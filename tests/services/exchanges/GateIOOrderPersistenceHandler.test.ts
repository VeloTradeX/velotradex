// tests/services/exchanges/GateIOOrderPersistenceHandler.test.ts
import { GateIOOrderPersistenceHandler } from '../../../src/services/exchanges/GateIOOrderPersistenceHandler';

describe('GateIOOrderPersistenceHandler', () => {
  const mockExchange = {};
  const mockOrder = { findOne: jest.fn(), findAll: jest.fn() };
  const mockStrategyPosition = { findAll: jest.fn(), update: jest.fn() };
  const mockPendingProtection = { findByPk: jest.fn(), destroy: jest.fn(), create: jest.fn() };
  const mockAuditService = { log: jest.fn(), logByExchangeOrderId: jest.fn() };

  beforeEach(() => {
    jest.clearAllMocks();
    jest.doMock('../../../src/models', () => ({
      Order: mockOrder, StrategyPosition: mockStrategyPosition, PendingProtection: mockPendingProtection,
    }));
    jest.doMock('../../../src/services/AuditService', () => ({
      default: mockAuditService, log: mockAuditService.log, logByExchangeOrderId: mockAuditService.logByExchangeOrderId,
    }));
  });

  const makeRawOrder = (overrides: any = {}) => ({
    id: 'ex-123', status: 'finished', left: '0', text: 't-trader',
    fill_price: '100', size: '5', is_reduce_only: false, contract: 'BTC_USDT',
    ...overrides,
  });

  it('开仓单成交更新 lifecycle → OPEN', async () => {
    const order = { id: 1, lifecycleStatus: 'PENDING', save: jest.fn() };
    mockOrder.findOne.mockResolvedValue(order);
    mockOrder.findAll.mockResolvedValue([]);
    mockPendingProtection.findByPk.mockResolvedValue(null);

    const handler = new (GateIOOrderPersistenceHandler as any)(mockExchange);
    handler.orderModel = mockOrder;
    handler.strategyPositionModel = mockStrategyPosition;
    handler.pendingProtectionModel = mockPendingProtection;
    handler.auditService = mockAuditService;

    await handler.handleOrderFilled('ex-123', makeRawOrder());
    expect(order.lifecycleStatus).toBe('OPEN');
    expect(order.save).toHaveBeenCalled();
  });

  it('TP 单成交触发 remainingSize 减少', async () => {
    const order = { id: 1, lifecycleStatus: 'PROTECTED', save: jest.fn(), side: 'buy' };
    mockOrder.findOne.mockResolvedValue(order);
    mockOrder.findAll.mockResolvedValue([]);
    mockStrategyPosition.findAll.mockResolvedValue([
      { id: 1, orderId: 1, remainingSize: '5', update: jest.fn() },
    ]);
    mockPendingProtection.findByPk.mockResolvedValue(null);

    const handler = new (GateIOOrderPersistenceHandler as any)(mockExchange);
    handler.orderModel = mockOrder;
    handler.strategyPositionModel = mockStrategyPosition;
    handler.pendingProtectionModel = mockPendingProtection;
    handler.auditService = mockAuditService;

    await handler.handleOrderFilled('ex-123', makeRawOrder({
      text: 't-tp-1-ord-1', is_reduce_only: true, size: '-2',
    }));
    expect(mockStrategyPosition.findAll.mock.calls[0][0].where.symbol).toBe('BTC_USDT');
  });

  it('找不到关联订单时优雅跳过', async () => {
    mockOrder.findOne.mockResolvedValue(null);
    mockOrder.findAll.mockResolvedValue([]);
    mockPendingProtection.findByPk.mockResolvedValue(null);

    const handler = new (GateIOOrderPersistenceHandler as any)(mockExchange);
    handler.orderModel = mockOrder;
    handler.strategyPositionModel = mockStrategyPosition;
    handler.pendingProtectionModel = mockPendingProtection;
    handler.auditService = mockAuditService;

    await expect(handler.handleOrderFilled('ex-123', makeRawOrder())).resolves.not.toThrow();
  });

  it('取消事件更新 lifecycle → CLOSED', async () => {
    const order = { id: 1, lifecycleStatus: 'PENDING', save: jest.fn() };
    mockOrder.findOne.mockResolvedValue(order);

    const handler = new (GateIOOrderPersistenceHandler as any)(mockExchange);
    handler.orderModel = mockOrder;
    handler.strategyPositionModel = mockStrategyPosition;
    handler.pendingProtectionModel = mockPendingProtection;
    handler.auditService = mockAuditService;

    await handler.handleOrderCancelled('ex-123', makeRawOrder({ status: 'open', left: '3' }));
    expect(order.lifecycleStatus).toBe('CLOSED');
    expect(order.save).toHaveBeenCalled();
  });

  it('TP fill 触发 moveStopLossToBreakeven', async () => {
    const order = { id: 99, lifecycleStatus: 'PROTECTED', save: jest.fn(), side: 'buy', symbol: 'BTC_USDT' };
    mockOrder.findOne
      .mockResolvedValueOnce(order) // findDbOrder (by exchangeOrderId)
      .mockResolvedValueOnce(order); // for TP fill handling (by linked orderId)
    mockOrder.findAll.mockResolvedValue([]);
    mockStrategyPosition.findAll.mockResolvedValue([]);
    mockPendingProtection.findByPk.mockResolvedValue(null);

    const mockPipeline = {
      moveStopLossToBreakeven: jest.fn().mockResolvedValue(true),
      cancelProtections: jest.fn(),
    };

    // Remaining TPs are regular reduce-only limit orders — they appear in getOpenOrders()
    const mockExchangeWithOpenOrders = {
      ...mockExchange,
      getOpenOrders: jest.fn().mockResolvedValue([
        { id: 'tp-2', text: `t-tp-2-ws-handler-ord-99` },
      ]),
      getPriceOrders: jest.fn().mockResolvedValue([]),
      getPosition: jest.fn().mockResolvedValue({ size: '0' }),
    };

    const handler = new (GateIOOrderPersistenceHandler as any)(mockExchangeWithOpenOrders);
    handler.orderModel = mockOrder;
    handler.strategyPositionModel = mockStrategyPosition;
    handler.pendingProtectionModel = mockPendingProtection;
    handler.auditService = mockAuditService;
    handler.protectionPipeline = mockPipeline; // injected

    await handler.handleOrderFilled('ex-tp-1', makeRawOrder({
      text: 't-tp-1-ord-99', is_reduce_only: true, size: '-2',
    }));

    expect(mockPipeline.moveStopLossToBreakeven).toHaveBeenCalledWith('99');
    expect(order.lifecycleStatus).toBe('PROTECTED');
  });

  it('tpOrdersJson 新格式（{tpOrders, attachedSl}）解析出多档 TP 并透传 slPreAttached', async () => {
    const order = { id: 1, lifecycleStatus: 'PENDING', save: jest.fn() };
    const protection = {
      orderId: 'ex-123',
      symbol: 'BTC_USDT',
      side: 'buy',
      stopLoss: null,
      takeProfit: null,
      // 多 TP + 自带 SL：tpOrdersJson 为对象格式，带 attachedSl 标记
      tpOrdersJson: JSON.stringify({
        tpOrders: [{ price: '75000', amount: '2.5' }, { price: '76000', amount: '2.5' }],
        attachedSl: true,
      }),
    };

    mockOrder.findOne.mockResolvedValue(order);
    mockOrder.findAll.mockResolvedValue([]);
    mockStrategyPosition.findAll.mockResolvedValue([]);
    mockPendingProtection.findByPk.mockResolvedValueOnce(protection);

    const mockPipeline = {
      placeProtections: jest.fn().mockResolvedValue({ slPlaced: true, tpPlaced: true, claimed: true }),
      moveStopLossToBreakeven: jest.fn(),
      cancelProtections: jest.fn(),
    };

    const handler = new (GateIOOrderPersistenceHandler as any)(mockExchange);
    handler.orderModel = mockOrder;
    handler.strategyPositionModel = mockStrategyPosition;
    handler.pendingProtectionModel = mockPendingProtection;
    handler.auditService = mockAuditService;
    handler.protectionPipeline = mockPipeline;

    await handler.handleOrderFilled('ex-123', makeRawOrder());

    expect(mockPipeline.placeProtections).toHaveBeenCalledWith(expect.objectContaining({
      tpOrders: [{ price: '75000', amount: '2.5' }, { price: '76000', amount: '2.5' }],
      // 自带 SL：管线跳过 SL 挂单，只补多档 TP
      slPreAttached: true,
    }));
  });

  it('tpOrdersJson 旧格式（纯数组）解析仍兼容，slPreAttached 默认 false', async () => {
    const order = { id: 1, lifecycleStatus: 'PENDING', save: jest.fn() };
    const protection = {
      orderId: 'ex-456',
      symbol: 'BTC_USDT',
      side: 'buy',
      stopLoss: '95',
      takeProfit: null,
      tpOrdersJson: JSON.stringify([{ price: '75000', amount: '5' }]),
    };

    mockOrder.findOne.mockResolvedValue(order);
    mockOrder.findAll.mockResolvedValue([]);
    mockStrategyPosition.findAll.mockResolvedValue([]);
    mockPendingProtection.findByPk.mockResolvedValueOnce(protection);

    const mockPipeline = {
      placeProtections: jest.fn().mockResolvedValue({ slPlaced: true, tpPlaced: true, claimed: true }),
      moveStopLossToBreakeven: jest.fn(),
      cancelProtections: jest.fn(),
    };

    const handler = new (GateIOOrderPersistenceHandler as any)(mockExchange);
    handler.orderModel = mockOrder;
    handler.strategyPositionModel = mockStrategyPosition;
    handler.pendingProtectionModel = mockPendingProtection;
    handler.auditService = mockAuditService;
    handler.protectionPipeline = mockPipeline;

    await handler.handleOrderFilled('ex-456', makeRawOrder());

    expect(mockPipeline.placeProtections).toHaveBeenCalledWith(expect.objectContaining({
      tpOrders: [{ price: '75000', amount: '5' }],
      slPreAttached: false,
    }));
  });

  it('当保护记录仍挂在 clientOrderId 上时，会先迁移到 exchangeOrderId 再放置保护', async () => {    const order = { id: 1, lifecycleStatus: 'PENDING', save: jest.fn() };
    const tempProtection = {
      orderId: 't-client-1',
      symbol: 'BTC_USDT',
      side: 'buy',
      stopLoss: '95',
      takeProfit: '110',
      destroy: jest.fn(),
    };

    mockOrder.findOne.mockResolvedValue(order);
    mockStrategyPosition.findAll.mockResolvedValue([]);
    mockPendingProtection.findByPk
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(tempProtection);
    mockPendingProtection.create.mockResolvedValue({
      orderId: 'ex-123',
      symbol: 'BTC_USDT',
      side: 'buy',
      stopLoss: '95',
      takeProfit: '110',
      destroy: jest.fn(),
    });

    const mockPipeline = {
      placeProtections: jest.fn().mockResolvedValue({ slPlaced: true, tpPlaced: true, claimed: true }),
      moveStopLossToBreakeven: jest.fn(),
      cancelProtections: jest.fn(),
    };

    const handler = new (GateIOOrderPersistenceHandler as any)(mockExchange);
    handler.orderModel = mockOrder;
    handler.strategyPositionModel = mockStrategyPosition;
    handler.pendingProtectionModel = mockPendingProtection;
    handler.auditService = mockAuditService;
    handler.protectionPipeline = mockPipeline;

    await handler.handleOrderFilled('ex-123', makeRawOrder({ text: 't-client-1' }));

    expect(mockPendingProtection.create).toHaveBeenCalledWith({
      orderId: 'ex-123',
      symbol: 'BTC_USDT',
      side: 'buy',
      stopLoss: '95',
      takeProfit: '110',
      tpOrdersJson: null,
      status: 'PENDING',
    });
    expect(tempProtection.destroy).toHaveBeenCalled();
    expect(mockPipeline.placeProtections).toHaveBeenCalledWith(expect.objectContaining({
      orderId: 'ex-123',
      symbol: 'BTC_USDT',
      side: 'buy',
      stopLossPrice: '95',
    }));
  });

  it('当 pipeline 未成功 claim 时，不会删除待保护记录', async () => {
    const order = { id: 1, lifecycleStatus: 'PENDING', save: jest.fn() };
    const protection = {
      orderId: 'ex-123',
      symbol: 'BTC_USDT',
      side: 'buy',
      stopLoss: '95',
      takeProfit: null,
      destroy: jest.fn(),
    };

    mockOrder.findOne.mockResolvedValue(order);
    mockStrategyPosition.findAll.mockResolvedValue([]);
    mockPendingProtection.findByPk.mockResolvedValue(protection);

    const mockPipeline = {
      placeProtections: jest.fn().mockResolvedValue({ slPlaced: false, tpPlaced: false, claimed: false }),
      moveStopLossToBreakeven: jest.fn(),
      cancelProtections: jest.fn(),
    };

    const handler = new (GateIOOrderPersistenceHandler as any)(mockExchange);
    handler.orderModel = mockOrder;
    handler.strategyPositionModel = mockStrategyPosition;
    handler.pendingProtectionModel = mockPendingProtection;
    handler.auditService = mockAuditService;
    handler.protectionPipeline = mockPipeline;

    await handler.handleOrderFilled('ex-123', makeRawOrder());

    expect(mockPipeline.placeProtections).toHaveBeenCalled();
    expect(protection.destroy).not.toHaveBeenCalled();
  });

  it('TP text 携带 exchangeOrderId 时，能找到原始开仓单并触发 breakeven/cancel 链路', async () => {
    const openOrder = { id: 128, lifecycleStatus: 'PROTECTED', save: jest.fn(), side: 'buy', symbol: 'BTC_USDT' };
    mockOrder.findOne.mockImplementation(({ where }: any) => {
      if (where?.exchangeOrderId === '82472171401084903') {
        return Promise.resolve(openOrder);
      }
      return Promise.resolve(null);
    });
    mockStrategyPosition.findAll.mockResolvedValue([
      { id: 1, orderId: 128, remainingSize: '5', update: jest.fn() },
    ]);
    mockPendingProtection.findByPk.mockResolvedValue(null);

    const mockPipeline = {
      moveStopLossToBreakeven: jest.fn().mockResolvedValue(true),
      cancelProtections: jest.fn(),
    };

    const mockExchangeWithOpenOrders = {
      ...mockExchange,
      // TP orders are regular limit orders — they appear in getOpenOrders()
      getOpenOrders: jest.fn().mockResolvedValue([
        { id: 'tp-2', text: 't-tp-2-ws-handler-ord-82472171401084903' },
        { id: 'tp-3', text: 't-tp-3-ord-82472171401084903' },
      ]),
      getPriceOrders: jest.fn().mockResolvedValue([]),
      getPosition: jest.fn().mockResolvedValue({ size: '0' }),
    };

    const handler = new (GateIOOrderPersistenceHandler as any)(mockExchangeWithOpenOrders);
    handler.orderModel = mockOrder;
    handler.strategyPositionModel = mockStrategyPosition;
    handler.pendingProtectionModel = mockPendingProtection;
    handler.auditService = mockAuditService;
    handler.protectionPipeline = mockPipeline;

    await handler.handleOrderFilled('ex-tp-1', makeRawOrder({
      text: 't-tp-1-ord-82472171401084903',
      is_reduce_only: true,
      size: '-2',
    }));

    expect(mockPipeline.moveStopLossToBreakeven).toHaveBeenCalledWith('82472171401084903');
  });

  it('所有 TP 成交但仓位仍存在时，不取消 SL', async () => {
    const order = { id: 77, lifecycleStatus: 'PROTECTED', save: jest.fn(), side: 'buy', symbol: 'BTC_USDT' };
    mockOrder.findOne
      .mockResolvedValueOnce(order) // findDbOrder
      .mockResolvedValueOnce(order); // _handleTpFill lookup
    mockOrder.findAll.mockResolvedValue([]);
    mockStrategyPosition.findAll.mockResolvedValue([]);
    mockPendingProtection.findByPk.mockResolvedValue(null);

    const mockPipeline = {
      moveStopLossToBreakeven: jest.fn().mockResolvedValue(true),
      cancelProtections: jest.fn(),
    };

    const mockExchangeWithPosition = {
      ...mockExchange,
      getOpenOrders: jest.fn().mockResolvedValue([]),
      getPriceOrders: jest.fn().mockResolvedValue([]),
      getPosition: jest.fn().mockResolvedValue({ size: '3.5' }),
    };

    const handler = new (GateIOOrderPersistenceHandler as any)(mockExchangeWithPosition);
    handler.orderModel = mockOrder;
    handler.strategyPositionModel = mockStrategyPosition;
    handler.pendingProtectionModel = mockPendingProtection;
    handler.auditService = mockAuditService;
    handler.protectionPipeline = mockPipeline;

    await handler.handleOrderFilled('ex-tp-last', makeRawOrder({
      text: 't-tp-1-ord-77', is_reduce_only: true, size: '-1',
    }));

    expect(mockPipeline.cancelProtections).not.toHaveBeenCalled();
    expect(order.lifecycleStatus).toBe('PROTECTED');
  });

  it('所有 TP 成交且仓位已平仓时，取消 SL', async () => {
    const order = { id: 77, lifecycleStatus: 'PROTECTED', save: jest.fn(), side: 'buy', symbol: 'BTC_USDT' };
    mockOrder.findOne
      .mockResolvedValueOnce(order)
      .mockResolvedValueOnce(order);
    mockOrder.findAll.mockResolvedValue([]);
    mockPendingProtection.findByPk.mockResolvedValue(null);

    const mockPipeline = {
      moveStopLossToBreakeven: jest.fn().mockResolvedValue(true),
      cancelProtections: jest.fn(),
    };

    const mockExchangeWithClosedPosition = {
      ...mockExchange,
      getOpenOrders: jest.fn().mockResolvedValue([]),
      getPriceOrders: jest.fn().mockResolvedValue([]),
      getPosition: jest.fn().mockResolvedValue({ size: '0' }),
    };

    const handler = new (GateIOOrderPersistenceHandler as any)(mockExchangeWithClosedPosition);
    handler.orderModel = mockOrder;
    handler.strategyPositionModel = mockStrategyPosition;
    handler.pendingProtectionModel = mockPendingProtection;
    handler.auditService = mockAuditService;
    handler.protectionPipeline = mockPipeline;

    await handler.handleOrderFilled('ex-tp-last', makeRawOrder({
      text: 't-tp-1-ord-77', is_reduce_only: true, size: '-1',
    }));

    expect(mockPipeline.cancelProtections).toHaveBeenCalledWith('BTC_USDT', 'buy');
    expect(order.lifecycleStatus).toBe('CLOSED');
  });

  it('_getRemainingTpOrders 使用 getOpenOrders 查询 TP 订单', async () => {
    const mockExchangeWithOpenOrders = {
      ...mockExchange,
      getOpenOrders: jest.fn().mockResolvedValue([
        { id: 'tp-1', text: 't-tp-1-ord-123' },
        { id: 'tp-2', text: 't-tp-2-ord-123' },
        { id: 'tp-3', text: 't-tp-3-ord-999' },
      ]),
    };

    const handler = new (GateIOOrderPersistenceHandler as any)(mockExchangeWithOpenOrders);

    const count = await handler._getRemainingTpOrders('BTC_USDT', '123');
    expect(count).toBe(2);
    expect(mockExchangeWithOpenOrders.getOpenOrders).toHaveBeenCalledWith('BTC_USDT');
  });

  it('_getRemainingTpOrders 在 API 失败时抛出异常（调用方捕获后设置 remainingTpOrders = -1）', async () => {
    const mockExchangeFails = {
      ...mockExchange,
      getOpenOrders: jest.fn().mockRejectedValue(new Error('API timeout')),
    };

    const handler = new (GateIOOrderPersistenceHandler as any)(mockExchangeFails);

    await expect(handler._getRemainingTpOrders('BTC_USDT', '123')).rejects.toThrow('_getRemainingTpOrders failed');
  });
});
