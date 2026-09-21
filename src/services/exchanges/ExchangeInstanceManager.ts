import { IExchange, ExchangeConfig, OrderParams, OrderResult, AccountBalance, Position, MarketInfo, Ticker, Trade, Candle } from './IExchange';
import { GateIOExchange } from './GateIOExchange';
import { GateCFDExchange } from './GateCFDExchange';
import { VirtualGateExchange } from './virtual/VirtualGateExchange';
import { VirtualGateTradFiExchange } from './virtual/VirtualGateTradFiExchange';
import { LighterExchange } from './lighter';
import { GateIORestClient } from './gate/GateIORestClient';
import { MarketDataHub } from '../marketData/MarketDataHub';
import { GateMarketDataStream } from '../marketData/GateMarketDataStream';
import { GateTradFiMarketDataStream } from '../marketData/GateTradFiMarketDataStream';
import { GateTradFiStreamAdapter } from '../marketData/GateTradFiStreamAdapter';
import { ExchangeInstance } from '../../models';
import logger, { formatError } from '../../utils/logger';
import exchangeConnectionLogService from '../ExchangeConnectionLogService';
import { VirtualExchangeFillHandler } from '../VirtualExchangeFillHandler';
import config from '../../config';

export function serializeError(error: unknown): Record<string, unknown> {
    if (error instanceof Error) {
        const serialized: Record<string, unknown> = {
            name: error.name,
            message: error.message,
            stack: error.stack,
        };

        const candidate = error as Error & {
            code?: unknown;
            errno?: unknown;
            syscall?: unknown;
            path?: unknown;
            cause?: unknown;
        };
        if (candidate.code !== undefined) serialized.code = candidate.code;
        if (candidate.errno !== undefined) serialized.errno = candidate.errno;
        if (candidate.syscall !== undefined) serialized.syscall = candidate.syscall;
        if (candidate.path !== undefined) serialized.path = candidate.path;
        if (candidate.cause !== undefined) serialized.cause = serializeError(candidate.cause);

        return serialized;
    }

    if (typeof error === 'string') {
        return { message: error };
    }

    if (error && typeof error === 'object') {
        return { ...error };
    }

    return { message: String(error) };
}

class NoOpExchange implements IExchange {
    id = 'noop';
    name = 'NoOpExchange';

    async start() {}
    async stop() {}
    async placeOrder(params: OrderParams): Promise<OrderResult> { return { id: 'noop', status: 'closed' }; }
    async amendOrder(orderId: string, symbol: string, price?: string, amount?: string): Promise<OrderResult> { return { id: 'noop', status: 'closed' }; }
    async cancelOrder(orderId: string, symbol: string): Promise<boolean> { return true; }
    async cancelPriceOrder(orderId: string, symbol: string): Promise<boolean> { return true; }
    async updateStopLoss(symbol: string, side: 'buy' | 'sell', price: string, text?: string): Promise<string | null> { return null; }
    async closePosition(symbol: string, side: 'buy' | 'sell', price?: string, amount?: string, text?: string): Promise<boolean> { return true; }
    async getBalance(currency?: string): Promise<AccountBalance> { return { currency: currency || 'USDT', available: '0', total: '0' }; }
    async getPosition(symbol: string): Promise<Position | null> { return null; }
    async getPositions(): Promise<Position[]> { return []; }
    async getOrder(orderId: string, symbol: string): Promise<OrderResult> { return { id: orderId, status: 'closed', symbol, side: 'buy', price: '0', amount: '0' }; }
    async getOpenOrders(symbol?: string): Promise<OrderResult[]> { return []; }
    async getFinishedOrders(symbol: string, limit?: number): Promise<OrderResult[]> { return []; }
    async getPriceOrders(symbol?: string): Promise<OrderResult[]> { return []; }
    async waitForOrderFill(orderId: string, symbol: string, timeoutMs?: number): Promise<OrderResult> { return { id: orderId, status: 'closed', symbol, side: 'buy', price: '0', amount: '0' }; }
    async getTradeHistory(symbol: string, limit?: number): Promise<Trade[]> { return []; }
    async getMarkets(): Promise<MarketInfo[]> { return []; }
    async getTicker(symbol: string): Promise<Ticker> { return { symbol, lastPrice: '0', markPrice: '0', indexPrice: '0', fundingRate: '0', volume24h: '0', change24h: '0' }; }
    async getCandles(symbol: string, timeframe: string, limit?: number): Promise<Candle[]> { return []; }
    async setLeverage(symbol: string, leverage: string): Promise<boolean> { return true; }
    async setMarginMode(symbol: string, marginMode: 'cross' | 'isolated', leverage?: string): Promise<boolean> { return true; }
    async getMarginMode(symbol: string): Promise<{ marginMode: 'cross' | 'isolated', leverage: string }> { return { marginMode: 'cross', leverage: '1' }; }
    getWebSocketStats() { return { isConnected: false }; }
}

