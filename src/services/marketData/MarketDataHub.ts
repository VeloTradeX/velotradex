import { EventEmitter } from 'events';
import {
  MarketDataHubOptions,
  MarketDataStream,
  MarketTick,
  MarketTickListener,
  MarketTicker,
} from './types';
import { normalizeSymbolCase } from '../../utils/normalizeSymbol';

type Unsubscribe = () => Promise<void>;

export class MarketDataHub {
  public readonly events = new EventEmitter();

  private readonly options: MarketDataHubOptions;
  private readonly subscribers = new Map<string, Set<MarketTickListener>>();
  private readonly streams = new Map<string, MarketDataStream>();
  private readonly latestTicks = new Map<string, MarketTick>();
  private running = false;

  constructor(options: MarketDataHubOptions) {
    this.options = options;
  }

  async start(): Promise<void> {
    this.running = true;

    await Promise.all(
      Array.from(this.subscribers.keys()).map(symbol => this.ensureStream(symbol)),
    );
  }

  async stop(): Promise<void> {
    this.running = false;

    const streams = Array.from(this.streams.values());
    this.streams.clear();
    await Promise.all(streams.map(stream => stream.stop()));
  }

  subscribe(symbol: string, listener: MarketTickListener): Unsubscribe {
    const normalizedSymbol = normalizeSymbolCase(symbol);
    let listeners = this.subscribers.get(normalizedSymbol);

    if (!listeners) {
      listeners = new Set();
      this.subscribers.set(normalizedSymbol, listeners);
    }

    listeners.add(listener);

    if (this.running) {
      void this.ensureStream(normalizedSymbol);
    }

    let unsubscribed = false;
    return async () => {
      if (unsubscribed) {
        return;
      }

      unsubscribed = true;
      await this.unsubscribe(normalizedSymbol, listener);
    };
  }

  ingestTick(tick: MarketTick): void {
    const normalizedTick: MarketTick = {
      ...tick,
      symbol: normalizeSymbolCase(tick.symbol),
    };

    this.latestTicks.set(normalizedTick.symbol, normalizedTick);

    const listeners = this.subscribers.get(normalizedTick.symbol);
    if (listeners) {
      for (const listener of listeners) {
        listener(normalizedTick);
      }
    }

    this.events.emit('tick', normalizedTick);
  }

  getLatestTick(symbol: string): MarketTick | null {
    return this.latestTicks.get(normalizeSymbolCase(symbol)) ?? null;
  }

  getTicker(symbol: string): MarketTicker {
    const normalizedSymbol = normalizeSymbolCase(symbol);
    const tick = this.latestTicks.get(normalizedSymbol);

    if (!tick) {
      return {
        symbol: normalizedSymbol,
        lastPrice: '0',
        markPrice: '0',
        indexPrice: '0',
        fundingRate: '0',
        volume24h: '0',
        change24h: '0',
        raw: {
          receivedAt: null,
          ageMs: null,
          source: null,
        },
      };
    }

    return {
      symbol: normalizedSymbol,
      lastPrice: tick.lastPrice,
      markPrice: tick.markPrice ?? tick.lastPrice,
      indexPrice: tick.indexPrice ?? tick.markPrice ?? tick.lastPrice,
      fundingRate: '0',
      volume24h: '0',
      change24h: '0',
      raw: {
        receivedAt: tick.receivedAt,
        ageMs: Date.now() - tick.receivedAt.getTime(),
        source: tick.source,
      },
    };
  }

  private async unsubscribe(symbol: string, listener: MarketTickListener): Promise<void> {
    const listeners = this.subscribers.get(symbol);
    if (!listeners) {
      return;
    }

    listeners.delete(listener);
    if (listeners.size > 0) {
      return;
    }

    this.subscribers.delete(symbol);
    this.latestTicks.delete(symbol);
    const stream = this.streams.get(symbol);
    if (!stream) {
      return;
    }

    this.streams.delete(symbol);
    await stream.stop();
  }

  private async ensureStream(symbol: string): Promise<void> {
    if (this.streams.has(symbol)) {
      return;
    }

    const stream = this.options.createStream(symbol);
    this.streams.set(symbol, stream);
    await stream.start(tick => this.ingestTick(tick));
  }
}
