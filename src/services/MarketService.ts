import exchangeRegistry from './exchanges';
import logger from '../utils/logger';
import { ExchangeInstance } from '../models';
import config from '../config';
import axios from 'axios';
import { getBacktestPrice } from '../backtest/Clock';

class MarketService {
    // Cache for prices to avoid hammering API if multiple parsers need it
    private priceCache: Map<string, { price: number, timestamp: number }> = new Map();
    private readonly CACHE_TTL = 5000; // 5 seconds
    private priceCacheCallCount = 0;
    private readonly PRICE_CACHE_CLEANUP_INTERVAL = 100;
    private commonPricesCache: { xml: string; timestamp: number } | null = null;
    private readonly COMMON_PRICES_CACHE_TTL = 24 * 60 * 60 * 1000; // 1 day
    private readonly COMMON_MARKETS = [
        { symbol: 'BTC_USDT', aliases: ['BTC', 'Bitcoin'] },
        { symbol: 'ETH_USDT', aliases: ['ETH', 'Ethereum'] },
        { symbol: 'SOL_USDT', aliases: ['SOL', 'Solana'] },
        { symbol: 'XAU_USDT', aliases: ['XAU', 'XAUUSD', 'Gold', 'GOLD'] },
        { symbol: 'XAG_USDT', aliases: ['XAG', 'XAGUSD', 'Silver', 'SILVER'] },
        { symbol: 'EURUSD_USDT', aliases: ['EURUSD', 'EUR/USD'] },
    ];

    public async getCurrentPrice(symbol: string): Promise<number> {
        // 回测子进程：优先使用回放 K 线提供的当前模拟时刻价格；
        // 实盘进程 getBacktestPrice() 恒为 null，走原有实时行情逻辑。
        const backtestPrice = getBacktestPrice(symbol);
        if (backtestPrice !== null) {
            return backtestPrice;
        }

        // Normalize symbol if needed (e.g. BTCUSDT -> BTC_USDT)
        // Parsers usually output standard symbols, but let's be safe
        // Assuming Exchange uses standard symbols.

        // Periodic cache cleanup to prevent memory leaks
        if (++this.priceCacheCallCount % this.PRICE_CACHE_CLEANUP_INTERVAL === 0) {
            const now = Date.now();
            for (const [key, entry] of this.priceCache) {
                if (now - entry.timestamp >= this.CACHE_TTL) {
                    this.priceCache.delete(key);
                }
            }
        }

        const cached = this.priceCache.get(symbol);
        if (cached && Date.now() - cached.timestamp < this.CACHE_TTL) {
            return cached.price;
        }

        try {
            const exchange = exchangeRegistry.getExchange(); // Get default exchange
            if (!exchange) {
                logger.warn('No exchange available to fetch price');
                return 0;
            }

            const ticker = await exchange.getTicker(symbol);
            const price = parseFloat(ticker.lastPrice);
            
            if (!isNaN(price) && price > 0) {
                this.priceCache.set(symbol, { price, timestamp: Date.now() });
                return price;
            }
        } catch (error) {
            logger.warn(`Failed to fetch current price for ${symbol}`, { error });
        }
        
        return 0;
    }

    public async getCommonMarketPricesXml(): Promise<string> {
        const now = Date.now();
        if (this.commonPricesCache && now - this.commonPricesCache.timestamp < this.COMMON_PRICES_CACHE_TTL) {
            return this.commonPricesCache.xml;
        }

        const fetchedAt = new Date(now).toISOString();
        const cachedUntil = new Date(now + this.COMMON_PRICES_CACHE_TTL).toISOString();
        const lines: string[] = [];

        for (const market of this.COMMON_MARKETS) {
            const price = await this.getCurrentPriceIgnoringShortCache(market.symbol);
            if (price <= 0) {
                lines.push(`  <market symbol="${market.symbol}" aliases="${this.escapeXml(market.aliases.join(', '))}" price="unavailable" />`);
                continue;
            }
            lines.push(`  <market symbol="${market.symbol}" aliases="${this.escapeXml(market.aliases.join(', '))}" price="${price}" />`);
        }

        const xml = [
            `<market_prices fetched_at="${fetchedAt}" cached_until="${cachedUntil}">`,
            ...lines,
            '</market_prices>',
        ].join('\n');

        this.commonPricesCache = { xml, timestamp: now };
        return xml;
    }

    public async getCandles(params: {
        exchangeInstanceId?: any;
        symbol?: any;
        interval?: any;
        limit?: any;
    }): Promise<any> {
        const { symbol, interval, limit, exchangeInstanceId } = params;

        const instances = await ExchangeInstance.findAll({ where: { status: 'active' } });

        if (exchangeInstanceId && instances.find(i => i.id === exchangeInstanceId)) {
            exchangeRegistry.getExchange(exchangeInstanceId as string);
        } else if (instances.length > 0) {
            exchangeRegistry.getExchange();
        } else {
            const error: any = new Error('No active exchange instances found');
            error.status = 400;
            throw error;
        }

        const baseUrl = config.external.urls.gateApiBase;
        const url = `${baseUrl}/futures/usdt/candlesticks`;
        const response = await axios.get(url, {
            params: {
                contract: symbol,
                interval: interval || '1h',
                limit: parseInt(limit as string) || 100
            }
        });

        return response.data;
    }

    private async getCurrentPriceIgnoringShortCache(symbol: string): Promise<number> {
        try {
            const exchange = exchangeRegistry.getExchange();
            if (!exchange) {
                logger.warn('No exchange available to fetch common market price');
                return 0;
            }

            const ticker = await exchange.getTicker(symbol);
            const price = parseFloat(ticker.lastPrice);
            if (Number.isFinite(price) && price > 0) {
                this.priceCache.set(symbol, { price, timestamp: Date.now() });
                return price;
            }
        } catch (error: any) {
            const { message, response, config } = error || {};
            logger.warn(`Failed to fetch common market price for ${symbol}`, {
                message,
                status: response?.status,
                statusText: response?.statusText,
                data: response?.data,
                url: config?.url,
                method: config?.method,
            });
        }

        return 0;
    }

    private escapeXml(value: string): string {
        return value
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }
}

export default new MarketService();
