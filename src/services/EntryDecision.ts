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

export type EntryDecisionReason = 'passed_entry' | 'within_tolerance' | 'outside_tolerance';

export interface EntryDecisionResult {
  isMarket: boolean;
  /**
   * passed_entry      价格已经穿过入场价（原限价单本应成交）
   * within_tolerance  尚未穿过，但偏离 ≤ tolerance（追单）
   * outside_tolerance 尚未穿过且偏离 > tolerance（继续挂限价）
   */
  reason: EntryDecisionReason;
  /** |currentPrice - entryPrice|；输入无效时返回 NaN。 */
  deviation: number;
}

export function classifyEntryDecision(input: MarketEntryCheck): EntryDecisionResult {
  const { side, currentPrice, entryPrice } = input;
  const tolerance = Math.max(0, Number(input.tolerance) || 0);
  if (!Number.isFinite(currentPrice) || !Number.isFinite(entryPrice)) {
    return { isMarket: false, reason: 'outside_tolerance', deviation: Number.NaN };
  }

  if (side === 'buy') {
    if (currentPrice <= entryPrice) {
      return { isMarket: true, reason: 'passed_entry', deviation: entryPrice - currentPrice };
    }
    const deviation = currentPrice - entryPrice;
    return deviation <= tolerance
      ? { isMarket: true, reason: 'within_tolerance', deviation }
      : { isMarket: false, reason: 'outside_tolerance', deviation };
  }

  if (currentPrice >= entryPrice) {
    return { isMarket: true, reason: 'passed_entry', deviation: currentPrice - entryPrice };
  }
  const deviation = entryPrice - currentPrice;
  return deviation <= tolerance
    ? { isMarket: true, reason: 'within_tolerance', deviation }
    : { isMarket: false, reason: 'outside_tolerance', deviation };
}

/**
 * Market when the price is already at/through the entry, or within tolerance of
 * it; otherwise keep a limit at the signal entry.
 */
export function isMarketEntryPrice(input: MarketEntryCheck): boolean {
  return classifyEntryDecision(input).isMarket;
}

export interface ChaseReanchorInput {
  side: 'buy' | 'sell';
  /** 市价单实际执行价（下单前的 live 价） */
  executionEntryPrice: number;
  stopLoss: number;
  /** 第一止盈价（绝对价，保持信号原值） */
  target?: number | null;
  /** 追单重锚后要求的最低剩余盈亏比；null/undefined = 不校验 */
  minEntryRR?: number | null;
}

export interface ChaseReanchorResult {
  entryPrice: number;
  /** 以实际执行价重算的 R */
  R: number;
  /** |target - entry| / R（无有效 target 时为 null） */
  rewardRisk: number | null;
  /** 非空表示不该追这一单，调用方应拒单 */
  invalidReason?: string;
}

/**
 * 迟到入场重锚：市价追单时，仓位/风险必须按实际执行价计算，而不是信号限价。
 * SL/TP 的绝对价位保持信号原值，因此在执行价变差时 R 会变大、仓位相应缩小，
 * 金额风险仍锚定在配置的风险预算上。
 */
export function planChaseReanchor(input: ChaseReanchorInput): ChaseReanchorResult {
  const { side, executionEntryPrice, stopLoss, target } = input;
  const entryPrice = executionEntryPrice;
  const R = Math.abs(entryPrice - stopLoss);
  const invalid = (invalidReason: string): ChaseReanchorResult => ({
    entryPrice,
    R,
    rewardRisk: null,
    invalidReason,
  });

  if (!Number.isFinite(entryPrice) || entryPrice <= 0) {
    return invalid(`Invalid chase entry price: ${entryPrice}`);
  }
  if (!Number.isFinite(stopLoss) || stopLoss <= 0) {
    return invalid(`Invalid stop loss: ${stopLoss}`);
  }
  if (!Number.isFinite(R) || R <= 0) {
    return invalid(`Invalid R after re-anchor: ${R}`);
  }
  if (side === 'buy' ? stopLoss >= entryPrice : stopLoss <= entryPrice) {
    return invalid(`Stop loss ${stopLoss} is on the wrong side of execution entry ${entryPrice}`);
  }

  let rewardRisk: number | null = null;
  if (typeof target === 'number' && Number.isFinite(target) && target > 0) {
    const reward = side === 'buy' ? target - entryPrice : entryPrice - target;
    if (reward <= 0) {
      return {
        entryPrice,
        R,
        rewardRisk: 0,
        invalidReason: `Target ${target} is on the wrong side of execution entry ${entryPrice}`,
      };
    }
    rewardRisk = reward / R;

    const minEntryRR = input.minEntryRR;
    if (typeof minEntryRR === 'number' && Number.isFinite(minEntryRR) && minEntryRR > 0
      && rewardRisk < minEntryRR) {
      return {
        entryPrice,
        R,
        rewardRisk,
        invalidReason: `Remaining reward/risk ${rewardRisk.toFixed(2)} after chasing is below minEntryRR ${minEntryRR}`,
      };
    }
  }

  return { entryPrice, R, rewardRisk };
}
