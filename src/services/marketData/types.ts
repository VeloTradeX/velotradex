import { Ticker } from '../exchanges/IExchange';

export interface MarketTick {
  symbol: string;
  lastPrice: string;
  markPrice?: string;
  indexPrice?: string;
  source: 'gate';
  receivedAt: Date;
}

export type MarketTickListener = (tick: MarketTick) => void;

export interface MarketDataStream {
  start(listener: MarketTickListener): Promise<void>;
  stop(): Promise<void>;
}

export interface MarketDataHubOptions {
  createStream(symbol: string): MarketDataStream;
}

export interface MarketTicker extends Ticker {
  raw?: {
    receivedAt: Date | null;
    ageMs: number | null;
    source: MarketTick['source'] | null;
  };
}
