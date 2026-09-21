// tests/services/CloseScopeResolver.test.ts
import { CloseScopeResolver } from '../../src/services/CloseScopeResolver';
import { ParsedStrategy } from '../../src/services/parsers/types';

// Mock models
jest.mock('../../src/models', () => ({
  Order: {
    findAll: jest.fn(),
  },
  Strategy: {
    findAll: jest.fn(),
  },
}));

describe('CloseScopeResolver', () => {
  const { Order, Strategy } = require('../../src/models');

  beforeEach(() => { jest.clearAllMocks(); });

  const makeOrder = (id: number, strategyId: number, side = 'buy', source = 'discord:1', routeId?: number, exchangeInstanceId?: string) => ({
    id, strategyId, side, source, routeId, exchangeInstanceId,
    lifecycleStatus: 'PROTECTED',
    exchangeOrderId: `ex-${id}`, symbol: 'BTC_USDT',
    createdAt: new Date(),
    closedAt: null,
  });

  const makeClosedOrder = (id: number, strategyId: number, side = 'buy', source = 'discord:1', routeId?: number, exchangeInstanceId?: string) => ({
    ...makeOrder(id, strategyId, side, source, routeId, exchangeInstanceId),
    lifecycleStatus: 'CLOSED',
    closedAt: new Date(),
  });

  it('按 orderId 精确匹配', async () => {
    const order = makeOrder(5, 1);
    Order.findAll.mockResolvedValue([order]);
    const resolver = new CloseScopeResolver();
    const result = await resolver.resolve({
      parsed: { action: 'close', symbol: 'BTC_USDT', orderId: '5', raw: {} } as ParsedStrategy,
      strategyId: undefined, exchangeInstanceId: undefined, targetPositionSide: undefined,
    });
    expect(result.scopedOrders).toHaveLength(1);
    expect(result.scopeMode).toBe('order-id');
  });

  it('按 strategyId 匹配多条', async () => {
    const orders = [makeOrder(1, 5), makeOrder(2, 5), makeOrder(3, 5)];
    Order.findAll.mockResolvedValue(orders);
    const resolver = new CloseScopeResolver();
    const result = await resolver.resolve({
      parsed: { action: 'close', symbol: 'BTC_USDT', raw: {} } as ParsedStrategy,
      strategyId: 5, exchangeInstanceId: undefined, targetPositionSide: undefined,
    });
    expect(result.scopedOrders).toHaveLength(3);
    expect(result.scopeMode).toBe('strategy-id');
  });

  it('无匹配时 fallback 到最新一条', async () => {
    // Return orders in createdAt DESC order so allActive[0] is the latest
    const orders = [
      { ...makeOrder(2, 2), createdAt: new Date('2024-01-03') },
      { ...makeOrder(1, 1), createdAt: new Date('2024-01-01') },
    ];
    Order.findAll.mockResolvedValue(orders);
    const resolver = new CloseScopeResolver();
    const result = await resolver.resolve({
      parsed: { action: 'close', symbol: 'BTC_USDT', raw: {} } as ParsedStrategy,
      strategyId: undefined, exchangeInstanceId: undefined, targetPositionSide: undefined,
    });
    expect(result.scopedOrders).toHaveLength(1);
    expect(result.scopeMode).toBe('fallback-latest-order');
    expect(result.scopedOrders[0].id).toBe(2);
  });

  it('完全无订单返回空数组', async () => {
    Order.findAll.mockResolvedValue([]);
    const resolver = new CloseScopeResolver();
    const result = await resolver.resolve({
      parsed: { action: 'close', symbol: 'BTC_USDT', raw: {} } as ParsedStrategy,
      strategyId: undefined, exchangeInstanceId: undefined, targetPositionSide: undefined,
    });
    expect(result.scopedOrders).toHaveLength(0);
  });

  describe('strategyId widening', () => {
    it('strategyId 匹配不到时 widening 到 routeId', async () => {
      // First call: no OPEN/PROTECTED orders match strategyId=3717
      // But there is an active order with routeId=11
      const activeOrder = makeOrder(1886, 3711, 'sell', 'discord:1', 11, 'gate_main');
      Order.findAll.mockResolvedValueOnce([activeOrder]); // OPEN/PROTECTED query
      const resolver = new CloseScopeResolver();
      const result = await resolver.resolve({
        parsed: { action: 'close', symbol: 'BTC_USDT', side: 'sell', raw: { routeId: 11 } } as ParsedStrategy,
        strategyId: 3717, exchangeInstanceId: 'gate_main', targetPositionSide: 'sell',
      });
      expect(result.scopedOrders).toHaveLength(1);
      expect(result.scopedOrders[0].id).toBe(1886);
      expect(result.scopeMode).toBe('strategy-id-widened');
    });

    it('strategyId 匹配不到时 widening 到 source', async () => {
      const activeOrder = makeOrder(1886, 3711, 'sell', 'discord:100000000000000001');
      Order.findAll.mockResolvedValueOnce([activeOrder]); // OPEN/PROTECTED query
      const resolver = new CloseScopeResolver();
      const result = await resolver.resolve({
        parsed: { action: 'close', symbol: 'BTC_USDT', side: 'sell', raw: { source: 'discord:100000000000000001' } } as ParsedStrategy,
        strategyId: 3717, exchangeInstanceId: 'gate_main', targetPositionSide: 'sell',
      });
      expect(result.scopedOrders).toHaveLength(1);
      expect(result.scopeMode).toBe('strategy-id-widened');
    });

    it('strategyId 匹配不到时 widening 到 exchangeInstanceId', async () => {
      const activeOrder = makeOrder(1886, 3711, 'sell', 'discord:1', undefined, 'gate_main');
      Order.findAll.mockResolvedValueOnce([activeOrder]); // OPEN/PROTECTED query
      const resolver = new CloseScopeResolver();
      const result = await resolver.resolve({
        parsed: { action: 'close', symbol: 'BTC_USDT', side: 'sell', raw: {} } as ParsedStrategy,
        strategyId: 3717, exchangeInstanceId: 'gate_main', targetPositionSide: 'sell',
      });
      expect(result.scopedOrders).toHaveLength(1);
      expect(result.scopeMode).toBe('strategy-id-widened');
    });
  });

  describe('recently-closed fallback', () => {
    it('当无 OPEN/PROTECTED 订单时，查找最近 CLOSED 的订单（source 匹配）', async () => {
      const closedOrder = makeClosedOrder(1886, 3711, 'sell', 'discord:100000000000000001', 11, 'gate_main');
      // First call: OPEN/PROTECTED returns empty
      Order.findAll.mockResolvedValueOnce([]);
      // Second call: CLOSED orders query
      Order.findAll.mockResolvedValueOnce([closedOrder]);
      const resolver = new CloseScopeResolver();
      const result = await resolver.resolve({
        parsed: { action: 'close', symbol: 'BTC_USDT', side: 'sell', raw: { source: 'discord:100000000000000001' } } as ParsedStrategy,
        strategyId: 3717, exchangeInstanceId: 'gate_main', targetPositionSide: 'sell',
      });
      expect(result.scopedOrders).toHaveLength(1);
      expect(result.scopedOrders[0].id).toBe(1886);
      expect(result.scopeMode).toBe('recently-closed');
    });

    it('当无 OPEN/PROTECTED 订单时，查找最近 CLOSED 的订单（routeId 匹配）', async () => {
      const closedOrder = makeClosedOrder(1886, 3711, 'sell', 'discord:1', 11, 'gate_main');
      Order.findAll.mockResolvedValueOnce([]); // OPEN/PROTECTED empty
      Order.findAll.mockResolvedValueOnce([closedOrder]); // CLOSED query
      const resolver = new CloseScopeResolver();
      const result = await resolver.resolve({
        parsed: { action: 'close', symbol: 'BTC_USDT', side: 'sell', raw: { routeId: 11 } } as ParsedStrategy,
        strategyId: 3717, exchangeInstanceId: 'gate_main', targetPositionSide: 'sell',
      });
      expect(result.scopedOrders).toHaveLength(1);
      expect(result.scopeMode).toBe('recently-closed');
    });

    it('CLOSED 订单超过 30 分钟不计入', async () => {
      // CLOSED query returns empty (old closed orders filtered by DB query)
      Order.findAll.mockResolvedValueOnce([]); // OPEN/PROTECTED empty
      Order.findAll.mockResolvedValueOnce([]); // CLOSED query also empty
      const resolver = new CloseScopeResolver();
      const result = await resolver.resolve({
        parsed: { action: 'close', symbol: 'BTC_USDT', side: 'sell', raw: { source: 'discord:1' } } as ParsedStrategy,
        strategyId: 3717, exchangeInstanceId: 'gate_main', targetPositionSide: 'sell',
      });
      expect(result.scopedOrders).toHaveLength(0);
    });
  });
});
