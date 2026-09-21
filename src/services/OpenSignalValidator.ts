import { ParsedStrategy, StrategyRiskConfig } from './parsers/types';
import { parseFinitePositiveNumber, isCmpEntryPrice, formatExecutionNumber } from './TradeMath';
import logger from '../utils/logger';

const DISPLAY_PRICE_SCALE_FACTORS = [100, 1000, 10000, 1000000];

export function detectDisplayPriceScaleFactor(entryPrice: number, currentPrice: number): number | null {
    if (!Number.isFinite(entryPrice) || entryPrice <= 0 || !Number.isFinite(currentPrice) || currentPrice <= 0) {
        return null;
    }
    const ratio = entryPrice / currentPrice;
    for (const factor of DISPLAY_PRICE_SCALE_FACTORS) {
        const deviation = Math.abs(ratio - factor) / factor;
        if (deviation <= 0.2) {
            return factor;
        }
    }
    return null;
}

export function normalizeDisplayPrice(value: any, scaleFactor: number): string | undefined {
    const price = parseFinitePositiveNumber(value);
    if (price === null) return undefined;
    return formatExecutionNumber(price / scaleFactor);
}

export function normalizeDisplayPriceScale(params: {
    parsed: ParsedStrategy;
    signal: {
        entryPrice: number;
        stopLoss: number;
    };
    currentPrice: number;
}): { parsed: ParsedStrategy; scaleFactor: number } | null {
    const scaleFactor = detectDisplayPriceScaleFactor(params.signal.entryPrice, params.currentPrice);
    if (!scaleFactor) return null;

    const normalizedEntryPrice = normalizeDisplayPrice(params.parsed.entryPrice, scaleFactor);
    const normalizedStopLoss = normalizeDisplayPrice(params.parsed.stopLoss, scaleFactor);
    if (!normalizedEntryPrice || !normalizedStopLoss) return null;

    const normalizedTargets = Array.isArray(params.parsed.targets)
        ? params.parsed.targets.map((target) => normalizeDisplayPrice(target, scaleFactor) || target)
        : params.parsed.targets;
    const normalizedAverageEntryPrice =
        typeof params.parsed.averageEntryPrice === 'number' && Number.isFinite(params.parsed.averageEntryPrice) && params.parsed.averageEntryPrice > 0
            ? params.parsed.averageEntryPrice / scaleFactor
            : params.parsed.averageEntryPrice;

    return {
        scaleFactor,
        parsed: {
            ...params.parsed,
            entryPrice: normalizedEntryPrice,
            stopLoss: normalizedStopLoss,
            targets: normalizedTargets,
            averageEntryPrice: normalizedAverageEntryPrice,
        },
    };
}

export function computeNeilHardStopFromSoftStop(
    side: 'buy' | 'sell',
    entryPrice: number,
    softStop: number,
    multiplier: number
): number | null {
    const r = side === 'buy' ? entryPrice - softStop : softStop - entryPrice;
    if (!Number.isFinite(r) || r <= 0 || !Number.isFinite(multiplier) || multiplier <= 0) return null;
    return side === 'buy' ? entryPrice - multiplier * r : entryPrice + multiplier * r;
}

export function computeFallbackTargetFromHardStop(
    side: 'buy' | 'sell',
    entryPrice: number,
    hardStop: number,
    rMultiple: number
): string {
    const r = Math.abs(entryPrice - hardStop);
    const target = side === 'buy' ? entryPrice + r * rMultiple : entryPrice - r * rMultiple;
    return formatExecutionNumber(target);
}

