// Regression tests for two bugs:
// 1. updateStopLoss: old SL not cancelled because Gate.io returns isReduceOnly=false (camelCase)
//    Fix: use text prefix 't-sl-pos-' + rule to identify SL orders instead of reduce_only
// 2. getPriceOrders: mapping puts ...o last, overriding reduce_only/is_reduce_only with undefined
//    Fix: put ...o first, map fields after; also read camelCase isReduceOnly/autoSize

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

describe('updateStopLoss regression — old SL must be cancelled using text prefix', () => {
  let exchange: any;

  beforeEach(async () => {
    jest.clearAllMocks();
    for (const key of Object.keys(wsHandlers)) { delete wsHandlers[key]; }
    jest.resetModules();

    const { GateIOExchange } = await import('../../../src/services/exchanges/GateIOExchange');
    exchange = new GateIOExchange({
      id: 'test', name: 'Test', baseURL: 'https://example.com',
      apiKey: 'k', apiSecret: 's', isTestnet: false,
    } as any);
  });

  it('cancels old SL when Gate.io returns isReduceOnly=false (camelCase, value=false)', async () => {
    // Regression: Gate.io API returns initial.isReduceOnly=false, initial.isClose=false
    // Old code filtered by reduce_only === true → always undefined → old SL never cancelled
    // Fix: use text prefix 't-sl-pos-' + rule to identify SL orders
    const oldSLId = 'sl-old-12345'; // Use string ID to avoid JS BigInt precision loss
    restClientMock.listPriceOrders.mockResolvedValueOnce([{
      id: oldSLId,
      trigger: { rule: 2, price: '84.85', strategy_type: 0, price_type: 0, expiration: 2592000 },
      initial: {
        contract: 'SOL_USDT',
        size: -40,
        price: '0',
        tif: 'ioc',
        text: 't-sl-pos-SOL_USDT-buy',
        // Gate.io actual API response — camelCase, values are false
        isReduceOnly: false,
        isClose: false,
        autoSize: '',
      },
    }]);
    restClientMock.cancelPriceOrder.mockResolvedValueOnce({ id: oldSLId });
    restClientMock.createPriceOrder.mockResolvedValueOnce({
      id: 'new-sl-1',
      initial: { contract: 'SOL_USDT' },
      trigger: { rule: 2 },
    });
    // formatPrice needs markets
    restClientMock.listContracts.mockResolvedValueOnce([
      { name: 'SOL_USDT', order_price_round: '0.01' },
    ]);
    const fs = require('fs');
    jest.spyOn(fs, 'existsSync').mockReturnValue(false);
    jest.spyOn(fs, 'readFileSync').mockReturnValue('');

    await exchange.updateStopLoss('SOL_USDT', 'buy', '86.00', 't-sl-pos-SOL_USDT-buy', '17');

    // Old SL must be cancelled (cancelPriceOrder signature: orderId, settle)
    expect(restClientMock.cancelPriceOrder).toHaveBeenCalledWith(oldSLId);
    // New SL must be created
    expect(restClientMock.createPriceOrder).toHaveBeenCalled();

    fs.existsSync.mockRestore();
    fs.readFileSync.mockRestore();
  });

  it('does NOT cancel non-SL price orders that have different text prefix', async () => {
    restClientMock.listPriceOrders.mockResolvedValueOnce([{
      id: 'other-trigger-1',
      trigger: { rule: 1, price: '90.00' },
      initial: {
        contract: 'SOL_USDT',
        size: 10,
        price: '0',
        text: 'custom-trigger-order',
        isReduceOnly: false,
      },
    }]);
    restClientMock.createPriceOrder.mockResolvedValueOnce({
      id: 'new-sl-1',
      initial: { contract: 'SOL_USDT' },
      trigger: { rule: 1 },
    });
    restClientMock.listContracts.mockResolvedValueOnce([
      { name: 'SOL_USDT', order_price_round: '0.01' },
    ]);
    const fs = require('fs');
    jest.spyOn(fs, 'existsSync').mockReturnValue(false);
    jest.spyOn(fs, 'readFileSync').mockReturnValue('');

    await exchange.updateStopLoss('SOL_USDT', 'sell', '86.10', 't-sl-pos-SOL_USDT-sell', '27');

    // Non-SL order must NOT be cancelled
    expect(restClientMock.cancelPriceOrder).not.toHaveBeenCalled();

    fs.existsSync.mockRestore();
    fs.readFileSync.mockRestore();
  });

  it('cancels multiple old SL orders with same text prefix + rule', async () => {
    restClientMock.listPriceOrders.mockResolvedValueOnce([
      {
        id: 'sl-old-1',
        trigger: { rule: 2, price: '84.85' },
        initial: { contract: 'SOL_USDT', text: 't-sl-pos-SOL_USDT-buy', isReduceOnly: false },
      },
      {
        id: 'sl-old-2',
        trigger: { rule: 2, price: '85.00' },
        initial: { contract: 'SOL_USDT', text: 't-sl-pos-SOL_USDT-buy', isReduceOnly: false },
      },
    ]);
    restClientMock.cancelPriceOrder
      .mockResolvedValueOnce({ id: 'sl-old-1' })
      .mockResolvedValueOnce({ id: 'sl-old-2' });
    restClientMock.createPriceOrder.mockResolvedValueOnce({
      id: 'new-sl-multi',
      initial: { contract: 'SOL_USDT' },
      trigger: { rule: 2 },
    });
    restClientMock.listContracts.mockResolvedValueOnce([
      { name: 'SOL_USDT', order_price_round: '0.01' },
    ]);
    const fs = require('fs');
    jest.spyOn(fs, 'existsSync').mockReturnValue(false);
    jest.spyOn(fs, 'readFileSync').mockReturnValue('');

    await exchange.updateStopLoss('SOL_USDT', 'buy', '86.00', 't-sl-pos-SOL_USDT-buy', '17');

    expect(restClientMock.cancelPriceOrder).toHaveBeenCalledWith('sl-old-1');
    expect(restClientMock.cancelPriceOrder).toHaveBeenCalledWith('sl-old-2');

    fs.existsSync.mockRestore();
    fs.readFileSync.mockRestore();
  });

  it('sell-side SL uses rule=1 and cancels matching t-sl-pos-sell orders', async () => {
    restClientMock.listPriceOrders.mockResolvedValueOnce([{
      id: 'sl-sell-1',
      trigger: { rule: 1, price: '86.85' },
      initial: { contract: 'SOL_USDT', text: 't-sl-pos-SOL_USDT-sell', isReduceOnly: false },
    }]);
    restClientMock.cancelPriceOrder.mockResolvedValueOnce({ id: 'sl-sell-1' });
    restClientMock.createPriceOrder.mockResolvedValueOnce({
      id: 'new-sell-sl',
      initial: { contract: 'SOL_USDT' },
      trigger: { rule: 1 },
    });
    restClientMock.listContracts.mockResolvedValueOnce([
      { name: 'SOL_USDT', order_price_round: '0.01' },
    ]);
    const fs = require('fs');
    jest.spyOn(fs, 'existsSync').mockReturnValue(false);
    jest.spyOn(fs, 'readFileSync').mockReturnValue('');

    await exchange.updateStopLoss('SOL_USDT', 'sell', '86.10', 't-sl-pos-SOL_USDT-sell', '27');

    expect(restClientMock.cancelPriceOrder).toHaveBeenCalledWith('sl-sell-1');

    fs.existsSync.mockRestore();
    fs.readFileSync.mockRestore();
  });

  it('ignores buy-side SL when updating sell-side SL (different rule)', async () => {
    restClientMock.listPriceOrders.mockResolvedValueOnce([{
      id: 'sl-buy-1',
      trigger: { rule: 2, price: '84.85' },  // buy SL uses rule=2
      initial: { contract: 'SOL_USDT', text: 't-sl-pos-SOL_USDT-buy' },
    }]);
    restClientMock.createPriceOrder.mockResolvedValueOnce({
      id: 'new-sell-sl',
      initial: { contract: 'SOL_USDT' },
      trigger: { rule: 1 },
    });
    restClientMock.listContracts.mockResolvedValueOnce([
      { name: 'SOL_USDT', order_price_round: '0.01' },
    ]);
    const fs = require('fs');
    jest.spyOn(fs, 'existsSync').mockReturnValue(false);
    jest.spyOn(fs, 'readFileSync').mockReturnValue('');

    await exchange.updateStopLoss('SOL_USDT', 'sell', '86.10', 't-sl-pos-SOL_USDT-sell', '27');

    // Buy-side SL (rule=2) must NOT be cancelled when updating sell-side (rule=1)
    expect(restClientMock.cancelPriceOrder).not.toHaveBeenCalledWith('sl-buy-1');

    fs.existsSync.mockRestore();
    fs.readFileSync.mockRestore();
  });
});

