import { PostFillOrchestrator } from '../../src/services/PostFillOrchestrator';

describe('PostFillOrchestrator', () => {
  const mockExchange = {
    getPosition: jest.fn(),
    getMarkets: jest.fn(),
  };
  const mockPipeline = { placeProtections: jest.fn() };
  const mockNoStopLossMonitor = { watchOrder: jest.fn() };
  const mockTradeExecutor = { placeTpOrders: jest.fn() };

  beforeEach(() => { jest.clearAllMocks(); });

  const makeOrder = (overrides: any = {}) => ({
    id: 1, exchangeOrderId: 'ex-1', filledAmount: '5', filledPrice: '100',
    initialSl: '95', lifecycleStatus: 'OPEN', symbol: 'BTC_USDT', side: 'buy',
    save: jest.fn(),
    ...overrides,
  });

  const makeParams = (order: any, extra: any = {}) => ({
    order,
    parsed: {
      action: 'open', symbol: 'BTC_USDT', side: 'buy',
      stopLoss: '95', targets: ['102'], entryPrice: '100',
      ...(extra.parsed || {}),
    },
    riskConfig: {
      riskMode: 'percentage', riskValue: 1, defaultLeverage: '10',
      priceTolerance: 0.005, tpDistribution: [1], tpPaddingR: 0,
      entryPaddingR: 0, slPaddingR: 0,
    },
    source: 'discord:1',
    strategyId: 1,
    exchangeInstanceId: undefined,
    ...extra,
  });

  it('SL+TP 都成功时 lifecycle → PROTECTED', async () => {
    mockExchange.getMarkets.mockResolvedValue([{ symbol: 'BTC_USDT', amountPrecision: 2, pricePrecision: 2 }]);
    mockPipeline.placeProtections.mockResolvedValue({ slPlaced: true, tpPlaced: true, claimed: true });

    const orchestrator = new PostFillOrchestrator(
      mockExchange as any, mockNoStopLossMonitor as any,
      mockPipeline as any, mockTradeExecutor as any,
    );

    const order = makeOrder();
    await orchestrator.run(makeParams(order));

    expect(order.lifecycleStatus).toBe('PROTECTED');
    expect(order.save).toHaveBeenCalled();
    expect(mockNoStopLossMonitor.watchOrder).toHaveBeenCalledWith('1', 'BTC_USDT');
  });

  it('SL 失败但 TP 成功时 lifecycle → OPEN', async () => {
    mockExchange.getMarkets.mockResolvedValue([{ symbol: 'BTC_USDT', amountPrecision: 2, pricePrecision: 2 }]);
    mockPipeline.placeProtections.mockResolvedValue({ slPlaced: false, tpPlaced: true, claimed: true });

    const orchestrator = new PostFillOrchestrator(
      mockExchange as any, mockNoStopLossMonitor as any,
      mockPipeline as any, mockTradeExecutor as any,
    );

    const order = makeOrder();
    await orchestrator.run(makeParams(order));

    expect(order.lifecycleStatus).toBe('OPEN');
  });

  it('无 stopLoss 时跳过 SL 放置', async () => {
    mockExchange.getMarkets.mockResolvedValue([{ symbol: 'BTC_USDT', amountPrecision: 2, pricePrecision: 2 }]);
    mockPipeline.placeProtections.mockResolvedValue({ slPlaced: false, tpPlaced: true, claimed: true });

    const orchestrator = new PostFillOrchestrator(
      mockExchange as any, mockNoStopLossMonitor as any,
      mockPipeline as any, mockTradeExecutor as any,
    );

    const order = makeOrder();
    await orchestrator.run(makeParams(order, {
      parsed: { action: 'open', symbol: 'BTC_USDT', side: 'buy', targets: ['102'] },
    }));

    expect(mockPipeline.placeProtections).toHaveBeenCalled();
  });

  it('TP/SL 全自带（slPreAttached && tpPreAttached）时不调管线，直接 PROTECTED', async () => {
    mockExchange.getMarkets.mockResolvedValue([{ symbol: 'BTC_USDT', amountPrecision: 2, pricePrecision: 2 }]);

    const orchestrator = new PostFillOrchestrator(
      mockExchange as any, mockNoStopLossMonitor as any,
      mockPipeline as any, mockTradeExecutor as any,
    );

    const order = makeOrder();
    await orchestrator.run(makeParams(order, {
      slPreAttached: true,
      tpPreAttached: true,
    }));

    // 全自带：不再走 placeProtections（无 PendingProtection，claim 必失败）
    expect(mockPipeline.placeProtections).not.toHaveBeenCalled();
    expect(order.lifecycleStatus).toBe('PROTECTED');
    expect(order.save).toHaveBeenCalled();
    expect(mockNoStopLossMonitor.watchOrder).toHaveBeenCalledWith('1', 'BTC_USDT');
  });

  it('仅 SL 自带（slPreAttached && !tpPreAttached）时仍走管线挂多档 TP', async () => {
    mockExchange.getMarkets.mockResolvedValue([{ symbol: 'BTC_USDT', amountPrecision: 2, pricePrecision: 2 }]);
    mockPipeline.placeProtections.mockResolvedValue({ slPlaced: true, tpPlaced: true, claimed: true });

    const orchestrator = new PostFillOrchestrator(
      mockExchange as any, mockNoStopLossMonitor as any,
      mockPipeline as any, mockTradeExecutor as any,
    );

    const order = makeOrder();
    await orchestrator.run(makeParams(order, {
      slPreAttached: true,
      tpPreAttached: false,
      tpOrders: [{ price: '102', amount: '2.5' }, { price: '105', amount: '2.5' }],
    }));

    expect(mockPipeline.placeProtections).toHaveBeenCalledWith(expect.objectContaining({
      slPreAttached: true,
      tpOrders: [{ price: '102', amount: '2.5' }, { price: '105', amount: '2.5' }],
    }));
    expect(order.lifecycleStatus).toBe('PROTECTED');
  });
});
