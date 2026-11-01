import { Order, PendingProtection, StrategyPosition } from '../../src/models';
import { PendingEntryService } from '../../src/services/executor/PendingEntryService';
import { ParsedStrategy } from '../../src/services/parsers/types';

function makeOrder(overrides: Record<string, any> = {}) {
  return {
    id: 136,
    strategyId: 222,
    exchangeInstanceId: 'gate_main',
    exchangeOrderId: 'ex-136',
    symbol: 'BTC_USDT',
    side: 'buy',
    amount: '98',
    price: '79820.1',
    status: 'open',
    lifecycleStatus: 'PENDING',
    save: jest.fn(async () => undefined),
    ...overrides,
  };
}

function makeService(options: { positions?: any[]; cancelResult?: boolean } = {}) {
  const exchange = {
    getPositions: jest.fn(async () => options.positions ?? []),
    cancelOrder: jest.fn(async () => options.cancelResult ?? true),
  };
  const registry = { getExchange: jest.fn(() => exchange) };
  const audit = { log: jest.fn(async () => undefined) };
  return {
    exchange,
    audit,
    service: new PendingEntryService(registry as any, audit as any),
  };
}

const beUpdate: ParsedStrategy = {
  action: 'update',
  symbol: 'BTC_USDT',
  stopLoss: 'breakeven',
  replyStrategyId: 222,
  replyOrderId: 136,
  raw: { routeId: 11 },
};

describe('PendingEntryService.cancelUnfilledEntry', () => {
  it('cancels a pending entry when a breakeven update arrives before fill', async () => {
    const order = makeOrder();
    jest.spyOn(Order, 'findOne').mockResolvedValue(order as any);
    jest.spyOn(PendingProtection, 'destroy').mockResolvedValue(1 as any);
    jest.spyOn(StrategyPosition, 'update').mockResolvedValue([1] as any);

    const { service, exchange, audit } = makeService();
    const result = await service.cancelUnfilledEntry({
      parsed: beUpdate,
      exchangeInstanceId: 'gate_main',
      strategyId: 226,
      reason: 'breakeven-update-before-entry-fill',
    });

    expect(exchange.cancelOrder).toHaveBeenCalledWith('ex-136', 'BTC_USDT');
    expect(order.save).toHaveBeenCalled();
    expect(result?.status).toBe('cancelled');
    expect(result?.id).toBe('ex-136');
    expect(audit.log).toHaveBeenCalledWith(
      expect.any(Number),
      'PENDING_ENTRY_CANCELLED',
      expect.objectContaining({ symbol: 'BTC_USDT' }),
      expect.any(Number),
      'CLOSED',
      'gate_main',
    );
  });

  it('does not cancel when a live position exists (normal management path)', async () => {
    const order = makeOrder();
    jest.spyOn(Order, 'findOne').mockResolvedValue(order as any);

    const { service, exchange } = makeService({ positions: [{ symbol: 'BTC_USDT', size: '98' }] });
    const result = await service.cancelUnfilledEntry({
      parsed: beUpdate,
      exchangeInstanceId: 'gate_main',
      reason: 'breakeven-update-before-entry-fill',
    });

    expect(result).toBeNull();
    expect(exchange.cancelOrder).not.toHaveBeenCalled();
  });

  it('cancels a pending entry on a close/cut signal', async () => {
    const order = makeOrder({ id: 137, strategyId: 224, symbol: 'TAO_USDT', exchangeOrderId: 'ex-137' });
    jest.spyOn(Order, 'findOne').mockResolvedValue(order as any);
    jest.spyOn(PendingProtection, 'destroy').mockResolvedValue(1 as any);
    jest.spyOn(StrategyPosition, 'update').mockResolvedValue([1] as any);

    const { service, exchange } = makeService();
    const result = await service.cancelUnfilledEntry({
      parsed: {
        action: 'close',
        symbol: 'TAO_USDT',
        closePercentage: 100,
        replyStrategyId: 224,
        replyOrderId: 137,
        raw: {},
      },
      exchangeInstanceId: 'gate_main',
      reason: 'close-signal-before-entry-fill',
    });

    expect(exchange.cancelOrder).toHaveBeenCalledWith('ex-137', 'TAO_USDT');
    expect(result?.status).toBe('cancelled');
  });

  it('refuses to guess when several pending entries match and there is no reply target', async () => {
    jest.spyOn(Order, 'findOne').mockResolvedValue(null as any);
    jest.spyOn(Order, 'findAll').mockResolvedValue([makeOrder({ id: 1 }), makeOrder({ id: 2 })] as any);

    const { service, exchange } = makeService();
    const result = await service.cancelUnfilledEntry({
      parsed: { action: 'close', symbol: 'BTC_USDT', closePercentage: 100, raw: { routeId: 11 } },
      exchangeInstanceId: 'gate_main',
      reason: 'close-signal-before-entry-fill',
    });

    expect(result).toBeNull();
    expect(exchange.cancelOrder).not.toHaveBeenCalled();
  });

  it('does not mark the order cancelled when the exchange rejects the cancel', async () => {
    const order = makeOrder();
    jest.spyOn(Order, 'findOne').mockResolvedValue(order as any);

    const { service } = makeService({ cancelResult: false });
    const result = await service.cancelUnfilledEntry({
      parsed: beUpdate,
      exchangeInstanceId: 'gate_main',
      reason: 'breakeven-update-before-entry-fill',
    });

    expect(result).toBeNull();
    expect(order.save).not.toHaveBeenCalled();
  });
});
