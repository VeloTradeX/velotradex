import { sequelize, ExchangeInstance, Order, Strategy, VirtualOrder, VirtualTrade, VirtualPosition } from '../../src/models';
import {
  getVirtualExchangeInstances,
  listVirtualBusinessOrders,
  listVirtualOpenOrders,
  listVirtualTrades,
  cancelVirtualBusinessOrder,
  cancelVirtualOpenOrder,
  parseLimit,
  validateVirtualExchangeId,
} from '../../src/routes/virtualExchange';

describe('virtual exchange route helpers', () => {
  beforeEach(async () => {
    await sequelize.sync({ force: true });

    await ExchangeInstance.bulkCreate([
      { id: 'virtual-a', type: 'virtual_gate', name: 'Virtual A', config: '{}', status: 'active' },
      { id: 'virtual-b', type: 'virtual_gate', name: 'Virtual B', config: '{}', status: 'inactive' },
      { id: 'real-a', type: 'gate', name: 'Real A', config: '{}', status: 'active' },
    ]);
  });

  afterAll(async () => {
    await sequelize.close();
  });

  it('returns only virtual_gate instances', async () => {
    const instances = await getVirtualExchangeInstances();

    expect(instances.map(i => i.id)).toEqual(['virtual-a', 'virtual-b']);
  });

  it('accepts virtual exchange ids and rejects non-virtual ids', async () => {
    await expect(validateVirtualExchangeId('virtual-a')).resolves.toBeUndefined();
    await expect(validateVirtualExchangeId('real-a')).rejects.toMatchObject({
      status: 400,
      message: 'exchangeInstanceId must be a virtual_gate instance',
    });
  });

  it('parses list limits with a safe cap', () => {
    expect(parseLimit(undefined, 100)).toBe(100);
    expect(parseLimit('25', 100)).toBe(25);
    expect(parseLimit('0', 100)).toBe(100);
    expect(parseLimit('9999', 100)).toBe(500);
    expect(parseLimit('abc', 100)).toBe(100);
  });

  it('lists only virtual business orders and supports exchange filtering', async () => {
    const strategy = await Strategy.create({
      symbol: 'BTC_USDT',
      side: 'buy',
      source: 'route-a',
      parserName: 'DefaultParser',
    });

    await Order.bulkCreate([
      {
        strategyId: strategy.id,
        exchangeOrderId: 'vo-1',
        exchangeInstanceId: 'virtual-a',
        source: 'route-a',
        exchange: 'virtual_gate',
        symbol: 'BTC_USDT',
        side: 'buy',
        amount: '1',
        price: '100',
        status: 'open',
      },
      {
        strategyId: strategy.id,
        exchangeOrderId: 'vo-2',
        exchangeInstanceId: 'virtual-b',
        source: 'route-a',
        exchange: 'virtual_gate',
        symbol: 'ETH_USDT',
        side: 'sell',
        amount: '2',
        price: '200',
        status: 'closed',
      },
      {
        strategyId: strategy.id,
        exchangeOrderId: 'real-1',
        exchangeInstanceId: 'real-a',
        source: 'route-a',
        exchange: 'gate',
        symbol: 'BTC_USDT',
        side: 'buy',
        amount: '3',
        price: '300',
        status: 'open',
      },
    ]);

    const allVirtual = await listVirtualBusinessOrders({});
    expect(allVirtual.map(o => o.exchangeOrderId)).toEqual(['vo-2', 'vo-1']);

    const filtered = await listVirtualBusinessOrders({ exchangeInstanceId: 'virtual-a' });
    expect(filtered.map(o => o.exchangeOrderId)).toEqual(['vo-1']);
  });

  it('adds actual base amount to virtual business orders', async () => {
    const strategy = await Strategy.create({
      symbol: 'BTC_USDT',
      side: 'buy',
      source: 'route-a',
      parserName: 'DefaultParser',
    });

    await Order.create({
      strategyId: strategy.id,
      exchangeOrderId: 'vo-base-amount-1',
      exchangeInstanceId: 'virtual-a',
      source: 'route-a',
      exchange: 'virtual_gate',
      symbol: 'BTC_USDT',
      side: 'buy',
      amount: '100',
      price: '65000',
      filledAmount: '100',
      filledPrice: '65000',
      status: 'open',
      lifecycleStatus: 'OPEN',
    });

    const orders = await listVirtualBusinessOrders({ exchangeInstanceId: 'virtual-a' });

    expect(orders[0].baseAmount).toBe('0.01');
    expect(orders[0].baseCurrency).toBe('BTC');
  });

  it('lists only open virtual orders', async () => {
    await VirtualOrder.bulkCreate([
      {
        virtualOrderId: 'open-1',
        exchangeInstanceId: 'virtual-a',
        symbol: 'BTC_USDT',
        side: 'buy',
        type: 'limit',
        orderRole: 'entry',
        price: '100',
        amount: '1',
        status: 'open',
      },
      {
        virtualOrderId: 'filled-1',
        exchangeInstanceId: 'virtual-a',
        symbol: 'BTC_USDT',
        side: 'buy',
        type: 'limit',
        orderRole: 'entry',
        price: '100',
        amount: '1',
        status: 'filled',
      },
    ]);

    const openOrders = await listVirtualOpenOrders({ exchangeInstanceId: 'virtual-a' });

    expect(openOrders.map(o => o.virtualOrderId)).toEqual(['open-1']);
  });

  it('cancels an open business order and its matching virtual order', async () => {
    const strategy = await Strategy.create({
      symbol: 'BTC_USDT',
      side: 'buy',
      source: 'route-a',
      parserName: 'DefaultParser',
    });

    const order = await Order.create({
      strategyId: strategy.id,
      exchangeOrderId: 'vo-cancel-1',
      exchangeInstanceId: 'virtual-a',
      source: 'route-a',
      exchange: 'virtual_gate',
      symbol: 'BTC_USDT',
      side: 'buy',
      amount: '1',
      price: '64000',
      status: 'open',
      lifecycleStatus: 'PENDING',
    });

    await VirtualOrder.create({
      virtualOrderId: 'vo-cancel-1',
      exchangeInstanceId: 'virtual-a',
      symbol: 'BTC_USDT',
      side: 'buy',
      type: 'limit',
      orderRole: 'entry',
      price: '64000',
      amount: '1',
      status: 'open',
    });

    await expect(cancelVirtualBusinessOrder(order.id)).resolves.toEqual({ success: true });

    await order.reload();
    const virtualOrder = await VirtualOrder.findOne({ where: { virtualOrderId: 'vo-cancel-1' } });
    expect(order.status).toBe('cancelled');
    expect(order.lifecycleStatus).toBe('CLOSED');
    expect(virtualOrder?.status).toBe('cancelled');
  });

  it('cancels an open virtual order directly', async () => {
    await VirtualOrder.create({
      virtualOrderId: 'open-cancel-1',
      exchangeInstanceId: 'virtual-a',
      symbol: 'BTC_USDT',
      side: 'buy',
      type: 'limit',
      orderRole: 'entry',
      price: '100',
      amount: '1',
      status: 'open',
    });

    await expect(cancelVirtualOpenOrder('open-cancel-1', { exchangeInstanceId: 'virtual-a', symbol: 'BTC_USDT' }))
      .resolves.toEqual({ success: true });

    const openOrders = await listVirtualOpenOrders({ exchangeInstanceId: 'virtual-a' });
    expect(openOrders).toEqual([]);
  });

  it('adds actual base amount to open virtual orders', async () => {
    await VirtualOrder.create({
      virtualOrderId: 'open-base-amount-1',
      exchangeInstanceId: 'virtual-a',
      symbol: 'BTC_USDT',
      side: 'buy',
      type: 'limit',
      orderRole: 'entry',
      price: '65000',
      amount: '100',
      status: 'open',
    });

    const openOrders = await listVirtualOpenOrders({ exchangeInstanceId: 'virtual-a' });

    expect((openOrders[0] as any).baseAmount).toBe('0.01');
    expect((openOrders[0] as any).baseCurrency).toBe('BTC');
  });

  it('lists virtual trades newest first', async () => {
    await VirtualTrade.bulkCreate([
      {
        tradeId: 'trade-old',
        virtualOrderId: 'open-1',
        exchangeInstanceId: 'virtual-a',
        symbol: 'BTC_USDT',
        side: 'buy',
        price: '100',
        amount: '1',
        role: 'taker',
        realizedPnl: '0',
        executedAt: new Date('2026-05-04T01:00:00.000Z'),
      },
      {
        tradeId: 'trade-new',
        virtualOrderId: 'open-2',
        exchangeInstanceId: 'virtual-a',
        symbol: 'BTC_USDT',
        side: 'sell',
        price: '110',
        amount: '1',
        role: 'taker',
        realizedPnl: '10',
        executedAt: new Date('2026-05-04T02:00:00.000Z'),
      },
    ]);

    const trades = await listVirtualTrades({ exchangeInstanceId: 'virtual-a' });

    expect(trades.map(t => t.tradeId)).toEqual(['trade-new', 'trade-old']);
  });

  it('adds actual base amount to virtual trades', async () => {
    await VirtualTrade.create({
      tradeId: 'trade-base-amount-1',
      virtualOrderId: 'open-1',
      exchangeInstanceId: 'virtual-a',
      symbol: 'BTC_USDT',
      side: 'buy',
      price: '65000',
      amount: '100',
      role: 'taker',
      realizedPnl: '0',
      executedAt: new Date('2026-05-04T01:00:00.000Z'),
    });

    const trades = await listVirtualTrades({ exchangeInstanceId: 'virtual-a' });

    expect((trades[0] as any).baseAmount).toBe('0.01');
    expect((trades[0] as any).baseCurrency).toBe('BTC');
  });

  it('computes P&L for closed orders using realizedPnl', async () => {
    const strategy = await Strategy.create({
      symbol: 'SOL_USDT',
      side: 'buy',
      source: 'route-a',
      parserName: 'DefaultParser',
    });

    await Order.create({
      strategyId: strategy.id,
      exchangeOrderId: 'closed-1',
      exchangeInstanceId: 'virtual-a',
      source: 'route-a',
      exchange: 'virtual_gate',
      symbol: 'SOL_USDT',
      side: 'buy',
      amount: '1',
      price: '100',
      filledPrice: '100',
      filledAmount: '1',
      status: 'closed',
      lifecycleStatus: 'CLOSED',
      realizedPnl: '50',
    });

    const orders = await listVirtualBusinessOrders({});
    expect(orders).toHaveLength(1);
    expect(orders[0].pnlAmount).toBe('50');
    expect(orders[0].pnlPercent).toBeCloseTo(50, 0);
  });

  it('computes closed order P&L from realizedPnl when filled fields are missing', async () => {
    const strategy = await Strategy.create({
      symbol: 'SOL_USDT',
      side: 'buy',
      source: 'route-a',
      parserName: 'DefaultParser',
    });

    await Order.create({
      strategyId: strategy.id,
      exchangeOrderId: 'closed-no-fill-1',
      exchangeInstanceId: 'virtual-a',
      source: 'route-a',
      exchange: 'virtual_gate',
      symbol: 'SOL_USDT',
      side: 'buy',
      amount: '1',
      price: '100',
      status: 'closed',
      lifecycleStatus: 'CLOSED',
      realizedPnl: '25',
    });

    const orders = await listVirtualBusinessOrders({});
    expect(orders).toHaveLength(1);
    expect(orders[0].pnlAmount).toBe('25');
    expect(orders[0].pnlPercent).toBeCloseTo(25, 0);
  });

  it('computes unrealized P&L for open buy orders', async () => {
    const strategy = await Strategy.create({
      symbol: 'SOL_USDT',
      side: 'buy',
      source: 'route-a',
      parserName: 'DefaultParser',
    });

    await Order.create({
      strategyId: strategy.id,
      exchangeOrderId: 'open-buy-1',
      exchangeInstanceId: 'virtual-a',
      source: 'route-a',
      exchange: 'virtual_gate',
      symbol: 'SOL_USDT',
      side: 'buy',
      amount: '2',
      price: '100',
      filledPrice: '100',
      filledAmount: '2',
      status: 'open',
      lifecycleStatus: 'OPEN',
    });

    await VirtualPosition.create({
      exchangeInstanceId: 'virtual-a',
      symbol: 'SOL_USDT',
      size: '2',
      entryPrice: '100',
      markPrice: '110',
      realizedPnl: '0',
      leverage: '1',
      marginType: 'cross',
    });

    const orders = await listVirtualBusinessOrders({});
    expect(orders).toHaveLength(1);
    expect(orders[0].pnlAmount).toBe('20');
    expect(orders[0].pnlPercent).toBeCloseTo(10, 0);
  });

  it('computes unrealized P&L with the contract multiplier', async () => {
    const strategy = await Strategy.create({
      symbol: 'BTC_USDT',
      side: 'buy',
      source: 'route-a',
      parserName: 'DefaultParser',
    });

    await Order.create({
      strategyId: strategy.id,
      exchangeOrderId: 'open-buy-contracts-1',
      exchangeInstanceId: 'virtual-a',
      source: 'route-a',
      exchange: 'virtual_gate',
      symbol: 'BTC_USDT',
      side: 'buy',
      amount: '100',
      price: '65000',
      filledPrice: '65000',
      filledAmount: '100',
      leverage: '10',
      status: 'open',
      lifecycleStatus: 'OPEN',
    });

    await VirtualPosition.create({
      exchangeInstanceId: 'virtual-a',
      symbol: 'BTC_USDT',
      size: '100',
      entryPrice: '65000',
      markPrice: '66000',
      realizedPnl: '0',
      leverage: '1',
      marginType: 'cross',
    });

    const orders = await listVirtualBusinessOrders({});
    expect(orders).toHaveLength(1);
    expect(orders[0].pnlAmount).toBe('10');
    expect(orders[0].pnlPercent).toBeCloseTo(15.3846, 4);
  });

  it('computes closed order P&L percent with the contract multiplier', async () => {
    const strategy = await Strategy.create({
      symbol: 'BTC_USDT',
      side: 'buy',
      source: 'route-a',
      parserName: 'DefaultParser',
    });

    await Order.create({
      strategyId: strategy.id,
      exchangeOrderId: 'closed-contracts-1',
      exchangeInstanceId: 'virtual-a',
      source: 'route-a',
      exchange: 'virtual_gate',
      symbol: 'BTC_USDT',
      side: 'buy',
      amount: '100',
      price: '65000',
      filledPrice: '65000',
      filledAmount: '100',
      status: 'closed',
      lifecycleStatus: 'CLOSED',
      realizedPnl: '10',
      leverage: '10',
    });

    const orders = await listVirtualBusinessOrders({});
    expect(orders).toHaveLength(1);
    expect(orders[0].pnlAmount).toBe('10');
    expect(orders[0].pnlPercent).toBeCloseTo(15.3846, 4);
  });

  it('computes closed order P&L from linked virtual TP and SL trades when realizedPnl is absent', async () => {
    const strategy = await Strategy.create({
      symbol: 'SOL_USDT',
      side: 'buy',
      source: 'route-a',
      parserName: 'DefaultParser',
    });

    await Order.create({
      strategyId: strategy.id,
      exchangeOrderId: 'vo-linked-1',
      exchangeInstanceId: 'virtual-a',
      source: 'route-a',
      exchange: 'virtual_gate',
      symbol: 'SOL_USDT',
      side: 'buy',
      amount: '2',
      price: '100',
      filledPrice: '100',
      filledAmount: '2',
      status: 'closed',
      lifecycleStatus: 'CLOSED',
      createdAt: new Date('2026-05-04T01:00:00.000Z'),
      closedAt: new Date('2026-05-04T03:00:00.000Z'),
    });

    await VirtualTrade.bulkCreate([
      {
        tradeId: 'linked-tp',
        virtualOrderId: 'tp-1',
        exchangeInstanceId: 'virtual-a',
        symbol: 'SOL_USDT',
        side: 'sell',
        price: '110',
        amount: '1',
        role: 'maker',
        realizedPnl: '10',
        text: 't-tp-1-vo-linked-1',
        executedAt: new Date('2026-05-04T02:00:00.000Z'),
      },
      {
        tradeId: 'linked-sl',
        virtualOrderId: 'sl-1',
        exchangeInstanceId: 'virtual-a',
        symbol: 'SOL_USDT',
        side: 'sell',
        price: '95',
        amount: '1',
        role: 'taker',
        realizedPnl: '-5',
        text: 't-sl-vo-linked-1',
        executedAt: new Date('2026-05-04T02:10:00.000Z'),
      },
      {
        tradeId: 'other-tp',
        virtualOrderId: 'tp-2',
        exchangeInstanceId: 'virtual-a',
        symbol: 'SOL_USDT',
        side: 'sell',
        price: '130',
        amount: '1',
        role: 'maker',
        realizedPnl: '30',
        text: 't-tp-1-vo-other',
        executedAt: new Date('2026-05-04T02:20:00.000Z'),
      },
    ]);

    const orders = await listVirtualBusinessOrders({});

    expect(orders[0].pnlAmount).toBe('5');
    expect(orders[0].pnlPercent).toBeCloseTo(2.5, 4);
  });

  it('computes unrealized P&L for open sell orders', async () => {
    const strategy = await Strategy.create({
      symbol: 'SOL_USDT',
      side: 'sell',
      source: 'route-a',
      parserName: 'DefaultParser',
    });

    await Order.create({
      strategyId: strategy.id,
      exchangeOrderId: 'open-sell-1',
      exchangeInstanceId: 'virtual-a',
      source: 'route-a',
      exchange: 'virtual_gate',
      symbol: 'SOL_USDT',
      side: 'sell',
      amount: '1',
      price: '200',
      filledPrice: '200',
      filledAmount: '1',
      status: 'open',
      lifecycleStatus: 'OPEN',
    });

    await VirtualPosition.create({
      exchangeInstanceId: 'virtual-a',
      symbol: 'SOL_USDT',
      size: '-1',
      entryPrice: '200',
      markPrice: '180',
      realizedPnl: '0',
      leverage: '1',
      marginType: 'cross',
    });

    const orders = await listVirtualBusinessOrders({});
    expect(orders).toHaveLength(1);
    expect(orders[0].pnlAmount).toBe('20');
    expect(orders[0].pnlPercent).toBeCloseTo(10, 0);
  });

  it('returns null P&L when filledPrice or filledAmount is missing', async () => {
    const strategy = await Strategy.create({
      symbol: 'BTC_USDT',
      side: 'buy',
      source: 'route-a',
      parserName: 'DefaultParser',
    });

    await Order.create({
      strategyId: strategy.id,
      exchangeOrderId: 'no-fill-1',
      exchangeInstanceId: 'virtual-a',
      source: 'route-a',
      exchange: 'virtual_gate',
      symbol: 'BTC_USDT',
      side: 'buy',
      amount: '1',
      price: '100',
      status: 'open',
      lifecycleStatus: 'OPEN',
    });

    const orders = await listVirtualBusinessOrders({});
    expect(orders).toHaveLength(1);
    expect(orders[0].pnlAmount).toBeNull();
    expect(orders[0].pnlPercent).toBeNull();
  });
});
