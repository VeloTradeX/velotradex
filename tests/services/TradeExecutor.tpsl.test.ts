// TradeExecutor tpsl（Gate 订单自带 TP/SL）集成测试
// 覆盖 OpenPositionService 的 tpsl 决策：
// - 单 TP + SL：入场单同时带 tpsl_tp_trigger_price + tpsl_sl_trigger_price
// - 多 TP + SL：入场单只带 tpsl_sl_trigger_price，多档 TP 由 post-fill 挂
// - ratio_based 无 SL：不启用 tpsl

import tradeExecutor from '../../src/services/TradeExecutor';
import exchangeRegistry from '../../src/services/exchanges';
import auditService from '../../src/services/AuditService';
import { Order } from '../../src/models';

jest.mock('../../src/services/exchanges', () => ({
  __esModule: true,
  default: { getExchange: jest.fn() },
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
    findOne: jest.fn(),
    findAll: jest.fn(),
    create: jest.fn(),
    update: jest.fn().mockResolvedValue([1]),
  },
  Strategy: {},
  StrategyPosition: { findOne: jest.fn(), create: jest.fn() },
  AuditLog: {},
  PendingProtection: { create: jest.fn(), findByPk: jest.fn() },
  SoftStopLoss: { create: jest.fn() },
  sequelize: {},
}));

describe('TradeExecutor tpsl (Gate order-attached TP/SL) decision', () => {
  const mockExchange = {
    name: 'Mock Gate',
    getTicker: jest.fn(),
    getBalance: jest.fn(),
    getMarkets: jest.fn(),
    getPositions: jest.fn(),
    getOpenOrders: jest.fn(),
    getPriceOrders: jest.fn(),
    setMarginMode: jest.fn(),
    setLeverage: jest.fn(),
    placeOrder: jest.fn(),
    waitForOrderFill: jest.fn(),
    updateStopLoss: jest.fn(),
    closePosition: jest.fn(),
    getTradeHistory: jest.fn(),
    cancelOrder: jest.fn(),
    cancelPriceOrder: jest.fn(),
  };

  const baseRiskConfig = {
    riskMode: 'percentage' as const,
    riskValue: 1,
    defaultLeverage: '5',
    priceTolerance: 0.01,
    entryPaddingR: 0,
    tpPaddingR: 0,
    slPaddingR: 0,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    (exchangeRegistry.getExchange as jest.Mock).mockReturnValue(mockExchange);
    mockExchange.getTicker.mockResolvedValue({ lastPrice: '100' });
    mockExchange.getBalance.mockResolvedValue({ total: '1000', available: '1000' });
    mockExchange.getMarkets.mockResolvedValue([
      {
        symbol: 'BTC_USDT',
        multiplier: '0.0001',
        leverageMax: '20',
        amountPrecision: 0,
        pricePrecision: 1,
      },
    ]);
    mockExchange.getPositions.mockResolvedValue([]);
    mockExchange.getOpenOrders.mockResolvedValue([]);
    mockExchange.getPriceOrders.mockResolvedValue([]);
    mockExchange.setMarginMode.mockResolvedValue(true);
    mockExchange.setLeverage.mockResolvedValue(true);
    // status 'open' → handleOpen 走 waitForOrderFill 挂起路径，post-fill 不立即执行
    mockExchange.placeOrder.mockResolvedValue({ id: 'entry-1', status: 'open', symbol: 'BTC_USDT', amount: '1', price: '101' });
    mockExchange.waitForOrderFill.mockReturnValue(new Promise(() => {}));
    mockExchange.updateStopLoss.mockResolvedValue('sl-1');
    mockExchange.closePosition.mockResolvedValue(true);
    mockExchange.getTradeHistory.mockResolvedValue([]);
    (Order.findOne as jest.Mock).mockResolvedValue(null);
    (Order.findAll as jest.Mock).mockResolvedValue([]);
    (Order.create as jest.Mock).mockResolvedValue({
      id: 1,
      symbol: 'BTC_USDT',
      side: 'buy',
      amount: '1',
      price: '101',
      lifecycleStatus: 'INIT',
      save: jest.fn(),
    });
    (auditService.log as jest.Mock).mockResolvedValue(undefined);
  });

  it('单 TP + SL：入场单同时带 tpsl_tp_trigger_price 与 tpsl_sl_trigger_price', async () => {
    await (tradeExecutor as any).handleOpen(
      { action: 'open', symbol: 'BTC_USDT', side: 'buy', entryPrice: '101', stopLoss: '95', targets: ['110'], raw: {} },
      baseRiskConfig,
      'unit-test-source',
      123,
      'main',
    );

    expect(mockExchange.placeOrder).toHaveBeenCalledWith(expect.objectContaining({
      tpslTpTriggerPrice: '110.0',
      tpslSlTriggerPrice: '95.0',
    }));
  });

  it('多 TP + SL：入场单只带 tpsl_sl_trigger_price，TP 由 post-fill 分档挂', async () => {
    await (tradeExecutor as any).handleOpen(
      { action: 'open', symbol: 'BTC_USDT', side: 'buy', entryPrice: '101', stopLoss: '95', targets: ['110', '120'], raw: {} },
      { ...baseRiskConfig, tpDistribution: [0.5, 0.5] },
      'unit-test-source',
      124,
      'main',
    );

    const orderParams = mockExchange.placeOrder.mock.calls[0][0];
    expect(orderParams.tpslSlTriggerPrice).toBe('95.0');
    expect(orderParams.tpslTpTriggerPrice).toBeUndefined();
    // 多档 TP 照常传入 post-fill 使用
    expect(orderParams.tpOrders).toHaveLength(2);
  });

  it('ratio_based 无 SL：不启用 tpsl（无自带字段）', async () => {
    await (tradeExecutor as any).handleOpen(
      { action: 'open', symbol: 'BTC_USDT', side: 'buy', entryPrice: '101', targets: ['110', '120'], raw: {} },
      { ...baseRiskConfig, riskMode: 'ratio_based' },
      'unit-test-source',
      125,
      'main',
    );

    const orderParams = mockExchange.placeOrder.mock.calls[0][0];
    expect(orderParams.tpslSlTriggerPrice).toBeUndefined();
    expect(orderParams.tpslTpTriggerPrice).toBeUndefined();
  });

  it('Lighter 交易所不启用 tpsl（走原逻辑）', async () => {
    const lighter = {
      ...mockExchange,
      constructor: { name: 'LighterExchange' },
    };
    Object.defineProperty(lighter, 'constructor', { value: { name: 'LighterExchange' }, configurable: true });
    (exchangeRegistry.getExchange as jest.Mock).mockReturnValue(lighter);

    await (tradeExecutor as any).handleOpen(
      { action: 'open', symbol: 'BTC_USDT', side: 'buy', entryPrice: '101', stopLoss: '95', targets: ['110'], raw: {} },
      baseRiskConfig,
      'unit-test-source',
      126,
      'lighter_1',
    );

    const orderParams = lighter.placeOrder.mock.calls[0][0];
    expect(orderParams.tpslSlTriggerPrice).toBeUndefined();
    expect(orderParams.tpslTpTriggerPrice).toBeUndefined();
  });
});