describe('getPriceOrders regression — Gate.io camelCase field mapping', () => {
  let exchange: any;

  beforeEach(async () => {
    jest.clearAllMocks();
    for (const key of Object.keys(wsHandlers)) { delete wsHandlers[key]; }
    jest.resetModules();

    const { GateIOExchange } = await import('../../../src/services/exchanges/GateIOExchange');
    exchange = new GateIOExchange({
      id: 'test', name: 'Test', baseURL: 'https://example.com',
      apiKey: 'k', apiSecret: 's', isTestnet: false,
    } as any);
  });

  it('maps isReduceOnly from camelCase when snake_case absent', async () => {
    // Gate.io actual API returns: isReduceOnly (camelCase), autoSize, isClose
    // ...o spread must NOT override mapped fields
    restClientMock.listPriceOrders.mockResolvedValueOnce([{
      id: 12345,
      trigger: { rule: 2, price: '84.85' },
      initial: {
        contract: 'SOL_USDT',
        size: -40,
        price: '0',
        tif: 'ioc',
        text: 't-sl-pos-SOL_USDT-buy',
        isReduceOnly: false,
        isClose: false,
        autoSize: '',
      },
    }]);

    const orders = await exchange.getPriceOrders('SOL_USDT');

    expect(orders).toHaveLength(1);
    // is_reduce_only should map from camelCase isReduceOnly (not undefined)
    expect(orders[0].is_reduce_only).toBe(false);
    // auto_size should map from camelCase autoSize (not undefined)
    expect(orders[0].auto_size).toBe('');
    expect(orders[0].id).toBe('12345');
  });

  it('maps is_reduce_only from snake_case when camelCase absent', async () => {
    // Some Gate.io API versions or SDK wrappers may return snake_case
    restClientMock.listPriceOrders.mockResolvedValueOnce([{
      id: 12345,
      trigger: { rule: 2, price: '84.85' },
      initial: {
        contract: 'SOL_USDT',
        size: -40,
        price: '0',
        text: 't-sl-pos-SOL_USDT-buy',
        // Only snake_case present (no camelCase)
        is_reduce_only: true,
        auto_size: 'close',
      },
    }]);

    const orders = await exchange.getPriceOrders('SOL_USDT');

    expect(orders[0].is_reduce_only).toBe(true);
    expect(orders[0].auto_size).toBe('close');
  });
});