class ExchangeInstanceManager {
    private exchanges: Map<string, IExchange> = new Map();
    private marketDataRestClient: GateIORestClient | null = null;

    /**
     * 回测子进程的空行情流：不建立任何真实 WS 连接，
     * tick 完全由回测引擎通过 MarketDataHub.ingestTick 注入。
     */
    private static readonly replayStream = () => ({
        start: async (_listener: (tick: any) => void) => {},
        stop: async () => {},
    });

    private marketDataHub = new MarketDataHub({
        createStream: symbol => config.backtest.child
            ? ExchangeInstanceManager.replayStream() as any
            : new GateMarketDataStream(symbol, {
                fetchTicker: async contract => {
                    const tickers = await this.getMarketDataRestClient().listTickers(contract);
                    return Array.isArray(tickers) ? tickers[0] : tickers;
                },
                wsUrl: 'wss://fx-ws.gateio.ws/v4/ws/usdt',
                proxyUrl: config.trading.wsProxy || undefined,
            }),
    });

    private getMarketDataRestClient(): GateIORestClient {
        if (!this.marketDataRestClient) {
            this.marketDataRestClient = new GateIORestClient({
                id: 'gate-market-data',
                type: 'gate',
                name: 'Gate Market Data',
                apiKey: '',
                apiSecret: '',
                baseURL: config.external.urls.gateApiBase,
            });
        }
        return this.marketDataRestClient;
    }

    // ── 虚拟 Gate TradFi 行情源：共用一条 Gate TradFi 公共 WS 连接，经适配器桥接进 MarketDataHub ──
    private tradFiStream: GateTradFiMarketDataStream | null = null;

    private getTradFiStream(): GateTradFiMarketDataStream {
        if (!this.tradFiStream) {
            this.tradFiStream = new GateTradFiMarketDataStream({
                proxyUrl: config.trading.wsProxy || undefined,
            });
        }
        return this.tradFiStream;
    }

    private virtualTradFiHub = new MarketDataHub({
        createStream: symbol => config.backtest.child
            ? ExchangeInstanceManager.replayStream() as any
            : new GateTradFiStreamAdapter(this.getTradFiStream(), symbol),
    });

    /** 回测子进程：回测引擎用它向虚拟 TradFi 交易所注入历史行情 tick */
    public getVirtualTradFiHub(): MarketDataHub {
        return this.virtualTradFiHub;
    }

    public async initialize() {
        // Load from DB
        try {
            const instances = await ExchangeInstance.findAll({ where: { status: 'active' } });
       
            // Migration: If no instances, create default from config
            // 回测子进程：跳过默认实例创建（子进程仅注册回测 bt_ 虚拟实例，不连任何实盘交易所）
            if (instances.length === 0 && !config.backtest.child) {
                logger.info('No exchange instances found in DB. Creating default from config...');
                const defaultType = config.trading.exchange;
                let defaultConfig: any = {};
                
                if (defaultType === 'gate') {
                    defaultConfig = {
                        apiKey: config.trading.gate.apiKey,
                        apiSecret: config.trading.gate.apiSecret,
                        baseURL: config.trading.mode === 'testnet' ? config.trading.gate.baseURL.testnet : config.trading.gate.baseURL.real,
                        isTestnet: config.trading.mode === 'testnet',
                        proxy: config.trading.apiProxy
                    };
                }

                try {
                    const newInstance = await ExchangeInstance.create({
                        id: `${defaultType}_main`,
                        type: defaultType,
                        name: 'Main Exchange',
                        config: JSON.stringify(defaultConfig),
                        status: 'active'
                    });
                    // Push to instances array so we register it below
                    instances.push(newInstance);
                } catch (err) {
                    logger.error('Failed to create default exchange instance', { error: err });
                }
            }

            for (const instance of instances) {
                await this.registerExchange(instance);
            }
        } catch (err) {
            logger.error('Failed to initialize ExchangeInstanceManager', { error: err });
        }
    }

    public getExchange(id?: string): IExchange {
        if (!id) {
            // Return first one as default
            if (this.exchanges.size > 0) {
                const first = this.exchanges.values().next().value;
                if (first) return first;
            }
            logger.warn('No exchange instances available. Returning NoOpExchange.');
            return new NoOpExchange();
        }

        const exchange = this.exchanges.get(id);
        if (!exchange) {
            throw new Error(`Exchange instance ${id} not found`);
        }
        return exchange;
    }

    /** 判断指定交易所实例是否存在；为空时按「存在」处理（getExchange 会回退默认实例）。 */
    public hasExchange(id?: string): boolean {
        if (!id) return true;
        return this.exchanges.has(id);
    }

    public getAllExchanges(): IExchange[] {
        return Array.from(this.exchanges.values());
    }

