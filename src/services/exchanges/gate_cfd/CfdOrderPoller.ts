/**
 * CfdOrderPoller —— Gate-CFD 订单成交确认轮询器（替代 WS fill 回调）
 *
 * 背景（内部设计文档 §3.4）：
 * Gate-CFD（/tradfi/*）没有任何 WebSocket 通道，订单成交/撤销只能靠 REST 轮询。
 * 本模块用「promise 注册表 + 后台定时轮询」替代 GateIOExchange 的
 * fillListeners（WS 成交回调）语义，向上层暴露 waitForOrderFill 统一接口。
 *
 * 轮询策略（D2 差异化轮询，设计文档 §3.4）：
 * - 市价单（priceType=Market）：下单响应即返回 log id，以 ~1s 高频轮询
 *   活动单列表（queryOrderList）直至终态；默认 30s 超时（marketTimeoutMs）。
 *   超时 reject —— 调用方审计 POSTFILL_FAILED / RISK_UNPROTECTED。
 * - 限价/触发单（priceType=Trigger）：~10s 低频轮询活动单列表
 *   （queryOrderList，缺失时回落 queryOrderHistoryList 查终态），
 *   成交/撤销即 resolve；默认 timeoutMs=0 无限等待（对齐加密限价挂单语义，
 *   服务重启后由启动对账兜底，见设计 §4.4）。
 * 注意：本轮询器以 orderId 为 key，而 queryOrderLog 仅接受 log_id（与 orderId 不同），
 * 故【不】在此调用 queryOrderLog（传 orderId 实盘实测 HTTP 400）；市价单成交定位
 * 由 GateCFDExchange.waitForFilledPositionId(logId) 单独负责。
 *
 * 终态判定：以 Mapper 归一化的 `finished` 布尔为主，stateDesc 兜底；
 * 数字 state 码在 SDK 文档核实后可在 TERMINAL_STATES 扩展。
 */

import logger, { formatError } from '../../../utils/logger';
import type { CfdRestClientLike, CfdOrderRow } from './types';

export interface CfdOrderPollerOptions {
  /** 市价单轮询间隔（ms），缺省 1000 */
  marketIntervalMs?: number;
  /** Trigger（限价/触发）单轮询间隔（ms），缺省 10000 */
  triggerIntervalMs?: number;
  /** 市价单默认超时（ms），缺省 30000；Trigger 单缺省 0 = 无限等待 */
  marketTimeoutMs?: number;
}

export interface WaitForOrderFillOptions {
  /** 缺省 'Market'；决定轮询间隔与默认超时 */
  priceType?: 'Market' | 'Trigger';
  /**
   * 超时（ms）。0 = 无限等待。
   * 缺省：Market → marketTimeoutMs（30s）；Trigger → 0（无限）。
   */
  timeoutMs?: number;
}

interface PendingFillResolver {
  resolve: (row: CfdOrderRow) => void;
  reject: (err: Error) => void;
  /** 该调用方自己的超时定时器；0 = 无限等待时不建 */
  timer: NodeJS.Timeout | null;
}

interface PendingFill {
  orderId: string;
  symbol: string;
  priceType: 'Market' | 'Trigger';
  /** 轮询间隔（ms），由 priceType 决定 */
  intervalMs: number;
  /** 下次轮询时间戳（节流：单一后台定时器按各自间隔分发） */
  nextPollAt: number;
  /** 防止同 entry 的 REST 轮询重叠 */
  inFlight: boolean;
  resolvers: PendingFillResolver[];
}

/** stateDesc 兜底判定关键词（Mapper 可能只给 state 数值时可用） */
const TERMINAL_STATE_DESC = ['closed', 'filled', 'cancelled', 'done', 'finished'];

export class CfdOrderPoller {
  private readonly rest: CfdRestClientLike;
  private readonly marketIntervalMs: number;
  private readonly triggerIntervalMs: number;
  private readonly marketTimeoutMs: number;
  /** 后台轮询定时器句柄（start/stop 幂等管理） */
  private timer: NodeJS.Timeout | null = null;
  /** promise 注册表：orderId → 待确认条目（对齐 GateIOExchange.fillListeners 模式） */
  private registry = new Map<string, PendingFill>();

  constructor(rest: CfdRestClientLike, opts?: CfdOrderPollerOptions) {
    this.rest = rest;
    // 缺省：market 1s / trigger 10s / market 超时 30s（设计 §3.4）
    this.marketIntervalMs = opts?.marketIntervalMs ?? 1000;
    this.triggerIntervalMs = opts?.triggerIntervalMs ?? 10_000;
    this.marketTimeoutMs = opts?.marketTimeoutMs ?? 30_000;
  }

  /**
   * 等待订单终态（成交/撤销/失败均视为终态，调用方按返回行判定成败）。
   * - 已终态：注册后立即触发一次轮询，尽快 resolve；
   * - 未终态：登记注册表，由后台定时循环轮询直至终态；
   * - timeoutMs=0：无限等待；否则超时 reject（调用方审计）。
   */
  waitForOrderFill(
    orderId: number | string,
    symbol: string,
    opts?: WaitForOrderFillOptions
  ): Promise<CfdOrderRow> {
    const priceType = opts?.priceType ?? 'Market';
    // 超时解析：显式传 0 = 无限等待；Trigger 缺省 0；Market 缺省 marketTimeoutMs
    let timeoutMs: number;
    if (opts?.timeoutMs !== undefined) {
      timeoutMs = opts.timeoutMs;
    } else {
      timeoutMs = priceType === 'Trigger' ? 0 : this.marketTimeoutMs;
    }

    const key = String(orderId);

    return new Promise<CfdOrderRow>((resolve, reject) => {
      // 合并同 orderId 的多次等待：共享一个轮询条目，各自独立 resolve/reject
      let entry = this.registry.get(key);
      if (!entry) {
        entry = {
          orderId: key,
          symbol,
          priceType,
          intervalMs: priceType === 'Trigger' ? this.triggerIntervalMs : this.marketIntervalMs,
          nextPollAt: 0, // 立即轮询一次
          inFlight: false,
          resolvers: [],
        };
        this.registry.set(key, entry);
      }

      let timer: NodeJS.Timeout | null = null;
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          const e = this.registry.get(key);
          if (!e) return;
          // 从条目中摘除本 resolver，避免 settle 时重复清理
          e.resolvers = e.resolvers.filter((r) => r.reject !== reject);
          if (e.resolvers.length === 0) this.registry.delete(key);
          reject(new Error(`[CfdOrderPoller] Timeout waiting for order fill: ${key} (symbol=${symbol}, priceType=${priceType}, timeout=${timeoutMs}ms)`));
          logger.warn('CfdOrderPoller timeout waiting for order fill', {
            orderId: key,
            symbol,
            priceType,
            timeoutMs,
          });
        }, timeoutMs);
      }

