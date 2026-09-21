import Router from 'koa-router';
import { Op } from 'sequelize';
import { sequelize, ExchangeInstance, Order, Strategy, VirtualOrder, VirtualTrade, VirtualPosition } from '../models';
import MarkPriceCache from '../services/exchanges/virtual/MarkPriceCache';

const router = new Router();

type QueryValue = string | string[] | undefined;

export class VirtualExchangeRouteError extends Error {
  public status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const asString = (value: QueryValue): string | undefined => {
  if (Array.isArray(value)) return value[0];
  return value;
};

import { getVirtualContractMultiplier } from '../utils/virtualContractMultiplier';
import { normalizeSymbolCase } from '../utils/normalizeSymbol';
import { VIRTUAL_TYPE_OP } from '../utils/virtualTypes';

export { getVirtualContractMultiplier };

const parseLeverage = (value: unknown): number => {
  const leverage = Number(value);
  return Number.isFinite(leverage) && leverage > 0 ? leverage : 1;
};

const getBaseCurrency = (symbol: string): string => normalizeSymbolCase(symbol).split('_')[0] || symbol;

const normalizeDecimalString = (value: number): string => {
  if (!Number.isFinite(value)) return '';
  return Number(value.toFixed(12)).toString();
};

const attachBaseAmount = <T extends Record<string, any>>(row: T, amountValue?: unknown): T & { baseAmount: string | null; baseCurrency: string } => {
  const rawAmount = amountValue ?? row.filledAmount ?? row.amount;
  const amount = Number(rawAmount);
  const multiplier = getVirtualContractMultiplier(row.symbol);
  return {
    ...row,
    baseAmount: Number.isFinite(amount) ? normalizeDecimalString(amount * multiplier) : null,
    baseCurrency: getBaseCurrency(row.symbol),
  };
};

export const parseLimit = (value: QueryValue, fallback: number): number => {
  const raw = asString(value);
  const parsed = raw ? Number.parseInt(raw, 10) : fallback;
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, 500);
};

export const getVirtualExchangeInstances = async () => {
  return ExchangeInstance.findAll({
    where: { type: VIRTUAL_TYPE_OP },
    order: [['createdAt', 'ASC'], ['id', 'ASC']],
  });
};

export const getVirtualExchangeIds = async (): Promise<string[]> => {
  const instances = await getVirtualExchangeInstances();
  // 回测虚拟实例（bt_ 前缀）不进入默认虚拟视图；显式指定 exchangeInstanceId 仍可查询
  return instances.map(instance => instance.id).filter(id => !id.startsWith('bt_'));
};

export const validateVirtualExchangeId = async (exchangeInstanceId?: string): Promise<void> => {
  if (!exchangeInstanceId) return;

  const instance = await ExchangeInstance.findOne({
    where: { id: exchangeInstanceId, type: VIRTUAL_TYPE_OP },
  });

  if (!instance) {
    throw new VirtualExchangeRouteError(400, 'exchangeInstanceId must be a virtual_gate instance');
  }
};

const virtualExchangeScope = async (exchangeInstanceId?: string) => {
  await validateVirtualExchangeId(exchangeInstanceId);

  if (exchangeInstanceId) {
    return exchangeInstanceId;
  }

  const ids = await getVirtualExchangeIds();
  return { [Op.in]: ids };
};

