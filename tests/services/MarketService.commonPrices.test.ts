import marketService from '../../src/services/MarketService';
import exchangeRegistry from '../../src/services/exchanges';

jest.mock('../../src/services/exchanges', () => ({
  __esModule: true,
  default: {
    getExchange: jest.fn(),
  },
}));

describe('MarketService common market price context', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-05-02T00:00:00.000Z'));
    (marketService as any).commonPricesCache = null;
    (marketService as any).priceCache = new Map();
    jest.clearAllMocks();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('builds an XML price context for common markets and caches it for one day', async () => {
    const getTicker = jest.fn(async (symbol: string) => ({
      symbol,
      lastPrice: symbol === 'BTC_USDT' ? '65000' : symbol === 'XAU_USDT' ? '2350' : '100',
      markPrice: '',
      indexPrice: '',
      fundingRate: '',
      volume24h: '',
      change24h: '',
    }));
    (exchangeRegistry.getExchange as jest.Mock).mockReturnValue({ getTicker });

    const first = await marketService.getCommonMarketPricesXml();
    const second = await marketService.getCommonMarketPricesXml();

    expect(first).toContain('<market_prices');
    expect(first).toContain('symbol="BTC_USDT"');
    expect(first).toContain('price="65000"');
    expect(first).toContain('symbol="XAU_USDT"');
    expect(first).toContain('aliases="XAU, XAUUSD, Gold, GOLD"');
    expect(second).toBe(first);
    expect(getTicker).toHaveBeenCalledTimes((marketService as any).COMMON_MARKETS.length);
  });

  it('refreshes the common market context after the daily cache expires', async () => {
    let calls = 0;
    const getTicker = jest.fn(async (symbol: string) => {
      calls += 1;
      return {
      symbol,
      lastPrice: calls <= (marketService as any).COMMON_MARKETS.length ? '100' : '200',
      markPrice: '',
      indexPrice: '',
      fundingRate: '',
      volume24h: '',
      change24h: '',
      };
    });
    (exchangeRegistry.getExchange as jest.Mock).mockReturnValue({ getTicker });

    const first = await marketService.getCommonMarketPricesXml();
    jest.setSystemTime(new Date('2026-05-03T00:00:01.000Z'));
    const second = await marketService.getCommonMarketPricesXml();

    expect(first).toContain('price="100"');
    expect(second).toContain('price="200"');
    expect(getTicker).toHaveBeenCalledTimes((marketService as any).COMMON_MARKETS.length * 2);
  });
});
