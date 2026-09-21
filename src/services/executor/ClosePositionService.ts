import { Op } from 'sequelize';
import { Order, StrategyPosition, AuditLog, sequelize } from '../../models';
import logger, { formatError } from '../../utils/logger';
import { createNamedStageDebug } from '../../utils/debug';
import { OrderResult } from '../exchanges/IExchange';
import { ParsedStrategy, StrategyRiskConfig } from '../parsers/types';
import { parsePositiveAmount, roundToPrecision, formatAmountWithPrecision } from '../TradeMath';
import { buildTakeProfitOrderText } from '../../utils/orderText';
import { CloseScopeResolver } from '../CloseScopeResolver';
import { isScopedOpenOrder, isScopedProtectionOrder, extractTpStepFromRawMessage } from '../OrderClassifier';
import { ExecutorServices, ExecutorCapabilities, summarizeParsedForDebug } from './deps';
import cfdPriceSyncService from '../CfdPriceSyncService';

const debugOrderClose = createNamedStageDebug('order', 'close');

export class ClosePositionService {
  constructor(
    private readonly services: ExecutorServices,
    private readonly capabilities: ExecutorCapabilities,
  ) {}

  public async handleClose(
    parsed: ParsedStrategy,
    source: string,
    riskConfig: StrategyRiskConfig | undefined,
    strategyId?: number,
    targetPositionSide?: 'buy' | 'sell',
    exchangeInstanceId?: string,
  ): Promise<OrderResult | null> {
    debugOrderClose('started %o', {
        strategyId,
        exchangeInstanceId,
        source,
        targetPositionSide,
        parsed: summarizeParsedForDebug(parsed),
    });
    const exchange = this.services.exchangeRegistry.getExchange(exchangeInstanceId);

    // Use CloseScopeResolver for scope resolution
    const resolver = new CloseScopeResolver();
    const scope = await resolver.resolve({
        parsed,
        strategyId,
        exchangeInstanceId,
        targetPositionSide,
    });

    const { scopedOrders, scopeOrderIds, scopeStrategyIds, expectedPositionSide, scopeMode } = scope;
    const parsedPositionSide = parsed.side === 'buy' || parsed.side === 'sell' ? parsed.side : undefined;
    const resolvedExpectedPositionSide = targetPositionSide || parsedPositionSide || expectedPositionSide;
    debugOrderClose('scope resolved %o', {
        strategyId,
        exchangeInstanceId,
        symbol: parsed.symbol,
        scopeMode,
        scopedOrderIds: scopedOrders.map((order) => order.id),
        scopeOrderIds,
        scopeStrategyIds,
        expectedPositionSide: resolvedExpectedPositionSide,
    });

    if (scopedOrders.length === 0) {
        logger.warn(`No scoped active order found for close ${parsed.symbol}`, { strategyId, parsedOrderId: parsed.orderId, scopeMode });

        // Manual Intervention Detection: If no tracked orders but position exists, it's manual
        const positions = await exchange.getPositions();
        const hasPosition = positions.some(p => {
            if (p.symbol !== parsed.symbol) return false;
            const size = parseFloat(p.size);
            if (!Number.isFinite(size) || size === 0) return false;
            const posSide = size > 0 ? 'buy' : 'sell';
            return posSide === resolvedExpectedPositionSide;
        });

        if (hasPosition) {
            logger.error(`Manual intervention detected: Position exists for ${parsed.symbol} but no tracked orders found. Refusing to close manual position.`, {
                strategyId,
                scopeMode,
                symbol: parsed.symbol,
            });
            return null;
        }

        if (!targetPositionSide && !parsedPositionSide) {
            debugOrderClose('skipped because no scoped active orders found and no position side was provided %o', {
                strategyId,
                exchangeInstanceId,
                symbol: parsed.symbol,
                parsedOrderId: parsed.orderId,
                scopeMode,
            });
            return null;
        }
    }

    // Handle the case where scopedOrders contain only CLOSED orders
    // (found via CloseScopeResolver's tryClosedOrders fallback).
    // This means the position was already closed by WSEventRouter/SL/TP
    // before this close signal arrived. We should handle gracefully.
    const allScopedClosed = scopedOrders.length > 0 && scopedOrders.every(o => o.lifecycleStatus === 'CLOSED');
    if (allScopedClosed) {
        debugOrderClose('all scoped orders are already CLOSED, checking exchange position %o', {
            strategyId,
            exchangeInstanceId,
            symbol: parsed.symbol,
            scopeMode,
            scopedOrderIds: scopedOrders.map(o => o.id),
        });

        const positions = await exchange.getPositions();
        const position = positions.find(p => {
            if (p.symbol !== parsed.symbol) return false;
            const size = parseFloat(p.size);
            if (!Number.isFinite(size) || size === 0) return false;
            return resolvedExpectedPositionSide === 'buy' ? size > 0 : size < 0;
        });

        if (!position) {
            logger.info(`Close signal arrived after position was already closed (scope=${scopeMode}). Skipping.`, {
                strategyId,
                symbol: parsed.symbol,
                scopeMode,
                closedOrderIds: scopedOrders.map(o => o.id),
            });
            return {
                id: 'close-skipped-already-closed',
                status: 'filled',
                symbol: parsed.symbol,
                amount: '0',
                text: 'Already Closed'
            };
        }

        // Position still exists on exchange but our orders are all CLOSED.
        // This typically happens when WSEventRouter prematurely marked orders CLOSED
        // (e.g., another strategy's close triggered size=0 on the same symbol),
        // or when SL/TP closed the tracked position but the close signal refers to
        // the same trade. Execute the close based on the actual position size
        // rather than the stale CLOSED order metadata.
        logger.info(`Position exists but tracked orders are CLOSED for ${parsed.symbol}. Executing close based on actual position size.`, {
            strategyId,
            symbol: parsed.symbol,
            scopeMode,
            positionSize: position.size,
            expectedPositionSide: resolvedExpectedPositionSide,
        });

        // Calculate close amount from actual position, not from CLOSED orders
        const positionAbs = Math.abs(parseFloat(position.size));
        let finalCloseAmount = positionAbs;

        // Apply TP distribution ratio if applicable
        const tpStep = extractTpStepFromRawMessage(parsed.raw);
        const tpDistribution = riskConfig?.tpDistribution || [];
        const ratioFromTpDistribution = tpStep && tpStep > 0 ? tpDistribution[tpStep - 1] : undefined;

        if (parsed.closePercentage && parsed.closePercentage > 0 && parsed.closePercentage < 100) {
            finalCloseAmount = positionAbs * (parsed.closePercentage / 100);
        } else if (ratioFromTpDistribution && ratioFromTpDistribution > 0 && ratioFromTpDistribution < 1) {
            finalCloseAmount = positionAbs * ratioFromTpDistribution;
        }
        finalCloseAmount = Math.min(finalCloseAmount, positionAbs);

        let amountPrecision = 0;
        try {
            const markets = await exchange.getMarkets();
            const market = markets.find(m => m.symbol === parsed.symbol);
            if (market) amountPrecision = market.amountPrecision;
        } catch (e) {}

        // Apply ratio_based scaling to closeAmount
        if (riskConfig?.riskMode === 'ratio_based' && finalCloseAmount !== positionAbs) {
            const ratioMultiplier = Math.max(0.01, Math.min(10, riskConfig.riskValue || 1));
            if (ratioMultiplier !== 1) {
                finalCloseAmount = roundToPrecision(finalCloseAmount * ratioMultiplier, amountPrecision);
                logger.info(`ratio_based close: ratioMultiplier=${ratioMultiplier}, scaled=${finalCloseAmount}`);
            }
        }
        finalCloseAmount = Math.min(finalCloseAmount, positionAbs);

        let formattedAmount = formatAmountWithPrecision(finalCloseAmount, amountPrecision);
        const closeAmountNum = parseFloat(formattedAmount);
        if (!Number.isFinite(closeAmountNum) || closeAmountNum <= 0) {
            logger.warn(`Scoped close amount resolved to zero for CLOSED-order close`, { symbol: parsed.symbol, positionAbs, scopeMode });
            return null;
        }

        // Execute the close order directly on the exchange
        const closeSide = resolvedExpectedPositionSide === 'buy' ? 'sell' : 'buy';
        try {
            const closeText = `t-close-${strategyId || 'signal'}`;
            const closed = await exchange.closePosition(parsed.symbol, closeSide, undefined, formattedAmount, closeText);

            if (!closed) {
                logger.warn(`closePosition returned false for CLOSED-order close: ${parsed.symbol}`, {
                    strategyId, symbol: parsed.symbol, scopeMode, closeSide, closeAmount: formattedAmount,
                });
                return null;
            }

            logger.info(`Close executed for CLOSED-order position: ${parsed.symbol} ${closeSide} ${formattedAmount}`, {
                strategyId,
                symbol: parsed.symbol,
                scopeMode,
                closeSide,
                closeAmount: formattedAmount,
            });

            return {
                id: `closed-order-close-${strategyId || 'signal'}`,
                status: 'filled',
                symbol: parsed.symbol,
                amount: formattedAmount,
                text: closeText,
            };
        } catch (err: any) {
            logger.error(`Failed to execute close for CLOSED-order position: ${parsed.symbol}`, formatError(err, {
                strategyId,
                symbol: parsed.symbol,
                scopeMode,
                closeSide,
                closeAmount: formattedAmount,
            }));
            return null;
        }
    }

    const mappingByOrderId = new Map<number, StrategyPosition>();
    for (const o of scopedOrders) {
        const mapping = await this.services.orderPersistenceHandler.upsertStrategyPositionFromOrder(o, parsed.raw?.parserName || parsed.raw?.parser);
        mappingByOrderId.set(o.id, mapping);
    }

    const scopeExchangeOrderIds = new Set(scopedOrders.map(o => o.exchangeOrderId).filter(Boolean));

    try {
        const openOrders = await exchange.getOpenOrders(parsed.symbol);
        for (const order of openOrders) {
            const byExchangeOrderId = scopeExchangeOrderIds.has(order.id);
            const byScopedTextOrReduceOnly = isScopedOpenOrder(order, scopeOrderIds, scopeStrategyIds, resolvedExpectedPositionSide);
            if (!byExchangeOrderId && !byScopedTextOrReduceOnly) continue;
            await exchange.cancelOrder(order.id, parsed.symbol);
        }
    } catch (err: any) {
        logger.warn(`Failed scoped open-order cancellation for ${parsed.symbol}`, formatError(err, { scopeMode }));
    }

    try {
        const priceOrders = await exchange.getPriceOrders(parsed.symbol);
        for (const order of priceOrders) {
            if (!isScopedProtectionOrder(order, scopeOrderIds, scopeStrategyIds)) continue;
            await exchange.cancelPriceOrder(order.id, parsed.symbol);
        }
    } catch (err: any) {
        logger.warn(`Failed scoped trigger-order cancellation for ${parsed.symbol}`, formatError(err, { scopeMode }));
    }

    const positions = await exchange.getPositions();
    const position = positions.find(p => {
        if (p.symbol !== parsed.symbol) return false;
        const size = parseFloat(p.size);
        if (!Number.isFinite(size) || size === 0) return false;
        return resolvedExpectedPositionSide === 'buy' ? size > 0 : size < 0;
    });

    if (!position) {
        logger.warn(`No exchange position found for scoped close`, { symbol: parsed.symbol, expectedPositionSide: resolvedExpectedPositionSide, scopeMode });
        debugOrderClose('no exchange position found, returning close-skipped %o', {
            strategyId,
            exchangeInstanceId,
            symbol: parsed.symbol,
            expectedPositionSide: resolvedExpectedPositionSide,
            scopeMode,
        });
        return {
            id: 'close-skipped',
            status: 'filled',
            symbol: parsed.symbol,
            amount: '0',
            text: 'No Position'
        };
    }

    let amountPrecision = 0;
    try {
        const markets = await exchange.getMarkets();
        const market = markets.find(m => m.symbol === parsed.symbol);
        if (market) amountPrecision = market.amountPrecision;
    } catch (e) {
        logger.debug('Failed to fetch market info for amount precision in close scope', formatError(e, { symbol: parsed.symbol }));
    }

    const strategyTracked = scopedOrders.reduce((sum, order) => {
        const mapped = mappingByOrderId.get(order.id);
        const remaining = parsePositiveAmount(mapped?.remainingSize);
        if (remaining !== null) return sum + remaining;
        return sum + this.services.orderPersistenceHandler.getOrderTrackedAmount(order);
    }, 0);
    const positionAbs = Math.abs(parseFloat(position.size));
    const trackedCloseBase = strategyTracked > this.capabilities.protectionQtyEpsilon ? strategyTracked : positionAbs;
    let finalCloseAmount = trackedCloseBase;
    const tpStep = extractTpStepFromRawMessage(parsed.raw);
    const tpDistribution = riskConfig?.tpDistribution || [];
    const ratioFromTpDistribution = tpStep && tpStep > 0 ? tpDistribution[tpStep - 1] : undefined;
    const requestedCloseAmount = parsePositiveAmount(parsed.closeAmount || parsed.raw?.closeAmount || parsed.raw?.amount);
    if (requestedCloseAmount !== null) {
        finalCloseAmount = requestedCloseAmount;
    } else if (parsed.closePercentage && parsed.closePercentage > 0 && parsed.closePercentage < 100) {
        finalCloseAmount = trackedCloseBase * (parsed.closePercentage / 100);
    } else if (ratioFromTpDistribution && ratioFromTpDistribution > 0 && ratioFromTpDistribution < 1) {
        finalCloseAmount = trackedCloseBase * ratioFromTpDistribution;
    }
    finalCloseAmount = Math.min(finalCloseAmount, trackedCloseBase, positionAbs);

    // Apply ratio_based scaling to closeAmount
    if (riskConfig?.riskMode === 'ratio_based' && finalCloseAmount !== trackedCloseBase) {
        const ratioMultiplier = Math.max(0.01, Math.min(10, riskConfig.riskValue || 1));
        if (ratioMultiplier !== 1) {
            finalCloseAmount = roundToPrecision(finalCloseAmount * ratioMultiplier, amountPrecision);
            logger.info(`ratio_based close: ratioMultiplier=${ratioMultiplier}, scaled=${finalCloseAmount}`);
        }
    }
    finalCloseAmount = Math.min(finalCloseAmount, positionAbs);

    let formattedAmount = formatAmountWithPrecision(finalCloseAmount, amountPrecision);
    let closeAmountNum = parseFloat(formattedAmount);
    if (!Number.isFinite(closeAmountNum) || closeAmountNum <= 0) {
        logger.warn(`Scoped close amount resolved to zero`, { symbol: parsed.symbol, strategyTracked, positionAbs, scopeMode });
        debugOrderClose('skipped because close amount resolved to zero %o', {
            strategyId,
            exchangeInstanceId,
            symbol: parsed.symbol,
            strategyTracked,
            positionAbs,
            scopeMode,
        });
        return null;
    }
    if (closeAmountNum > positionAbs + this.capabilities.protectionQtyEpsilon) {
        const maxAvailable = formatAmountWithPrecision(positionAbs, amountPrecision);
        logger.warn(`Scoped close amount exceeds available position after precision format, clamping`, {
            symbol: parsed.symbol,
            requested: formattedAmount,
            maxAvailable
        });
        if (parsePositiveAmount(maxAvailable) === null) return null;
        formattedAmount = maxAvailable;
        closeAmountNum = parseFloat(formattedAmount);
    }
    if (!Number.isFinite(closeAmountNum) || closeAmountNum <= 0) {
        logger.warn(`Scoped close amount resolved to zero`, { symbol: parsed.symbol, strategyTracked, positionAbs, scopeMode });
        debugOrderClose('skipped because close amount resolved to zero after clamp %o', {
            strategyId,
            exchangeInstanceId,
            symbol: parsed.symbol,
            strategyTracked,
            positionAbs,
            scopeMode,
        });
        return null;
    }

    const closeSide = parseFloat(position.size) > 0 ? 'sell' : 'buy';
    const auditStrategyId = strategyId || scopeStrategyIds[0];
    if (auditStrategyId) {
        await this.services.auditService.log(auditStrategyId, 'SUBMITTING_CLOSE_ORDER', {
            symbol: parsed.symbol,
            side: closeSide,
            amount: formattedAmount,
            scopeMode,
            strategyTracked,
            positionAbs
        });
    }

    // Build TP-prefixed order text for breakeven-on-TP logic
    let tpOrderText: string | undefined;
    if (tpStep && tpStep > 0 && scopedOrders.length > 0 && scopedOrders[0].exchangeOrderId) {
        tpOrderText = buildTakeProfitOrderText(tpStep, scopedOrders[0].exchangeOrderId);
        debugOrderClose('TP step detected, will use TP-prefixed order text %o', {
            strategyId, tpStep, tpOrderText, linkedOrderId: scopedOrders[0].exchangeOrderId,
        });
    }

    // Cancel per-order protections before closing.
    // For TP-triggered closes: skip cancellation entirely — existing TP protection orders
    // should remain active for the remaining position; the SL will be moved to breakeven
    // by GateIOOrderPersistenceHandler when it detects the TP-prefixed order fill.
    const pm = this.services.protectionContext.getProtectionManager(exchangeInstanceId);
    if (!tpOrderText) {
        for (const order of scopedOrders) {
            try {
                await pm.cancelProtections(
                    parsed.symbol,
                    order.side as 'buy' | 'sell',
                    order.exchangeOrderId
                );
            } catch (err: any) {
                logger.warn(`Failed to cancel protections for order ${order.id}`, formatError(err));
            }
        }
    } else {
        debugOrderClose('TP close — skipping protection cancellation, SL will move to BE on fill %o', {
            strategyId, tpStep, tpOrderText,
        });
    }

    // ── syncCfdPrice：平仓价格基准切换为 CFD 市场实时价 ──
    // 当路由配置 riskSettings.syncCfdPrice=true 且未显式给出 closePrice 时，
    // 用 CFD（gate_tradfi）实时价作为平仓限价，保证「按 CFD 价格平仓、无价差」。
    let effectiveClosePrice = parsed.closePrice;
    if (riskConfig?.syncCfdPrice === true && !effectiveClosePrice) {
        try {
            const cfdPrice = await cfdPriceSyncService.getCfdLastPrice(parsed.symbol);
            if (cfdPrice !== null && cfdPrice > 0) {
                effectiveClosePrice = String(cfdPrice);
                logger.info(`[syncCfdPrice] ${parsed.symbol} closePrice set from CFD: ${effectiveClosePrice}`);
            }
        } catch (err: any) {
            logger.warn(`[syncCfdPrice] failed to resolve CFD close price for ${parsed.symbol}`, formatError(err));
        }
    }

    const success = await exchange.closePosition(parsed.symbol, closeSide, effectiveClosePrice, formattedAmount, tpOrderText);
    if (!success) {
        if (auditStrategyId) {
            await this.services.auditService.log(auditStrategyId, 'CLOSE_ORDER_FAILED', { symbol: parsed.symbol, amount: formattedAmount, scopeMode });
        }
        debugOrderClose('exchange close position failed %o', {
            strategyId,
            auditStrategyId,
            exchangeInstanceId,
            symbol: parsed.symbol,
            closeSide,
            amount: formattedAmount,
            scopeMode,
        });
        return { id: 'close-pos', status: 'failed', symbol: parsed.symbol, amount: formattedAmount };
    }
    debugOrderClose('exchange close position succeeded %o', {
        strategyId,
        auditStrategyId,
        exchangeInstanceId,
        symbol: parsed.symbol,
        closeSide,
        amount: formattedAmount,
        scopeMode,
    });

    // If position is fully closed, cancel all position-level protections
    try {
        const remainingPosition = await exchange.getPosition(parsed.symbol);
        const remainingSize = Math.abs(parseFloat(remainingPosition?.size || '0'));
        if (remainingSize <= this.capabilities.protectionQtyEpsilon) {
            const pipeline = this.services.protectionContext.getProtectionPipeline(exchangeInstanceId);
            const positionSide = closeSide === 'sell' ? 'buy' : 'sell';
            await pipeline.cancelProtections(parsed.symbol, positionSide);
            logger.info(`[TradeExecutor] Fully closed position, cancelled all protections for ${parsed.symbol} ${positionSide}`);
        }
    } catch (err: any) {
        logger.warn(`[TradeExecutor] Failed to cancel position-level protections after full close`, formatError(err));
    }

    // Record trading stats for each fully closed order
    try {
        const recentTrades = await exchange.getTradeHistory(parsed.symbol, 1);
        const exitPrice = recentTrades.length > 0 ? recentTrades[0].price : (parsed.closePrice || undefined);
        const exitTime = recentTrades.length > 0 ? new Date(recentTrades[0].time) : new Date();
        // 平仓侧成交手续费（USDT，取最近一笔平仓成交的费用；多笔拆分为近似）。
        const exitFee = recentTrades.length > 0 ? parseFloat(recentTrades[0].fee || '0') || 0 : 0;
        if (exitPrice) {
            for (const order of scopedOrders) {
                try {
                    await this.services.tradingStatsService.recordOrderStats(order.id, exitPrice, exitTime, exitFee);
                } catch (statsErr: any) {
                    logger.warn(`Failed to record stats for order ${order.id}`, formatError(statsErr));
                }
            }
        }
    } catch (tradeErr: any) {
        logger.warn('Failed to fetch trade history for stats recording', formatError(tradeErr));
    }

    // Record lastPrice for each scoped order
    try {
        const ticker = await exchange.getTicker(parsed.symbol);
        if (ticker?.lastPrice) {
            for (const order of scopedOrders) {
                if (!order.lastPrice) {
                    order.lastPrice = ticker.lastPrice;
                    await order.save();
                }
            }
        }
    } catch (tickerErr: any) {
        logger.warn('Failed to fetch ticker for lastPrice recording', formatError(tickerErr));
    }

    const now = new Date();
    if (scopedOrders.length === 0) {
        debugOrderClose('completed exchange-position close without scoped local order %o', {
            strategyId,
            auditStrategyId,
            exchangeInstanceId,
            symbol: parsed.symbol,
            amount: formattedAmount,
            scopeMode,
        });
        return {
            id: 'close-pos',
            status: 'filled',
            symbol: parsed.symbol,
            amount: formattedAmount
        };
    }

    await sequelize.transaction(async (tx) => {
        let remainingToAllocate = parseFloat(formattedAmount);
        for (const order of scopedOrders) {
            if (remainingToAllocate <= this.capabilities.protectionQtyEpsilon) break;
            const mapped = mappingByOrderId.get(order.id) || await this.services.orderPersistenceHandler.upsertStrategyPositionFromOrder(order, parsed.raw?.parserName || parsed.raw?.parser, tx);
            const currentRemaining = parsePositiveAmount(mapped.remainingSize) || 0;
            if (currentRemaining <= this.capabilities.protectionQtyEpsilon) continue;
            const reduced = Math.min(currentRemaining, remainingToAllocate);
            const nextRemaining = Math.max(0, currentRemaining - reduced);
            const nextStatus: 'OPEN' | 'PARTIAL' | 'CLOSED' = nextRemaining <= this.capabilities.protectionQtyEpsilon ? 'CLOSED' : 'PARTIAL';
            await mapped.update({
                remainingSize: nextRemaining.toString(),
                status: nextStatus,
                closedAt: nextStatus === 'CLOSED' ? now : null
            }, { transaction: tx });

            if (nextStatus === 'CLOSED') {
                order.status = 'closed';
                order.lifecycleStatus = 'CLOSED';
                order.closedAt = now;
                await order.save({ transaction: tx });
            } else {
                order.status = 'partially_closed';
                await order.save({ transaction: tx });
            }

            if (auditStrategyId) {
                await AuditLog.create({
                    strategyId: auditStrategyId,
                    orderId: order.id,
                    action: 'MANUAL_CLOSE_SCOPE_APPLIED',
                    lifecycleStatus: order.lifecycleStatus,
                    exchangeInstanceId: order.exchangeInstanceId,
                    details: JSON.stringify({
                        symbol: parsed.symbol,
                        closeAmount: reduced.toString(),
                        remainingPosition: nextRemaining.toString(),
                        scopeMode,
                        scopedOrderId: order.id
                    })
                }, { transaction: tx });
            }
            remainingToAllocate -= reduced;
        }

        const strategyStats = await StrategyPosition.findAll({
            where: {
                symbol: parsed.symbol,
                strategyId: { [Op.in]: scopeStrategyIds.length > 0 ? scopeStrategyIds : [-1] },
                status: ['OPEN', 'PARTIAL']
            },
            transaction: tx
        });
        if (auditStrategyId) {
            const remainingByStrategy = strategyStats.reduce((acc: Record<string, number>, item) => {
                const key = String(item.strategyId || 0);
                acc[key] = (acc[key] || 0) + (parsePositiveAmount(item.remainingSize) || 0);
                return acc;
            }, {});
            await AuditLog.create({
                strategyId: auditStrategyId,
                action: 'STRATEGY_POSITION_STATS_SYNCED',
                exchangeInstanceId: exchangeInstanceId,
                details: JSON.stringify({
                    symbol: parsed.symbol,
                    scopeMode,
                    closedAmount: formattedAmount,
                    remainingByStrategy
                })
            }, { transaction: tx });
        }
    });

    debugOrderClose('completed %o', {
        strategyId,
        auditStrategyId,
        exchangeInstanceId,
        symbol: parsed.symbol,
        amount: formattedAmount,
        scopeMode,
    });
    return {
        id: 'close-pos',
        status: 'filled',
        symbol: parsed.symbol,
        amount: formattedAmount
    };
  }
}