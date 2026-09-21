/**
 * CfdPersistenceHandler —— 轮询事件 → Order/CfdLeg 状态机
 *
 * 职责（内部设计文档 §3.5 / §4.4）：
 * 消费 CfdPositionPoller 的 CfdPositionEvent，把 CFD 轮询事件落库，
 * 驱动每腿 Order 的状态机：INIT → PENDING(挂单) → OPEN(成交) →
 * PROTECTED(保护确认) → CLOSED。
 *
 * 替代对象：加密链路的 GateIOOrderPersistenceHandler（WS 事件落库）。
 * 差异：加密链路由 WS 成交回调驱动，这里由 REST 轮询 diff 驱动。
 *
 * 并发安全：Order 生命周期更新一律走条件更新（where lifecycleStatus in [...]），
 * 绝不从已终态（PROTECTED/CLOSED/FAILED/RISK_UNPROTECTED）降级 ——
 * 与 OpenPositionService.applyLifecycleStatus 的条件更新模式一致，
 * 避免两个并发路径（REST 串行确认 vs 轮询/对账）用过期内存对象互相覆盖。
 */

import { Order, CfdLeg, CfdLegGroup } from '../../../models';
import logger, { formatError } from '../../../utils/logger';
import type { CfdRestClientLike, CfdPositionEvent, CfdPositionRow } from './types';

export interface CfdPersistenceHandlerOptions {
  /** 审计回调（由 Exchange/调用方注入，如 auditService.logByExchangeOrderId） */
  onAudit?: (action: string, details: any) => void;
}

/** 启动对账第三步：回查历史订单的天数 */
const RECONCILE_HISTORY_DAYS = 7;

/** 手数模糊匹配容差（手）：CFD 最小下单量 0.01，容差取 1e-4 足够 */
const VOLUME_TOLERANCE = 1e-4;

/** 价格容差：绝对地板 0.01，另加基价的 0.1% 相对容差（覆盖 padding/点差） */
function priceTolerance(base: number): number {
  return Math.max(0.01, Math.abs(base) * 0.001);
}

function approxEq(a: number, b: number, tol: number): boolean {
  return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= tol;
}

export class CfdPersistenceHandler {
  private readonly onAudit?: (action: string, details: any) => void;

  constructor(opts?: CfdPersistenceHandlerOptions) {
    this.onAudit = opts?.onAudit;
  }

  // ---------------------------------------------------------------------
  // 事件处理（CfdPositionPoller.onPositionEvent 入口）
  // ---------------------------------------------------------------------

  /**
   * 处理单个持仓事件，按 positionId 反查 CfdLeg → 更新 Order / CfdLeg。
   *
   * - position_opened  → Order OPEN（条件更新）→ 保护确认后 PROTECTED；回写 leg.status='open'
   * - position_closed  → Order CLOSED + closedAt（exitPrice/closePrice 尽力带平仓价）；leg 'closed'
   * - foreign_position → 仅审计告警（人工干预，对齐 MANUAL_INTERVENTION 语义）
   * - position_reduced → 仅审计（我们主动的部分平仓，不影响 Order 终态）
   */
  async handlePositionEvent(event: CfdPositionEvent): Promise<void> {
    switch (event.type) {
      case 'position_opened':
        await this.handlePositionOpened(event);
        break;
      case 'position_closed':
        await this.handlePositionClosed(event);
        break;
      case 'foreign_position':
        this.audit('CFD_FOREIGN_POSITION', {
          positionId: event.positionId,
          symbol: event.symbol,
          volume: event.volume,
          priceOpen: event.priceOpen,
          raw: event.raw,
        });
        break;
      case 'position_reduced':
        this.audit('CFD_POSITION_REDUCED', {
          positionId: event.positionId,
          symbol: event.symbol,
          volume: event.volume,
          priceOpen: event.priceOpen,
        });
        break;
      default:
        logger.warn('CfdPersistenceHandler unknown position event type', { event });
    }
  }

