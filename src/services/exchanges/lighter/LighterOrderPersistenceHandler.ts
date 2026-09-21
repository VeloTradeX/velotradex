/**
 * LighterOrderPersistenceHandler - Reconciler Order Event Persistence
 *
 * Processes order fill/cancel events from LighterStateReconciler and updates database state.
 * Mirrors GateIOOrderPersistenceHandler but receives pre-normalized events from the reconciler.
 */

import { Order, StrategyPosition, PendingProtection } from '../../../models';
import LighterClientOrderIndex from '../../../models/LighterClientOrderIndex';
import LighterTxJournal from '../../../models/LighterTxJournal';
import auditService from '../../AuditService';
import logger, { formatError, buildLogContextFromOrder, logContext } from '../../../utils/logger';
import { ProtectionPipeline } from '../../ProtectionPipeline';
import { extractLinkedOrderIdFromText, extractTpIndexFromText } from '../../../utils/orderText';
import type { EventEmitter } from 'events';
import type { OrderResult } from '../IExchange';

export class LighterOrderPersistenceHandler {
  public orderModel = Order;
  public strategyPositionModel = StrategyPosition;
  public pendingProtectionModel = PendingProtection;
  public auditService = auditService;
  public protectionPipeline: ProtectionPipeline | null = null;

  constructor(
    private reconciler: EventEmitter,
    private exchange: any,
  ) {
    if (typeof (this.reconciler as any).on === 'function') {
      this.reconciler.on('order', (result: OrderResult) => {
        this.handleOrderEvent(result).catch(err => {
          logger.error('LighterOrderPersistenceHandler: unhandled error in event listener', { error: err });
        });
      });
    }
  }

  setProtectionPipeline(pipeline: ProtectionPipeline): void {
    this.protectionPipeline = pipeline;
  }

  private async handleOrderEvent(result: OrderResult): Promise<void> {
    try {
      const status = result.status;
      if (status === 'filled') {
        await this.handleOrderFilled(result);
      } else if (status === 'cancelled') {
        await this.handleOrderCancelled(result);
      }
    } catch (err) {
      logger.error('Order event handling failed', formatError(err, { orderId: result.id }));
    }
  }

  private async handleOrderFilled(result: OrderResult): Promise<void> {
    const orderId = result.id;
    const rawText = (result.raw as any)?.text
      ?? (result.raw as any)?.client_text
      ?? (result.raw as any)?.clientOrderText
      ?? await this.resolveBusinessKey(orderId);

    const dbOrder = await this.findDbOrder(orderId, rawText);

    if (dbOrder) {
      await logContext.run(new Map([['context', buildLogContextFromOrder(dbOrder)]]), async () => {
      // Entry order filled
      if (dbOrder.lifecycleStatus !== 'OPEN') {
        const prevStatus = dbOrder.lifecycleStatus;
        dbOrder.status = 'filled';
        dbOrder.lifecycleStatus = 'OPEN';
        dbOrder.filledAmount = result.amount || dbOrder.amount;
        // Prefer human-readable price from journal intent over WS event price
        // (WS avg_price may use a different integer scale than the order submission)
        const intentPrice = await this.resolveIntentPrice(orderId);
        dbOrder.filledPrice = intentPrice || result.price || dbOrder.price;
        await dbOrder.save();
        logger.info('Order lifecycle status changed', {
          orderId: dbOrder.id,
          exchangeOrderId: orderId,
          fromStatus: prevStatus,
          toStatus: 'OPEN',
          reason: 'order filled via WS',
        });
        await auditService.logByExchangeOrderId(orderId, 'ORDER_FILLED_WS', {
          fillPrice: result.price, amount: result.amount,
        });
      }

      // Trigger PendingProtection
      if (this.protectionPipeline) {
        let protection = await this.pendingProtectionModel.findByPk(orderId);
        if (!protection && rawText) {
          protection = await this.pendingProtectionModel.findByPk(rawText);
        }
        if (protection) {
          try {
            const filledQty = Math.abs(parseFloat(result.amount || dbOrder.filledAmount || '0'));
            let tpOrders: { price: string; amount: string }[];
            if (protection.tpOrdersJson) {
              tpOrders = JSON.parse(protection.tpOrdersJson);
            } else if (protection.takeProfit) {
              tpOrders = [{ price: protection.takeProfit, amount: filledQty.toString() }];
            } else {
              tpOrders = [];
            }

            const protectionResult = await this.protectionPipeline.placeProtections({
              orderId,
              symbol: protection.symbol,
              side: protection.side as 'buy' | 'sell',
              stopLossPrice: protection.stopLoss ?? undefined,
              tpOrders,
              amount: filledQty > 0 ? filledQty.toString() : '0',
              source: 'lighter-ws-handler',
            });
            if (!protectionResult.claimed) {
              logger.debug(`[LighterPersistence] PendingProtection ${orderId} already claimed; skipping`);
            } else if (protectionResult.slPlaced && protectionResult.tpPlaced) {
              dbOrder.lifecycleStatus = 'PROTECTED';
              await dbOrder.save();
            }
          } catch (err) {
            logger.warn(`[LighterPersistence] PendingProtection ${orderId} placement failed`, { error: err });
          }
        }
      }
      }); // end logContext.run
    } else if (rawText && this.isClosingText(rawText)) {
      // TP/SL order filled (no DB Order record for these)
      await this.handleClosingOrderFill(result, rawText);
    } else if (this.isClosingOrderByType(result)) {
      // OTOCO TP/SL order filled (identified by type, not text)
      await this.handleClosingOrderFill(result, rawText || '');
    }
  }

