/**
 * GateTradFiStreamAdapter —— 把单连接、多品种的 GateTradFiMarketDataStream
 * 适配为标准 MarketDataStream 接口（供 MarketDataHub 按 symbol 创建流使用）。
 *
 * 背景：MarketDataHub 通过 options.createStream(symbol) 为每个品种创建一条
 * MarketDataStream（start(listener)/stop()），而 GateTradFiMarketDataStream
 * 是「全软件共用一条 WS 连接、通过 subscribe/onTick 订阅多品种」的单例式流，
 * 两者接口不一致。本适配器桥接二者：
 * - start(listener)：向共享流订阅该 symbol 并注册 tick 监听；
 * - stop()：退订该 symbol 并移除监听。
 *
 * 同一条共享 GateTradFiMarketDataStream 实例会被多个 symbol 的适配器共用，
 * 底层只维持一条 tradfi WS 连接。
 */
import { MarketDataStream, MarketTickListener } from './types';
import { GateTradFiMarketDataStream } from './GateTradFiMarketDataStream';
import { normalizeSymbolCase } from '../../utils/normalizeSymbol';

export class GateTradFiStreamAdapter implements MarketDataStream {
  private readonly normalized: string;
  private unsub: (() => void) | null = null;

  constructor(
    private readonly shared: GateTradFiMarketDataStream,
    symbol: string,
  ) {
    this.normalized = normalizeSymbolCase(symbol);
  }

  async start(listener: MarketTickListener): Promise<void> {
    this.shared.subscribe(this.normalized);
    this.unsub = this.shared.onTick(this.normalized, listener);
    // 若共享流已有该 symbol 的最新 tick，立即补推一次，避免冷启动取价空窗
    const latest = this.shared.getLatestTick(this.normalized);
    if (latest) listener(latest);
  }

  async stop(): Promise<void> {
    if (this.unsub) {
      this.unsub();
      this.unsub = null;
    }
    this.shared.unsubscribe(this.normalized);
  }
}