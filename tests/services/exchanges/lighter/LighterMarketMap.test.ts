import { LighterMarketMap } from '../../../../src/services/exchanges/lighter/LighterMarketMap';
import { LighterMarketConfig } from '../../../../src/services/exchanges/lighter/types';

const markets: LighterMarketConfig[] = [
  {
    symbol: 'BTC_USDT',
    marketIndex: 1,
    baseCurrency: 'BTC',
    quoteCurrency: 'USDC',
    priceDecimals: 2,
    sizeDecimals: 5,
    minBaseAmount: '0.0001',
  },
];

describe('LighterMarketMap', () => {
  const marketMap = new LighterMarketMap({ markets });

  it('resolves explicit BTC_USDT mapping to market index 1', () => {
    expect(marketMap.resolve('BTC_USDT').marketIndex).toBe(1);
  });

  it('resolves BTC_USDC via USDT/USDC alias to market index 1', () => {
    expect(marketMap.resolve('BTC_USDC').marketIndex).toBe(1);
    expect(marketMap.resolve('BTC_USDC').symbol).toBe('BTC_USDT');
  });

  it('throws for unsupported ETH_USDT without guessing', () => {
    expect(() => marketMap.resolve('ETH_USDT')).toThrow('Unsupported Lighter symbol: ETH_USDT');
  });

  it('converts price to integer string using configured price decimals', () => {
    expect(marketMap.toIntegerPrice('BTC_USDT', '65000.12')).toBe('6500012');
  });

  it('converts price via alias', () => {
    expect(marketMap.toIntegerPrice('BTC_USDC', '65000.12')).toBe('6500012');
  });

  it('converts large decimal price strings exactly', () => {
    expect(marketMap.toIntegerPrice('BTC_USDT', '9007199254740993.12')).toBe('900719925474099312');
  });

  it('rejects non-string price inputs', () => {
    expect(() => marketMap.toIntegerPrice('BTC_USDT', 65000.12)).toThrow(/must be a decimal string/);
  });

  it('converts size to integer string using configured size decimals', () => {
    expect(marketMap.toIntegerSize('BTC_USDT', '0.12345')).toBe('12345');
  });

  it('rejects amounts below minBaseAmount', () => {
    expect(() => marketMap.toIntegerSize('BTC_USDT', '0.00009')).toThrow(/below minBaseAmount/);
  });

  it('rejects long decimal amounts below minBaseAmount without rounding to min', () => {
    expect(() => marketMap.toIntegerSize('BTC_USDT', '0.000099999999999999999')).toThrow(/below minBaseAmount/);
  });

  it('returns MarketInfo-like market metadata', async () => {
    await expect(marketMap.getMarkets()).resolves.toEqual([
      expect.objectContaining({
        symbol: 'BTC_USDT',
        quoteCurrency: 'USDC',
        pricePrecision: 2,
        amountPrecision: 5,
        leverageMin: '1',
        leverageMax: '50',
      }),
    ]);
  });
});
