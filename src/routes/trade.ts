import Router from 'koa-router';
import { Op } from 'sequelize';
import { sequelize } from '../db';
import {
  ExchangeInstance,
  Order,
  VirtualTrade,
  LighterTxJournal,
} from '../models';
import exchangeRegistry from '../services/exchanges';
import { getVirtualContractMultiplier } from '../utils/virtualContractMultiplier';
import { isVirtualExchangeType } from '../utils/virtualTypes';
import logger, { formatError } from '../utils/logger';

const router = new Router();

export const parsePageQuery = (value: unknown, fallback: number): number => {
  const raw = Array.isArray(value) ? value[0] : value;
  const parsed = raw ? parseInt(String(raw), 10) : fallback;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const asString = (value: unknown): string | undefined => {
  if (Array.isArray(value)) return value[0] as string;
  return value as string | undefined;
};

/** 根据订单计算平仓盈亏率（%）：盈亏 / 保证金 * 100，保证金 = 入场价 * 数量 * 合约乘数 / 杠杆 */
const computePnlPercent = (order: any): number | null => {
  const pnl = order.realizedPnl !== null && order.realizedPnl !== undefined && order.realizedPnl !== ''
    ? Number(order.realizedPnl)
    : null;
  if (pnl === null || !Number.isFinite(pnl)) return null;

  const entryPrice = order.filledPrice ? Number(order.filledPrice) : order.price ? Number(order.price) : NaN;
  const amount = order.filledAmount ? Number(order.filledAmount) : order.amount ? Number(order.amount) : NaN;
  if (!Number.isFinite(entryPrice) || entryPrice <= 0 || !Number.isFinite(amount) || amount <= 0) return null;

  const multiplier = getVirtualContractMultiplier(order.symbol || '');
  const leverage = order.leverage ? Number(order.leverage) : 1;
  const marginValue = (entryPrice * amount * multiplier) / (Number.isFinite(leverage) && leverage > 0 ? leverage : 1);
  if (!Number.isFinite(marginValue) || marginValue === 0) return null;

  return (pnl / marginValue) * 100;
};

/**
 * 历史委托（按交易所实例筛选订单，分页）。返回按指定顺序的展示字段：
 * 委托价格 price、成交价格 filledPrice、成交数量 filledAmount、
 * 平仓盈亏 realizedPnl、平仓盈亏率 pnlPercent、杠杆 leverage、方向 side。
 */
router.get('/orders', async (ctx) => {
  const exchangeInstanceId = asString(ctx.query.exchangeInstanceId);
  if (!exchangeInstanceId) {
    ctx.status = 400;
    ctx.body = { error: 'exchangeInstanceId is required' };
    return;
  }

  const page = parsePageQuery(ctx.query.page, 1);
  const pageSize = parsePageQuery(ctx.query.pageSize, 20);

  try {
    const { count, rows } = await Order.findAndCountAll({
      where: { exchangeInstanceId },
      order: [['createdAt', 'DESC'], ['id', 'DESC']],
      limit: pageSize,
      offset: (page - 1) * pageSize,
      attributes: [
        'id', 'symbol', 'side', 'price', 'filledPrice', 'filledAmount',
        'realizedPnl', 'leverage', 'amount', 'status', 'lifecycleStatus',
        'closedAt', 'createdAt',
      ],
    });

    const data = rows.map((row) => {
      const plain = row.get({ plain: true });
      return { ...plain, pnlPercent: computePnlPercent(plain) };
    });

    ctx.body = { total: count, page, pageSize, data };
  } catch (error: any) {
    ctx.status = 500;
    ctx.body = { error: error.message };
  }
});

/** 获取某交易所已发生成交的交易对列表（用于实时拉取成交记录） */
const getTradedSymbols = async (exchangeInstanceId: string): Promise<string[]> => {
  const rows = await Order.findAll({
    where: { exchangeInstanceId },
    attributes: [[sequelize.fn('DISTINCT', sequelize.col('symbol')), 'symbol']],
    raw: true,
  });
  return rows.map((r: any) => r.symbol).filter(Boolean).slice(0, 50);
};

/**
 * 成交记录：虚拟交易所读 VirtualTrade 表；实盘交易所按交易对调用 getTradeHistory 实时拉取，
 * 按时间倒序合并（Gate-CFD 无成交 API 时返回空，前端据此提示）。
 */
router.get('/fills', async (ctx) => {
  const exchangeInstanceId = asString(ctx.query.exchangeInstanceId);
  if (!exchangeInstanceId) {
    ctx.status = 400;
    ctx.body = { error: 'exchangeInstanceId is required' };
    return;
  }

  const symbol = asString(ctx.query.symbol);
  const limit = parsePageQuery(ctx.query.limit, 200);

  try {
    const instance = await ExchangeInstance.findByPk(exchangeInstanceId);
    if (!instance) {
      ctx.status = 404;
      ctx.body = { error: 'Exchange instance not found' };
      return;
    }

    // 虚拟交易所：直接读持久化的成交表
    if (isVirtualExchangeType(instance.type)) {
      const where: any = { exchangeInstanceId };
      if (symbol) where.symbol = symbol;
      const rows = await VirtualTrade.findAll({
        where,
        order: [['executedAt', 'DESC']],
        limit: Math.min(limit, 500),
      });
      ctx.body = rows.map((row) => {
        const plain = row.get({ plain: true });
        return {
          id: plain.tradeId,
          orderId: plain.virtualOrderId,
          symbol: plain.symbol,
          side: plain.side,
          price: plain.price,
          amount: plain.amount,
          role: plain.role,
          realizedPnl: plain.realizedPnl,
          time: plain.executedAt ? new Date(plain.executedAt).getTime() : 0,
          exchangeInstanceId,
        };
      });
      return;
    }

    // 实盘：按交易对逐个实时拉取并合并
    const exchange = exchangeRegistry.getExchange(exchangeInstanceId);
    const symbols = symbol ? [symbol] : await getTradedSymbols(exchangeInstanceId);
    const perSymbol = Math.ceil(limit / Math.max(symbols.length, 1)) + 10;

    const settled = await Promise.allSettled(
      symbols.map((s) => exchange.getTradeHistory(s, perSymbol)),
    );

    const fills: any[] = [];
    settled.forEach((result, idx) => {
      if (result.status !== 'fulfilled') return;
      const list = result.value || [];
      for (const t of list) {
        fills.push({
          id: t.id,
          orderId: t.orderId,
          symbol: t.symbol || symbols[idx],
          side: t.side,
          price: t.price,
          amount: t.amount,
          role: t.role,
          time: t.time,
          exchangeInstanceId,
        });
      }
    });

    fills.sort((a, b) => (b.time || 0) - (a.time || 0));
    ctx.body = fills.slice(0, limit);
  } catch (error: any) {
    logger.warn(`[trades/fills] failed: ${error.message}`);
    ctx.status = 500;
    ctx.body = { error: error.message };
  }
});

/**
 * 资金流水：尽力基于现有数据实现。
 * - balance：账户实时余额快照
 * - entries：已平仓订单的平仓盈亏（所有类型）+ Lighter 交易台账（若有）
 *   + 虚拟交易所成交盈亏，按时间倒序合并
 */
router.get('/funds', async (ctx) => {
  const exchangeInstanceId = asString(ctx.query.exchangeInstanceId);
  if (!exchangeInstanceId) {
    ctx.status = 400;
    ctx.body = { error: 'exchangeInstanceId is required' };
    return;
  }

  const limit = parsePageQuery(ctx.query.limit, 200);

  try {
    const instance = await ExchangeInstance.findByPk(exchangeInstanceId);

    // 1) 余额快照（尽可能获取；失败不阻断流水展示）
    let balance: any = null;
    try {
      const exchange = exchangeRegistry.getExchange(exchangeInstanceId);
      balance = await exchange.getBalance();
    } catch (e) {
      logger.debug(`[trades/funds] getBalance failed: ${formatError(e).message}`);
    }

    const entries: any[] = [];

    // 2) 已平仓订单的平仓盈亏
    const closedOrders = await Order.findAll({
      where: {
        exchangeInstanceId,
        realizedPnl: { [Op.ne]: null },
        [Op.or]: [{ lifecycleStatus: 'CLOSED' }, { lifecycleStatus: 'PROTECTED' }],
      },
      order: [['closedAt', 'DESC']],
      limit: Math.min(limit, 200),
      attributes: ['id', 'symbol', 'realizedPnl', 'closedAt', 'createdAt'],
    });
    for (const row of closedOrders) {
      const plain = row.get({ plain: true });
      entries.push({
        time: plain.closedAt || plain.createdAt,
        type: 'realized_pnl',
        typeLabel: '平仓盈亏',
        amount: Number(plain.realizedPnl),
        currency: 'USDT',
        symbol: plain.symbol,
        note: `${plain.symbol} 平仓`,
      });
    }

    // 3) 虚拟交易所：成交盈亏
    if (instance && isVirtualExchangeType(instance.type)) {
      const trades = await VirtualTrade.findAll({
        where: { exchangeInstanceId },
        order: [['executedAt', 'DESC']],
        limit: Math.min(limit, 200),
        attributes: ['symbol', 'realizedPnl', 'executedAt'],
      });
      for (const row of trades) {
        const plain = row.get({ plain: true });
        const pnl = Number(plain.realizedPnl);
        if (!Number.isFinite(pnl) || pnl === 0) continue;
        entries.push({
          time: plain.executedAt,
          type: 'trade',
          typeLabel: '成交',
          amount: pnl,
          currency: 'USDT',
          symbol: plain.symbol,
          note: `${plain.symbol} 成交盈亏`,
        });
      }
    }

    // 4) Lighter：交易台账（底层签名/提交记录）
    if (instance && instance.type === 'lighter') {
      const journals = await LighterTxJournal.findAll({
        where: { exchangeInstanceId },
        order: [['createdAt', 'DESC']],
        limit: Math.min(limit, 200),
      });
      for (const row of journals) {
        const plain = row.get({ plain: true });
        entries.push({
          time: plain.confirmedAt || plain.createdAt,
          type: 'lighter_tx',
          typeLabel: '交易提交',
          amount: null,
          currency: 'USDT',
          symbol: null,
          note: `tx ${plain.txId} · type ${plain.txType} · ${plain.status}`,
        });
      }
    }

    entries.sort((a, b) => (b.time ? new Date(b.time).getTime() : 0) - (a.time ? new Date(a.time).getTime() : 0));

    ctx.body = { balance, entries: entries.slice(0, limit) };
  } catch (error: any) {
    logger.warn(`[trades/funds] failed: ${error.message}`);
    ctx.status = 500;
    ctx.body = { error: error.message };
  }
});

export default router;