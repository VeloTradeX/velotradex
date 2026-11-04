import { PriceSnapshotService, extractSnapshotSymbols } from '../../src/services/PriceSnapshotService';

function makeService(options: {
  prices?: Record<string, number>;
  failSymbols?: string[];
  now?: () => number;
} = {}) {
  const prices = options.prices ?? {
    BTC_USDT: 78_267.3,
    ETH_USDT: 2_250,
    SOL_USDT: 150,
    TAO_USDT: 230,
    XAU_USDT: 4_000,
  };
  const failing = new Set(options.failSymbols ?? []);

  const exchange = {
    getTicker: jest.fn(async (symbol: string) => {
      if (failing.has(symbol)) throw new Error(`ticker failed for ${symbol}`);
      return { lastPrice: String(prices[symbol] ?? 0) };
    }),
  };
  const registry = { getExchange: jest.fn(() => exchange) };

  return {
    exchange,
    registry,
    service: new PriceSnapshotService(registry as any, options.now ?? (() => 1_000)),
  };
}

const raizexRoute = [{ parser: 'RaizexbtParser', exchangeInstanceId: 'gate_main' }];

describe('extractSnapshotSymbols', () => {
  it('includes the usual symbols plus explicit $tickers', () => {
    const symbols = extractSnapshotSymbols('Shorted $BTC and watching $TAO');
    expect(symbols).toEqual(expect.arrayContaining(['BTC_USDT', 'TAO_USDT', 'ETH_USDT']));
    expect(new Set(symbols).size).toBe(symbols.length);
  });

  it('is case-insensitive and tolerates other currency prefixes', () => {
    const symbols = extractSnapshotSymbols('€ETH long');
    expect(symbols).toContain('ETH_USDT');
  });
});

describe('PriceSnapshotService', () => {
  it('captures a receipt-time price and resolves it for the executor', async () => {
    const { service } = makeService();
    const message: any = { id: 'm1', content: 'Shorted $BTC' };

    service.captureForMessage(message, raizexRoute);

    const snapshot = await service.resolve(message, 'BTC_USDT');
    expect(snapshot?.price).toBe(78_267.3);
    expect(snapshot?.ageMs).toBe(0);
  });

  it('does not capture for non-raizexbt routes', async () => {
    const { service, exchange } = makeService();
    const message: any = { id: 'm2', content: 'Shorted $BTC' };

    service.captureForMessage(message, [{ parser: 'MansoorParser', exchangeInstanceId: 'gate_main' }]);

    expect(await service.resolve(message, 'BTC_USDT')).toBeNull();
    expect(exchange.getTicker).not.toHaveBeenCalled();
  });

  it('ignores snapshots older than the max age', async () => {
    let now = 1_000;
    const { service } = makeService({ now: () => now });
    const message: any = { id: 'm3', content: 'Shorted $BTC' };

    service.captureForMessage(message, raizexRoute);
    expect(await service.resolve(message, 'BTC_USDT')).not.toBeNull();

    now += 31_000;
    expect(await service.resolve(message, 'BTC_USDT')).toBeNull();
  });

  it('returns null for a symbol whose ticker failed', async () => {
    const { service } = makeService({ failSymbols: ['BTC_USDT'] });
    const message: any = { id: 'm4', content: 'Shorted $BTC' };

    service.captureForMessage(message, raizexRoute);

    expect(await service.resolve(message, 'BTC_USDT')).toBeNull();
    // Other symbols still resolve.
    expect((await service.resolve(message, 'ETH_USDT'))?.price).toBe(2_250);
  });

  it('returns null for a message without a captured snapshot', async () => {
    const { service } = makeService();
    expect(await service.resolve({ id: 'unknown' }, 'BTC_USDT')).toBeNull();
  });
});