  private async handleClosingOrderFill(result: OrderResult, text: string): Promise<void> {
    const orderId = result.id;
    const filledSize = Math.abs(parseFloat(result.amount || '0'));

    // Reduce StrategyPosition.remainingSize
    if (filledSize > 0) {
      const symbol = (result.raw as any)?.symbol;
      if (symbol) {
        const positions = await this.strategyPositionModel.findAll({ where: { symbol } });
        let remaining = filledSize;
        for (const pos of positions) {
          if (remaining <= 0) break;
          const currentRemaining = parseFloat(pos.remainingSize || '0');
          if (currentRemaining <= 0) continue;
          const reduce = Math.min(currentRemaining, remaining);
          await pos.update({ remainingSize: (currentRemaining - reduce).toString() });
          remaining -= reduce;
        }
      }
    }

    await auditService.logByExchangeOrderId(orderId, 'CLOSE_ORDER_FILLED_WS', {
      text, fillPrice: result.price, amount: result.amount,
    });

    // TP fill → move SL to breakeven
    const raw = result.raw as any;
    const orderType = raw?.type || raw?.order_type || '';
    const isTpOrder = orderType.includes('take-profit') || orderType.includes('take_profit') || text.includes('-tp-');
    
    if (isTpOrder && this.protectionPipeline) {
      await this.handleTpFill(text, result);
    }
  }

  private async handleTpFill(text: string, result?: OrderResult): Promise<void> {
    // Try to extract linked order ID from text first
    let linkedOrderId = extractLinkedOrderIdFromText(text);
    
    // For OTOCO orders without text, try to find linked order by client_order_index
    if (!linkedOrderId && result) {
      const raw = result.raw as any;
      const clientOrderIndex = raw?.client_order_index || raw?.clientOrderIndex;
      if (clientOrderIndex) {
        // OTOCO TP has client_order_index = base + 2
        // Try to find main order with client_order_index = base or base + 1
        const possibleMainIndex1 = clientOrderIndex - 2;
        const possibleMainIndex2 = clientOrderIndex - 1;
        
        const mainOrder = await this.orderModel.findOne({
          where: {
            exchangeOrderId: [possibleMainIndex1.toString(), possibleMainIndex2.toString()],
          },
        });
        
        if (mainOrder) {
          linkedOrderId = mainOrder.exchangeOrderId;
          logger.info(`[LighterPersistence] OTOCO TP: found linked order ${linkedOrderId} via client_order_index`);
        }
      }
    }
    
    if (!linkedOrderId) return;

    const linkedOrder = await this.orderModel.findOne({ where: { exchangeOrderId: linkedOrderId } });
    if (!linkedOrder) {
      logger.warn(`[LighterPersistence] TP fill: linked order ${linkedOrderId} not found`);
      return;
    }

    const tpIndex = extractTpIndexFromText(text) || 1; // Default to 1 for OTOCO
    if (tpIndex === 1) {
      logger.info(`[LighterPersistence] TP1 filled for order ${linkedOrderId} — moving SL to breakeven`);
      const moved = await this.protectionPipeline!.moveStopLossToBreakeven(linkedOrderId);
      if (moved) {
        logger.info(`[LighterPersistence] SL moved to breakeven for ${linkedOrder.symbol}`);
      } else {
        logger.warn(`[LighterPersistence] Failed to move SL to breakeven for ${linkedOrder.symbol}`);
      }
    } else if (tpIndex && tpIndex > 1) {
      logger.info(`[LighterPersistence] TP${tpIndex} filled for ${linkedOrderId} — SL unchanged`);
    }

    // Check if all TPs filled and position closed → cancel SL
    const remainingTpOrders = await this.getRemainingTpOrders(linkedOrder.symbol, linkedOrderId);
    if (remainingTpOrders === 0) {
      const position = await this.exchange.getPosition(linkedOrder.symbol);
      const posSize = position ? Math.abs(parseFloat(position.size)) : 0;

      if (posSize > 0) {
        logger.warn(`[LighterPersistence] All TPs filled but position still open for ${linkedOrder.symbol}: size=${posSize}`);
      } else {
        logger.info(`[LighterPersistence] All TPs filled and position closed for ${linkedOrderId} — cancelling SL`);
        await this.protectionPipeline!.cancelProtections(linkedOrder.symbol, linkedOrder.side as 'buy' | 'sell');
      }
    }
  }

