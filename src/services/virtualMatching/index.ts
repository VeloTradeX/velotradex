/**
 * 统一 CFD 行情订阅 + 虚拟撮合（入口）。
 *
 * 保证「全软件只有一个 CFD 行情订阅」：
 * - getCfdMarketDataStream() 返回进程内唯一的 GateTradFiMarketDataStream 单例
 *   （单条 tradfi WS 连接），所有调用方共享；
 * - createCfdVirtualMatcher() 创建共享该单例的撮合引擎实例，
 *   多个消费方各持一个 matcher 但共享同一连接与同一撮合事件语义。
 */
import { GateTradFiMarketDataStream, GateTradFiMarketDataStreamOptions } from '../marketData/GateTradFiMarketDataStream';
import { CfdVirtualMatcher, CfdVirtualMatcherOptions } from './CfdVirtualMatcher';

let sharedStream: GateTradFiMarketDataStream | null = null;

/** 获取进程内唯一的 tradfi 行情流（单连接）。首次调用时创建，options 仅首次生效。 */
export function getCfdMarketDataStream(options?: GateTradFiMarketDataStreamOptions): GateTradFiMarketDataStream {
  if (!sharedStream) {
    sharedStream = new GateTradFiMarketDataStream(options);
  }
  return sharedStream;
}

/** 创建一个共享同一行情订阅的虚拟撮合引擎（可创建多个实例，连接仍只有一条） */
export function createCfdVirtualMatcher(options?: CfdVirtualMatcherOptions): CfdVirtualMatcher {
  return new CfdVirtualMatcher(getCfdMarketDataStream(), options);
}

export * from './types';
export { CfdVirtualMatcher } from './CfdVirtualMatcher';
export {
  GateTradFiMarketDataStream,
  toTradFiSymbol,
  fromTradFiSymbol,
} from '../marketData/GateTradFiMarketDataStream';
export type {
  GateTradFiMarketDataStreamOptions,
  TradFiTickListener,
  TradFiBestPrices,
} from '../marketData/GateTradFiMarketDataStream';
