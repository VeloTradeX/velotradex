// tests/services/EntrySelection.test.ts
// 严格覆盖多入场点选择（riskConfig.entrySelection）：
//   'all'（默认）保持现状；'nearest_sl' 仅保留与止损最近的入场点并全仓（weight=1）。
// 覆盖两种多入场点表达：
//   A) 解析器拆分组（entryIndex/entryCount/groupEntries，Gauls/WWG）；
//   B) 单条策略携带 entries 数组（KacangParser）。
import { applyEntrySelection } from '../../src/services/EntrySelection';
import { ParsedStrategy, StrategyRiskConfig } from '../../src/services/parsers/types';

function buildConfig(overrides: Partial<StrategyRiskConfig> = {}): StrategyRiskConfig {
    return {
        riskMode: 'fixed',
        riskValue: 50,
        defaultLeverage: '10',
        priceTolerance: 0.01,
        ...overrides,
    };
}

function buildParsed(overrides: Partial<ParsedStrategy> = {}): ParsedStrategy {
    return {
        action: 'open',
        symbol: 'XAU_USDT',
        side: 'buy',
        entryPrice: '2650',
        stopLoss: '2640',
        raw: {},
        ...overrides,
    };
}

describe('EntrySelection — 默认行为', () => {
    it('entrySelection 未配置 → 原样返回（对象引用不变）', () => {
        const parsed = buildParsed();
        const result = applyEntrySelection(parsed, buildConfig());
        expect(result.filtered).toBe(false);
        expect(result.parsed).toBe(parsed);
    });

    it("entrySelection='all' → 原样返回", () => {
        const parsed = buildParsed({ entryCount: 2, entryIndex: 0 });
        const result = applyEntrySelection(parsed, buildConfig({ entrySelection: 'all' }));
        expect(result.filtered).toBe(false);
        expect(result.parsed).toBe(parsed);
    });

    it('非 open 动作（close/update）→ 原样返回', () => {
        const parsed = buildParsed({ action: 'close', closePercentage: 50 });
        const result = applyEntrySelection(parsed, buildConfig({ entrySelection: 'nearest_sl' }));
        expect(result.filtered).toBe(false);
        expect(result.parsed).toBe(parsed);
    });

    it("止损非数值（'breakeven'）→ 无法判定，原样返回", () => {
        const parsed = buildParsed({
            stopLoss: 'breakeven',
            entryCount: 2,
            entryIndex: 0,
            groupEntries: [{ type: 'limit', price: 100 }, { type: 'limit', price: 98 }],
        });
        const result = applyEntrySelection(parsed, buildConfig({ entrySelection: 'nearest_sl' }));
        expect(result.filtered).toBe(false);
        expect(result.parsed).toBe(parsed);
    });

    it('单入场点信号（无组元数据、无 entries）→ 原样返回', () => {
        const parsed = buildParsed();
        const result = applyEntrySelection(parsed, buildConfig({ entrySelection: 'nearest_sl' }));
        expect(result.filtered).toBe(false);
        expect(result.parsed).toBe(parsed);
    });
});

