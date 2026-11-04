/**
 * Pure helpers for the open-position entry decision.
 *
 * The decision uses the receipt-time snapshot price when available (captured
 * before image/LLM parsing), otherwise the live ticker. Keeping this pure makes
 * the market-vs-limit behaviour testable without an exchange.
 */

export interface DecisionPrice {
  price: number;
  source: 'snapshot' | 'live';
}

export function selectEntryDecisionPrice(
  livePrice: number,
  snapshotPrice?: number | null,
): DecisionPrice {
  if (typeof snapshotPrice === 'number' && Number.isFinite(snapshotPrice) && snapshotPrice > 0) {
    return { price: snapshotPrice, source: 'snapshot' };
  }
  return { price: livePrice, source: 'live' };
}

export interface MarketEntryCheck {
  side: 'buy' | 'sell';
  /** Price used for the decision (usually the snapshot, else live). */
  currentPrice: number;
  entryPrice: number;
  /** Absolute price tolerance (R * priceTolerance). */
  tolerance: number;
}

/**
 * Market when the price is already at/through the entry, or within tolerance of
 * it; otherwise keep a limit at the signal entry.
 */
export function isMarketEntryPrice(input: MarketEntryCheck): boolean {
  const { side, currentPrice, entryPrice } = input;
  const tolerance = Math.max(0, Number(input.tolerance) || 0);
  if (!Number.isFinite(currentPrice) || !Number.isFinite(entryPrice)) return false;

  if (side === 'buy') {
    if (currentPrice <= entryPrice) return true;
    return currentPrice - entryPrice <= tolerance;
  }

  if (currentPrice >= entryPrice) return true;
  return entryPrice - currentPrice <= tolerance;
}
