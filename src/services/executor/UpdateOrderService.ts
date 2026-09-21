import { Op } from 'sequelize';
import { Order } from '../../models';
import logger, { formatError } from '../../utils/logger';
import { createNamedStageDebug } from '../../utils/debug';
import { OrderResult } from '../exchanges/IExchange';
import { ParsedStrategy, StrategyRiskConfig } from '../parsers/types';
import { ExecutorServices, summarizeParsedForDebug } from './deps';
import { ClosePositionService } from './ClosePositionService';

const debugOrderUpdate = createNamedStageDebug('order', 'update');
const debugOrderCancel = createNamedStageDebug('order', 'cancel');

export class UpdateOrderService {
  constructor(
    private readonly services: ExecutorServices,
    private readonly closePositionService: ClosePositionService,
  ) {}

  public async handleUpdate(parsed: ParsedStrategy, strategyId?: number, exchangeInstanceId?: string, source?: string, riskConfig?: StrategyRiskConfig): Promise<OrderResult | null> {
    logger.info('handleUpdate started', { strategyId, exchangeInstanceId, action: parsed.action, symbol: parsed.symbol, side: parsed.side, stopLoss: parsed.stopLoss });
    debugOrderUpdate('started %o', {
        strategyId,
        exchangeInstanceId,
        parsed: summarizeParsedForDebug(parsed),
    });
    const exchange = this.services.exchangeRegistry.getExchange(exchangeInstanceId);
    let targetOrder: Order | null = null;

    if (parsed.orderId) {
        const orderIdNum = parseInt(parsed.orderId, 10);
        const orderIdCandidates: any[] = [{ exchangeOrderId: parsed.orderId }];
        if (Number.isFinite(orderIdNum)) {
            orderIdCandidates.push({ id: orderIdNum });
        }
        targetOrder = await Order.findOne({
            where: {
                symbol: parsed.symbol,
                lifecycleStatus: ['OPEN', 'PROTECTED'],
                ...(exchangeInstanceId ? { exchangeInstanceId } : {}),
                [Op.or]: orderIdCandidates
            },
            order: [['createdAt', 'DESC']]
        });
    }

    if (!targetOrder && strategyId) {
        targetOrder = await Order.findOne({
            where: {
                strategyId,
                symbol: parsed.symbol,
                lifecycleStatus: ['OPEN', 'PROTECTED'],
                ...(exchangeInstanceId ? { exchangeInstanceId } : {})
            },
            order: [['createdAt', 'DESC']]
        });

        // Fallback 1: when WSEventRouter prematurely marks orders as CLOSED,
        // look for recently CLOSED orders so we can still update their DB records
        // (activeStopLossId, currentSl) after SL updates on the exchange.
        if (!targetOrder) {
            const thirtyMinutesAgo = new Date(Date.now() - 30 * 60 * 1000);
            targetOrder = await Order.findOne({
                where: {
                    strategyId,
                    symbol: parsed.symbol,
                    lifecycleStatus: 'CLOSED',
                    closedAt: { [Op.gte]: thirtyMinutesAgo },
                    ...(exchangeInstanceId ? { exchangeInstanceId } : {}),
                },
                order: [['closedAt', 'DESC']],
            });
            if (targetOrder) {
                logger.info(`[handleUpdate] strategyId=${strategyId} matched no OPEN/PROTECTED orders for ${parsed.symbol}, using recently CLOSED order ${targetOrder.id} for DB sync`, { strategyId, symbol: parsed.symbol, closedOrderId: targetOrder.id });
            }
        }
    }

    // Fallback 2: when strategyId doesn't match any order (e.g., TP/update signals
    // have different strategyId than the open signal), widen the search using
    // routeId/source from parsed.raw (similar to CloseScopeResolver widening).
    if (!targetOrder && parsed.symbol) {
        const raw = parsed.raw || {};
        const routeId = raw.routeId;
        const source = raw.source;

        // Try widening by routeId or source
        const widenWhere: any = {
            symbol: parsed.symbol,
            lifecycleStatus: ['OPEN', 'PROTECTED'],
            ...(exchangeInstanceId ? { exchangeInstanceId } : {}),
        };

        let widenReason = '';
        if (routeId) {
            widenWhere.routeId = routeId;
            widenReason = `routeId=${routeId}`;
        } else if (source) {
            widenWhere.source = source;
            widenReason = `source=${source}`;
        }

        // Only widen if we have a constraint (routeId or source) to avoid
        // matching unrelated orders on the same symbol
        if (widenReason) {
            targetOrder = await Order.findOne({
                where: widenWhere,
                order: [['createdAt', 'DESC']],
            });
            if (targetOrder) {
                logger.info(`[handleUpdate] strategyId=${strategyId} matched no orders for ${parsed.symbol}, using active order ${targetOrder.id} (strategyId=${targetOrder.strategyId}) by ${widenReason} widening`, { strategyId, symbol: parsed.symbol, fallbackOrderId: targetOrder.id, fallbackStrategyId: targetOrder.strategyId, widenReason });
            }

            // Fallback 2b: if no OPEN/PROTECTED orders found by widening, try recently CLOSED
            if (!targetOrder) {
                const thirtyMinutesAgo = new Date(Date.now() - 30 * 60 * 1000);
                const closedWhere = { ...widenWhere, lifecycleStatus: 'CLOSED', closedAt: { [Op.gte]: thirtyMinutesAgo } };
                delete (closedWhere as any).lifecycleStatus;
                (closedWhere as any).lifecycleStatus = 'CLOSED';
                targetOrder = await Order.findOne({
                    where: closedWhere,
                    order: [['closedAt', 'DESC']],
                });
                if (targetOrder) {
                    logger.info(`[handleUpdate] strategyId=${strategyId} matched no orders for ${parsed.symbol}, using recently CLOSED order ${targetOrder.id} (strategyId=${targetOrder.strategyId}) by ${widenReason} widening`, { strategyId, symbol: parsed.symbol, closedOrderId: targetOrder.id, closedStrategyId: targetOrder.strategyId, widenReason });
                }
            }
        }
    }

    const rawSide = parsed.side && (parsed.side as string) !== 'unknown' ? parsed.side : undefined;
    const effectiveSide = rawSide || targetOrder?.side;
    const positions = await exchange.getPositions();
    const position = positions.find(p =>
        p.symbol === parsed.symbol &&
        (effectiveSide ? (effectiveSide === 'buy' ? parseFloat(p.size) > 0 : parseFloat(p.size) < 0) : parseFloat(p.size) !== 0)
    );

    if (!position) {
        logger.warn(`Received UPDATE for ${parsed.symbol} but no active position found. Ignoring.`);
        debugOrderUpdate('skipped because no active position found %o', {
            strategyId,
            exchangeInstanceId,
            symbol: parsed.symbol,
            effectiveSide,
        });
        return null;
    }

    let newSLPrice: string | undefined;

    if (parsed.stopLoss) {
        if (parsed.stopLoss.toLowerCase() === 'breakeven') {
            const fromOrderEntry = parseFloat(targetOrder?.filledPrice || targetOrder?.price || '0');
            const entryPrice = Number.isFinite(fromOrderEntry) && fromOrderEntry > 0
                ? fromOrderEntry
                : parseFloat(position.entryPrice);
            const bufferPercent = 0;
            const isLong = parseFloat(position.size) > 0;

            const bufferedPrice = isLong
                ? entryPrice * (1 + bufferPercent)
                : entryPrice * (1 - bufferPercent);

            const markets = await exchange.getMarkets();
            const market = markets.find(m => m.symbol === parsed.symbol);
            if (market) {
                newSLPrice = bufferedPrice.toFixed(market.pricePrecision);
            } else {
                newSLPrice = bufferedPrice.toString();
            }

            logger.info(`Calculated Breakeven SL for ${parsed.symbol}: ${newSLPrice} (Entry: ${entryPrice}, Buffer: ${bufferPercent * 100}%)`);

        } else {
            newSLPrice = parsed.stopLoss;
        }
    }

    if (newSLPrice) {
        try {
            if (strategyId) await this.services.auditService.log(strategyId, 'UPDATING_SL', { newSL: newSLPrice, type: parsed.stopLoss });

            // side represents the POSITION direction (not close direction):
            // long position → side='buy', short position → side='sell'
            // This matches GateIOExchange.updateStopLoss which interprets
            // side='buy' as long (close=buy→sell) and side='sell' as short (close=sell→buy)
            const side = parseFloat(position.size) > 0 ? 'buy' : 'sell';
            const trackedQty = targetOrder ? this.services.orderPersistenceHandler.getOrderTrackedAmount(targetOrder) : 0;
            const updateAmount = trackedQty > 0
                ? trackedQty.toString()
                : Math.abs(parseFloat(position.size)).toString();
            // When targetOrder is CLOSED, use position-level SL update (exchange.updateStopLoss)
            // rather than ProtectionManager.placeStopLoss which ties the SL to a specific order.
            const isOrderActive = targetOrder && targetOrder.lifecycleStatus !== 'CLOSED';
            const newSlId = isOrderActive && targetOrder?.exchangeOrderId
                ? await this.services.protectionContext.getProtectionManager(exchangeInstanceId).placeStopLoss({
                    orderId: targetOrder.exchangeOrderId,
                    symbol: parsed.symbol,
                    side,
                    amount: updateAmount,
                    stopLossPrice: newSLPrice!,
                    source: strategyId ? `strategy-${strategyId}` : 'unknown',
                })
                : await exchange.updateStopLoss(
                    parsed.symbol,
                    side,
                    newSLPrice!,
                    `t-sl-pos-${parsed.symbol}-${side === 'buy' ? 'sell' : 'buy'}`, // close-side convention (matches ProtectionManager)
                    updateAmount,
                );
            if (newSlId) {
                if (targetOrder) {
                    targetOrder.currentSl = newSLPrice;
                    targetOrder.activeStopLossId = newSlId;
                    await targetOrder.save();
                }
                logger.info(`Successfully updated SL for ${parsed.symbol} to ${newSLPrice}`);
                debugOrderUpdate('stop loss updated %o', {
                    strategyId,
                    exchangeInstanceId,
                    symbol: parsed.symbol,
                    newSLPrice,
                    newSlId,
                    targetOrderId: targetOrder?.id,
                });
                return { id: 'update-sl', status: 'filled', symbol: parsed.symbol };
            } else {
                logger.warn(`Failed to update SL for ${parsed.symbol} (ProtectionManager returned null)`);
                debugOrderUpdate('stop loss update failed with null id %o', {
                    strategyId,
                    exchangeInstanceId,
                    symbol: parsed.symbol,
                    newSLPrice,
                    targetOrderId: targetOrder?.id,
                });
                // Defensive fallback: if breakeven SL cannot be placed (price already at/above breakeven),
                // close the position at market instead of leaving it unprotected.
                if (parsed.stopLoss?.toLowerCase() === 'breakeven') {
                    return await this.fallbackBreakevenToClose(parsed, strategyId, exchangeInstanceId, source, riskConfig);
                }
                return { id: 'update-sl-failed', status: 'failed', symbol: parsed.symbol };
            }

        } catch (error: any) {
            logger.error('Failed to update SL', formatError(error, { symbol: parsed.symbol, strategyId }));
            debugOrderUpdate('stop loss update threw %o', {
                strategyId,
                exchangeInstanceId,
                symbol: parsed.symbol,
                ...formatError(error),
            });
            // Defensive fallback: if breakeven SL cannot be placed (price already at/above breakeven),
            // close the position at market instead of leaving it unprotected.
            if (parsed.stopLoss?.toLowerCase() === 'breakeven') {
                return await this.fallbackBreakevenToClose(parsed, strategyId, exchangeInstanceId, source, riskConfig);
            }
            return { id: 'update-sl-failed', status: 'failed', symbol: parsed.symbol };
        }
    }

    debugOrderUpdate('skipped because no new stop loss was resolved %o', {
        strategyId,
        exchangeInstanceId,
        symbol: parsed.symbol,
    });
    return null;
  }

