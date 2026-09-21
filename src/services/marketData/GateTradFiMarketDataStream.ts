/**
 * GateTradFiMarketDataStream — Gate CFD (/tradfi) 行情推送流（单连接、多品种）。
 *
 * 设计目标（对应需求：全软件只保留一个 CFD 行情订阅）：
 * - 全软件共用【一个】WS 连接（wss://fx-ws.gateio.ws/v4/ws/tradfi），
 *   多个消费方（虚拟撮合/模拟实例）通过 subscribe/onTick 共享同一条连接。
 * - 多品种订阅管理：内部统一使用 BASE_USDT 符号（如 XAU_USDT），
 *   进出 tradfi 时映射为 BASEUSD（如 XAUUSD）。
 * - 订阅 tradfi.tickers（last_price，250ms）与可选 tradfi.order_book（bid/ask，250ms），
 *   均为公共频道、免鉴权（Gate TradFi WS v1.0.0）。
 * - 断线自动重连（指数退避 + 抖动），重连成功后自动重新订阅全部品种。
 *
 * 说明：本组件为新增独立模块，不修改现有 GateMarketDataStream / MarketDataHub /
 * 虚拟交易所任何代码；WS 生命周期逻辑借鉴现有 GateMarketDataStream。
 */
import WebSocket from 'ws';
import { HttpsProxyAgent } from 'https-proxy-agent';
import logger, { formatError } from '../../utils/logger';
import { safeCloseWebSocket } from '../../utils/safeCloseWebSocket';
import { MarketTick } from './types';
import { normalizeSymbolCase } from '../../utils/normalizeSymbol';
import {
  toTradFiSymbol,
  fromTradFiSymbol,
} from '../exchanges/gate_cfd/cfdSymbol';

// ─── 品种映射 ───────────────────────────────────────────────────────────────

// 符号转换（BASE_USDT ↔ BASEUSD）统一定义于 gate_cfd/cfdSymbol.ts，
// REST（GateCFDRestClient）与 WS（本流）共用；此处仅做重导出以保持既有 API。
export { toTradFiSymbol, fromTradFiSymbol };

// ─── 类型 ───────────────────────────────────────────────────────────────────

export interface TradFiTickerPayload {
  timestamp?: string;
  symbol?: string;
  last_price?: string;
  open_price?: string;
  high?: string;
  low?: string;
  price_change_rate?: string;
}

export interface TradFiOrderBookPayload {
  time?: number;
  symbol?: string;
  bid?: string;
  ask?: string;
}

export interface TradFiBestPrices {
  bid: string;
  ask: string;
  at: Date;
}

export type TradFiTickListener = (tick: MarketTick) => void;

export interface GateTradFiMarketDataStreamOptions {
  /** tradfi WS 地址，默认 wss://fx-ws.gateio.ws/v4/ws/tradfi */
  wsUrl?: string;
  /** 代理地址（可选） */
  proxyUrl?: string;
  /** 是否同时订阅 tradfi.order_book（bid/ask），默认 false（只订阅 tickers） */
  subscribeOrderBook?: boolean;
  /** 心跳间隔 ms，默认 15000 */
  pingIntervalMs?: number;
  /** 重连初始延迟 ms，默认 5000 */
  reconnectDelayMs?: number;
  /** 重连最大延迟 ms，默认 60000 */
  maxReconnectDelayMs?: number;
  /** 可注入的 WS 工厂（测试用），默认使用 ws 库 */
  createWebSocket?: (url: string, options?: WebSocket.ClientOptions) => WebSocket;
}

// ─── Stream ─────────────────────────────────────────────────────────────────

export class GateTradFiMarketDataStream {
  private readonly wsUrl: string;
  private readonly proxyUrl: string | undefined;
  private readonly subscribeOrderBook: boolean;
  private readonly pingIntervalMs: number;
  private readonly reconnectDelayMs: number;
  private readonly maxReconnectDelayMs: number;
  private readonly createWebSocket: (url: string, options?: WebSocket.ClientOptions) => WebSocket;

  /** 已订阅的内部符号（BASE_USDT 形式） */
  private readonly subscribedSymbols = new Set<string>();
  /** 内部符号 → 监听器集合 */
  private readonly listeners = new Map<string, Set<TradFiTickListener>>();
  /** 内部符号 → 最新 tick */
  private readonly latestTicks = new Map<string, MarketTick>();
  /** 内部符号 → 最优 bid/ask（order_book 频道） */
  private readonly bestPrices = new Map<string, TradFiBestPrices>();

  private ws: WebSocket | null = null;
  private wsConnected = false;
  private running = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectCount = 0;
  private pingTimer: NodeJS.Timeout | null = null;

