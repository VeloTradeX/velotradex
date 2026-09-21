import WebSocket from 'ws';
import crypto from 'crypto';
import EventEmitter from 'events';
import { HttpsProxyAgent } from 'https-proxy-agent';
import config from '../../config';
import logger, { formatError } from '../../utils/logger';
import { safeCloseWebSocket } from '../../utils/safeCloseWebSocket';
import { nowSec } from './gate/GateTimeSync';
import JSONBig from 'json-bigint';

const jsonBig = JSONBig({ storeAsString: true });

export class GateIOWebSocket extends EventEmitter {
    private ws: WebSocket | null = null;
    private baseURL: string;
    private apiKey: string;
    private apiSecret: string;
    private pingInterval: NodeJS.Timeout | null = null;
    private reconnectTimer: NodeJS.Timeout | null = null;
    private isReconnecting: boolean = false;
    private shouldReconnect: boolean = true;
    private reconnectDelay: number = 5000;
    private maxReconnectDelay: number = 60000;
    private stats = {
        isConnected: false,
        reconnectCount: 0,
        lastHeartbeat: 0,
        heartbeatCount: 0,
        startTime: 0,
        lastError: '',
        lastErrorTime: 0,
        connectedAt: ''
    };
    private pendingRequests = new Map<string, { 
        resolve: (value: any) => void, 
        reject: (reason?: any) => void, 
        timer: NodeJS.Timeout,
        context: { channel: string, event: string, reqParam: any }
    }>();

    // Exposed for GateIOWSEventRouter in GateIOExchange
    public fillListeners = new Map<string, (order: any) => void>();

    private proxyUrl?: string;

    constructor(baseURL: string, apiKey: string, apiSecret: string, proxyUrl?: string) {
        super();
        this.baseURL = baseURL;
        this.apiKey = apiKey.trim();
        this.apiSecret = apiSecret.trim();
        this.proxyUrl = proxyUrl;

        if (!this.apiKey || !this.apiSecret) {
            logger.warn('GateIO WS: Credentials missing!');
        }
    }

    public async connect() {
        safeCloseWebSocket(this.ws);

        this.shouldReconnect = true;

        const options: WebSocket.ClientOptions = {};

        // Use proxy if provided
        if (this.proxyUrl) {
             logger.info(`GateIO WS: Using Proxy ${this.proxyUrl}`);
             options.agent = new HttpsProxyAgent(this.proxyUrl);
        }

        logger.info(`Connecting to GateIO WS: ${this.baseURL}`);
        this.ws = new WebSocket(this.baseURL, options);

        this.ws.on('open', this.onOpen.bind(this));
        this.ws.on('message', this.onMessage.bind(this));
        this.ws.on('error', this.onError.bind(this));
        this.ws.on('close', this.onClose.bind(this));
    }

    public async disconnect() {
        this.shouldReconnect = false; // Prevent auto-reconnect
        if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
        
        if (this.ws) {
            safeCloseWebSocket(this.ws);
            this.ws = null;
        }
        if (this.pingInterval) clearInterval(this.pingInterval);
        this.stats.isConnected = false;
    }