  /** position_opened：成交确认 → OPEN；priceTp/priceSl 回查确认后 → PROTECTED */
  private async handlePositionOpened(event: CfdPositionEvent): Promise<void> {
    const leg = await this.findLegByPositionId(event.positionId);
    if (!leg) {
      // 事件来自 tracked 集合但 DB 无对应腿：数据异常，审计兜底
      this.audit('CFD_POSITION_OPENED_UNLINKED', {
        positionId: event.positionId,
        symbol: event.symbol,
        volume: event.volume,
      });
      logger.warn('CfdPersistenceHandler position_opened without CfdLeg', {
        positionId: event.positionId,
        symbol: event.symbol,
      });
      return;
    }
    if (!leg.orderId) {
      this.audit('CFD_LEG_WITHOUT_ORDER', { legId: leg.id, positionId: event.positionId });
      return;
    }

    const order = await Order.findByPk(leg.orderId).catch(() => null);
    const target = (await this.isProtected(leg, this.eventToPositionRow(event), order)) ? 'PROTECTED' : 'OPEN';

    // 条件更新：仅允许从 INIT/PENDING/OPEN 升级，绝不从 PROTECTED 降级
    const updates: Record<string, unknown> = {
      status: 'filled',
      filledAmount: event.volume,
      filledPrice: event.priceOpen,
    };
    if (event.priceTp) updates.currentTp = event.priceTp;
    if (event.priceSl) updates.currentSl = event.priceSl;

    const ok = await this.applyOrderLifecycle(leg.orderId, target, updates, ['INIT', 'PENDING', 'OPEN']);
    await CfdLeg.update({ status: 'open' }, { where: { id: leg.id } });

    this.audit(target === 'PROTECTED' ? 'CFD_POSITION_PROTECTED' : 'CFD_POSITION_OPENED', {
      orderId: leg.orderId,
      legId: leg.id,
      positionId: event.positionId,
      symbol: event.symbol,
      volume: event.volume,
      priceOpen: event.priceOpen,
      priceTp: event.priceTp,
      priceSl: event.priceSl,
      updated: ok,
    });
    logger.info('CfdPersistenceHandler position opened', {
      orderId: leg.orderId,
      positionId: event.positionId,
      lifecycleStatus: target,
    });
  }

  /** position_closed：TP/SL/强平/手工平仓 → Order CLOSED + CfdLeg closed */
  private async handlePositionClosed(event: CfdPositionEvent): Promise<void> {
    const leg = await this.findLegByPositionId(event.positionId);
    if (!leg) {
      // 未跟踪仓位的关闭（人工干预等）：仅审计
      this.audit('CFD_FOREIGN_POSITION_CLOSED', {
        positionId: event.positionId,
        symbol: event.symbol,
        closedPrice: event.closedPrice,
        closeReason: event.closeReason,
      });
      return;
    }
    if (!leg.orderId) {
      this.audit('CFD_LEG_WITHOUT_ORDER', { legId: leg.id, positionId: event.positionId });
      return;
    }

    const updates: Record<string, unknown> = { status: 'closed', closedAt: new Date() };
    if (event.closedPrice) {
      updates.exitPrice = event.closedPrice;
      updates.closePrice = event.closedPrice;
    }
    // 允许从任意非终态关闭；若已 FAILED/RISK_UNPROTECTED 则条件更新不生效
    const ok = await this.applyOrderLifecycle(leg.orderId, 'CLOSED', updates, [
      'INIT', 'PENDING', 'OPEN', 'PROTECTED',
    ]);
    await CfdLeg.update({ status: 'closed' }, { where: { id: leg.id } });

    this.audit('CFD_POSITION_CLOSED', {
      orderId: leg.orderId,
      legId: leg.id,
      positionId: event.positionId,
      symbol: event.symbol,
      closedPrice: event.closedPrice,
      closeReason: event.closeReason,
      updated: ok,
    });
    logger.info('CfdPersistenceHandler position closed', {
      orderId: leg.orderId,
      positionId: event.positionId,
      closeReason: event.closeReason,
      closedPrice: event.closedPrice,
    });
  }

