const wsHandlers: Record<string, (payload: any) => void> = {};

const restClientMock = {
  createOrder: jest.fn(),
  amendOrder: jest.fn(),
  cancelOrder: jest.fn(),
  getOrder: jest.fn(),
  listOrders: jest.fn(),
  createPriceOrder: jest.fn(),
  cancelPriceOrder: jest.fn(),
  cancelAllPriceOrders: jest.fn(),
  listPriceOrders: jest.fn(),
  getAccount: jest.fn(),
  getPosition: jest.fn(),
  listPositions: jest.fn(),
  listTrades: jest.fn(),
  listContracts: jest.fn(),
  listTickers: jest.fn(),
  listCandlesticks: jest.fn(),
  updateLeverage: jest.fn(),
};

jest.mock('../../../src/services/exchanges/gate/GateIORestClient', () => ({
  GateIORestClient: jest.fn().mockImplementation(() => restClientMock),
}));

jest.mock('../../../src/services/exchanges/GateIOWebSocket', () => ({
  GateIOWebSocket: jest.fn().mockImplementation(() => ({
    on: jest.fn((event: string, handler: (payload: any) => void) => {
      wsHandlers[event] = handler;
    }),
    connect: jest.fn(),
    disconnect: jest.fn(),
    waitForOpen: jest.fn(),
    getStats: jest.fn(() => ({ isConnected: true })),
    fillListeners: new Map(),
  })),
}));

jest.mock('../../../src/services/RedisService', () => ({
  __esModule: true,
  default: {
    publish: jest.fn().mockResolvedValue(undefined),
    subscribe: jest.fn().mockResolvedValue(undefined),
  },
}));

jest.mock('../../../src/models', () => ({
  PendingProtection: {
    create: jest.fn().mockResolvedValue({ id: 'pp-1' }),
    findByPk: jest.fn().mockResolvedValue(null),
    destroy: jest.fn().mockResolvedValue(undefined),
  },
  Order: {
    findOne: jest.fn().mockResolvedValue(null),
    findAll: jest.fn().mockResolvedValue([]),
  },
}));

// Jest 30 的一个已知行为：`jest.useRealTimers()` 无法恢复被 fake timers 替换的全局计时器，
// 导致后续测试出现 `setTimeout/setImmediate is not defined`。这里在每个测试后手动还原。
const realTimers = {
  setTimeout: globalThis.setTimeout,
  clearTimeout: globalThis.clearTimeout,
  setInterval: globalThis.setInterval,
  clearInterval: globalThis.clearInterval,
  setImmediate: globalThis.setImmediate,
  clearImmediate: globalThis.clearImmediate,
};

afterEach(() => {
  globalThis.setTimeout = realTimers.setTimeout;
  globalThis.clearTimeout = realTimers.clearTimeout;
  globalThis.setInterval = realTimers.setInterval;
  globalThis.clearInterval = realTimers.clearInterval;
  globalThis.setImmediate = realTimers.setImmediate;
  globalThis.clearImmediate = realTimers.clearImmediate;
});

