// tests/services/ClosePositionService.keepPartialProtections.test.ts
//
// Focused unit tests for ClosePositionService's partially-close protection
// retention (parsed.keepPartialProtections). Uses a mocked CloseScopeResolver
// so only the close pipeline itself is exercised.
import { ClosePositionService } from '../../src/services/executor/ClosePositionService';

const mockResolve = jest.fn();

jest.mock('../../src/services/CloseScopeResolver', () => ({
  CloseScopeResolver: jest.fn().mockImplementation(() => ({ resolve: mockResolve })),
}));

jest.mock('../../src/models', () => ({
  Order: {},
  StrategyPosition: { findAll: jest.fn().mockResolvedValue([]) },
  AuditLog: { create: jest.fn().mockResolvedValue(undefined) },
  sequelize: { transaction: jest.fn((fn: any) => fn({})) },
}));

describe('ClosePositionService — keepPartialProtections', () => {
  let service: ClosePositionService;
  let exchange: any;
  let protectionsManager: { cancelProtections: jest.Mock };
  let protectionPipeline: { cancelProtections: jest.Mock };
  let services: any;
  let scopedOrder: any;

  function makeScopedOrder() {
    return {
      id: 10,
      strategyId: 50,
      routeId: 5,
      exchangeOrderId: 'ex-10',
      exchangeInstanceId: 'gate_1',
      symbol: 'BTC_USDT',
      side: 'buy',
      amount: '100',
      price: '65000',
      filledPrice: '65000',
      filledAmount: '100',
      initialSl: '64000',
      status: 'open',
      lifecycleStatus: 'OPEN',
      lastPrice: null,
      save: jest.fn().mockResolvedValue(undefined),
      update: jest.fn().mockResolvedValue(undefined),
    };
  }

  function mockPosition(size: string) {
    exchange.getPositions.mockResolvedValue([
      {
        symbol: 'BTC_USDT',
        size,
        entryPrice: '65000',
        markPrice: '64000',
        unrealizedPnl: '-100',
        leverage: '10',
        marginType: 'cross',
      },
    ]);
  }

  beforeEach(() => {
    scopedOrder = makeScopedOrder();

    exchange = {
      getOpenOrders: jest.fn().mockResolvedValue([]),
      getPriceOrders: jest.fn().mockResolvedValue([]),
      cancelOrder: jest.fn().mockResolvedValue(true),
      cancelPriceOrder: jest.fn().mockResolvedValue(true),
      getPositions: jest.fn(),
      getMarkets: jest.fn().mockResolvedValue([
        { symbol: 'BTC_USDT', amountPrecision: 1, pricePrecision: 1 },
      ]),
      getPosition: jest.fn().mockResolvedValue({ symbol: 'BTC_USDT', size: '50' }),
      closePosition: jest.fn().mockResolvedValue(true),
      getTradeHistory: jest.fn().mockResolvedValue([]),
      getTicker: jest.fn().mockResolvedValue({ symbol: 'BTC_USDT', lastPrice: '64000' }),
      updateStopLoss: jest.fn(),
    };
    mockPosition('100');

    protectionsManager = { cancelProtections: jest.fn().mockResolvedValue(undefined) };
    protectionPipeline = { cancelProtections: jest.fn().mockResolvedValue(undefined) };

    const orderPersistenceHandler = {
      upsertStrategyPositionFromOrder: jest.fn().mockResolvedValue({
        remainingSize: '100',
        status: 'OPEN',
        update: jest.fn().mockResolvedValue(undefined),
      }),
      getOrderTrackedAmount: jest.fn(() => 100),
    };

    services = {
      exchangeRegistry: { getExchange: jest.fn(() => exchange) },
      auditService: { log: jest.fn().mockResolvedValue(undefined) },
      orderPersistenceHandler,
      tradingStatsService: { recordOrderStats: jest.fn().mockResolvedValue(undefined) },
      protectionContext: {
        getProtectionManager: jest.fn(() => protectionsManager),
        getProtectionPipeline: jest.fn(() => protectionPipeline),
      },
    };

    service = new ClosePositionService(services, { protectionQtyEpsilon: 1e-8 } as any);

    mockResolve.mockResolvedValue({
      scopedOrders: [scopedOrder],
      scopeOrderIds: [10],
      scopeStrategyIds: [50],
      expectedPositionSide: 'buy',
      scopeMode: 'strategy-id',
    });
  });

  it('partial close with keepPartialProtections=true keeps SL/TP protections', async () => {
    const result = await service.handleClose(
      {
        action: 'close',
        symbol: 'BTC_USDT',
        side: 'buy',
        closePercentage: 50,
        keepPartialProtections: true,
        raw: {},
      },
      'unit-test',
      undefined,
      50,
      'buy',
      'gate_1',
    );

    expect(result).toEqual(expect.objectContaining({ id: 'close-pos', status: 'filled' }));
    // Half of the 100-contract position was closed at market.
    expect(exchange.closePosition).toHaveBeenCalledWith(
      'BTC_USDT',
      'sell',
      undefined,
      '50.0',
      undefined,
    );
    // Protections are intentionally NOT cancelled so the remaining 50 stays protected.
    expect(protectionsManager.cancelProtections).not.toHaveBeenCalled();
    expect(protectionPipeline.cancelProtections).not.toHaveBeenCalled();
  });

  it('partial close WITHOUT the flag still cancels per-order protections (legacy behavior)', async () => {
    await service.handleClose(
      {
        action: 'close',
        symbol: 'BTC_USDT',
        side: 'buy',
        closePercentage: 50,
        raw: {},
      },
      'unit-test',
      undefined,
      50,
      'buy',
      'gate_1',
    );

    expect(protectionsManager.cancelProtections).toHaveBeenCalledTimes(1);
    expect(protectionsManager.cancelProtections).toHaveBeenCalledWith(
      'BTC_USDT',
      'buy',
      'ex-10',
    );
  });

  it('full close with keepPartialProtections=true still cancels protections (no remaining position)', async () => {
    exchange.getPosition.mockResolvedValue({ symbol: 'BTC_USDT', size: '0' });

    await service.handleClose(
      {
        action: 'close',
        symbol: 'BTC_USDT',
        side: 'buy',
        closePercentage: 100,
        keepPartialProtections: true,
        raw: {},
      },
      'unit-test',
      undefined,
      50,
      'buy',
      'gate_1',
    );

    expect(protectionsManager.cancelProtections).toHaveBeenCalledTimes(1);
    expect(protectionPipeline.cancelProtections).toHaveBeenCalledTimes(1);
  });
});
