import { Op } from 'sequelize';
import logger, { formatError } from '../../utils/logger';
import { Order, PendingProtection, StrategyPosition } from '../../models';
import { ParsedStrategy } from '../parsers/types';
import { OrderResult } from '../exchanges/IExchange';

/**
 * Cancels an unfilled entry order when a management message (close / cut /
 * stop-to-entry / breakeven) arrives for it.
 *
 * Rationale: if the trader already moved to breakeven or cut the trade while
 * our limit entry is still pending, the original setup is invalid. Leaving the
 * limit alive means we can fill hours later at the exact level the trader has
 * already abandoned ("buying the knife"). Management before fill must therefore
 * invalidate the entry instead of waiting for a position that will never be
 * managed.
 *
 * No time-based TTL is applied here: the trigger is always an explicit new
 * instruction linked (via reply chain or symbol) to the pending entry.
 */
export class PendingEntryService {
  constructor(
    private readonly exchangeRegistry: any,
    private readonly auditService: any,
  ) {}

  public async cancelUnfilledEntry(params: {
    parsed: ParsedStrategy;
    exchangeInstanceId?: string;
    strategyId?: number;
    reason: string;
  }): Promise<OrderResult | null> {
    const { parsed, exchangeInstanceId, strategyId, reason } = params;
    if (!parsed.symbol) return null;
    if (!['close', 'update', 'cancel'].includes(parsed.action)) return null;

    let exchange: any;
    try {
      exchange = this.exchangeRegistry.getExchange(exchangeInstanceId);
    } catch (error: any) {
      logger.warn('[PendingEntry] exchange lookup failed', formatError(error, { exchangeInstanceId }));
      return null;
    }
    if (!exchange) return null;

    // Only cancel when the exchange has no live position for this symbol/side:
    // a management message for an existing position must go through the normal
    // close/update path.
    try {
      const positions = await exchange.getPositions();
      const hasPosition = (positions || []).some((position: any) => {
        if (position.symbol !== parsed.symbol) return false;
        const size = parseFloat(position.size);
        if (!Number.isFinite(size) || Math.abs(size) < 1e-8) return false;
        if (parsed.side === 'buy') return size > 0;
        if (parsed.side === 'sell') return size < 0;
        return true;
      });
      if (hasPosition) return null;
    } catch (error: any) {
      logger.warn('[PendingEntry] position check failed', formatError(error, { symbol: parsed.symbol }));
      return null;
    }

    let order: Order | null = null;
    try {
      order = await this.findPendingOrder(parsed, exchangeInstanceId, strategyId);
    } catch (error: any) {
      logger.warn('[PendingEntry] pending order lookup failed', formatError(error, { symbol: parsed.symbol }));
      return null;
    }

    if (!order || !order.exchangeOrderId) return null;

    logger.info('[PendingEntry] Cancelling unfilled entry after management signal', {
      orderId: order.id,
      exchangeOrderId: order.exchangeOrderId,
      symbol: order.symbol,
      side: order.side,
      strategyId,
      replyStrategyId: parsed.replyStrategyId,
      replyOrderId: parsed.replyOrderId,
      reason,
    });

    const cancelled = await exchange.cancelOrder(order.exchangeOrderId, order.symbol);
    if (!cancelled) {
      logger.warn('[PendingEntry] Exchange rejected the cancel; leaving order state untouched', {
        orderId: order.id,
        exchangeOrderId: order.exchangeOrderId,
        reason,
      });
      return null;
    }

    try {
      order.status = 'cancelled';
      order.lifecycleStatus = 'CLOSED';
      order.closedAt = new Date();
      await order.save();

      await PendingProtection.destroy({
        where: {
          [Op.or]: [
            { orderId: order.exchangeOrderId },
            { orderId: `t-entry-${order.id}` },
          ],
        },
      });

      await StrategyPosition.update(
        { status: 'CLOSED', remainingSize: '0', closedAt: new Date() },
        { where: { orderId: order.id } },
      );

      await this.auditService.log(
        Number(strategyId ?? order.strategyId ?? 0),
        'PENDING_ENTRY_CANCELLED',
        {
          symbol: order.symbol,
          side: order.side,
          exchangeOrderId: order.exchangeOrderId,
          reason,
          replyStrategyId: parsed.replyStrategyId ?? null,
          replyOrderId: parsed.replyOrderId ?? null,
        },
        order.id,
        'CLOSED',
        exchangeInstanceId ?? order.exchangeInstanceId,
      );
    } catch (error: any) {
      logger.warn('[PendingEntry] Failed to persist cancellation state', formatError(error, { orderId: order.id }));
    }

    return {
      id: order.exchangeOrderId,
      status: 'cancelled',
      amount: order.amount,
      price: order.price,
      raw: {
        reason,
        cancelledPendingOrderId: order.id,
        exchangeOrderId: order.exchangeOrderId,
      },
    };
  }

  private async findPendingOrder(
    parsed: ParsedStrategy,
    exchangeInstanceId?: string,
    strategyId?: number,
  ): Promise<Order | null> {
    const baseWhere: any = {
      symbol: parsed.symbol,
      lifecycleStatus: { [Op.in]: ['INIT', 'PENDING'] },
    };
    if (exchangeInstanceId) baseWhere.exchangeInstanceId = exchangeInstanceId;

    // 1) Exact reply target wins.
    if (parsed.replyOrderId != null) {
      return await Order.findOne({ where: { ...baseWhere, id: parsed.replyOrderId } });
    }
    if (parsed.replyStrategyId != null) {
      const exact = await Order.findOne({
        where: { ...baseWhere, strategyId: parsed.replyStrategyId },
        order: [['createdAt', 'DESC']],
      });
      if (exact) return exact;
    }

    // 2) Strategy of the management message itself (older parsers).
    if (strategyId != null) {
      const exact = await Order.findOne({
        where: { ...baseWhere, strategyId },
        order: [['createdAt', 'DESC']],
      });
      if (exact) return exact;
    }

    // 3) Widen to route/source, but only when there is exactly one candidate:
    // never cancel a different strategy's entry on the same symbol by guess.
    const widenWhere: any = { ...baseWhere };
    const routeId = (parsed.raw as any)?.routeId;
    const source = (parsed.raw as any)?.source;
    if (routeId != null) widenWhere.routeId = routeId;
    else if (source) widenWhere.source = source;

    const candidates = await Order.findAll({
      where: widenWhere,
      order: [['createdAt', 'DESC']],
      limit: 5,
    });
    if (candidates.length === 1) return candidates[0];
    if (candidates.length > 1) {
      logger.warn('[PendingEntry] Multiple pending entries match; refusing to guess', {
        symbol: parsed.symbol,
        candidates: candidates.map((candidate) => candidate.id),
      });
    }
    return null;
  }
}
