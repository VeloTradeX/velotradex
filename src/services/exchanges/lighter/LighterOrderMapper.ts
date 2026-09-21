import { OrderResult } from '../IExchange';
import { LighterMarketConfig } from './types';
import { normalizeLighterOrders } from './LighterResponseNormalizer';
import { symbolFromMarketKey } from './LighterSymbolUtils';

export function normalizeOrders(raw: unknown, markets: LighterMarketConfig[], fallbackSymbol?: string): OrderResult[] {
  return normalizeLighterOrders(raw, fallbackSymbol).map(order => {
    const rawRow = order.raw && typeof order.raw === 'object'
      ? order.raw as Record<string, unknown>
      : {};
    const marketKey = rawRow.market_id
      ?? rawRow.marketId
      ?? rawRow.market_index
      ?? rawRow.marketIndex
      ?? order.symbol
      ?? rawRow.market
      ?? fallbackSymbol;

    if (marketKey === undefined || marketKey === null || String(marketKey).length === 0) {
      return order;
    }

    return {
      ...order,
      symbol: symbolFromMarketKey(markets, String(marketKey)),
    };
  });
}
