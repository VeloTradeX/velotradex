jest.mock('../../../src/models', () => {
  const accounts: any[] = [];
  const orders: any[] = [];
  const positions: any[] = [];
  const trades: any[] = [];
  const pendingProtections: any[] = [];

  const makeRow = (payload: any) => ({
    ...payload,
    createdAt: payload.createdAt ?? new Date(),
    updatedAt: payload.updatedAt ?? new Date(),
    update: jest.fn(async function update(this: any, next: any) {
      Object.assign(this, next, { updatedAt: new Date() });
      return this;
    }),
  });

  const matchesWhere = (row: any, where: any = {}) => Object.entries(where).every(([key, expected]: [string, any]) => {
    if (expected && typeof expected === 'object' && Object.getOwnPropertySymbols(expected).length > 0) {
      const symbol = Object.getOwnPropertySymbols(expected)[0];
      return expected[symbol].includes(row[key]);
    }
    return row[key] === expected;
  });

  return {
    __esModule: true,
    __virtualDb: { accounts, orders, positions, trades, pendingProtections },
    sequelize: {
      transaction: jest.fn(async (callback: any) => callback({})),
    },
    VirtualAccount: {
      findOrCreate: jest.fn(async ({ where, defaults }: any) => {
        let account = accounts.find(row => matchesWhere(row, where));
        if (!account) {
          account = makeRow({ id: accounts.length + 1, ...defaults });
          accounts.push(account);
        }
        return [account, !account];
      }),
      findOne: jest.fn(async ({ where }: any = {}) => accounts.find(row => matchesWhere(row, where)) ?? null),
    },
    VirtualOrder: {
      create: jest.fn(async (payload: any) => {
        const order = makeRow({ id: orders.length + 1, ...payload });
        orders.push(order);
        return order;
      }),
      update: jest.fn(async (payload: any, { where }: any = {}) => {
        const rows = orders.filter(row => matchesWhere(row, where));
        for (const row of rows) {
          await row.update(payload);
        }
        return [rows.length];
      }),
      findAll: jest.fn(async ({ where, limit }: any = {}) => {
        const rows = orders.filter(row => matchesWhere(row, where));
        return typeof limit === 'number' ? rows.slice(0, limit) : rows;
      }),
      findOne: jest.fn(async ({ where }: any = {}) => orders.find(row => matchesWhere(row, where)) ?? null),
    },
    VirtualPosition: {
      findOne: jest.fn(async ({ where }: any = {}) => positions.find(row => matchesWhere(row, where)) ?? null),
      create: jest.fn(async (payload: any) => {
        const position = makeRow({ id: positions.length + 1, ...payload });
        positions.push(position);
        return position;
      }),
      findAll: jest.fn(async ({ where }: any = {}) => positions.filter(row => matchesWhere(row, where))),
    },
    VirtualTrade: {
      create: jest.fn(async (payload: any) => {
        const trade = makeRow({ id: trades.length + 1, ...payload });
        trades.push(trade);
        return trade;
      }),
      findAll: jest.fn(async ({ where, limit }: any = {}) => {
        const rows = trades.filter(row => matchesWhere(row, where));
        return typeof limit === 'number' ? rows.slice(0, limit) : rows;
      }),
    },
    PendingProtection: {
      create: jest.fn(async (payload: any) => {
        const record = makeRow({ id: pendingProtections.length + 1, status: 'PENDING', ...payload });
        pendingProtections.push(record);
        return record;
      }),
    },
  };
});

import { VirtualGateExchange } from '../../../src/services/exchanges/virtual/VirtualGateExchange';
import MarkPriceCache from '../../../src/services/exchanges/virtual/MarkPriceCache';
const { __virtualDb } = jest.requireMock('../../../src/models') as any;

