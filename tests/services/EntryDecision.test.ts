import {
  isMarketEntryPrice,
  selectEntryDecisionPrice,
} from '../../src/services/EntryDecision';

describe('selectEntryDecisionPrice', () => {
  it('prefers the receipt-time snapshot over the live price', () => {
    expect(selectEntryDecisionPrice(78_234.8, 78_267.3)).toEqual({
      price: 78_267.3,
      source: 'snapshot',
    });
  });

  it('falls back to the live price when the snapshot is missing or invalid', () => {
    expect(selectEntryDecisionPrice(78_234.8, null)).toEqual({ price: 78_234.8, source: 'live' });
    expect(selectEntryDecisionPrice(78_234.8, 0)).toEqual({ price: 78_234.8, source: 'live' });
    expect(selectEntryDecisionPrice(78_234.8, Number.NaN)).toEqual({ price: 78_234.8, source: 'live' });
  });
});

describe('isMarketEntryPrice', () => {
  const R = 433.3;
  const tolerance = R * 0.1; // widened route tolerance

  it('uses the snapshot price to keep the 08:09 short inside tolerance', () => {
    // Chart entry 78,295.967, receipt snapshot 78,267.3 -> 0.066R -> market.
    expect(isMarketEntryPrice({
      side: 'sell',
      currentPrice: 78_267.3,
      entryPrice: 78_295.967,
      tolerance,
    })).toBe(true);
  });

  it('would have kept a limit with the live execution price', () => {
    // Live at execution 78,234.8 -> 0.141R -> outside the widened 0.1R.
    expect(isMarketEntryPrice({
      side: 'sell',
      currentPrice: 78_234.8,
      entryPrice: 78_295.967,
      tolerance,
    })).toBe(false);
  });

  it('markets a short when price is at or through the entry', () => {
    expect(isMarketEntryPrice({
      side: 'sell',
      currentPrice: 78_320,
      entryPrice: 78_295.967,
      tolerance,
    })).toBe(true);
  });

  it('mirrors the behaviour for longs', () => {
    expect(isMarketEntryPrice({
      side: 'buy',
      currentPrice: 78_330,
      entryPrice: 78_300,
      tolerance: 43.33,
    })).toBe(true);
    expect(isMarketEntryPrice({
      side: 'buy',
      currentPrice: 78_360,
      entryPrice: 78_300,
      tolerance: 43.33,
    })).toBe(false);
  });

  it('markets a long when price is at or through the entry', () => {
    expect(isMarketEntryPrice({
      side: 'buy',
      currentPrice: 78_250,
      entryPrice: 78_300,
      tolerance,
    })).toBe(true);
  });
});
