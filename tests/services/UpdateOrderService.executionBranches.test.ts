// tests/services/UpdateOrderService.executionBranches.test.ts
//
// Focused unit tests for the Raizexbt execution-layer branches added to
// UpdateOrderService: risk resize (A1), R-multiple plan (A2) and the
// breakeven-in-loss guard (A3). The service is instantiated directly with a
// fake ClosePositionService so the close pipeline is not exercised here.
import { UpdateOrderService } from '../../src/services/executor/UpdateOrderService';
import { Order, Strategy, StrategyPosition } from '../../src/models';

jest.mock('../../src/models', () => ({
  Order: { findOne: jest.fn(), findAll: jest.fn(), findByPk: jest.fn() },
  Strategy: { findByPk: jest.fn(), update: jest.fn() },
  StrategyPosition: { update: jest.fn() },
  PendingProtection: { destroy: jest.fn() },
  AuditLog: { create: jest.fn() },
  sequelize: { transaction: jest.fn() },
}));

jest.mock('../../src/services/AuditService', () => ({
  __esModule: true,
  default: { log: jest.fn() },
}));

type AnyMock = jest.Mock;

function makeOrder(overrides: Record<string, any> = {}) {
  return {
    id: 1,
    strategyId: 50,
    symbol: 'BTC_USDT',
    side: 'buy',
    exchangeOrderId: 'ex-1',
    exchangeInstanceId: 'gate_1',
    lifecycleStatus: 'OPEN',
    type: 'limit',
    amount: '100',
    price: '65000',
    filledPrice: '65000',
    filledAmount: '100',
    initialSl: '64000',
    currentSl: '64000',
    activeStopLossId: 'old-sl',
    save: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function makeExchange(overrides: Record<string, any> = {}) {
  return {
    getPositions: jest.fn().mockResolvedValue([]),
    getMarkets: jest.fn().mockResolvedValue([
      { symbol: 'BTC_USDT', amountPrecision: 1, pricePrecision: 1 },
    ]),
    getTicker: jest.fn().mockResolvedValue({ symbol: 'BTC_USDT', lastPrice: '65000' }),
    amendOrder: jest.fn().mockResolvedValue({ id: 'ex-1', status: 'updated' }),
    cancelOrder: jest.fn().mockResolvedValue(true),
    placeOrder: jest.fn().mockResolvedValue({ id: 'plan-1', status: 'open' }),
    updateStopLoss: jest.fn().mockResolvedValue('sl-ex'),
    ...overrides,
  };
}

function createService(exchange: any) {
  const auditService = { log: jest.fn().mockResolvedValue(undefined) };
  const orderPersistenceHandler = {
    getOrderTrackedAmount: jest.fn(() => 0),
    updateRelatedMessages: jest.fn(),
  };
  const protectionManager = { placeStopLoss: jest.fn().mockResolvedValue('sl-new') };
  const services = {
    exchangeRegistry: { getExchange: jest.fn(() => exchange) },
    auditService,
    orderPersistenceHandler,
    tradingStatsService: {},
    protectionContext: {
      getProtectionManager: jest.fn(() => protectionManager),
      getProtectionPipeline: jest.fn(),
    },
  };
  const closeService = { handleClose: jest.fn() };
  const service = new UpdateOrderService(services as any, closeService as any);
  return { service, services, auditService, orderPersistenceHandler, protectionManager, closeService };
}

describe('UpdateOrderService — risk resize (A1)', () => {
  beforeEach(() => {
    (Order.findOne as unknown as AnyMock).mockReset();
    (Strategy.findByPk as unknown as AnyMock).mockReset();
    (Strategy.update as unknown as AnyMock).mockReset();
    (StrategyPosition.update as unknown as AnyMock).mockReset();
  });

  it('reduces a live position by the ratio needed to reach the target riskMultiplier', async () => {
    const exchange = makeExchange({
      getPositions: jest.fn().mockResolvedValue([
        { symbol: 'BTC_USDT', size: '100', entryPrice: '65000' },
      ]),
    });
    const { service, closeService, auditService } = createService(exchange);
    const targetOrder = makeOrder({ lifecycleStatus: 'PROTECTED' });
    (Order.findOne as unknown as AnyMock).mockResolvedValue(targetOrder);
    (Strategy.findByPk as unknown as AnyMock).mockResolvedValue({ riskMultiplier: 1 });
    const closeResult = { id: 'close-pos', status: 'filled', amount: '50' };
    closeService.handleClose.mockResolvedValue(closeResult);

    const result = await service.handleUpdate(
      { action: 'update', symbol: 'BTC_USDT', side: 'buy', riskResize: true, riskMultiplier: 0.5, raw: {} },
      50,
      'gate_1',
      'raizexbt-test',
      undefined,
    );

    expect(result).toBe(closeResult);
    expect(closeService.handleClose).toHaveBeenCalledTimes(1);
    expect(closeService.handleClose).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'close',
        symbol: 'BTC_USDT',
        side: 'buy',
        closePercentage: 50,
        keepPartialProtections: true,
      }),
      'raizexbt-test',
      undefined,
      50,
      'buy',
      'gate_1',
    );
    expect(Strategy.update).toHaveBeenCalledWith(
      { riskMultiplier: 0.5 },
      { where: { id: 50 } },
    );
    expect(auditService.log).toHaveBeenCalledWith(
      50,
      'RISK_RESIZED',
      expect.objectContaining({ targetMultiplier: 0.5, baseMultiplier: 1, closePercentage: 50 }),
    );
  });

  it('does nothing when the target multiplier is >= the current base', async () => {
    const exchange = makeExchange({
      getPositions: jest.fn().mockResolvedValue([
        { symbol: 'BTC_USDT', size: '100', entryPrice: '65000' },
      ]),
    });
    const { service, closeService } = createService(exchange);
    (Order.findOne as unknown as AnyMock).mockResolvedValue(makeOrder({ lifecycleStatus: 'PROTECTED' }));
    (Strategy.findByPk as unknown as AnyMock).mockResolvedValue({ riskMultiplier: 1 });

    const result = await service.handleUpdate(
      { action: 'update', symbol: 'BTC_USDT', side: 'buy', riskResize: true, riskMultiplier: 1, raw: {} },
      50,
      'gate_1',
    );

    expect(result).toBeNull();
    expect(closeService.handleClose).not.toHaveBeenCalled();
    expect(Strategy.update).not.toHaveBeenCalled();
  });

  it('amends an unfilled entry order when no live position exists', async () => {
    const exchange = makeExchange();
    const { service, auditService } = createService(exchange);
    const pendingOrder = makeOrder({ id: 7, strategyId: 9, exchangeOrderId: 'ex-7', lifecycleStatus: 'PENDING' });
    (Order.findOne as unknown as AnyMock).mockResolvedValue(pendingOrder);
    (Strategy.findByPk as unknown as AnyMock).mockResolvedValue({ riskMultiplier: 1 });
    (Strategy.update as unknown as AnyMock).mockResolvedValue([1]);
    (StrategyPosition.update as unknown as AnyMock).mockResolvedValue([1]);

    const result = await service.handleUpdate(
      { action: 'update', symbol: 'BTC_USDT', riskResize: true, riskMultiplier: 2, raw: {} },
      undefined,
      'gate_1',
    );

    // 100 contracts × (2 / 1) = 200, formatted to amountPrecision 1.
    expect(exchange.amendOrder).toHaveBeenCalledWith('ex-7', 'BTC_USDT', undefined, '200.0');
    expect(pendingOrder.amount).toBe('200.0');
    expect(pendingOrder.save).toHaveBeenCalled();
    expect(StrategyPosition.update).toHaveBeenCalledWith(
      expect.objectContaining({ totalSize: '200.0', remainingSize: '200.0' }),
      expect.objectContaining({ where: expect.objectContaining({ orderId: 7, status: 'OPEN' }) }),
    );
    expect(Strategy.update).toHaveBeenCalledWith(
      { riskMultiplier: 2 },
      { where: { id: 9 } },
    );
    expect(auditService.log).toHaveBeenCalledWith(
      9,
      'RISK_RESIZED_PENDING',
      expect.objectContaining({ oldAmount: '100', newAmount: '200.0' }),
    );
    expect(result).toEqual({ id: 'ex-7', status: 'updated', amount: '200.0' });
  });

  it('returns null (does not crash) when amendOrder throws', async () => {
    const exchange = makeExchange({ amendOrder: jest.fn().mockRejectedValue(new Error('amend rejected')) });
    const { service } = createService(exchange);
    const pendingOrder = makeOrder({ id: 7, strategyId: 9, exchangeOrderId: 'ex-7', lifecycleStatus: 'INIT' });
    (Order.findOne as unknown as AnyMock).mockResolvedValue(pendingOrder);
    (Strategy.findByPk as unknown as AnyMock).mockResolvedValue({ riskMultiplier: 1 });

    const result = await service.handleUpdate(
      { action: 'update', symbol: 'BTC_USDT', riskResize: true, riskMultiplier: 0.5, raw: {} },
      undefined,
      'gate_1',
    );

    expect(result).toBeNull();
    expect(pendingOrder.save).not.toHaveBeenCalled();
  });
});