    public getAllExchangeEntries(): Array<[string, IExchange]> {
        return Array.from(this.exchanges.entries());
    }

    public async registerExchange(instanceModel: ExchangeInstance) {
        try {
            const conf = JSON.parse(instanceModel.config);
            const exchangeConfig: ExchangeConfig = {
                ...conf,
                id: instanceModel.id,
                name: instanceModel.name,
                type: instanceModel.type
            };

            let exchange: IExchange;
            if (instanceModel.type === 'gate') {
                exchange = new GateIOExchange(exchangeConfig);
            } else if (instanceModel.type === 'virtual_gate') {
                const fillHandler = new VirtualExchangeFillHandler();
                exchange = new VirtualGateExchange(
                  exchangeConfig as any,
                  this.marketDataHub,
                  fillHandler.handleProtectionFill.bind(fillHandler),
                );
            } else if (instanceModel.type === 'virtual_gate_tradfi') {
                // 虚拟 Gate TradFi：虚拟撮合，行情源自 Gate TradFi（共用 tradFiHub）
                const fillHandler = new VirtualExchangeFillHandler();
                exchange = new VirtualGateTradFiExchange(
                  exchangeConfig as any,
                  this.virtualTradFiHub,
                  fillHandler.handleProtectionFill.bind(fillHandler),
                );
            } else if (instanceModel.type === 'lighter') {
                exchange = new LighterExchange(exchangeConfig);
            } else if (instanceModel.type === 'gate_tradfi' || instanceModel.type === 'gate_cfd') {
                // Gate-CFD（/tradfi/*）：前端沿用既有类型名 gate_tradfi，兼容 gate_cfd 别名
                exchange = new GateCFDExchange(exchangeConfig);
            } else {
                logger.warn(`Unknown exchange type ${instanceModel.type}, skipping`);
                return;
            }

            if (exchange.start) {
                await exchange.start();
            }

            // 挂接连接状态监听：记录断连/重连历史（仅对支持事件与 WS 状态的对象生效）
            this.setupConnectionLogging(exchange, instanceModel);

            this.exchanges.set(instanceModel.id, exchange);
            logger.info(`Registered exchange instance: ${instanceModel.id}`);
        } catch (error) {
            logger.error(`Failed to register exchange ${instanceModel.id}`, { error: serializeError(error) });
        }
    }

    public async unregisterExchange(id: string) {
        const exchange = this.exchanges.get(id);
        if (exchange) {
            if (exchange.stop) {
                await exchange.stop();
            }
            this.exchanges.delete(id);
            logger.info(`Unregistered exchange instance: ${id}`);
        }
    }

    /**
     * 挂接交易所连接状态监听，将断连/重连事件写入 exchange_connection_logs：
     *  - 'disconnected'：记录一次断连（时间/原因/名称快照）；
     *  - 'wsConnected'  ：闭合最近的未闭合断连记录并回填持续时间。
     * 仅对支持事件（EventEmitter）的交易所生效，失败仅记日志不影响运行。
     */
    private setupConnectionLogging(exchange: IExchange, instanceModel: ExchangeInstance): void {
        if (typeof exchange.on !== 'function') return;

        const id = exchange.id || instanceModel.id;
        const name = exchange.name || instanceModel.name || id;
        const type = instanceModel.type || '';

        exchange.on('disconnected', () => {
            const stats = (exchange as any).getWebSocketStats
                ? (exchange as any).getWebSocketStats()
                : null;
            const reason = (stats && stats.lastError) || '连接断开';
            void exchangeConnectionLogService.recordDisconnect({
                exchangeInstanceId: id,
                exchangeName: name,
                exchangeType: type,
                reason,
            });
        });

        exchange.on('wsConnected', () => {
            void exchangeConnectionLogService.recordReconnect(id);
        });
    }

    // For testing compatibility
    public setExchange(exchange: IExchange) {
        this.exchanges.clear();
        // If mock exchange doesn't have id, use 'mock'
        const id = exchange.id || 'mock';
        // Ensure id property exists on object if it was missing
        if (!exchange.id) (exchange as any).id = id;
        
        this.exchanges.set(id, exchange);
    }
    
    public async handleUpdate(payload: any) {
        try {
            // Expected payload: { action: 'reload' | 'delete', id: '...' }
            if (payload.action === 'reload') {
                logger.info(`Reloading exchange instance ${payload.id}...`);
                await this.unregisterExchange(payload.id);
                const instance = await ExchangeInstance.findByPk(payload.id);
                if (instance && instance.status === 'active') {
                    await this.registerExchange(instance);
                }
            } else if (payload.action === 'delete') {
                await this.unregisterExchange(payload.id);
            }
        } catch (err: any) {
            logger.error('Failed to handle exchange update message', formatError(err, { payload }));
        }
    }
}

export default new ExchangeInstanceManager();