  private async getRemainingTpOrders(symbol: string, orderId: string): Promise<number> {
    try {
      const openOrders = await this.exchange.getOpenOrders(symbol);
      return openOrders.filter((o: any) => {
        const orderText = String(o.text || o.raw?.text || '');
        return orderText.includes('-tp-') && orderText.includes(orderId);
      }).length;
    } catch (err) {
      logger.error(`[LighterPersistence] getRemainingTpOrders failed for ${symbol}: ${err}`);
      return 0;
    }
  }

  private async handleOrderCancelled(result: OrderResult): Promise<void> {
    const orderId = result.id;
    const rawText = (result.raw as any)?.text;

    const dbOrder = await this.findDbOrder(orderId, rawText);
    if (!dbOrder) return;

    dbOrder.lifecycleStatus = 'CLOSED';
    dbOrder.status = 'cancelled';
    await dbOrder.save();
    await auditService.logByExchangeOrderId(orderId, 'ORDER_CANCELLED_WS', {
      text: rawText, amount: result.amount,
    });
  }

  private async findDbOrder(orderId: string, text?: string): Promise<Order | null> {
    try {
      const order = await this.orderModel.findOne({ where: { exchangeOrderId: orderId } });
      if (order) return order;
      if (text) {
        const scopedOrderId = extractLinkedOrderIdFromText(text);
        if (scopedOrderId) {
          const exchangeOrder = await this.orderModel.findOne({ where: { exchangeOrderId: scopedOrderId } });
          if (exchangeOrder) return exchangeOrder;
          return this.orderModel.findOne({ where: { id: parseInt(scopedOrderId, 10) } });
        }
      }
      return null;
    } catch (err) {
      logger.warn(`[LighterPersistence] findDbOrder failed for ${orderId}`, { error: err });
      return null;
    }
  }

  private isClosingText(text: string): boolean {
    return text.includes('-tp-') || text.includes('-sl-') || text.includes('close-');
  }

  private isClosingOrderByType(result: OrderResult): boolean {
    const raw = result.raw as any;
    if (!raw) return false;
    const type = raw.type || raw.order_type || '';
    return type.includes('take-profit') || type.includes('take_profit') || 
           type.includes('stop-loss') || type.includes('stop_loss');
  }

  private async resolveBusinessKey(clientOrderIndex: string): Promise<string | undefined> {
    try {
      const row = await LighterClientOrderIndex.findOne({
        where: { clientOrderIndex },
      });
      return row?.businessKey ?? undefined;
    } catch {
      return undefined;
    }
  }

  private async resolveIntentPrice(clientOrderIndex: string): Promise<string | undefined> {
    try {
      const journal = await LighterTxJournal.findOne({
        where: { clientOrderIndex },
      });
      if (!journal?.intentJson) return undefined;
      const intent = JSON.parse(journal.intentJson);
      return typeof intent.price === 'string' ? intent.price : undefined;
    } catch {
      return undefined;
    }
  }
}
