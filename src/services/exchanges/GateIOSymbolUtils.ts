import fs from 'fs';
import path from 'path';
import logger from '../../utils/logger';
import { MarketInfo } from './IExchange';

export function mapContractToMarketInfo(m: any): MarketInfo {
    return {
        symbol: m.name,
        baseCurrency: m.name.split('_')[0],
        quoteCurrency: 'USDT',
        minSize: '1',
        tickSize: m.orderPriceRound,
        pricePrecision: m.orderPriceRound ? (m.orderPriceRound.includes('.') ? m.orderPriceRound.split('.')[1].length : 0) : 2,
        amountPrecision: 0,
        multiplier: String(m.quantoMultiplier),
        leverageMin: String(m.leverageMin),
        leverageMax: String(m.leverageMax)
    };
}

export function loadMarketsFromDict(): MarketInfo[] {
    const dictPath = path.join(process.cwd(), 'dict', 'gate_contracts.json');
    try {
        const raw = fs.readFileSync(dictPath, 'utf8');
        const contracts = JSON.parse(raw);
        if (!Array.isArray(contracts)) throw new Error('Gate contract dictionary must be an array');

        const markets = contracts
            .filter((c: any) => {
                const name = typeof c?.name === 'string' ? c.name : '';
                return name.endsWith('_USDT') && !c?.in_delisting;
            })
            .map((c: any) => {
                const symbol = c.name;
                const tickSize = String(c.order_price_round || c.mark_price_round || '0.01');
                const pricePrecision = tickSize.includes('.')
                    ? tickSize.split('.')[1].length
                    : 0;
                return {
                    symbol,
                    baseCurrency: symbol.split('_')[0],
                    quoteCurrency: 'USDT',
                    minSize: '1',
                    tickSize,
                    pricePrecision,
                    amountPrecision: 0,
                    multiplier: String(c.quanto_multiplier || '1'),
                    leverageMin: c.leverage_min ? String(c.leverage_min) : '1',
                    leverageMax: c.leverage_max ? String(c.leverage_max) : '100',
                } as MarketInfo;
            });

        if (markets.length > 0) {
            logger.info(`Loaded ${markets.length} markets from dict file`);
            return markets;
        }
    } catch (err) {
        logger.warn('Failed to load markets from dict file', { error: err });
    }
    return [];
}

export function toGateCandleInterval(timeframe: string): string {
    const normalized = String(timeframe || '').toLowerCase();
    if (normalized === '15m') return '15m';
    if (normalized === '1h') return '1h';
    if (normalized === '4h') return '4h';
    if (normalized === '12h') return '12h';
    if (normalized === '1d') return '1d';
    throw new Error(`Unsupported candle timeframe: ${timeframe}`);
}
