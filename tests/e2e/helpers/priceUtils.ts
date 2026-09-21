// Constants
export const SYMBOL = 'XRP_USDT';
export const LEVERAGE = '10';
export const SL_DISTANCE = 0.003;    // 0.3%
export const TP_DISTANCE = 0.003;    // 0.3%
export const LIMIT_OFFSET = 0.0005;   // ±0.05% — tight offset for reliable E2E fills
export const PRICE_PRECISION = 4;     // XRP_USDT has 4 decimal places on Gate.io

// Additional constants needed by test suite:
export const MARKET_FILL_TIMEOUT_MS = 30_000;
export const LIMIT_FILL_TIMEOUT_MS = 60_000;
export const TP_SL_TRIGGER_TIMEOUT_MS = 120_000;
export const POLL_INTERVAL_MS = 2_000;
export const MAX_RETRIES = 5;

// Helpers
export function toExchangePrice(price: number, precision = PRICE_PRECISION): string {
  const factor = Math.pow(10, precision);
  const rounded = Math.round(price * factor) / factor;
  return rounded.toFixed(precision);
}

export function calcTpSlForLong(entryPrice: number): { slPrice: string; tpPrice: string } {
  const slPrice = entryPrice * (1 - SL_DISTANCE);
  const tpPrice = entryPrice * (1 + TP_DISTANCE);
  return {
    slPrice: toExchangePrice(slPrice),
    tpPrice: toExchangePrice(tpPrice),
  };
}

export function calcTpSlForShort(entryPrice: number): { slPrice: string; tpPrice: string } {
  const slPrice = entryPrice * (1 + SL_DISTANCE);
  const tpPrice = entryPrice * (1 - TP_DISTANCE);
  return {
    slPrice: toExchangePrice(slPrice),
    tpPrice: toExchangePrice(tpPrice),
  };
}

export function calcLimitPrices(currentPrice: number): { bid: string; ask: string } {
  const bid = currentPrice * (1 - LIMIT_OFFSET);
  const ask = currentPrice * (1 + LIMIT_OFFSET);
  return {
    bid: toExchangePrice(bid),
    ask: toExchangePrice(ask),
  };
}

export async function waitFor(
  condition: () => Promise<boolean>,
  timeoutMs: number,
  intervalMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return false;
}

export function makeOrderText(runIndex: number): string {
  return `t-e2e-${runIndex}-${Date.now()}`;
}
