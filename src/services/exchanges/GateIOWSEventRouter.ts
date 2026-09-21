/**
 * GateIOWSEventRouter - WebSocket Event Routing and Position Monitoring
 *
 * This router processes WebSocket events from Gate.io and dispatches them to appropriate handlers.
 *
 * **Event Types:**
 * - futures.orders: Order updates (fill, cancel)
 * - futures.positions: Position updates (size, PnL changes)
 * - futures.balances: Balance updates
 *
 * **Position Close Detection:**
 * - Monitors position_update events for size=0
 * - Defers close detection when a pending open is in flight (leverage/margin transitions
 *   cause transient size=0 on the WS feed)
 * - Double REST verification: first check after 1.5s, second check after 3s to catch
 *   slow exchange state propagation
 * - Cancels SL orders and marks all related orders as CLOSED only after confirmation
 *
 * **Integration:**
 * - Called by GateIOWebSocket.onMessage()
 * - Publishes events to Redis for async processing
 * - Uses ProtectionPipeline for SL cancellation
 * - Checks GateIOExchange.pendingOpenSymbols to avoid false close detection
 */

import logger, { formatError } from '../../utils/logger';
import { OrderPersistenceHandler } from '../OrderPersistenceHandler';
import auditService from '../AuditService';

export interface WsOrderEvent {
  type: 'order_update';
  orderId: string;
  symbol: string;
  status: string;
  filledSize: number;
  filledPrice: number;
  text: string;
  isReduceOnly: boolean;
  timestamp: number;
}

export interface WsPositionEvent {
  type: 'position_update';
  symbol: string;
  size: number;
  entryPrice: number;
  markPrice: number;
  unrealizedPnl: number;
}

export interface WsBalanceEvent {
  type: 'balance_update';
  currency: string;
  available: string;
  orderMargin: string;
}

export class GateIOWSEventRouter {
  private readonly closeCleanupCooldownMs = 2000;
  private closeCleanupInFlight = new Set<string>();
  private recentCloseCleanupAt = new Map<string, number>();

  /** REST re-verification delay after WS size=0 before marking orders CLOSED. */
  private readonly restConfirmDelayMs: number;
  /** Whether to REST-verify position close before marking orders CLOSED. */
  private readonly restConfirmEnabled: boolean;
  /** Delay before second REST verification (catches slow leverage/margin transitions). */
  private readonly restSecondConfirmDelayMs: number;
  /** Maximum time (ms) to defer close detection while a pending open is in flight. */
  private readonly pendingOpenDeferMs: number;

  constructor(
    private exchange: any, // GateIOExchange instance (for handleWsOrderUpdate)
    private orderPersistenceHandler: OrderPersistenceHandler,
    options?: { restConfirmDelayMs?: number; restConfirmEnabled?: boolean; pendingOpenDeferMs?: number }
  ) {
    this.restConfirmDelayMs = options?.restConfirmDelayMs ?? 1500;
    this.restConfirmEnabled = options?.restConfirmEnabled ?? true;
    this.restSecondConfirmDelayMs = options?.restConfirmDelayMs !== undefined ? options.restConfirmDelayMs * 2 : 3000;
    this.pendingOpenDeferMs = options?.pendingOpenDeferMs ?? 10000;
  }

  /**
   * Route a raw WS message from Gate.io to appropriate handler.
   * Called by GateIOWebSocket.onMessage().
   *
   * WS message structure: { channel: string, result: any }
   * - channel='futures.orders' -> order update
   * - channel='futures.positions' -> position update
   * - channel='futures.balances' -> balance update
   */
  public route(raw: any): void {
    const channel = raw.channel;
    const result = raw.result;
    if (!result) return;

    try {
      if (channel === 'futures.orders') {
        this.handleOrderUpdate(result);
      } else if (channel === 'futures.positions') {
        this.handlePositionUpdate(result);
      }
    } catch (e) {
      logger.error('WS message routing failed', formatError(e, { channel }));
    }
  }