describe('UpdateOrderService — R-multiple management plan (A2)', () => {
  beforeEach(() => {
    (Order.findOne as unknown as AnyMock).mockReset();
  });

  it('places a reduce-only TP1-tagged limit order at entry + N*R for 50% of the position', async () => {
    const exchange = makeExchange({
      getPositions: jest.fn().mockResolvedValue([
        { symbol: 'BTC_USDT', size: '100', entryPrice: '65000' },
      ]),
    });
    const { service, auditService } = createService(exchange);
    const targetOrder = makeOrder({ lifecycleStatus: 'PROTECTED' });
    (Order.findOne as unknown as AnyMock).mockResolvedValue(targetOrder);

    // entry=65000, SL=64000 → R=1000; planR=2 → 67000; amount = 100 × 50% = 50.
    const result = await service.handleUpdate(
      { action: 'update', symbol: 'BTC_USDT', side: 'buy', planRMultiple: 2, planClosePercentage: 50, raw: {} },
      50,
      'gate_1',
    );

    expect(exchange.placeOrder).toHaveBeenCalledTimes(1);
    expect(exchange.placeOrder).toHaveBeenCalledWith(expect.objectContaining({
      symbol: 'BTC_USDT',
      side: 'sell',
      amount: '50.0',
      reduceOnly: true,
      type: 'limit',
      price: '67000.0',
      text: 't-tp-1-ord-ex-1',
      timeInForce: 'GTC',
    }));
    expect(result).toEqual({ id: 'plan-1', status: 'placed', price: '67000.0', amount: '50.0' });
    expect(auditService.log).toHaveBeenCalledWith(
      50,
      'R_MULTIPLE_PLAN_PLACED',
      expect.objectContaining({ planRMultiple: 2, planPrice: '67000.0', amount: '50.0', reduceOnly: true }),
    );
  });

  it('never opens a position: no live position → returns null without placing', async () => {
    const exchange = makeExchange();
    const { service } = createService(exchange);
    (Order.findOne as unknown as AnyMock).mockResolvedValue(makeOrder({ lifecycleStatus: 'PROTECTED' }));

    const result = await service.handleUpdate(
      { action: 'update', symbol: 'BTC_USDT', side: 'buy', planRMultiple: 1.5, raw: {} },
      50,
      'gate_1',
    );

    expect(result).toBeNull();
    expect(exchange.placeOrder).not.toHaveBeenCalled();
  });
});

