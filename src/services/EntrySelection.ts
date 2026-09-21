// src/services/EntrySelection.ts
// 多入场点选择（纯函数）：由路由级 riskConfig.entrySelection 控制。
//   'all'（默认）      : 全部入场点按 weight 均分仓位（现状行为，原样返回）；
//   'nearest_sl'       : 仅在与止损价距离最近的入场点入场，该点全仓（weight=1），
//                       其余入场点跳过（返回 filtered=true 由路由层过滤）。
// 支持两种多入场点表达：
//   A) 解析器拆分：每条 ParsedStrategy 携带 entryIndex/entryCount/groupEntries（Gauls/WWG）；
//   B) 单条策略携带 entries 数组（KacangParser：L1 市价 + L2 限价）。
import { ParsedStrategy, StrategyRiskConfig } from './parsers/types';

export interface EntrySelectionResult {
    /** 处理后的策略（nearest_sl 命中时 weight=1 全仓） */
    parsed: ParsedStrategy;
    /** true = 该入场点应被本路由跳过 */
    filtered: boolean;
    /** 过滤原因（审计用） */
    reason?: string;
}

interface GroupEntryLike {
    type: 'market' | 'limit';
    price?: number;
}

/** 在带价格的入场点中找距止损最近者；返回 0-based 序号，无比价对象返回 null */
function nearestSlEntryIndexFromCandidates(candidates: Array<number | null>, stopLoss: number): number | null {
    let nearestIdx: number | null = null;
    let nearestDist = Infinity;
    for (let i = 0; i < candidates.length; i++) {
        const price = candidates[i];
        if (price === null || !Number.isFinite(price) || price <= 0) continue;
        const dist = Math.abs(price - stopLoss);
        if (dist < nearestDist) {
            nearestDist = dist;
            nearestIdx = i;
        }
    }
    return nearestIdx;
}

function parsePrice(value: unknown): number | null {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string') {
        const num = parseFloat(value);
        if (Number.isFinite(num)) return num;
    }
    return null;
}

export function applyEntrySelection(parsed: ParsedStrategy, riskConfig: StrategyRiskConfig): EntrySelectionResult {
    // 默认（含 undefined / 'all'）：不做任何处理
    if (riskConfig.entrySelection !== 'nearest_sl') return { parsed, filtered: false };
    // 仅开仓信号需要选择入场点
    if (parsed.action !== 'open') return { parsed, filtered: false };

    // 'breakeven' 等非数值止损无法判定距离 → 保持原状
    const stopLoss = parsePrice(parsed.stopLoss);
    if (stopLoss === null) return { parsed, filtered: false };

    // ── Case A：解析器拆分的多入场点组 ──
    if (
        parsed.entryCount !== undefined &&
        parsed.entryCount > 1 &&
        Array.isArray(parsed.groupEntries) &&
        parsed.groupEntries.length === parsed.entryCount &&
        parsed.entryIndex !== undefined
    ) {
        const candidates = (parsed.groupEntries as GroupEntryLike[]).map((e) =>
            e.price !== undefined && Number.isFinite(e.price) ? e.price : null
        );
        const nearestIdx = nearestSlEntryIndexFromCandidates(candidates, stopLoss);
        // 组内无任何可比价格（如全 CMP 市价入场）→ 无法判定，保持原状
        if (nearestIdx === null) return { parsed, filtered: false };

        if (parsed.entryIndex !== nearestIdx) {
            const nearest = (parsed.groupEntries as GroupEntryLike[])[nearestIdx];
            const nearestPrice = nearest.price !== undefined ? nearest.price : '?';
            return {
                parsed,
                filtered: true,
                reason: `entrySelection=nearest_sl：本入场点（第 ${parsed.entryIndex + 1} 个）不是距止损最近的入场点（最近为第 ${nearestIdx + 1} 个 @ ${nearestPrice}，SL=${stopLoss}），跳过`,
            };
        }

        // 命中最近入场点：全仓打到该点。averageEntryPrice 基于整组的均值，
        // 此时只剩一个入场点，移除后让仓位计算锚定到本入场价。
        const { averageEntryPrice: _drop, ...rest } = parsed;
        void _drop;
        return { parsed: { ...rest, weight: 1 }, filtered: false };
    }

    // ── Case B：单条策略携带多个入场点（entries 数组）──
    if (Array.isArray(parsed.entries) && parsed.entries.length > 1) {
        const entries = parsed.entries as GroupEntryLike[];
        const currentEntryPrice = parsePrice(parsed.entryPrice);
        const candidates = entries.map((e, i) => {
            if (e.price !== undefined && Number.isFinite(e.price)) return e.price;
            // 第一个市价入场点的价格即 parsed.entryPrice（如 Kacang L1）
            if (i === 0 && e.type === 'market' && currentEntryPrice !== null) return currentEntryPrice;
            return null;
        });
        const nearestIdx = nearestSlEntryIndexFromCandidates(candidates, stopLoss);
        // 无可比价格，或最近的就是当前入场点（entries[0]）→ 保持原状
        if (nearestIdx === null || nearestIdx === 0) return { parsed, filtered: false };

        const chosen = entries[nearestIdx];
        const chosenPrice = candidates[nearestIdx] as number;
        const { averageEntryPrice: _drop, ...rest } = parsed;
        void _drop;
        return {
            parsed: {
                ...rest,
                entries: [chosen],
                entryPrice: String(chosenPrice),
                orderType: chosen.type === 'market' ? 'market' : 'limit',
                weight: 1,
            },
            filtered: false,
        };
    }

    // 单入场点信号：不受 nearest_sl 影响
    return { parsed, filtered: false };
}
