import { applyDefaultConfig } from '../../src/routes/exchange';

describe('exchange route virtual_gate defaults', () => {
  it('applies virtual_gate config defaults', () => {
    const config: any = {};

    applyDefaultConfig('virtual_gate', config);

    expect(config).toEqual({
      initialBalance: '10000',
      currency: 'USDT',
      marketDataSourceId: 'gate_public_main',
      supportedSymbols: [],
      maxTickAgeMs: 10000,
      autoRestore: true,
    });
  });

  it('preserves explicit virtual_gate config values', () => {
    const config: any = {
      initialBalance: '25000',
      currency: 'USD',
      marketDataSourceId: 'custom_source',
      supportedSymbols: ['BTC_USDT'],
      maxTickAgeMs: '5000',
      autoRestore: false,
    };

    applyDefaultConfig('virtual_gate', config);

    expect(config).toEqual({
      initialBalance: '25000',
      currency: 'USD',
      marketDataSourceId: 'custom_source',
      supportedSymbols: ['BTC_USDT'],
      maxTickAgeMs: 5000,
      autoRestore: false,
    });
  });
});