describe('UpdateOrderService — breakeven-in-loss guard (A3)', () => {
  beforeEach(() => {
    (Order.findOne as unknown as AnyMock).mockReset();
  });

  function inLossLongExchange(overrides: Record<string, any> = {}) {
    return makeExchange({
      getPositions: jest.fn().mockResolvedValue([
        { symbol: 'BTC_USDT', size: '100', entryPrice: '65000' },
      ]),
      getTicker: jest.fn().mockResolvedValue({ symbol: 'BTC_USDT', lastPrice: '64000' }),
      ...overrides,
    });
  }

  it("mode='protect' restores the original SL instead of moving to BE / market closing", async () => {
    const exchange = inLossLongExchange();
    const { service, protectionManager, closeService, auditService } = createService(exchange);
    const targetOrder = makeOrder();
    (Order.findOne as unknown as AnyMock).mockResolvedValue(targetOrder);
    protectionManager.placeStopLoss.mockResolvedValue('restored-sl');

    const result = await service.handleUpdate(
      { action: 'update', symbol: 'BTC_USDT', side: 'buy', stopLoss: 'breakeven', breakevenMode: 'protect', raw: {} },
      50,
      'gate_1',
      'raizexbt-test',
    );

    expect(result).toEqual({ id: 'update-sl-restored', status: 'filled', symbol: 'BTC_USDT' });
    expect(protectionManager.placeStopLoss).toHaveBeenCalledWith(expect.objectContaining({
      symbol: 'BTC_USDT',
      side: 'buy',
      stopLossPrice: '64000.0',
      amount: '100',
    }));
    expect(closeService.handleClose).not.toHaveBeenCalled();
    expect(exchange.updateStopLoss).not.toHaveBeenCalled();
    expect(targetOrder.currentSl).toBe('64000.0');
    expect(targetOrder.activeStopLossId).toBe('restored-sl');
    expect(auditService.log).toHaveBeenCalledWith(
      50,
      'BREAKEVEN_SKIPPED_IN_LOSS_RESTORED_SL',
      expect.objectContaining({ restoredSlPrice: '64000.0', lastPrice: 64000 }),
    );
  });

  it("mode='exit_at_entry' places a reduce-only limit close at entry and keeps protections", async () => {
    const exchange = inLossLongExchange();
    const { service, closeService, protectionManager, auditService } = createService(exchange);
    (Order.findOne as unknown as AnyMock).mockResolvedValue(makeOrder());
    const closeResult = { id: 'close-pos', status: 'filled', amount: '100' };
    closeService.handleClose.mockResolvedValue(closeResult);

    const result = await service.handleUpdate(
      { action: 'update', symbol: 'BTC_USDT', side: 'buy', stopLoss: 'breakeven', breakevenMode: 'exit_at_entry', raw: {} },
      50,
      'gate_1',
      'raizexbt-test',
    );

    expect(result).toBe(closeResult);
    expect(closeService.handleClose).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'close',
        symbol: 'BTC_USDT',
        side: 'buy',
        closePercentage: 100,
        closePrice: '65000.0',
        keepPartialProtections: true,
      }),
      'raizexbt-test',
      undefined,
      50,
      'buy',
      'gate_1',
    );
    // existing SL must not be touched by the guard itself
    expect(protectionManager.placeStopLoss).not.toHaveBeenCalled();
    expect(exchange.updateStopLoss).not.toHaveBeenCalled();
    expect(auditService.log).toHaveBeenCalledWith(
      50,
      'BREAKEVEN_EXIT_LIMIT_PLACED',
      expect.objectContaining({ entryPrice: '65000.0', lastPrice: 64000 }),
    );
  });

  it('falls through to the normal BE placement when price is still favorable', async () => {
    const exchange = makeExchange({
      getPositions: jest.fn().mockResolvedValue([
        { symbol: 'BTC_USDT', size: '100', entryPrice: '65000' },
      ]),
      getTicker: jest.fn().mockResolvedValue({ symbol: 'BTC_USDT', lastPrice: '66000' }),
    });
    const { service, protectionManager, closeService } = createService(exchange);
    (Order.findOne as unknown as AnyMock).mockResolvedValue(makeOrder());

    const result = await service.handleUpdate(
      { action: 'update', symbol: 'BTC_USDT', side: 'buy', stopLoss: 'breakeven', breakevenMode: 'protect', raw: {} },
      50,
      'gate_1',
    );

    expect(result).toEqual({ id: 'update-sl', status: 'filled', symbol: 'BTC_USDT' });
    expect(protectionManager.placeStopLoss).toHaveBeenCalledWith(expect.objectContaining({
      stopLossPrice: '65000.0',
    }));
    expect(closeService.handleClose).not.toHaveBeenCalled();
  });

  it("mode='protect': a failed BE placement must NOT market-close", async () => {
    const exchange = makeExchange({
      getPositions: jest.fn().mockResolvedValue([
        { symbol: 'BTC_USDT', size: '100', entryPrice: '65000' },
      ]),
      getTicker: jest.fn().mockResolvedValue({ symbol: 'BTC_USDT', lastPrice: '66000' }),
    });
    const { service, protectionManager, closeService } = createService(exchange);
    (Order.findOne as unknown as AnyMock).mockResolvedValue(makeOrder());
    protectionManager.placeStopLoss.mockResolvedValue(null);

    const result = await service.handleUpdate(
      { action: 'update', symbol: 'BTC_USDT', side: 'buy', stopLoss: 'breakeven', breakevenMode: 'protect', raw: {} },
      50,
      'gate_1',
    );

    expect(result).toEqual({ id: 'update-sl-failed', status: 'failed', symbol: 'BTC_USDT' });
    expect(closeService.handleClose).not.toHaveBeenCalled();
  });

  it('legacy breakeven (no breakevenMode) keeps the market-close fallback on placement failure', async () => {
    const exchange = makeExchange({
      getPositions: jest.fn().mockResolvedValue([
        { symbol: 'BTC_USDT', size: '100', entryPrice: '65000' },
      ]),
      getTicker: jest.fn().mockResolvedValue({ symbol: 'BTC_USDT', lastPrice: '66000' }),
    });
    const { service, protectionManager, closeService } = createService(exchange);
    (Order.findOne as unknown as AnyMock).mockResolvedValue(makeOrder());
    protectionManager.placeStopLoss.mockResolvedValue(null);
    const closeResult = { id: 'close-pos', status: 'filled' };
    closeService.handleClose.mockResolvedValue(closeResult);

    const result = await service.handleUpdate(
      { action: 'update', symbol: 'BTC_USDT', side: 'buy', stopLoss: 'breakeven', raw: {} },
      50,
      'gate_1',
    );

    expect(result).toBe(closeResult);
    expect(closeService.handleClose).toHaveBeenCalledTimes(1);
    expect(closeService.handleClose).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'close', closePercentage: 100 }),
      expect.any(String),
      undefined,
      50,
      'buy',
      'gate_1',
    );
  });
});

