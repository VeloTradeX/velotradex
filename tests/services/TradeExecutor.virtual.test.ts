import tradeExecutor from '../../src/services/TradeExecutor';
import exchangeRegistry from '../../src/services/exchanges';
import { Order, Strategy, StrategyPosition } from '../../src/models';
import { PostFillOrchestrator } from '../../src/services/PostFillOrchestrator';
import { EventEmitter } from 'events';

jest.mock('../../src/services/exchanges', () => ({
  __esModule: true,
  default: { getExchange: jest.fn(), getAllExchanges: jest.fn(), exchanges: new Map() },
}));

jest.mock('../../src/services/AuditService', () => ({
  __esModule: true,
  default: { log: jest.fn() },
}));

jest.mock('../../src/services/PostFillOrchestrator', () => ({
  PostFillOrchestrator: jest.fn().mockImplementation(() => ({
    run: jest.fn().mockResolvedValue({ slPlaced: true, tpPlaced: true }),
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
  Order: {
    create: jest.fn(),
    findAll: jest.fn(),
    update: jest.fn().mockResolvedValue([1]),
    findByPk: jest.fn(),
  },
  Strategy: { findByPk: jest.fn() },
  StrategyPosition: { findOne: jest.fn(), create: jest.fn() },
  AuditLog: {},
  PendingProtection: { create: jest.fn(), findByPk: jest.fn() },
  SoftStopLoss: { create: jest.fn() },
  sequelize: { transaction: jest.fn((fn: any) => fn({})) },
}));

describe('TradeExecutor virtual exchange route', () => {
  const exchange = {
    id: 'virtual_1',
    name: 'Virtual 1',
    getTicker: jest.fn(),
    getBalance: jest.fn(),
    getMarkets: jest.fn(),
    getPositions: jest.fn(),
    getOpenOrders: jest.fn(),
    setLeverage: jest.fn(),
    placeOrder: jest.fn(),
    waitForOrderFill: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    (exchangeRegistry.getExchange as jest.Mock).mockReturnValue(exchange);
    exchange.getTicker.mockResolvedValue({ lastPrice: '65000' });
    exchange.getBalance.mockResolvedValue({ total: '10000', available: '10000' });
    exchange.getMarkets.mockResolvedValue([
      { symbol: 'BTC_USDT', multiplier: '0.0001', amountPrecision: 0, pricePrecision: 1, leverageMax: '20' },
    ]);
    exchange.getPositions.mockResolvedValue([]);
    exchange.getOpenOrders.mockResolvedValue([]);
    exchange.setLeverage.mockResolvedValue(true);
    exchange.placeOrder.mockResolvedValue({ id: 'vo-1', status: 'filled', amount: '100', price: '65000' });
    exchange.waitForOrderFill.mockResolvedValue({ id: 'vo-1', status: 'filled', amount: '100', price: '65000' });
    (exchangeRegistry.getAllExchanges as jest.Mock).mockReturnValue([]);
    (Order.findAll as jest.Mock).mockResolvedValue([]);
    (Order.create as jest.Mock).mockImplementation(async (payload: any) => ({
      id: 1,
      ...payload,
      save: jest.fn(),
    }));
    (StrategyPosition.findOne as jest.Mock).mockResolvedValue(null);
    (StrategyPosition.create as jest.Mock).mockResolvedValue({});
    (Strategy.findByPk as jest.Mock).mockResolvedValue(null);
  });

  it('treats virtual filled entry orders as immediately filled', async () => {
    const result = await (tradeExecutor as any).handleOpen(
      { action: 'open', symbol: 'BTC_USDT', side: 'buy', entryPrice: '65000', stopLoss: '64000', targets: [], raw: {} },
      { riskMode: 'fixed', riskValue: 100, defaultLeverage: '1', priceTolerance: 0.01 },
      'virtual-test',
      123,
      'virtual_1',
      77,
    );

    expect(result).toEqual(expect.objectContaining({ id: 'vo-1', status: 'filled' }));
    expect(exchangeRegistry.getExchange).toHaveBeenCalledWith('virtual_1');
    expect(Order.create).toHaveBeenCalledWith(expect.objectContaining({
      exchangeInstanceId: 'virtual_1',
      isSimulated: false,
    }));
    expect(exchange.waitForOrderFill).not.toHaveBeenCalled();
    expect(PostFillOrchestrator).toHaveBeenCalled();
  });

  it('initializes NoStopLossMonitor before recovering filled orders', async () => {
    const pendingOrder = {
      id: 429,
      strategyId: 77,
      exchangeInstanceId: 'virtual_1',
      exchangeOrderId: 'vo-429',
      symbol: 'BTC_USDT',
      status: 'open',
      lifecycleStatus: 'PENDING',
      save: jest.fn(),
    };
    (Order.findAll as jest.Mock).mockResolvedValue([pendingOrder]);
    (Strategy.findByPk as jest.Mock).mockResolvedValue({
      id: 77,
      action: 'open',
      symbol: 'BTC_USDT',
      side: 'buy',
      entryPrice: '65000',
      targets: JSON.stringify(['66000']),
      stopLoss: '64000',
      source: 'discord:1',
      parserName: null,
      rawMessage: JSON.stringify({}),
    });
    (exchange as any).getOrder = jest.fn().mockResolvedValue({
      id: 'vo-429',
      status: 'filled',
      amount: '100',
      price: '65000',
    });

    await (tradeExecutor as any).initialize();
    tradeExecutor.stop();

    expect(PostFillOrchestrator).toHaveBeenCalledWith(
      exchange,
      expect.objectContaining({ watchOrder: expect.any(Function) }),
      expect.anything(),
      tradeExecutor,
    );
  });

  it('runs REST reconcile for local pending Lighter orders immediately after WS reconnect', async () => {
    const pendingOrder = {
      id: 430,
      strategyId: 78,
      exchangeInstanceId: 'lighter_1',
      exchangeOrderId: 'lighter-430',
      symbol: 'BTC_USDT',
      side: 'buy',
      amount: '100',
      status: 'open',
      lifecycleStatus: 'PENDING',
      save: jest.fn(),
    };
    const lighterExchange = Object.assign(new EventEmitter(), {
      id: 'lighter_1',
      name: 'Lighter 1',
      getPositions: jest.fn().mockResolvedValue([]),
      getOrder: jest.fn().mockResolvedValue({
        id: 'lighter-430',
        status: 'filled',
        amount: '100',
        price: '65000',
      }),
      waitForOrderFill: jest.fn(),
    });
    Object.defineProperty(lighterExchange, 'constructor', {
      value: { name: 'LighterExchange' },
      configurable: true,
    });

    (exchangeRegistry as any).exchanges = new Map([['lighter_1', lighterExchange]]);
    (exchangeRegistry.getAllExchanges as jest.Mock).mockReturnValue([lighterExchange]);
    (exchangeRegistry.getExchange as jest.Mock).mockReturnValue(lighterExchange);
    (Order.findAll as jest.Mock)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([pendingOrder]);
    (Strategy.findByPk as jest.Mock).mockResolvedValue({
      id: 78,
      action: 'open',
      symbol: 'BTC_USDT',
      side: 'buy',
      entryPrice: '65000',
      targets: JSON.stringify(['66000']),
      stopLoss: '64000',
      source: 'discord:1',
      parserName: null,
      rawMessage: JSON.stringify({}),
    });

    await (tradeExecutor as any).initialize();
    lighterExchange.emit('wsConnected');
    await new Promise(resolve => setImmediate(resolve));
    tradeExecutor.stop();

    expect(lighterExchange.getOrder).toHaveBeenCalledWith('lighter-430', 'BTC_USDT');
    expect(lighterExchange.waitForOrderFill).not.toHaveBeenCalled();
    expect(pendingOrder.lifecycleStatus).toBe('OPEN');
    expect(PostFillOrchestrator).toHaveBeenCalledWith(
      lighterExchange,
      expect.objectContaining({ watchOrder: expect.any(Function) }),
      expect.anything(),
      tradeExecutor,
    );
  });
});
