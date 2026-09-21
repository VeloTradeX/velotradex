import { LighterStateReconciler } from '../../../../src/services/exchanges/lighter/LighterStateReconciler';
import { LighterWsStateClient } from '../../../../src/services/exchanges/lighter/LighterWsStateClient';

describe('LighterStateReconciler', () => {
  beforeEach(() => {
    jest.useRealTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('resolves fill waiters when an order is fully filled', async () => {
    const reconciler = new LighterStateReconciler({ journalModel: { findOne: jest.fn() } } as any);
    const waiter = reconciler.waitForFill('1001', 'BTC_USDT', 1000);

    reconciler.handleOrderEvent({
      client_order_index: '1001',
      symbol: 'BTC_USDT',
      status: 'FILLED',
      filled_base_amount: '12345',
      avg_price: '6500012',
    });

    await expect(waiter).resolves.toEqual(expect.objectContaining({
      id: '1001',
      status: 'filled',
      raw: expect.any(Object),
    }));
  });

  it('normalizes short position updates into signed size and exchange fields', () => {
    const reconciler = new LighterStateReconciler({ journalModel: { findOne: jest.fn() } } as any);

    expect(reconciler.normalizePosition({
      symbol: 'BTC_USDT',
      side: 'short',
      size: '0.2',
      entry_price: '65000',
      mark_price: '64000',
      unrealized_pnl: '200',
      leverage: '5',
      margin_mode: 'cross',
    })).toEqual({
      symbol: 'BTC_USDT',
      size: '-0.2',
      entryPrice: '65000',
      markPrice: '64000',
      unrealizedPnl: '200',
      leverage: '5',
      marginType: 'cross',
    });
  });

  it('normalizes documented position shape using position and sign', () => {
    const reconciler = new LighterStateReconciler({ journalModel: { findOne: jest.fn() } } as any);

    expect(reconciler.normalizePosition({
      symbol: 'BTC_USDT',
      sign: -1,
      position: '0.2',
      avg_entry_price: '65000',
      index_price: '64000',
      pnl: '200',
      initial_margin_fraction: '0.2',
      margin_mode: 0,
    })).toEqual({
      symbol: 'BTC_USDT',
      size: '-0.2',
      entryPrice: '65000',
      markPrice: '64000',
      unrealizedPnl: '200',
      leverage: '5',
      marginType: 'cross',
    });
  });

  it('rejects an existing waiter before replacing it for the same client order index', async () => {
    // 用真实计时器（避免 fake timers 污染全局 setImmediate/setTimeout，影响 winston logger）。
    const reconciler = new LighterStateReconciler({ journalModel: { findOne: jest.fn() } } as any);
    const firstWaiter = reconciler.waitForFill('1001', 'BTC_USDT', 1000);
    const secondWaiter = reconciler.waitForFill('1001', 'BTC_USDT', 2000);

    // 第二次 waitForFill 同步 reject 掉第一个 waiter
    await expect(firstWaiter).rejects.toThrow('already waiting');

    reconciler.handleOrderEvent({
      clientOrderIndex: '1001',
      symbol: 'BTC_USDT',
      status: 'FILLED',
      filledBaseAmount: '12345',
      avgPrice: '6500012',
    });

    await expect(secondWaiter).resolves.toEqual(expect.objectContaining({
      id: '1001',
      status: 'filled',
    }));
  });

  it('rejects waiters and emits rejected status for rejected order events', async () => {
    const reconciler = new LighterStateReconciler({ journalModel: { findOne: jest.fn() } } as any);
    const onOrder = jest.fn();
    reconciler.on('order', onOrder);

    const waiter = reconciler.waitForFill('1001', 'BTC_USDT', 1000);

    reconciler.handleOrderEvent({
      client_order_index: '1001',
      symbol: 'BTC_USDT',
      status: 'REJECTED',
    });

    await expect(waiter).rejects.toThrow('rejected');
    expect(onOrder).toHaveBeenCalledWith(expect.objectContaining({
      id: '1001',
      status: 'rejected',
    }));
  });

  it('moves accepted journal rows to final status from order and tx events', async () => {
    const orderJournal = { status: 'ACCEPTED', error: 'old', confirmedAt: null, save: jest.fn().mockResolvedValue(undefined) };
    const txJournal = { status: 'ACCEPTED', error: null, confirmedAt: null, save: jest.fn().mockResolvedValue(undefined) };
    const journalModel = {
      findOne: jest.fn()
        .mockResolvedValueOnce(orderJournal)
        .mockResolvedValueOnce(txJournal),
    };
    const reconciler = new LighterStateReconciler({ journalModel } as any);

    reconciler.handleOrderEvent({
      client_order_index: '1001',
      symbol: 'BTC_USDT',
      status: 'FILLED',
    });
    await new Promise(resolve => setImmediate(resolve));

    expect(orderJournal.status).toBe('CONFIRMED');
    expect(orderJournal.error).toBeNull();
    expect(orderJournal.confirmedAt).toBeInstanceOf(Date);

    reconciler.handleTxEvent({ nonce: '42', status: 'rejected', message: 'sequencer rejected' });
    await new Promise(resolve => setImmediate(resolve));

    expect(txJournal.status).toBe('REJECTED');
    expect(txJournal.error).toBe('sequencer rejected');
    expect(txJournal.confirmedAt).toBeInstanceOf(Date);
  });

  it('treats canceled order events as terminal and confirms the journal', async () => {
    const journal = { status: 'ACCEPTED', error: null, confirmedAt: null, save: jest.fn().mockResolvedValue(undefined) };
    const journalModel = { findOne: jest.fn().mockResolvedValue(journal) };
    const reconciler = new LighterStateReconciler({ journalModel } as any);
    const waiter = reconciler.waitForFill('1001', 'BTC_USDT', 1000);
    const onOrder = jest.fn();
    reconciler.on('order', onOrder);

    reconciler.handleOrderEvent({
      client_order_index: '1001',
      symbol: 'BTC_USDT',
      status: 'canceled',
    });

    await expect(waiter).rejects.toThrow('canceled');
    await new Promise(resolve => setImmediate(resolve));
    expect(onOrder).toHaveBeenCalledWith(expect.objectContaining({ status: 'cancelled' }));
    expect(journal.status).toBe('CONFIRMED');
    expect(journal.confirmedAt).toBeInstanceOf(Date);
  });

  it('splits aggregate websocket order payloads into individual order events', () => {
    const client = new LighterWsStateClient('wss://example.test', 7, () => ({ token: 'token', expiresAt: Date.now() + 60000 }));
    const onOrder = jest.fn();
    client.on('order', onOrder);

    (client as any).onMessage(Buffer.from(JSON.stringify({
      type: 'update/account_all',
      orders: [
        { client_order_index: '1001' },
        { client_order_index: '1002' },
      ],
    })));

    expect(onOrder).toHaveBeenCalledTimes(2);
    expect(onOrder).toHaveBeenNthCalledWith(1, { client_order_index: '1001' });
    expect(onOrder).toHaveBeenNthCalledWith(2, { client_order_index: '1002' });
  });

  it('uses lookup fallback when fill wait times out', async () => {
    const lookupOrder = jest.fn(async () => ({ id: '123', status: 'filled', symbol: 'BTC_USDT' } as any));
    const reconciler = new LighterStateReconciler({
      journalModel: { findOne: jest.fn() },
      lookupOrder,
    } as any);

    await expect(reconciler.waitForFill('123', 'BTC_USDT', 1)).resolves.toEqual({
      id: '123',
      status: 'filled',
      symbol: 'BTC_USDT',
    });
    expect(lookupOrder).toHaveBeenCalledWith('123', 'BTC_USDT');
  });

  it('keeps waiting indefinitely when timeout is disabled', async () => {
    // 用真实计时器：timeout=0 时禁用超时，等待一小段真实时间后应仍未触发 lookup 兜底。
    const lookupOrder = jest.fn(async () => null);
    const reconciler = new LighterStateReconciler({
      journalModel: { findOne: jest.fn() },
      lookupOrder,
    } as any);

    const waiter = reconciler.waitForFill('123', 'BTC_USDT', 0);

    await new Promise(resolve => setTimeout(resolve, 25));
    expect(lookupOrder).not.toHaveBeenCalled();

    reconciler.handleOrderEvent({
      client_order_index: '123',
      symbol: 'BTC_USDT',
      status: 'FILLED',
      filled_base_amount: '0.01138',
      avg_price: '80836.8',
    });

    await expect(waiter).resolves.toEqual(expect.objectContaining({
      id: '123',
      status: 'filled',
    }));
  });

  it('rejects when lookup fallback returns a non-filled order', async () => {
    const lookupOrder = jest.fn(async () => ({ id: '123', status: 'cancelled', symbol: 'BTC_USDT' } as any));
    const reconciler = new LighterStateReconciler({
      journalModel: { findOne: jest.fn() },
      lookupOrder,
    } as any);

    await expect(reconciler.waitForFill('123', 'BTC_USDT', 1)).rejects.toThrow(
      'Timed out waiting for Lighter order fill: 123 BTC_USDT',
    );
    expect(lookupOrder).toHaveBeenCalledWith('123', 'BTC_USDT');
  });

  it('rejects when lookup fallback returns null', async () => {
    const lookupOrder = jest.fn(async () => null);
    const reconciler = new LighterStateReconciler({
      journalModel: { findOne: jest.fn() },
      lookupOrder,
    } as any);

    await expect(reconciler.waitForFill('123', 'BTC_USDT', 1)).rejects.toThrow(
      'Timed out waiting for Lighter order fill: 123 BTC_USDT',
    );
    expect(lookupOrder).toHaveBeenCalledWith('123', 'BTC_USDT');
  });

  it('emits order events from update/account_all with multiple orders', () => {
    const client = new LighterWsStateClient('wss://example.test', 7, () => ({ token: 'token', expiresAt: Date.now() + 60000 }));
    const onOrder = jest.fn();
    client.on('order', onOrder);

    (client as any).onMessage(Buffer.from(JSON.stringify({
      type: 'update/account_all',
      orders: [
        { client_order_index: '1001' },
        { client_order_index: '1002' },
        { client_order_index: '2001' },
      ],
    })));

    expect(onOrder).toHaveBeenCalledTimes(3);
    expect(onOrder).toHaveBeenNthCalledWith(1, { client_order_index: '1001' });
    expect(onOrder).toHaveBeenNthCalledWith(2, { client_order_index: '1002' });
    expect(onOrder).toHaveBeenNthCalledWith(3, { client_order_index: '2001' });
  });
});
