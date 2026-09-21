/**
 * NoStopLossMonitor - Automatic Position Protection
 * 
 * This monitor scans all OPEN/PROTECTED orders and verifies they have stop loss protection.
 * If an order is missing SL for too long, it automatically closes the position to prevent unlimited loss.
 * 
 * **Detection Strategy:**
 * - Queries exchange price_orders API directly (not relying on cached activeStopLossId)
 * - Matches by symbol + side + rule (position-level SL detection)
 * - Long positions: rule=2 (trigger when price <= SL)
 * - Short positions: rule=1 (trigger when price >= SL)
 * 
 * **Grace Period:**
 * - Initial grace: 15 seconds (allows time for SL placement after order fill)
 * - Missing SL confirmations: 3 scans before auto-close
 * - Position absence check: 12 seconds (verify position is truly gone before marking CLOSED)
 * 
 * **Safety Features:**
 * - API failure tolerance: Assumes SL exists if query fails (prevents false-positive auto-close)
 * - Position verification: Checks if position still exists before auto-close
 * - Orphan cleanup: Cancels residual SL orders when position is gone
 * 
 * **Scan Interval:** 5 seconds
 */

import { Op } from 'sequelize';
import { Order, PendingProtection, VirtualTrade } from '../models';
import exchangeRegistry from './exchanges';
import auditService from './AuditService';
import logger, { formatError, buildLogContextFromOrder, logContext } from '../utils/logger';
import { ParsedStrategy } from './parsers/types';
import type { CloseExecutor } from './executor/types';
import { nowOrSim } from '../backtest/Clock';

type StopLossState = 'present' | 'missing' | 'unknown';

interface QueryFailureState {
  failureCount: number;
  firstFailureAt: number;
  lastFailureAt: number;
  lastError: any;
  alerted: boolean;
}

interface PriceOrderFetchResult {
  orders: any[] | null;
  error?: any;
}

interface NoStopLossState {
  orderId: string;
  symbol: string;
  side?: 'buy' | 'sell';
  exchangeInstanceId?: string;
  checkedAt: number;
  graceEndsAt: number;
  confirmed: boolean;
  missingConfirmations: number;
  firstMissingAt?: number;
  lastMissingAt?: number;
  positionAbsentSince?: number;
}

export class NoStopLossMonitor {
  private state: Map<string, NoStopLossState> = new Map();
  private queryFailureState = new Map<string, QueryFailureState>();
  private interval: NodeJS.Timeout | null = null;

  // Config — aligned with values previously hardcoded in TradeExecutor
  private readonly SCAN_INTERVAL_MS = 5000;
  private readonly GRACE_MS = 15000;
  private readonly CONFIRM_MS = 12000;
  private readonly FETCH_RETRY = 3;
  private readonly FETCH_RETRY_DELAY_MS = 600;
  private readonly MISSING_SL_CONFIRMATIONS = 3;
  private readonly QUERY_FAILURE_ALERT_THRESHOLD = 3;

  // Epsilon for floating-point position size comparison
  private readonly QTY_EPSILON = 1e-8;

  constructor(private tradeExecutor: CloseExecutor) {}

  // ─── Public API ─────────────────────────────────────────────────────────────

  public start(): void {
    if (this.interval) {
      clearInterval(this.interval);
    }
    this.interval = setInterval(() => {
      this.checkAll().catch(err => {
        logger.warn('NoStopLossMonitor scan failed', formatError(err));
      });
    }, this.SCAN_INTERVAL_MS);
    // Run an immediate scan on start
    this.checkAll().catch(err => {
      logger.warn('NoStopLossMonitor initial scan failed', formatError(err));
    });
    logger.info('NoStopLossMonitor: started');
  }

