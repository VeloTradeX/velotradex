import { ExchangeConfig } from '../../../../src/services/exchanges/IExchange';
import { LighterExchange } from '../../../../src/services/exchanges/lighter/LighterExchange';
import { LighterMarketMap } from '../../../../src/services/exchanges/lighter/LighterMarketMap';

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
      priceDecimals: 0,
      sizeDecimals: 1,
      minBaseAmount: '0.1',
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
  },
  restClient: {
    getAccountPositions: jest.fn().mockResolvedValue([]),
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

describe('LighterExchange protection order semantics', () => {
  it('places long stop-loss as sell reduce-only stop trigger order', async () => {
    const deps = makeDeps();
    const exchange = allowTrading(new LighterExchange(config, deps));

    await expect(exchange.updateStopLoss('BTC_USDT', 'buy', '64000', 'sl-1', '0.1')).resolves.toBe('1001');

    expect(deps.clientOrderIndexStore.getOrCreate).toHaveBeenCalledWith('lighter-main', expect.stringMatching(/^sl-1-\d+$/));
    expect(deps.nonceManager.submit).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'place_order',
      side: 'sell',
      reduceOnly: true,
      triggerPrice: '64000',
      payload: expect.objectContaining({
        is_ask: true,
        price: expect.not.stringMatching(/^0+$/),
        order_type: 'STOP_LOSS',
        reduce_only: true,
        trigger_price: '64000',
      }),
    }));
  });

  it('places short stop-loss as buy reduce-only stop trigger order', async () => {
    const deps = makeDeps();
    const exchange = allowTrading(new LighterExchange(config, deps));

    await expect(exchange.updateStopLoss('BTC_USDT', 'sell', '66000', 'sl-2', '0.1')).resolves.toBe('1001');

    expect(deps.nonceManager.submit).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'place_order',
      side: 'buy',
      reduceOnly: true,
      triggerPrice: '66000',
      payload: expect.objectContaining({
        is_ask: false,
        price: expect.not.stringMatching(/^0+$/),
        order_type: 'STOP_LOSS',
        reduce_only: true,
        trigger_price: '66000',
      }),
    }));
  });

  it('rejects stop-loss without positive amount', async () => {
    const deps = makeDeps();
    const exchange = new LighterExchange(config, deps);

    await expect(exchange.updateStopLoss('BTC_USDT', 'buy', '64000', 'sl-1')).rejects.toThrow(
      'Lighter updateStopLoss requires positive amount',
    );
    await expect(exchange.updateStopLoss('BTC_USDT', 'buy', '64000', 'sl-1', '0')).rejects.toThrow(
      'Lighter updateStopLoss requires positive amount',
    );

    expect(deps.nonceManager.submit).not.toHaveBeenCalled();
  });
});
