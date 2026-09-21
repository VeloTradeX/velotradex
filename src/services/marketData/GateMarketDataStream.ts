import logger, { formatError } from '../../utils/logger';
import { safeCloseWebSocket } from '../../utils/safeCloseWebSocket';
import { MarketDataStream, MarketTickListener } from './types';
import WebSocket from 'ws';
import { HttpsProxyAgent } from 'https-proxy-agent';

export interface GateTickerPayload {
  contract?: string;
  last?: string | number;
  last_price?: string | number;
  mark_price?: string | number;
  index_price?: string | number;
}

export type GateTickerFetcher = (symbol: string) => Promise<GateTickerPayload | GateTickerPayload[] | null>;

export interface GateMarketDataStreamOptions {
  intervalMs?: number;
  fetchTicker: GateTickerFetcher;
  wsUrl?: string;
  proxyUrl?: string;
  useWebSocket?: boolean;
}

export class GateMarketDataStream implements MarketDataStream {
  private readonly symbol: string;
  private readonly fetchTicker: GateTickerFetcher;
  private readonly intervalMs: number;
  private readonly wsUrl: string;
  private readonly proxyUrl: string | undefined;
  private readonly useWebSocket: boolean;
  private timeout: NodeJS.Timeout | null = null;
  private listener: MarketTickListener | null = null;
  private running = false;
  private generation = 0;
  private ws: WebSocket | null = null;
  private wsConnected = false;
  private pingInterval: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectCount = 0;
  private readonly reconnectDelay = 5000;
  private readonly maxReconnectDelay = 60000;
  private isPolling = false;

  constructor(symbol: string, options: GateMarketDataStreamOptions) {
    this.symbol = symbol.trim().toUpperCase();
    this.fetchTicker = options.fetchTicker;
    this.intervalMs = options.intervalMs ?? 1000;
    this.wsUrl = options.wsUrl ?? 'wss://fx-ws.gateio.ws/v4/ws/usdt';
    this.proxyUrl = options.proxyUrl;
    this.useWebSocket = options.useWebSocket ?? true;
  }

  async start(listener: MarketTickListener): Promise<void> {
    this.generation += 1;
    this.running = true;
    this.listener = listener;

    if (this.useWebSocket) {
      this.connectWS();
    } else {
      this.startPolling();
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    this.generation += 1;
    this.disconnectWS();
    this.stopPolling();
    this.listener = null;
  }

  private async runPollCycle(generation: number): Promise<void> {
    if (!this.isActive(generation) || !this.isPolling) {
      return;
    }

    await this.poll(generation);

    if (this.isActive(generation) && this.isPolling) {
      this.timeout = setTimeout(() => {
        void this.runPollCycle(generation);
      }, this.intervalMs);
    }
  }

  private async poll(generation: number): Promise<void> {
    if (!this.isActive(generation)) {
      return;
    }

    try {
      const data = await this.fetchTicker(this.symbol);
      if (!this.isActive(generation)) {
        return;
      }

      const payload = this.extractPayload(data);
      if (!payload) {
        return;
      }

      const lastPrice = this.firstPositiveString(payload.last, payload.last_price, payload.mark_price);
      if (!lastPrice) {
        return;
      }

      const listener = this.listener;
      if (!listener) {
        return;
      }

      listener({
        symbol: payload.contract?.trim().toUpperCase() || this.symbol,
        lastPrice,
        markPrice: this.toPositiveString(payload.mark_price) ?? undefined,
        indexPrice: this.toPositiveString(payload.index_price) ?? undefined,
        source: 'gate',
        receivedAt: new Date(),
      });
    } catch (error: any) {
      if (!this.isActive(generation)) {
        return;
      }

      logger.warn('Gate market data poll failed', formatError(error, { symbol: this.symbol }));
    }
  }

  private extractPayload(data: unknown): GateTickerPayload | null {
    if (Array.isArray(data)) {
      return (data[0] as GateTickerPayload | undefined) ?? null;
    }

    if (data && typeof data === 'object') {
      return data as GateTickerPayload;
    }

    return null;
  }

  private firstPositiveString(...values: unknown[]): string | null {
    for (const value of values) {
      const normalized = this.toPositiveString(value);
      if (normalized) return normalized;
    }
    return null;
  }

  private toPositiveString(value: unknown): string | null {
    if (value === undefined || value === null || value === '') {
      return null;
    }

    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric <= 0) {
      return null;
    }

    return String(value);
  }

  private isActive(generation: number): boolean {
    return this.running && this.generation === generation && !!this.listener;
  }