export const listVirtualBusinessOrders = async (query: Record<string, QueryValue>) => {
  const exchangeInstanceId = asString(query.exchangeInstanceId);
  const parser = asString(query.parser);
  const where: any = {
    exchangeInstanceId: await virtualExchangeScope(exchangeInstanceId),
  };

  const symbol = asString(query.symbol);
  const source = asString(query.source);
  if (symbol) where.symbol = symbol;
  if (source) where.source = source;

  const include: any[] = [{ model: Strategy, as: 'Strategy' }];
  if (parser) {
    include[0].where = { parserName: parser };
  }

  const orders = await Order.findAll({
    where,
    include,
    order: [['createdAt', 'DESC'], ['id', 'DESC']],
    limit: parseLimit(query.limit, 100),
  });

  // Build markPriceMap: prefer in-memory cache, fall back to DB for any gaps
  const markPriceMap = new Map<string, string>();
  const cacheAll = MarkPriceCache.getAll();
  for (const [key, value] of cacheAll) {
    markPriceMap.set(key, value);
  }

  // Collect pairs still missing from the cache
  const orConditions: { exchangeInstanceId: string; symbol: string }[] = [];
  const seenKeys = new Set<string>();
  for (const order of orders) {
    if (order.lifecycleStatus !== 'CLOSED' && order.filledPrice && order.filledAmount) {
      const key = `${order.exchangeInstanceId}\0${order.symbol}`;
      if (!markPriceMap.has(key) && !seenKeys.has(key)) {
        seenKeys.add(key);
        orConditions.push({ exchangeInstanceId: order.exchangeInstanceId, symbol: order.symbol });
      }
    }
  }

  if (orConditions.length > 0) {
    const positions = await VirtualPosition.findAll({
      where: { [Op.or]: orConditions },
    });
    for (const pos of positions) {
      const key = `${pos.exchangeInstanceId}\0${pos.symbol}`;
      markPriceMap.set(key, pos.markPrice);
    }
  }

  const computedPnlMap = new Map<number, number>();
  const closedWithoutPnl = orders.filter(
    (o) => o.lifecycleStatus === 'CLOSED' && !o.realizedPnl && o.exchangeInstanceId
  );
  if (closedWithoutPnl.length > 0) {
    const orConditions = closedWithoutPnl.map((o) => ({
      exchangeInstanceId: o.exchangeInstanceId,
      symbol: o.symbol,
      executedAt: {
        [Op.gte]: o.createdAt,
        [Op.lte]: o.closedAt || o.updatedAt || new Date(),
      },
    }));
    const trades = await VirtualTrade.findAll({
      where: { [Op.or]: orConditions },
      attributes: ['exchangeInstanceId', 'symbol', 'virtualOrderId', 'realizedPnl', 'text', 'executedAt'],
    });
    for (const order of closedWithoutPnl) {
      let pnl = 0;
      let matched = false;
      for (const t of trades) {
        if (isLinkedVirtualTrade(order, t)) {
          pnl += parseFloat(t.realizedPnl || '0');
          matched = true;
        }
      }
      if (matched) {
        computedPnlMap.set(order.id, pnl);
      }
    }
  }

  // Attach P&L and return as plain objects so custom fields survive JSON serialization
  return orders.map((order) => {
    const plain = attachBaseAmount(order.get({ plain: true }) as any);
    const effectiveEntryPrice = plain.filledPrice ? Number(plain.filledPrice) : Number(plain.price);
    const effectiveAmount = plain.filledAmount ? Number(plain.filledAmount) : Number(plain.amount);

    const hasPositionBasis =
      Number.isFinite(effectiveEntryPrice) && effectiveEntryPrice > 0 &&
      Number.isFinite(effectiveAmount) && effectiveAmount > 0;

    if (isClosedBusinessOrder(plain)) {
      let pnl = plain.realizedPnl ? Number(plain.realizedPnl) : null;
      if (pnl === null) {
        const computed = computedPnlMap.get(plain.id);
        pnl = computed !== undefined ? computed : null;
      }
      plain.pnlAmount = pnl !== null ? String(pnl) : null;
      if (!hasPositionBasis) {
        plain.pnlPercent = null;
        return plain;
      }
      const multiplier = getVirtualContractMultiplier(plain.symbol);
      const marginValue = (effectiveEntryPrice * effectiveAmount * multiplier) / parseLeverage(plain.leverage);
      plain.pnlPercent = pnl !== null && marginValue !== 0
        ? (pnl / marginValue) * 100
        : null;
    } else {
      if (!hasPositionBasis) {
        plain.pnlAmount = null;
        plain.pnlPercent = null;
        return plain;
      }

      const markPriceStr = markPriceMap.get(`${plain.exchangeInstanceId}\0${plain.symbol}`);
      const markPrice = markPriceStr ? Number(markPriceStr) : null;
      if (!markPrice || markPrice === 0) {
        plain.pnlAmount = null;
        plain.pnlPercent = null;
        return plain;
      }

      const diff = plain.side === 'buy'
        ? markPrice - effectiveEntryPrice
        : effectiveEntryPrice - markPrice;
      const multiplier = getVirtualContractMultiplier(plain.symbol);
      const marginValue = (effectiveEntryPrice * effectiveAmount * multiplier) / parseLeverage(plain.leverage);
      const pnl = diff * effectiveAmount * multiplier;

      plain.pnlAmount = String(pnl);
      plain.pnlPercent = (pnl / marginValue) * 100;
      plain.lastPrice = String(markPrice);
    }

    return plain;
  });
};

const isClosedBusinessOrder = (order: Record<string, any>): boolean => {
  const lifecycleStatus = String(order.lifecycleStatus || '').toUpperCase();
  const status = String(order.status || '').toLowerCase();
  return lifecycleStatus === 'CLOSED' || status === 'closed' || status === 'cancelled';
};

const isLinkedVirtualTrade = (order: any, trade: any): boolean => {
  if (trade.exchangeInstanceId !== order.exchangeInstanceId || trade.symbol !== order.symbol) return false;
  const text = String(trade.text || '');
  const exchangeOrderId = String(order.exchangeOrderId || '');
  const orderId = String(order.id || '');

  if (exchangeOrderId && (trade.virtualOrderId === exchangeOrderId || text.includes(exchangeOrderId))) {
    return true;
  }

  if (orderId && text.includes(`-ord-${orderId}`)) {
    return true;
  }

  return false;
};

