import { normalizeSymbolOrNull } from '../utils/normalizeSymbol';
import type { AIAction, AISide, AIAnalysisResult } from './AIParserService';

export function normalizeResult(raw: any): AIAnalysisResult | null {
    if (!raw || typeof raw !== 'object') return null;

    const rawAction = String(raw.action || '').trim().toLowerCase();
    const normalizedAction = normalizeAction(rawAction);
    if (!normalizedAction) return null;

    const symbol = normalizeSymbolOrNull(raw.symbol);
    if (!symbol) return null;

    const legacySide = rawAction === 'long' ? 'buy' : rawAction === 'short' ? 'sell' : undefined;
    const side = normalizeSide(raw.side || raw.direction || legacySide);
    const confidence = toNumber(raw.confidence);
    const entryPrice = toNumber(raw.entryPrice);
    const stopLoss = toNumber(raw.stopLoss);
    const leverage = toNumber(raw.leverage);
    const targets = toNumberArray(raw.targets);
    const reasoning = typeof raw.reasoning === 'string' ? raw.reasoning : '';

    if (normalizedAction === 'open' && !side) {
        return null;
    }

    if (normalizedAction === 'open' && (entryPrice === undefined || stopLoss === undefined)) {
        return null;
    }

    if (normalizedAction === 'ignore') {
        return {
            action: 'ignore',
            symbol,
            confidence,
            reasoning
        };
    }

    const result: AIAnalysisResult = {
        action: normalizedAction,
        symbol,
        confidence,
        reasoning
    };

    if (side) result.side = side;
    if (entryPrice !== undefined) result.entryPrice = entryPrice;
    if (stopLoss !== undefined) result.stopLoss = stopLoss;
    if (leverage !== undefined) result.leverage = leverage;
    if (targets && targets.length > 0) result.targets = targets;

    return result;
}

function normalizeAction(action: string): AIAction | null {
    if (!action) return null;
    if (action === 'long' || action === 'short') return 'open';
    if (['open', 'close', 'update', 'cancel', 'ignore'].includes(action)) {
        return action as AIAction;
    }
    return null;
}

function normalizeSide(input: any): AISide | undefined {
    if (input === undefined || input === null) return undefined;
    const value = String(input).trim().toLowerCase();
    if (value === 'buy' || value === 'long') return 'buy';
    if (value === 'sell' || value === 'short') return 'sell';
    return undefined;
}

function toNumber(input: any): number | undefined {
    if (input === undefined || input === null || input === '') return undefined;
    const value = Number(input);
    if (!Number.isFinite(value)) return undefined;
    return value;
}

function toNumberArray(input: any): number[] {
    if (!Array.isArray(input)) return [];
    return input
        .map((v) => Number(v))
        .filter((v) => Number.isFinite(v));
}
