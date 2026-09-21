// src/services/PositionSizer.ts
import { StrategyRiskConfig } from './parsers/types';

export interface PositionSizingInput {
  balance: { total: string; available: string };
  market: { symbol: string; multiplier: string; leverageMax?: string; amountPrecision: number };
  entryPrice: number;
  stopLoss: number;
  riskConfig: StrategyRiskConfig;
  weight?: number;
  averageEntryPrice?: number;
  quantity?: number;
}

/**
 * 风险预算低于品种最小可交易单位时触发的"升格"详情。
 * 场景：不同交易所对同一品种的合约乘数/数量精度不同（如 Lighter XAU multiplier=1、精度4，
 * Gate CFD XAU multiplier=100、精度2），同样的风险预算在高乘数低精度品种上
 * 可能低于最小单位对应的风险敞口。此时不开单会让信号失效，故升格到最小单位执行，
 * 由业务调用方决定是否接受放大后的风险。
 */
export interface UnderfundedInfo {
  /** 设定风险预算（USDT） */
  riskAmount: number;
  /** 升格前的理论合约数 */
  rawContracts: number;
  /** 品种最小可表达单位（张） */
  minUnit: number;
  /** 品种合约乘数 */
  multiplier: number;
  /** 最小单位对应的风险敞口（USDT）= minUnit × multiplier × R */
  minUnitRisk: number;
}

export interface PositionSizingResult {
  contracts: number;
  amount: string;
  riskAmount: number;
  equity: number;
  sizingMode: 'risk_based' | 'size_based' | 'ratio_based'; // ratio_based kept for result reporting only
  /** 实际风险敞口（USDT）= contracts × multiplier × |entry - SL|，用于跨交易所乘数口径的风险核对 */
  actualRisk: number;
  /** 风险预算不足最小可交易单位（contracts 被截断为 0）时的详情 */
  underfunded?: UnderfundedInfo;
}

export class PositionSizer {
  calculate(input: PositionSizingInput): PositionSizingResult {
    const equity = parseFloat(input.balance.total) || 0;
    const adjustedR = Math.abs(input.entryPrice - input.stopLoss);
    const multiplier = parseFloat(input.market.multiplier || '0.0001');
    const riskMode = input.riskConfig.riskMode;
    const sizingMode = input.riskConfig.positionSizingMode || 'risk_based';

    let riskAmount = 0;
    let contracts = 0;
    let underfunded: UnderfundedInfo | undefined;

    if (riskMode === 'ratio_based') {
      // ratio_based: position size comes from signal quantity, riskValue acts as multiplier
      const quantity = input.quantity ?? 1;
      const ratioMultiplier = Math.max(0.01, Math.min(10, input.riskConfig.riskValue || 1));
      contracts = Math.max(1, Math.round(quantity * ratioMultiplier));
    } else {
      if (equity <= 0 || adjustedR <= 0) {
        return { contracts: 0, amount: '0', riskAmount: 0, equity, sizingMode, actualRisk: 0 };
      }

      if (riskMode === 'fixed') {
        riskAmount = input.riskConfig.riskValue;
      } else {
        riskAmount = equity * (input.riskConfig.riskValue / 100);
      }

      if (riskAmount <= 0) {
        return { contracts: 0, amount: '0', riskAmount: 0, equity, sizingMode, actualRisk: 0 };
      }

      const avgEntry = input.averageEntryPrice || input.entryPrice;
      const avgR = Math.abs(avgEntry - input.stopLoss);

      if (sizingMode === 'risk_based') {
        if (adjustedR > 0) {
          let sizeBase = riskAmount / adjustedR;
          if (input.weight && input.weight > 0 && input.weight <= 1) {
            sizeBase = sizeBase * input.weight;
          }
          const rawContracts = sizeBase / multiplier;
          // 保守优先：可表达时向下取整（实际风险不超过预算）；
          // 预算不足最小可交易单位时升格到最小单位执行（允许适当放大风险），保证信号可用
          contracts = this.snapToTradable(rawContracts, input.market.amountPrecision);
          underfunded = this.buildUnderfunded(
            contracts, rawContracts, riskAmount, multiplier, adjustedR, input.market.amountPrecision
          );
        }
      } else {
        // size_based
        if (avgR > 0) {
          let totalSizeCoins = riskAmount / avgR;
          if (input.weight && input.weight > 0 && input.weight <= 1) {
            totalSizeCoins = totalSizeCoins * input.weight;
          }
          const rawContracts = totalSizeCoins / multiplier;
          // 同 risk_based：不足最小单位时升格，避免因乘数口径差异导致无法开单
          contracts = this.snapToTradable(rawContracts, input.market.amountPrecision);
          underfunded = this.buildUnderfunded(
            contracts, rawContracts, riskAmount, multiplier, avgR, input.market.amountPrecision
          );
        }
      }
    }

    // Apply max position cap（向下取整，避免上限被进位突破）
    if (input.riskConfig.maxPositionSize && contracts > 0) {
      const maxContracts = this.floorAmount(
        (input.riskConfig.maxPositionSize / input.entryPrice) / multiplier,
        input.market.amountPrecision
      );
      if (contracts > maxContracts) {
        contracts = maxContracts;
      }
    }

    const actualRisk = contracts > 0 && multiplier > 0 && adjustedR > 0
      ? contracts * multiplier * adjustedR
      : 0;

    return {
      contracts,
      amount: this.formatAmount(contracts, input.market.amountPrecision),
      riskAmount,
      equity,
      sizingMode: riskMode === 'ratio_based' ? 'ratio_based' : sizingMode,
      actualRisk,
      ...(underfunded ? { underfunded } : {}),
    };
  }