  // ---------------------------------------------------------------------
  // 启动对账（设计 §4.4）
  // ---------------------------------------------------------------------

  /**
   * 启动全量对账三步，修复服务重启期间错过的状态迁移：
   *   ① queryOrderList()      在途挂单 → PENDING（INIT 升级）
   *   ② queryPositionList()   活动持仓 → OPEN / PROTECTED
   *                            （先 positionId 精确匹配，再 symbol+volume+priceOpen 模糊匹配 CfdLeg）
   *   ③ queryOrderHistoryList 近 N 天历史 → 补错过的 CLOSED
   */
  async reconcileOnStartup(rest: CfdRestClientLike, trackedIds?: Set<number | string>): Promise<void> {
    logger.info('CfdPersistenceHandler reconcileOnStartup start');
    try {
      await this.reconcileOpenOrders(rest);
      await this.reconcilePositions(rest, trackedIds);
      await this.reconcileOrderHistory(rest);
    } catch (err) {
      // 对账单步失败不阻断整体启动；下一轮位置轮询会继续收敛状态
      logger.error('CfdPersistenceHandler reconcileOnStartup failed', formatError(err));
    }
    logger.info('CfdPersistenceHandler reconcileOnStartup done');
  }

  /** ① 在途挂单 → PENDING */
  private async reconcileOpenOrders(rest: CfdRestClientLike): Promise<void> {
    const rows = await rest.queryOrderList();
    for (const row of rows) {
      const order = await Order.findOne({ where: { exchangeOrderId: String(row.orderId) } }).catch(() => null);
      if (!order) {
        // 交易所活动单里没有我们 DB 的订单 → 外部手工挂单
        this.audit('CFD_RECONCILE_FOREIGN_ORDER', { orderId: row.orderId, symbol: row.symbol });
        continue;
      }
      const ok = await this.applyOrderLifecycle(order.id, 'PENDING', {}, ['INIT', 'PENDING']);
      if (ok) {
        this.audit('CFD_RECONCILE_ORDER_PENDING', {
          orderId: order.id,
          exchangeOrderId: row.orderId,
          symbol: row.symbol,
        });
      }
    }
  }

  /** ② 活动持仓 → OPEN / PROTECTED；未匹配到腿 → foreign 告警 */
  private async reconcilePositions(rest: CfdRestClientLike, trackedIds?: Set<number | string>): Promise<void> {
    const rows = await rest.queryPositionList();
    for (const row of rows) {
      let leg = await this.findLegByPositionId(row.positionId);
      if (!leg) leg = await this.findLegByFuzzyMatch(row);
      if (!leg) {
        const tracked = trackedIds?.has(String(row.positionId)) ?? false;
        this.audit('CFD_RECONCILE_FOREIGN_POSITION', {
          positionId: row.positionId,
          symbol: row.symbol,
          volume: row.volume,
          priceOpen: row.priceOpen,
          tracked,
        });
        continue;
      }
      if (!leg.orderId) {
        this.audit('CFD_LEG_WITHOUT_ORDER', { legId: leg.id, positionId: row.positionId });
        continue;
      }

      const order = await Order.findByPk(leg.orderId).catch(() => null);
      const target = (await this.isProtected(leg, row, order)) ? 'PROTECTED' : 'OPEN';
      const ok = await this.applyOrderLifecycle(
        leg.orderId,
        target,
        { status: 'filled', filledAmount: row.volume, filledPrice: row.priceOpen },
        ['INIT', 'PENDING', 'OPEN']
      );

      // 回写 positionId（成交后绑定锚点，供 closePosition/updatePosition 使用）
      const pid = String(row.positionId);
      if (leg.positionId !== pid) {
        await CfdLeg.update({ positionId: pid }, { where: { id: leg.id } });
      }
      await CfdLeg.update({ status: 'open' }, { where: { id: leg.id } });

      this.audit('CFD_RECONCILE_POSITION_OPEN', {
        orderId: leg.orderId,
        legId: leg.id,
        positionId: row.positionId,
        symbol: row.symbol,
        volume: row.volume,
        priceOpen: row.priceOpen,
        lifecycleStatus: target,
        updated: ok,
      });
      logger.info('CfdPersistenceHandler reconcile position matched', {
        orderId: leg.orderId,
        positionId: row.positionId,
        lifecycleStatus: target,
      });
    }
  }

