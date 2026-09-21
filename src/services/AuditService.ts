import { AuditLog, Order } from '../models';
import logger, { formatError } from '../utils/logger';
import { safeStringify } from '../utils/json';
import webhookService from './WebhookService';

class AuditService {
  private extractWebhookMeta(details: any): { parser?: string; symbol?: string } {
    if (!details || typeof details !== 'object') {
      return {};
    }

    const parser = details.parser || details.parserName;
    const symbol = details.symbol || details.parsed?.symbol || details.strategy?.symbol;

    return {
      parser: parser || undefined,
      symbol: symbol || undefined
    };
  }

  public async log(strategyId: number, action: string, details: any, orderId?: number, lifecycleStatus?: string, exchangeInstanceId?: string, routeId?: number) {
    try {
      // If lifecycleStatus is not provided, try to fetch from order if orderId is present
      let status = lifecycleStatus;
      let instanceId = exchangeInstanceId;

      if (orderId) {
        const order = await Order.findByPk(orderId);
        if (order) {
            if (!status) status = order.lifecycleStatus;
            if (!instanceId) instanceId = order.exchangeInstanceId;
        }
      }

      const detailsStr = typeof details === 'string' ? details : safeStringify(details);

      await AuditLog.create({
        strategyId,
        orderId,
        action,
        lifecycleStatus: status,
        exchangeInstanceId: instanceId,
        routeId: routeId ?? null,
        details: detailsStr,
      });

      // Trigger Webhook Asynchronously
      // We don't await this to keep audit log fast
      const meta = this.extractWebhookMeta(details);
      webhookService.dispatch(action, {
        strategyId,
        orderId,
        lifecycleStatus: status,
        exchangeInstanceId: instanceId,
        routeId,
        parser: meta.parser,
        symbol: meta.symbol,
        details: details
      }).catch(err => logger.error('Webhook dispatch failed', formatError(err)));

    } catch (error: any) {
      logger.error('Failed to write audit log', formatError(error));
    }
  }

  public async logByExchangeOrderId(exchangeOrderId: string, action: string, details: any, lifecycleStatus?: string) {
    try {
      const order = await Order.findOne({ where: { exchangeOrderId } });
      if (order) {
        await this.log(order.strategyId, action, details, order.id, lifecycleStatus || order.lifecycleStatus);
      } else {
        // It might be a trigger order or SL/TP order which is not directly in 'orders' table as main order
        // But for main orders, this should work.
        // If it's a trigger order, we might not track it in 'orders' table yet (PendingProtection stores it separately).
        logger.debug('AuditService: Could not find order for exchange ID', { exchangeOrderId });
      }
    } catch (error: any) {
      logger.error('Failed to write audit log by exchange ID', formatError(error));
    }
  }

  public async logBySymbol(symbol: string, action: string, details: any, lifecycleStatus?: string) {
    try {
      // Find the most recent order for this symbol to associate the audit log with a strategy
      const order = await Order.findOne({ 
        where: { symbol }, 
        order: [['createdAt', 'DESC']] 
      });

      if (order && order.strategyId) {
        await this.log(order.strategyId, action, details, order.id, lifecycleStatus || order.lifecycleStatus);
      } else {
        logger.warn(`AuditService: No recent order found for symbol ${symbol} to link audit log`, { action });
      }
    } catch (error: any) {
      logger.error('Failed to write audit log by symbol', formatError(error));
    }
  }
}

export default new AuditService();
