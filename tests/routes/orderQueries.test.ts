import { sequelize, ExchangeInstance, Order, Strategy } from '../../src/models';
import { listFormalOrders } from '../../src/routes/orderQueries';
import { listVirtualBusinessOrders } from '../../src/routes/virtualExchange';

describe('formal order route helpers', () => {
  beforeEach(async () => {
    await sequelize.sync({ force: true });

    await ExchangeInstance.bulkCreate([
      { id: 'real-gate', type: 'gate', name: 'Real Gate', config: '{}', status: 'active' },
      { id: 'real-lighter', type: 'lighter', name: 'Real Lighter', config: '{}', status: 'active' },
      { id: 'virtual-a', type: 'virtual_gate', name: 'Virtual A', config: '{}', status: 'active' },
    ]);
  });

  afterAll(async () => {
    await sequelize.close();
  });

  async function seedOrders() {
    const strategy = await Strategy.create({
      rawMessage: '{"test": true}',
      action: 'open',
      symbol: 'BTC_USDT',
      side: 'buy',
      source: 'route-a',
      parserName: 'DefaultParser',
      status: 'processed',
      routes: '[]',
      riskMultiplier: 1.0,
    });

    await Order.bulkCreate([
      {
        strategyId: strategy.id,
        exchangeOrderId: 'real-gate-1',
        exchangeInstanceId: 'real-gate',
        source: 'route-a',
        exchange: 'gate',
        symbol: 'BTC_USDT',
        side: 'buy',
        amount: '1',
        price: '100',
        status: 'filled',
        lifecycleStatus: 'CLOSED',
      },
      {
        strategyId: strategy.id,
        exchangeOrderId: 'real-lighter-1',
        exchangeInstanceId: 'real-lighter',
        source: 'route-a',
        exchange: 'lighter',
        symbol: 'ETH_USDT',
        side: 'sell',
        amount: '2',
        price: '200',
        status: 'filled',
        lifecycleStatus: 'CLOSED',
      },
      {
        strategyId: strategy.id,
        exchangeOrderId: 'virtual-a-1',
        exchangeInstanceId: 'virtual-a',
        source: 'route-a',
        exchange: 'virtual_gate',
        symbol: 'BTC_USDT',
        side: 'buy',
        amount: '3',
        price: '300',
        status: 'open',
        lifecycleStatus: 'OPEN',
      },
      {
        strategyId: strategy.id,
        exchangeOrderId: 'legacy-null-1',
        exchangeInstanceId: null,
        source: 'route-a',
        exchange: 'legacy',
        symbol: 'BTC_USDT',
        side: 'buy',
        amount: '4',
        price: '400',
        status: 'filled',
        lifecycleStatus: 'CLOSED',
      },
    ]);
  }

  it('lists formal orders without virtual_gate business orders and preserves null exchangeInstanceId orders', async () => {
    await seedOrders();

    const orders = await listFormalOrders({ limit: 50 });

    expect(orders.map((order: any) => order.exchangeOrderId)).toEqual(['legacy-null-1', 'real-lighter-1', 'real-gate-1']);
    expect(orders.every((order: any) => order.exchangeInstanceId !== 'virtual-a')).toBe(true);
  });

  it('uses the same exclusion behavior for history limit queries', async () => {
    await seedOrders();

    const orders = await listFormalOrders({ limit: 50 });

    expect(orders).toHaveLength(3);
    expect(orders.map((order: any) => order.exchangeInstanceId)).toEqual([null, 'real-lighter', 'real-gate']);
  });

  it('returns matching formal orders when filtering by a real exchange id', async () => {
    await seedOrders();

    const orders = await listFormalOrders({ limit: 50, exchange: 'real-gate' });

    expect(orders.map((order: any) => order.exchangeOrderId)).toEqual(['real-gate-1']);
  });

  it('preserves symbol source and parser filters for formal orders', async () => {
    await seedOrders();

    const orders = await listFormalOrders({
      limit: 50,
      symbol: 'BTC_USDT',
      source: 'route-a',
      parser: 'DefaultParser',
    });

    expect(orders.map((order: any) => order.exchangeOrderId)).toEqual(['legacy-null-1', 'real-gate-1']);
  });

  it('applies the requested limit to formal orders', async () => {
    await seedOrders();

    const orders = await listFormalOrders({ limit: 1 });

    expect(orders.map((order: any) => order.exchangeOrderId)).toEqual(['legacy-null-1']);
  });

  it('returns no formal orders when filtering by a virtual exchange id', async () => {
    await seedOrders();

    const orders = await listFormalOrders({ limit: 50, exchange: 'virtual-a' });

    expect(orders).toEqual([]);
  });

  it('still lets the dedicated virtual exchange helper return virtual business orders', async () => {
    await seedOrders();

    const orders = await listVirtualBusinessOrders({ exchangeInstanceId: 'virtual-a' });

    expect(orders.map((order: any) => order.exchangeOrderId)).toEqual(['virtual-a-1']);
    expect(orders.every((order: any) => order.exchangeInstanceId === 'virtual-a')).toBe(true);
  });
});
