import { Transaction } from 'sequelize';
import logger from '../utils/logger';
import { Order, StrategyPosition } from '../models';

interface WsOrderEvent {
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

export class OrderPersistenceHandler {
  public async handleOrderUpdate(data: unknown): Promise<void> {
    let event: WsOrderEvent;
    try {
      event = data as WsOrderEvent;
    } catch {
      logger.warn('[OrderPersistenceHandler] Invalid order_update message shape');
      return;
    }

    try {
      await this.persistOrderUpdate(event);
    } catch (e) {
      logger.error('[OrderPersistenceHandler] Failed to persist order update', { event, error: e });
    }
  }

  public async handlePositionUpdate(message: unknown): Promise<void> {
    // Position updates are informational only for now
    logger.debug('[OrderPersistenceHandler] position_update received (no-op)', { message });
  }

  public async transitionOrderStatus(
    order: Order,
    toStatus: Order['lifecycleStatus'],
    reason: string,
    extra?: Record<string, any>
  ): Promise<boolean> {
    const fromStatus = order.lifecycleStatus;
    const [affectedRows] = await (Order as any).update(
      { lifecycleStatus: toStatus },
      { where: { id: order.id, lifecycleStatus: fromStatus }, limit: 1 }
    );
    if (affectedRows === 0) {
      logger.warn('Order lifecycle status change skipped — concurrent update', {
        orderId: order.id,
        exchangeOrderId: order.exchangeOrderId,
        fromStatus,
        toStatus,
        reason,
      });
      return false;
    }
    await order.reload();
    logger.info('Order lifecycle status changed', {
      orderId: order.id,
      exchangeOrderId: order.exchangeOrderId,
      fromStatus,
      toStatus,
      reason,
      ...extra,
    });
    return true;
  }

  public updateRelatedMessages(order: Order, strategyId: number) {
    try {
      const ids = JSON.parse(order.relatedMessages || '[]');
      if (!ids.includes(strategyId)) {
        ids.push(strategyId);
        order.relatedMessages = JSON.stringify(ids);
      }
    } catch (e) {
      order.relatedMessages = JSON.stringify([strategyId]);
    }
  }

  public getOrderTrackedAmount(order: Order): number {
    const amount = Math.abs(parseFloat(order.filledAmount || order.amount || '0'));
    return Number.isFinite(amount) && amount > 0 ? amount : 0;
  }

  public async upsertStrategyPositionFromOrder(
    order: Order,
    parserName?: string,
    tx?: Transaction
  ): Promise<StrategyPosition> {
    const totalSize = this.getOrderTrackedAmount(order);
    const existing = await StrategyPosition.findOne({
      where: { orderId: order.id },
      transaction: tx,
    });
    const payload = {
      strategyId: order.strategyId || null,
      orderId: order.id,
      routeId: order.routeId || null,
      exchangeInstanceId: order.exchangeInstanceId || null,
      symbol: order.symbol,
      side: order.side as 'buy' | 'sell',
      totalSize: totalSize.toString(),
      remainingSize: existing ? existing.remainingSize : totalSize.toString(),
      source: order.source || null,
      parserName: parserName || null,
    };
    if (existing) {
      await existing.update(payload, { transaction: tx });
      return existing;
    }
    return StrategyPosition.create(
      {
        ...payload,
        status: totalSize > 0 ? 'OPEN' : 'CLOSED',
      },
      { transaction: tx }
    );
  }

  private async persistOrderUpdate(event: WsOrderEvent): Promise<void> {
    const { orderId, status, filledSize, filledPrice, text } = event;

    // Find the order by exchangeOrderId or by text matching
    let order = orderId
      ? await Order.findOne({ where: { exchangeOrderId: orderId } })
      : null;

    // Fallback: try to find by text (which may contain order info)
    if (!order && text) {
      // Try to match by text containing 'ord-{id}'
      const orderIdMatch = text.match(/ord-(\d+)/);
      if (orderIdMatch) {
        order = await Order.findByPk(parseInt(orderIdMatch[1]));
      }
    }

    if (!order) {
      logger.debug(`[OrderPersistenceHandler] Order not found for event: ${JSON.stringify(event)}`);
      return;
    }

    if (status === 'finished') {
      const updates: any = {
        status: 'filled',
        filledAmount: filledSize?.toString() || order.filledAmount,
        filledPrice: filledPrice?.toString() || order.filledPrice,
      };

      // Transition lifecycleStatus if not already past OPEN
      if (order.lifecycleStatus === 'INIT' || order.lifecycleStatus === 'PENDING') {
        updates.lifecycleStatus = 'OPEN';
      }

      await order.update(updates);

      // Update StrategyPosition
      const position = await StrategyPosition.findOne({ where: { orderId: order.id } });
      if (position) {
        await position.update({ status: 'OPEN' });
      }

      logger.info(`[OrderPersistenceHandler] Order ${order.id} filled: ${filledSize} @ ${filledPrice}`);
    } else if (status === 'cancelled') {
      await order.update({ status: 'cancelled', lifecycleStatus: 'CLOSED' });
      logger.info(`[OrderPersistenceHandler] Order ${order.id} cancelled`);
    }
  }
}

export default new OrderPersistenceHandler();
