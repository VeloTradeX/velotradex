/**
 * CfdPositionPoller —— Gate-CFD 持仓状态轮询器（替代 WS position 事件）
 *
 * 背景（内部设计文档 §3.5）：
 * Gate-CFD（/tradfi/*）无 WebSocket，TP/SL 触发平仓、强平、外部手工干预
 * 只能靠 REST 轮询 queryPositionList() 感知。本模块每隔 intervalMs（缺省 4s）
 * 拉取持仓列表，与本地快照（Map<positionId, CfdPositionRow>）做 diff，产出
 * 四类 CfdPositionEvent 喂给 CfdPersistenceHandler 驱动 Order 状态机。
 *
 * 事件语义（与设计 §3.5 对应）：
 * - position_opened  —— 新增且在我们跟踪集合（tracked）内：Trigger 单成交 /
 *                       我们开的仓首次被观测到。事件透传 priceTp/priceSl，
 *                       供 PersistenceHandler 做 PROTECTED 判定。
 * - foreign_position —— 新增但不在 tracked 集合：交易所侧存在我们未知的仓位，
 *                       说明有人工干预或外部开仓，对齐现有 MANUAL_INTERVENTION
 *                       告警语义（PersistenceHandler 仅审计）。
 * - position_closed  —— 从快照消失：TP/SL 触发整仓平掉 / 强平 / 手工平仓。
 *                       rest 提供 queryPositionHistoryList 时尽力取平仓价与
 *                       closeReason（tp/sl/manual/liquidation/unknown），
 *                       取不到则为 unknown（PersistenceHandler 审计兜底）。
 * - position_reduced —— 同 positionId 但 volume 减小：我们主动的部分平仓
 *                       （POST /positions/{id}/close 带 closeVolume），
 *                       不影响 Order 终态，仅供展示/审计。
 */

import logger, { formatError } from '../../../utils/logger';
import type { CfdRestClientLike, CfdPositionEvent, CfdPositionRow } from './types';

export interface CfdPositionPollerOptions {
  /** 轮询间隔（ms），缺省 4000 */
  intervalMs?: number;
}

/** 平仓原因联合类型（去 optional，供 Record key 使用） */
type CloseReason = NonNullable<CfdPositionEvent['closeReason']>;

/** 平仓原因判定的关键词表（对历史行 raw/字段的字符串做包含匹配） */
const CLOSE_REASON_KEYWORDS: Record<CloseReason, string[]> = {
  liquidation: ['liquidation', 'liq', '强平'],
  tp: ['tp', 'take_profit', 'take profit', '止盈'],
  sl: ['sl', 'stop_loss', 'stop loss', '止损'],
  manual: ['manual', 'hand', '手工', 'user close', 'user_close'],
  unknown: [],
};

export class CfdPositionPoller {
  private readonly rest: CfdRestClientLike;
  private readonly intervalMs: number;
  private timer: NodeJS.Timeout | null = null;
  /** 本地快照：positionId → 上次轮询到的持仓行 */
  private snapshot = new Map<string, CfdPositionRow>();
  /** 我们跟踪的持仓（Exchange 注入；多腿 = 多个 positionId） */
  private trackedIds = new Set<string>();
  /** 防止上一轮 REST 未返回时重复轮询 */
  private isPolling = false;

  /** 事件回调（Exchange 注入，转发给 CfdPersistenceHandler） */
  onPositionEvent?: (event: CfdPositionEvent) => void;

  constructor(rest: CfdRestClientLike, opts?: CfdPositionPollerOptions) {
    this.rest = rest;
    this.intervalMs = opts?.intervalMs ?? 4000;
  }

  /** 注入「我们跟踪的持仓」集合，用于 foreign_position 判定（可重复调用覆盖） */
  setTrackedPositionIds(ids: Set<number | string>): void {
    this.trackedIds = new Set([...ids].map(String));
    logger.debug('CfdPositionPoller tracked positions updated', { count: this.trackedIds.size });
  }