  constructor(options: GateTradFiMarketDataStreamOptions = {}) {
    this.wsUrl = options.wsUrl ?? 'wss://fx-ws.gateio.ws/v4/ws/tradfi';
    this.proxyUrl = options.proxyUrl;
    this.subscribeOrderBook = options.subscribeOrderBook ?? false;
    this.pingIntervalMs = options.pingIntervalMs ?? 15000;
    this.reconnectDelayMs = options.reconnectDelayMs ?? 5000;
    this.maxReconnectDelayMs = options.maxReconnectDelayMs ?? 60000;
    this.createWebSocket = options.createWebSocket ?? ((url, wsOptions) => new WebSocket(url, wsOptions));
  }

  // ─── Public API ───────────────────────────────────────────────────────────

  public async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.connectWS();
  }

  public async stop(): Promise<void> {
    this.running = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.stopPing();
    safeCloseWebSocket(this.ws);
    this.ws = null;
    this.wsConnected = false;
    this.listeners.clear();
    this.latestTicks.clear();
    this.bestPrices.clear();
  }

  /** 订阅一个内部符号（BASE_USDT）；未连接时记录并在连接后自动订阅 */
  public subscribe(symbol: string): void {
    const normalized = normalizeSymbolCase(symbol);
    this.subscribedSymbols.add(normalized);
    if (!this.running) {
      void this.start();
      return;
    }
    if (this.wsConnected && this.ws) {
      this.sendSubscribe(normalized);
    }
  }

  /** 退订一个内部符号 */
  public unsubscribe(symbol: string): void {
    const normalized = normalizeSymbolCase(symbol);
    if (!this.subscribedSymbols.delete(normalized)) return;
    if (this.wsConnected && this.ws) {
      this.sendUnsubscribe(normalized);
    }
  }

  /** 注册 tick 监听，返回退订函数 */
  public onTick(symbol: string, listener: TradFiTickListener): () => void {
    const normalized = normalizeSymbolCase(symbol);
    let set = this.listeners.get(normalized);
    if (!set) {
      set = new Set();
      this.listeners.set(normalized, set);
    }
    set.add(listener);
    return () => {
      const current = this.listeners.get(normalized);
      if (!current) return;
      current.delete(listener);
      if (current.size === 0) this.listeners.delete(normalized);
    };
  }

  public getLatestTick(symbol: string): MarketTick | null {
    return this.latestTicks.get(normalizeSymbolCase(symbol)) ?? null;
  }

  public getBestPrices(symbol: string): TradFiBestPrices | null {
    return this.bestPrices.get(normalizeSymbolCase(symbol)) ?? null;
  }

  public getSubscribedSymbols(): string[] {
    return Array.from(this.subscribedSymbols);
  }

  public isConnected(): boolean {
    return this.wsConnected;
  }

  // ─── WS 生命周期 ─────────────────────────────────────────────────────────

  private connectWS(): void {
    this.disconnectWS();

    const options: WebSocket.ClientOptions = {};
    if (this.proxyUrl) {
      options.agent = new HttpsProxyAgent(this.proxyUrl);
    }

    logger.info(`[GateTradFi] WS connecting: ${this.wsUrl}`);
    this.ws = this.createWebSocket(this.wsUrl, options);

    this.ws.on('open', () => this.onWSOpen());
    this.ws.on('message', (data) => this.handleWSMessage(data));
    this.ws.on('error', (err) => {
      logger.warn('[GateTradFi] WS error', formatError(err));
      this.ws?.terminate();
    });
    this.ws.on('close', () => this.onWSClose());
  }

  private onWSOpen(): void {
    this.wsConnected = true;
    this.reconnectCount = 0;
    logger.info(`[GateTradFi] WS connected, subscribed symbols: ${this.subscribedSymbols.size}`);
    this.startPing();

    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    // 重连成功后重新订阅全部品种（每个品种单独发一条订阅）
    for (const symbol of this.subscribedSymbols) {
      this.sendSubscribe(symbol);
    }
  }

  private onWSClose(): void {
    if (!this.wsConnected && !this.ws) return;
    this.wsConnected = false;
    this.stopPing();

    if (this.running) {
      this.scheduleReconnect();
    }
  }

  private disconnectWS(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.stopPing();
    safeCloseWebSocket(this.ws);
    this.ws = null;
    this.wsConnected = false;
  }

  private scheduleReconnect(): void {
    this.reconnectCount += 1;
    const delay = Math.min(
      this.reconnectDelayMs * Math.pow(1.5, this.reconnectCount - 1),
      this.maxReconnectDelayMs,
    );
    const jitter = Math.random() * 1000;
    const totalDelay = delay + jitter;

    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    logger.info(`[GateTradFi] WS reconnecting in ${(totalDelay / 1000).toFixed(1)}s (attempt ${this.reconnectCount})`);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connectWS();
    }, totalDelay);
  }

  private startPing(): void {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({
          time: Math.floor(Date.now() / 1000),
          channel: 'tradfi.ping',
        }));
      }
    }, this.pingIntervalMs);
  }

  private stopPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  // ─── 订阅消息 ─────────────────────────────────────────────────────────────

  private sendSubscribe(symbol: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const tradfiSymbol = toTradFiSymbol(symbol);
    const time = Math.floor(Date.now() / 1000);
    this.ws.send(JSON.stringify({
      time,
      channel: 'tradfi.tickers',
      event: 'subscribe',
      payload: { markets: [tradfiSymbol] },
    }));
    if (this.subscribeOrderBook) {
      this.ws.send(JSON.stringify({
        time,
        channel: 'tradfi.order_book',
        event: 'subscribe',
        payload: [tradfiSymbol],
      }));
    }
  }

  private sendUnsubscribe(symbol: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const tradfiSymbol = toTradFiSymbol(symbol);
    const time = Math.floor(Date.now() / 1000);
    this.ws.send(JSON.stringify({
      time,
      channel: 'tradfi.tickers',
      event: 'unsubscribe',
      payload: { markets: [tradfiSymbol] },
    }));
    if (this.subscribeOrderBook) {
      this.ws.send(JSON.stringify({
        time,
        channel: 'tradfi.order_book',
        event: 'unsubscribe',
        payload: [tradfiSymbol],
      }));
    }
  }

  // ─── 消息处理 ─────────────────────────────────────────────────────────────

  private handleWSMessage(data: WebSocket.Data): void {
    try {
      const msg = JSON.parse(data.toString());
      const channel: string = msg.channel || '';

      // 心跳应答，忽略
      if (channel.endsWith('.pong')) return;

      if (msg.event === 'subscribe' || msg.event === 'unsubscribe') {
        if (msg.error) {
          logger.error('[GateTradFi] WS subscribe/unsubscribe failed', { channel, error: msg.error });
        }
        return;
      }

      if (msg.event !== 'update' || !Array.isArray(msg.result)) return;

      if (channel === 'tradfi.tickers') {
        this.handleTickers(msg.result);
      } else if (channel === 'tradfi.order_book') {
        this.handleOrderBook(msg.result);
      }
    } catch (err: any) {
      logger.warn('[GateTradFi] WS message parse error', formatError(err));
    }
  }

  private handleTickers(result: any[]): void {
    for (const item of result) {
      const internal = fromTradFiSymbol(String(item.symbol || ''));
      if (!internal || !this.subscribedSymbols.has(internal)) continue;

      const lastPrice = this.firstPositiveString(item.last_price);
      if (!lastPrice) continue;

      const tick: MarketTick = {
        symbol: internal,
        lastPrice,
        markPrice: undefined,
        indexPrice: undefined,
        source: 'gate',
        receivedAt: new Date(),
      };
      this.latestTicks.set(internal, tick);
      this.emitTick(internal, tick);
    }
  }

  private handleOrderBook(result: any[]): void {
    for (const item of result) {
      const internal = fromTradFiSymbol(String(item.symbol || ''));
      if (!internal || !this.subscribedSymbols.has(internal)) continue;

      const bid = this.firstPositiveString(item.bid);
      const ask = this.firstPositiveString(item.ask);
      if (!bid || !ask) continue;

      this.bestPrices.set(internal, { bid, ask, at: new Date() });

      // 若已有 tick，把 bid/ask 挂到 raw 上（扩展字段，不影响 MarketTick 基础类型）
      const existing = this.latestTicks.get(internal);
      if (existing) {
        const updated: MarketTick & { raw?: { bid?: string; ask?: string } } = {
          ...existing,
          raw: { ...(existing as any).raw, bid, ask },
        };
        this.latestTicks.set(internal, updated);
        this.emitTick(internal, updated);
      }
    }
  }

  private emitTick(symbol: string, tick: MarketTick): void {
    const listeners = this.listeners.get(symbol);
    if (!listeners) return;
    for (const listener of listeners) {
      try {
        listener(tick);
      } catch (err: any) {
        logger.warn('[GateTradFi] tick listener error', formatError(err, { symbol }));
      }
    }
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  private firstPositiveString(...values: unknown[]): string | null {
    for (const value of values) {
      const normalized = this.toPositiveString(value);
      if (normalized) return normalized;
    }
    return null;
  }

  private toPositiveString(value: unknown): string | null {
    if (value === undefined || value === null || value === '') return null;
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric <= 0) return null;
    return String(value);
  }
}
