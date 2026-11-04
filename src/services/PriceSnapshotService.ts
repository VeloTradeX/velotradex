import logger from '../utils/logger';
import config from '../config';
import exchangeRegistry from './exchanges';

/**
 * Captures a price snapshot at the instant a Discord message arrives, before
 * image download / LLM parsing runs. The entry decision (market vs limit) can
 * then use the price that was live when the signal was posted instead of the
 * price several seconds later, after parsing.
 *
 * The snapshot is intentionally best-effort:
 * - it never blocks message parsing (the fetch promise starts at receipt and is
 *   awaited only when the executor needs it);
 * - failures / timeouts fall back to the live ticker;
 * - snapshots older than `maxAgeMs` are ignored so a slow parse cannot enter on
 *   a stale price.
 */

export interface PriceSnapshotHandle {
  capturedAt: number;
  promise: Promise<Record<string, number>>;
}

export interface ResolvedPriceSnapshot {
  price: number;
  capturedAt: number;
  ageMs: number;
}

const DEFAULT_SNAPSHOT_SYMBOLS = [
  'BTC_USDT',
  'ETH_USDT',
  'SOL_USDT',
  'TAO_USDT',
  'XAU_USDT',
];

const MAX_SNAPSHOT_SYMBOLS = 8;
const TICKER_TIMEOUT_MS = 1500;
const DEFAULT_MAX_AGE_MS = 30_000;

/** Symbols to snapshot for a message: explicit $tickers plus the usual set. */
export function extractSnapshotSymbols(content: string): string[] {
  const symbols = new Set<string>(DEFAULT_SNAPSHOT_SYMBOLS);

  const tickerRe = /(?:\$|€|¥|£)\s*([A-Za-z]{2,10})\b/g;
  let match: RegExpExecArray | null;
  while ((match = tickerRe.exec(String(content || ''))) !== null) {
    const base = match[1].toUpperCase();
    if (!/^[A-Z]{2,10}$/.test(base)) continue;
    symbols.add(`${base}_USDT`);
    if (symbols.size >= MAX_SNAPSHOT_SYMBOLS) break;
  }

  return Array.from(symbols).slice(0, MAX_SNAPSHOT_SYMBOLS);
}

export class PriceSnapshotService {
  private readonly snapshots = new WeakMap<object, PriceSnapshotHandle>();

  constructor(
    private readonly registry: any = exchangeRegistry,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Starts the snapshot fetch for a message. Call this as early as possible in
   * the message handler; do not await it.
   */
  public captureForMessage(message: any, routes: any[]): void {
    try {
      if (!message || typeof message !== 'object') return;
      if (config.backtest.child) return;
      if (this.snapshots.has(message)) return;

      const raizexRoutes = (routes || []).filter((route) => route?.parser === 'RaizexbtParser');
      if (raizexRoutes.length === 0) return;

      const exchangeInstanceId = raizexRoutes.find((route) => route?.exchangeInstanceId)?.exchangeInstanceId;
      const symbols = extractSnapshotSymbols(String(message.content || ''));
      const capturedAt = this.now();

      const promise = this.fetchPrices(exchangeInstanceId, symbols).catch((error: any) => {
        logger.warn('[PriceSnapshot] snapshot fetch failed', {
          messageId: message.id,
          exchangeInstanceId,
          error: error?.message || String(error),
        });
        return {};
      });

      this.snapshots.set(message, { capturedAt, promise });
      logger.info('[PriceSnapshot] started at message receipt', {
        messageId: message.id,
        exchangeInstanceId,
        symbols,
        capturedAt,
      });
    } catch (error: any) {
      logger.warn('[PriceSnapshot] capture failed', {
        messageId: message?.id,
        error: error?.message || String(error),
      });
    }
  }

  /**
   * Returns the receipt-time price for `symbol`, or null when the snapshot is
   * missing, empty, or older than `maxAgeMs`.
   */
  public async resolve(
    message: any,
    symbol: string,
    maxAgeMs: number = DEFAULT_MAX_AGE_MS,
  ): Promise<ResolvedPriceSnapshot | null> {
    if (!message || !symbol) return null;
    const handle = this.snapshots.get(message);
    if (!handle) return null;

    let prices: Record<string, number>;
    try {
      prices = await handle.promise;
    } catch {
      return null;
    }

    const price = Number(prices?.[symbol]);
    if (!Number.isFinite(price) || price <= 0) return null;

    const ageMs = this.now() - handle.capturedAt;
    if (ageMs > maxAgeMs) {
      logger.warn('[PriceSnapshot] ignoring stale snapshot', { symbol, ageMs, maxAgeMs });
      return null;
    }

    return { price, capturedAt: handle.capturedAt, ageMs };
  }

  private async fetchPrices(
    exchangeInstanceId: string | undefined,
    symbols: string[],
  ): Promise<Record<string, number>> {
    const exchange = this.registry.getExchange(exchangeInstanceId);
    if (!exchange) return {};

    const results = await Promise.allSettled(
      symbols.map(async (symbol) => {
        const ticker = await this.withTimeout(
          Promise.resolve(exchange.getTicker(symbol)),
          TICKER_TIMEOUT_MS,
        );
        const price = parseFloat(String(ticker?.lastPrice ?? '0'));
        return [symbol, price] as const;
      }),
    );

    const prices: Record<string, number> = {};
    for (const result of results) {
      if (result.status !== 'fulfilled') continue;
      const [symbol, price] = result.value;
      if (Number.isFinite(price) && price > 0) prices[symbol] = price;
    }

    logger.info('[PriceSnapshot] captured prices', {
      exchangeInstanceId,
      requested: symbols.length,
      captured: Object.keys(prices).length,
    });
    return prices;
  }

  private withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`ticker timeout after ${timeoutMs}ms`)), timeoutMs);
      promise.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  }
}

const priceSnapshotService = new PriceSnapshotService();
export default priceSnapshotService;