describe('EntrySelection — Case A：解析器拆分的多入场点组', () => {
    // 做多：入场点1=2650（限价），入场点2=2648（限价，更靠近 SL=2640）
    const groupEntries = [
        { type: 'limit' as const, price: 2650 },
        { type: 'limit' as const, price: 2648 },
    ];

    it('非最近入场点被过滤（filtered=true，带原因）', () => {
        const parsed = buildParsed({
            entryPrice: '2650',
            entryIndex: 0,
            entryCount: 2,
            groupEntries,
        });
        const result = applyEntrySelection(parsed, buildConfig({ entrySelection: 'nearest_sl' }));
        expect(result.filtered).toBe(true);
        expect(result.reason).toContain('第 2 个');
        expect(result.reason).toContain('2648');
    });

    it('最近入场点全仓（weight=1），移除 averageEntryPrice', () => {
        const parsed = buildParsed({
            entryPrice: '2648',
            weight: 0.5,
            averageEntryPrice: 2649,
            entryIndex: 1,
            entryCount: 2,
            groupEntries,
        });
        const result = applyEntrySelection(parsed, buildConfig({ entrySelection: 'nearest_sl' }));
        expect(result.filtered).toBe(false);
        expect(result.parsed.weight).toBe(1);
        expect(result.parsed.averageEntryPrice).toBeUndefined();
        expect(result.parsed.entryPrice).toBe('2648');
    });

    it('做空：更靠近上方止损的入场点胜出', () => {
        // 做空 SL=2660：入场点 2655（距离 5）vs 2650（距离 10）→ 2655 最近
        const shortGroup = [
            { type: 'limit' as const, price: 2650 },
            { type: 'limit' as const, price: 2655 },
        ];
        const first = buildParsed({
            side: 'sell',
            entryPrice: '2650',
            stopLoss: '2660',
            entryIndex: 0,
            entryCount: 2,
            groupEntries: shortGroup,
        });
        const second = buildParsed({
            side: 'sell',
            entryPrice: '2655',
            stopLoss: '2660',
            weight: 0.5,
            entryIndex: 1,
            entryCount: 2,
            groupEntries: shortGroup,
        });
        const cfg = buildConfig({ entrySelection: 'nearest_sl' });

        expect(applyEntrySelection(first, cfg).filtered).toBe(true);
        const kept = applyEntrySelection(second, cfg);
        expect(kept.filtered).toBe(false);
        expect(kept.parsed.weight).toBe(1);
    });

    it('市价/CMP 入场点无价格，不参与比较（被跳过）', () => {
        // "CMP till 2648" 做多：[market(CMP), limit 2648]，SL=2640 → limit 最近
        const gaulsGroup = [
            { type: 'market' as const },
            { type: 'limit' as const, price: 2648 },
        ];
        const cmpLeg = buildParsed({
            entryPrice: 'CMP',
            entryIndex: 0,
            entryCount: 2,
            groupEntries: gaulsGroup,
        });
        const limitLeg = buildParsed({
            entryPrice: '2648',
            weight: 0.5,
            entryIndex: 1,
            entryCount: 2,
            groupEntries: gaulsGroup,
        });
        const cfg = buildConfig({ entrySelection: 'nearest_sl' });

        expect(applyEntrySelection(cmpLeg, cfg).filtered).toBe(true);
        const kept = applyEntrySelection(limitLeg, cfg);
        expect(kept.filtered).toBe(false);
        expect(kept.parsed.weight).toBe(1);
    });

    it('组内全部为无价格市价入场点 → 无法判定，原样返回', () => {
        const parsed = buildParsed({
            entryPrice: 'CMP',
            entryIndex: 0,
            entryCount: 2,
            groupEntries: [{ type: 'market' }, { type: 'market' }],
        });
        const result = applyEntrySelection(parsed, buildConfig({ entrySelection: 'nearest_sl' }));
        expect(result.filtered).toBe(false);
        expect(result.parsed).toBe(parsed);
    });

    it('距离相同取靠前者（第一个 priced 入场点）', () => {
        // SL=100，两个入场点 95/105 距离均为 5 → 取第 0 个
        const tieGroup = [
            { type: 'limit' as const, price: 95 },
            { type: 'limit' as const, price: 105 },
        ];
        const first = buildParsed({
            entryPrice: '95',
            stopLoss: '100',
            entryIndex: 0,
            entryCount: 2,
            groupEntries: tieGroup,
        });
        const second = buildParsed({
            entryPrice: '105',
            stopLoss: '100',
            entryIndex: 1,
            entryCount: 2,
            groupEntries: tieGroup,
        });
        const cfg = buildConfig({ entrySelection: 'nearest_sl' });

        expect(applyEntrySelection(first, cfg).filtered).toBe(false);
        expect(applyEntrySelection(second, cfg).filtered).toBe(true);
    });

    it('组元数据不完整（缺 entryIndex / groupEntries 长度不符）→ 原样返回', () => {
        const noIndex = buildParsed({ entryCount: 2, groupEntries });
        const mismatch = buildParsed({
            entryIndex: 0,
            entryCount: 3,
            groupEntries, // 长度 2 ≠ entryCount 3
        });
        const cfg = buildConfig({ entrySelection: 'nearest_sl' });
        expect(applyEntrySelection(noIndex, cfg).parsed).toBe(noIndex);
        expect(applyEntrySelection(mismatch, cfg).parsed).toBe(mismatch);
    });

    it('entryCount=1（单入场点）→ 原样返回', () => {
        const parsed = buildParsed({
            entryIndex: 0,
            entryCount: 1,
            groupEntries: [{ type: 'limit', price: 2650 }],
        });
        const result = applyEntrySelection(parsed, buildConfig({ entrySelection: 'nearest_sl' }));
        expect(result.filtered).toBe(false);
        expect(result.parsed).toBe(parsed);
    });
});