      entry.resolvers.push({ resolve, reject, timer });

      // 已登记（含新登记的）→ 确保后台循环在跑；立即触发一次轮询实现「已终态立即 resolve」
      if (!this.timer) this.start();
      void this.pollEntry(entry);
    });
  }

  /** 启动后台定时器；幂等（重复 start 不重复建定时器） */
  start(): void {
    if (this.timer) return;
    // 单一后台定时器，以最小间隔为节拍，entry 按各自 intervalMs 节流分发
    const tickMs = Math.min(this.marketIntervalMs, this.triggerIntervalMs);
    this.timer = setInterval(() => void this.tick(), tickMs);
    logger.info('CfdOrderPoller started', { tickMs });
  }

  /** 停止后台定时器并清理句柄；已在途轮询不受影响，已登记条目保留待下次 start 继续 */
  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
    logger.info('CfdOrderPoller stopped', { pending: this.registry.size });
  }

  /** 当前待确认订单数（诊断用） */
  get pendingCount(): number {
    return this.registry.size;
  }

  /** 后台节拍：对到期条目发起一轮轮询 */
  private tick(): void {
    const now = Date.now();
    for (const entry of this.registry.values()) {
      if (now < entry.nextPollAt) continue;
      if (entry.inFlight) continue;
      entry.nextPollAt = now + entry.intervalMs;
      void this.pollEntry(entry);
    }
  }

  /**
   * 轮询单个条目直至终态。
   * 查询顺序（对 Market / Trigger 均安全）：
   *   ① queryOrderList 活动单列表（成交/未成交/已撤单均出现，发现终态即 resolve）；
   *   ② 不在活动列表 → queryOrderHistoryList 查终态（成交/撤销后的最后落点）。
   * REST 错误不致命：记日志并留待下个轮询周期重试。
   *
   * 说明：本轮询器以 orderId（交易所订单号）为 key，而 queryOrderLog 接口仅接受
   * log_id（下单响应返回的另一套序号，与 orderId 不同），故【不】在此调用
   * queryOrderLog（实盘实测传 orderId 会 HTTP 400）。orderId→positionId 的桥接、
   * 市价单成交定位由 GateCFDExchange.waitForFilledPositionId(logId) 单独负责。
   */
  private async pollEntry(entry: PendingFill): Promise<void> {
    if (entry.inFlight) return;
    entry.inFlight = true;
    try {
      // ① 活动单列表（主通道）
      try {
        const list = await this.rest.queryOrderList();
        const row = list.find((r) => String(r.orderId) === entry.orderId);
        if (row && this.isTerminalOrder(row)) {
          this.settle(entry, row);
          return;
        }
      } catch (err) {
        logger.warn(`CfdOrderPoller queryOrderList failed for ${entry.orderId}`, formatError(err));
      }

      // ② 不在活动列表 → 从历史补终态（可能是已成交/已撤销）
      try {
        const history = await this.rest.queryOrderHistoryList({ symbol: entry.symbol });
        const hrow = history.find((r) => String(r.orderId) === entry.orderId);
        if (hrow && this.isTerminalOrder(hrow)) {
          this.settle(entry, hrow);
          return;
        }
      } catch (err) {
        logger.warn(`CfdOrderPoller queryOrderHistoryList failed for ${entry.orderId}`, formatError(err));
      }
    } finally {
      entry.inFlight = false;
    }
  }

  /** 终态判定：`finished` 布尔为主，stateDesc 兜底，数字 state 码留扩展点 */
  private isTerminalOrder(row: CfdOrderRow): boolean {
    const finished = row.finished;
    if (finished === true) return true;
    if (typeof finished === 'string' && ['true', '1', 'yes', 'finished', 'closed', 'filled'].includes(finished.toLowerCase())) {
      return true;
    }
    // 数字 state 终态码：SDK OrderListDataList.state 文档核实后在此扩展
    // （0=待成交，非终态；此处不预设猜测值）
    const desc = (row.stateDesc || '').toLowerCase();
    if (desc && TERMINAL_STATE_DESC.includes(desc)) return true;
    return false;
  }

  /** 终态到达：清理定时器、摘除注册表条目、resolve 所有等待方 */
  private settle(entry: PendingFill, row: CfdOrderRow): void {
    const key = entry.orderId;
    this.registry.delete(key);
    for (const r of entry.resolvers) {
      if (r.timer) clearTimeout(r.timer);
      r.resolve(row);
    }
    logger.info('CfdOrderPoller order reached terminal state', {
      orderId: key,
      symbol: entry.symbol,
      priceType: entry.priceType,
      state: row.state,
      stateDesc: row.stateDesc,
      finished: row.finished,
    });
  }
}
