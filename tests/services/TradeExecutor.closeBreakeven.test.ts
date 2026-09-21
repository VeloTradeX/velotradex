import tradeExecutor from '../../src/services/TradeExecutor';
import exchangeRegistry from '../../src/services/exchanges';
import { Order, StrategyPosition } from '../../src/models';

jest.mock('../../src/services/exchanges', () => ({
  __esModule: true,
  default: { getExchange: jest.fn(), getAllExchanges: jest.fn(), exchanges: new Map() },
}));

jest.mock('../../src/services/AuditService', () => ({
  __esModule: true,
  default: { log: jest.fn() },
}));

const mockCancelProtections = jest.fn().mockResolvedValue(undefined);
const mockCancelTpOrders = jest.fn().mockResolvedValue(undefined);

jest.mock('../../src/services/ProtectionManager', () => ({
  ProtectionManager: jest.fn().mockImplementation(() => ({
    cancelProtections: mockCancelProtections,
    cancelTpOrders: mockCancelTpOrders,
    placeStopLoss: jest.fn().mockResolvedValue('sl-1'),
    checkBreakeven: jest.fn(),
  })),
}));

jest.mock('../../src/services/NoStopLossMonitor', () => ({
  NoStopLossMonitor: jest.fn().mockImplementation(() => ({
    start: jest.fn(),
    stop: jest.fn(),
    watchOrder: jest.fn(),
  })),
}));

jest.mock('../../src/models', () => ({
  Order: { create: jest.fn(), findAll: jest.fn() },
  Strategy: { findByPk: jest.fn() },
  StrategyPosition: { findOne: jest.fn(), create: jest.fn(), findAll: jest.fn() },
  AuditLog: { create: jest.fn() },
  PendingProtection: { create: jest.fn(), findByPk: jest.fn() },
  SoftStopLoss: { create: jest.fn() },
  sequelize: { transaction: jest.fn((fn: any) => fn({})) },
}));

