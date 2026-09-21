import { VirtualMatchingEngine } from '../../../src/services/exchanges/virtual/VirtualMatchingEngine';

describe('VirtualMatchingEngine', () => {
  const createStore = (position: any = null) => ({
    getPosition: jest.fn().mockResolvedValue(position),
    recordFill: jest.fn().mockResolvedValue(undefined),
    cancelInvalidReduceOnlyOrder: jest.fn().mockResolvedValue(true),
  });

  it('matches market entry and then long TP with realized pnl', async () => {
    const store: any = createStore();
    const engine = new VirtualMatchingEngine(store, { exchangeInstanceId: 'v1', multiplierBySymbol: () => 0.0001 });

    const entry = await engine.fillOrder({
      virtualOrderId: 'vo-entry',
      exchangeInstanceId: 'v1',
      symbol: 'BTC_USDT',
      side: 'buy',
      amount: '100',
      price: null,
      text: 'entry',
      reduceOnly: false,
      orderRole: 'entry',
    } as any, '65000');

    store.getPosition.mockResolvedValue({ size: '100', entryPrice: '65000', realizedPnl: '0', save: jest.fn() });

    const exit = await engine.fillOrder({
      virtualOrderId: 'vo-tp',
      exchangeInstanceId: 'v1',
      symbol: 'BTC_USDT',
      side: 'sell',
      amount: '100',
      price: '66000',
      text: 'tp',
      reduceOnly: true,
      orderRole: 'tp',
    } as any, '66000');

    expect(entry.realizedPnl).toBe(0);
    expect(exit.realizedPnl).toBe(10);
    expect(store.recordFill).toHaveBeenCalledTimes(2);
  });

  it('detects long limit and protection triggers from lastPrice', () => {
    const engine = new VirtualMatchingEngine({} as any, { exchangeInstanceId: 'v1', multiplierBySymbol: () => 1 });
    expect(engine.shouldFillLimit({ side: 'buy', price: '100' } as any, 99)).toBe(true);
    expect(engine.shouldFillLimit({ side: 'sell', price: '100' } as any, 101)).toBe(true);
    expect(engine.shouldTriggerProtection({ orderRole: 'sl', parentSide: 'buy', triggerPrice: '95' } as any, 94)).toBe(true);
    expect(engine.shouldTriggerProtection({ orderRole: 'tp', parentSide: 'buy', price: '110' } as any, 111)).toBe(true);
  });

  it('rejects invalid limit side even when sell logic would match', () => {
    const engine = new VirtualMatchingEngine({} as any, { exchangeInstanceId: 'v1', multiplierBySymbol: () => 1 });
    expect(engine.shouldFillLimit({ side: 'hold', price: '100' } as any, 101)).toBe(false);
  });

  it('cancels same-direction reduceOnly without writing fill records', async () => {
    const store = createStore({ size: '100', entryPrice: '65000' });
    const engine = new VirtualMatchingEngine(store as any, { exchangeInstanceId: 'v1', multiplierBySymbol: () => 0.0001 });

    await expect(engine.fillOrder({
      virtualOrderId: 'vo-bad-ro',
      symbol: 'BTC_USDT',
      side: 'buy',
      amount: '10',
      reduceOnly: true,
      orderRole: 'close',
    } as any, '66000')).resolves.toEqual({ realizedPnl: 0, filled: false });

    expect(store.recordFill).not.toHaveBeenCalled();
    expect(store.cancelInvalidReduceOnlyOrder).toHaveBeenCalledWith(
      expect.objectContaining({ virtualOrderId: 'vo-bad-ro' }),
      'Invalid reduce-only direction',
    );
  });

  it('cancels reduceOnly with no position without writing fill records', async () => {
    const store = createStore(null);
    const engine = new VirtualMatchingEngine(store as any, { exchangeInstanceId: 'v1', multiplierBySymbol: () => 0.0001 });

    await expect(engine.fillOrder({
      virtualOrderId: 'vo-stale-ro',
      symbol: 'BTC_USDT',
      side: 'sell',
      amount: '10',
      reduceOnly: true,
      orderRole: 'sl',
    } as any, '63000')).resolves.toEqual({ realizedPnl: 0, filled: false });

    expect(store.recordFill).not.toHaveBeenCalled();
    expect(store.cancelInvalidReduceOnlyOrder).toHaveBeenCalledWith(
      expect.objectContaining({ virtualOrderId: 'vo-stale-ro' }),
      'Invalid reduce-only direction',
    );
  });

  it('does not reverse on oversized reduceOnly close', async () => {
    const store = createStore({ size: '100', entryPrice: '65000' });
    const engine = new VirtualMatchingEngine(store as any, { exchangeInstanceId: 'v1', multiplierBySymbol: () => 0.0001 });

    const result = await engine.fillOrder({
      virtualOrderId: 'vo-oversized',
      symbol: 'BTC_USDT',
      side: 'sell',
      amount: '150',
      reduceOnly: true,
      orderRole: 'close',
    } as any, '66000');

    expect(result.realizedPnl).toBe(10);
    expect(store.recordFill).toHaveBeenCalledWith(expect.objectContaining({
      position: { symbol: 'BTC_USDT', size: '0', entryPrice: '0', markPrice: '66000' },
      filledAmount: '100',
      trade: expect.objectContaining({ amount: '100', realizedPnl: '10' }),
    }));
  });

  it('calculates short realized PnL on reduceOnly close', async () => {
    const store = createStore({ size: '-100', entryPrice: '65000' });
    const engine = new VirtualMatchingEngine(store as any, { exchangeInstanceId: 'v1', multiplierBySymbol: () => 0.0001 });

    const result = await engine.fillOrder({
      virtualOrderId: 'vo-short-close',
      symbol: 'BTC_USDT',
      side: 'buy',
      amount: '100',
      reduceOnly: true,
      orderRole: 'close',
    } as any, '64000');

    expect(result.realizedPnl).toBe(10);
    expect(store.recordFill).toHaveBeenCalledWith(expect.objectContaining({
      position: { symbol: 'BTC_USDT', size: '0', entryPrice: '0', markPrice: '64000' },
    }));
  });

  it('preserves entry and realizes PnL on non-reduceOnly partial opposite fill', async () => {
    const store = createStore({ size: '100', entryPrice: '65000' });
    const engine = new VirtualMatchingEngine(store as any, { exchangeInstanceId: 'v1', multiplierBySymbol: () => 0.0001 });

    const result = await engine.fillOrder({
      virtualOrderId: 'vo-partial-reduce',
      symbol: 'BTC_USDT',
      side: 'sell',
      amount: '40',
      reduceOnly: false,
      orderRole: 'entry',
    } as any, '66000');

    expect(result.realizedPnl).toBe(4);
    expect(store.recordFill).toHaveBeenCalledWith(expect.objectContaining({
      position: { symbol: 'BTC_USDT', size: '60', entryPrice: '65000', markPrice: '66000' },
      trade: expect.objectContaining({ realizedPnl: '4' }),
    }));
  });

  it('rejects invalid amount price and side before persistence', async () => {
    const cases = [
      { order: { side: 'hold', amount: '10' }, fillPrice: '65000', error: 'Invalid order side' },
      { order: { side: 'buy', amount: '0' }, fillPrice: '65000', error: 'Invalid order amount' },
      { order: { side: 'buy', amount: '-10' }, fillPrice: '65000', error: 'Invalid order amount' },
      { order: { side: 'buy', amount: '10' }, fillPrice: '0', error: 'Invalid fill price' },
    ];

    for (const item of cases) {
      const store = createStore();
      const engine = new VirtualMatchingEngine(store as any, { exchangeInstanceId: 'v1', multiplierBySymbol: () => 0.0001 });

      await expect(engine.fillOrder({
        virtualOrderId: 'vo-invalid',
        symbol: 'BTC_USDT',
        reduceOnly: false,
        orderRole: 'entry',
        ...item.order,
      } as any, item.fillPrice)).rejects.toThrow(item.error);

      expect(store.getPosition).not.toHaveBeenCalled();
      expect(store.recordFill).not.toHaveBeenCalled();
    }
  });

  it('rejects invalid multiplier before persistence', async () => {
    for (const multiplier of [0, Number.NaN]) {
      const store = createStore();
      const engine = new VirtualMatchingEngine(store as any, { exchangeInstanceId: 'v1', multiplierBySymbol: () => multiplier });

      await expect(engine.fillOrder({
        virtualOrderId: 'vo-bad-multiplier',
        symbol: 'BTC_USDT',
        side: 'buy',
        amount: '10',
        reduceOnly: false,
        orderRole: 'entry',
      } as any, '65000')).rejects.toThrow('Invalid contract multiplier');

      expect(store.getPosition).not.toHaveBeenCalled();
      expect(store.recordFill).not.toHaveBeenCalled();
    }
  });

  it('rejects invalid current position values before persistence', async () => {
    const cases = [
      { position: { size: 'abc', entryPrice: '65000' }, error: 'Invalid current position size' },
      { position: { size: '100', entryPrice: 'abc' }, error: 'Invalid current entry price' },
    ];

    for (const item of cases) {
      const store = createStore(item.position);
      const engine = new VirtualMatchingEngine(store as any, { exchangeInstanceId: 'v1', multiplierBySymbol: () => 0.0001 });

      await expect(engine.fillOrder({
        virtualOrderId: 'vo-bad-position',
        symbol: 'BTC_USDT',
        side: 'sell',
        amount: '10',
        reduceOnly: true,
        orderRole: 'close',
      } as any, '65000')).rejects.toThrow(item.error);

      expect(store.recordFill).not.toHaveBeenCalled();
    }
  });

  it('records successful fill atomically with position order and trade payloads', async () => {
    const store = createStore();
    const order = {
      virtualOrderId: 'vo-atomic',
      symbol: 'BTC_USDT',
      side: 'buy',
      type: 'limit',
      amount: '100',
      reduceOnly: false,
      orderRole: 'entry',
      text: 'entry',
    };
    const engine = new VirtualMatchingEngine(store as any, { exchangeInstanceId: 'v1', multiplierBySymbol: () => 0.0001 });

    const result = await engine.fillOrder(order as any, '65000');

    expect(result.realizedPnl).toBe(0);
    expect(store.recordFill).toHaveBeenCalledTimes(1);
    expect(store.recordFill).toHaveBeenCalledWith({
      position: { symbol: 'BTC_USDT', size: '100', entryPrice: '65000', markPrice: '65000' },
      order,
      fillPrice: '65000',
      filledAmount: '100',
      trade: expect.objectContaining({
        virtualOrderId: 'vo-atomic',
        symbol: 'BTC_USDT',
        side: 'buy',
        price: '65000',
        amount: '100',
        role: 'maker',
        realizedPnl: '0',
        text: 'entry',
      }),
      realizedPnl: 0,
    });
  });
});
