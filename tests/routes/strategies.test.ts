import { sequelize, Strategy, Order, AuditLog } from '../../src/models';
import { getStrategyDetails, listStrategies } from '../../src/routes/index';

describe('strategies routes', () => {
  beforeEach(async () => {
    await sequelize.sync({ force: true });
  });

  afterAll(async () => {
    await sequelize.close();
  });

  describe('getStrategyDetails', () => {
    it('should return null for non-existent strategy', async () => {
      const result = await getStrategyDetails('99999');
      expect(result).toBeNull();
    });

    it('should return strategy with orders and auditLogs', async () => {
      const strategy = await Strategy.create({
        rawMessage: '{"test": true}',
        action: 'open',
        symbol: 'BTC_USDT',
        side: 'long',
        source: 'test',
        parserName: 'TestParser',
        status: 'processed',
        routes: '[]',
        riskMultiplier: 1.0,
      });

      await Order.create({
        strategyId: strategy.id,
        exchangeOrderId: 'order-1',
        exchangeInstanceId: 'exchange-1',
        symbol: 'BTC_USDT',
        side: 'buy',
        amount: '0.1',
        price: '50000',
        status: 'filled',
        lifecycleStatus: 'CLOSED',
        type: 'limit',
        leverage: '10',
        realizedPnl: '100',
        closePrice: '51000',
        lastPrice: '51000',
      });

      await AuditLog.create({
        strategyId: strategy.id,
        action: 'STRATEGY_DETECTED',
        details: '{"parser": "TestParser"}',
        lifecycleStatus: 'INIT',
      });

      await AuditLog.create({
        strategyId: strategy.id,
        action: 'ROUTE_EXECUTED',
        orderId: 1,
        routeId: 1,
        exchangeInstanceId: 'exchange-1',
        details: '{"status": "filled"}',
        lifecycleStatus: 'OPEN',
      });

      const result = await getStrategyDetails(String(strategy.id));

      expect(result).not.toBeNull();
      expect(result!.strategy).toHaveProperty('id', strategy.id);
      expect(result!.strategy).toHaveProperty('rawMessage');
      expect(result!.strategy).toHaveProperty('action', 'open');
      expect(result!.strategy).not.toHaveProperty('Orders');
      expect(result!.strategy).not.toHaveProperty('AuditLogs');

      expect(Array.isArray(result!.orders)).toBe(true);
      expect(result!.orders.length).toBe(1);
      expect(result!.orders[0]).toHaveProperty('id');
      expect(result!.orders[0]).toHaveProperty('exchangeOrderId', 'order-1');
      expect(result!.orders[0]).toHaveProperty('symbol', 'BTC_USDT');
      expect(result!.orders[0]).toHaveProperty('side', 'buy');
      expect(result!.orders[0]).toHaveProperty('lifecycleStatus', 'CLOSED');
      expect(result!.orders[0]).toHaveProperty('closePrice', '51000');
      expect(result!.orders[0]).toHaveProperty('lastPrice', '51000');

      expect(Array.isArray(result!.auditLogs)).toBe(true);
      expect(result!.auditLogs.length).toBe(2);
      expect(result!.auditLogs[0]).toHaveProperty('action', 'STRATEGY_DETECTED');
      expect(result!.auditLogs[1]).toHaveProperty('action', 'ROUTE_EXECUTED');
    });

    it('should return empty orders and auditLogs when strategy has none', async () => {
      const strategy = await Strategy.create({
        rawMessage: '{"test": true}',
        action: 'close',
        symbol: 'ETH_USDT',
        side: 'short',
        source: 'test',
        parserName: 'TestParser',
        status: 'filtered',
        routes: '[]',
        riskMultiplier: 1.0,
      });

      const result = await getStrategyDetails(String(strategy.id));

      expect(result).not.toBeNull();
      expect(result!.strategy.id).toBe(strategy.id);
      expect(result!.orders).toEqual([]);
      expect(result!.auditLogs).toEqual([]);
    });
  });

  describe('GET /api/strategies', () => {
    it('should include orderCount in strategy items', async () => {
      const strategy = await Strategy.create({
        rawMessage: '{"test": true}',
        action: 'open',
        symbol: 'BTC_USDT',
        side: 'long',
        source: 'test',
        parserName: 'TestParser',
        status: 'processed',
        routes: '[]',
        riskMultiplier: 1.0,
      });

      await Order.create({
        strategyId: strategy.id,
        exchangeOrderId: 'order-1',
        exchangeInstanceId: 'exchange-1',
        symbol: 'BTC_USDT',
        side: 'buy',
        amount: '0.1',
        price: '50000',
        status: 'filled',
        lifecycleStatus: 'CLOSED',
        type: 'limit',
        leverage: '10',
      });

      const strategies = await listStrategies({});
      expect(strategies.length).toBeGreaterThanOrEqual(1);
      const found = strategies.find((s: any) => s.id === strategy.id);
      expect(found).toBeDefined();
      expect(found.orderCount).toBe(1);
      expect(found).not.toHaveProperty('Orders');
    });

    it('should return orderCount 0 for strategies with no orders', async () => {
      await Strategy.create({
        rawMessage: '{"test": true}',
        action: 'close',
        symbol: 'ETH_USDT',
        side: 'short',
        source: 'test',
        parserName: 'TestParser',
        status: 'filtered',
        routes: '[]',
        riskMultiplier: 1.0,
      });

      const strategies = await listStrategies({});
      expect(strategies.length).toBeGreaterThanOrEqual(1);
      expect(strategies.every((s: any) => typeof s.orderCount === 'number')).toBe(true);
      const noOrders = strategies.find((s: any) => s.orderCount === 0);
      expect(noOrders).toBeDefined();
    });
  });
});
