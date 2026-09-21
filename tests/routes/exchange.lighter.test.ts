import {
  preserveSensitiveConfig,
  redactSensitiveConfig,
  sensitiveFields,
} from '../../src/routes/exchangeConfig';
import {
  applyDefaultConfig,
  serializeExchangeInstance,
} from '../../src/routes/exchange';

describe('exchange route lighter defaults', () => {
  it('applies lighter config defaults', () => {
    const config: any = {};

    applyDefaultConfig('lighter', config);

    expect(config).toEqual({
      baseURL: 'https://mainnet.zklighter.elliot.ai',
      wsURL: 'wss://mainnet.zklighter.elliot.ai/stream',
      balanceCurrency: 'USDC',
      defaultSlippageBps: 30,
      markets: [],
    });
  });

  it('preserves explicit lighter config values and valid markets array', () => {
    const markets = [
      {
        symbol: 'ETH_USDC',
        marketIndex: 1,
        baseCurrency: 'ETH',
        quoteCurrency: 'USDC',
        priceDecimals: 2,
        sizeDecimals: 4,
        minBaseAmount: '0.001',
      },
    ];
    const config: any = {
      baseURL: 'https://custom.lighter.example',
      wsURL: 'wss://custom.lighter.example/stream',
      balanceCurrency: 'USD',
      defaultSlippageBps: '50',
      markets,
    };

    applyDefaultConfig('lighter', config);

    expect(config).toEqual({
      baseURL: 'https://custom.lighter.example',
      wsURL: 'wss://custom.lighter.example/stream',
      balanceCurrency: 'USD',
      defaultSlippageBps: 50,
      markets,
    });
  });

  it('normalizes invalid lighter markets to an empty array', () => {
    const config: any = { markets: { BTC_USDC: { marketIndex: 0 } } };

    applyDefaultConfig('lighter', config);

    expect(config.markets).toEqual([]);
  });

  it('keeps apiPrivateKey in sensitive fields', () => {
    expect(sensitiveFields).toContain('apiPrivateKey');
  });

  it('redacts and preserves apiPrivateKey through shared sensitive config helpers', () => {
    const config: any = { nested: { apiPrivateKey: 'secret-value' } };
    const editedConfig: any = {};

    redactSensitiveConfig(config);
    preserveSensitiveConfig(editedConfig, { apiPrivateKey: 'secret-value' });

    expect(config).toEqual({ nested: {} });
    expect(editedConfig).toEqual({ apiPrivateKey: 'secret-value' });
  });

  it('redacts sensitive config in exchange instance responses', () => {
    const instance = {
      toJSON: () => ({
        id: 'r-lighter',
        type: 'lighter',
        config: JSON.stringify({
          apiSecret: 'secret',
          privateKey: 'private',
          apiPrivateKey: 'api-private',
          nested: { password: 'password' },
          baseURL: 'https://mainnet.zklighter.elliot.ai',
        }),
      }),
    };

    const serialized = serializeExchangeInstance(instance as any) as any;

    expect(JSON.parse(serialized.config)).toEqual({
      baseURL: 'https://mainnet.zklighter.elliot.ai',
      nested: {},
    });
  });
});
