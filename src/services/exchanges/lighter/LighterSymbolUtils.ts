import { LighterMarketConfig } from './types';

export function normalizeMarketAlias(value: string): string {
  return value.trim().toUpperCase().replace(/[-/]/g, '_');
}

export function marketAliases(market: LighterMarketConfig): string[] {
  const aliases = [
    market.symbol,
    `${market.baseCurrency}_${market.quoteCurrency}`,
    `${market.baseCurrency}-${market.quoteCurrency}`,
    `${market.baseCurrency}/${market.quoteCurrency}`,
  ];

  const quoteAliases = new Set([market.quoteCurrency]);
  if (market.quoteCurrency === 'USDC') quoteAliases.add('USDT');
  if (market.quoteCurrency === 'USDT') quoteAliases.add('USDC');

  for (const quote of quoteAliases) {
    aliases.push(
      `${market.baseCurrency}_${quote}`,
      `${market.baseCurrency}-${quote}`,
      `${market.baseCurrency}/${quote}`,
    );
  }

  return aliases;
}

export function symbolFromMarketKey(markets: LighterMarketConfig[], key: string): string {
  const normalizedKey = normalizeMarketAlias(key);
  const market = markets.find(m => {
    if (String(m.marketIndex) === String(key)) return true;
    return marketAliases(m).some(alias => normalizeMarketAlias(alias) === normalizedKey);
  });
  return market?.symbol ?? key;
}
