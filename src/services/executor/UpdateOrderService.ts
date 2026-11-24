import { Op } from 'sequelize';
import { Order, Strategy, StrategyPosition } from '../../models';
import logger, { formatError } from '../../utils/logger';
import { createNamedStageDebug } from '../../utils/debug';
import { buildTakeProfitOrderText } from '../../utils/orderText';
import { OrderResult, Position, MarketInfo } from '../exchanges/IExchange';
import { ParsedStrategy, StrategyRiskConfig } from '../parsers/types';
import { ExecutorServices, summarizeParsedForDebug } from './deps';
import { ClosePositionService } from './ClosePositionService';
import { PendingEntryService } from './PendingEntryService';

const debugOrderUpdate = createNamedStageDebug('order', 'update');
const debugOrderCancel = createNamedStageDebug('order', 'cancel');

/** Risk multipliers are floats; treat near-equality as equality. */
const RISK_MULTIPLIER_EPSILON = 1e-9;

export class UpdateOrderService {
  private readonly pendingEntryService: PendingEntryService;

  constructor(
    private readonly services: ExecutorServices,
    private readonly closePositionService: ClosePositionService,
  ) {
    this.pendingEntryService = new PendingEntryService(services.exchangeRegistry, services.auditService);
  }

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

    // Reply-chain targeting: management signals (risk-note resize / breakeven /
    // 1R plan) carry the replied-to signal's order/strategy ids. Prefer the exact
    // reply target over the widened route/source search below.
    if (!targetOrder && (parsed.replyOrderId != null || parsed.replyStrategyId != null)) {
        const replyOrderIdNum = parsed.replyOrderId != null ? Number(parsed.replyOrderId) : NaN;
        const replyWhere: any = {
            symbol: parsed.symbol,
            ...(exchangeInstanceId ? { exchangeInstanceId } : {}),
        };
        if (Number.isFinite(replyOrderIdNum)) {
            replyWhere.id = replyOrderIdNum;
        } else if (parsed.replyStrategyId != null) {
            replyWhere.strategyId = parsed.replyStrategyId;
        }
        const replyOrder = await Order.findOne({
            where: { ...replyWhere, lifecycleStatus: ['OPEN', 'PROTECTED', 'INIT', 'PENDING'] },
            order: [['createdAt', 'DESC']],
        });
        if (replyOrder) {
            targetOrder = replyOrder;
            logger.info(`[handleUpdate] matched reply-chain target order ${replyOrder.id} for ${parsed.symbol}`, {
                strategyId,
                symbol: parsed.symbol,
                replyOrderId: parsed.replyOrderId ?? null,
                replyStrategyId: parsed.replyStrategyId ?? null,
                matchedOrderId: replyOrder.id,
            });
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

    // ── 频道级风险管理扩展（仅当解析器显式设置新字段时才进入；─────────────
    // ── 未设置时完全跳过后面的分支，其他解析器行为与改动前一致。─────────────

    // A1. 按目标 riskMultiplier 缩放「已有持仓 / 未成交挂单」（Raizexbt "0.5R" 类 risk-resize 信号）。
    if (parsed.riskResize === true && typeof parsed.riskMultiplier === 'number') {
        debugOrderUpdate('risk resize requested %o', {
            strategyId,
            exchangeInstanceId,
            symbol: parsed.symbol,
            riskMultiplier: parsed.riskMultiplier,
        });
        return this.handleRiskResize(parsed, targetOrder, strategyId, exchangeInstanceId, source, riskConfig);
    }

    // A2. 入场价 ± N×R 的 reduce-only 限价止盈计划（成交后由 TP1→移 BE 的既有链路接管）。
    if (typeof parsed.planRMultiple === 'number' && parsed.planRMultiple > 0) {
        debugOrderUpdate('R-multiple plan requested %o', {
            strategyId,
            exchangeInstanceId,
            symbol: parsed.symbol,
            planRMultiple: parsed.planRMultiple,
            planClosePercentage: parsed.planClosePercentage,
        });
        return this.handleRMultiplePlan(parsed, targetOrder, strategyId, exchangeInstanceId);
    }

    const rawSide = parsed.side && (parsed.side as string) !== 'unknown' ? parsed.side : undefined;
    const effectiveSide = rawSide || targetOrder?.side;
    const positions = await exchange.getPositions();
    const position = positions.find(p =>
        p.symbol === parsed.symbol &&
        (effectiveSide ? (effectiveSide === 'buy' ? parseFloat(p.size) > 0 : parseFloat(p.size) < 0) : parseFloat(p.size) !== 0)
    );

    if (!position) {
        // A management signal (stop-to-entry / breakeven) for a position whose
        // entry order has not filled yet must invalidate that pending entry:
        // the trader already changed the plan, so filling hours later would
        // open a position nobody is managing.
        if (String(parsed.stopLoss || '').toLowerCase() === 'breakeven') {
            const cancelled = await this.pendingEntryService.cancelUnfilledEntry({
                parsed,
                exchangeInstanceId,
                strategyId,
                reason: 'breakeven-update-before-entry-fill',
            });
            if (cancelled) {
                logger.info('Cancelled unfilled entry because a breakeven update arrived before fill', {
                    strategyId,
                    symbol: parsed.symbol,
                    exchangeOrderId: cancelled.id,
                });
                return cancelled;
            }
        }

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

            // A3. 浮亏时的保本语义保护（仅当解析器显式设置 breakevenMode 时生效）。
            // 交易员说「保本」，但执行时价格已经在亏损侧，此时把 SL 移到入场价会被交易所
            // 拒绝（trigger price 已在错误一侧）。按 breakevenMode 决定降级行为：
            //  - 'protect'：恢复原止损，绝不市价全平；
            //  - 'exit_at_entry'：在入场价挂 reduce-only 限价平仓单（回本平仓），保留原止损。
            // 未设置 breakevenMode 的旧解析器完全跳过这里，保持原有行为（失败→市价平仓兜底）。
            if (parsed.breakevenMode != null) {
                const guard = await this.handleBreakevenInLossGuard({
                    parsed,
                    exchange,
                    position,
                    targetOrder,
                    strategyId,
                    exchangeInstanceId,
                    source,
                    riskConfig,
                    entryPrice,
                    isLong,
                    market,
                });
                if (guard) return guard.result;
            }

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
            const newSlId = await this.placeProtectiveStopLoss({
                exchange,
                parsed,
                position,
                targetOrder,
                strategyId,
                exchangeInstanceId,
                stopLossPrice: newSLPrice!,
            });
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
                // Explicit breakevenMode ('protect' / 'exit_at_entry') must NEVER market-close.
                if (this.shouldFallbackBreakevenToClose(parsed)) {
                    return await this.fallbackBreakevenToClose(parsed, strategyId, exchangeInstanceId, source, riskConfig);
                }
                if (parsed.breakevenMode != null) {
                    logger.warn(`[Breakeven Guard] SL placement failed for ${parsed.symbol}; breakevenMode='${parsed.breakevenMode}' forbids market close, returning failed`, {
                        strategyId,
                        symbol: parsed.symbol,
                        breakevenMode: parsed.breakevenMode,
                    });
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
            // Explicit breakevenMode ('protect' / 'exit_at_entry') must NEVER market-close.
            if (this.shouldFallbackBreakevenToClose(parsed)) {
                return await this.fallbackBreakevenToClose(parsed, strategyId, exchangeInstanceId, source, riskConfig);
            }
            if (parsed.breakevenMode != null) {
                logger.warn(`[Breakeven Guard] SL placement threw for ${parsed.symbol}; breakevenMode='${parsed.breakevenMode}' forbids market close, returning failed`, {
                    strategyId,
                    symbol: parsed.symbol,
                    breakevenMode: parsed.breakevenMode,
                });
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
   * Legacy breakeven updates (no explicit breakevenMode) keep the historical
   * market-close fallback. Explicit 'protect' / 'exit_at_entry' modes never
   * market-close on failure.
   */
  private shouldFallbackBreakevenToClose(parsed: ParsedStrategy): boolean {
      return String(parsed.stopLoss || '').toLowerCase() === 'breakeven' && parsed.breakevenMode == null;
  }

  /** Resolve the live position for a symbol/side using the same matching rules as handleUpdate. */
  private async resolveLivePosition(params: {
      exchange: any;
      symbol: string;
      side?: string;
      targetOrder?: Order | null;
  }): Promise<Position | undefined> {
      const { exchange, symbol, side, targetOrder } = params;
      const positions: Position[] = await exchange.getPositions();
      const effectiveSide = side && (side as string) !== 'unknown' ? side : targetOrder?.side;
      return positions.find(p =>
          p.symbol === symbol &&
          (effectiveSide ? (effectiveSide === 'buy' ? parseFloat(p.size) > 0 : parseFloat(p.size) < 0) : parseFloat(p.size) !== 0)
      );
  }

  /** Load the persisted riskMultiplier of a strategy (default 1 when unknown). */
  private async resolveStrategyRiskMultiplier(strategyId?: number | null): Promise<number> {
      if (!strategyId) return 1;
      try {
          const strategy = await Strategy.findByPk(strategyId);
          const value = Number((strategy as any)?.riskMultiplier);
          if (Number.isFinite(value) && value > 0) return value;
      } catch (error: any) {
          logger.warn('[UpdateOrderService] failed to load strategy riskMultiplier, defaulting to 1', formatError(error, { strategyId }));
      }
      return 1;
  }

  /** Format a number using an exchange precision; clamps to a sane number of decimals. */
  private formatToPrecision(value: number, precision?: number): string {
      const digits = typeof precision === 'number' && Number.isFinite(precision) && precision >= 0
          ? Math.min(12, Math.floor(precision))
          : 2;
      return value.toFixed(digits);
  }

  /**
   * Shared SL placement path (ProtectionManager for active orders, position-level
   * exchange.updateStopLoss otherwise). Used by the normal breakeven update and by
   * the in-loss 'protect' guard that restores the original stop.
   */
  private async placeProtectiveStopLoss(params: {
      exchange: any;
      parsed: ParsedStrategy;
      position: Position;
      targetOrder: Order | null;
      strategyId?: number;
      exchangeInstanceId?: string;
      stopLossPrice: string;
      amountOverride?: string;
  }): Promise<string | null> {
      const { exchange, parsed, position, targetOrder, strategyId, exchangeInstanceId, stopLossPrice, amountOverride } = params;
      // side represents the POSITION direction (not close direction):
      // long position → side='buy', short position → side='sell'
      // This matches GateIOExchange.updateStopLoss which interprets
      // side='buy' as long (close=buy→sell) and side='sell' as short (close=sell→buy)
      const side: 'buy' | 'sell' = parseFloat(position.size) > 0 ? 'buy' : 'sell';
      const trackedQty = targetOrder ? this.services.orderPersistenceHandler.getOrderTrackedAmount(targetOrder) : 0;
      const positionAbs = Math.abs(parseFloat(position.size));
      // 部分平仓后 filledAmount 仍是原始数量；SL 数量必须按当前剩余仓位收缩，
      // 否则 reduce-only 止损可能因数量大于持仓被交易所拒绝。
      const cappedQty = trackedQty > 0 && Number.isFinite(positionAbs) && positionAbs > 0
          ? Math.min(trackedQty, positionAbs)
          : trackedQty;
      const updateAmount = amountOverride
          ?? (cappedQty > 0 ? cappedQty.toString() : positionAbs.toString());
      // When targetOrder is CLOSED, use position-level SL update (exchange.updateStopLoss)
      // rather than ProtectionManager.placeStopLoss which ties the SL to a specific order.
      const isOrderActive = targetOrder && targetOrder.lifecycleStatus !== 'CLOSED';
      return isOrderActive && targetOrder?.exchangeOrderId
          ? await this.services.protectionContext.getProtectionManager(exchangeInstanceId).placeStopLoss({
              orderId: targetOrder.exchangeOrderId,
              symbol: parsed.symbol,
              side,
              amount: updateAmount,
              stopLossPrice,
              source: strategyId ? `strategy-${strategyId}` : 'unknown',
          })
          : await exchange.updateStopLoss(
              parsed.symbol,
              side,
              stopLossPrice,
              `t-sl-pos-${parsed.symbol}-${side === 'buy' ? 'sell' : 'buy'}`, // close-side convention (matches ProtectionManager)
              updateAmount,
          );
  }

  /**
   * A3. Guard for "move stop to breakeven" updates that arrive while price is
   * already on the losing side of entry (the exchange would reject the BE stop).
   *
   * Returns `null` when the caller should fall through to the legacy BE placement
   * (not in loss, mode absent, or ticker unavailable). Returns `{ result }` when
   * this guard fully handled the update.
   */
  private async handleBreakevenInLossGuard(params: {
      parsed: ParsedStrategy;
      exchange: any;
      position: Position;
      targetOrder: Order | null;
      strategyId?: number;
      exchangeInstanceId?: string;
      source?: string;
      riskConfig?: StrategyRiskConfig;
      entryPrice: number;
      isLong: boolean;
      market?: MarketInfo;
  }): Promise<{ result: OrderResult | null } | null> {
      const { parsed, exchange, position, targetOrder, strategyId, exchangeInstanceId, source, riskConfig, entryPrice, isLong, market } = params;
      const mode = parsed.breakevenMode;
      if (!mode) return null;
      if (!Number.isFinite(entryPrice) || entryPrice <= 0) return null;

      let lastPrice = NaN;
      try {
          const ticker = await exchange.getTicker(parsed.symbol);
          lastPrice = parseFloat(ticker?.lastPrice);
      } catch (error: any) {
          logger.warn(`[Breakeven Guard] ticker unavailable for ${parsed.symbol}; falling back to legacy breakeven placement`, formatError(error, { strategyId, symbol: parsed.symbol }));
      }
      if (!Number.isFinite(lastPrice) || lastPrice <= 0) return null;

      const positionSide: 'buy' | 'sell' = isLong ? 'buy' : 'sell';
      const epsilon = Math.max(Math.abs(entryPrice) * 1e-9, 1e-9);
      const inLoss = isLong ? lastPrice <= entryPrice + epsilon : lastPrice >= entryPrice - epsilon;
      if (!inLoss) {
          // Price is still on the favorable side: normal breakeven placement is safe.
          return null;
      }

      logger.warn(`[Breakeven Guard] price already in loss for ${parsed.symbol}; applying breakevenMode='${mode}'`, {
          strategyId,
          symbol: parsed.symbol,
          positionSide,
          entryPrice,
          lastPrice,
          breakevenMode: mode,
      });

      const auditStrategyId = strategyId ?? targetOrder?.strategyId;

      if (mode === 'exit_at_entry') {
          // Trader semantics: "close when it comes back to entry". Place a
          // reduce-only LIMIT close at the original entry and DO NOT cancel the SL.
          const closePrice = market
              ? entryPrice.toFixed(market.pricePrecision)
              : entryPrice.toString();
          if (auditStrategyId) {
              await this.services.auditService.log(auditStrategyId, 'BREAKEVEN_EXIT_LIMIT_PLACED', {
                  symbol: parsed.symbol,
                  side: positionSide,
                  entryPrice: closePrice,
                  lastPrice,
                  closePercentage: 100,
                  keepPartialProtections: true,
                  exchangeInstanceId,
              });
          }
          logger.info(`[Breakeven Guard] placing reduce-only limit exit at entry ${closePrice} for ${parsed.symbol}`, {
              strategyId,
              symbol: parsed.symbol,
              positionSide,
              lastPrice,
          });
          const result = await this.closePositionService.handleClose({
              action: 'close',
              symbol: parsed.symbol,
              side: positionSide,
              closePercentage: 100,
              closePrice,
              keepPartialProtections: true,
              raw: parsed.raw,
          }, source || 'breakeven-exit-at-entry', riskConfig, strategyId, positionSide, exchangeInstanceId);
          if (result) {
              return { result };
          }
          logger.warn(`[Breakeven Guard] exit-at-entry limit close returned null for ${parsed.symbol}; never market-closing`, {
              strategyId,
              symbol: parsed.symbol,
              positionSide,
          });
          return { result: null };
      }

      // mode === 'protect': restore the original stop instead of moving to BE.
      const initialSl = parseFloat(targetOrder?.initialSl || position.price_sl || '');
      if (!Number.isFinite(initialSl) || initialSl <= 0) {
          logger.warn(`[Breakeven Guard] cannot restore original SL for ${parsed.symbol}: initialSl unavailable; never market-closing`, {
              strategyId,
              symbol: parsed.symbol,
              rawInitialSl: targetOrder?.initialSl,
              positionSl: position.price_sl,
          });
          return { result: { id: 'update-sl-failed', status: 'failed', symbol: parsed.symbol } };
      }
      const restoredSlPrice = this.formatToPrecision(initialSl, market?.pricePrecision);
      let restoredSlId: string | null = null;
      try {
          restoredSlId = await this.placeProtectiveStopLoss({
              exchange,
              parsed,
              position,
              targetOrder,
              strategyId,
              exchangeInstanceId,
              stopLossPrice: restoredSlPrice,
              amountOverride: Math.abs(parseFloat(position.size)).toString(),
          });
      } catch (error: any) {
          logger.error(`[Breakeven Guard] restoring original SL threw for ${parsed.symbol}; never market-closing`, formatError(error, { strategyId, symbol: parsed.symbol }));
      }
      if (!restoredSlId) {
          logger.warn(`[Breakeven Guard] failed to restore original SL for ${parsed.symbol}; never market-closing`, {
              strategyId,
              symbol: parsed.symbol,
              restoredSlPrice,
          });
          return { result: { id: 'update-sl-failed', status: 'failed', symbol: parsed.symbol } };
      }
      if (targetOrder) {
          try {
              targetOrder.currentSl = restoredSlPrice;
              targetOrder.activeStopLossId = restoredSlId;
              await targetOrder.save();
          } catch (error: any) {
              logger.warn('[Breakeven Guard] failed to persist restored SL on order', formatError(error, { strategyId, orderId: targetOrder.id }));
          }
      }
      if (auditStrategyId) {
          await this.services.auditService.log(auditStrategyId, 'BREAKEVEN_SKIPPED_IN_LOSS_RESTORED_SL', {
              symbol: parsed.symbol,
              side: positionSide,
              entryPrice,
              lastPrice,
              restoredSlPrice,
              restoredSlId,
              exchangeInstanceId,
          });
      }
      logger.info(`[Breakeven Guard] restored original SL ${restoredSlPrice} for ${parsed.symbol} instead of moving to BE`, {
          strategyId,
          symbol: parsed.symbol,
          positionSide,
          lastPrice,
      });
      return { result: { id: 'update-sl-restored', status: 'filled', symbol: parsed.symbol } };
  }

  /**
   * A1. Resize an existing position (partial market close) or an unfilled entry
   * order so that the strategy's exposure matches `parsed.riskMultiplier`.
   */
  private async handleRiskResize(
      parsed: ParsedStrategy,
      targetOrder: Order | null,
      strategyId?: number,
      exchangeInstanceId?: string,
      source?: string,
      riskConfig?: StrategyRiskConfig,
  ): Promise<OrderResult | null> {
      const target = parsed.riskMultiplier as number;
      const exchange = this.services.exchangeRegistry.getExchange(exchangeInstanceId);
      const position = await this.resolveLivePosition({ exchange, symbol: parsed.symbol, side: parsed.side, targetOrder });

      if (position) {
          const positionSide: 'buy' | 'sell' = parseFloat(position.size) > 0 ? 'buy' : 'sell';
          const linkedStrategyId = targetOrder?.strategyId;
          const base = await this.resolveStrategyRiskMultiplier(linkedStrategyId);
          logger.info('[RiskResize] live position found; computing partial close', {
              strategyId,
              exchangeInstanceId,
              symbol: parsed.symbol,
              positionSide,
              positionSize: position.size,
              target,
              base,
              linkedStrategyId,
          });
          if (!Number.isFinite(base) || base <= 0) {
              logger.warn('[RiskResize] invalid base riskMultiplier; skipping', { strategyId, base });
              return null;
          }
          if (target >= base - RISK_MULTIPLIER_EPSILON) {
              logger.info('[RiskResize] target riskMultiplier >= current base; nothing to resize', { strategyId, target, base });
              return null;
          }
          const closePercentage = Math.min(99, Math.max(1, (1 - target / base) * 100));
          logger.info('[RiskResize] submitting partial close to reach target riskMultiplier', {
              strategyId,
              symbol: parsed.symbol,
              target,
              base,
              closePercentage,
          });
          const closeResult = await this.closePositionService.handleClose({
              action: 'close',
              symbol: parsed.symbol,
              side: positionSide,
              closePercentage,
              keepPartialProtections: true,
              raw: parsed.raw,
          }, source || 'risk-resize', riskConfig, strategyId, positionSide, exchangeInstanceId);
          if (!closeResult) {
              logger.warn('[RiskResize] partial close failed; leaving strategy riskMultiplier unchanged', {
                  strategyId,
                  symbol: parsed.symbol,
                  target,
                  base,
              });
              return null;
          }
          if (linkedStrategyId) {
              try {
                  await Strategy.update({ riskMultiplier: target }, { where: { id: linkedStrategyId } });
              } catch (error: any) {
                  // The position was already resized; a DB sync failure must not turn it into an error.
                  logger.warn('[RiskResize] failed to persist strategy riskMultiplier after partial close', formatError(error, {
                      strategyId,
                      linkedStrategyId,
                      target,
                  }));
              }
          }
          const auditStrategyId = strategyId ?? linkedStrategyId;
          if (auditStrategyId) {
              await this.services.auditService.log(auditStrategyId, 'RISK_RESIZED', {
                  symbol: parsed.symbol,
                  side: positionSide,
                  targetMultiplier: target,
                  baseMultiplier: base,
                  closePercentage,
                  resultId: closeResult.id,
                  resultStatus: closeResult.status,
                  linkedStrategyId,
                  exchangeInstanceId,
              });
          }
          logger.info('[RiskResize] partial close completed; strategy riskMultiplier updated', {
              strategyId,
              symbol: parsed.symbol,
              target,
              linkedStrategyId,
          });
          return closeResult;
      }

      // No live position: resize the unfilled entry order (amend) instead.
      const pendingOrder = await this.findUnfilledEntryOrder(parsed, exchangeInstanceId);
      if (!pendingOrder) {
          logger.info('[RiskResize] no live position and no unfilled entry order; nothing to resize', {
              strategyId,
              symbol: parsed.symbol,
          });
          return null;
      }
      if (!pendingOrder.exchangeOrderId) {
          logger.warn('[RiskResize] unfilled entry order has no exchangeOrderId; skipping', {
              strategyId,
              orderId: pendingOrder.id,
          });
          return null;
      }
      const oldAmount = parseFloat(pendingOrder.amount);
      if (!Number.isFinite(oldAmount) || oldAmount <= 0) {
          logger.warn('[RiskResize] unfilled entry order amount is invalid; skipping', {
              strategyId,
              orderId: pendingOrder.id,
              amount: pendingOrder.amount,
          });
          return null;
      }
      const orderStrategyId = pendingOrder.strategyId;
      const base = await this.resolveStrategyRiskMultiplier(orderStrategyId);
      if (!Number.isFinite(base) || base <= 0) {
          logger.warn('[RiskResize] invalid base riskMultiplier for pending order; skipping', { strategyId, base });
          return null;
      }
      const newAmountNum = oldAmount * (target / base);
      const markets = await exchange.getMarkets();
      const market = markets.find((m: MarketInfo) => m.symbol === parsed.symbol);
      const newAmount = this.formatToPrecision(newAmountNum, market?.amountPrecision ?? 0);
      const parsedNewAmount = parseFloat(newAmount);
      if (!Number.isFinite(parsedNewAmount) || parsedNewAmount <= 0) {
          logger.warn('[RiskResize] resized amount is not tradable; skipping', {
              strategyId,
              orderId: pendingOrder.id,
              newAmount,
              oldAmount,
          });
          return null;
      }
      try {
          logger.info('[RiskResize] amending unfilled entry order amount', {
              strategyId,
              orderId: pendingOrder.id,
              exchangeOrderId: pendingOrder.exchangeOrderId,
              oldAmount,
              newAmount,
              target,
              base,
          });
          await exchange.amendOrder(pendingOrder.exchangeOrderId, parsed.symbol, undefined, newAmount);
      } catch (error: any) {
          logger.error('[RiskResize] amendOrder failed; leaving order unchanged', formatError(error, {
              strategyId,
              orderId: pendingOrder.id,
              exchangeOrderId: pendingOrder.exchangeOrderId,
          }));
          return null;
      }
      pendingOrder.amount = newAmount;
      await pendingOrder.save();
      try {
          await StrategyPosition.update(
              { totalSize: newAmount, remainingSize: newAmount },
              { where: { orderId: pendingOrder.id, status: 'OPEN', remainingSize: { [Op.gt]: '0' } } as any },
          );
      } catch (error: any) {
          logger.warn('[RiskResize] failed to sync StrategyPosition sizes after amend', formatError(error, { orderId: pendingOrder.id }));
      }
      if (orderStrategyId) {
          try {
              await Strategy.update({ riskMultiplier: target }, { where: { id: orderStrategyId } });
          } catch (error: any) {
              // The order was already amended; a DB sync failure must not turn it into an error.
              logger.warn('[RiskResize] failed to persist strategy riskMultiplier after amend', formatError(error, {
                  strategyId,
                  orderStrategyId,
                  target,
              }));
          }
      }
      const auditStrategyId = strategyId ?? orderStrategyId;
      if (auditStrategyId) {
          await this.services.auditService.log(auditStrategyId, 'RISK_RESIZED_PENDING', {
              symbol: parsed.symbol,
              orderId: pendingOrder.id,
              exchangeOrderId: pendingOrder.exchangeOrderId,
              oldAmount: oldAmount.toString(),
              newAmount,
              targetMultiplier: target,
              baseMultiplier: base,
              exchangeInstanceId,
          });
      }
      logger.info('[RiskResize] amended unfilled entry order; strategy riskMultiplier updated', {
          strategyId,
          symbol: parsed.symbol,
          orderId: pendingOrder.id,
          newAmount,
          target,
      });
      return { id: pendingOrder.exchangeOrderId, status: 'updated', amount: newAmount };
  }

  /** Find an unfilled entry order, preferring reply-chain targets when present. */
  private async findUnfilledEntryOrder(parsed: ParsedStrategy, exchangeInstanceId?: string): Promise<Order | null> {
      const where: any = {
          symbol: parsed.symbol,
          lifecycleStatus: { [Op.in]: ['INIT', 'PENDING'] },
          ...(exchangeInstanceId ? { exchangeInstanceId } : {}),
      };
      if (parsed.replyOrderId != null && String(parsed.replyOrderId) !== '') {
          const replyOrderIdNum = Number(parsed.replyOrderId);
          where[Op.or] = [
              { exchangeOrderId: String(parsed.replyOrderId) },
              ...(Number.isFinite(replyOrderIdNum) ? [{ id: replyOrderIdNum }] : []),
          ];
      } else if (parsed.replyStrategyId != null) {
          where.strategyId = parsed.replyStrategyId;
      }
      return Order.findOne({ where, order: [['createdAt', 'DESC']] });
  }

  /**
   * A2. Place a reduce-only limit take-profit at entry ± planRMultiple × R for
   * `planClosePercentage` of the remaining position. The 't-tp-1-…' order text
   * makes the existing TP1-fill → move-SL-to-breakeven handler move the stop
   * automatically once this plan order fills.
   */
  private async handleRMultiplePlan(
      parsed: ParsedStrategy,
      targetOrder: Order | null,
      strategyId?: number,
      exchangeInstanceId?: string,
  ): Promise<OrderResult | null> {
      const exchange = this.services.exchangeRegistry.getExchange(exchangeInstanceId);
      const position = await this.resolveLivePosition({ exchange, symbol: parsed.symbol, side: parsed.side, targetOrder });
      if (!position) {
          logger.info('[RMultiplePlan] no live position; a plan update never opens a new position', {
              strategyId,
              symbol: parsed.symbol,
          });
          return null;
      }
      if (!targetOrder?.exchangeOrderId) {
          logger.warn('[RMultiplePlan] missing linked order exchangeOrderId; cannot build TP1 order text', {
              strategyId,
              symbol: parsed.symbol,
              targetOrderId: targetOrder?.id,
          });
          return null;
      }
      const entry = parseFloat(targetOrder.filledPrice || targetOrder.price || position.entryPrice);
      const sl = parseFloat(targetOrder.initialSl || position.price_sl || '');
      const risk = Math.abs(entry - sl);
      if (!Number.isFinite(entry) || entry <= 0 || !Number.isFinite(sl) || sl <= 0 || !Number.isFinite(risk) || risk <= 0) {
          logger.warn('[RMultiplePlan] invalid entry/SL; cannot compute R', {
              strategyId,
              symbol: parsed.symbol,
              entry,
              sl,
          });
          return null;
      }
      const long = parseFloat(position.size) > 0;
      const planRMultiple = parsed.planRMultiple as number;
      const planPriceNum = long ? entry + risk * planRMultiple : entry - risk * planRMultiple;
      const markets = await exchange.getMarkets();
      const market = markets.find((m: MarketInfo) => m.symbol === parsed.symbol);
      const planPrice = this.formatToPrecision(planPriceNum, market?.pricePrecision);
      const remaining = Math.abs(parseFloat(position.size));
      const closePct = typeof parsed.planClosePercentage === 'number' && parsed.planClosePercentage > 0 && parsed.planClosePercentage <= 100
          ? parsed.planClosePercentage
          : 50;
      const amount = this.formatToPrecision(remaining * (closePct / 100), market?.amountPrecision ?? 0);
      const amountNum = parseFloat(amount);
      if (!Number.isFinite(remaining) || remaining <= 0 || !Number.isFinite(amountNum) || amountNum <= 0) {
          logger.warn('[RMultiplePlan] resolved plan amount is not tradable; skipping', {
              strategyId,
              symbol: parsed.symbol,
              remaining,
              amount,
          });
          return null;
      }
      const side: 'buy' | 'sell' = long ? 'sell' : 'buy';
      let placed: OrderResult;
      try {
          placed = await exchange.placeOrder({
              symbol: parsed.symbol,
              side,
              amount,
              reduceOnly: true,
              type: 'limit',
              price: planPrice,
              text: buildTakeProfitOrderText(1, targetOrder.exchangeOrderId),
              timeInForce: 'GTC',
          });
      } catch (error: any) {
          logger.error('[RMultiplePlan] placeOrder failed', formatError(error, {
              strategyId,
              symbol: parsed.symbol,
              planPrice,
              amount,
          }));
          return null;
      }
      if (!placed?.id) {
          logger.warn('[RMultiplePlan] placeOrder returned no order id; skipping', {
              strategyId,
              symbol: parsed.symbol,
              planPrice,
              amount,
          });
          return null;
      }
      const auditStrategyId = strategyId ?? targetOrder.strategyId;
      if (auditStrategyId) {
          await this.services.auditService.log(auditStrategyId, 'R_MULTIPLE_PLAN_PLACED', {
              symbol: parsed.symbol,
              side,
              entry,
              stopLoss: sl,
              risk,
              planRMultiple,
              planPrice,
              amount,
              planClosePercentage: closePct,
              reduceOnly: true,
              linkedOrderId: targetOrder.exchangeOrderId,
              placedOrderId: placed.id,
              exchangeInstanceId,
          });
      }
      logger.info(`[RMultiplePlan] placed ${planRMultiple}R plan for ${parsed.symbol} at ${planPrice} (${closePct}% = ${amount})`, {
          strategyId,
          symbol: parsed.symbol,
          side,
          planPrice,
          amount,
          linkedOrderId: targetOrder.exchangeOrderId,
      });
      return { id: placed.id, status: 'placed', price: planPrice, amount };
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

  /**
   * Cancel a specific pending entry resolved via the reply chain. Mirrors the
   * explicit `parsed.orderId` branch: cancel on the exchange, mark the local
   * record CLOSED, sync related messages and audit.
   */
  private async cancelResolvedPendingOrder(params: {
      order: Order;
      exchange: any;
      parsed: ParsedStrategy;
      strategyId?: number;
      routeId?: number;
      exchangeInstanceId?: string;
      reason: string;
  }): Promise<OrderResult> {
      const { order, exchange, parsed, strategyId, routeId, exchangeInstanceId, reason } = params;
      const exchangeOrderId = order.exchangeOrderId as string;
      if (strategyId) {
          await this.services.auditService.log(strategyId, 'CANCELLING_ORDER', {
              orderId: exchangeOrderId,
              routeId,
              reason,
          });
      }

      const success = await exchange.cancelOrder(exchangeOrderId, parsed.symbol);
      order.status = success ? 'cancelled' : 'failed';
      order.lifecycleStatus = 'CLOSED';
      if (strategyId) this.services.orderPersistenceHandler.updateRelatedMessages(order, strategyId);
      await order.save();
      if (strategyId) {
          await this.services.auditService.log(strategyId, 'ORDER_CLOSED_CANCEL', { orderId: order.id, reason }, undefined, 'CLOSED');
      }

      debugOrderCancel('reply-chain cancel completed %o', {
          strategyId,
          routeId,
          exchangeInstanceId,
          symbol: parsed.symbol,
          reason,
          orderId: order.id,
          exchangeOrderId,
          success,
      });
      return { id: exchangeOrderId, status: success ? 'cancelled' : 'failed', symbol: parsed.symbol };
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

    // Reply-chain cancel: the parser now reports replyOrderId (local Order.id) and
    // replyStrategyId instead of the exchange order id. Cancel the exact linked
    // pending entry BEFORE the symbol-wide scoped lookup, otherwise a symbol with
    // several pending entries could cancel the wrong one.
    if (parsed.replyOrderId != null && String(parsed.replyOrderId).trim() !== '') {
      const replyOrderIdNum = Number(parsed.replyOrderId);
      if (Number.isFinite(replyOrderIdNum)) {
        let replyOrder: Order | null = null;
        try {
          replyOrder = await Order.findByPk(replyOrderIdNum);
        } catch (error: any) {
          logger.warn('[handleCancel] failed to load replyOrderId target; falling back to scoped lookup', formatError(error, {
            strategyId,
            replyOrderId: replyOrderIdNum,
          }));
        }
        if (replyOrder?.exchangeOrderId && ['INIT', 'PENDING'].includes(String(replyOrder.lifecycleStatus))) {
          logger.info('[handleCancel] cancelling pending entry linked by replyOrderId', {
            strategyId,
            routeId,
            exchangeInstanceId,
            symbol: parsed.symbol,
            replyOrderId: replyOrderIdNum,
            exchangeOrderId: replyOrder.exchangeOrderId,
          });
          return this.cancelResolvedPendingOrder({
            order: replyOrder,
            exchange,
            parsed,
            strategyId,
            routeId,
            exchangeInstanceId,
            reason: 'reply_order_id_cancel',
          });
        }
        logger.info('[handleCancel] replyOrderId target is not an unfilled entry; falling back to scoped lookup', {
          strategyId,
          replyOrderId: replyOrderIdNum,
          lifecycleStatus: replyOrder?.lifecycleStatus,
        });
      }
    } else if (parsed.replyStrategyId != null && String(parsed.replyStrategyId).trim() !== '') {
      const replyStrategyIdNum = Number(parsed.replyStrategyId);
      if (Number.isFinite(replyStrategyIdNum)) {
        let replyOrder: Order | null = null;
        try {
          replyOrder = await Order.findOne({
            where: {
              strategyId: replyStrategyIdNum,
              ...(parsed.symbol ? { symbol: parsed.symbol } : {}),
              ...(exchangeInstanceId ? { exchangeInstanceId } : {}),
              lifecycleStatus: { [Op.in]: ['INIT', 'PENDING'] },
            },
            order: [['createdAt', 'DESC']],
          });
        } catch (error: any) {
          logger.warn('[handleCancel] failed to load replyStrategyId target; falling back to scoped lookup', formatError(error, {
            strategyId,
            replyStrategyId: replyStrategyIdNum,
          }));
        }
        if (replyOrder?.exchangeOrderId) {
          logger.info('[handleCancel] cancelling pending entry linked by replyStrategyId', {
            strategyId,
            routeId,
            exchangeInstanceId,
            symbol: parsed.symbol,
            replyStrategyId: replyStrategyIdNum,
            orderId: replyOrder.id,
            exchangeOrderId: replyOrder.exchangeOrderId,
          });
          return this.cancelResolvedPendingOrder({
            order: replyOrder,
            exchange,
            parsed,
            strategyId,
            routeId,
            exchangeInstanceId,
            reason: 'reply_strategy_id_cancel',
          });
        }
        logger.info('[handleCancel] no unfilled entry found for replyStrategyId; falling back to scoped lookup', {
          strategyId,
          replyStrategyId: replyStrategyIdNum,
        });
      }
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