import {
  classifyEntryDecision,
  isMarketEntryPrice,
  planChaseReanchor,
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

describe('classifyEntryDecision', () => {
  // Production case: 2026-11-09 raizexbt short, entry 75,461.118, SL 75,999.882.
  const signalEntry = 75_461.118;
  const receiptPrice = 75_336.1;
  const signalR = Math.abs(75_999.882 - signalEntry);

  it('classifies a chase beyond the configured tolerance as a limit', () => {
    const result = classifyEntryDecision({
      side: 'sell',
      currentPrice: receiptPrice,
      entryPrice: signalEntry,
      tolerance: signalR * 0.1,
    });
    expect(result.isMarket).toBe(false);
    expect(result.reason).toBe('outside_tolerance');
    expect(result.deviation).toBeCloseTo(125.018, 3);
  });

  it('classifies the same chase as within tolerance when the route allows 0.25R', () => {
    const result = classifyEntryDecision({
      side: 'sell',
      currentPrice: receiptPrice,
      entryPrice: signalEntry,
      tolerance: signalR * 0.25,
    });
    expect(result.isMarket).toBe(true);
    expect(result.reason).toBe('within_tolerance');
  });

  it('classifies prices already through the entry as passed_entry', () => {
    const result = classifyEntryDecision({
      side: 'sell',
      currentPrice: 75_500,
      entryPrice: signalEntry,
      tolerance: signalR * 0.1,
    });
    expect(result.isMarket).toBe(true);
    expect(result.reason).toBe('passed_entry');
    expect(result.deviation).toBeCloseTo(38.882, 3);
  });

  it('mirrors tolerance classification for longs', () => {
    expect(classifyEntryDecision({
      side: 'buy',
      currentPrice: 78_330,
      entryPrice: 78_300,
      tolerance: 43.33,
    }).reason).toBe('within_tolerance');
    expect(classifyEntryDecision({
      side: 'buy',
      currentPrice: 78_360,
      entryPrice: 78_300,
      tolerance: 43.33,
    }).reason).toBe('outside_tolerance');
  });
});

describe('planChaseReanchor', () => {
  const stopLoss = 75_999.882;
  const target = 74_224.582;

  it('re-anchors R and sizing to the execution price while keeping absolute SL/TP', () => {
    const plan = planChaseReanchor({
      side: 'sell',
      executionEntryPrice: 75_336.1,
      stopLoss,
      target,
      minEntryRR: 1.2,
    });
    expect(plan.invalidReason).toBeUndefined();
    expect(plan.entryPrice).toBe(75_336.1);
    expect(plan.R).toBeCloseTo(663.782, 3);
    expect(plan.rewardRisk).toBeCloseTo(1.6745, 4);
    // 20 USDT risk budget => 301 contracts instead of 371 at the signal entry.
    expect(Math.floor(20 / (plan.R * 0.0001))).toBe(301);
  });

  it('rejects the chase when the remaining reward/risk is below minEntryRR', () => {
    const plan = planChaseReanchor({
      side: 'sell',
      executionEntryPrice: 75_336.1,
      stopLoss,
      target,
      minEntryRR: 2,
    });
    expect(plan.invalidReason).toContain('minEntryRR');
  });

  it('rejects a stop loss on the wrong side of the execution price', () => {
    const plan = planChaseReanchor({
      side: 'sell',
      executionEntryPrice: 76_100,
      stopLoss,
      target,
    });
    expect(plan.invalidReason).toContain('wrong side');
  });

  it('rejects a target that is already behind the execution price', () => {
    const plan = planChaseReanchor({
      side: 'sell',
      executionEntryPrice: 74_100,
      stopLoss,
      target,
    });
    expect(plan.invalidReason).toContain('wrong side');
  });

  it('mirrors the calculation for longs', () => {
    const plan = planChaseReanchor({
      side: 'buy',
      executionEntryPrice: 78_360,
      stopLoss: 78_300,
      target: 78_500,
      minEntryRR: 1.2,
    });
    expect(plan.R).toBe(60);
    expect(plan.rewardRisk).toBeCloseTo(140 / 60, 6);
    expect(plan.invalidReason).toBeUndefined();
  });
});