  /** ③ 历史订单近 N 天 → 补错过的 CLOSED */
  private async reconcileOrderHistory(rest: CfdRestClientLike): Promise<void> {
    const rows = await rest.queryOrderHistoryList({ days: RECONCILE_HISTORY_DAYS });
    for (const row of rows) {
      const order = await Order.findOne({ where: { exchangeOrderId: String(row.orderId) } }).catch(() => null);
      if (!order) continue; // 历史里的非本系统订单，忽略
      if (order.lifecycleStatus === 'CLOSED' || order.lifecycleStatus === 'FAILED') continue;
      const ok = await this.applyOrderLifecycle(
        order.id,
        'CLOSED',
        { status: 'closed', closedAt: new Date() },
        ['INIT', 'PENDING', 'OPEN', 'PROTECTED']
      );
      if (!ok) continue;
      const leg = await CfdLeg.findOne({ where: { orderId: order.id } }).catch(() => null);
      if (leg) await CfdLeg.update({ status: 'closed' }, { where: { id: leg.id } });
      this.audit('CFD_RECONCILE_ORDER_CLOSED', {
        orderId: order.id,
        exchangeOrderId: row.orderId,
        symbol: row.symbol,
      });
    }
  }

  // ---------------------------------------------------------------------
  // 匹配 / 保护判定工具
  // ---------------------------------------------------------------------

  /** 按 positionId 精确反查 CfdLeg */
  private async findLegByPositionId(positionId: number | string): Promise<CfdLeg | null> {
    return CfdLeg.findOne({ where: { positionId: String(positionId) } }).catch(() => null);
  }

  /**
   * 模糊匹配兜底（对账第二步）：symbol + volume + priceOpen 匹配 CfdLeg。
   * CfdLeg 表无价格字段（设计 §5.1），入场参考价取关联 Order 的 price/filledPrice。
   * 先按 symbol 过滤，再比手数（容差 1e-4），最后比入场价（相对容差，覆盖 padding/点差）。
   */
  private async findLegByFuzzyMatch(row: CfdPositionRow): Promise<CfdLeg | null> {
    const candidates = await CfdLeg.findAll({ where: { status: ['pending', 'open'] } }).catch(() => [] as CfdLeg[]);
    for (const leg of candidates) {
      if (!leg.orderId) continue;
      const order = await Order.findByPk(leg.orderId).catch(() => null);
      if (!order) continue;
      if (String(order.symbol) !== String(row.symbol)) continue;
      if (!approxEq(parseFloat(leg.volume), parseFloat(row.volume ?? ''), VOLUME_TOLERANCE)) continue;
      const entryRef = parseFloat(order.filledPrice || order.price || '');
      const priceOpen = parseFloat(row.priceOpen ?? '');
      if (Number.isFinite(entryRef) && Number.isFinite(priceOpen)) {
        if (!approxEq(entryRef, priceOpen, priceTolerance(entryRef))) continue;
      }
      return leg;
    }
    return null;
  }