  private clearScheduledPoll(): void {
    if (this.timeout) {
      clearTimeout(this.timeout);
      this.timeout = null;
    }
  }

  private connectWS(): void {
    this.disconnectWS();

    const options: WebSocket.ClientOptions = {};
    if (this.proxyUrl) {
      options.agent = new HttpsProxyAgent(this.proxyUrl);
    }

    logger.info(`Gate market WS connecting: ${this.wsUrl}`, { symbol: this.symbol });
    this.ws = new WebSocket(this.wsUrl, options);

    this.ws.on('open', () => this.onWSOpen());
    this.ws.on('message', (data) => this.handleWSMessage(data));
    this.ws.on('error', (err) => {
      logger.warn('Gate market WS error', formatError(err, { symbol: this.symbol }));
      this.ws?.terminate();
    });
    this.ws.on('close', () => this.onWSClose());
  }

  private onWSOpen(): void {
    this.wsConnected = true;
    this.reconnectCount = 0;
    logger.info('Gate market WS connected', { symbol: this.symbol });

    this.startWSPing();

    if (this.isPolling) {
      this.stopPolling();
      logger.info('Gate market WS recovered, stopped HTTP poll', { symbol: this.symbol });
    }

    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    const subscribeMsg = {
      time: Math.floor(Date.now() / 1000),
      channel: 'futures.tickers',
      event: 'subscribe',
      payload: [this.symbol],
    };
    this.ws.send(JSON.stringify(subscribeMsg));
  }

  private handleWSMessage(data: WebSocket.Data): void {
    try {
      const msg = JSON.parse(data.toString());

      if (msg.channel === 'futures.pong') return;

      if (msg.event === 'subscribe') {
        if (msg.error) {
          logger.error('Gate market WS subscribe failed', { symbol: this.symbol, error: msg.error });
        } else {
          logger.info('Gate market WS subscribed', { symbol: this.symbol });
        }
        return;
      }

      if (msg.event === 'update' && msg.channel === 'futures.tickers' && Array.isArray(msg.result)) {
        for (const ticker of msg.result) {
          const lastPrice = this.firstPositiveString(ticker.last, ticker.last_price, ticker.mark_price);
          if (!lastPrice) continue;

          const contractSymbol = (ticker.contract ?? '').trim().toUpperCase();
          if (contractSymbol !== this.symbol) continue;

          const listener = this.listener;
          if (!listener) continue;

          listener({
            symbol: contractSymbol,
            lastPrice,
            markPrice: this.toPositiveString(ticker.mark_price) ?? undefined,
            indexPrice: this.toPositiveString(ticker.index_price) ?? undefined,
            source: 'gate',
            receivedAt: new Date(),
          });
        }
      }
    } catch (err: any) {
      logger.warn('Gate market WS message parse error', formatError(err, { symbol: this.symbol }));
    }
  }

  private onWSClose(): void {
    if (!this.wsConnected && !this.ws) return;
    const wasConnected = this.wsConnected;
    this.wsConnected = false;
    this.stopWSPing();

    if (wasConnected) {
      logger.info('Gate market WS closed, falling back to HTTP poll', { symbol: this.symbol });
    }

    if (!this.isPolling && this.running && this.listener) {
      this.startPolling();
    }

    if (this.running) {
      this.scheduleReconnect();
    }
  }

  private disconnectWS(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.stopWSPing();
    safeCloseWebSocket(this.ws);
    this.ws = null;
    this.wsConnected = false;
  }

  private scheduleReconnect(): void {
    this.reconnectCount++;
    const delay = Math.min(
      this.reconnectDelay * Math.pow(1.5, this.reconnectCount - 1),
      this.maxReconnectDelay,
    );
    const jitter = Math.random() * 1000;
    const totalDelay = delay + jitter;

    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);

    logger.info(`Gate market WS reconnecting in ${(totalDelay / 1000).toFixed(1)}s (attempt ${this.reconnectCount})`, { symbol: this.symbol });

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connectWS();
    }, totalDelay);
  }

  private startPolling(): void {
    if (this.isPolling) return;
    this.isPolling = true;
    this.generation += 1;
    void this.runPollCycle(this.generation);
  }

  private stopPolling(): void {
    this.isPolling = false;
    this.generation += 1;
    this.clearScheduledPoll();
  }

  private startWSPing(): void {
    this.stopWSPing();
    this.pingInterval = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({
          time: Math.floor(Date.now() / 1000),
          channel: 'futures.ping',
        }));
      }
    }, 15000);
  }

  private stopWSPing(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }
}