export const listVirtualOpenOrders = async (query: Record<string, QueryValue>) => {
  const exchangeInstanceId = asString(query.exchangeInstanceId);
  const where: any = {
    status: 'open',
    exchangeInstanceId: await virtualExchangeScope(exchangeInstanceId),
  };

  const symbol = asString(query.symbol);
  const orderRole = asString(query.orderRole);
  if (symbol) where.symbol = symbol;
  if (orderRole) where.orderRole = orderRole;

  const rows = await VirtualOrder.findAll({
    where,
    order: [['createdAt', 'DESC'], ['id', 'DESC']],
    limit: parseLimit(query.limit, 100),
  });

  return rows.map(row => attachBaseAmount(row.get({ plain: true }) as any));
};

export const cancelVirtualBusinessOrder = async (orderId: number | string) => {
  const order = await Order.findByPk(orderId);
  if (!order) {
    throw new VirtualExchangeRouteError(404, 'Order not found');
  }

  await validateVirtualExchangeId(order.exchangeInstanceId);

  if (String(order.status || '').toLowerCase() !== 'open') {
    throw new VirtualExchangeRouteError(400, 'Only open virtual orders can be cancelled');
  }

  if (!order.exchangeOrderId) {
    throw new VirtualExchangeRouteError(400, 'Order has no exchangeOrderId');
  }

  const virtualOrder = await VirtualOrder.findOne({
    where: {
      exchangeInstanceId: order.exchangeInstanceId,
      virtualOrderId: order.exchangeOrderId,
      symbol: order.symbol,
      status: 'open',
    },
  });

  if (!virtualOrder) {
    throw new VirtualExchangeRouteError(404, 'Matching open virtual order not found');
  }

  await sequelize.transaction(async (transaction) => {
    await virtualOrder.update({ status: 'cancelled' }, { transaction });
    await order.update({ status: 'cancelled', lifecycleStatus: 'CLOSED', closedAt: new Date() }, { transaction });
  });

  return { success: true };
};

export const cancelVirtualOpenOrder = async (virtualOrderId: string, query: Record<string, QueryValue>) => {
  const exchangeInstanceId = asString(query.exchangeInstanceId);
  const symbol = asString(query.symbol);
  await validateVirtualExchangeId(exchangeInstanceId);

  const where: any = { virtualOrderId, status: 'open' };
  if (exchangeInstanceId) where.exchangeInstanceId = exchangeInstanceId;
  if (symbol) where.symbol = symbol;

  const order = await VirtualOrder.findOne({ where });
  if (!order) {
    throw new VirtualExchangeRouteError(404, 'Open virtual order not found');
  }

  await validateVirtualExchangeId(order.exchangeInstanceId);
  await order.update({ status: 'cancelled' });
  return { success: true };
};

export const listVirtualTrades = async (query: Record<string, QueryValue>) => {
  const exchangeInstanceId = asString(query.exchangeInstanceId);
  const where: any = {
    exchangeInstanceId: await virtualExchangeScope(exchangeInstanceId),
  };

  const symbol = asString(query.symbol);
  if (symbol) where.symbol = symbol;

  const rows = await VirtualTrade.findAll({
    where,
    order: [['executedAt', 'DESC'], ['createdAt', 'DESC']],
    limit: parseLimit(query.limit, 100),
  });

  return rows.map(row => attachBaseAmount(row.get({ plain: true }) as any));
};

const handleRouteError = (ctx: any, error: any) => {
  if (error instanceof VirtualExchangeRouteError) {
    ctx.status = error.status;
    ctx.body = { error: error.message };
    return;
  }

  ctx.status = 500;
  ctx.body = { error: error.message };
};

router.get('/instances', async (ctx) => {
  try {
    ctx.body = await getVirtualExchangeInstances();
  } catch (error: any) {
    handleRouteError(ctx, error);
  }
});

router.get('/orders', async (ctx) => {
  try {
    ctx.body = await listVirtualBusinessOrders(ctx.query as Record<string, QueryValue>);
  } catch (error: any) {
    handleRouteError(ctx, error);
  }
});

router.post('/orders/:id/cancel', async (ctx) => {
  try {
    ctx.body = await cancelVirtualBusinessOrder(ctx.params.id);
  } catch (error: any) {
    handleRouteError(ctx, error);
  }
});

router.get('/open-orders', async (ctx) => {
  try {
    ctx.body = await listVirtualOpenOrders(ctx.query as Record<string, QueryValue>);
  } catch (error: any) {
    handleRouteError(ctx, error);
  }
});

router.post('/open-orders/:id/cancel', async (ctx) => {
  try {
    ctx.body = await cancelVirtualOpenOrder(ctx.params.id, ctx.query as Record<string, QueryValue>);
  } catch (error: any) {
    handleRouteError(ctx, error);
  }
});

router.get('/trades', async (ctx) => {
  try {
    ctx.body = await listVirtualTrades(ctx.query as Record<string, QueryValue>);
  } catch (error: any) {
    handleRouteError(ctx, error);
  }
});

export default router;