  /**
   * Defensive fallback: when a breakeven SL update fails (typically because the current
   * price is already at or past breakeven, so Gate.io rejects Trigger.Price >= last_price),
   * close the position at market instead of leaving it with the old SL or no SL at all.
   */
  private async fallbackBreakevenToClose(
      parsed: ParsedStrategy,
      strategyId?: number,
      exchangeInstanceId?: string,
      source?: string,
      riskConfig?: StrategyRiskConfig,
  ): Promise<OrderResult | null> {
      logger.warn(`[Breakeven Fallback] Breakeven SL failed for ${parsed.symbol}, falling back to market close`);
      debugOrderUpdate('breakeven fallback to close %o', {
          strategyId,
          exchangeInstanceId,
          symbol: parsed.symbol,
      });
      const closeParsed: ParsedStrategy = {
          action: 'close',
          symbol: parsed.symbol,
          side: parsed.side,
          closePercentage: 100,
          raw: {
              ...(parsed.raw || {}),
              reason: 'breakeven_sl_failed_fallback_close',
          },
      };
      return this.closePositionService.handleClose(closeParsed, source || 'breakeven-fallback', riskConfig, strategyId, parsed.side as 'buy' | 'sell', exchangeInstanceId);
  }

  public async handleCancel(parsed: ParsedStrategy, strategyId?: number, exchangeInstanceId?: string, routeId?: number): Promise<OrderResult | null> {
    debugOrderCancel('started %o', {
        strategyId,
        routeId,
        exchangeInstanceId,
        parsed: summarizeParsedForDebug(parsed),
    });
    const exchange = this.services.exchangeRegistry.getExchange(exchangeInstanceId);
    if (parsed.orderId) {
      if (strategyId) await this.services.auditService.log(strategyId, 'CANCELLING_ORDER', { orderId: parsed.orderId });
      const success = await exchange.cancelOrder(parsed.orderId, parsed.symbol);

      const orderRecord = await Order.findOne({ where: { exchangeOrderId: parsed.orderId } });
      if (orderRecord) {
          orderRecord.status = success ? 'cancelled' : 'failed';
          orderRecord.lifecycleStatus = 'CLOSED';
          if (strategyId) this.services.orderPersistenceHandler.updateRelatedMessages(orderRecord, strategyId);
          await orderRecord.save();
          if (strategyId) await this.services.auditService.log(strategyId, 'ORDER_CLOSED_CANCEL', { orderId: orderRecord.id }, undefined, 'CLOSED');
      }

      debugOrderCancel('cancel by explicit order id completed %o', {
        strategyId,
        routeId,
        exchangeInstanceId,
        symbol: parsed.symbol,
        orderId: parsed.orderId,
        success,
        trackedOrderId: orderRecord?.id,
      });
      return { id: parsed.orderId, status: success ? 'cancelled' : 'failed', symbol: parsed.symbol };
    }

    const scopedOrder = await Order.findOne({
      where: {
        symbol: parsed.symbol,
        ...(parsed.side ? { side: parsed.side } : {}),
        ...(routeId ? { routeId } : {}),
        ...(exchangeInstanceId ? { exchangeInstanceId } : {}),
        lifecycleStatus: { [Op.in]: ['INIT', 'PENDING'] },
      },
      order: [['createdAt', 'DESC']],
    });

    if (!scopedOrder?.exchangeOrderId) {
      logger.warn(`Received CANCEL for ${parsed.symbol} but no scoped pending order found. Ignoring.`, {
        routeId,
        exchangeInstanceId,
        side: parsed.side,
      });
      debugOrderCancel('skipped because no scoped pending order found %o', {
        strategyId,
        routeId,
        exchangeInstanceId,
        symbol: parsed.symbol,
        side: parsed.side,
      });
      return null;
    }

    if (strategyId) {
      await this.services.auditService.log(strategyId, 'CANCELLING_ORDER', {
        orderId: scopedOrder.exchangeOrderId,
        routeId,
        reason: 'scoped_symbol_cancel',
      });
    }

    const success = await exchange.cancelOrder(scopedOrder.exchangeOrderId, parsed.symbol);
    scopedOrder.status = success ? 'cancelled' : 'failed';
    scopedOrder.lifecycleStatus = success ? 'CLOSED' : 'FAILED';
    if (strategyId) this.services.orderPersistenceHandler.updateRelatedMessages(scopedOrder, strategyId);
    await scopedOrder.save();
    if (strategyId && success) {
      await this.services.auditService.log(strategyId, 'ORDER_CLOSED_CANCEL', { orderId: scopedOrder.id }, undefined, 'CLOSED');
    }

    debugOrderCancel('scoped cancel completed %o', {
      strategyId,
      routeId,
      exchangeInstanceId,
      symbol: parsed.symbol,
      exchangeOrderId: scopedOrder.exchangeOrderId,
      orderId: scopedOrder.id,
      success,
    });
    return { id: scopedOrder.exchangeOrderId, status: success ? 'cancelled' : 'failed', symbol: parsed.symbol };
  }
}