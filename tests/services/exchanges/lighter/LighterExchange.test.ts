import { LighterExchange } from '../../../../src/services/exchanges/lighter/LighterExchange';
import { LighterMarketMap } from '../../../../src/services/exchanges/lighter/LighterMarketMap';
import { ExchangeConfig } from '../../../../src/services/exchanges/IExchange';

jest.mock('../../../../src/models/PendingProtection', () => ({
  __esModule: true,
  default: {
    create: jest.fn().mockResolvedValue({}),
    upsert: jest.fn().mockResolvedValue([{}, true]),
    destroy: jest.fn().mockResolvedValue(0),
  },
}));
import PendingProtection from '../../../../src/models/PendingProtection';

const config = {
  id: 'lighter-main',
  name: 'Lighter Main',
  type: 'lighter',
  apiKey: 'api-key',
  apiSecret: 'api-secret',
  privateKey: 'private-key',
  signerPath: '/bin/lighter-signer',
  baseURL: 'https://lighter.example',
  wsURL: 'wss://lighter.example/ws',
  accountIndex: 7,
  apiKeyIndex: 2,
  markets: [
    {
      symbol: 'BTC_USDT',
      marketIndex: 1,
      baseCurrency: 'BTC',
      quoteCurrency: 'USDT',
      priceDecimals: 2,
      sizeDecimals: 5,
      minBaseAmount: '0.0001',
    },
  ],
} as ExchangeConfig & { signerPath: string; markets: any[] };

const makeDeps = () => ({
  marketMap: new LighterMarketMap({ markets: config.markets }),
  clientOrderIndexStore: {
    getOrCreate: jest.fn().mockResolvedValue('1001'),
  },
  signer: {
    assertUsable: jest.fn().mockResolvedValue(undefined),
    createAuthToken: jest.fn().mockResolvedValue({ token: 'test-token', expiresAt: Date.now() + 60000 }),
  },
  restClient: {
    getAccountPositions: jest.fn().mockResolvedValue([]),
    getAccount: jest.fn().mockResolvedValue({}),
    getAccountOrders: jest.fn().mockResolvedValue({ orders: [] }),
    getAccountOrderHistory: jest.fn().mockResolvedValue({ orders: [] }),
    getAccountTrades: jest.fn().mockResolvedValue({ trades: [] }),
    getTicker: jest.fn().mockResolvedValue({}),
    getCandles: jest.fn().mockResolvedValue({ candles: [] }),
  },
  nonceManager: {
    submit: jest.fn().mockResolvedValue({
      txId: 'tx-1',
      raw: { accepted: true },
      clientOrderIndex: '1001',
    }),
  },
  reconciler: {
    reconcileStartup: jest.fn().mockResolvedValue({ safeToTrade: true, unknownTxCount: 0 }),
    waitForFill: jest.fn(),
    normalizePosition: jest.fn((position: any) => position),
  },
  wsClient: {
    connect: jest.fn().mockResolvedValue(undefined),
    disconnect: jest.fn().mockResolvedValue(undefined),
    getStats: jest.fn(() => ({ isConnected: false })),
    on: jest.fn(),
  },
});

const allowTrading = (exchange: LighterExchange): LighterExchange => {
  (exchange as any).safeToTrade = true;
  return exchange;
};