export function buildCmpResolvedOpenStrategy(parsed: ParsedStrategy, currentPrice: number): ParsedStrategy | null {
    if (!isCmpEntryPrice(parsed.entryPrice)) return parsed;
    if (parsed.side !== 'buy' && parsed.side !== 'sell') return null;

    const hasNeil = !!(parsed.raw as any)?.neil;

    if (hasNeil) {
        const softStop = parseFinitePositiveNumber((parsed.raw as any)?.neil?.softStop?.price ?? parsed.stopLoss);
        if (softStop === null) return null;

        const multiplier = parseFinitePositiveNumber((parsed.raw as any)?.neil?.hardStopRMultiplier) || 2;
        const hardStop = computeNeilHardStopFromSoftStop(parsed.side, currentPrice, softStop, multiplier);
        if (hardStop === null) return null;

        const neilRaw = {
            ...((parsed.raw as any)?.neil || {}),
            cmpEntry: true,
            cmpResolvedEntryPrice: currentPrice,
            hardStopLoss: Number(formatExecutionNumber(hardStop)),
        };
        const fallbackFullTp = (parsed.raw as any)?.neil?.fallbackFullTp;
        const targets = parsed.targets && parsed.targets.length > 0
            ? parsed.targets
            : fallbackFullTp?.enabled
                ? [computeFallbackTargetFromHardStop(parsed.side, currentPrice, hardStop, fallbackFullTp.rMultiple || 1.1)]
                : parsed.targets;

        return {
            ...parsed,
            entryPrice: formatExecutionNumber(currentPrice),
            stopLoss: formatExecutionNumber(hardStop),
            targets,
            orderType: 'market',
            raw: {
                ...(parsed.raw || {}),
                neil: {
                    ...neilRaw,
                    ...(targets && targets.length > 0 && fallbackFullTp?.enabled
                        ? { fallbackFullTp: { ...fallbackFullTp, resolvedTarget: targets[0] } }
                        : {}),
                },
            },
        };
    }

    return {
        ...parsed,
        entryPrice: formatExecutionNumber(currentPrice),
        orderType: 'market',
    };
}

export async function rejectOpenStrategy(
    auditService: any,
    strategyId: number | undefined,
    exchangeInstanceId: string | undefined,
    details: {
        symbol: any;
        side: any;
        entryPrice: any;
        stopLoss: any;
        currentPrice: any;
        field: string;
        reason: string;
    }
): Promise<never> {
    if (strategyId) {
        await auditService.log(
            strategyId,
            'STRATEGY_REJECTED',
            details,
            undefined,
            undefined,
            exchangeInstanceId
        );
    }
    logger.warn('TradeExecutor: open strategy rejected', {
        field: details.field,
        reason: details.reason,
        symbol: details.symbol,
        side: details.side,
    });
    throw new Error(details.reason);
}

export async function validateOpenSignal(
    auditService: any,
    signal: {
        symbol: string;
        side: 'buy' | 'sell';
        entryPrice: number;
        stopLoss: number;
        isLong: boolean;
    },
    ticker: any,
    markets: any[],
    strategyId?: number,
    exchangeInstanceId?: string,
    riskConfig?: StrategyRiskConfig
): Promise<{
    marketInfo: any;
    currentPrice: number;
}> {
    const { symbol, side, entryPrice, stopLoss, isLong } = signal;
    const currentPrice = parseFinitePositiveNumber(ticker?.lastPrice);

    const marketInfo = markets.find(m => m.symbol === symbol);
    if (!marketInfo) {
        await rejectOpenStrategy(auditService, strategyId, exchangeInstanceId, {
            symbol,
            side,
            entryPrice,
            stopLoss,
            currentPrice,
            field: 'symbol',
            reason: `Unsupported open strategy symbol: ${symbol}`,
        });
        throw new Error('Unreachable');
    }

    if (currentPrice === null) {
        await rejectOpenStrategy(auditService, strategyId, exchangeInstanceId, {
            symbol,
            side,
            entryPrice,
            stopLoss,
            currentPrice,
            field: 'currentPrice',
            reason: 'Invalid open strategy currentPrice',
        });
        throw new Error('Unreachable');
    }

    if (riskConfig?.riskMode !== 'ratio_based') {
        if (isLong) {
            if (!(stopLoss < currentPrice)) {
                await rejectOpenStrategy(auditService, strategyId, exchangeInstanceId, {
                    symbol,
                    side,
                    entryPrice,
                    stopLoss,
                    currentPrice,
                    field: 'stopLoss',
                    reason: `Invalid Long Strategy: SL (${stopLoss}) >= Current Price (${currentPrice}). Rejecting to avoid immediate trigger.`,
                });
            }
        } else {
            if (!(stopLoss > currentPrice)) {
                await rejectOpenStrategy(auditService, strategyId, exchangeInstanceId, {
                    symbol,
                    side,
                    entryPrice,
                    stopLoss,
                    currentPrice,
                    field: 'stopLoss',
                    reason: `Invalid Short Strategy: SL (${stopLoss}) <= Current Price (${currentPrice}). Rejecting to avoid immediate trigger.`,
                });
            }
        }
    }

    return {
        marketInfo,
        currentPrice: currentPrice,
    };
}