describe('TradeExecutor handleClose – TP breakeven', () => {
  const exchange = {
    getPositions: jest.fn(),
    getMarkets: jest.fn(),
    getOpenOrders: jest.fn(),
    getPriceOrders: jest.fn(),
    closePosition: jest.fn(),
    getPosition: jest.fn(),
    getTicker: jest.fn(),
    cancelOrder: jest.fn(),
    cancelPriceOrder: jest.fn(),
    updateStopLoss: jest.fn(),
  };

  const activeOrder = {
    id: 10,
    strategyId: 50,
    routeId: 5,
    exchangeOrderId: 'ex-123',
    exchangeInstanceId: 'gate_1',
    source: 'raizexbt',
    symbol: 'BTC_USDT',
    side: 'buy',
    amount: '100',
    filledAmount: '100',
    filledPrice: '65000',
    status: 'open',
    lifecycleStatus: 'OPEN',
    save: jest.fn(),
    update: jest.fn().mockImplementation(async function(this: any, payload: any) {
      Object.assign(this, payload);
      return this;
    }),
  };

  const activePosition = {
    id: 1,
    strategyId: 50,
    orderId: 10,
    routeId: 5,
    exchangeInstanceId: 'gate_1',
    symbol: 'BTC_USDT',
    side: 'buy',
    totalSize: '100',
    remainingSize: '100',
    source: 'raizexbt',
    parserName: 'RaizexbtParser',
    status: 'OPEN',
    save: jest.fn(),
    update: jest.fn().mockImplementation(async function(this: any, payload: any) {
      Object.assign(this, payload);
      return this;
    }),
  };

  beforeEach(() => {
    jest.clearAllMocks();

    Object.assign(activeOrder, {
      status: 'open',
      lifecycleStatus: 'OPEN',
      lastPrice: undefined,
      closedAt: undefined,
    });
    Object.assign(activePosition, {
      remainingSize: '100',
      status: 'OPEN',
      closedAt: undefined,
    });

    (exchangeRegistry.getExchange as jest.Mock).mockReturnValue(exchange);

    exchange.getPositions.mockResolvedValue([
      { symbol: 'BTC_USDT', size: '100', entryPrice: '65000', markPrice: '66000' },
    ]);
    exchange.getPosition.mockResolvedValue(
      { symbol: 'BTC_USDT', size: '50', entryPrice: '65000', markPrice: '66000' },
    );
    exchange.getMarkets.mockResolvedValue([
      { symbol: 'BTC_USDT', amountPrecision: 0, pricePrecision: 1 },
    ]);
    exchange.getOpenOrders.mockResolvedValue([]);
    exchange.getPriceOrders.mockResolvedValue([]);
    exchange.closePosition.mockResolvedValue(true);

    (Order.findAll as jest.Mock).mockResolvedValue([activeOrder]);
    (StrategyPosition.findOne as jest.Mock).mockResolvedValue(activePosition);
    (StrategyPosition.findAll as jest.Mock).mockResolvedValue([activePosition]);
    (StrategyPosition.create as jest.Mock).mockResolvedValue(activePosition);
  });

  it('TP1 close: uses TP-prefixed order text and skips protection cancellation', async () => {
    const parsed = {
      action: 'close' as const,
      symbol: 'BTC_USDT',
      side: 'buy' as const,
      raw: { content: 'Tp1' },
    };

    const result = await (tradeExecutor as any).handleClose(
      parsed, 'raizexbt', { tpDistribution: [0.5, 0.3, 0.2] }, 50, undefined, 'gate_1',
    );

    expect(result).toEqual(expect.objectContaining({ status: 'filled' }));

    // closePosition should be called with TP-prefixed text
    expect(exchange.closePosition).toHaveBeenCalledWith(
      'BTC_USDT', 'sell', undefined, expect.any(String),
      't-tp-1-ord-ex-123',
    );

    // Protection cancellation should be skipped entirely
    expect(mockCancelProtections).not.toHaveBeenCalled();
    expect(mockCancelTpOrders).not.toHaveBeenCalled();
  });

  it('non-TP close: uses default text and cancels all protections', async () => {
    const parsed = {
      action: 'close' as const,
      symbol: 'BTC_USDT',
      side: 'buy' as const,
      closePercentage: 100,
      raw: { content: 'Close all' },
    };

    const result = await (tradeExecutor as any).handleClose(
      parsed, 'raizexbt', { tpDistribution: [0.5, 0.3, 0.2] }, 50, undefined, 'gate_1',
    );

    expect(result).toEqual(expect.objectContaining({ status: 'filled' }));

    // closePosition should use default close text
    expect(exchange.closePosition).toHaveBeenCalledWith(
      'BTC_USDT', 'sell', undefined, expect.any(String),
      undefined,
    );

    // All protections should be cancelled
    expect(mockCancelProtections).toHaveBeenCalledWith('BTC_USDT', 'buy', 'ex-123');
  });

  it('TP1 close: calculates 50% close amount via tpDistribution', async () => {
    const parsed = {
      action: 'close' as const,
      symbol: 'BTC_USDT',
      side: 'buy' as const,
      raw: { content: 'Tp1' },
    };

    await (tradeExecutor as any).handleClose(
      parsed, 'raizexbt', { tpDistribution: [0.5, 0.3, 0.2] }, 50, undefined, 'gate_1',
    );

    // 100 * 0.5 = 50
    expect(exchange.closePosition).toHaveBeenCalledWith(
      'BTC_USDT', 'sell', undefined, '50',
      expect.any(String),
    );
  });

  it('TP2 close: uses TP index 2 in order text and closes 30%', async () => {
    const parsed = {
      action: 'close' as const,
      symbol: 'BTC_USDT',
      side: 'buy' as const,
      raw: { content: 'Tp2' },
    };

    await (tradeExecutor as any).handleClose(
      parsed, 'raizexbt', { tpDistribution: [0.5, 0.3, 0.2] }, 50, undefined, 'gate_1',
    );

    expect(exchange.closePosition).toHaveBeenCalledWith(
      'BTC_USDT', 'sell', undefined, '30',
      't-tp-2-ord-ex-123',
    );
    expect(mockCancelProtections).not.toHaveBeenCalled();
  });
});