describe('GateIOExchange websocket order routing', () => {
  beforeEach(() => {
    for (const key of Object.keys(wsHandlers)) {
      delete wsHandlers[key];
    }
    jest.resetModules();
    jest.clearAllMocks();
  });

  it('同一条 WS order_update 只处理一次', async () => {
    const { GateIOExchange } = await import('../../../src/services/exchanges/GateIOExchange');
    const exchange = new GateIOExchange({
      id: 'main',
      name: 'Main',
      baseURL: 'https://example.com',
      apiKey: 'k',
      apiSecret: 's',
      isTestnet: false,
    } as any);

    const handleSpy = jest.fn();
    (exchange as any).handleWsOrderUpdate = handleSpy;

    wsHandlers.order_update({
      id: '82472171400871789',
      status: 'finished',
      left: '0',
      text: 't-1776186464444-666',
      fillPrice: '74694.1',
      size: '429',
      contract: 'BTC_USDT',
    });

    expect(handleSpy).toHaveBeenCalledTimes(1);
  });

  it('placeOrder 保留显式传入的 text，避免 TP/SL 回报丢失来源订单标识', async () => {
    const { GateIOExchange } = await import('../../../src/services/exchanges/GateIOExchange');
    const exchange = new GateIOExchange({
      id: 'main',
      name: 'Main',
      baseURL: 'https://example.com',
      apiKey: 'k',
      apiSecret: 's',
      isTestnet: false,
    } as any);

    restClientMock.createOrder.mockResolvedValueOnce({
      id: 'tp-1',
      status: 'open',
      size: -300,
      fillPrice: '0',
    });

    await exchange.placeOrder({
      symbol: 'BTC_USDT',
      side: 'sell',
      amount: '300',
      reduceOnly: true,
      type: 'limit',
      price: '76000',
      text: 't-tp-1-ws-handler-ord-82472171401084903',
    } as any);

    expect(restClientMock.createOrder).toHaveBeenCalledWith(expect.objectContaining({
      text: 't-tp-1-ws-handler-ord-82472171401084903',
    }));
  });

  it('placeOrder 会把非 Gate 格式 text 归一化为 t- 前缀，避免 Gate 400 拒单', async () => {
    const { GateIOExchange } = await import('../../../src/services/exchanges/GateIOExchange');
    const exchange = new GateIOExchange({
      id: 'main',
      name: 'Main',
      baseURL: 'https://example.com',
      apiKey: 'k',
      apiSecret: 's',
      isTestnet: false,
    } as any);

    restClientMock.createOrder.mockResolvedValueOnce({
      id: 'entry-1',
      status: 'finished',
      size: 17,
      fillPrice: '3000',
    });

    await exchange.placeOrder({
      symbol: 'ETH_USDT',
      side: 'buy',
      amount: '17',
      reduceOnly: true,
      type: 'market',
      text: 'gate-default:ETHUSDT:default:merged:ETH_USDT:buy:2026-05-13T15:49:02.000Z:0.3:2',
    } as any);

    const placedText = restClientMock.createOrder.mock.calls[0][0].text;
    expect(placedText).toMatch(/^t-[A-Za-z0-9_.-]+$/);
    expect(Buffer.byteLength(placedText.replace(/^t-/, ''), 'utf8')).toBeLessThanOrEqual(28);
  });

  it('placeOrder 透传 tpsl_tp_trigger_price / tpsl_sl_trigger_price（订单自带 TP/SL）', async () => {
    const { GateIOExchange } = await import('../../../src/services/exchanges/GateIOExchange');
    const exchange = new GateIOExchange({
      id: 'main',
      name: 'Main',
      baseURL: 'https://example.com',
      apiKey: 'k',
      apiSecret: 's',
      isTestnet: false,
    } as any);

    restClientMock.listPositions.mockResolvedValueOnce([
      { contract: 'BTC_USDT', size: '1', leverage: '0' },
    ]);
    restClientMock.createOrder.mockResolvedValueOnce({
      id: 'entry-tpsl',
      status: 'open',
      size: 17,
      fillPrice: '0',
    });

    await exchange.placeOrder({
      symbol: 'BTC_USDT',
      side: 'buy',
      amount: '17',
      type: 'market',
      text: 't-entry-tpsl',
      tpslTpTriggerPrice: '76000',
      tpslSlTriggerPrice: '74000',
    } as any);

    expect(restClientMock.createOrder).toHaveBeenCalledWith(expect.objectContaining({
      tpslTpTriggerPrice: '76000',
      tpslSlTriggerPrice: '74000',
    }));
  });

  it('placeOrder 单 TP+SL 全自带时不创建 PendingProtection（无待挂保护）', async () => {
    const { GateIOExchange } = await import('../../../src/services/exchanges/GateIOExchange');
    const exchange = new GateIOExchange({
      id: 'main',
      name: 'Main',
      baseURL: 'https://example.com',
      apiKey: 'k',
      apiSecret: 's',
      isTestnet: false,
    } as any);

    const pendingProtectionMock = require('../../../src/models').PendingProtection;
    pendingProtectionMock.create.mockClear();
    pendingProtectionMock.findByPk.mockClear();
    pendingProtectionMock.destroy.mockClear();

    restClientMock.listPositions.mockResolvedValueOnce([
      { contract: 'BTC_USDT', size: '1', leverage: '0' },
    ]);
    restClientMock.createOrder.mockResolvedValueOnce({
      id: 'entry-tpsl-single',
      status: 'finished',
      size: 17,
      left: '0',
      fillPrice: '75000',
    });

    await exchange.placeOrder({
      symbol: 'BTC_USDT',
      side: 'buy',
      amount: '17',
      type: 'market',
      text: 't-entry-tpsl-single',
      stopLoss: '74000',
      takeProfit: '76000',
      tpOrders: [{ price: '76000', amount: '17' }],
      tpslTpTriggerPrice: '76000',
      tpslSlTriggerPrice: '74000',
    } as any);

    // 全自带：不创建待挂保护记录（交易所托管，无需 post-fill 补挂）
    expect(pendingProtectionMock.create).not.toHaveBeenCalled();
    expect(restClientMock.createOrder).toHaveBeenCalledWith(expect.objectContaining({
      tpslTpTriggerPrice: '76000',
      tpslSlTriggerPrice: '74000',
    }));
  });

  it('placeOrder 多 TP+SL：只带 SL，tpOrdersJson 保留多档 TP 供 post-fill 补挂', async () => {
    const { GateIOExchange } = await import('../../../src/services/exchanges/GateIOExchange');
    const exchange = new GateIOExchange({
      id: 'main',
      name: 'Main',
      baseURL: 'https://example.com',
      apiKey: 'k',
      apiSecret: 's',
      isTestnet: false,
    } as any);

    const pendingProtectionMock = require('../../../src/models').PendingProtection;
    pendingProtectionMock.create.mockClear();

    restClientMock.listPositions.mockResolvedValueOnce([
      { contract: 'BTC_USDT', size: '1', leverage: '0' },
    ]);
    restClientMock.createOrder.mockResolvedValueOnce({
      id: 'entry-tpsl-multi',
      status: 'open',
      size: 17,
      fillPrice: '0',
    });

    await exchange.placeOrder({
      symbol: 'BTC_USDT',
      side: 'buy',
      amount: '17',
      type: 'market',
      text: 't-entry-tpsl-multi',
      stopLoss: '74000',
      takeProfit: '76000',
      tpOrders: [
        { price: '76000', amount: '8.5' },
        { price: '77000', amount: '8.5' },
      ],
      tpslSlTriggerPrice: '74000',
    } as any);

    expect(restClientMock.createOrder).toHaveBeenCalledWith(expect.objectContaining({
      tpslSlTriggerPrice: '74000',
    }));
    // 多 TP：placeOrder 只透传 SL，TP 以 tpOrdersJson 形式等待 post-fill
    const createCalls = pendingProtectionMock.create.mock.calls;
    expect(createCalls.length).toBeGreaterThan(0);
    const lastCreate = createCalls[createCalls.length - 1][0];
    expect(lastCreate.stopLoss).toBeNull();
    expect(JSON.parse(lastCreate.tpOrdersJson).tpOrders).toHaveLength(2);
    expect(JSON.parse(lastCreate.tpOrdersJson).attachedSl).toBe(true);
  });

  it('placeOrder keeps non-post-only limit orders as GTC so they can remain open', async () => {    const { GateIOExchange } = await import('../../../src/services/exchanges/GateIOExchange');
    const exchange = new GateIOExchange({
      id: 'main',
      name: 'Main',
      baseURL: 'https://example.com',
      apiKey: 'k',
      apiSecret: 's',
      isTestnet: false,
    } as any);

    restClientMock.createOrder.mockResolvedValueOnce({
      id: 'entry-1',
      status: 'open',
      size: 184,
      fillPrice: '0',
    });

    await exchange.placeOrder({
      symbol: 'BTC_USDT',
      side: 'buy',
      amount: '184',
      reduceOnly: true,
      type: 'limit',
      price: '79555.5',
      text: 't-entry-609',
    } as any);

    expect(restClientMock.createOrder).toHaveBeenCalledWith(expect.objectContaining({
      tif: 'gtc',
      text: 't-entry-609',
    }));
  });

  it('placeOrder sends maker limit orders as post-only POC', async () => {
    const { GateIOExchange } = await import('../../../src/services/exchanges/GateIOExchange');
    const exchange = new GateIOExchange({
      id: 'main',
      name: 'Main',
      baseURL: 'https://example.com',
      apiKey: 'k',
      apiSecret: 's',
      isTestnet: false,
    } as any);

    restClientMock.createOrder.mockResolvedValueOnce({
      id: 'entry-maker',
      status: 'open',
      size: 184,
      fillPrice: '0',
    });

    await exchange.placeOrder({
      symbol: 'BTC_USDT',
      side: 'buy',
      amount: '184',
      reduceOnly: true,
      type: 'limit',
      price: '79555.5',
      postOnly: true,
      text: 't-entry-609',
    } as any);

    expect(restClientMock.createOrder).toHaveBeenCalledWith(expect.objectContaining({
      tif: 'poc',
      text: 't-entry-609',
    }));
  });

  it('placeOrder no longer mutates Gate margin mode for opening orders', async () => {
    const { GateIOExchange } = await import('../../../src/services/exchanges/GateIOExchange');
    const exchange = new GateIOExchange({
      id: 'main',
      name: 'Main',
      baseURL: 'https://example.com',
      apiKey: 'k',
      apiSecret: 's',
      isTestnet: false,
    } as any);

    // CRITICAL: Mock listPositions to return a cross-margin position (leverage='0'),
    // so that getPosition() detects isCross=true and skips setMarginMode → updateLeverage.
    // getPosition() uses listPositions (not the old getPosition) due to Hedge Mode fix.
    restClientMock.listPositions.mockResolvedValueOnce([
      { contract: 'BTC_USDT', size: '1', leverage: '0' },
    ]);
    restClientMock.createOrder.mockResolvedValueOnce({
      id: 'entry-cross',
      status: 'open',
      size: 184,
      fillPrice: '0',
    });

    await exchange.placeOrder({
      symbol: 'BTC_USDT',
      side: 'buy',
      amount: '184',
      type: 'limit',
      price: '79555.5',
      text: 't-entry-cross',
    } as any);

    expect(restClientMock.updateLeverage).not.toHaveBeenCalled();
    expect(restClientMock.createOrder).toHaveBeenCalledWith(expect.objectContaining({
      contract: 'BTC_USDT',
      tif: 'gtc',
      text: 't-entry-cross',
    }));
  });

  it('does not REST fallback when Gate rejects a post-only order that would immediately match', async () => {
    const { GateIOExchange } = await import('../../../src/services/exchanges/GateIOExchange');
    const exchange = new GateIOExchange({
      id: 'main',
      name: 'Main',
      baseURL: 'https://example.com',
      apiKey: 'k',
      apiSecret: 's',
      isTestnet: false,
    } as any);

    restClientMock.createOrder.mockRejectedValueOnce(Object.assign(
      new Error('ORDER_POC_IMMEDIATE: order price 79555.5 while counter price 79550.1'),
      {
        label: 'ORDER_POC_IMMEDIATE',
        responseBody: {
          label: 'ORDER_POC_IMMEDIATE',
          message: 'order price 79555.5 while counter price 79550.1',
        },
      },
    ));

    await expect(exchange.placeOrder({
      symbol: 'BTC_USDT',
      side: 'buy',
      amount: '184',
      reduceOnly: true,
      type: 'limit',
      price: '79555.5',
      postOnly: true,
      text: 't-entry-609',
    } as any)).rejects.toThrow('ORDER_POC_IMMEDIATE');

    expect((exchange as any).ws.placeOrder).toBeUndefined();
  });

  it('fetches futures candles and normalizes candle fields', async () => {
    const { GateIOExchange } = await import('../../../src/services/exchanges/GateIOExchange');
    const exchange = new GateIOExchange({
      id: 'main',
      name: 'Main',
      baseURL: 'https://example.com',
      apiKey: 'k',
      apiSecret: 's',
      isTestnet: false,
    } as any);

    restClientMock.listCandlesticks.mockResolvedValueOnce([
      { t: 1713955200, o: '10', h: '12', l: '9', c: '11', v: '100' },
    ]);

    const candles = await exchange.getCandles('INIT_USDT', '4h', 2);

    expect(restClientMock.listCandlesticks).toHaveBeenCalledWith('INIT_USDT', '4h', 2);
    expect(candles).toEqual([
      { timestamp: 1713955200000, open: '10', high: '12', low: '9', close: '11', volume: '100' },
    ]);
  });
});

