// src/services/OpenPriceAdjustment.ts
// 开仓价格调整（纯函数）：两套互斥体系由 riskConfig.paddingMode 切换。
//   'r'（默认）：R 百分比体系（entryPaddingR/tpPaddingR/slPaddingR），与历史行为完全一致；
//   'fixed'：固定金额（美元）体系（entryOffsetFixed 让点 / fixedSlDistance 固定止损距离 /
//            slBackOffsetFixed 止损后移），此时 R 百分比滑点全部忽略。
import { StrategyRiskConfig } from './parsers/types';

export interface OpenPriceAdjustmentInput {
    side: 'buy' | 'sell';
    entryPrice: number;
    stopLoss: number;
    takeProfit?: number;
    /** R = |原始入场价 - 原始止损价|（信号风险单位，调整前计算） */
    R: number;
    /** 当前市场价，用于固定体系下"止损立即触发"校验；缺省则跳过该校验 */
    currentPrice?: number;
    riskConfig: StrategyRiskConfig;
    /** R 百分比体系的默认滑点（config.trading.execution.defaultPaddingR） */
    defaults: { entry: number; tp: number; sl: number };
}

export interface OpenPriceAdjustmentResult {
    entryPrice: number;
    stopLoss: number;
    takeProfit?: number;
    mode: 'r' | 'fixed';
    /** 非空表示调整结果非法（如止损穿越入场价/当前价），调用方应拒单 */
    invalidReason?: string;
    /** 实际生效的参数快照（日志/审计用） */
    applied: {
        entryPaddingR?: number;
        tpPaddingR?: number;
        slPaddingR?: number;
        entryOffsetFixed?: number;
        fixedSlDistance?: number;
        slBackOffsetFixed?: number;
    };
}

function toPositiveFinite(value: unknown): number | undefined {
    const num = typeof value === 'number' ? value : Number(value);
    if (Number.isFinite(num) && num > 0) return num;
    return undefined;
}

export function applyOpenPriceAdjustments(input: OpenPriceAdjustmentInput): OpenPriceAdjustmentResult {
    const isLong = input.side === 'buy';
    const mode: 'r' | 'fixed' = input.riskConfig.paddingMode === 'fixed' ? 'fixed' : 'r';
    let entryPrice = input.entryPrice;
    let stopLoss = input.stopLoss;
    let takeProfit = input.takeProfit;
    const applied: OpenPriceAdjustmentResult['applied'] = {};

    if (mode === 'r') {
        // ── R 百分比体系（历史行为，逐字节保持一致）──
        const entryPaddingR = input.riskConfig.entryPaddingR ?? input.defaults.entry;
        const tpPaddingR = input.riskConfig.tpPaddingR ?? input.defaults.tp;
        const slPaddingR = input.riskConfig.slPaddingR ?? input.defaults.sl;
        applied.entryPaddingR = entryPaddingR;
        applied.tpPaddingR = tpPaddingR;
        applied.slPaddingR = slPaddingR;

        if (isLong) {
            entryPrice += input.R * entryPaddingR;
            stopLoss -= input.R * slPaddingR;
            if (takeProfit !== undefined) takeProfit -= input.R * tpPaddingR;
        } else {
            entryPrice -= input.R * entryPaddingR;
            stopLoss += input.R * slPaddingR;
            if (takeProfit !== undefined) takeProfit += input.R * tpPaddingR;
        }

        return { entryPrice, stopLoss, takeProfit, mode, applied };
    }

    // ── 固定金额（美元）体系 ──
    const entryOffsetFixed = toPositiveFinite(input.riskConfig.entryOffsetFixed);
    const fixedSlDistance = toPositiveFinite(input.riskConfig.fixedSlDistance);
    const slBackOffsetFixed = toPositiveFinite(input.riskConfig.slBackOffsetFixed);

    // 1) 让点提前入场：多头入场价下移（更低价提前成交），空头上移
    if (entryOffsetFixed !== undefined) {
        applied.entryOffsetFixed = entryOffsetFixed;
        entryPrice = isLong ? entryPrice - entryOffsetFixed : entryPrice + entryOffsetFixed;
    }

    // 2) 固定止损距离：以让点后的实际入场价为基准，覆盖信号自带止损
    if (fixedSlDistance !== undefined) {
        applied.fixedSlDistance = fixedSlDistance;
        stopLoss = isLong ? entryPrice - fixedSlDistance : entryPrice + fixedSlDistance;
    }

    // 3) 止损后移：在（固定距离或信号）止损基础上向远离价格方向拖后
    if (slBackOffsetFixed !== undefined) {
        applied.slBackOffsetFixed = slBackOffsetFixed;
        stopLoss = isLong ? stopLoss - slBackOffsetFixed : stopLoss + slBackOffsetFixed;
    }

    // 止盈在固定体系下不做调整（如需固定金额止盈偏移，后续对称扩展即可）

    // 合法性校验：止损不得穿越入场价（让点过大致入场价低于止损等）
    if (Number.isFinite(stopLoss) && stopLoss > 0 && Number.isFinite(entryPrice) && entryPrice > 0) {
        if (isLong ? stopLoss >= entryPrice : stopLoss <= entryPrice) {
            return {
                entryPrice,
                stopLoss,
                takeProfit,
                mode,
                applied,
                invalidReason: `固定金额调整后止损(${stopLoss})穿越入场价(${entryPrice})，${isLong ? '做多' : '做空'}方向非法`,
            };
        }
    }

    // 合法性校验：止损不得穿越当前价（否则成交即触发止损）
    if (
        input.currentPrice !== undefined &&
        Number.isFinite(input.currentPrice) &&
        input.currentPrice > 0 &&
        Number.isFinite(stopLoss) &&
        stopLoss > 0
    ) {
        if (isLong ? stopLoss >= input.currentPrice : stopLoss <= input.currentPrice) {
            return {
                entryPrice,
                stopLoss,
                takeProfit,
                mode,
                applied,
                invalidReason: `固定金额调整后止损(${stopLoss})${isLong ? '不低于' : '不高于'}当前价(${input.currentPrice})，成交即触发止损，拒单`,
            };
        }
    }

    return { entryPrice, stopLoss, takeProfit, mode, applied };
}