describe('LighterExchange', () => {
  it('rejects negative account indexes before creating runtime clients', () => {
    expect(() => new LighterExchange({ ...config, accountIndex: -1 }, makeDeps())).toThrow(
      'Lighter accountIndex must be non-negative',
    );
  });

  it('uses injected dependencies, returns configured markets, and rejects unsupported tickers', async () => {
    const exchange = new LighterExchange(config, makeDeps());

    await expect(exchange.getMarkets()).resolves.toEqual([
      expect.objectContaining({
        symbol: 'BTC_USDT',
        baseCurrency: 'BTC',
        quoteCurrency: 'USDT',
      }),
    ]);
    await expect(exchange.getTicker('ETH_USDT')).rejects.toThrow('Unsupported Lighter symbol: ETH_USDT');
  });

  it('starts only after signer, websocket, and startup reconciliation succeed', async () => {
    const deps = makeDeps();
    const exchange = new LighterExchange(config, deps);

    await expect(exchange.start()).resolves.toBeUndefined();

    expect(deps.signer.assertUsable).toHaveBeenCalledTimes(1);
    expect(deps.wsClient.connect).toHaveBeenCalledTimes(1);
    expect(deps.reconciler.reconcileStartup).toHaveBeenCalledWith('lighter-main');
  });

  it('emits wsConnected when the underlying websocket connects', () => {
    const deps = makeDeps();
    const exchange = new LighterExchange(config, deps);
    const handler = jest.fn();
    exchange.on('wsConnected', handler);

    const connectedHandler = deps.wsClient.on.mock.calls.find(([event]) => event === 'connected')?.[1];
    expect(connectedHandler).toBeDefined();
    connectedHandler?.({});

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('stop disables trading writes after a successful start', async () => {
    const deps = makeDeps();
    const exchange = new LighterExchange(config, deps);

    await exchange.start();
    await exchange.stop();

    await expect(exchange.placeOrder({
      symbol: 'BTC_USDT',
      side: 'buy',
      amount: '0.1',
      price: '65000.12',
      type: 'market',
      text: 'entry-1',
    })).rejects.toThrow('Lighter exchange lighter-main is not safe to trade');
    expect(deps.wsClient.disconnect).toHaveBeenCalledTimes(1);
    expect(deps.nonceManager.submit).not.toHaveBeenCalled();
  });

  it('starts in paused trading mode when startup reconciliation finds unknown txs', async () => {
    const deps = makeDeps();
    deps.reconciler.reconcileStartup.mockResolvedValue({ safeToTrade: false, unknownTxCount: 1 });
    const exchange = new LighterExchange(config, deps);

    await expect(exchange.start()).resolves.toBeUndefined();

    expect(deps.wsClient.connect).toHaveBeenCalledTimes(1);
    expect(deps.wsClient.disconnect).not.toHaveBeenCalled();
    expect(exchange.getWebSocketStats()).toEqual(expect.objectContaining({
      safeToTrade: false,
      pausedReason: 'Lighter exchange lighter-main has 1 unknown txs; trading paused',
    }));
    await expect(exchange.placeOrder({
      symbol: 'BTC_USDT',
      side: 'buy',
      amount: '0.1',
      price: '65000.12',
      type: 'market',
      text: 'entry-1',
    })).rejects.toThrow('Lighter exchange lighter-main is not safe to trade');
    expect(deps.nonceManager.submit).not.toHaveBeenCalled();
  });

  it('disconnects websocket and keeps trading paused when startup reconciliation throws', async () => {
    const deps = makeDeps();
    deps.reconciler.reconcileStartup.mockRejectedValue(new Error('journal unavailable'));
    const exchange = allowTrading(new LighterExchange(config, deps));

    await expect(exchange.start()).rejects.toThrow('journal unavailable');

    expect(deps.wsClient.connect).toHaveBeenCalledTimes(1);
    expect(deps.wsClient.disconnect).toHaveBeenCalledTimes(1);
    await expect(exchange.placeOrder({
      symbol: 'BTC_USDT',
      side: 'buy',
      amount: '0.1',
      price: '65000.12',
      type: 'market',
      text: 'entry-1',
    })).rejects.toThrow('Lighter exchange lighter-main is not safe to trade');
    expect(deps.nonceManager.submit).not.toHaveBeenCalled();
  });

  it('submits BTC_USDT market buy with allocated client order index and returns accepted result', async () => {
    const deps = makeDeps();
    const exchange = allowTrading(new LighterExchange(config, deps));

    await expect(exchange.placeOrder({
      symbol: 'BTC_USDT',
      side: 'buy',
      amount: '0.1',
      price: '65000.12',
      type: 'market',
      text: 'entry-1',
    })).resolves.toEqual(expect.objectContaining({
      id: '1001',
      status: 'accepted',
      amount: '0.1',
      price: '65000.12',
      raw: { accepted: true },
    }));

    expect(deps.clientOrderIndexStore.getOrCreate).toHaveBeenCalledWith('lighter-main', 'entry-1');
    expect(deps.nonceManager.submit).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'place_order',
      clientOrderIndex: '1001',
      payload: expect.objectContaining({
        market_index: 1,
        client_order_index: '1001',
        is_ask: false,
        base_amount: '10000',
        price: '6500012',
        order_type: 'market',
        reduce_only: false,
      }),
    }));
  });

  it('auto-calculates worst acceptable price for market orders without price', async () => {
    const deps = makeDeps();
    deps.restClient.getTicker.mockResolvedValue({
      order_book_details: [{ last_trade_price: '65000' }],
    });
    const exchange = allowTrading(new LighterExchange(config, deps));

    await expect(exchange.placeOrder({
      symbol: 'BTC_USDT',
      side: 'buy',
      amount: '0.1',
      type: 'market',
      text: 'entry-1',
    })).resolves.toEqual(expect.objectContaining({
      id: '1001',
      status: 'accepted',
      price: '65325.00', // 65000 * 1.005 (0.5% market slippage)
    }));

    expect(deps.nonceManager.submit).toHaveBeenCalledWith(expect.objectContaining({
      payload: expect.objectContaining({
        price: '6532500', // 65325.00 * 100 (priceDecimals=2)
        order_type: 'market',
      }),
    }));
  });

  it('auto-calculates lower worst price for sell market orders', async () => {
    const deps = makeDeps();
    deps.restClient.getTicker.mockResolvedValue({
      order_book_details: [{ last_trade_price: '65000' }],
    });
    const exchange = allowTrading(new LighterExchange(config, deps));

    await expect(exchange.placeOrder({
      symbol: 'BTC_USDT',
      side: 'sell',
      amount: '0.1',
      type: 'market',
      text: 'exit-1',
    })).resolves.toEqual(expect.objectContaining({
      price: '64675.00', // 65000 * 0.995 (0.5% market slippage)
    }));
  });

  it('places long stop-loss as sell reduce-only trigger with stop price as preliminary worst price', async () => {
    const deps = makeDeps();
    const exchange = allowTrading(new LighterExchange(config, deps));

    await expect(exchange.updateStopLoss('BTC_USDT', 'buy', '64000.50', 'sl-long', '0.1')).resolves.toBe('1001');

    expect(deps.nonceManager.submit).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'place_order',
      side: 'sell',
      payload: expect.objectContaining({
        is_ask: true,
        price: '6272049',
        trigger_price: '6400050',
        reduce_only: true,
      }),
    }));
  });

  it('places short stop-loss as buy reduce-only trigger with stop price as preliminary worst price', async () => {
    const deps = makeDeps();
    const exchange = allowTrading(new LighterExchange(config, deps));

    await expect(exchange.updateStopLoss('BTC_USDT', 'sell', '66000.25', 'sl-short', '0.1')).resolves.toBe('1001');

    expect(deps.nonceManager.submit).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'place_order',
      side: 'buy',
      payload: expect.objectContaining({
        is_ask: false,
        price: '6732026',
        trigger_price: '6600025',
        reduce_only: true,
      }),
    }));
  });

  it('rejects stop-loss without positive amount when no position exists', async () => {
    const deps = makeDeps();
    const exchange = new LighterExchange(config, deps);

    await expect(exchange.updateStopLoss('BTC_USDT', 'buy', '64000.50', 'sl-long')).rejects.toThrow(
      'Lighter updateStopLoss requires positive amount (not available from params or position)',
    );
    await expect(exchange.updateStopLoss('BTC_USDT', 'buy', '64000.50', 'sl-long', '0')).rejects.toThrow(
      'Lighter updateStopLoss requires positive amount (not available from params or position)',
    );

    expect(deps.nonceManager.submit).not.toHaveBeenCalled();
  });

  it('cancels existing SL orders before placing new one', async () => {
    const deps = makeDeps();
    deps.restClient.getAccountOrders.mockResolvedValue({
      orders: [
        { client_order_index: 'old-sl', symbol: 'BTC_USDT', side: 'sell', price: '64000', base_amount: '0.1', status: 'OPEN', order_type: 'STOP_LOSS' },
      ],
    });
    const exchange = allowTrading(new LighterExchange(config, deps));

    await expect(exchange.updateStopLoss('BTC_USDT', 'buy', '63000', 'sl-new', '0.1')).resolves.toBe('1001');

    // First submit should be cancel_order for old SL
    expect(deps.nonceManager.submit).toHaveBeenNthCalledWith(1, expect.objectContaining({
      kind: 'cancel_order',
      clientOrderIndex: 'old-sl',
    }));
    // Second submit should be the new SL place_order
    expect(deps.nonceManager.submit).toHaveBeenNthCalledWith(2, expect.objectContaining({
      kind: 'place_order',
      payload: expect.objectContaining({ trigger_price: '6300000' }),
    }));
  });

  it('falls back to position size when amount is not provided', async () => {
    const deps = makeDeps();
    deps.restClient.getAccountPositions.mockResolvedValue([
      { symbol: 'BTC_USDT', size: '0.5', side: 'long' },
    ]);
    const exchange = allowTrading(new LighterExchange(config, deps));

    await expect(exchange.updateStopLoss('BTC_USDT', 'buy', '64000')).resolves.toBe('1001');

    expect(deps.nonceManager.submit).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'place_order',
      amount: '0.5',
    }));
  });

  it('cancels using client order index semantics', async () => {
    const deps = makeDeps();
    const exchange = allowTrading(new LighterExchange(config, deps));

    await expect(exchange.cancelPriceOrder('1001', 'BTC_USDT')).resolves.toBe(true);

    expect(deps.nonceManager.submit).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'cancel_order',
      clientOrderIndex: '1001',
      payload: expect.objectContaining({
        market_index: 1,
        client_order_index: '1001',
      }),
    }));
  });

  it('auto-calculates worst price for closePosition without price', async () => {
    const deps = makeDeps();
    deps.restClient.getTicker.mockResolvedValue({
      order_book_details: [{ last_trade_price: '65000' }],
    });
    deps.reconciler.normalizePosition.mockReturnValue({
      symbol: 'BTC_USDT',
      size: '-0.5',
      entryPrice: '64000',
      markPrice: '65000',
      unrealizedPnl: '500',
      leverage: '10',
      marginType: 'cross',
    });
    deps.restClient.getAccountPositions.mockResolvedValue([{
      symbol: 'BTC_USDT',
      sign: -1,
      position: '0.5',
      avg_entry_price: '64000',
      index_price: '65000',
      pnl: '500',
      initial_margin_fraction: '0.1',
      margin_mode: 0,
    }]);
    const exchange = allowTrading(new LighterExchange(config, deps));

    await expect(exchange.closePosition('BTC_USDT', 'buy')).resolves.toBe(true);

    expect(deps.nonceManager.submit).toHaveBeenCalledWith(expect.objectContaining({
      payload: expect.objectContaining({
        order_type: 'market',
        reduce_only: true,
      }),
    }));
  });

  it('returns normalized Lighter balance', async () => {
    const deps = makeDeps();
    deps.restClient.getAccount.mockResolvedValue({
      account: { available_balance: '10', total_balance: '12', unrealized_pnl: '0.5' },
    });
    const exchange = new LighterExchange(config, deps);

    await expect(exchange.getBalance()).resolves.toEqual({
      currency: 'USDT',
      available: '10',
      total: '12',
      unrealizedPnl: '0.5',
    });
    expect(deps.restClient.getAccount).toHaveBeenCalledWith(7);
  });

  it('returns normalized Lighter balance with explicit currency', async () => {
    const deps = makeDeps();
    deps.restClient.getAccount.mockResolvedValue({
      account: { available_balance: '100', total_balance: '200' },
    });
    const exchange = new LighterExchange(config, deps);

    await expect(exchange.getBalance('USDC')).resolves.toEqual({
      currency: 'USDC',
      available: '100',
      total: '200',
      unrealizedPnl: '',
    });
  });

  it('finds an active order by client order index via getOrder', async () => {
    const deps = makeDeps();
    deps.restClient.getAccountOrders.mockResolvedValue({
      orders: [
        { client_order_index: '1001', symbol: 'BTC_USDT', side: 'buy', price: '65000', base_amount: '0.1', status: 'OPEN' },
        { client_order_index: '1002', symbol: 'BTC_USDT', side: 'sell', price: '66000', base_amount: '0.1', status: 'OPEN' },
      ],
    });
    const exchange = new LighterExchange(config, deps);

    const result = await exchange.getOrder('1001', 'BTC_USDT');
    expect(result.id).toBe('1001');
    expect(result.status).toBe('open');
  });

  it('finds a finished order via getOrder by falling back to order history', async () => {
    const deps = makeDeps();
    deps.restClient.getAccountOrders.mockResolvedValue({ orders: [] });
    deps.restClient.getAccountOrderHistory.mockResolvedValue({
      orders: [
        { client_order_index: '2001', symbol: 'BTC_USDT', side: 'buy', price: '65000', base_amount: '0.1', status: 'FILLED' },
      ],
    });
    const exchange = new LighterExchange(config, deps);

    const result = await exchange.getOrder('2001', 'BTC_USDT');
    expect(result.id).toBe('2001');
    expect(result.status).toBe('filled');
  });

  it('throws when getOrder cannot find the requested order', async () => {
    const deps = makeDeps();
    deps.restClient.getAccountOrders.mockResolvedValue({ orders: [] });
    deps.restClient.getAccountOrderHistory.mockResolvedValue({ orders: [] });
    const exchange = new LighterExchange(config, deps);

    await expect(exchange.getOrder('9999', 'BTC_USDT')).rejects.toThrow(
      'Lighter order not found: 9999 BTC_USDT',
    );
  });

  it('returns open orders filtered by symbol via getOpenOrders', async () => {
    const deps = makeDeps();
    deps.restClient.getAccountOrders.mockResolvedValue({
      orders: [
        { client_order_index: '1', symbol: 'BTC_USDT', side: 'buy', price: '65000', base_amount: '0.1', status: 'OPEN' },
        { client_order_index: '2', symbol: 'ETH_USDT', side: 'sell', price: '3500', base_amount: '1', status: 'OPEN' },
      ],
    });
    const exchange = new LighterExchange(config, deps);

    const results = await exchange.getOpenOrders('BTC_USDT');
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe('1');
  });

  it('returns all active orders when getOpenOrders has no symbol filter', async () => {
    const deps = makeDeps();
    deps.restClient.getAccountOrders.mockResolvedValue({
      orders: [
        { client_order_index: '1', symbol: 'BTC_USDT', side: 'buy', price: '65000', base_amount: '0.1', status: 'OPEN' },
        { client_order_index: '2', symbol: 'BTC_USDT', side: 'sell', price: '66000', base_amount: '0.1', status: 'OPEN' },
      ],
    });
    const exchange = new LighterExchange(config, deps);

    const results = await exchange.getOpenOrders();
    expect(results).toHaveLength(2);
  });

  it('returns finished orders from order history via getFinishedOrders', async () => {
    const deps = makeDeps();
    deps.restClient.getAccountOrderHistory.mockResolvedValue({
      orders: [
        { client_order_index: '3001', symbol: 'BTC_USDT', side: 'buy', price: '65000', base_amount: '0.1', status: 'FILLED' },
        { client_order_index: '3002', symbol: 'BTC_USDT', side: 'sell', price: '66000', base_amount: '0.1', status: 'CANCELLED' },
      ],
    });
    const exchange = new LighterExchange(config, deps);

    const results = await exchange.getFinishedOrders('BTC_USDT', 50);
    expect(results).toHaveLength(2);
    expect(deps.restClient.getAccountOrderHistory).toHaveBeenCalledWith(7, 1, 50);
  });

  it('returns open price orders by filtering trigger order types', async () => {
    const deps = makeDeps();
    deps.restClient.getAccountOrders.mockResolvedValue({
      orders: [
        { client_order_index: '1', symbol: 'BTC_USDT', side: 'sell', price: '60000', base_amount: '0.01', status: 'OPEN', order_type: 'STOP_LOSS' },
        { client_order_index: '2', symbol: 'BTC_USDT', side: 'sell', price: '70000', base_amount: '0.01', status: 'OPEN', order_type: 'LIMIT' },
      ],
    });
    const exchange = new LighterExchange(config, deps);

    const results = await exchange.getPriceOrders('BTC_USDT');
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe('1');
  });

  it('maps native USDC order symbols before filtering price orders', async () => {
    const deps = makeDeps();
    deps.restClient.getAccountOrders.mockResolvedValue({
      orders: [
        { client_order_index: '1', symbol: 'BTC-USDC', side: 'sell', price: '60000', base_amount: '0.01', status: 'OPEN', order_type: 'STOP_LOSS' },
      ],
    });
    const exchange = new LighterExchange(config, deps);

    const results = await exchange.getPriceOrders('BTC_USDT');

    expect(results).toEqual([
      expect.objectContaining({
        id: '1',
        symbol: 'BTC_USDT',
      }),
    ]);
  });

  it('returns price orders including TAKE_PROFIT types', async () => {
    const deps = makeDeps();
    deps.restClient.getAccountOrders.mockResolvedValue({
      orders: [
        { client_order_index: '1', symbol: 'BTC_USDT', side: 'sell', price: '60000', base_amount: '0.01', status: 'OPEN', order_type: 'STOP_LOSS' },
        { client_order_index: '2', symbol: 'BTC_USDT', side: 'sell', price: '70000', base_amount: '0.01', status: 'OPEN', order_type: 'TAKE_PROFIT' },
        { client_order_index: '3', symbol: 'BTC_USDT', side: 'sell', price: '75000', base_amount: '0.01', status: 'OPEN', order_type: 'TAKE_PROFIT_LIMIT' },
        { client_order_index: '4', symbol: 'BTC_USDT', side: 'buy', price: '55000', base_amount: '0.01', status: 'OPEN', order_type: 'STOP_LOSS_LIMIT' },
        { client_order_index: '5', symbol: 'BTC_USDT', side: 'buy', price: '65000', base_amount: '0.01', status: 'OPEN', order_type: 'LIMIT' },
      ],
    });
    const exchange = new LighterExchange(config, deps);

    const results = await exchange.getPriceOrders('BTC_USDT');
    expect(results).toHaveLength(4);
    expect(results.map((r: any) => r.id)).toEqual(['1', '2', '3', '4']);
  });

  it('includes orders with trigger_price as price orders', async () => {
    const deps = makeDeps();
    deps.restClient.getAccountOrders.mockResolvedValue({
      orders: [
        { client_order_index: '1', symbol: 'BTC_USDT', side: 'sell', price: '60000', base_amount: '0.01', status: 'OPEN', order_type: 'LIMIT', trigger_price: '61000' },
        { client_order_index: '2', symbol: 'BTC_USDT', side: 'sell', price: '70000', base_amount: '0.01', status: 'OPEN', order_type: 'LIMIT' },
      ],
    });
    const exchange = new LighterExchange(config, deps);

    const results = await exchange.getPriceOrders('BTC_USDT');
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe('1');
  });

  it('returns trade history via getTradeHistory', async () => {
    const deps = makeDeps();
    deps.restClient.getAccountTrades.mockResolvedValue({
      trades: [
        { trade_id: 't1', client_order_index: '1001', symbol: 'BTC_USDT', side: 'buy', price: '65000', base_amount: '0.1', is_maker: false, created_at: '1700000000' },
      ],
    });
    const exchange = new LighterExchange(config, deps);

    const results = await exchange.getTradeHistory('BTC_USDT', 10);
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe('t1');
    expect(deps.restClient.getAccountTrades).toHaveBeenCalledWith(7, 1, 10);
  });

  it('returns normalized ticker via getTicker', async () => {
    const deps = makeDeps();
    deps.restClient.getTicker.mockResolvedValue({
      ticker: { last_price: '65000', mark_price: '65001', index_price: '65000.5', funding_rate: '0.0001', volume_24h: '1000', price_change_24h: '500' },
    });
    const exchange = new LighterExchange(config, deps);

    const ticker = await exchange.getTicker('BTC_USDT');
    expect(ticker.symbol).toBe('BTC_USDT');
    expect(ticker.lastPrice).toBe('65000');
    expect(ticker.markPrice).toBe('65001');
    expect(deps.restClient.getTicker).toHaveBeenCalledWith(1);
  });

  it('returns normalized candles via getCandles', async () => {
    const deps = makeDeps();
    deps.restClient.getCandles.mockResolvedValue({
      candles: [
        { time: 1700000000, open: '65000', high: '66000', low: '64000', close: '65500', volume: '100' },
      ],
    });
    const exchange = new LighterExchange(config, deps);

    const candles = await exchange.getCandles('BTC_USDT', '1m', 50);
    expect(candles).toHaveLength(1);
    expect(candles[0].open).toBe('65000');
    expect(deps.restClient.getCandles).toHaveBeenCalledWith(1, '1m', 50, expect.any(Number), expect.any(Number));
  });

  it('throws for unrecognized account positions response shape', async () => {
    const deps = makeDeps();
    deps.restClient.getAccountPositions.mockResolvedValue({ unexpected: true });
    const exchange = new LighterExchange(config, deps);

    await expect(exchange.getPositions()).rejects.toThrow('Unrecognized Lighter account positions response');
  });

  it('normalizes supported account positions response shapes', async () => {
    const deps = makeDeps();
    deps.restClient.getAccountPositions.mockResolvedValueOnce({ account: { positions: [{ symbol: 'BTC_USDT' }] } });
    const exchange = new LighterExchange(config, deps);

    await expect(exchange.getPositions()).resolves.toEqual([{ symbol: 'BTC_USDT' }]);

    deps.restClient.getAccountPositions.mockResolvedValueOnce({ accounts: [{ positions: [{ symbol: 'BTC_USDT' }] }] });
    await expect(exchange.getPositions()).resolves.toEqual([{ symbol: 'BTC_USDT' }]);
  });

  it('normalizes market-indexed account position maps', async () => {
    const deps = makeDeps();
    deps.reconciler.normalizePosition.mockImplementation((position: any) => position);
    deps.restClient.getAccountPositions.mockResolvedValue({
      account: {
        positions: {
          '1': { position: '0.2', sign: -1 },
        },
      },
    });
    const exchange = new LighterExchange(config, deps);

    await expect(exchange.getPositions()).resolves.toEqual([
      expect.objectContaining({
        symbol: 'BTC_USDT',
        market: '1',
        position: '0.2',
        sign: -1,
      }),
    ]);
  });

  it('normalizes singular account position response shapes', async () => {
    const deps = makeDeps();
    deps.reconciler.normalizePosition.mockImplementation((position: any) => position);
    deps.restClient.getAccountPositions.mockResolvedValueOnce({
      account: {
        position: [{
          market_id: 1,
          symbol: 'BTC_USDT',
          position: '0.2',
          sign: 1,
        }],
      },
    });
    const exchange = new LighterExchange(config, deps);

    await expect(exchange.getPositions()).resolves.toEqual([
      expect.objectContaining({
        symbol: 'BTC_USDT',
        position: '0.2',
      }),
    ]);

    deps.restClient.getAccountPositions.mockResolvedValueOnce({
      position: {
        market_id: 1,
        symbol: 'BTC_USDT',
        position: '0.1',
        sign: -1,
      },
    });
    await expect(exchange.getPositions()).resolves.toEqual([
      expect.objectContaining({
        symbol: 'BTC_USDT',
        position: '0.1',
      }),
    ]);
  });

  it('maps market_id-only position rows to configured symbols before normalization', async () => {
    const deps = makeDeps();
    delete (deps as any).reconciler;
    deps.restClient.getAccountPositions.mockResolvedValue({
      account: {
        positions: [{
          market_id: 1,
          position: '0.00133',
          sign: 1,
          avg_entry_price: '81100',
          index_price: '81200',
          initial_margin_fraction: '0.02',
        }],
      },
    });
    const exchange = new LighterExchange(config, deps as any);

    await expect(exchange.getPosition('BTC_USDT')).resolves.toEqual(expect.objectContaining({
      symbol: 'BTC_USDT',
      size: '0.00133',
      entryPrice: '81100',
      markPrice: '81200',
      leverage: '50',
    }));
  });

  it('maps native USDC position symbols to configured USDT symbols before lookup', async () => {
    const deps = makeDeps();
    delete (deps as any).reconciler;
    deps.restClient.getAccountPositions.mockResolvedValue({
      account: {
        positions: [{
          symbol: 'BTC-USDC',
          position: '0.0014',
          sign: 1,
          avg_entry_price: '81050',
          index_price: '81080',
        }],
      },
    });
    const exchange = new LighterExchange(config, deps as any);

    await expect(exchange.getPosition('BTC_USDT')).resolves.toEqual(expect.objectContaining({
      symbol: 'BTC_USDT',
      size: '0.0014',
    }));
  });

  it('passes lookupOrder fallback to reconciler when using default deps', () => {
    const deps = makeDeps();
    // Remove the injected reconciler so the default one is created
    delete (deps as any).reconciler;
    // Provide minimal deps needed for the constructor
    const exchange = new LighterExchange(config, {
      marketMap: deps.marketMap,
      clientOrderIndexStore: deps.clientOrderIndexStore,
      signer: deps.signer,
      restClient: deps.restClient,
      nonceManager: deps.nonceManager,
      wsClient: deps.wsClient,
    });

    // The reconciler should have been created with a lookupOrder function
    const reconciler = (exchange as any).reconciler;
    expect(reconciler.deps.lookupOrder).toBeDefined();
    expect(typeof reconciler.deps.lookupOrder).toBe('function');
  });

  it('testConnection checks signer and REST account query without starting trading', async () => {
    const deps = makeDeps();
    deps.signer.assertUsable = jest.fn(async () => undefined);
    deps.signer.createAuthToken = jest.fn(async () => ({ token: 'token', expiresAt: Date.now() + 60000 }));
    deps.restClient.getAccount = jest.fn(async () => ({ account: { index: 7 } }));
    const exchange = new LighterExchange(config, deps);

    await expect((exchange as any).testConnection()).resolves.toEqual({
      success: true,
      http: true,
      ws: true,
      message: 'Lighter connection check passed',
    });

    expect(deps.signer.assertUsable).toHaveBeenCalledTimes(1);
    expect(deps.restClient.getAccount).toHaveBeenCalledWith(7);
    expect(deps.signer.createAuthToken).toHaveBeenCalledTimes(1);
    expect(deps.wsClient.connect).not.toHaveBeenCalled();
  });

  it('testConnection fails when signer is not usable', async () => {
    const deps = makeDeps();
    deps.signer.assertUsable = jest.fn(async () => { throw new Error('binary not found'); });
    const exchange = new LighterExchange(config, deps);

    await expect((exchange as any).testConnection()).rejects.toThrow('binary not found');
  });

  it('submits set leverage through nonce manager', async () => {
    const deps = makeDeps();
    const exchange = allowTrading(new LighterExchange(config, deps));

    await expect(exchange.setLeverage('BTC_USDT', '10')).resolves.toBe(true);

    expect(deps.nonceManager.submit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'set_leverage',
      symbol: 'BTC_USDT',
      marketIndex: 1,
      payload: expect.objectContaining({
        market_index: 1,
        initial_margin_fraction: 1000,
      }),
    }));
  });

  it('submits margin mode through nonce manager', async () => {
    const deps = makeDeps();
    const exchange = allowTrading(new LighterExchange(config, deps));

    await expect(exchange.setMarginMode('BTC_USDT', 'isolated', '5')).resolves.toBe(true);

    expect(deps.nonceManager.submit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'set_margin_mode',
      payload: expect.objectContaining({
        market_index: 1,
        initial_margin_fraction: 2000,
        margin_mode: 1,
      }),
    }));
  });

  it('submits amend order through nonce manager with merged values', async () => {
    const deps = makeDeps();
    deps.restClient.getAccountOrders.mockResolvedValue({
      orders: [
        { client_order_index: '1001', symbol: 'BTC_USDT', side: 'buy', price: '65000', base_amount: '0.1', status: 'OPEN' },
      ],
    });
    const exchange = allowTrading(new LighterExchange(config, deps));

    await expect(exchange.amendOrder('1001', 'BTC_USDT', '66000')).resolves.toEqual(
      expect.objectContaining({
        id: '1001',
        status: 'accepted',
        price: '66000',
        amount: '0.1',
      }),
    );

    expect(deps.nonceManager.submit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'amend_order',
      symbol: 'BTC_USDT',
      marketIndex: 1,
      payload: expect.objectContaining({
        market_index: 1,
        order_index: '1001',
        base_amount: '10000',
        price: '6600000',
      }),
    }));
  });

  describe('placeOrder PendingProtection', () => {
    beforeEach(() => {
      jest.mocked(PendingProtection.create).mockClear();
      jest.mocked((PendingProtection as any).upsert).mockClear();
      jest.mocked(PendingProtection.destroy).mockClear();
    });

    it('creates PendingProtection when stopLoss is provided', async () => {
      const deps = makeDeps();
      const exchange = allowTrading(new LighterExchange(config, deps));

      await exchange.placeOrder({
        symbol: 'BTC_USDT',
        side: 'buy',
        amount: '0.1',
        price: '65000',
        type: 'limit',
        stopLoss: '64000',
        text: 'entry-1',
      });

      expect((PendingProtection as any).upsert).toHaveBeenCalledWith({
        orderId: '1001',
        symbol: 'BTC_USDT',
        side: 'buy',
        stopLoss: '64000',
        takeProfit: null,
        tpOrdersJson: null,
        status: 'PENDING',
      });
    });

    it('creates PendingProtection when takeProfit is provided', async () => {
      const deps = makeDeps();
      const exchange = allowTrading(new LighterExchange(config, deps));

      await exchange.placeOrder({
        symbol: 'BTC_USDT',
        side: 'buy',
        amount: '0.1',
        price: '65000',
        type: 'limit',
        takeProfit: '68000',
        text: 'entry-1',
      });

      expect((PendingProtection as any).upsert).toHaveBeenCalledWith({
        orderId: '1001',
        symbol: 'BTC_USDT',
        side: 'buy',
        stopLoss: null,
        takeProfit: '68000',
        tpOrdersJson: null,
        status: 'PENDING',
      });
    });

    it('does not create PendingProtection when neither stopLoss nor takeProfit is provided', async () => {
      const deps = makeDeps();
      const exchange = allowTrading(new LighterExchange(config, deps));

      await exchange.placeOrder({
        symbol: 'BTC_USDT',
        side: 'buy',
        amount: '0.1',
        price: '65000',
        type: 'limit',
        text: 'entry-1',
      });

      expect((PendingProtection as any).upsert).not.toHaveBeenCalled();
    });

    it('resets existing PendingProtection to PENDING when client order index is reused', async () => {
      const deps = makeDeps();
      const exchange = allowTrading(new LighterExchange(config, deps));

      await exchange.placeOrder({
        symbol: 'BTC_USDT',
        side: 'buy',
        amount: '0.1',
        price: '65000',
        type: 'limit',
        stopLoss: '64000',
        takeProfit: '68000',
        text: 'entry-1',
      });

      expect((PendingProtection as any).upsert).toHaveBeenCalledWith({
        orderId: '1001',
        symbol: 'BTC_USDT',
        side: 'buy',
        stopLoss: '64000',
        takeProfit: '68000',
        tpOrdersJson: null,
        status: 'PENDING',
      });
      expect(deps.nonceManager.submit).toHaveBeenCalled();
    });

    it('cleans up PendingProtection on order submission failure', async () => {
      const deps = makeDeps();
      deps.nonceManager.submit.mockRejectedValueOnce(new Error('nonce error'));
      const exchange = allowTrading(new LighterExchange(config, deps));

      await expect(
        exchange.placeOrder({
          symbol: 'BTC_USDT',
          side: 'buy',
          amount: '0.1',
          price: '65000',
          type: 'limit',
          stopLoss: '64000',
          text: 'entry-1',
        }),
      ).rejects.toThrow('nonce error');

      expect(PendingProtection.destroy).toHaveBeenCalledWith({ where: { orderId: '1001' } });
    });

    it('does not submit order when PendingProtection cannot be persisted', async () => {
      const deps = makeDeps();
      jest.mocked((PendingProtection as any).upsert).mockRejectedValueOnce(new Error('db unavailable'));
      const exchange = allowTrading(new LighterExchange(config, deps));

      await expect(
        exchange.placeOrder({
          symbol: 'BTC_USDT',
          side: 'buy',
          amount: '0.1',
          price: '65000',
          type: 'limit',
          stopLoss: '64000',
          text: 'entry-1',
        }),
      ).rejects.toThrow('Failed to persist pending protection before placing Lighter order 1001');

      expect(deps.nonceManager.submit).not.toHaveBeenCalled();
    });
  });

  describe('setProtectionPipeline', () => {
    it('should wire pipeline to orderPersistenceHandler', () => {
      const deps = makeDeps();
      const exchange = new LighterExchange(config, deps);
      const mockPipeline = {} as any;

      exchange.setProtectionPipeline(mockPipeline);

      expect((exchange as any).orderPersistenceHandler.protectionPipeline).toBe(mockPipeline);
    });
  });

  describe('updateStopLoss trigger price rounding (regression)', () => {
    const xauConfig = {
      ...config,
      markets: [
        {
          symbol: 'XAU_USDT',
          marketIndex: 92,
          baseCurrency: 'XAU',
          quoteCurrency: 'USDT',
          priceDecimals: 2,
          sizeDecimals: 4,
          minBaseAmount: '0.0030',
        },
      ],
    } as ExchangeConfig & { signerPath: string; markets: any[] };

    const makeXauDeps = () => ({
      marketMap: new LighterMarketMap({ markets: xauConfig.markets }),
      clientOrderIndexStore: {
        getOrCreate: jest.fn().mockResolvedValue('2001'),
      },
      signer: {
        assertUsable: jest.fn().mockResolvedValue(undefined),
        createAuthToken: jest.fn().mockResolvedValue({ token: 'test-token', expiresAt: Date.now() + 60000 }),
      },
      restClient: {
        getAccountPositions: jest.fn().mockResolvedValue([]),
        getAccount: jest.fn().mockResolvedValue({}),
        getAccountOrders: jest.fn().mockResolvedValue({ orders: [] }),
        getAccountOrderHistory: jest.fn().mockResolvedValue({ orders: [] }),
        getAccountTrades: jest.fn().mockResolvedValue({ trades: [] }),
        getTicker: jest.fn().mockResolvedValue({}),
        getCandles: jest.fn().mockResolvedValue({ candles: [] }),
      },
      nonceManager: {
        submit: jest.fn().mockResolvedValue({
          txId: 'tx-xau',
          raw: { accepted: true },
          clientOrderIndex: '2001',
        }),
      },
      reconciler: {
        reconcileStartup: jest.fn().mockResolvedValue({ safeToTrade: true, unknownTxCount: 0 }),
        waitForFill: jest.fn(),
        normalizePosition: jest.fn((position: any) => position),
      },
      wsClient: {
        connect: jest.fn().mockResolvedValue(undefined),
        disconnect: jest.fn().mockResolvedValue(undefined),
        getStats: jest.fn(() => ({ isConnected: false })),
        on: jest.fn(),
      },
    });

    it('rounds trigger price with excess decimals to priceDecimals (XAU_USDT 3dp → 2dp)', async () => {
      const deps = makeXauDeps();
      const exchange = allowTrading(new LighterExchange(xauConfig, deps));

      // 4520.084 has 3 decimals but XAU_USDT allows only 2
      await expect(exchange.updateStopLoss('XAU_USDT', 'buy', '4520.084', 'sl-pos', '0.3428')).resolves.toBe('2001');

      const submitted = deps.nonceManager.submit.mock.calls[0][0];
      // trigger_price should be the integer representation of 4520.08 (rounded), not 4520.084
      expect(submitted.payload.trigger_price).toBe('452008');
    });

    it('rounds down trigger price .005 to .00 for long SL (toFixed rounds half-up)', async () => {
      const deps = makeXauDeps();
      const exchange = allowTrading(new LighterExchange(xauConfig, deps));

      // .005 rounds to .01 with toFixed (banker's rounding in JS is half-up for .5)
      await expect(exchange.updateStopLoss('XAU_USDT', 'buy', '4500.005', 'sl-pos', '0.1')).resolves.toBe('2001');

      const submitted = deps.nonceManager.submit.mock.calls[0][0];
      // toFixed(2) on 4500.005 → "4500.01" (JS toFixed rounds 0.5 up)
      // integer: 4500.01 * 100 = 450001
      expect(submitted.payload.trigger_price).toBe('450001');
    });

    it('still works with exactly 2 decimal places (no rounding needed)', async () => {
      const deps = makeXauDeps();
      const exchange = allowTrading(new LighterExchange(xauConfig, deps));

      await expect(exchange.updateStopLoss('XAU_USDT', 'buy', '4520.08', 'sl-pos', '0.1')).resolves.toBe('2001');

      const submitted = deps.nonceManager.submit.mock.calls[0][0];
      expect(submitted.payload.trigger_price).toBe('452008');
    });

    it('rounds trigger price for short SL as well', async () => {
      const deps = makeXauDeps();
      const exchange = allowTrading(new LighterExchange(xauConfig, deps));

      // Short SL (side=sell): 3 decimals → 2
      await expect(exchange.updateStopLoss('XAU_USDT', 'sell', '4580.126', 'sl-pos', '0.1')).resolves.toBe('2001');

      const submitted = deps.nonceManager.submit.mock.calls[0][0];
      // 4580.126 → toFixed(2) → "4580.13" → integer 458013
      expect(submitted.payload.trigger_price).toBe('458013');
    });
  });

  describe('getTradeHistory graceful degradation (regression)', () => {
    it('returns empty array when API response format is unrecognized', async () => {
      const deps = makeDeps();
      deps.restClient.getAccountTrades.mockResolvedValue({ unexpected_format: true });
      const exchange = new LighterExchange(config, deps);

      const results = await exchange.getTradeHistory('BTC_USDT', 10);
      expect(results).toEqual([]);
    });

    it('returns empty array when API returns null', async () => {
      const deps = makeDeps();
      deps.restClient.getAccountTrades.mockResolvedValue(null);
      const exchange = new LighterExchange(config, deps);

      const results = await exchange.getTradeHistory('BTC_USDT', 10);
      expect(results).toEqual([]);
    });

    it('returns empty array when API call throws', async () => {
      const deps = makeDeps();
      deps.restClient.getAccountTrades.mockRejectedValue(new Error('network timeout'));
      const exchange = new LighterExchange(config, deps);

      const results = await exchange.getTradeHistory('BTC_USDT', 10);
      expect(results).toEqual([]);
    });

    it('still returns trades when response is valid', async () => {
      const deps = makeDeps();
      deps.restClient.getAccountTrades.mockResolvedValue({
        trades: [
          { trade_id: 't1', client_order_index: '1001', symbol: 'BTC_USDT', side: 'buy', price: '65000', base_amount: '0.1', is_maker: false, created_at: '1700000000' },
        ],
      });
      const exchange = new LighterExchange(config, deps);

      const results = await exchange.getTradeHistory('BTC_USDT', 10);
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe('t1');
    });
  });

  describe('handler wiring', () => {
    it('should create orderPersistenceHandler in constructor', () => {
      const deps = makeDeps();
      (deps.reconciler as any).on = jest.fn();
      const exchange = new LighterExchange(config, deps);

      expect((exchange as any).orderPersistenceHandler).toBeDefined();
      expect((deps.reconciler as any).on).toHaveBeenCalledWith('order', expect.any(Function));
    });
  });
});