  private handleOrderUpdate(result: any): void {
    const events = Array.isArray(result) ? result : [result];
    for (const event of events) {
      // GateIOExchange owns fill-listener resolution and order persistence;
      // Gate completion events require `left` to distinguish fills from cancels.
      this.exchange.handleWsOrderUpdate(event);
    }
  }

  private handlePositionUpdate(result: any): void {
    const events = Array.isArray(result) ? result : [result];
    for (const event of events) {
      // Check if position is closed (size = 0)
      this.checkPositionClosed(event);
      // Direct call for position update
      this.orderPersistenceHandler.handlePositionUpdate({
        type: 'position_update',
        symbol: event.contract,
        size: event.size,
        entryPrice: String(event.entryPrice || event.entry_price || '0'),
        markPrice: String(event.markPrice || event.mark_price || '0'),
        unrealizedPnl: String(event.unrealisedPnl || event.unrealised_pnl || '0')
      }).catch(err => {
        logger.error('[GateIOWSEventRouter] handlePositionUpdate failed', { error: err });
      });
    }
  }

  /**
   * Check if a position is closed (size = 0) and cancel SL orders immediately.
   * This provides instant cleanup when positions are manually closed or hit SL/TP.
   *
   * Guards against false positives from:
   * 1. Pending open operations (leverage/margin mode changes cause transient size=0)
   * 2. Slow exchange state propagation (double REST verification)
   */
  private async checkPositionClosed(positionEvent: any): Promise<void> {
    try {
      const symbol = positionEvent.contract || positionEvent.symbol;
      const size = parseFloat(positionEvent.size || '0');

      if (!symbol || !Number.isFinite(size)) {
        return;
      }

      // Position still open — nothing to do
      if (Math.abs(size) > 1e-8) {
        this.recentCloseCleanupAt.delete(symbol);
        return;
      }

      if (this.closeCleanupInFlight.has(symbol)) {
        logger.info(`[WSEventRouter] Close cleanup already in flight for ${symbol}, skipping duplicate position event`);
        return;
      }

      const lastCleanupAt = this.recentCloseCleanupAt.get(symbol);
      if (lastCleanupAt && Date.now() - lastCleanupAt < this.closeCleanupCooldownMs) {
        logger.info(`[WSEventRouter] Close cleanup recently completed for ${symbol}, skipping duplicate position event`);
        return;
      }

      // Guard: if a pending open is in flight for this symbol, defer close detection.
      // Leverage/margin mode changes cause transient size=0 on the WS feed.
      const pendingOpenSymbols: Set<string> | undefined = (this.exchange as any)?.pendingOpenSymbols;
      if (pendingOpenSymbols?.has(symbol)) {
        logger.info(`[WSEventRouter] Pending open in flight for ${symbol}, deferring close detection by ${this.pendingOpenDeferMs}ms`);
        const deferredSymbol = symbol;
        setTimeout(() => {
          this.checkPositionClosed({ contract: deferredSymbol, size: '0' }).catch(err => {
            logger.warn(`[WSEventRouter] Deferred close check failed for ${deferredSymbol}`, formatError(err));
          });
        }, this.pendingOpenDeferMs);
        return;
      }

      this.closeCleanupInFlight.add(symbol);

      logger.info(`[WSEventRouter] Position closed detected for ${symbol} (size=${size}) — verifying via REST before cleanup`);

      // REST re-verification: wait briefly then confirm position is truly closed.
      // This prevents false positives when another strategy's close causes a
      // transient size=0 that is immediately followed by a new open on the same symbol.
      if (this.restConfirmEnabled) {
        logger.info(`[WSEventRouter] REST confirmation: waiting ${this.restConfirmDelayMs}ms before verifying ${symbol} position close`);
        await new Promise(resolve => setTimeout(resolve, this.restConfirmDelayMs));

        try {
          const positions = await this.exchange.getPositions();
          // In hedge mode (dual position), Gate.io returns separate long/short legs for the same
          // contract. Using find() would return only the first match — if the zero-size leg comes
          // first, we'd falsely confirm "position closed" even though the other leg is still open.
          // Fix: check ALL legs for this symbol; position is open if ANY leg has non-zero size.
          const symbolPositions = positions.filter((p: any) => p.symbol === symbol);
          const openPosition = symbolPositions.find((p: any) => Math.abs(parseFloat(p.size || '0')) > 1e-8);
          const openSize = openPosition ? parseFloat(openPosition.size || '0') : 0;

          if (Math.abs(openSize) > 1e-8) {
            logger.info(`[WSEventRouter] REST confirmation: ${symbol} position still open (size=${openSize}, legs=${symbolPositions.length}), skipping close cleanup`);
            this.recentCloseCleanupAt.delete(symbol);
            return;
          }

          logger.info(`[WSEventRouter] REST confirmation: ${symbol} position confirmed closed (size=0, legs=${symbolPositions.length}), running second verification`);
        } catch (restErr: any) {
          logger.warn(`[WSEventRouter] REST confirmation failed for ${symbol}, proceeding with WS-based cleanup`, formatError(restErr));
          // Fall through to existing cleanup logic
        }

        // Second REST verification: catches slow leverage/margin transitions where
        // the first REST check (1.5s) still sees size=0 but the position reappears later.
        try {
          logger.info(`[WSEventRouter] Second REST verification: waiting ${this.restSecondConfirmDelayMs}ms for ${symbol}`);
          await new Promise(resolve => setTimeout(resolve, this.restSecondConfirmDelayMs));

          const positions2 = await this.exchange.getPositions();
          // Same hedge-mode fix as first verification: check ALL legs.
          const symbolPositions2 = positions2.filter((p: any) => p.symbol === symbol);
          const openPosition2 = symbolPositions2.find((p: any) => Math.abs(parseFloat(p.size || '0')) > 1e-8);
          const openSize2 = openPosition2 ? parseFloat(openPosition2.size || '0') : 0;

          if (Math.abs(openSize2) > 1e-8) {
            logger.info(`[WSEventRouter] Second REST verification: ${symbol} position reopened (size=${openSize2}, legs=${symbolPositions2.length}), aborting close cleanup`);
            this.recentCloseCleanupAt.delete(symbol);
            return;
          }

          logger.info(`[WSEventRouter] Second REST verification: ${symbol} position confirmed closed (size=0, legs=${symbolPositions2.length}), proceeding with cleanup`);
        } catch (restErr: any) {
          logger.warn(`[WSEventRouter] Second REST verification failed for ${symbol}, proceeding with first verification result`, formatError(restErr));
        }
      }

      // Third guard: protection orders still open on the exchange → position NOT closed.
      // Gate.io auto-cancels position-level triggers when a position is fully closed, so the
      // presence of SL/TP protection orders proves the position is still open. This catches
      // false positives where a fresh market fill emits a transient size=0 position event and
      // Gate's REST position feed lags (testnet eventual consistency), even after the two
      // REST verifications above each saw size=0.
      try {
        const openExchangeOrders = await this.exchange.getOpenOrders(symbol);
        const protectives = (openExchangeOrders || []).filter((o: any) => {
          const t = String(o.text || '');
          return t.includes('-tp-') || t.includes('t-sl-') || t.includes('-sl-');
        });
        if (protectives.length > 0) {
          logger.info(`[WSEventRouter] Skip close cleanup for ${symbol}: ${protectives.length} protection order(s) still open on exchange — position not actually closed`);
          this.recentCloseCleanupAt.delete(symbol);
          return;
        }
      } catch (protErr: any) {
        logger.warn(`[WSEventRouter] Protection presence check failed for ${symbol}, proceeding with close cleanup`, formatError(protErr));
      }

      // Find all OPEN/PROTECTED orders for this symbol on this exchange instance
      const { Order } = require('../../models');
      const exchangeInstanceId = (this.exchange as any).id;
      const orders = await Order.findAll({
        where: {
          symbol,
          lifecycleStatus: ['OPEN', 'PROTECTED'],
          exchangeInstanceId,
        },
      });

      logger.info(`[WSEventRouter] Found ${orders.length} active orders for ${symbol}`);

      // Determine side from orders, or query recent orders if none found
      let side: 'buy' | 'sell' | null = null;
      
      if (orders.length > 0) {
        side = orders[0].side as 'buy' | 'sell';
      } else {
        // No active orders found, query recent orders to determine side
        const recentOrders = await Order.findAll({
          where: { symbol, exchangeInstanceId },
          order: [['updatedAt', 'DESC']],
          limit: 1,
        });
        
        if (recentOrders.length > 0) {
          side = recentOrders[0].side as 'buy' | 'sell';
          logger.info(`[WSEventRouter] No active orders, using side from recent order: ${side}`);
        } else {
          logger.warn(`[WSEventRouter] No orders found for ${symbol}, cannot determine side for SL cancellation`);
        }
      }

      // Cancel SL orders only for sides that have tracked orders
      // to avoid cancelling protections on manually-managed positions
      logger.info(`[WSEventRouter] Attempting to get ProtectionPipeline for ${symbol}`);

      const pipeline = (this.exchange as any).orderPersistenceHandler?.protectionPipeline;

      logger.info(`[WSEventRouter] ProtectionPipeline available: ${!!pipeline}`);

      if (pipeline) {
        for (const s of ['buy', 'sell'] as const) {
          const hasTrackedOrders = orders.some((o: any) => o.side === s);
          if (!hasTrackedOrders) {
            logger.info(`[WSEventRouter] No tracked ${s} orders for ${symbol}, skipping SL cancellation to protect manual positions`);
            continue;
          }
          try {
            logger.info(`[WSEventRouter] Calling cancelProtections for ${symbol} ${s}`);
            await pipeline.cancelProtections(symbol, s);
            logger.info(`[WSEventRouter] Cancelled SL orders for ${symbol} ${s}`);
          } catch (err: any) {
            logger.warn(`[WSEventRouter] Failed to cancel SL for ${symbol} ${s}`, formatError(err));
          }
        }
      } else {
        logger.warn(`[WSEventRouter] ProtectionPipeline not available for ${symbol}, skipping SL cancellation`);
      }

      // Mark all orders as CLOSED
      if (orders.length > 0) {
        const now = new Date();
        for (const order of orders) {
          const fromStatus = order.lifecycleStatus;
          order.lifecycleStatus = 'CLOSED';
          order.status = 'closed';
          order.closedAt = now;
          await order.save();
          logger.info('Order lifecycle status changed', {
            orderId: order.id,
            exchangeOrderId: order.exchangeOrderId,
            fromStatus,
            toStatus: 'CLOSED',
            reason: 'position closed on exchange',
          });
        }
        logger.info(`[WSEventRouter] Marked ${orders.length} orders as CLOSED for ${symbol}`);
        for (const order of orders) {
          if (order.strategyId) {
            await auditService.log(order.strategyId, 'POSITION_CLOSED_WS', {
              symbol,
              orderId: order.id,
              exchangeOrderId: order.exchangeOrderId,
            }, order.id, 'CLOSED');
          }
        }
      }

      this.recentCloseCleanupAt.set(symbol, Date.now());

    } catch (err: any) {
      logger.error('Position close check failed', formatError(err, { symbol: positionEvent?.contract || positionEvent?.symbol }));
    } finally {
      const symbol = positionEvent?.contract || positionEvent?.symbol;
      if (symbol) {
        this.closeCleanupInFlight.delete(symbol);
      }
    }
  }
}
