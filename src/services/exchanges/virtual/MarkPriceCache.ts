const cache = new Map<string, string>();

const buildKey = (exchangeInstanceId: string, symbol: string) =>
  `${exchangeInstanceId}\0${symbol.trim().toUpperCase()}`;

const MarkPriceCache = {
  set(exchangeInstanceId: string, symbol: string, markPrice: string): void {
    cache.set(buildKey(exchangeInstanceId, symbol), markPrice);
  },

  get(exchangeInstanceId: string, symbol: string): string | null {
    return cache.get(buildKey(exchangeInstanceId, symbol)) ?? null;
  },

  getAll(): Map<string, string> {
    return cache;
  },
};

export default MarkPriceCache;
