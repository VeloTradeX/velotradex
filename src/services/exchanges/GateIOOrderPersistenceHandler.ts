/**
 * GateIOOrderPersistenceHandler - WebSocket Order Event Persistence
 * 
 * This handler processes order fill/cancel events from Gate.io WebSocket and updates database state.
 * 
 * **Order Fill Processing:**
 * - Opening orders: Trigger pending protections (SL/TP placement)
 * - Closing orders (TP/SL): Update StrategyPosition.remainingSize
 * 
 * **TP Fill Logic:**
 * - TP1 fill: Move SL to breakeven to protect profits
 * - TP2+ fill: Keep SL at current level (no adjustment)
 * - All TPs filled + position closed: Cancel SL orders
 * 
 * **Integration:**
 * - Called by GateIOWSEventRouter.handleOrderUpdate()
 * - Uses ProtectionPipeline for SL management
 * - Updates Order and StrategyPosition models
 */

// src/services/exchanges/GateIOOrderPersistenceHandler.ts
import { Order, StrategyPosition, PendingProtection } from '../../models';
import auditService from '../AuditService';
import logger, { formatError, buildLogContextFromOrder, logContext } from '../../utils/logger';
import { ProtectionPipeline } from '../ProtectionPipeline';
import { extractLinkedOrderIdFromText, parseTpOrdersJson } from '../../utils/orderText';

export class GateIOOrderPersistenceHandler {
  public orderModel = Order;
  public strategyPositionModel = StrategyPosition;
  public pendingProtectionModel = PendingProtection;
  public auditService = auditService;
  public protectionPipeline: ProtectionPipeline | null = null;

  constructor(private exchange: any) {}

  setProtectionPipeline(pipeline: ProtectionPipeline): void {
    this.protectionPipeline = pipeline;
  }