describe('GateIOExchange query methods use restClient', () => {
  let exchange: any;

  beforeEach(async () => {
    jest.clearAllMocks();
    const { GateIOExchange } = await import('../../../src/services/exchanges/GateIOExchange');
    exchange = new GateIOExchange({
      id: 'test', name: 'Test', baseURL: 'https://example.com',
      apiKey: 'k', apiSecret: 's', isTestnet: false,
    } as any);
  });

  it('getBalance uses restClient.getAccount and maps fields', async () => {
    restClientMock.getAccount.mockResolvedValueOnce({
      available: '5000.00',
      total: '10000.00',
      unrealisedPnl: '123.45',
    });

    const balance = await exchange.getBalance('USDT');

    expect(restClientMock.getAccount).toHaveBeenCalled();
    expect(balance).toEqual({
      currency: 'USDT',
      available: '5000.00',
      total: '10000.00',
      unrealizedPnl: '123.45',
    });
  });

  it('getBalance returns zeros on error', async () => {
    restClientMock.getAccount.mockRejectedValueOnce(new Error('fail'));

    const balance = await exchange.getBalance('USDT');
    expect(balance).toEqual({ currency: 'USDT', available: '0', total: '0' });
  });

  it('getPosition uses restClient.listPositions and maps fields', async () => {
    restClientMock.listPositions.mockResolvedValueOnce([
      { contract: 'BTC_USDT', size: '100', entryPrice: '50000', markPrice: '51000', unrealisedPnl: '1000', leverage: '0', mode: 'dual' },
    ]);

    const pos = await exchange.getPosition('BTC_USDT');

    expect(restClientMock.listPositions).toHaveBeenCalled();
    expect(pos).toEqual({
      symbol: 'BTC_USDT',
      size: '100',
      entryPrice: '50000',
      markPrice: '51000',
      unrealizedPnl: '1000',
      leverage: '0',
      marginType: 'cross',
    });
  });

  it('getPosition ignores zero-size hedge side and returns the live short position', async () => {
    restClientMock.listPositions.mockResolvedValueOnce([
      { contract: 'BTC_USDT', size: '0', entryPrice: '0', markPrice: '64113.4', unrealisedPnl: '0', leverage: '0', mode: 'dual' },
      { contract: 'BTC_USDT', size: '-45', entryPrice: '64123.1', markPrice: '64113.4', unrealisedPnl: '1.25', leverage: '0', mode: 'dual' },
    ]);

    const pos = await exchange.getPosition('BTC_USDT');

    expect(pos).toEqual({
      symbol: 'BTC_USDT',
      size: '-45',
      entryPrice: '64123.1',
      markPrice: '64113.4',
      unrealizedPnl: '1.25',
      leverage: '0',
      marginType: 'cross',
    });
  });

  it('getPosition returns null when symbol not found in positions list', async () => {
    restClientMock.listPositions.mockResolvedValueOnce([]);

    const pos = await exchange.getPosition('BTC_USDT');
    expect(pos).toBeNull();
  });

  it('getPosition returns null on error', async () => {
    restClientMock.listPositions.mockRejectedValueOnce(new Error('not found'));
    const pos = await exchange.getPosition('BTC_USDT');
    expect(pos).toBeNull();
  });

  it('getPositions uses restClient.listPositions and maps fields', async () => {
    restClientMock.listPositions.mockResolvedValueOnce([
      { contract: 'BTC_USDT', size: '100', entryPrice: '50000', markPrice: '51000', unrealisedPnl: '1000', leverage: '0', mode: 'dual' },
    ]);

    const positions = await exchange.getPositions();

    expect(restClientMock.listPositions).toHaveBeenCalled();
    expect(positions).toEqual([{
      symbol: 'BTC_USDT',
      size: '100',
      entryPrice: '50000',
      markPrice: '51000',
      unrealizedPnl: '1000',
      leverage: '0',
      marginType: 'cross',
    }]);
  });

  it('getOpenOrders uses restClient.listOrders and filters by symbol', async () => {
    restClientMock.listOrders.mockResolvedValueOnce([
      { id: '1', contract: 'BTC_USDT', status: 'open', price: '50000', size: '-100', text: 't-1' },
      { id: '2', contract: 'ETH_USDT', status: 'open', price: '3000', size: '50', text: 't-2' },
    ]);

    const orders = await exchange.getOpenOrders('BTC_USDT');

    expect(restClientMock.listOrders).toHaveBeenCalledWith({ status: 'open' });
    expect(orders).toHaveLength(1);
    expect(orders[0].id).toBe('1');
    expect(orders[0].symbol).toBe('BTC_USDT');
    expect(orders[0].amount).toBe('100');
  });

  it('getOpenOrders returns all when no symbol filter', async () => {
    restClientMock.listOrders.mockResolvedValueOnce([
      { id: '1', contract: 'BTC_USDT', status: 'open', price: '50000', size: '100', text: 't-1' },
      { id: '2', contract: 'ETH_USDT', status: 'open', price: '3000', size: '50', text: 't-2' },
    ]);

    const orders = await exchange.getOpenOrders();
    expect(orders).toHaveLength(2);
  });

  it('getPriceOrders uses restClient.listPriceOrders and filters by symbol', async () => {
    restClientMock.listPriceOrders.mockResolvedValueOnce([
      { id: '10', initial: { contract: 'BTC_USDT', price: '0', size: '-100', reduce_only: true, is_reduce_only: true, text: 'sl-trigger' }, trigger: { rule: 2, price: '49000' } },
      { id: '11', initial: { contract: 'ETH_USDT', price: '0', size: '-50', reduce_only: true, is_reduce_only: true, text: 'sl-trigger' }, trigger: { rule: 2, price: '2800' } },
    ]);

    const orders = await exchange.getPriceOrders('BTC_USDT');

    expect(restClientMock.listPriceOrders).toHaveBeenCalledWith({ status: 'open' });
    expect(orders).toHaveLength(1);
    expect(orders[0].id).toBe('10');
    expect(orders[0].stopLoss).toBe('0');
  });

  it('getTradeHistory uses restClient.listTrades and maps fields', async () => {
    restClientMock.listTrades.mockResolvedValueOnce([
      // CRITICAL: Use camelCase field names matching SDK deserialization output.
      // SDK returns orderId/createTime, NOT order_id/create_time.
      // See gateio-sdk-snake-case-trap memory for details.
      { id: '100', orderId: '200', contract: 'BTC_USDT', size: '10', price: '50000', role: 'taker', createTime: 1713955200, text: 't-1' },
    ]);

    const trades = await exchange.getTradeHistory('BTC_USDT', 50);

    expect(restClientMock.listTrades).toHaveBeenCalledWith('BTC_USDT', 50);
    expect(trades).toEqual([{
      id: '100',
      orderId: '200',
      symbol: 'BTC_USDT',
      side: 'buy',
      price: '50000',
      amount: '10',
      role: 'taker',
      time: 1713955200000,
      text: 't-1',
    }]);
  });

  it('getMarkets with forceRefresh uses restClient.listContracts', async () => {
    restClientMock.listContracts.mockResolvedValueOnce([
      // CRITICAL: Use camelCase field names matching SDK deserialization output.
      // SDK returns orderPriceRound/quantoMultiplier/leverageMin/leverageMax,
      // NOT order_price_round/quanto_multiplier/leverage_min/leverage_max.
      // See gateio-sdk-snake-case-trap memory for details.
      { name: 'BTC_USDT', orderPriceRound: '0.1', quantoMultiplier: '0.0001', leverageMin: '1', leverageMax: '100' },
      { name: 'ETH_USDT', orderPriceRound: '0.01', quantoMultiplier: '0.001', leverageMin: '1', leverageMax: '50' },
      { name: 'SOL_USDT', orderPriceRound: '0.01', quantoMultiplier: '0.1', leverageMin: '1', leverageMax: '50' },
      { name: 'XRP_USDT', orderPriceRound: '0.0001', quantoMultiplier: '1', leverageMin: '1', leverageMax: '50' },
      { name: 'DOGE_USDT', orderPriceRound: '0.00001', quantoMultiplier: '1', leverageMin: '1', leverageMax: '50' },
      { name: 'ADA_USDT', orderPriceRound: '0.0001', quantoMultiplier: '1', leverageMin: '1', leverageMax: '50' },
      { name: 'BNB_USDT', orderPriceRound: '0.01', quantoMultiplier: '0.01', leverageMin: '1', leverageMax: '50' },
      { name: 'TRX_USDT', orderPriceRound: '0.00001', quantoMultiplier: '1', leverageMin: '1', leverageMax: '50' },
      { name: 'LINK_USDT', orderPriceRound: '0.001', quantoMultiplier: '0.1', leverageMin: '1', leverageMax: '50' },
      { name: 'DOT_USDT', orderPriceRound: '0.001', quantoMultiplier: '0.1', leverageMin: '1', leverageMax: '50' },
    ]);

    // Mock fs to avoid cache file side effects
    const fs = require('fs');
    jest.spyOn(fs, 'existsSync').mockReturnValue(false);

    const markets = await exchange.getMarkets(true);

    expect(restClientMock.listContracts).toHaveBeenCalled();
    expect(markets[0]).toEqual(expect.objectContaining({
      symbol: 'BTC_USDT',
      tickSize: '0.1',
      pricePrecision: 1,
    }));

    fs.existsSync.mockRestore();
  });

  it('getTicker uses restClient.listTickers and maps fields', async () => {
    restClientMock.listTickers.mockResolvedValueOnce([{
      contract: 'BTC_USDT',
      last: '50000',
      markPrice: '50100',
      indexPrice: '50050',
      fundingRate: '0.0001',
      volume24h: '12345',
      changePercentage: '2.5',
    }]);

    const ticker = await exchange.getTicker('BTC_USDT');

    expect(restClientMock.listTickers).toHaveBeenCalledWith('BTC_USDT');
    expect(ticker).toEqual({
      symbol: 'BTC_USDT',
      lastPrice: '50000',
      markPrice: '50100',
      indexPrice: '50050',
      fundingRate: '0.0001',
      volume24h: '12345',
      change24h: '2.5',
    });
  });

  it('setLeverage calls restClient.updateLeverage and returns true on success', async () => {
    restClientMock.updateLeverage.mockResolvedValueOnce({});

    const result = await exchange.setLeverage('BTC_USDT', '10');

    expect(restClientMock.updateLeverage).toHaveBeenCalledWith('BTC_USDT', '10');
    expect(result).toBe(true);
  });

  it('setLeverage throws on updateLeverage failure', async () => {
    restClientMock.updateLeverage.mockRejectedValueOnce(new Error('API error'));

    await expect(exchange.setLeverage('BTC_USDT', '10')).rejects.toThrow('API error');
  });
});

