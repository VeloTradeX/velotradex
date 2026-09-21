import { MarketInfo } from '../IExchange';
import { LighterMarketConfig } from './types';

interface LighterMarketMapConfig {
  markets: LighterMarketConfig[];
}

export class LighterMarketMap {
  private readonly marketsBySymbol: Map<string, LighterMarketConfig>;

  constructor(config: LighterMarketMapConfig) {
    this.marketsBySymbol = new Map(config.markets.map((market) => [market.symbol, market]));
  }

  resolve(symbol: string): LighterMarketConfig {
    const market = this.marketsBySymbol.get(symbol);
    if (market) return market;

    // Try USDT/USDC quote currency alias
    const alt = symbol.replace(/(USDT|USDC)$/, m => m === 'USDT' ? 'USDC' : 'USDT');
    const altMarket = this.marketsBySymbol.get(alt);
    if (altMarket) return altMarket;

    throw new Error(`Unsupported Lighter symbol: ${symbol}`);
  }

  toIntegerPrice(symbol: string, price: string | number): string {
    const market = this.resolve(symbol);
    return toScaledIntegerString(price, market.priceDecimals, 'price');
  }

  toIntegerSize(symbol: string, amount: string | number): string {
    const market = this.resolve(symbol);

    assertDecimalString(amount, 'amount');
    const amountString = amount as string;
    assertDecimalString(market.minBaseAmount, 'minBaseAmount');

    if (compareDecimalStrings(amountString, market.minBaseAmount) < 0) {
      throw new Error(`Lighter amount ${amount} below minBaseAmount ${market.minBaseAmount} for ${symbol}`);
    }

    return toScaledIntegerString(amountString, market.sizeDecimals, 'amount');
  }

  fromIntegerPrice(symbol: string, integerPrice: string | number | bigint): string {
    const market = this.resolve(symbol);
    return fromScaledIntegerString(integerPrice, market.priceDecimals);
  }

  fromIntegerSize(symbol: string, integerSize: string | number | bigint): string {
    const market = this.resolve(symbol);
    return fromScaledIntegerString(integerSize, market.sizeDecimals);
  }

  async getMarkets(): Promise<MarketInfo[]> {
    return Array.from(this.marketsBySymbol.values()).map((market) => ({
      symbol: market.symbol,
      baseCurrency: market.baseCurrency,
      quoteCurrency: market.quoteCurrency,
      minSize: market.minBaseAmount,
      pricePrecision: market.priceDecimals,
      amountPrecision: market.sizeDecimals,
      multiplier: market.multiplier ?? '1',
      tickSize: market.tickSize,
      leverageMin: market.leverageMin ?? '1',
      leverageMax: market.leverageMax ?? '50',
    }));
  }
}

function toScaledIntegerString(value: string | number, decimals: number, field: string): string {
  validateDecimals(decimals);
  const { whole, fraction } = assertDecimalString(value, field);
  if (fraction.length > decimals) {
    throw new Error(`Invalid Lighter ${field}: ${value} has more than ${decimals} decimals`);
  }

  const scaled = `${whole}${fraction.padEnd(decimals, '0')}`.replace(/^0+(?=\d)/, '');
  return scaled || '0';
}

function fromScaledIntegerString(value: string | number | bigint, decimals: number): string {
  validateDecimals(decimals);

  const raw = String(value);
  if (!/^\d+$/.test(raw)) {
    throw new Error(`Invalid Lighter integer value: ${value}`);
  }

  if (decimals === 0) {
    return raw;
  }

  const padded = raw.padStart(decimals + 1, '0');
  const whole = padded.slice(0, -decimals);
  const fraction = padded.slice(-decimals).replace(/0+$/, '');

  return fraction ? `${whole}.${fraction}` : whole;
}

function validateDecimals(decimals: number): void {
  if (!Number.isInteger(decimals) || decimals < 0) {
    throw new Error(`Invalid Lighter decimals: ${decimals}`);
  }
}

function assertDecimalString(value: string | number, field: string): { whole: string; fraction: string } {
  if (typeof value !== 'string') {
    throw new Error(`Invalid Lighter ${field}: value must be a decimal string`);
  }

  if (!/^\d+(\.\d+)?$/.test(value)) {
    throw new Error(`Invalid Lighter ${field}: ${value}`);
  }

  const [whole, fraction = ''] = value.split('.');
  const normalized = `${whole}${fraction}`.replace(/^0+/, '');
  if (normalized === '') {
    throw new Error(`Invalid Lighter ${field}: ${value}`);
  }

  return { whole, fraction };
}

function compareDecimalStrings(left: string, right: string): -1 | 0 | 1 {
  const leftParts = assertDecimalString(left, 'amount');
  const rightParts = assertDecimalString(right, 'minBaseAmount');
  const scale = Math.max(leftParts.fraction.length, rightParts.fraction.length);
  const leftInteger = decimalPartsToScaledBigInt(leftParts, scale);
  const rightInteger = decimalPartsToScaledBigInt(rightParts, scale);

  if (leftInteger < rightInteger) {
    return -1;
  }
  if (leftInteger > rightInteger) {
    return 1;
  }
  return 0;
}

function decimalPartsToScaledBigInt(parts: { whole: string; fraction: string }, scale: number): bigint {
  const scaled = `${parts.whole}${parts.fraction.padEnd(scale, '0')}`.replace(/^0+(?=\d)/, '');
  return BigInt(scaled);
}