  async handleOrderFilled(orderId: string, rawOrder: any): Promise<void> {
    try {
      const dbOrder = await this.findDbOrder(orderId, rawOrder.text);
      if (!dbOrder) return;

      await logContext.run(new Map([['context', buildLogContextFromOrder(dbOrder)]]), async () => {
      const left = parseFloat(rawOrder.left || '0');
      const isReduceOnly = rawOrder.isReduceOnly === true || rawOrder.isClose === true
        || rawOrder.is_reduce_only === true || rawOrder.is_close === true;
      const isTextReduceOnly = rawOrder.text && (
        rawOrder.text.includes('-tp-') || rawOrder.text.includes('-sl-') || rawOrder.text.includes('close-')
      );
      const isClosing = isReduceOnly || isTextReduceOnly;

      if (!isClosing) {
        // Opening order filled
        if (dbOrder.lifecycleStatus !== 'OPEN') {
          const prevStatus = dbOrder.lifecycleStatus;
          dbOrder.status = 'filled';
          dbOrder.lifecycleStatus = 'OPEN';
          // 方案6: filledAmount 统一绝对值（WS rawOrder.size 带符号，空单为负）。
          const rawFilled = rawOrder.size !== undefined && rawOrder.size !== null
            ? rawOrder.size
            : rawOrder.amount;
          dbOrder.filledAmount = Math.abs(parseFloat(rawFilled || '0')).toString();
          dbOrder.filledPrice = rawOrder.fill_price || rawOrder.price;
          await dbOrder.save();
          logger.info('Order lifecycle status changed', {
            orderId: dbOrder.id,
            exchangeOrderId: orderId,
            fromStatus: prevStatus,
            toStatus: 'OPEN',
            reason: 'order filled via WS',
          });
          await auditService.logByExchangeOrderId(orderId, 'ORDER_FILLED_WS', {
            fillPrice: rawOrder.fill_price, left: rawOrder.left,
          });
        }

        // Trigger pending protections via the unified Pipeline
        // Race condition: WS update may arrive before REST migration completes,
        // so the record may still be keyed by clientOrderId (from rawOrder.text).
        let protection = await this.pendingProtectionModel.findByPk(orderId);
        if (!protection && rawOrder.text) {
          protection = await this.pendingProtectionModel.findByPk(rawOrder.text);
          if (protection) {
            protection = await this.migratePendingProtection(rawOrder.text, orderId, protection);
          }
        }
        if (protection && this.protectionPipeline) {
          try {
            const filledQty = Math.abs(parseFloat(rawOrder.size || rawOrder.amount || '0'));
            // 新格式（带 attachedSl 标记）用对象存储：{ tpOrders: [...], attachedSl: boolean }。
            // 旧格式仍是纯数组。parseTpOrdersJson 兼容两者，并解析出自带止损标记。
            const parsedTp = parseTpOrdersJson(protection.tpOrdersJson);
            let tpOrders: { price: string; amount: string }[];
            if (parsedTp.tpOrders.length > 0) {
              tpOrders = parsedTp.tpOrders;
            } else if (protection.takeProfit) {
              tpOrders = [{ price: protection.takeProfit, amount: filledQty.toString() }];
            } else {
              tpOrders = [];
            }

            const result = await this.protectionPipeline.placeProtections({
              orderId: orderId,
              symbol: protection.symbol,
              side: protection.side as 'buy' | 'sell',
              stopLossPrice: protection.stopLoss ?? undefined,
              tpOrders,
              amount: filledQty > 0 ? filledQty.toString() : '0',
              source: 'ws-handler',
              // 入场单已自带止损（tpsl_sl_trigger_price）：管线跳过 SL，只补多档 TP。
              slPreAttached: parsedTp.attachedSl,
            });
            if (!result.claimed) {
              logger.debug(`[PersistenceHandler] PendingProtection ${orderId} already claimed by another handler; skipping`);
            }
            // P1-5: WS 路径成功放置保护后也要把订单升级为 PROTECTED，
            // 与 REST 串行路径（PostFillOrchestrator）保持状态机一致。
            if (result.claimed) {
              const newStatus = result.slPlaced && result.tpPlaced ? 'PROTECTED' : 'OPEN';
              // 与 REST 路径（OpenPositionService.handlePostFill）保持一致：成功放置保护后写 ORDER_PROTECTED 审计，
              // 保证无论 WS/REST 哪个并行路径赢得 claim，审计都确定存在。
              if (newStatus === 'PROTECTED') {
                await this.auditService.logByExchangeOrderId(orderId, 'ORDER_PROTECTED', {
                  orderId: dbOrder.id,
                  symbol: rawOrder.contract || rawOrder.symbol,
                  source: 'ws-handler',
                }, 'PROTECTED');
              }
              if (dbOrder.lifecycleStatus !== newStatus) {
                const fromStatus = dbOrder.lifecycleStatus;
                const [affectedRows] = await (this.orderModel as any).update(
                  { lifecycleStatus: newStatus },
                  { where: { id: dbOrder.id, lifecycleStatus: ['INIT', 'PENDING', 'OPEN'] }, limit: 1 }
                );
                if (affectedRows > 0) {
                  dbOrder.lifecycleStatus = newStatus;
                  logger.info('Order lifecycle status changed', {
                    orderId: dbOrder.id,
                    exchangeOrderId: orderId,
                    fromStatus,
                    toStatus: newStatus,
                    reason: 'ws-handler protection placement',
                    slPlaced: result.slPlaced,
                    tpPlaced: result.tpPlaced,
                  });
                }
              }
            }
          } catch (err) {
            logger.warn(`PendingProtection ${orderId} re-placement failed`, { error: err });
          }
        } else if (protection) {
          logger.warn(`[PersistenceHandler] ProtectionPipeline unavailable for ${orderId}; leaving pending protection intact`);
        }
      } else {
        // Closing order (TP/SL) filled
        await auditService.logByExchangeOrderId(orderId, 'CLOSE_ORDER_FILLED_WS', {
          text: rawOrder.text, fillPrice: rawOrder.fill_price, left: rawOrder.left,
        });

        // Reduce StrategyPosition.remainingSize
        const filledSize = Math.abs(parseFloat(rawOrder.size || '0'));
        const positions = await this.strategyPositionModel.findAll({
          where: { symbol: rawOrder.contract || rawOrder.symbol },
        });
        let remaining = filledSize;
        for (const pos of positions) {
          if (remaining <= 0) break;
          const currentRemaining = parseFloat(pos.remainingSize || '0');
          if (currentRemaining <= 0) continue;
          const reduce = Math.min(currentRemaining, remaining);
          await pos.update({ remainingSize: (currentRemaining - reduce).toString() });
          remaining -= reduce;
        }

        // TP fill → move SL to breakeven
        if (rawOrder.text && rawOrder.text.includes('-tp-') && this.protectionPipeline) {
          await this._handleTpFill(rawOrder, dbOrder);
        } else {
          // SL or close order fill → mark order CLOSED
          dbOrder.lifecycleStatus = 'CLOSED';
          dbOrder.status = 'closed';
          dbOrder.closedAt = new Date();
          await dbOrder.save();
        }
      }
      }); // end logContext.run
    } catch (err) {
      logger.error('Order filled handling failed', formatError(err, { orderId }));
    }
  }