  public stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    this.state.clear();
    this.queryFailureState.clear();
    logger.info('NoStopLossMonitor: stopped');
  }

  /**
   * Register an order for SL monitoring.
   * Called after SL is placed and the order reaches PROTECTED status.
   */
  public watchOrder(orderId: string, symbol: string): void {
    const key = orderId;
    if (this.state.has(key)) return; // already watched
    const now = Date.now();
    this.state.set(key, {
      orderId,
      symbol,
      checkedAt: now,
      graceEndsAt: now + this.GRACE_MS,
      confirmed: false,
      missingConfirmations: 0,
      firstMissingAt: undefined,
      lastMissingAt: undefined,
      positionAbsentSince: undefined,
    });
    logger.debug(`NoStopLossMonitor: watching order ${orderId} (${symbol})`);
  }

  /**
   * Remove an order from SL monitoring.
   * Called when the order is closed.
   */
  public unwatchOrder(orderId: string): void {
    if (this.state.delete(orderId)) {
      logger.debug(`NoStopLossMonitor: unwatched order ${orderId}`);
    }
  }

  // ─── Internal scan ───────────────────────────────────────────────────────────

  private async checkAll(): Promise<void> {
    const candidates = await Order.findAll({
      where: {
        isSimulated: false,
        lifecycleStatus: ['PENDING', 'OPEN', 'PROTECTED'],
        strategyId: { [Op.ne]: null },
        // 回测导入的订单不参与实盘无止损监控（子进程内订单未打标，行为不变）
        backtestRunId: { [Op.is]: null },
      },
    });

    const now = Date.now();
    const activeKeys = new Set<string>();

    const BATCH_SIZE = 5;
    for (let i = 0; i < candidates.length; i += BATCH_SIZE) {
      const batch = candidates.slice(i, i + BATCH_SIZE);
      await Promise.all(
        batch
          .filter(o => o.exchangeInstanceId)
          .map(o => {
            const key = String(o.id);
            activeKeys.add(key);

            // Hydrate state entry if not already present
            if (!this.state.has(key)) {
              this.state.set(key, {
                orderId: key,
                symbol: o.symbol,
                checkedAt: now,
                graceEndsAt: now + this.GRACE_MS,
                confirmed: false,
                missingConfirmations: 0,
                firstMissingAt: undefined,
                lastMissingAt: undefined,
                positionAbsentSince: undefined,
              });
            }

            return this.checkOrder(key, now);
          })
      );
    }

    // Remove state for orders no longer in OPEN/PROTECTED
    for (const key of this.state.keys()) {
      if (!activeKeys.has(key)) {
        const stale = this.state.get(key);
        if (stale?.side) {
          this.clearQueryFailureByParts(stale.exchangeInstanceId || 'default', stale.symbol, stale.side);
        }
        this.state.delete(key);
      }
    }
  }

  private async checkOrder(key: string, now: number): Promise<void> {
    const entry = this.state.get(key);
    if (!entry) return;

    const orderId = parseInt(entry.orderId, 10);
    const order = await Order.findOne({ where: { id: orderId } });
    if (!order) {
      this.clearQueryFailureForEntry(entry);
      this.state.delete(key);
      return;
    }
        const side = order.side as 'buy' | 'sell';
    entry.side = side;
    entry.exchangeInstanceId = order.exchangeInstanceId || undefined;
    entry.symbol = order.symbol;

    // Skip orders that are already closed
    if (order.lifecycleStatus === 'CLOSED' || order.lifecycleStatus === 'FAILED') {
      this.clearQueryFailure(order, side);
      this.state.delete(key);
      return;
    }

    await logContext.run(new Map([['context', buildLogContextFromOrder(order)]]), async () => {
    const exchange = exchangeRegistry.getExchange(order.exchangeInstanceId);

    // 1. Verify the live position still exists
    const liveStatus = await this.getLivePositionStatus(exchange, order);
    if (liveStatus === 'unknown') return; // keep monitoring, retry next cycle
    if (liveStatus === 'absent') {
      if (order.lifecycleStatus === 'PENDING') {
        entry.positionAbsentSince = undefined;
        return;
      }
      if (!entry.positionAbsentSince) {
        entry.positionAbsentSince = now;
        logger.warn(`NoStopLossMonitor: position absent precheck for ${order.symbol}, awaiting confirmation`, {
          orderId: order.id,
        });
        return;
      }
      if (now - entry.positionAbsentSince < this.CONFIRM_MS) {
        return;
      }
      await this.markOrderClosed(order, 'precheck');
      // Cancel any orphan SL/TP orders on the exchange
      await this.cancelOrphanProtections(order, exchange);
      this.clearQueryFailure(order, side);
      this.state.delete(key);
      return;
    }
    entry.positionAbsentSince = undefined;

    // 2. Check SL using explicit states
    const slState = await this.getStopLossState(order, side, exchange);
    if (slState === 'unknown') {
      return;
    }

    if (slState === 'present') {
      this.resetMissingState(entry, now);
      this.clearQueryFailure(order, side);
      return;
    }

    // 3. SL is missing
    if (now < entry.graceEndsAt) {
      // Still within grace period, nothing to do
      return;
    }

    entry.confirmed = true;
    entry.checkedAt = now;
    entry.missingConfirmations = (entry.missingConfirmations ?? 0) + 1;
    entry.firstMissingAt = entry.firstMissingAt ?? now;
    entry.lastMissingAt = now;

    if (entry.missingConfirmations < this.MISSING_SL_CONFIRMATIONS) {
      logger.warn(`NoStopLossMonitor: SL missing for ${order.symbol}, awaiting confirmation ${entry.missingConfirmations}/${this.MISSING_SL_CONFIRMATIONS}`, {
        orderId: order.id,
      });
      return;
    }

    // 4. Confirmed: SL has been missing through grace + confirm windows — attempt re-placement before auto-close
    logger.warn(`NoStopLossMonitor: Auto close — No SL for ${order.symbol} after confirmation window`, {
      orderId: order.id,
    });

    // Attempt SL re-placement before auto-close
    const pipeline = this.tradeExecutor.getProtectionPipeline?.(order.exchangeInstanceId);
    if (pipeline) {
      const pendingProtection = await PendingProtection.findOne({
        where: {
          orderId: order.exchangeOrderId,
          status: ['PENDING', 'CLAIMED'],
        },
      });
      if (pendingProtection) {
        const filledQty = parseFloat((order as any).filledAmount || (order as any).amount || '0');
        let tpOrders: { price: string; amount: string }[] = [];
        if ((pendingProtection as any).tpOrdersJson) {
          tpOrders = JSON.parse((pendingProtection as any).tpOrdersJson);
        } else if ((pendingProtection as any).takeProfit) {
          tpOrders = [{ price: (pendingProtection as any).takeProfit, amount: filledQty.toString() }];
        }
        try {
          const replResult = await pipeline.placeProtections({
            orderId: order.exchangeOrderId,
            symbol: order.symbol,
            side: side as 'buy' | 'sell',
            stopLossPrice: (pendingProtection as any).stopLoss ?? undefined,
            tpOrders,
            amount: filledQty > 0 ? filledQty.toString() : '0',
            source: 'no-stop-loss-monitor-retry',
            strategyId: order.strategyId,
          });
          if (replResult.slPlaced) {
            logger.info(`NoStopLossMonitor: SL re-placed successfully for ${order.symbol}`, {
              orderId: order.id,
            });
            this.resetMissingState(entry, now);
            this.clearQueryFailure(order, side);
            return;
          }
        } catch (err: any) {
          logger.warn(`NoStopLossMonitor: SL re-placement failed for ${order.symbol}`, formatError(err, { orderId: order.id }));
        }
      }
    }

    if (order.strategyId) {
      await auditService.log(order.strategyId, 'AUTO_CLOSED_NO_SL', {
        orderId: order.id,
        symbol: order.symbol,
      }, order.id);
    }

    const parsed: ParsedStrategy = {
      action: 'close',
      symbol: order.symbol,
      side: side,
      closePercentage: 100,
      raw: { reason: 'no_stop_loss_auto_close', orderId: order.id },
    };

    await this.tradeExecutor.handleClose(
      parsed,
      'system',
      undefined,
      order.strategyId,
      side,
      order.exchangeInstanceId
    );

    this.clearQueryFailure(order, side);
    this.state.delete(key);
    }); // end logContext.run
  }

  // ─── Helpers ────────────────────────────────────────────────────────────────

  private async delay(ms: number): Promise<void> {
    await new Promise(resolve => setTimeout(resolve, ms));
  }

  private async getPriceOrdersWithRetry(exchange: any, order: Order): Promise<PriceOrderFetchResult> {
    let lastError: any = null;
    for (let attempt = 0; attempt <= this.FETCH_RETRY; attempt++) {
      try {
        const orders = await exchange.getPriceOrders(order.symbol);
        return { orders, error: undefined };
      } catch (err: any) {
        lastError = err;
        logger.warn(`NoStopLossMonitor: getPriceOrders failed for ${order.symbol}`, formatError(err, { orderId: order.id, attempt: attempt + 1 }));
        if (attempt < this.FETCH_RETRY) {
          await this.delay(this.FETCH_RETRY_DELAY_MS);
        }
      }
    }
    logger.error(`NoStopLossMonitor: exhausted getPriceOrders retries for ${order.symbol}`, {
      orderId: order.id,
      error: lastError?.message,
    });
    return { orders: null, error: lastError };
  }

  private getQueryFailureKey(order: Order, side: 'buy' | 'sell'): string {
    return `${order.exchangeInstanceId || 'default'}:${order.symbol}:${side}`;
  }

  private clearQueryFailure(order: Order, side: 'buy' | 'sell'): void {
    this.queryFailureState.delete(this.getQueryFailureKey(order, side));
  }

  private clearQueryFailureByParts(exchangeInstanceId: string, symbol: string, side: 'buy' | 'sell'): void {
    this.queryFailureState.delete(`${exchangeInstanceId || 'default'}:${symbol}:${side}`);
  }

  private clearQueryFailureForEntry(entry: NoStopLossState): void {
    if (entry.side) {
      this.clearQueryFailureByParts(entry.exchangeInstanceId || 'default', entry.symbol, entry.side);
    }
  }

  private async recordQueryFailure(order: Order, side: 'buy' | 'sell', error: any): Promise<void> {
    const key = this.getQueryFailureKey(order, side);
    const now = Date.now();
    const lastError = error?.message ?? String(error);
    const current = this.queryFailureState.get(key);

    const nextState: QueryFailureState = current ? {
      ...current,
      failureCount: current.failureCount + 1,
      lastFailureAt: now,
      lastError,
    } : {
      failureCount: 1,
      firstFailureAt: now,
      lastFailureAt: now,
      lastError,
      alerted: false,
    };

    if (nextState.failureCount >= this.QUERY_FAILURE_ALERT_THRESHOLD && !nextState.alerted) {
      nextState.alerted = true;
      logger.warn(`NoStopLossMonitor: SL query degraded for ${order.symbol} ${side}`, {
        orderId: order.id,
        failureCount: nextState.failureCount,
        error: lastError,
      });
      if (order.strategyId) {
        await auditService.log(order.strategyId, 'SL_CHECK_DEGRADED', {
          orderId: order.id,
          symbol: order.symbol,
          side,
          failureCount: nextState.failureCount,
          firstFailureAt: nextState.firstFailureAt,
          lastFailureAt: nextState.lastFailureAt,
          lastError,
          exchangeInstanceId: order.exchangeInstanceId || 'default',
        }, order.id);
      }
    }

    this.queryFailureState.set(key, nextState);
  }

  private resetMissingState(entry: NoStopLossState, now: number): void {
    entry.checkedAt = now;
    entry.graceEndsAt = now + this.GRACE_MS;
    entry.confirmed = false;
    entry.missingConfirmations = 0;
    entry.firstMissingAt = undefined;
    entry.lastMissingAt = undefined;
  }

  private async getLivePositionStatus(exchange: any, order: Order): Promise<'present' | 'absent' | 'unknown'> {
    try {
      const position = await exchange.getPosition(order.symbol);
      if (!position) return 'absent';
      const size = parseFloat(position.size);
      // NaN or non-finite size means API returned invalid data (e.g. REST lag after WS fill)
      // Return 'unknown' to retry next cycle rather than 'absent' which would trigger forced close
      if (!Number.isFinite(size)) {
        logger.warn(`NoStopLossMonitor: Invalid position size for ${order.symbol}`, {
          orderId: order.id,
          size: position.size,
        });
        return 'unknown';
      }
      if (Math.abs(size) <= this.QTY_EPSILON) return 'absent';
      const positionSide: 'buy' | 'sell' = size > 0 ? 'buy' : 'sell';
      return positionSide === order.side ? 'present' : 'absent';
    } catch (err: any) {
      logger.warn(`NoStopLossMonitor: getPosition failed for ${order.symbol}`, formatError(err, { orderId: order.id }));
      return 'unknown';
    }
  }

  private async cancelOrphanProtections(order: Order, exchange: any): Promise<void> {
    try {
      const exchangeOrderId = order.exchangeOrderId;
      if (!exchangeOrderId) return;

      const pipeline = this.tradeExecutor.getProtectionPipeline?.(order.exchangeInstanceId);
      if (!pipeline) return;

      // Position-level SL is shared across orders — only cancel if truly orphaned
      const otherActiveOrders = await Order.findAll({
        where: {
          symbol: order.symbol,
          side: order.side,
          exchangeInstanceId: order.exchangeInstanceId,
          lifecycleStatus: ['PENDING', 'OPEN', 'PROTECTED'],
          isSimulated: false,
          id: { [Op.ne]: order.id },
        },
      });

      if (otherActiveOrders.length > 0) {
        logger.info(`NoStopLossMonitor: skipping orphan cancellation for ${order.symbol} — ${otherActiveOrders.length} other active ${order.side} orders`, {
          orderId: order.id,
          exchangeOrderId,
        });
        return;
      }

      await pipeline.cancelProtections(order.symbol, order.side as 'buy' | 'sell', exchangeOrderId);
      logger.info(`NoStopLossMonitor: cancelled orphan protections for ${order.symbol}`, {
        orderId: order.id,
        exchangeOrderId,
      });
    } catch (err: any) {
      logger.warn(`NoStopLossMonitor: failed to cancel orphan protections for ${order.symbol}`, formatError(err, { orderId: order.id }));
    }
  }

  private async markOrderClosed(order: Order, context: string): Promise<void> {
    try {
      if (order.lifecycleStatus === 'CLOSED') return;
      const fromStatus = order.lifecycleStatus;
      order.lifecycleStatus = 'CLOSED';
      order.status = 'closed';
      // 回测子进程：平仓时间记录为对应 K 线时间；实盘 nowOrSim() === new Date()
      order.closedAt = nowOrSim();
      if (order.exchangeInstanceId?.startsWith('v-')) {
        await this.backfillVirtualCloseFields(order);
      }
      await order.save();
      logger.info('Order lifecycle status changed', {
        orderId: order.id,
        exchangeOrderId: order.exchangeOrderId,
        fromStatus,
        toStatus: 'CLOSED',
        reason: `auto close - no SL protection (${context})`,
      });
    } catch (err: any) {
      logger.error('Failed to mark order CLOSED', formatError(err, { orderId: order.id, symbol: order.symbol, context }));
    }
  }

  private async backfillVirtualCloseFields(order: Order): Promise<void> {
    const trades = await VirtualTrade.findAll({
      where: {
        exchangeInstanceId: order.exchangeInstanceId,
        symbol: order.symbol,
      },
      order: [['executedAt', 'ASC']],
    });

    const entryOrderId = order.exchangeOrderId;
    const closeTrade = trades
      .filter((trade: any) => trade.virtualOrderId !== entryOrderId)
      .filter((trade: any) => String(trade.text || '').includes(String(order.activeStopLossId || '')) || String(trade.text || '').includes('t-sl-pos-') || String(trade.text || '').includes(String(entryOrderId || '')))
      [trades
        .filter((trade: any) => trade.virtualOrderId !== entryOrderId)
        .filter((trade: any) => String(trade.text || '').includes(String(order.activeStopLossId || '')) || String(trade.text || '').includes('t-sl-pos-') || String(trade.text || '').includes(String(entryOrderId || '')))
        .length - 1] as any;

    if (!closeTrade) return;

    order.exitPrice = closeTrade.price;
    order.closePrice = closeTrade.price;
    order.lastPrice = closeTrade.price;
    order.realizedPnl = Number(parseFloat(closeTrade.realizedPnl || '0').toFixed(4)).toFixed(4);
    order.closedAt = order.closedAt || closeTrade.executedAt;
  }

  /**
   * Check if the given order has a live SL by querying exchange price_orders.
   * Matches by symbol + side + rule (position-level SL detection).
   * No longer relies on activeStopLossId which may be stale.
   */
  private async getStopLossState(order: Order, side: 'buy' | 'sell', exchange: any): Promise<StopLossState> {
    const result = await this.getPriceOrdersWithRetry(exchange, order);
    if (result.error || !result.orders) {
      await this.recordQueryFailure(order, side, result.error || new Error('unknown price_orders failure'));
      return 'unknown';
    }

    this.clearQueryFailure(order, side);

    const slRule = side === 'buy' ? 2 : 1; // Long SL uses rule 2, Short SL uses rule 1
    const legacyToken = order.exchangeOrderId ? `t-sl-ord-${order.exchangeOrderId}` : '';
    const activeStopLossId = order.activeStopLossId ? String(order.activeStopLossId) : '';

    const slOrder = result.orders.find((o: any) => {
      const rule = o.trigger?.rule;
      const raw = o.raw && typeof o.raw === 'object' ? o.raw : {};
      const isReduceOnly =
        o.reduce_only === true ||
        o.reduceOnly === true ||
        raw.reduce_only === true ||
        raw.reduceOnly === true ||
        o.initial?.reduce_only === true ||
        o.initial?.is_reduce_only === true ||
        o.initial?.auto_size === 'close';
      const orderSymbol = o.initial?.contract || o.contract || o.symbol || raw.symbol || '';
      const orderText = [o.text, o.initial?.text].filter(Boolean).join(' ');
      const legacyTokenMatch = !!legacyToken && orderText.includes(legacyToken);
      const activeStopLossIdMatch = !!activeStopLossId && (
        String(o.id ?? '') === activeStopLossId ||
        orderText.includes(activeStopLossId)
      );
      const legacyMatch = legacyTokenMatch || activeStopLossIdMatch;
      const ruleMatch = rule === slRule && isReduceOnly && orderSymbol === order.symbol;
      const orderType = String(o.type ?? raw.order_type ?? raw.orderType ?? raw.type ?? '').toUpperCase();
      // 入场单自带 SL（Gate tpsl_sl_trigger_price 生成的 close-long-order/close-short-order）：
      // 属于 reduce-only 关仓触发单，rule 与方向匹配即可认定 SL 存在，避免误判裸仓触发自动平仓。
      const attachedOrderType = side === 'buy' ? 'close-long-order' : 'close-short-order';
      const rawOrderType = String(raw.order_type ?? raw.orderType ?? o.order_type ?? o.orderType ?? '').toLowerCase();
      const attachedSlMatch = rawOrderType === attachedOrderType && rule === slRule;
      const closeSide = side === 'buy' ? 'sell' : 'buy';
      const sideMatches = !o.side || o.side === closeSide;
      const lighterStopLossMatch =
        (orderType === 'STOP_LOSS' || orderType === 'STOP_LOSS_LIMIT') &&
        isReduceOnly &&
        sideMatches &&
        orderSymbol === order.symbol;

      return ruleMatch || legacyMatch || lighterStopLossMatch || attachedSlMatch;
    });

    if (slOrder) {
      return 'present';
    }

    logger.warn(`NoStopLossMonitor: No SL found for ${order.symbol} ${side} (rule=${slRule}, total priceOrders=${result.orders.length})`, {
      orderId: order.id,
    });
    return 'missing';
  }

  private async hasStopLoss(order: Order, side: 'buy' | 'sell', exchange: any): Promise<boolean> {
    const state = await this.getStopLossState(order, side, exchange);
    return state !== 'missing';
  }
}
