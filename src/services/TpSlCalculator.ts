// src/services/TpSlCalculator.ts

export interface TpSlInput {
  entryPrice: number;
  stopLoss: number;
  side: 'buy' | 'sell';
  targets: string[];
  tpDistribution?: number[];
  tpPaddingR: number;
  tpOrderType?: 'limit' | 'market';
  fixedRiskRewardClose?: number | null;
}

export interface TpSlResult {
  targets: string[];
  distribution: number[];
  allocated: number[];
  tpOrders: { price: string; amount: string }[];
  effectiveEntryPrice: number;
  R: number;
  isLong: boolean;
}

export class TpSlCalculator {
  /**
   * Main calculation entry point (used by handleOpen and executePostFill).
   * @param input TP/SL input parameters
   * @param totalAmount total position amount to distribute across targets
   * @param amountPrecision decimal precision for amounts
   */
  calculate(input: TpSlInput, totalAmount: number, pricePrecision: number, amountPrecision: number): TpSlResult {
    const isLong = input.side === 'buy';
    const R = Math.abs(input.entryPrice - input.stopLoss);
    let targets = input.targets ? [...input.targets] : [];

    // 1. Insert FixedRR target if configured
    if (input.fixedRiskRewardClose && R > 0) {
      const rrDist = R * input.fixedRiskRewardClose;
      const rrPrice = isLong
        ? input.entryPrice + rrDist
        : input.entryPrice - rrDist;
      targets.push(rrPrice.toString());
    }

    // 2. Fallback if still empty — use 1:1 RR as single target
    if (targets.length === 0) {
      const fallbackTarget = isLong
        ? input.entryPrice + R
        : input.entryPrice - R;
      targets.push(fallbackTarget.toString());
    }

    // 3. Sort targets: Long → ascending, Short → descending
    targets = targets
      .map(t => parseFloat(t))
      .sort((a, b) => isLong ? a - b : b - a)
      .map(t => t.toString());

    // 4. Distribution: equal split if empty or fixedRR set
    let distribution = input.tpDistribution ? [...input.tpDistribution] : [];
    if (distribution.length === 0 || (input.fixedRiskRewardClose !== undefined && input.fixedRiskRewardClose !== null)) {
      distribution = Array(targets.length).fill(1 / targets.length);
    }

    // Normalize distribution to sum to 1.0
    const sum = distribution.reduce((a, b) => a + b, 0);
    if (sum > 0 && Math.abs(sum - 1) > 0.01) {
      distribution = distribution.map(d => d / sum);
    }

    // 5. Check if totalAmount is too small to split across multiple TPs
    // Calculate minimum amount per TP based on precision
    const minAmount = Math.pow(10, -amountPrecision);
    let numTPs = Math.min(targets.length, distribution.length);
    
    // Check if smallest allocation would be below minimum
    if (numTPs > 1) {
      const smallestRatio = Math.min(...distribution.slice(0, numTPs));
      const smallestAllocation = totalAmount * smallestRatio;
      // Only force single TP if allocation is below minimum tradeable amount
      if (smallestAllocation < minAmount) {
        numTPs = 1;
      }
    }

    // 6. Allocate amount by distribution
    const allocated = this.allocateAmountByDistribution(
      totalAmount,
      distribution.slice(0, numTPs),
      amountPrecision
    );

    // 7. Build tpOrders with padding applied to price
    const tpOrders: { price: string; amount: string }[] = [];
    for (let i = 0; i < numTPs; i++) {
      const tpAmount = allocated[i] || 0;
      if (tpAmount <= 0) continue;

      let price = parseFloat(targets[i]);
      // Apply TP padding: for Long subtract R*tpPaddingR, for Short add R*tpPaddingR
      if (R > 0 && input.tpPaddingR > 0) {
        price = isLong ? price - R * input.tpPaddingR : price + R * input.tpPaddingR;
      }

      tpOrders.push({
        price: price.toFixed(pricePrecision),
        amount: tpAmount.toFixed(amountPrecision),
      });
    }

    return {
      targets,
      distribution,
      allocated,
      tpOrders,
      effectiveEntryPrice: input.entryPrice,
      R,
      isLong,
    };
  }

  private allocateAmountByDistribution(
    totalAmount: number,
    distribution: number[],
    precision: number
  ): number[] {
    const totalUnits = Math.round(totalAmount * Math.pow(10, precision));
    if (totalUnits <= 0 || distribution.length === 0) {
      return distribution.map(() => 0);
    }

    const allocatedUnits: number[] = [];
    let remainingUnits = totalUnits;

    for (let i = 0; i < distribution.length; i++) {
      if (i === distribution.length - 1) {
        // Last bucket gets whatever is left
        allocatedUnits.push(remainingUnits / Math.pow(10, precision));
        break;
      }
      const candidateUnits = Math.round(totalUnits * distribution[i]);
      const capped = Math.min(Math.max(0, candidateUnits), remainingUnits);
      allocatedUnits.push(capped / Math.pow(10, precision));
      remainingUnits -= capped;
    }

    return allocatedUnits;
  }
}
