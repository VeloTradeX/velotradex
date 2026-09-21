import logger from '../../utils/logger';
import { ParsedStrategy } from './types';
import { LLMResult } from './RaizexbtAiPrompts';
import {
    ManagementContext,
    analyzeManagementContext,
    parseNumericValue,
    resolveRiskMultiplier
} from './RaizexbtTextMatchers';

// ─── Result Conversion ──────────────────────────────────────────────────

export function convertToStrategies(result: LLMResult, rawMessage: any, logPrefix: string): ParsedStrategy[] | null {
    if (result.action === 'ignore') {
        logger.info(`${logPrefix} LLM classified as ignore`, { reasoning: result.reasoning });
        return null;
    }

    if (!result.symbol) {
        logger.warn(`${logPrefix} No symbol in LLM result`);
        return null;
    }

    const symbol = result.symbol;
    const managementContext = analyzeManagementContext(rawMessage);

    if (shouldConvertToBreakevenUpdate(result, managementContext)) {
        return [{
            action: 'update',
            symbol,
            stopLoss: 'breakeven',
            raw: rawMessage
        }];
    }

    if (result.action === 'update' && shouldTreatUpdateAsClose(result, managementContext)) {
        result = { ...result, action: 'close' };
    }

    if (result.action === 'close') {
        const closePercentage = resolveClosePercentage(result, rawMessage);
        const closePrice = resolveClosePrice(result, rawMessage);
        const strategy: ParsedStrategy = {
            action: 'close',
            symbol,
            raw: rawMessage
        };
        if (result.side === 'buy' || result.side === 'sell') {
            strategy.side = result.side;
        }
        if (typeof closePercentage === 'number') {
            strategy.closePercentage = closePercentage;
        }
        if (closePrice) {
            strategy.closePrice = closePrice;
        }
        const strategies: ParsedStrategy[] = [strategy];
        if (
            managementContext.hasBreakevenWord &&
            (result.stopLoss === 'breakeven' || managementContext.hasCloseVerb || managementContext.hasPartialWord) &&
            closePercentage !== 100
        ) {
            const updateStrategy: ParsedStrategy = {
                action: 'update',
                symbol,
                stopLoss: 'breakeven',
                raw: rawMessage
            };
            if (result.side === 'buy' || result.side === 'sell') {
                updateStrategy.side = result.side;
            }
            strategies.push(updateStrategy);
        }
        return strategies;
    }

    if (result.action === 'cancel') {
        return [{
            action: 'cancel',
            symbol,
            raw: rawMessage
        }];
    }

    if (result.action === 'update') {
        const strategy: ParsedStrategy = {
            action: 'update',
            symbol,
            raw: rawMessage
        };
        if (shouldConvertToBreakevenUpdate(result, managementContext)) {
            strategy.stopLoss = 'breakeven';
        }
        if (result.targets && result.targets.length > 0) {
            strategy.targets = result.targets.map(t => String(t));
        }
        if (result.stopLoss != null) {
            strategy.stopLoss = String(result.stopLoss);
        }
        return [strategy];
    }

    // action === 'open'
    if (!result.side) {
        logger.warn(`${logPrefix} Open action without side`);
        return null;
    }

    // Confidence gate
    const confidence = typeof result.confidence === 'number' ? result.confidence : 0;
    if (confidence < 0.3) {
        logger.info(`${logPrefix} Low confidence, skipping`, { confidence, reasoning: result.reasoning });
        return null;
    }

    const strategy: ParsedStrategy = {
        action: 'open',
        symbol,
        side: result.side,
        orderType: result.orderType || 'market',
        raw: rawMessage
    };

    if (result.entryPrice != null) {
        strategy.entryPrice = String(result.entryPrice);
    } else if ((result.orderType || 'market') === 'market') {
        // P0: 市价单（"entry CMP"）没有显式价格。标注为 CMP，让下游
        // buildCmpResolvedOpenStrategy 用实时 ticker 价格补齐，否则静态校验
        // 会因 entryPrice 缺失而拒绝（Invalid open strategy entryPrice）。
        strategy.entryPrice = 'CMP';
    }

    if (result.stopLoss != null) {
        strategy.stopLoss = String(result.stopLoss);
    }

    if (result.targets && result.targets.length > 0) {
        strategy.targets = result.targets.map(t => String(t));
    }

    if (result.riskMultiplier != null && typeof result.riskMultiplier === 'number') {
        strategy.riskMultiplier = result.riskMultiplier;
    } else {
        const resolvedRiskMultiplier = resolveRiskMultiplier(rawMessage);
        if (resolvedRiskMultiplier != null) {
            strategy.riskMultiplier = resolvedRiskMultiplier;
        }
    }

    return [strategy];
}

// ─── Conversion Decision Helpers ─────────────────────────────────────────

export function shouldConvertToBreakevenUpdate(
    result: LLMResult,
    context: ManagementContext
): boolean {
    if (!context.hasBreakevenWord) return false;
    if (context.hasCloseVerb) return false;
    if (result.action === 'cancel' || result.action === 'ignore' || result.action === 'open' || result.action === 'close') return false;
    return true;
}

export function shouldTreatUpdateAsClose(
    result: LLMResult,
    context: ManagementContext
): boolean {
    if (result.action !== 'update') return false;
    if (shouldConvertToBreakevenUpdate(result, context)) return false;
    return context.hasTakeProfitIntent || !!extractResolvedClosePrice(result, context);
}

export function extractResolvedClosePrice(
    result: LLMResult,
    context: ManagementContext
): string | undefined {
    const directClosePrice = parseNumericValue(result.closePrice);
    if (typeof directClosePrice === 'number') {
        return String(directClosePrice);
    }
    if (context.hasTpShorthand || shouldConvertToBreakevenUpdate(result, context)) {
        return undefined;
    }
    if (context.hasTakeProfitIntent && result.targets && result.targets.length > 0) {
        const firstTarget = parseNumericValue(result.targets[0]);
        if (typeof firstTarget === 'number') {
            return String(firstTarget);
        }
    }
    return undefined;
}

export function resolveClosePrice(result: LLMResult, rawMessage: any): string | undefined {
    const context = analyzeManagementContext(rawMessage);
    return extractResolvedClosePrice(result, context);
}

export function resolveClosePercentage(result: LLMResult, rawMessage: any): number | undefined {
    if (typeof result.closePercentage === 'number' && Number.isFinite(result.closePercentage)) {
        return Math.max(0, Math.min(100, result.closePercentage));
    }

    const context = analyzeManagementContext(rawMessage);

    if (typeof context.explicitClosePercentage === 'number') {
        return context.explicitClosePercentage;
    }
    if (context.isExplicitFullClose) {
        return 100;
    }
    if (typeof context.partialClosePercentage === 'number') {
        return context.partialClosePercentage;
    }
    if (context.hasTpShorthand) {
        return undefined;
    }
    if (extractResolvedClosePrice(result, context)) {
        return undefined;
    }
    return 100;
}