describe('UpdateOrderService — reply-chain cancel targeting', () => {
  beforeEach(() => {
    (Order.findOne as unknown as AnyMock).mockReset();
    (Order.findByPk as unknown as AnyMock).mockReset();
  });

  function makePendingOrder(overrides: Record<string, any> = {}) {
    return {
      id: 77,
      strategyId: 300,
      exchangeInstanceId: 'gate_1',
      exchangeOrderId: 'ex-reply',
      symbol: 'BTC_USDT',
      side: 'buy',
      lifecycleStatus: 'PENDING',
      status: 'pending',
      save: jest.fn().mockResolvedValue(undefined),
      ...overrides,
    };
  }

  it('cancels the exact order referenced by replyOrderId (local Order.id)', async () => {
    const exchange = makeExchange();
    const { service, auditService, orderPersistenceHandler } = createService(exchange);
    const pendingOrder = makePendingOrder();
    (Order.findByPk as unknown as AnyMock).mockResolvedValue(pendingOrder);

    const result = await service.handleCancel(
      { action: 'cancel', symbol: 'BTC_USDT', replyOrderId: 77, raw: {} },
      50,
      'gate_1',
      19,
    );

    expect(Order.findByPk).toHaveBeenCalledWith(77);
    expect(exchange.cancelOrder).toHaveBeenCalledWith('ex-reply', 'BTC_USDT');
    expect(pendingOrder.status).toBe('cancelled');
    expect(pendingOrder.lifecycleStatus).toBe('CLOSED');
    expect(pendingOrder.save).toHaveBeenCalled();
    expect(orderPersistenceHandler.updateRelatedMessages).toHaveBeenCalledWith(pendingOrder, 50);
    expect(auditService.log).toHaveBeenCalledWith(
      50,
      'CANCELLING_ORDER',
      expect.objectContaining({ orderId: 'ex-reply', reason: 'reply_order_id_cancel' }),
    );
    expect(auditService.log).toHaveBeenCalledWith(
      50,
      'ORDER_CLOSED_CANCEL',
      expect.objectContaining({ orderId: 77, reason: 'reply_order_id_cancel' }),
      undefined,
      'CLOSED',
    );
    expect(result).toEqual({ id: 'ex-reply', status: 'cancelled', symbol: 'BTC_USDT' });
    // The symbol-wide scoped lookup must not run when the reply target was resolved.
    expect(Order.findOne).not.toHaveBeenCalled();
  });

  it('cancels the latest INIT/PENDING order for replyStrategyId', async () => {
    const exchange = makeExchange();
    const { service } = createService(exchange);
    const pendingOrder = makePendingOrder({ id: 88, exchangeOrderId: 'ex-strategy' });
    (Order.findOne as unknown as AnyMock).mockResolvedValue(pendingOrder);

    const result = await service.handleCancel(
      { action: 'cancel', symbol: 'BTC_USDT', replyStrategyId: 300, raw: {} },
      50,
      'gate_1',
      19,
    );

    expect(Order.findOne).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        strategyId: 300,
        symbol: 'BTC_USDT',
        exchangeInstanceId: 'gate_1',
      }),
    }));
    expect(Order.findByPk).not.toHaveBeenCalled();
    expect(exchange.cancelOrder).toHaveBeenCalledWith('ex-strategy', 'BTC_USDT');
    expect(result).toEqual({ id: 'ex-strategy', status: 'cancelled', symbol: 'BTC_USDT' });
  });

  it('falls back to the scoped symbol lookup when replyOrderId is not an unfilled entry', async () => {
    const exchange = makeExchange();
    const { service } = createService(exchange);
    (Order.findByPk as unknown as AnyMock).mockResolvedValue(
      makePendingOrder({ lifecycleStatus: 'OPEN', exchangeOrderId: 'ex-old' }),
    );
    const scopedOrder = makePendingOrder({ id: 88, exchangeOrderId: 'ex-scoped' });
    (Order.findOne as unknown as AnyMock).mockResolvedValue(scopedOrder);

    const result = await service.handleCancel(
      { action: 'cancel', symbol: 'BTC_USDT', replyOrderId: 77, raw: {} },
      50,
      'gate_1',
      19,
    );

    expect(Order.findByPk).toHaveBeenCalledWith(77);
    expect(exchange.cancelOrder).toHaveBeenCalledWith('ex-scoped', 'BTC_USDT');
    expect(result).toEqual({ id: 'ex-scoped', status: 'cancelled', symbol: 'BTC_USDT' });
  });

  it('keeps the legacy scoped behavior when no reply-chain fields are present', async () => {
    const exchange = makeExchange();
    const { service } = createService(exchange);
    (Order.findOne as unknown as AnyMock).mockResolvedValue(null);

    const result = await service.handleCancel(
      { action: 'cancel', symbol: 'BTC_USDT', raw: {} },
      50,
      'gate_1',
      19,
    );

    expect(result).toBeNull();
    expect(Order.findByPk).not.toHaveBeenCalled();
    expect(exchange.cancelOrder).not.toHaveBeenCalled();
  });
});