  /** 启动定时器并立即执行一轮 diff；幂等 */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.poll(), this.intervalMs);
    void this.poll();
    logger.info('CfdPositionPoller started', { intervalMs: this.intervalMs });
  }

  /** 停止定时器并清理句柄；幂等 */
  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
    logger.info('CfdPositionPoller stopped');
  }

  /** 单轮轮询：拉取持仓列表并与本地快照 diff */
  private async poll(): Promise<void> {
    if (this.isPolling) return;
    this.isPolling = true;
    try {
      const rows = await this.rest.queryPositionList();
      this.diff(rows);
    } catch (err) {
      // 单轮失败不致命：保留上一轮快照，下个周期重试
      logger.warn('CfdPositionPoller queryPositionList failed', formatError(err));
    } finally {
      this.isPolling = false;
    }
  }

  /** 快照 diff，产出事件（§3.5） */
  private diff(rows: CfdPositionRow[]): void {
    const current = new Map<string, CfdPositionRow>();
    for (const row of rows) current.set(String(row.positionId), row);

    for (const [pid, row] of current) {
      const prev = this.snapshot.get(pid);
      if (!prev) {
        // 新增：tracked 内 → position_opened；tracked 外 → foreign_position
        const tracked = this.trackedIds.has(pid);
        this.emit({
          ...this.toEventFields(row),
          type: tracked ? 'position_opened' : 'foreign_position',
        });
        if (!tracked) {
          logger.warn('CfdPositionPoller detected untracked (foreign) position', {
            positionId: pid,
            symbol: row.symbol,
            volume: row.volume,
          });
        }
      } else {
        // 同 id 但 volume 减小 → 我们主动的部分平仓
        const prevVol = parseFloat(prev.volume ?? '0');
        const curVol = parseFloat(row.volume ?? '0');
        if (Number.isFinite(prevVol) && Number.isFinite(curVol) && curVol < prevVol - 1e-9) {
          this.emit({ ...this.toEventFields(row), type: 'position_reduced' });
        }
      }
    }

    // 快照中存在但列表消失 → position_closed（异步查历史补平仓价与原因）
    for (const pid of this.snapshot.keys()) {
      if (!current.has(pid)) {
        const prev = this.snapshot.get(pid)!;
        void this.handlePositionClosed(pid, prev);
      }
    }

    this.snapshot = current;
  }

  /** position_closed：若 rest 支持则查历史，尽力取平仓价与 closeReason，取不到为 unknown */
  private async handlePositionClosed(pid: string, prev: CfdPositionRow): Promise<void> {
    let closedPrice: string | undefined;
    let closeReason: CfdPositionEvent['closeReason'] = 'unknown';

    if (typeof this.rest.queryPositionHistoryList === 'function') {
      try {
        const history = await this.rest.queryPositionHistoryList({ positionId: pid });
        const hrow = Array.isArray(history) ? history.find((r) => String(r.positionId) === pid) : null;
        if (hrow) {
          // 平仓价：优先取历史行的 closePrice/price 字段，缺省回退到开仓均价
          closedPrice = this.pickString(hrow, ['closePrice', 'priceClose', 'price', 'priceOpen']);
          closeReason = this.resolveCloseReason(hrow);
        }
      } catch (err) {
        logger.warn(`CfdPositionPoller queryPositionHistoryList failed for ${pid}`, formatError(err));
      }
    }

    this.emit({
      ...this.toEventFields(prev),
      type: 'position_closed',
      closedPrice,
      closeReason,
    });
  }

  /** 从历史行推断平仓原因（tp/sl/manual/liquidation/unknown），字段缺失/无法识别即 unknown */
  private resolveCloseReason(row: CfdPositionRow): CfdPositionEvent['closeReason'] {
    const raw = (row.raw && typeof row.raw === 'object' ? row.raw : {}) as Record<string, unknown>;
    const fields: string[] = [];
    for (const key of ['closeType', 'closeReason', 'reason', 'type', 'stateDesc', 'remark', 'isLiq', 'liqPrice']) {
      const v = raw[key] ?? (row as any)[key];
      if (v !== undefined && v !== null) fields.push(String(v));
    }
    const hay = fields.join(' ').toLowerCase();
    // 强平优先（关键词更独特），再按 tp/sl/manual 顺序匹配
    for (const reason of ['liquidation', 'tp', 'sl', 'manual'] as const) {
      if (CLOSE_REASON_KEYWORDS[reason].some((kw) => hay.includes(kw.toLowerCase()))) {
        return reason;
      }
    }
    return 'unknown';
  }

  /** CfdPositionRow → CfdPositionEvent 公共字段（不含 type 与 closed 专属字段） */
  private toEventFields(row: CfdPositionRow): Omit<CfdPositionEvent, 'type' | 'closedPrice' | 'closeReason'> {
    return {
      positionId: row.positionId,
      symbol: row.symbol,
      volume: row.volume ?? '0',
      priceOpen: row.priceOpen ?? '',
      priceTp: row.priceTp,
      priceSl: row.priceSl,
      raw: row.raw ?? row,
    };
  }

  private pickString(row: CfdPositionRow, keys: string[]): string | undefined {
    for (const key of keys) {
      const v = (row as any)[key] ?? ((row.raw && typeof row.raw === 'object') ? (row.raw as any)[key] : undefined);
      if (v !== undefined && v !== null && v !== '') return String(v);
    }
    return undefined;
  }

  private emit(event: CfdPositionEvent): void {
    try {
      this.onPositionEvent?.(event);
    } catch (err) {
      // 事件处理方（PersistenceHandler/Exchange）异常不中断轮询
      logger.warn(`CfdPositionPoller onPositionEvent handler failed for ${event.type}`, formatError(err));
    }
  }
}