  private async _handleTpFill(rawOrder: any, dbOrder: Order): Promise<void> {
    const exchangeOrderId = extractLinkedOrderIdFromText(rawOrder.text);
    if (!exchangeOrderId) {
      await this._closeOrder(dbOrder);
      return;
    }

    const linkedOrder = await this.orderModel.findOne({ where: { exchangeOrderId: exchangeOrderId } });
    if (!linkedOrder) {
      logger.warn(`[PersistenceHandler] TP fill: linked order ${exchangeOrderId} not found`);
      await this._closeOrder(dbOrder);
      return;
    }

    // Extract TP index from order text (e.g., t-tp-1-ord-123 -> index=1)
    const { extractTpIndexFromText } = require('../../utils/orderText');
    const tpIndex = extractTpIndexFromText(rawOrder.text);
    
    if (tpIndex === 1) {
      // TP1 filled — move SL to breakeven to protect profits
      logger.info(`[PersistenceHandler] TP1 filled for order ${exchangeOrderId} — moving SL to breakeven`);
      const moved = await this.protectionPipeline!.moveStopLossToBreakeven(exchangeOrderId);
      if (moved) {
        logger.info(`[PersistenceHandler] SL successfully moved to breakeven for ${linkedOrder.symbol}`);
        if (linkedOrder.strategyId) {
          await auditService.log(linkedOrder.strategyId, 'SL_MOVED_TO_BREAKEVEN', {
            symbol: linkedOrder.symbol,
            orderId: linkedOrder.id,
            exchangeOrderId,
          }, linkedOrder.id);
        }
      } else {
        logger.warn(`[PersistenceHandler] Failed to move SL to breakeven for ${linkedOrder.symbol}`);
      }
    } else if (tpIndex && tpIndex > 1) {
      // TP2+ filled — do not move SL, just log
      logger.info(`[PersistenceHandler] TP${tpIndex} filled for order ${exchangeOrderId} — SL remains at current level`);
    } else {
      // Unable to determine TP index — log warning
      logger.warn(`[PersistenceHandler] Unable to extract TP index from text: ${rawOrder.text}`);
    }

    // Check if all TPs are filled and position is closed
    let remainingTpOrders: number;
    try {
      remainingTpOrders = await this._getRemainingTpOrders(linkedOrder.symbol, exchangeOrderId);
    } catch (err: any) {
      logger.error('[PersistenceHandler] Keeping SL due to _getRemainingTpOrders error', formatError(err));
      remainingTpOrders = -1;
    }
    if (remainingTpOrders === 0) {
      const position = await this.exchange.getPosition(linkedOrder.symbol);
      const posSize = position ? Math.abs(parseFloat(position.size)) : 0;

      if (posSize > 0) {
        logger.warn(`[PersistenceHandler] All TPs filled but position still open for ${linkedOrder.symbol}: size=${posSize}. SL will remain active.`);
      } else {
        logger.info(`[PersistenceHandler] All TPs filled and position closed for ${exchangeOrderId} — cancelling SL`);
        await this.protectionPipeline!.cancelProtections(linkedOrder.symbol, linkedOrder.side as 'buy' | 'sell');
        linkedOrder.lifecycleStatus = 'CLOSED';
        linkedOrder.status = 'closed';
        linkedOrder.closedAt = new Date();
        await linkedOrder.save();
      }
    }

    // dbOrder found via findDbOrder may be the original entry order (not a TP sub-order).
    // Don't close the original order on a TP fill — it should stay OPEN/PROTECTED
    // until the position is fully closed (all TPs filled or SL hit).
    // Only close if dbOrder is actually a distinct TP sub-order record.
    if (dbOrder.id !== linkedOrder.id) {
      await this._closeOrder(dbOrder);
    }
  }