export async function validateStaticOpenSignal(
    auditService: any,
    parsed: ParsedStrategy,
    strategyId?: number,
    exchangeInstanceId?: string,
    riskConfig?: StrategyRiskConfig
): Promise<{
    symbol: string;
    side: 'buy' | 'sell';
    entryPrice: number;
    stopLoss: number;
    isLong: boolean;
    R: number;
}> {
    const symbol = typeof parsed.symbol === 'string' ? parsed.symbol.trim() : '';
    const side = parsed.side;
    const entryPrice = parseFinitePositiveNumber(parsed.entryPrice);
    const stopLoss = parseFinitePositiveNumber(parsed.stopLoss);

    if (!symbol) {
        await rejectOpenStrategy(auditService, strategyId, exchangeInstanceId, {
            symbol,
            side,
            entryPrice: parsed.entryPrice,
            stopLoss: parsed.stopLoss,
            currentPrice: null,
            field: 'symbol',
            reason: 'Invalid open strategy symbol',
        });
    }

    if (side !== 'buy' && side !== 'sell') {
        await rejectOpenStrategy(auditService, strategyId, exchangeInstanceId, {
            symbol,
            side,
            entryPrice: parsed.entryPrice,
            stopLoss: parsed.stopLoss,
            currentPrice: null,
            field: 'side',
            reason: 'Invalid open strategy side',
        });
    }

    if (entryPrice === null) {
        await rejectOpenStrategy(auditService, strategyId, exchangeInstanceId, {
            symbol,
            side,
            entryPrice: parsed.entryPrice,
            stopLoss: parsed.stopLoss,
            currentPrice: null,
            field: 'entryPrice',
            reason: 'Invalid open strategy entryPrice',
        });
    }

    if (stopLoss === null && riskConfig?.riskMode !== 'ratio_based') {
        await rejectOpenStrategy(auditService, strategyId, exchangeInstanceId, {
            symbol,
            side,
            entryPrice: parsed.entryPrice,
            stopLoss: parsed.stopLoss,
            currentPrice: null,
            field: 'stopLoss',
            reason: 'Invalid open strategy stopLoss',
        });
    }

    const safeSide = side as 'buy' | 'sell';
    const safeEntryPrice = entryPrice as number;
    const safeStopLoss = stopLoss ?? 0;
    const R = Math.abs(safeEntryPrice - safeStopLoss);
    if (!Number.isFinite(R) || R <= 0) {
        if (riskConfig?.riskMode === 'ratio_based') {
            // In ratio_based mode, stopLoss may be null/0 — skip R validation
        } else {
            await rejectOpenStrategy(auditService, strategyId, exchangeInstanceId, {
                symbol,
                side: safeSide,
                entryPrice: parsed.entryPrice,
                stopLoss: parsed.stopLoss,
                currentPrice: null,
                field: 'R',
                reason: 'Invalid open strategy R',
            });
        }
    }

    return {
        symbol,
        side: safeSide,
        entryPrice: safeEntryPrice,
        stopLoss: safeStopLoss,
        isLong: safeSide === 'buy',
        R,
    };
}
