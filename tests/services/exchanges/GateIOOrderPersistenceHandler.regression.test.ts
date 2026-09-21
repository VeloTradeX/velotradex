// Regression tests for: TP1 fill should NOT close original entry order
// Bug: _handleTpFill called _closeOrder(dbOrder) where dbOrder was the original
// entry order (found via findDbOrder → extractLinkedOrderIdFromText), causing
// checkPositionClosed to find 0 active orders → TP2 never cancelled.

import { GateIOOrderPersistenceHandler } from '../../../src/services/exchanges/GateIOOrderPersistenceHandler';

describe('GateIOOrderPersistenceHandler — regression: TP1 fill must not close original entry order', () => {
  const mockExchange: any = {};
  const mockOrder = { findOne: jest.fn(), findAll: jest.fn() };
  const mockStrategyPosition = { findAll: jest.fn(), update: jest.fn() };
  const mockPendingProtection = { findByPk: jest.fn(), destroy: jest.fn(), create: jest.fn() };
  const mockAuditService = { log: jest.fn(), logByExchangeOrderId: jest.fn() };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  const makeRawOrder = (overrides: any = {}) => ({
    id: 'ex-123', status: 'finished', left: '0', text: 't-trader',
    fill_price: '100', size: '5', is_reduce_only: false, contract: 'BTC_USDT',
    ...overrides,
  });

  it('TP1 fill does NOT close original entry order when TP2 still exists', async () => {
    // Original entry order (found via extractLinkedOrderIdFromText)
    const originalOrder = {
      id: 200,
      exchangeOrderId: '82472171401084903',
      lifecycleStatus: 'PROTECTED',
      save: jest.fn(),
      side: 'buy',
      symbol: 'SOL_USDT',
    };

    // findDbOrder: first by TP exchangeOrderId (not found), then by linked orderId
    mockOrder.findOne.mockImplementation(({ where }: any) => {
      if (where?.exchangeOrderId === 'tp1-exchange-id') return Promise.resolve(null);
      if (where?.exchangeOrderId === '82472171401084903') return Promise.resolve(originalOrder);
      return Promise.resolve(null);
    });
    mockOrder.findAll.mockResolvedValue([]);
    mockStrategyPosition.findAll.mockResolvedValue([]);
    mockPendingProtection.findByPk.mockResolvedValue(null);

    const mockPipeline = {
      moveStopLossToBreakeven: jest.fn().mockResolvedValue(true),
      cancelProtections: jest.fn(),
    };

    // TP2 still exists → getOpenOrders returns 1 TP
    const mockExchangeWithOpenOrders = {
      ...mockExchange,
      getOpenOrders: jest.fn().mockResolvedValue([
        { id: 'tp-2', text: 't-tp-2-ord-82472171401084903' },
      ]),
      getPriceOrders: jest.fn().mockResolvedValue([]),
      getPosition: jest.fn().mockResolvedValue({ size: '17' }),
    };

    const handler = new (GateIOOrderPersistenceHandler as any)(mockExchangeWithOpenOrders);
    handler.orderModel = mockOrder;
    handler.strategyPositionModel = mockStrategyPosition;
    handler.pendingProtectionModel = mockPendingProtection;
    handler.auditService = mockAuditService;
    handler.protectionPipeline = mockPipeline;

    await handler.handleOrderFilled('tp1-exchange-id', makeRawOrder({
      text: 't-tp-1-ord-82472171401084903',
      is_reduce_only: true,
      size: '-26',
      contract: 'SOL_USDT',
    }));

    // Original entry order must remain PROTECTED (not CLOSED)
    expect(originalOrder.lifecycleStatus).toBe('PROTECTED');
    expect(mockPipeline.moveStopLossToBreakeven).toHaveBeenCalledWith('82472171401084903');
    // cancelProtections should NOT be called (TP2 still exists, position still open)
    expect(mockPipeline.cancelProtections).not.toHaveBeenCalled();
  });

  it('TP1 fill closes original order only when all TPs filled and position closed', async () => {
    const originalOrder = {
      id: 200,
      exchangeOrderId: '82472171401084903',
      lifecycleStatus: 'PROTECTED',
      save: jest.fn(),
      side: 'buy',
      symbol: 'SOL_USDT',
    };

    mockOrder.findOne.mockImplementation(({ where }: any) => {
      if (where?.exchangeOrderId === 'tp1-exchange-id') return Promise.resolve(null);
      if (where?.exchangeOrderId === '82472171401084903') return Promise.resolve(originalOrder);
      return Promise.resolve(null);
    });
    mockOrder.findAll.mockResolvedValue([]);
    mockStrategyPosition.findAll.mockResolvedValue([]);
    mockPendingProtection.findByPk.mockResolvedValue(null);

    const mockPipeline = {
      moveStopLossToBreakeven: jest.fn().mockResolvedValue(true),
      cancelProtections: jest.fn(),
    };

    // No remaining TPs, position closed
    const mockExchangeAllFilled = {
      ...mockExchange,
      getOpenOrders: jest.fn().mockResolvedValue([]),
      getPriceOrders: jest.fn().mockResolvedValue([]),
      getPosition: jest.fn().mockResolvedValue({ size: '0' }),
    };

    const handler = new (GateIOOrderPersistenceHandler as any)(mockExchangeAllFilled);
    handler.orderModel = mockOrder;
    handler.strategyPositionModel = mockStrategyPosition;
    handler.pendingProtectionModel = mockPendingProtection;
    handler.auditService = mockAuditService;
    handler.protectionPipeline = mockPipeline;

    await handler.handleOrderFilled('tp1-exchange-id', makeRawOrder({
      text: 't-tp-1-ord-82472171401084903',
      is_reduce_only: true,
      size: '-43',
      contract: 'SOL_USDT',
    }));

    // All TPs filled and position closed → original order should be CLOSED
    expect(originalOrder.lifecycleStatus).toBe('CLOSED');
    expect(mockPipeline.cancelProtections).toHaveBeenCalledWith('SOL_USDT', 'buy');
  });

  it('TP1 fill does NOT close original order when all TPs filled but position still open', async () => {
    const originalOrder = {
      id: 200,
      exchangeOrderId: '82472171401084903',
      lifecycleStatus: 'PROTECTED',
      save: jest.fn(),
      side: 'buy',
      symbol: 'SOL_USDT',
    };

    mockOrder.findOne.mockImplementation(({ where }: any) => {
      if (where?.exchangeOrderId === 'tp1-exchange-id') return Promise.resolve(null);
      if (where?.exchangeOrderId === '82472171401084903') return Promise.resolve(originalOrder);
      return Promise.resolve(null);
    });
    mockOrder.findAll.mockResolvedValue([]);
    mockStrategyPosition.findAll.mockResolvedValue([]);
    mockPendingProtection.findByPk.mockResolvedValue(null);

    const mockPipeline = {
      moveStopLossToBreakeven: jest.fn().mockResolvedValue(true),
      cancelProtections: jest.fn(),
    };

    // No remaining TPs but position still open (e.g. partial fill scenario)
    const mockExchangePositionOpen = {
      ...mockExchange,
      getOpenOrders: jest.fn().mockResolvedValue([]),
      getPriceOrders: jest.fn().mockResolvedValue([]),
      getPosition: jest.fn().mockResolvedValue({ size: '17' }),
    };

    const handler = new (GateIOOrderPersistenceHandler as any)(mockExchangePositionOpen);
    handler.orderModel = mockOrder;
    handler.strategyPositionModel = mockStrategyPosition;
    handler.pendingProtectionModel = mockPendingProtection;
    handler.auditService = mockAuditService;
    handler.protectionPipeline = mockPipeline;

    await handler.handleOrderFilled('tp1-exchange-id', makeRawOrder({
      text: 't-tp-1-ord-82472171401084903',
      is_reduce_only: true,
      size: '-26',
      contract: 'SOL_USDT',
    }));

    // Position still open → original order stays PROTECTED, SL remains active
    expect(originalOrder.lifecycleStatus).toBe('PROTECTED');
    expect(mockPipeline.cancelProtections).not.toHaveBeenCalled();
  });

  it('SL fill closes original entry order (regression guard)', async () => {
    // When SL triggers, handleOrderFilled should close the original entry order.
    // This test guards against accidentally protecting the order from SL fills too.
    const originalOrder = {
      id: 200,
      exchangeOrderId: '82472171401084903',
      lifecycleStatus: 'PROTECTED',
      save: jest.fn(),
      side: 'buy',
      symbol: 'SOL_USDT',
    };

    mockOrder.findOne.mockResolvedValue(originalOrder);
    mockOrder.findAll.mockResolvedValue([]);
    mockStrategyPosition.findAll.mockResolvedValue([]);
    mockPendingProtection.findByPk.mockResolvedValue(null);

    const handler = new (GateIOOrderPersistenceHandler as any)(mockExchange);
    handler.orderModel = mockOrder;
    handler.strategyPositionModel = mockStrategyPosition;
    handler.pendingProtectionModel = mockPendingProtection;
    handler.auditService = mockAuditService;
    handler.protectionPipeline = null;

    await handler.handleOrderFilled('sl-exchange-id', makeRawOrder({
      text: 'ao-82472171401084903',
      is_reduce_only: true,
      is_close: true,
      size: '-43',
      contract: 'SOL_USDT',
    }));

    // SL fill should close the original order
    expect(originalOrder.lifecycleStatus).toBe('CLOSED');
  });
});