  /**
   * PROTECTED 判定（设计 §3.5）：
   * CFD 下单自带 priceTp/priceSl（下单参数即含保护）。因此：
   *   PROTECTED = 成交确认 + 持仓/订单回查 priceTp、priceSl 非空且与预期一致。
   * - position 行提供 priceTp/priceSl 字段 → 要求非空，且与腿预期
   *   （leg.tpPrice / 分组 slPrice 或 order.initialSl）数值一致（含容差）；
   * - position 行未提供 priceTp/priceSl 字段（undefined）→ 退化为
   *   「成交确认 + 下单参数已含保护」：腿参数只要带保护即视为已托管。
   */
  private async isProtected(leg: CfdLeg, posRow: CfdPositionRow, order: Order | null): Promise<boolean> {
    const expectedTp = parseFloat(leg.tpPrice ?? '');
    const expectedSlStr = await this.resolveExpectedSl(leg, order);
    const expectedSl = parseFloat(expectedSlStr ?? '');
    const hasExpected = Number.isFinite(expectedTp) || Number.isFinite(expectedSl);

    // position 行没有 priceTp/priceSl 字段（undefined/null）→ 退化判定
    const posHasTp = posRow.priceTp !== undefined && posRow.priceTp !== null && posRow.priceTp !== '';
    const posHasSl = posRow.priceSl !== undefined && posRow.priceSl !== null && posRow.priceSl !== '';
    if (!posHasTp && !posHasSl) return hasExpected;

    const tpOk = !Number.isFinite(expectedTp)
      || (posHasTp && approxEq(parseFloat(posRow.priceTp!), expectedTp, priceTolerance(expectedTp)));
    const slOk = !Number.isFinite(expectedSl)
      || (posHasSl && approxEq(parseFloat(posRow.priceSl!), expectedSl, priceTolerance(expectedSl)));
    return tpOk && slOk;
  }

  /** 预期止损：优先取腿组 slPrice（全腿共用 SL，设计 §5.1），缺省回退 Order.initialSl */
  private async resolveExpectedSl(leg: CfdLeg, order: Order | null): Promise<string | undefined> {
    if (leg.legGroupId) {
      const group = await CfdLegGroup.findByPk(leg.legGroupId).catch(() => null);
      if (group?.slPrice) return group.slPrice;
    }
    return order?.initialSl || order?.currentSl || undefined;
  }

  /** CfdPositionEvent → CfdPositionRow（isProtected 输入适配） */
  private eventToPositionRow(event: CfdPositionEvent): CfdPositionRow {
    return {
      positionId: event.positionId,
      symbol: event.symbol,
      volume: event.volume,
      priceOpen: event.priceOpen,
      priceTp: event.priceTp,
      priceSl: event.priceSl,
      raw: event.raw,
    };
  }

  /**
   * 条件更新 Order 生命周期（对齐 OpenPositionService.applyLifecycleStatus 模式）：
   * where lifecycleStatus in allowedFrom —— 防并发降级、防覆盖已终态。
   * 返回是否实际更新成功（rows > 0）。
   */
  private async applyOrderLifecycle(
    orderId: number,
    status: Order['lifecycleStatus'],
    updates: Record<string, unknown>,
    allowedFrom: Order['lifecycleStatus'][]
  ): Promise<boolean> {
    try {
      const [rows] = await (Order as any).update(
        { lifecycleStatus: status, ...updates },
        { where: { id: orderId, lifecycleStatus: allowedFrom }, limit: 1 }
      );
      return rows > 0;
    } catch (err) {
      logger.warn(`CfdPersistenceHandler applyOrderLifecycle failed: order=${orderId} → ${status}`, formatError(err));
      return false;
    }
  }

  /** 审计回调：异常不阻断主流程 */
  private audit(action: string, details: any): void {
    try {
      this.onAudit?.(action, details);
    } catch (err) {
      logger.warn(`CfdPersistenceHandler audit callback failed for ${action}`, formatError(err));
    }
  }
}
