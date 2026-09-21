import { Op, Transaction } from 'sequelize';
import { sequelize, VirtualAccount, VirtualOrder, VirtualPosition, VirtualTrade } from '../../../models';
import { nowOrSim } from '../../../backtest/Clock';

const EPSILON = 1e-8;

export class VirtualStateStore {
  constructor(private exchangeInstanceId: string) {}

  async getOrCreateAccount(initialBalance: string, currency = 'USDT') {
    const [account] = await VirtualAccount.findOrCreate({
      where: { exchangeInstanceId: this.exchangeInstanceId, currency },
      defaults: {
        exchangeInstanceId: this.exchangeInstanceId,
        currency,
        initialBalance,
        availableBalance: initialBalance,
        realizedPnl: '0',
        status: 'active',
      },
    } as any);
    return account;
  }

  async getPosition(symbol: string, transaction?: Transaction) {
    return VirtualPosition.findOne({ where: { exchangeInstanceId: this.exchangeInstanceId, symbol }, transaction });
  }

  async upsertPosition(payload: {
    symbol: string;
    size: string;
    entryPrice: string;
    markPrice: string;
    realizedPnl?: string;
    leverage?: string;
    marginType?: string;
  }, transaction?: Transaction) {
    const existing = await this.getPosition(payload.symbol, transaction);
    if (existing) {
      await existing.update(payload, { transaction });
      return existing;
    }
    return VirtualPosition.create({
      exchangeInstanceId: this.exchangeInstanceId,
      realizedPnl: '0',
      leverage: '1',
      marginType: 'cross',
      ...payload,
    } as any, { transaction });
  }

  async createOrder(payload: any, transaction?: Transaction) {
    return VirtualOrder.create({ exchangeInstanceId: this.exchangeInstanceId, ...payload }, { transaction });
  }

  async markOrderFilled(order: any, price: string, amount: string, transaction?: Transaction): Promise<boolean> {
    const [updatedCount] = await VirtualOrder.update(
      { status: 'filled', filledPrice: price, filledAmount: amount },
      {
        where: {
          exchangeInstanceId: this.exchangeInstanceId,
          virtualOrderId: order.virtualOrderId,
          status: 'open',
        },
        transaction,
      } as any,
    );
    return updatedCount > 0;
  }

  async cancelInvalidReduceOnlyOrder(order: any, _reason: string, transaction?: Transaction): Promise<boolean> {
    const [updatedCount] = await VirtualOrder.update(
      { status: 'cancelled' },
      {
        where: {
          exchangeInstanceId: this.exchangeInstanceId,
          virtualOrderId: order.virtualOrderId,
          status: 'open',
          reduceOnly: true,
        },
        transaction,
      } as any,
    );
    return updatedCount > 0;
  }

  async cancelStaleReduceOnlyOrders(symbol: string): Promise<number> {
    const position = await this.getPosition(symbol);
    const currentSize = Number(position?.size ?? '0');
    if (!Number.isFinite(currentSize)) return 0;

    const openOrders = await this.findOpenOrders(symbol);
    const staleOrders = openOrders.filter((order: any) => {
      if (order.reduceOnly !== true) return false;
      const signedAmount = order.side === 'buy' ? 1 : order.side === 'sell' ? -1 : 0;
      if (signedAmount === 0) return false;
      return currentSize === 0 || Math.sign(currentSize) === signedAmount;
    });

    for (const order of staleOrders) {
      await this.cancelInvalidReduceOnlyOrder(order, 'Stale reduce-only order');
    }

    return staleOrders.length;
  }

  async createTrade(payload: any, transaction?: Transaction) {
    // 回测子进程：成交时间记录为对应 K 线时间；实盘 nowOrSim() === new Date()
    return VirtualTrade.create({ exchangeInstanceId: this.exchangeInstanceId, executedAt: nowOrSim(), ...payload }, { transaction });
  }

  async recordFill(payload: {
    position: {
      symbol: string;
      size: string;
      entryPrice: string;
      markPrice: string;
      realizedPnl?: string;
      leverage?: string;
      marginType?: string;
    };
    order: any;
    fillPrice: string;
    filledAmount: string;
    trade: any;
    realizedPnl?: number;
  }): Promise<{ filled: boolean; trade?: any }> {
    return sequelize.transaction(async (transaction) => {
      const filled = await this.markOrderFilled(payload.order, payload.fillPrice, payload.filledAmount, transaction);
      if (!filled) {
        return { filled: false };
      }

      await this.upsertPosition(payload.position, transaction);
      const trade = await this.createTrade(payload.trade, transaction);

      if (payload.realizedPnl && Math.abs(payload.realizedPnl) > EPSILON) {
        await this.addRealizedPnl(payload.realizedPnl, transaction);
      }

      return { filled: true, trade };
    });
  }

  private async addRealizedPnl(pnl: number, transaction?: Transaction) {
    const account = await VirtualAccount.findOne({
      where: { exchangeInstanceId: this.exchangeInstanceId, currency: 'USDT' },
      transaction,
      lock: true,
    } as any);
    if (!account) return;

    const currentBalance = parseFloat(account.availableBalance || '0');
    const currentPnl = parseFloat(account.realizedPnl || '0');
    const nextBalance = currentBalance + pnl;
    const nextPnl = currentPnl + pnl;

    await account.update({
      availableBalance: nextBalance.toFixed(4),
      realizedPnl: nextPnl.toFixed(4),
    }, { transaction });
  }

  async findOpenOrders(symbol?: string) {
    return VirtualOrder.findAll({
      where: { exchangeInstanceId: this.exchangeInstanceId, status: 'open', ...(symbol ? { symbol } : {}) },
      order: [['createdAt', 'ASC']],
    });
  }

  async findFinishedOrders(symbol: string, limit: number) {
    return VirtualOrder.findAll({
      where: { exchangeInstanceId: this.exchangeInstanceId, symbol, status: { [Op.in]: ['filled', 'cancelled', 'rejected'] } },
      limit,
      order: [['updatedAt', 'DESC']],
    });
  }
}