    public async waitForOpen(): Promise<void> {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) return;
        return new Promise(resolve => {
            const onOpen = () => {
                resolve();
                this.removeListener('connected', onOpen);
            };
            this.on('connected', onOpen);
            // Optional: Timeout?
            setTimeout(() => {
                this.removeListener('connected', onOpen);
                // resolve anyway or throw? Better to let the caller handle timeout or retry.
                // But for now, just let it hang or resolve if connected.
                if (this.ws && this.ws.readyState === WebSocket.OPEN) resolve();
            }, 5000);
        });
    }

    private async onOpen() {
        logger.info('GateIO WS Connected');
        this.stats.isConnected = true;
        this.stats.reconnectCount = 0;
        this.stats.lastError = '';

        const now = new Date();
        const year = now.getFullYear();
        const month = String(now.getMonth() + 1).padStart(2, '0');
        const day = String(now.getDate()).padStart(2, '0');
        const hour = String(now.getHours()).padStart(2, '0');
        const minute = String(now.getMinutes()).padStart(2, '0');
        const second = String(now.getSeconds()).padStart(2, '0');
        this.stats.connectedAt = `${year}-${month}-${day} ${hour}:${minute}:${second}`;

        if (this.stats.startTime === 0) {
            this.stats.startTime = Date.now();
        }

        this.startPing();
        this.isReconnecting = false;
        
        try {
            await this.login();
            logger.info('GateIO WS Logged In');
            this.emit('connected');

            // Subscribe immediately as per working example
            this.subscribeAll();
        } catch (err: any) {
            logger.error('GateIO WS Login Failed', { err });
            this.stats.lastError = err.message;
            this.stats.lastErrorTime = Date.now();
            // Close to trigger reconnect logic
            this.ws?.close(); 
        }
    }

    private async login(): Promise<void> {
        return new Promise((resolve, reject) => {
            if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
                return reject(new Error('GateIO WS not connected'));
            }

            const reqId = `login-${Date.now()}`;
            const time = nowSec();
            
            // Login Signature: api\nfutures.login\n\n{time}
            const signStr = `api\nfutures.login\n\n${time}`;
            const signature = crypto.createHmac('sha512', this.apiSecret).update(signStr).digest('hex');

            const req = {
                time,
                channel: 'futures.login',
                event: 'api',
                payload: {
                    req_id: reqId,
                    api_key: this.apiKey,
                    timestamp: time.toString(),
                    signature
                }
            };

            // Timeout 10s
            const timer = setTimeout(() => {
                if (this.pendingRequests.has(reqId)) {
                    this.pendingRequests.delete(reqId);
                    reject(new Error('GateIO WS Login Timeout'));
                }
            }, 10000);

            this.pendingRequests.set(reqId, { 
                resolve, 
                reject, 
                timer,
                context: { channel: 'futures.login', event: 'api', reqParam: {} }
            });

            logger.info(`Sending GateIO WS Login Request (ID: ${reqId})`);
            this.ws.send(JSON.stringify(req));
        });
    }

    private subscribeAll() {
        // Balances: payload []
        this.subscribe('futures.balances', []);
        // Orders: payload ['!all'] (Working example uses this, NOT user_id)
        this.subscribe('futures.orders', ['!all']);
        // Positions: payload ['!all']
        this.subscribe('futures.positions', ['!all']);
    }

    private onMessage(data: WebSocket.Data) {
        try {
            // Use jsonBig to handle large numbers/IDs safely
            const msg = jsonBig.parse(data.toString());
            
            if (msg.event === 'subscribe') {
                if (msg.error) {
                    logger.error(`GateIO WS Subscription Failed [${msg.channel}]`, { error: msg.error });
                } else {
                    logger.info(`GateIO WS Subscribed [${msg.channel}]`);
                }
                return;
            }

            // Handle API responses (place/cancel/amend order)
            // Note: API responses have event inside header, while Subscribe responses have event at root
            if (msg.event === 'api' || msg.header?.event === 'api') {
                const reqId = msg.header?.req_id || msg.request_id;
                
                // Ignore ACK messages (they just confirm receipt, not execution result)
                if (msg.ack === true) {
                    // logger.info(`GateIO WS ACK Received: ${reqId}`);
                    return;
                }

                if (reqId && this.pendingRequests.has(reqId)) {
                    const { resolve, reject, timer, context } = this.pendingRequests.get(reqId)!;
                    clearTimeout(timer);
                    this.pendingRequests.delete(reqId);

                    if (msg.header && msg.header.status) {
                        const status = parseInt(msg.header.status);
                        if (status >= 400) {
                             const errorMsg = `GateIO WS API Error: ${JSON.stringify(msg.data || msg.error)}`;
                             logger.error(errorMsg, {
                                 path: `${context.channel}:${context.event}`,
                                 requestBody: context.reqParam,
                                 responseBody: msg.data || msg.error
                             });
                             reject(new Error(errorMsg));
                        } else {
                            // For API responses, result is in 'data.result'
                            if (msg.data && msg.data.result) {
                                resolve(msg.data.result);
                            } else {
                                resolve(msg.data);
                            }
                        }
                    } else if (msg.error) {
                        const errorMsg = `GateIO WS API Error: ${JSON.stringify(msg.error)}`;
                        logger.error(errorMsg, {
                            path: `${context.channel}:${context.event}`,
                            requestBody: context.reqParam,
                            responseBody: msg.error
                        });
                        reject(new Error(errorMsg));
                    } else {
                        resolve(msg.result);
                    }
                }
                return;
            }

            if (msg.channel === 'futures.pong') {
                this.stats.lastHeartbeat = Date.now();
                this.stats.heartbeatCount++;
                return;
            }
            // console.log('GateIO WS Message:', msg); // Reduce noise
            
            // Log ALL api events for debugging
            if (msg.event === 'api' || msg.header?.event === 'api') {
                 logger.info('GateIO WS API Response (Debug):', { msg });
            }

            if (msg.error) {
                logger.error('GateIO WS Error Message Received', { error: msg.error });
                this.stats.lastError = typeof msg.error === 'string' ? msg.error : JSON.stringify(msg.error);
                this.stats.lastErrorTime = Date.now();
                return;
            }

            if (msg.event === 'update') {
                if (msg.channel === 'futures.orders') {
                    this.handleOrderUpdate(msg.result);
                } else if (msg.channel === 'futures.positions') {
                    this.handlePositionUpdate(msg.result);
                }
            }
        } catch (err) {
            logger.error('GateIO WS Message Parse Error', { err });
        }
    }

    private handleOrderUpdate(orders: any[]) {
        for (const order of orders) {
            this.emit('order_update', order);
        }
    }

    private handlePositionUpdate(positions: any[]) {
        for (const pos of positions) {
            this.emit('position_update', pos);
        }
    }

    private onError(err: Error) {
        logger.error('GateIO WS Error', formatError(err));
        this.stats.lastError = err.message;
        this.stats.lastErrorTime = Date.now();
        this.emit('error', err);

        // Always terminate on error to force a clean reconnect.
        // The isConnected flag may be stale (e.g., close fired before error),
        // so we unconditionally terminate.
        this.ws?.terminate();
    }

    private onClose() {
        // Reject all pending requests BEFORE any reconnect logic.
        // This ensures callers (like placeOrder) are unblocked immediately
        // instead of hanging forever when the connection drops.
        if (this.pendingRequests.size > 0) {
            logger.warn(`GateIO WS Closed with ${this.pendingRequests.size} pending requests — rejecting all`);
            for (const [reqId, { reject, timer }] of this.pendingRequests.entries()) {
                clearTimeout(timer);
                reject(new Error(`GateIO WS connection closed while waiting for ${reqId}`));
            }
            this.pendingRequests.clear();
        }

        const wasConnected = this.stats.isConnected;
        this.stats.isConnected = false;
        this.stopPing();
        this.emit('disconnected');

        if (wasConnected) {
            logger.info('GateIO WS Closed');
        }

        if (this.shouldReconnect && !this.isReconnecting) {
            this.reconnect();
        }
    }

    private reconnect() {
        this.isReconnecting = true;
        this.stats.reconnectCount++;
        
        // Exponential backoff with jitter
        const delay = Math.min(this.reconnectDelay * Math.pow(1.5, this.stats.reconnectCount - 1), this.maxReconnectDelay);
        const jitter = Math.random() * 1000;
        const totalDelay = delay + jitter;

        if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
        
        logger.info(`GateIO WS Reconnecting in ${(totalDelay/1000).toFixed(1)}s... (Attempt ${this.stats.reconnectCount})`);
        
        this.reconnectTimer = setTimeout(() => {
            this.isReconnecting = false;
            this.connect();
        }, totalDelay);
    }

    private startPing() {
        if (this.pingInterval) clearInterval(this.pingInterval);
        this.pingInterval = setInterval(() => {
            if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                this.ws.send(JSON.stringify({
                    time: nowSec(),
                    channel: 'futures.ping'
                }));
            }
        }, 5000); // 5s interval as per working example
    }

    private stopPing() {
        if (this.pingInterval) clearInterval(this.pingInterval);
    }

    public subscribe(channel: string, payload: any[]) {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

        const time = nowSec();
        const event = 'subscribe';
        
        // Gate.io V4 WS Signature for Private Channels
        const signStr = `channel=${channel}&event=${event}&time=${time}`;
        const signature = crypto.createHmac('sha512', this.apiSecret).update(signStr).digest('hex');

        const req = {
            time,
            channel,
            event,
            payload,
            auth: {
                method: 'api_key',
                KEY: this.apiKey,
                SIGN: signature
            }
        };

        logger.info(`Subscribing to ${channel}`);
        this.ws.send(JSON.stringify(req));
    }
    public getStats() {
        return { ...this.stats };
    }
}

export default GateIOWebSocket;