describe('EntrySelection — Case B：单条策略携带 entries 数组（KacangParser 形态）', () => {
    it('Kacang 做多：entries[0](市价=区间低点) 本身最靠近下方止损 → 原样返回', () => {
        // Kacang 买入：L1=zoneLow(2648, 市价)，L2=zoneHigh(2652, 限价)，SL=2640
        const parsed = buildParsed({
            entryPrice: '2648',
            stopLoss: '2640',
            orderType: 'market',
            entries: [{ type: 'market' }, { type: 'limit', price: 2652 }],
        });
        const result = applyEntrySelection(parsed, buildConfig({ entrySelection: 'nearest_sl' }));
        expect(result.filtered).toBe(false);
        expect(result.parsed).toBe(parsed);
    });

    it('Kacang 做空：entries[0](市价=区间高点) 本身最靠近上方止损 → 原样返回', () => {
        // Kacang 卖出：L1=zoneHigh(2652, 市价)，L2=zoneLow(2648, 限价)，SL=2660
        const parsed = buildParsed({
            side: 'sell',
            entryPrice: '2652',
            stopLoss: '2660',
            orderType: 'market',
            entries: [{ type: 'market' }, { type: 'limit', price: 2648 }],
        });
        const result = applyEntrySelection(parsed, buildConfig({ entrySelection: 'nearest_sl' }));
        expect(result.filtered).toBe(false);
        expect(result.parsed).toBe(parsed);
    });

    it('第二入场点更靠近止损 → 切换入场价并全仓', () => {
        const parsed = buildParsed({
            entryPrice: '100',
            stopLoss: '90',
            orderType: 'limit',
            averageEntryPrice: 99,
            entries: [
                { type: 'limit', price: 100 },
                { type: 'limit', price: 98 },
            ],
        });
        const result = applyEntrySelection(parsed, buildConfig({ entrySelection: 'nearest_sl' }));
        expect(result.filtered).toBe(false);
        expect(result.parsed.entryPrice).toBe('98');
        expect(result.parsed.orderType).toBe('limit');
        expect(result.parsed.weight).toBe(1);
        expect(result.parsed.averageEntryPrice).toBeUndefined();
        expect(result.parsed.entries).toEqual([{ type: 'limit', price: 98 }]);
    });

    it('entries[0] 已是最近 → 原样返回', () => {
        const parsed = buildParsed({
            entryPrice: '98',
            stopLoss: '90',
            entries: [
                { type: 'limit', price: 98 },
                { type: 'limit', price: 100 },
            ],
        });
        const result = applyEntrySelection(parsed, buildConfig({ entrySelection: 'nearest_sl' }));
        expect(result.filtered).toBe(false);
        expect(result.parsed).toBe(parsed);
    });
});