  /** 理论仓位大于 0 但被精度截断到最小单位以下时，返回已升格到最小单位的详情 */
  private buildUnderfunded(
    contracts: number,
    rawContracts: number,
    riskAmount: number,
    multiplier: number,
    riskDistance: number,
    precision: number
  ): UnderfundedInfo | undefined {
    if (contracts !== this.minUnit(precision) || rawContracts <= 0) return undefined;
    const minUnit = this.minUnit(precision);
    if (rawContracts >= minUnit) return undefined;
    return {
      riskAmount,
      rawContracts,
      minUnit,
      multiplier,
      minUnitRisk: minUnit * multiplier * riskDistance,
    };
  }

  private minUnit(precision: number): number {
    if (!Number.isInteger(precision) || precision <= 0) return 1;
    return 1 / (10 ** precision);
  }

  /**
   * 保守取整 + 不足升格：可表达时向下取整（实际风险不超预算），
   * 低于最小可交易单位时升格到最小单位执行（允许适当放大风险），
   * 避免因交易所乘数差异导致信号无法执行。
   */
  private snapToTradable(value: number, precision: number): number {
    if (!Number.isFinite(value) || value <= 0) return 0;
    const floored = this.floorAmount(value, precision);
    if (floored > 0) return floored;
    // 浮点值 > 0 但 floor 不到最小单位 → 升格到最小单位
    return this.minUnit(precision);
  }

  /**
   * 向下取整（保守取整）：带相对浮点容差，吸收连续除法误差
   * （如 20 / 0.0001 = 199999.99999999997，直接 floor 会少 1 个最小单位）。
   * 容差取 1e-12 相对量级：足以覆盖浮点误差（~1e-16），
   * 又远小于放大后的 1 个最小单位，不会反向进位。
   */
  private floorAmount(value: number, precision: number): number {
    if (!Number.isFinite(value) || value <= 0) return 0;
    if (!Number.isInteger(precision) || precision <= 0) return Math.floor(value + 1e-9);
    const factor = 10 ** precision;
    const scaled = value * factor;
    const tolerated = scaled + Math.abs(scaled) * 1e-12 + 1e-12;
    return Math.floor(tolerated) / factor;
  }

  private formatAmount(value: number, precision: number): string {
    if (!Number.isInteger(precision) || precision <= 0) return Math.round(value).toString();
    return value.toFixed(precision).replace(/\.?0+$/, '');
  }
}
