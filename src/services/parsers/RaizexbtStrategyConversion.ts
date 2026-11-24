import logger from '../../utils/logger';
import { ParsedStrategy } from './types';
import { LLMResult } from './RaizexbtAiPrompts';
import {
    ManagementContext,
    analyzeManagementContext,
    extractEnglishText,
    parseNumericValue,
    resolveRiskMultiplier
} from './RaizexbtTextMatchers';
import {
    isDcaText,
    isExitAtBreakevenIntent,
    resolveRiskMultiplierFromText
} from './RaizexbtRiskRules';

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
    const englishText = managementContext.englishText;
    const deterministicRiskMultiplier = resolveEffectiveRiskMultiplier(result, rawMessage);

    // 「回到入场价就平仓」语义（如 "got low hold will close if we get breakeven"）：
    // 这是管理动作而不是平仓指令，也不是开仓。执行层会在浮亏时改用
    // 入场价 reduce-only 限价平仓单，而不是挂一个必然触发的 BE 止损。
    if (isExitAtBreakevenIntent(englishText) && ['open', 'close', 'update'].includes(result.action)) {
        const strategy: ParsedStrategy = {
            action: 'update',
            symbol,
            stopLoss: 'breakeven',
            breakevenMode: 'exit_at_entry',
            raw: rawMessage
        };
        if (result.side === 'buy' || result.side === 'sell') strategy.side = result.side;
        return [strategy];
    }

    // 1R 管理计划：纯管理动作，不能被后面的「TP 意图 → 平仓」启发式误判成平仓。
    if (result.action === 'update' && typeof result.planRMultiple === 'number' && result.planRMultiple > 0) {
        const strategy: ParsedStrategy = {
            action: 'update',
            symbol,
            planRMultiple: result.planRMultiple,
            planClosePercentage: result.planClosePercentage ?? 50,
            raw: rawMessage,
        };
        if (result.side === 'buy' || result.side === 'sell') strategy.side = result.side;
        return [strategy];
    }

    if (shouldConvertToBreakevenUpdate(result, managementContext)) {
        const strategy: ParsedStrategy = {
            action: 'update',
            symbol,
            stopLoss: 'breakeven',
            breakevenMode: resolveBreakevenMode(managementContext.englishText, result.breakevenMode),
            raw: rawMessage
        };
        if (result.side === 'buy' || result.side === 'sell') strategy.side = result.side;
        return [strategy];
    }

    if (result.action === 'update' && shouldTreatUpdateAsClose(result, managementContext)) {
        result = { ...result, action: 'close' };
    }

    // Partial-exit intent outranks the RR-report classification: "1.8R+ partials"
    // is an instruction to close part of the position, even when the LLM labelled
    // it as update. The close branch below also emits the breakeven update when
    // the same message says SL entry / stops to entry.
    if (
        result.action === 'update' &&
        typeof managementContext.partialClosePercentage === 'number' &&
        !managementContext.isExplicitFullClose
    ) {
        const partialPercentage = result.closePercentage ?? managementContext.partialClosePercentage;
        logger.info(`${logPrefix} Partial-exit intent overrides update classification`, {
            closePercentage: partialPercentage,
            hasStopToEntry: managementContext.hasStopToEntryIntent,
        });
        result = { ...result, action: 'close', closePercentage: partialPercentage };
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
        const isPartialClose = typeof closePercentage === 'number' && closePercentage > 0 && closePercentage < 100;

        if (isPartialClose) {
            // 部分平仓后不能撤掉剩余仓位的保护单（否则剩余仓裸奔，NoStopLossMonitor 会全平），
            // 并自动把止损移到保本；浮亏时执行层会改成保护模式（恢复原止损）而不是市价全平。
            strategy.keepPartialProtections = true;
            const updateStrategy: ParsedStrategy = {
                action: 'update',
                symbol,
                stopLoss: 'breakeven',
                breakevenMode: resolveBreakevenMode(englishText, result.breakevenMode),
                raw: rawMessage
            };
            if (result.side === 'buy' || result.side === 'sell') {
                updateStrategy.side = result.side;
            }
            strategies.push(updateStrategy);
            return strategies;
        }

        // TP 简写（Tp1/Tp2）不显式给比例：执行层按 tpDistribution 部分平仓，
        // 且 TP1 成交后由既有链路自动移保本，不需要额外 update。
        if (managementContext.hasTpShorthand && closePercentage == null) {
            return strategies;
        }

        if (
            (managementContext.hasBreakevenWord || managementContext.hasStopToEntryIntent) &&
            (result.stopLoss === 'breakeven' || managementContext.hasCloseVerb || managementContext.hasPartialWord) &&
            closePercentage !== 100
        ) {
            const updateStrategy: ParsedStrategy = {
                action: 'update',
                symbol,
                stopLoss: 'breakeven',
                breakevenMode: resolveBreakevenMode(englishText, result.breakevenMode),
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
        if (result.side === 'buy' || result.side === 'sell') {
            strategy.side = result.side;
        }
        if (result.riskResize) {
            if (typeof deterministicRiskMultiplier === 'number') {
                strategy.riskMultiplier = deterministicRiskMultiplier;
                strategy.riskResize = true;
            } else {
                logger.warn(`${logPrefix} riskResize requested without a usable riskMultiplier; skipping resize`, {
                    llmRiskMultiplier: result.riskMultiplier,
                });
            }
        }
        if (typeof result.planRMultiple === 'number' && result.planRMultiple > 0) {
            strategy.planRMultiple = result.planRMultiple;
            strategy.planClosePercentage = result.planClosePercentage ?? 50;
        }
        if (result.targets && result.targets.length > 0) {
            strategy.targets = result.targets.map(t => String(t));
        }
        if (result.stopLoss != null) {
            strategy.stopLoss = String(result.stopLoss);
        }
        if (shouldConvertToBreakevenUpdate(result, managementContext)) {
            strategy.stopLoss = 'breakeven';
        }
        if (String(strategy.stopLoss || '').toLowerCase() === 'breakeven') {
            strategy.breakevenMode = resolveBreakevenMode(englishText, result.breakevenMode);
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

    const dcaIntent = isDcaText(englishText) || result.isAddPosition === true;
    // 本频道开仓必须有止损：没有可读止损的图/文本不是可执行信号，解析层直接丢弃，
    // 不再依赖执行层 missing_stop_loss 拒单。DCA/加仓沿用原仓位止损，豁免该规则。
    if (!dcaIntent && (result.stopLoss == null || String(result.stopLoss).trim() === '')) {
        logger.info(`${logPrefix} Drop open without stop loss (raizexbt requires SL)`, {
            symbol,
            entryPrice: result.entryPrice,
            reasoning: result.reasoning,
        });
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

    if (typeof deterministicRiskMultiplier === 'number') {
        strategy.riskMultiplier = deterministicRiskMultiplier;
    } else {
        const resolvedRiskMultiplier = resolveRiskMultiplier(rawMessage);
        if (resolvedRiskMultiplier != null) {
            strategy.riskMultiplier = resolvedRiskMultiplier;
        }
    }

    if (dcaIntent) {
        strategy.isAddPosition = true;
        strategy.allowAddPosition = true;
    } else {
        // 近似重复开仓拦截：同币同向、价差 ≤0.5R、30 分钟内、已有持仓/挂单 → 跳过。
        strategy.nearDuplicateGuard = true;
    }

    return [strategy];
}

// ─── Risk / Breakeven helpers ────────────────────────────────────────────

/**
 * 解析本条消息的仓位风险倍数（确定性规则优先于 LLM）。
 *
 * 本频道只会缩仓不会加仓：结果 RR（2R+ 等）不参与仓位；任何 >1 的值按 1R 处理。
 */
export function resolveEffectiveRiskMultiplier(result: LLMResult, rawMessage: any): number | undefined {
    const text = extractEnglishText(String(rawMessage?.content || ''));
    const fromText = resolveRiskMultiplierFromText(text);
    const fromResult = typeof result.riskMultiplier === 'number' && Number.isFinite(result.riskMultiplier)
        ? result.riskMultiplier
        : undefined;
    const fromFallback = resolveRiskMultiplier(rawMessage);
    const resolved = fromText ?? fromResult ?? fromFallback;
    if (resolved == null) return undefined;
    if (resolved > 1) {
        logger.info('Raizexbt riskMultiplier > 1R clamped to 1R', { fromText, fromResult, resolved });
        return 1;
    }
    return Math.max(0.05, resolved);
}

export function resolveBreakevenMode(
    englishText: string,
    explicit?: 'protect' | 'exit_at_entry',
): 'protect' | 'exit_at_entry' {
    if (explicit === 'protect' || explicit === 'exit_at_entry') return explicit;
    return isExitAtBreakevenIntent(englishText) ? 'exit_at_entry' : 'protect';
}

// ─── Conversion Decision Helpers ─────────────────────────────────────────

export function shouldConvertToBreakevenUpdate(
    result: LLMResult,
    context: ManagementContext
): boolean {
    if (!context.hasBreakevenWord && !context.hasStopToEntryIntent) return false;
    if (context.hasCloseVerb) return false;
    if (result.action === 'cancel' || result.action === 'ignore' || result.action === 'close') return false;
    // Plain "breakeven" / "stops be" keeps the existing guard (trust the LLM's
    // open decision). Explicit stop-to-entry shorthand ("stops entry", "sl to
    // entry") is always management of an existing position: override a chart-signal
    // override that misclassified it as a fresh open.
    if (result.action === 'open' && !context.hasStopToEntryIntent) return false;
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
    const context = analyzeManagementContext(rawMessage);

    // Partial-exit intent has priority over the LLM percentage: "1.8R+ partials"
    // must default to 50%, never 100%. An explicit percentage or an explicit
    // full-close phrase still wins.
    if (
        typeof context.partialClosePercentage === 'number' &&
        !context.isExplicitFullClose &&
        typeof context.explicitClosePercentage !== 'number'
    ) {
        return context.partialClosePercentage;
    }

    if (typeof result.closePercentage === 'number' && Number.isFinite(result.closePercentage)) {
        return Math.max(0, Math.min(100, result.closePercentage));
    }

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