  private async _getRemainingTpOrders(symbol: string, orderId: string): Promise<number> {
    try {
      // TP orders are regular reduce-only limit orders, listed in getOpenOrders().
      // Gate.io lists them under /futures/usdt/orders?status=open.
      const openOrders = await this.exchange.getOpenOrders(symbol);
      const prefix = `-ord-${orderId}`;
      return openOrders.filter((o: any) => {
        const text = String(o.text || '');
        return text.includes(prefix) && text.includes('-tp-');
      }).length;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.error(`[PersistenceHandler] _getRemainingTpOrders failed for ${symbol}`, formatError(err));
      throw new Error(`_getRemainingTpOrders failed for ${symbol}: ${errMsg}`);
    }
  }

  private async _closeOrder(order: Order): Promise<void> {
    const fromStatus = order.lifecycleStatus;
    order.lifecycleStatus = 'CLOSED';
    order.status = 'closed';
    order.closedAt = new Date();
    await order.save();
    logger.info('Order lifecycle status changed', {
      orderId: order.id,
      exchangeOrderId: order.exchangeOrderId,
      fromStatus,
      toStatus: 'CLOSED',
      reason: 'closed by persistence handler',
    });
  }

  private async migratePendingProtection(clientOrderId: string, exchangeOrderId: string, protection: any): Promise<any> {
    if (clientOrderId === exchangeOrderId) {
      return protection;
    }

    const existing = await this.pendingProtectionModel.findByPk(exchangeOrderId);
    if (existing) {
      await protection.destroy();
      return existing;
    }

    try {
      const migrated = await this.pendingProtectionModel.create({
        orderId: exchangeOrderId,
        symbol: protection.symbol,
        side: protection.side,
        stopLoss: protection.stopLoss ?? null,
        takeProfit: protection.takeProfit ?? null,
        tpOrdersJson: protection.tpOrdersJson ?? null,
        status: protection.status ?? 'PENDING',
      });
      await protection.destroy();
      logger.info(`[PersistenceHandler] Migrated pending protection from ${clientOrderId} to ${exchangeOrderId} in fill handler`);
      return migrated;
    } catch (err) {
      logger.warn(`[PersistenceHandler] Failed to migrate pending protection ${clientOrderId} -> ${exchangeOrderId}`, { error: err });
      return protection;
    }
  }

  async handleOrderCancelled(orderId: string, rawOrder: any): Promise<void> {
    try {
      const dbOrder = await this.findDbOrder(orderId, rawOrder.text);
      if (!dbOrder) return;

      const isReduceOnly = rawOrder.isReduceOnly === true || rawOrder.isClose === true
        || rawOrder.is_reduce_only === true || rawOrder.is_close === true;
      const isTextReduceOnly = rawOrder.text && (
        rawOrder.text.includes('-tp-') || rawOrder.text.includes('-sl-') || rawOrder.text.includes('close-')
      );

      if (!isReduceOnly && !isTextReduceOnly) {
        dbOrder.lifecycleStatus = 'CLOSED';
        dbOrder.status = 'cancelled';
        await dbOrder.save();
        await auditService.logByExchangeOrderId(orderId, 'ORDER_CANCELLED_WS', { text: rawOrder.text });
      }
    } catch (err) {
      logger.error('Order cancelled handling failed', formatError(err, { orderId }));
    }
  }

  private async findDbOrder(orderId: string, text?: string): Promise<Order | null> {
    try {
      const order = await this.orderModel.findOne({ where: { exchangeOrderId: orderId } });
      if (order) return order;
      if (text) {
        const scopedOrderId = extractLinkedOrderIdFromText(text);
        if (scopedOrderId) {
          const exchangeOrder = await this.orderModel.findOne({ where: { exchangeOrderId: scopedOrderId } });
          if (exchangeOrder) {
            return exchangeOrder;
          }
          return this.orderModel.findOne({ where: { id: parseInt(scopedOrderId, 10) } });
        }
      }
      return null;
    } catch (err) {
      logger.warn(`findDbOrder failed for ${orderId}`, { error: err });
      return null;
    }
  }
}