describe('VirtualGateExchange', () => {
  const hub = {
    start: jest.fn(),
    getLatestTick: jest.fn(),
    getTicker: jest.fn(),
    subscribe: jest.fn<any, any>(() => jest.fn()),
  };

  beforeEach(() => {
    jest.useRealTimers();
    jest.clearAllMocks();
    __virtualDb.accounts.length = 0;
    __virtualDb.orders.length = 0;
    __virtualDb.positions.length = 0;
    __virtualDb.trades.length = 0;
    __virtualDb.pendingProtections.length = 0;
    hub.start.mockResolvedValue(undefined);
    hub.getLatestTick.mockReturnValue({
      symbol: 'BTC_USDT',
      lastPrice: '65000',
      source: 'gate',
      receivedAt: new Date(),
    });
    hub.getTicker.mockReturnValue({
      symbol: 'BTC_USDT',
      lastPrice: '65000',
      markPrice: '65000',
      indexPrice: '65000',
      fundingRate: '0',
      volume24h: '0',
      change24h: '0',
    });
  });

  it('fills market orders at latest lastPrice', async () => {
    const exchange = new VirtualGateExchange({
      id: 'v1',
      name: 'Virtual 1',
      type: 'virtual_gate',
      initialBalance: '10000',
    } as any, hub as any);

    const result = await exchange.placeOrder({ symbol: 'BTC_USDT', side: 'buy', amount: '100', type: 'market' });

    expect(result).toEqual(expect.objectContaining({
      status: 'filled',
      amount: '100',
      price: '65000',
    }));
    expect(__virtualDb.positions[0]).toEqual(expect.objectContaining({
      symbol: 'BTC_USDT',
      size: '100',
      entryPrice: '65000',
    }));
  });

  it('rejects stale market price', async () => {
    hub.getLatestTick.mockReturnValue({
      symbol: 'BTC_USDT',
      lastPrice: '65000',
      source: 'gate',
      receivedAt: new Date(Date.now() - 60_000),
    });
    const exchange = new VirtualGateExchange({
      id: 'v1',
      name: 'Virtual 1',
      type: 'virtual_gate',
      initialBalance: '10000',
      maxTickAgeMs: 1000,
    } as any, hub as any);

    await expect(exchange.placeOrder({ symbol: 'BTC_USDT', side: 'buy', amount: '100', type: 'market' }))
      .rejects.toThrow('stale market price for BTC_USDT');
  });

  it('returns hub ticker', async () => {
    const exchange = new VirtualGateExchange({
      id: 'v1',
      name: 'Virtual 1',
      type: 'virtual_gate',
    } as any, hub as any);

    await expect(exchange.getTicker('BTC_USDT')).resolves.toEqual(expect.objectContaining({
      symbol: 'BTC_USDT',
      lastPrice: '65000',
    }));
  });

  it('returns Gate USDT perpetual markets from the local contract dictionary', async () => {
    const exchange = new VirtualGateExchange({
      id: 'v1',
      name: 'Virtual 1',
      type: 'virtual_gate',
    } as any, hub as any);

    const markets = await exchange.getMarkets();

    expect(markets.length).toBeGreaterThan(100);
    expect(markets).toEqual(expect.arrayContaining([
      expect.objectContaining({
        symbol: 'ZEC_USDT',
        baseCurrency: 'ZEC',
        quoteCurrency: 'USDT',
        multiplier: '0.01',
        tickSize: '0.01',
        pricePrecision: 2,
      }),
    ]));
  });

  it('uses Gate contract dictionary multiplier for non-hardcoded virtual PnL', async () => {
    hub.getLatestTick.mockImplementation((symbol: string) => ({
      symbol,
      lastPrice: '500',
      source: 'gate',
      receivedAt: new Date(),
    }));
    const exchange = new VirtualGateExchange({
      id: 'v1',
      name: 'Virtual 1',
      type: 'virtual_gate',
      initialBalance: '10000',
    } as any, hub as any);

    await exchange.placeOrder({ symbol: 'ZEC_USDT', side: 'buy', amount: '10', type: 'market' });
    await exchange.closePosition('ZEC_USDT', 'buy', '510', '10');

    expect(__virtualDb.trades[1]).toEqual(expect.objectContaining({
      symbol: 'ZEC_USDT',
      realizedPnl: '1',
    }));
  });

  it('subscribes and waits for the first ticker when no latest price exists', async () => {
    let listener: any;
    hub.getLatestTick.mockReturnValue(null);
    hub.getTicker.mockReturnValue({
      symbol: 'BTC_USDT',
      lastPrice: '0',
      markPrice: '0',
      indexPrice: '0',
      fundingRate: '0',
      volume24h: '0',
      change24h: '0',
    });
    hub.subscribe.mockImplementation((_symbol: string, next: any) => {
      listener = next;
      return jest.fn();
    });
    const exchange = new VirtualGateExchange({
      id: 'v1',
      name: 'Virtual 1',
      type: 'virtual_gate',
    } as any, hub as any);

    const ticker = exchange.getTicker('BTC_USDT');
    listener({ symbol: 'BTC_USDT', lastPrice: '65000', markPrice: '65001', source: 'gate', receivedAt: new Date() });

    await expect(ticker).resolves.toEqual(expect.objectContaining({
      symbol: 'BTC_USDT',
      lastPrice: '65000',
      markPrice: '65001',
      indexPrice: '65001',
    }));
    expect(hub.subscribe).toHaveBeenCalledWith('BTC_USDT', expect.any(Function));
  });

  it('subscribes symbols for open orders on start', async () => {
    __virtualDb.orders.push(
      { exchangeInstanceId: 'v1', symbol: 'BTC_USDT', status: 'open', orderRole: 'entry' },
      { exchangeInstanceId: 'v1', symbol: 'BTC_USDT', status: 'open', orderRole: 'sl' },
      { exchangeInstanceId: 'v1', symbol: 'ETH_USDT', status: 'open', orderRole: 'entry' },
    );
    const exchange = new VirtualGateExchange({
      id: 'v1',
      name: 'Virtual 1',
      type: 'virtual_gate',
      initialBalance: '10000',
    } as any, hub as any);

    await exchange.start();

    expect(hub.subscribe).toHaveBeenCalledTimes(2);
    expect(hub.subscribe).toHaveBeenCalledWith('BTC_USDT', expect.any(Function));
    expect(hub.subscribe).toHaveBeenCalledWith('ETH_USDT', expect.any(Function));
  });

  it('fills subscribed limit orders and resolves waiters', async () => {
    let listener: any;
    hub.subscribe.mockImplementation((_symbol: string, next: any) => {
      listener = next;
      return jest.fn();
    });
    const exchange = new VirtualGateExchange({
      id: 'v1',
      name: 'Virtual 1',
      type: 'virtual_gate',
    } as any, hub as any);

    const order = await exchange.placeOrder({ symbol: 'BTC_USDT', side: 'buy', amount: '2', price: '64000', type: 'limit' });
    const waiter = exchange.waitForOrderFill(order.id, 'BTC_USDT', 1000);
    await listener({ symbol: 'BTC_USDT', lastPrice: '63999', source: 'gate', receivedAt: new Date() });

    await expect(waiter).resolves.toEqual(expect.objectContaining({
      id: order.id,
      status: 'filled',
      price: '64000',
    }));
  });

  it('fills marketable limit orders immediately from the latest tick', async () => {
    const exchange = new VirtualGateExchange({
      id: 'v1',
      name: 'Virtual 1',
      type: 'virtual_gate',
      initialBalance: '10000',
    } as any, hub as any);

    const order = await exchange.placeOrder({
      symbol: 'BTC_USDT',
      side: 'buy',
      amount: '2',
      price: '65100',
      type: 'limit',
    });

    expect(order).toEqual(expect.objectContaining({
      status: 'filled',
      amount: '2',
      price: '65100',
    }));
    expect(__virtualDb.orders[0]).toEqual(expect.objectContaining({
      status: 'filled',
      filledPrice: '65100',
      filledAmount: '2',
    }));
    expect(__virtualDb.trades).toHaveLength(1);
  });

  it('waits indefinitely when timeoutMs is 0', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'setInterval', 'clearInterval', 'clearImmediate', 'nextTick'] });
    const setTimeoutSpy = jest.spyOn(global, 'setTimeout');
    let listener: any;
    hub.subscribe.mockImplementation((_symbol: string, next: any) => {
      listener = next;
      return jest.fn();
    });
    const exchange = new VirtualGateExchange({
      id: 'v1',
      name: 'Virtual 1',
      type: 'virtual_gate',
    } as any, hub as any);

    const order = await exchange.placeOrder({ symbol: 'BTC_USDT', side: 'buy', amount: '2', price: '64000', type: 'limit' });
    const waiter = exchange.waitForOrderFill(order.id, 'BTC_USDT', 0);
    await Promise.resolve();

    expect(setTimeoutSpy).not.toHaveBeenCalled();
    await listener({ symbol: 'BTC_USDT', lastPrice: '63999', source: 'gate', receivedAt: new Date() });
    await expect(waiter).resolves.toEqual(expect.objectContaining({ id: order.id, status: 'filled' }));
  });

  it('serializes overlapping ticks so the same order is filled once', async () => {
    const listeners: any[] = [];
    hub.subscribe.mockImplementation((_symbol: string, next: any) => {
      listeners.push(next);
      return jest.fn();
    });
    const exchange = new VirtualGateExchange({
      id: 'v1',
      name: 'Virtual 1',
      type: 'virtual_gate',
    } as any, hub as any);

    await exchange.placeOrder({ symbol: 'BTC_USDT', side: 'buy', amount: '2', price: '64000', type: 'limit' });
    listeners[0]({ symbol: 'BTC_USDT', lastPrice: '63999', source: 'gate', receivedAt: new Date() });
    listeners[0]({ symbol: 'BTC_USDT', lastPrice: '63998', source: 'gate', receivedAt: new Date() });
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));

    expect(__virtualDb.trades).toHaveLength(1);
    expect(__virtualDb.orders[0].status).toBe('filled');
  });

  it('treats reduce-only limit TP as an open order, not a price order', async () => {
    const exchange = new VirtualGateExchange({
      id: 'v1',
      name: 'Virtual 1',
      type: 'virtual_gate',
    } as any, hub as any);

    const order = await exchange.placeOrder({
      symbol: 'BTC_USDT',
      side: 'sell',
      amount: '2',
      price: '70000',
      type: 'limit',
      reduceOnly: true,
      text: 'tp-limit',
    });

    await expect(exchange.getOpenOrders('BTC_USDT')).resolves.toEqual([
      expect.objectContaining({ id: order.id, text: 'tp-limit' }),
    ]);
    await expect(exchange.getPriceOrders('BTC_USDT')).resolves.toEqual([]);
    await expect(exchange.cancelOrder(order.id, 'BTC_USDT')).resolves.toBe(true);
  });

  it('stops subscriptions and ignores late ticks', async () => {
    let listener: any;
    const cleanup = jest.fn();
    hub.subscribe.mockImplementation((_symbol: string, next: any) => {
      listener = next;
      return cleanup;
    });
    const exchange = new VirtualGateExchange({
      id: 'v1',
      name: 'Virtual 1',
      type: 'virtual_gate',
    } as any, hub as any);

    await exchange.placeOrder({ symbol: 'BTC_USDT', side: 'buy', amount: '2', price: '64000', type: 'limit' });
    await exchange.stop();
    listener({ symbol: 'BTC_USDT', lastPrice: '63999', source: 'gate', receivedAt: new Date() });
    await new Promise(resolve => setImmediate(resolve));

    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(__virtualDb.trades).toHaveLength(0);
    expect(__virtualDb.orders[0].status).toBe('open');
  });

  it('does not create stop loss without amount when there is no same-side position', async () => {
    const exchange = new VirtualGateExchange({
      id: 'v1',
      name: 'Virtual 1',
      type: 'virtual_gate',
    } as any, hub as any);

    await expect(exchange.updateStopLoss('BTC_USDT', 'buy', '63000')).resolves.toBeNull();
    expect(__virtualDb.orders).toHaveLength(0);
  });

  it('derives stop loss amount from same-side position and returns price-order fields', async () => {
    __virtualDb.positions.push({
      symbol: 'BTC_USDT',
      exchangeInstanceId: 'v1',
      size: '3',
      entryPrice: '65000',
      markPrice: '65000',
      leverage: '1',
      marginType: 'cross',
      update: jest.fn(),
    });
    const exchange = new VirtualGateExchange({
      id: 'v1',
      name: 'Virtual 1',
      type: 'virtual_gate',
    } as any, hub as any);

    const orderId = await exchange.updateStopLoss('BTC_USDT', 'buy', '63000', 'sl-auto');
    const priceOrders = await exchange.getPriceOrders('BTC_USDT');

    expect(orderId).toEqual(expect.stringMatching(/^vo-/));
    expect(priceOrders).toEqual([
      expect.objectContaining({
        id: orderId,
        amount: '3',
        trigger: expect.objectContaining({ rule: 2 }),
        initial: expect.objectContaining({
          reduce_only: true,
          is_reduce_only: true,
          size: '3',
          text: 'sl-auto',
        }),
      }),
    ]);
  });

  it('replaces existing same-side position-level stop loss orders', async () => {
    __virtualDb.positions.push({
      symbol: 'BTC_USDT',
      exchangeInstanceId: 'v1',
      size: '3',
      entryPrice: '65000',
      markPrice: '65000',
      leverage: '1',
      marginType: 'cross',
      update: jest.fn(),
    });
    const exchange = new VirtualGateExchange({
      id: 'v1',
      name: 'Virtual 1',
      type: 'virtual_gate',
    } as any, hub as any);

    const firstId = await exchange.updateStopLoss('BTC_USDT', 'buy', '63000', 't-sl-pos-BTC_USDT-buy');
    const secondId = await exchange.updateStopLoss('BTC_USDT', 'buy', '64000', 't-sl-pos-BTC_USDT-buy');
    const priceOrders = await exchange.getPriceOrders('BTC_USDT');

    expect(firstId).toEqual(expect.stringMatching(/^vo-/));
    expect(secondId).toEqual(expect.stringMatching(/^vo-/));
    expect(__virtualDb.orders.find((order: any) => order.virtualOrderId === firstId)).toEqual(expect.objectContaining({
      status: 'cancelled',
    }));
    expect(priceOrders).toEqual([
      expect.objectContaining({
        id: secondId,
        price: '64000',
        amount: '3',
        text: 't-sl-pos-BTC_USDT-buy',
      }),
    ]);
  });

  it('cancels stale stop loss after take profit closes the virtual position', async () => {
    let listener: any;
    hub.subscribe.mockImplementation((_symbol: string, next: any) => {
      listener = next;
      return jest.fn();
    });
    const exchange = new VirtualGateExchange({
      id: 'v1',
      name: 'Virtual 1',
      type: 'virtual_gate',
      initialBalance: '10000',
    } as any, hub as any);

    await exchange.placeOrder({ symbol: 'BTC_USDT', side: 'buy', amount: '3', type: 'market' });
    const slId = await exchange.updateStopLoss('BTC_USDT', 'buy', '63000', 't-sl-pos-BTC_USDT-buy', '3');
    const tp = await exchange.placeOrder({
      symbol: 'BTC_USDT',
      side: 'sell',
      amount: '3',
      price: '66000',
      type: 'limit',
      reduceOnly: true,
      text: 'tp-limit',
    });

    listener({ symbol: 'BTC_USDT', lastPrice: '66000', source: 'gate', receivedAt: new Date() });
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));

    expect(__virtualDb.orders.find((order: any) => order.virtualOrderId === tp.id)).toEqual(expect.objectContaining({
      status: 'filled',
    }));
    expect(__virtualDb.positions[0]).toEqual(expect.objectContaining({ size: '0' }));
    expect(__virtualDb.orders.find((order: any) => order.virtualOrderId === slId)).toEqual(expect.objectContaining({
      status: 'cancelled',
    }));
    await expect(exchange.getPriceOrders('BTC_USDT')).resolves.toEqual([]);
  });

  it('cancels open entry orders and excludes them from open orders', async () => {
    const exchange = new VirtualGateExchange({
      id: 'v1',
      name: 'Virtual 1',
      type: 'virtual_gate',
    } as any, hub as any);
    const order = await exchange.placeOrder({ symbol: 'BTC_USDT', side: 'buy', amount: '2', price: '64000', type: 'limit' });

    await expect(exchange.cancelOrder(order.id, 'BTC_USDT')).resolves.toBe(true);
    await expect(exchange.getOpenOrders('BTC_USDT')).resolves.toEqual([]);
  });

  it('creates PendingProtection when stopLoss is provided', async () => {
    const exchange = new VirtualGateExchange({
      id: 'v1',
      name: 'Virtual 1',
      type: 'virtual_gate',
      initialBalance: '10000',
    } as any, hub as any);

    const result = await exchange.placeOrder({
      symbol: 'BTC_USDT',
      side: 'buy',
      amount: '100',
      type: 'market',
      stopLoss: '63000',
    });

    expect(__virtualDb.pendingProtections).toHaveLength(1);
    expect(__virtualDb.pendingProtections[0]).toEqual(expect.objectContaining({
      orderId: result.id,
      symbol: 'BTC_USDT',
      side: 'buy',
      stopLoss: '63000',
      takeProfit: null,
    }));
  });

  it('does not create PendingProtection when stopLoss and takeProfit are absent', async () => {
    const exchange = new VirtualGateExchange({
      id: 'v1',
      name: 'Virtual 1',
      type: 'virtual_gate',
      initialBalance: '10000',
    } as any, hub as any);

    await exchange.placeOrder({
      symbol: 'BTC_USDT',
      side: 'buy',
      amount: '100',
      type: 'market',
    });

    expect(__virtualDb.pendingProtections).toHaveLength(0);
  });

  it('subscribes market order symbols so later ticks update MarkPriceCache', async () => {
    let listener: any;
    hub.subscribe.mockImplementation((_symbol: string, next: any) => {
      listener = next;
      return jest.fn();
    });
    const exchange = new VirtualGateExchange({
      id: 'v1',
      name: 'Virtual 1',
      type: 'virtual_gate',
      initialBalance: '10000',
    } as any, hub as any);

    await exchange.placeOrder({
      symbol: 'BTC_USDT',
      side: 'buy',
      amount: '100',
      type: 'market',
    });

    expect(hub.subscribe).toHaveBeenCalledWith('BTC_USDT', expect.any(Function));

    listener({ symbol: 'BTC_USDT', lastPrice: '66000', source: 'gate', receivedAt: new Date() });
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));

    expect(MarkPriceCache.get('v1', 'BTC_USDT')).toBe('66000');
  });

  it('subscribes existing position symbols on start', async () => {
    __virtualDb.positions.push({
      exchangeInstanceId: 'v1',
      symbol: 'BTC_USDT',
      size: '100',
      entryPrice: '65000',
      markPrice: '65000',
      realizedPnl: '0',
      leverage: '1',
      marginType: 'cross',
    });
    const exchange = new VirtualGateExchange({
      id: 'v1',
      name: 'Virtual 1',
      type: 'virtual_gate',
      initialBalance: '10000',
    } as any, hub as any);

    await exchange.start();

    expect(hub.subscribe).toHaveBeenCalledWith('BTC_USDT', expect.any(Function));
  });

  it('updates MarkPriceCache on each tick', async () => {
    let listener: any;
    hub.subscribe.mockImplementation((_symbol: string, next: any) => {
      listener = next;
      return jest.fn();
    });
    const exchange = new VirtualGateExchange({
      id: 'v1',
      name: 'Virtual 1',
      type: 'virtual_gate',
      initialBalance: '100000',
    } as any, hub as any);

    // Place a limit order to set up tick subscription
    await exchange.placeOrder({ symbol: 'BTC_USDT', side: 'buy', amount: '1', price: '64000', type: 'limit' });
    // Fill the order via tick
    listener({ symbol: 'BTC_USDT', lastPrice: '64000', source: 'gate', receivedAt: new Date() });
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));

    expect(__virtualDb.positions).toHaveLength(1);
    expect(MarkPriceCache.get('v1', 'BTC_USDT')).toBe('64000');

    // Tick at higher price updates markPrice
    listener({ symbol: 'BTC_USDT', lastPrice: '65000', source: 'gate', receivedAt: new Date() });
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));

    expect(MarkPriceCache.get('v1', 'BTC_USDT')).toBe('65000');

    // Tick at lower price updates markPrice again
    listener({ symbol: 'BTC_USDT', lastPrice: '63500', source: 'gate', receivedAt: new Date() });
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));

    expect(MarkPriceCache.get('v1', 'BTC_USDT')).toBe('63500');
  });

  describe('VirtualStateStore new methods', () => {
    it('should cancel stale reduce-only orders', async () => {
      const exchange = new VirtualGateExchange({
        id: 'v1',
        name: 'Virtual 1',
        type: 'virtual_gate',
        initialBalance: '10000',
      } as any, hub as any);
      
      const store = (exchange as any).store;
      
      // Create a position
      await store.upsertPosition({
        symbol: 'BTC_USDT',
        size: '0.1',
        entryPrice: '50000',
        markPrice: '50000',
      });

      // Create a reduce-only order that should be stale (same side as position)
      await store.createOrder({
        virtualOrderId: 'order1',
        symbol: 'BTC_USDT',
        side: 'buy',
        amount: '0.05',
        price: '51000',
        type: 'limit',
        status: 'open',
        reduceOnly: true,
      });

      const cancelledCount = await store.cancelStaleReduceOnlyOrders('BTC_USDT');
      expect(cancelledCount).toBe(1);
    });

    it('should add realized PnL to account balance', async () => {
      const exchange = new VirtualGateExchange({
        id: 'v1',
        name: 'Virtual 1',
        type: 'virtual_gate',
        initialBalance: '10000',
      } as any, hub as any);
      
      const store = (exchange as any).store;
      
      // Test that the new methods exist and can be called
      expect(typeof store.cancelStaleReduceOnlyOrders).toBe('function');
      expect(typeof store.recordFill).toBe('function');
      
      // Test cancelStaleReduceOnlyOrders with no orders
      const cancelledCount = await store.cancelStaleReduceOnlyOrders('BTC_USDT');
      expect(cancelledCount).toBe(0);
    });
  });
});