describe('isRetryableError (shared retryUtils)', () => {
  let isRetryableError: (error: unknown) => boolean;

  beforeAll(async () => {
    const mod = await import('../../../src/utils/retryUtils');
    isRetryableError = mod.isRetryableError;
  });

  it('returns true for ECONNRESET', () => {
    expect(isRetryableError({ code: 'ECONNRESET' })).toBe(true);
  });

  it('returns true for ETIMEDOUT', () => {
    expect(isRetryableError({ code: 'ETIMEDOUT' })).toBe(true);
  });

  it('returns true for HTTP 429', () => {
    expect(isRetryableError({ response: { status: 429 } })).toBe(true);
  });

  it('returns true for normalized HTTP 429', () => {
    expect(isRetryableError({ status: 429 })).toBe(true);
  });

  it('returns true for HTTP 500', () => {
    expect(isRetryableError({ response: { status: 500 } })).toBe(true);
  });

  it('returns true for socket hang up message', () => {
    expect(isRetryableError({ message: 'socket hang up' })).toBe(true);
  });

  it('returns false for HTTP 400 (business error)', () => {
    expect(isRetryableError({ response: { status: 400 } })).toBe(false);
  });

  it('returns false for normalized HTTP 400 business error', () => {
    expect(isRetryableError({ status: 400, label: 'INVALID_PARAM_VALUE' })).toBe(false);
  });

  it('returns false for null/undefined error (treats as non-retryable, safe for trading)', () => {
    expect(isRetryableError(null as any)).toBe(false);
    expect(isRetryableError(undefined as any)).toBe(false);
  });

  it('returns false for AUTO_ORDER_NOT_FOUND (top-level label)', () => {
    expect(isRetryableError({ label: 'AUTO_ORDER_NOT_FOUND' })).toBe(false);
  });

  it('returns false for AUTO_USER_EXIST_POSITION_ORDER (top-level label, non-retryable by default)', () => {
    expect(isRetryableError({ label: 'AUTO_USER_EXIST_POSITION_ORDER' })).toBe(false);
  });

  it('returns false for INVALID_PARAM_VALUE (top-level label, business error)', () => {
    expect(isRetryableError({ status: 400, label: 'INVALID_PARAM_VALUE' })).toBe(false);
  });
});

