import { Order, VirtualTrade } from '../models';
import { Op } from 'sequelize';
import logger from '../utils/logger';
import { getVirtualContractMultiplier } from '../utils/virtualContractMultiplier';
import type { ProtectionFillInfo } from './exchanges/virtual/VirtualGateExchange';

export class VirtualExchangeFillHandler {
  async handleProtectionFill(info: ProtectionFillInfo): Promise<void> {
    // 1. Try order-level text (contains business Order ID)
    const orderId = this.extractOrderId(info.text);
    if (orderId) {
      await this.closeSingleOrder(orderId, info);
      return;
    }

    // 2. Try virtual exchange order ID in TP text (t-tp-{index}-vo-...)
    const virtualOrderId = this.extractVirtualOrderId(info.text);
    if (virtualOrderId) {
      await this.closeOrderByExchangeOrderId(virtualOrderId, info);
      return;
    }

    // 3. Try position-level SL text (t-sl-pos-{symbol}-{side})
    const posSl = this.parsePositionLevelSlText(info.text);
    if (posSl) {
      await this.closeOrdersForPosition(posSl.symbol, posSl.side, info.fillPrice, info.timestamp, info.virtualOrderId);
      return;
    }

    logger.warn(`[VirtualExchangeFillHandler] Cannot extract order ID from text: ${info.text}`);
  }

  private async closeSingleOrder(orderId: number, info: ProtectionFillInfo): Promise<void> {
    const order = await Order.findByPk(orderId);
    if (!order) {
      logger.warn(`[VirtualExchangeFillHandler] Order ${orderId} not found`);
      return;
    }

    await this.closeOrder(order, info);
  }

  private async closeOrderByExchangeOrderId(exchangeOrderId: string, info: ProtectionFillInfo): Promise<void> {
    const order = await Order.findOne({ where: { exchangeOrderId } });
    if (!order) {
      logger.warn(`[VirtualExchangeFillHandler] Order with exchangeOrderId ${exchangeOrderId} not found`);
      return;
    }

    await this.closeOrder(order, info);
  }

  private async closeOrder(order: Order, info: ProtectionFillInfo): Promise<void> {
    if (order.lifecycleStatus === 'CLOSED') return;

    const pnl = info.realizedPnl !== 0
      ? info.realizedPnl
      : await this.calculatePnlFromTrades(info);

    const updateData: any = {
      lifecycleStatus: 'CLOSED',
      status: 'closed',
      exitPrice: info.fillPrice,
      closePrice: info.fillPrice,
      lastPrice: info.fillPrice,
      realizedPnl: pnl.toFixed(4),
      closedAt: info.timestamp,
    };

    await order.update(updateData);

    logger.info(`[VirtualExchangeFillHandler] Order ${order.id} closed via ${info.orderRole}: exitPrice=${info.fillPrice}, pnl=${updateData.realizedPnl}`);
  }

  private async closeOrdersForPosition(symbol: string, side: string, fillPrice: string, timestamp: Date, stopLossOrderId?: string): Promise<void> {
    let orders = stopLossOrderId
      ? await Order.findAll({
        where: {
          activeStopLossId: stopLossOrderId,
        },
      })
      : [];

    if (orders.length === 0) {
      orders = await Order.findAll({
        where: {
          symbol,
          side,
          lifecycleStatus: { [Op.in]: ['OPEN', 'PROTECTED'] },
          // 回测导入的订单不被实盘虚拟交易所的持仓级止损误关（子进程内订单未打标，行为不变）
          backtestRunId: { [Op.is]: null },
        },
      });
    }

    if (orders.length === 0) {
      logger.debug(`[VirtualExchangeFillHandler] No OPEN/PROTECTED orders found for position-level SL: ${symbol} ${side}`);
      return;
    }

    for (const order of orders) {
      const pnl = this.calculatePnl(order, fillPrice);

      const updateData: any = {
        lifecycleStatus: 'CLOSED',
        status: 'closed',
        exitPrice: fillPrice,
        closePrice: fillPrice,
        lastPrice: fillPrice,
        realizedPnl: pnl.toFixed(4),
        closedAt: timestamp,
      };

      await order.update(updateData);

      logger.info(`[VirtualExchangeFillHandler] Order ${order.id} closed via position-level SL: exitPrice=${fillPrice}, pnl=${updateData.realizedPnl}`);
    }
  }

  private extractOrderId(text: string | null): number | null {
    if (!text) return null;
    // t-sl-ord-{id} or t-tp-{index}-ord-{id} or t-tp-{index}-{id}
    const match = text.match(/(?:t-sl-ord|t-tp-\d+-ord|t-tp-\d+)-(\d+)/);
    return match ? parseInt(match[1], 10) : null;
  }

  private extractVirtualOrderId(text: string | null): string | null {
    if (!text) return null;
    const match = text.match(/^t-tp-\d+-(vo-.+)$/);
    return match ? match[1] : null;
  }

  private parsePositionLevelSlText(text: string | null): { symbol: string; side: string } | null {
    if (!text) return null;
    // t-sl-pos-{symbol}-{side}
    const match = text.match(/^t-sl-pos-(.+)-(buy|sell)$/);
    if (!match) return null;
    return { symbol: match[1], side: match[2] };
  }

  private calculatePnl(order: Order, closePrice: string): number {
    const entry = parseFloat(order.filledPrice || order.price || '0');
    const close = parseFloat(closePrice || '0');
    const amount = parseFloat(order.filledAmount || order.amount || '0');
    if (!entry || !close || !amount) return 0;
    const direction = order.side === 'buy' ? 1 : -1;
    const multiplier = getVirtualContractMultiplier(order.symbol);
    return (close - entry) * amount * multiplier * direction;
  }

  private async calculatePnlFromTrades(info: ProtectionFillInfo): Promise<number> {
    try {
      const trades = await VirtualTrade.findAll({
        where: {
          exchangeInstanceId: info.exchangeInstanceId,
          symbol: info.symbol,
          [Op.or]: [
            { text: { [Op.like]: `%${info.text}%` } },
            { text: { [Op.like]: `%${info.virtualOrderId}%` } },
          ],
        },
      });
      return trades.reduce((sum: number, t: any) => sum + parseFloat(t.realizedPnl || '0'), 0);
    } catch (err) {
      logger.warn(`[VirtualExchangeFillHandler] Failed to query VirtualTrade for P&L fallback`, { error: err });
      return 0;
    }
  }
}
