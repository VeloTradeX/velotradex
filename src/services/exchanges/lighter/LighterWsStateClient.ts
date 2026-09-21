import WebSocket from 'ws';
import EventEmitter from 'events';
import net from 'net';
import { HttpsProxyAgent } from 'https-proxy-agent';
import logger, { formatError } from '../../../utils/logger';
import { safeCloseWebSocket } from '../../../utils/safeCloseWebSocket';

const HEARTBEAT_INTERVAL_MS = 25_000;
const HEARTBEAT_TIMEOUT_MS = 60_000;
const SOCKET_KEEPALIVE_MS = 30_000;
const RECONNECT_BASE_DELAY_MS = 5_000;
const RECONNECT_MAX_DELAY_MS = 60_000;

export type LighterAuthToken = {
  token: string;
  expiresAt: string | number | Date;
};

export type LighterWsStats = {
  isConnected: boolean;
  subscriptions: string[];
  lastHeartbeat: number;
  lastError: string;
  authTokenExpiresAt: string | number | Date | null;
};

export class LighterWsStateClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private keepaliveTimer: NodeJS.Timeout | null = null;
  private shouldReconnect = true;
  private reconnectAttempts = 0;
  private readonly stats: LighterWsStats = {
    isConnected: false,
    subscriptions: [],
    lastHeartbeat: 0,
    lastError: '',
    authTokenExpiresAt: null,
  };

  constructor(
    private readonly wsURL: string,
    private readonly accountIndex: number,
    private readonly authTokenProvider: () => Promise<LighterAuthToken> | LighterAuthToken,
    private readonly proxy?: string,
  ) {
    super();
  }

  async connect(): Promise<void> {
    logger.info(`[LighterWS] Attempting to connect to ${this.wsURL} for account ${this.accountIndex}`);
    this.shouldReconnect = true;
    this.clearReconnectTimer();
    this.stopKeepalive();

    safeCloseWebSocket(this.ws);
    this.ws = null;

    try {
      const auth = await this.authTokenProvider();
      this.stats.authTokenExpiresAt = auth.expiresAt;
      logger.info(`[LighterWS] Got auth token, expires at ${auth.expiresAt}`);

      const options: WebSocket.ClientOptions = {};
      if (this.proxy) {
        logger.info(`[LighterWS] Using proxy: ${this.proxy}`);
        options.agent = new HttpsProxyAgent(this.proxy);
      }

      // Pass auth token as query parameter on connection URL
      const url = new URL(this.wsURL);
      url.searchParams.set('authorization', auth.token);
      logger.info(`[LighterWS] Connecting to ${url.origin}${url.pathname}...`);

      await new Promise<void>((resolve, reject) => {
        let opened = false;
        const ws = new WebSocket(url.toString(), options);
        this.ws = ws;

        const cleanupOpenListeners = () => {
          ws.removeListener('open', onOpen);
          ws.removeListener('error', onErrorBeforeOpen);
          ws.removeListener('close', onCloseBeforeOpen);
        };
        const onOpen = () => {
          opened = true;
          cleanupOpenListeners();
          ws.on('message', data => this.onMessage(data));
          ws.on('ping', data => {
            logger.debug('[LighterWS] received native ping frame');
            ws.pong(data);
          });
          ws.on('pong', () => {
            logger.debug('[LighterWS] received native pong frame');
            this.stats.lastHeartbeat = Date.now();
          });
          ws.on('error', err => this.onError(err));
          ws.on('close', (code, reason) => this.onClose(code, reason));
          this.onOpen().then(() => resolve()).catch(reject);
        };
        const onErrorBeforeOpen = (err: Error) => {
          if (opened) return;
          cleanupOpenListeners();
          reject(err);
        };
        const onCloseBeforeOpen = () => {
          if (opened) return;
          cleanupOpenListeners();
          reject(new Error('Lighter WS closed before connection opened'));
        };

        ws.on('open', onOpen);
        ws.on('error', onErrorBeforeOpen);
        ws.on('close', onCloseBeforeOpen);
      });
    } catch (err: any) {
      this.cleanupFailedConnect();
      this.onError(err instanceof Error ? err : new Error(String(err)));
      this.scheduleReconnect();
      throw err;
    }
  }

  async disconnect(): Promise<void> {
    this.shouldReconnect = false;
    this.clearReconnectTimer();
    this.stopKeepalive();

    safeCloseWebSocket(this.ws);
    this.ws = null;

    this.stats.isConnected = false;
  }

  getStats(): LighterWsStats {
    return {
      ...this.stats,
      subscriptions: [...this.stats.subscriptions],
    };
  }

  private async onOpen(): Promise<void> {
    this.stats.isConnected = true;
    this.stats.lastError = '';
    this.stats.subscriptions = [];
    this.reconnectAttempts = 0;
    logger.info(`[LighterWS] connected to ${this.wsURL}`);

    this.startKeepalive();

    // Detect half-open / silently-dropped connections quickly via OS-level TCP keepalive.
    const socket = (this.ws as any)?._socket as net.Socket | undefined;
    if (socket && typeof socket.setKeepAlive === 'function') {
      socket.setKeepAlive(true, SOCKET_KEEPALIVE_MS);
    }

    // Get auth token for authenticated channels
    const auth = await this.authTokenProvider();
    const authToken = auth.token;
    
    // Subscribe to account_all_orders for real-time order updates
    const ordersChannel = `account_all_orders/${this.accountIndex}`;
    this.subscribe(ordersChannel, authToken);
    logger.info(`[LighterWS] subscribed to ${ordersChannel} with auth`);
    
    // Also subscribe to account_all for positions and general updates
    const accountChannel = `account_all/${this.accountIndex}`;
    this.subscribe(accountChannel);
    logger.info(`[LighterWS] subscribed to ${accountChannel}`);

    this.emit('connected');
  }

  private onMessage(data: WebSocket.RawData): void {
    try {
      const msg = JSON.parse(data.toString());

      // Any inbound message is proof the connection is alive.
      this.stats.lastHeartbeat = Date.now();
      
      // Log raw message for debugging (except ping/pong)
      const msgType = msg.type ?? '';
      if (msgType !== 'ping' && msgType !== 'pong') {
        logger.debug(`[LighterWS] raw message: ${JSON.stringify(msg).substring(0, 500)}`);
      }
      
      this.emit('message', msg);

      // Server sends ping; we respond with pong
      if (msgType === 'ping') {
        this.stats.lastHeartbeat = Date.now();
        this.send({ type: 'pong' });
        return;
      }

      // Account subscription confirmed or updated
      if (msgType === 'subscribed/account_all' || msgType === 'update/account_all') {
        this.stats.lastHeartbeat = Date.now();
        const orderCount = Array.isArray(msg.orders) ? msg.orders.length : 0;
        const posCount = Array.isArray(msg.positions) ? msg.positions.length : 0;
        const tradeCount = Array.isArray(msg.trades) ? msg.trades.length : 0;
        if (msgType === 'subscribed/account_all') {
          logger.info(`[LighterWS] subscription confirmed: ${msgType}, orders=${orderCount}, positions=${posCount}`);
        } else if (orderCount > 0 || posCount > 0 || tradeCount > 0) {
          logger.info(`[LighterWS] update received: orders=${orderCount}, positions=${posCount}, trades=${tradeCount}`);
        }
        this.emitAccountUpdate(msg);
        return;
      }

      // Account all orders subscription/update
      if (msgType === 'subscribed/account_all_orders' || msgType === 'update/account_all_orders') {
        this.stats.lastHeartbeat = Date.now();
        if (msgType === 'subscribed/account_all_orders') {
          logger.info(`[LighterWS] orders subscription confirmed`);
        }
        // msg.orders is a dict keyed by market_index
        if (msg.orders && typeof msg.orders === 'object') {
          const allOrders: any[] = [];
          for (const marketId in msg.orders) {
            const marketOrders = msg.orders[marketId];
            if (Array.isArray(marketOrders)) {
              allOrders.push(...marketOrders);
            }
          }
          if (allOrders.length > 0) {
            logger.info(`[LighterWS] orders update: ${allOrders.length} orders`);
            for (const order of allOrders) {
              const coi = order.client_order_index ?? order.clientOrderIndex ?? '?';
              const status = order.status ?? '?';
              logger.info(`[LighterWS] order event: clientOrderIndex=${coi}, status=${status}`);
              this.emit('order', order);
            }
          }
        }
        return;
      }

      // Order book subscription/update (ignore for account-only client)
      if (msgType === 'subscribed/order_book' || msgType === 'update/order_book') {
        return;
      }

      // Connected acknowledgement
      if (msgType === 'connected') {
        return;
      }

      logger.debug(`[LighterWS] unhandled message type: ${msgType}`);
    } catch (err: any) {
      this.onError(err instanceof Error ? err : new Error(String(err)));
    }
  }

  private emitAccountUpdate(msg: any): void {
    // The update/account_all message contains all account data:
    // orders, positions, trades, transactions
    
    // Emit raw account update for debugging
    this.emit('accountUpdate', msg);
    
    if (Array.isArray(msg.orders)) {
      for (const order of msg.orders) {
        const coi = order.client_order_index ?? order.clientOrderIndex ?? '?';
        const status = order.status ?? '?';
        logger.info(`[LighterWS] order event: clientOrderIndex=${coi}, status=${status}`);
        this.emit('order', order);
      }
    }

    if (Array.isArray(msg.positions)) {
      for (const position of msg.positions) {
        this.emit('position', position);
      }
    } else if (msg.positions && typeof msg.positions === 'object') {
      // positions might be a dict keyed by market_id
      for (const [marketId, position] of Object.entries(msg.positions)) {
        if (position && typeof position === 'object') {
          this.emit('position', { ...(position as any), market_id: marketId });
        }
      }
    }

    if (Array.isArray(msg.trades)) {
      for (const trade of msg.trades) {
        this.emit('trade', trade);
      }
    }

    if (Array.isArray(msg.transactions) || Array.isArray(msg.txs)) {
      const txs = msg.transactions ?? msg.txs;
      for (const tx of txs) {
        this.emit('tx', tx);
      }
    }
  }

  private onError(err: Error): void {
    this.stats.lastError = err.message;
    logger.warn('[LighterWS] error', formatError(err));
    if (this.listenerCount('error') > 0) {
      this.emit('error', err);
    }
  }

  private onClose(code?: number, reason?: Buffer): void {
    this.stats.isConnected = false;
    this.stopKeepalive();
    const reasonStr = reason?.toString() ?? '(none)';
    logger.warn(`[LighterWS] disconnected code=${code} reason=${reasonStr}`);
    
    // Log additional context for abnormal closures
    if (code === 1006) {
      logger.error(`[LighterWS] Abnormal closure (1006) - connection lost without close frame. Last error: ${this.stats.lastError || 'none'}, Last heartbeat: ${this.stats.lastHeartbeat ? new Date(this.stats.lastHeartbeat).toISOString() : 'never'}`);
    }
    
    logger.info(`[LighterWS] scheduling reconnect (backoff)`);
    this.emit('disconnected');

    this.scheduleReconnect();
  }

  private subscribe(channel: string, auth?: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    this.stats.subscriptions.push(channel);
    const msg: Record<string, unknown> = { type: 'subscribe', channel };
    if (auth) {
      msg.auth = auth;
    }
    this.send(msg);
  }

  private send(obj: Record<string, unknown>): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(obj));
    }
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private startKeepalive(): void {
    this.stopKeepalive();
    this.stats.lastHeartbeat = Date.now();

    // Watchdog: runs regardless of the ws readyState so that a connection which
    // goes half-open (silently dropped by the network/gateway) is detected and
    // torn down promptly instead of lingering undetected for hours.
    this.keepaliveTimer = setInterval(() => {
      if (this.shouldReconnect === false) {
        return; // intentionally disconnected via disconnect()
      }

      const timeSinceLastHeartbeat = Date.now() - this.stats.lastHeartbeat;
      if (timeSinceLastHeartbeat > HEARTBEAT_TIMEOUT_MS) {
        logger.warn(`[LighterWS] heartbeat timeout (${Math.round(timeSinceLastHeartbeat / 1000)}s since last signal), reconnecting`);
        this.reconnectNow();
        return;
      }

      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        // Send an application-level ping so the exchange gateway counts this
        // connection as active (native RFC-level ping frames are often ignored
        // by idle-timeout accounting) and fall back to a native ping as well.
        this.send({ type: 'ping' });
        this.ws.ping();
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  private stopKeepalive(): void {
    if (this.keepaliveTimer) {
      clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = null;
    }
  }

  private reconnectNow(): void {
    this.clearReconnectTimer();
    this.stopKeepalive();
    safeCloseWebSocket(this.ws);
    this.ws = null;
    this.shouldReconnect = true;
    this.scheduleReconnect(0);
  }

  private scheduleReconnect(delayMs?: number): void {
    if (!this.shouldReconnect || this.reconnectTimer) return;

    const backoff = Math.min(
      RECONNECT_MAX_DELAY_MS,
      RECONNECT_BASE_DELAY_MS * Math.pow(2, this.reconnectAttempts),
    );
    const delay = delayMs ?? Math.round(backoff * (0.8 + Math.random() * 0.4));
    this.reconnectAttempts += 1;

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect().catch(() => undefined);
    }, delay);
  }

  private cleanupFailedConnect(): void {
    this.stats.isConnected = false;

    safeCloseWebSocket(this.ws);
    this.ws = null;
  }
}

export default LighterWsStateClient;