describe('waitForOrderFill REST fallback', () => {
  let exchange: any;

  beforeEach(async () => {
    jest.clearAllMocks();
    const { GateIOExchange } = await import('../../../src/services/exchanges/GateIOExchange');
    exchange = new GateIOExchange({
      id: 'test', name: 'Test', baseURL: 'https://example.com',
      apiKey: 'k', apiSecret: 's', isTestnet: false,
    } as any);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('resolves filled via REST fallback when WS listener times out and order is finished with left=0', async () => {
    jest.useFakeTimers();

    restClientMock.getOrder.mockResolvedValueOnce({
      id: '123',
      status: 'finished',
      size: '1',
      fillPrice: '50000',
      left: '0',
      contract: 'BTC_USDT',
    });

    const promise = exchange.waitForOrderFill('123', 'BTC_USDT', 10000);

    await jest.advanceTimersByTimeAsync(10000);

    const result = await promise;

    expect(restClientMock.getOrder).toHaveBeenCalledWith('BTC_USDT', '123');
    expect(result).toEqual({
      id: '123',
      status: 'filled',
      amount: '1',
      price: '50000',
      raw: expect.objectContaining({ id: '123', status: 'finished', left: '0' }),
    });
  });

  it('resolves filled via REST fallback when WS listener times out and order is finished with left null', async () => {
    jest.useFakeTimers();

    restClientMock.getOrder.mockResolvedValueOnce({
      id: '456',
      status: 'finished',
      size: '2',
      fillPrice: '3000',
      left: null,
      contract: 'ETH_USDT',
    });

    const promise = exchange.waitForOrderFill('456', 'ETH_USDT', 10000);

    await jest.advanceTimersByTimeAsync(10000);

    const result = await promise;

    expect(restClientMock.getOrder).toHaveBeenCalledWith('ETH_USDT', '456');
    expect(result).toEqual({
      id: '456',
      status: 'filled',
      amount: '2',
      price: '3000',
      raw: expect.objectContaining({ id: '456', status: 'finished', left: null }),
    });
  });

  it('rejects with timeout when REST fallback sees an open/unfilled order', async () => {
    jest.useFakeTimers();

    // mockResolvedValue（非 Once）：预检与超时兜底都会查询到同一 open 状态
    restClientMock.getOrder.mockResolvedValue({
      id: '123',
      status: 'open',
      size: '1',
      fillPrice: '0',
      left: '1',
      contract: 'BTC_USDT',
    });

    const promise = exchange.waitForOrderFill('123', 'BTC_USDT', 10000);
    const errorPromise = promise.catch((e: unknown) => e);

    await jest.advanceTimersByTimeAsync(10000);

    const err = await errorPromise;
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe('Timeout waiting for order fill: 123');
  });

  it('resolves filled via REST fallback when order finished with partial fill (P0-2)', async () => {
    jest.useFakeTimers();

    // finished + left>0 但 |size|-|left| > 0 → 部分成交，应视为 filled 而不是 cancelled
    restClientMock.getOrder.mockResolvedValue({
      id: '789',
      status: 'finished',
      size: '1',
      fillPrice: '51000',
      left: '0.5',
      contract: 'BTC_USDT',
    });

    const promise = exchange.waitForOrderFill('789', 'BTC_USDT', 10000);

    await jest.advanceTimersByTimeAsync(10000);

    const result = await promise;
    expect(result.status).toBe('filled');
    expect(result.amount).toBe('0.5');
    expect(result.price).toBe('51000');
  });

  it('rejects with timeout when REST fallback getOrder throws', async () => {
    jest.useFakeTimers();

    restClientMock.getOrder.mockRejectedValue(new Error('network error'));

    const promise = exchange.waitForOrderFill('123', 'BTC_USDT', 10000);
    const errorPromise = promise.catch((e: unknown) => e);

    await jest.advanceTimersByTimeAsync(10000);

    const err = await errorPromise;
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe('Timeout waiting for order fill: 123');
  });

  it('WS listener resolves before timeout; REST pre-check runs once (P0-3)', async () => {
    jest.useFakeTimers();

    // 预检：订单仍 open → 不 resolve，继续等待 WS listener
    restClientMock.getOrder.mockResolvedValue({
      id: '123',
      status: 'open',
      size: '1',
      fillPrice: '0',
      left: '1',
      contract: 'BTC_USDT',
    });

    const promise = exchange.waitForOrderFill('123', 'BTC_USDT', 10000);

    const listener = (exchange as any).fillListeners.get('123');
    listener({ id: '123', status: 'filled', amount: '1', price: '50000', raw: { left: '0' } });

    const result = await promise;

    expect(result).toEqual({ id: '123', status: 'filled', amount: '1', price: '50000', raw: { left: '0' } });
    // 双检：注册 listener 后立刻有一次 REST 预检
    expect(restClientMock.getOrder).toHaveBeenCalledTimes(1);
    expect(restClientMock.getOrder).toHaveBeenCalledWith('BTC_USDT', '123');

    await jest.advanceTimersByTimeAsync(10000);
    // 超时兜底不应再次查询（已被 WS listener 解决）
    expect(restClientMock.getOrder).toHaveBeenCalledTimes(1);
  });

  it('removes fill listener and clears timer once settled via WS', async () => {
    jest.useFakeTimers();

    const promise = exchange.waitForOrderFill('123', 'BTC_USDT', 10000);

    const listener = (exchange as any).fillListeners.get('123');
    listener({ id: '123', status: 'filled', amount: '1', price: '50000', raw: { left: '0' } });

    await promise;

    expect((exchange as any).fillListeners.has('123')).toBe(false);

    await jest.advanceTimersByTimeAsync(10000);
    // 双检预检 1 次；WS listener 已解决后超时兜底不再查询
    expect(restClientMock.getOrder).toHaveBeenCalledTimes(1);
  });

  it('removes fill listener and clears timer once settled via REST fallback', async () => {
    jest.useFakeTimers();

    restClientMock.getOrder.mockResolvedValueOnce({
      id: '123',
      status: 'finished',
      size: '1',
      fillPrice: '50000',
      left: '0',
      contract: 'BTC_USDT',
    });

    const promise = exchange.waitForOrderFill('123', 'BTC_USDT', 10000);

    await jest.advanceTimersByTimeAsync(10000);
    await promise;

    expect((exchange as any).fillListeners.has('123')).toBe(false);
  });
});

describe('withRetry (shared retryUtils)', () => {
  let withRetryFn: typeof import('../../../src/utils/retryUtils').withRetry;

  beforeAll(async () => {
    const mod = await import('../../../src/utils/retryUtils');
    withRetryFn = mod.withRetry;
  });

  it('returns result directly when fn succeeds', async () => {
    const fn = jest.fn().mockResolvedValue('ok');
    const result = await withRetryFn(fn, { label: 'test', maxRetries: 3 });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('throws immediately for non-retryable errors (HTTP 400)', async () => {
    const error = { status: 400 };
    const fn = jest.fn().mockRejectedValue(error);
    await expect(withRetryFn(fn, { label: 'test', maxRetries: 3 })).rejects.toEqual(error);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('throws immediately for INVALID_PARAM_VALUE without retries', async () => {
    const error = { label: 'INVALID_PARAM_VALUE', message: 'bad param' };
    const fn = jest.fn().mockRejectedValue(error);
    await expect(withRetryFn(fn, { label: 'test', maxRetries: 3 })).rejects.toEqual(error);
    expect(fn).toHaveBeenCalledTimes(1); // no retries
  });

  it('retries up to maxRetries for retryable errors', async () => {
    const error = { code: 'ECONNRESET' };
    const fn = jest.fn()
      .mockRejectedValueOnce(error)
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce('ok');
    const result = await withRetryFn(fn, { label: 'test', maxRetries: 3, baseDelayMs: 1, maxJitterMs: 0 });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('throws after exhausting all attempts', async () => {
    const error = { code: 'ECONNRESET' };
    const fn = jest.fn().mockRejectedValue(error);
    await expect(withRetryFn(fn, { label: 'test', maxRetries: 3, baseDelayMs: 1, maxJitterMs: 0 })).rejects.toEqual(error);
    expect(fn).toHaveBeenCalledTimes(4); // 1 initial + 3 retries
  });
});
