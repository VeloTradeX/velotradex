// tests/services/OpenPriceAdjustment.test.ts
// 严格覆盖两套互斥价格调整体系：
//   'r'（默认）R 百分比滑点 —— 必须与历史行为完全一致；
//   'fixed' 固定美元体系 —— 让点入场 / 固定止损距离 / 止损后移 + 非法结果拒单。
import { applyOpenPriceAdjustments } from '../../src/services/OpenPriceAdjustment';
import { StrategyRiskConfig } from '../../src/services/parsers/types';

const DEFAULTS = { entry: 0.01, tp: 0.01, sl: 0.01 };

function buildConfig(overrides: Partial<StrategyRiskConfig> = {}): StrategyRiskConfig {
    return {
        riskMode: 'fixed',
        riskValue: 50,
        defaultLeverage: '10',
        priceTolerance: 0.01,
        ...overrides,
    };
}

describe('OpenPriceAdjustment — R 百分比体系（默认，历史行为）', () => {
    it('未配置 paddingMode 时走 R 体系并应用默认滑点（做多）', () => {
        const result = applyOpenPriceAdjustments({
            side: 'buy',
            entryPrice: 2650,
            stopLoss: 2640,
            takeProfit: 2660,
            R: 10,
            riskConfig: buildConfig(),
            defaults: DEFAULTS,
        });
        // entry += R*0.01, SL -= R*0.01, TP -= R*0.01
        expect(result.mode).toBe('r');
        expect(result.entryPrice).toBeCloseTo(2650.1, 10);
        expect(result.stopLoss).toBeCloseTo(2639.9, 10);
        expect(result.takeProfit).toBeCloseTo(2659.9, 10);
        expect(result.invalidReason).toBeUndefined();
    });

    it('未配置 paddingMode 时走 R 体系并应用默认滑点（做空）', () => {
        const result = applyOpenPriceAdjustments({
            side: 'sell',
            entryPrice: 2650,
            stopLoss: 2660,
            takeProfit: 2640,
            R: 10,
            riskConfig: buildConfig(),
            defaults: DEFAULTS,
        });
        expect(result.mode).toBe('r');
        expect(result.entryPrice).toBeCloseTo(2649.9, 10);
        expect(result.stopLoss).toBeCloseTo(2660.1, 10);
        expect(result.takeProfit).toBeCloseTo(2640.1, 10);
        expect(result.invalidReason).toBeUndefined();
    });

    it('显式 R 滑点覆盖默认值（做多：入场+、SL−、TP−）', () => {
        const result = applyOpenPriceAdjustments({
            side: 'buy',
            entryPrice: 2650,
            stopLoss: 2640,
            takeProfit: 2660,
            R: 10,
            riskConfig: buildConfig({ entryPaddingR: 0.1, slPaddingR: 0.2, tpPaddingR: 0.05 }),
            defaults: DEFAULTS,
        });
        expect(result.entryPrice).toBeCloseTo(2651, 10); // +1
        expect(result.stopLoss).toBeCloseTo(2638, 10); // -2
        expect(result.takeProfit).toBeCloseTo(2659.5, 10); // -0.5
        expect(result.applied.entryPaddingR).toBe(0.1);
        expect(result.applied.slPaddingR).toBe(0.2);
        expect(result.applied.tpPaddingR).toBe(0.05);
    });

    it('显式 R 滑点覆盖默认值（做空：入场−、SL+、TP+）', () => {
        const result = applyOpenPriceAdjustments({
            side: 'sell',
            entryPrice: 2650,
            stopLoss: 2660,
            takeProfit: 2640,
            R: 10,
            riskConfig: buildConfig({ entryPaddingR: 0.1, slPaddingR: 0.2, tpPaddingR: 0.05 }),
            defaults: DEFAULTS,
        });
        expect(result.entryPrice).toBeCloseTo(2649, 10);
        expect(result.stopLoss).toBeCloseTo(2662, 10);
        expect(result.takeProfit).toBeCloseTo(2640.5, 10);
    });

    it('paddingMode="r" 显式选择 R 体系', () => {
        const result = applyOpenPriceAdjustments({
            side: 'buy',
            entryPrice: 100,
            stopLoss: 90,
            R: 10,
            riskConfig: buildConfig({ paddingMode: 'r' }),
            defaults: DEFAULTS,
        });
        expect(result.mode).toBe('r');
        expect(result.entryPrice).toBeCloseTo(100.1, 10);
        expect(result.stopLoss).toBeCloseTo(89.9, 10);
    });

    it('无 takeProfit 时保持 undefined', () => {
        const result = applyOpenPriceAdjustments({
            side: 'buy',
            entryPrice: 100,
            stopLoss: 90,
            R: 10,
            riskConfig: buildConfig(),
            defaults: DEFAULTS,
        });
        expect(result.takeProfit).toBeUndefined();
    });
});

describe('OpenPriceAdjustment — 固定美元体系（paddingMode=fixed）', () => {
    it('让点入场：做多入场价下移、止损止盈不动', () => {
        const result = applyOpenPriceAdjustments({
            side: 'buy',
            entryPrice: 2650,
            stopLoss: 2640,
            takeProfit: 2660,
            R: 10,
            riskConfig: buildConfig({ paddingMode: 'fixed', entryOffsetFixed: 1.5 }),
            defaults: DEFAULTS,
        });
        expect(result.mode).toBe('fixed');
        expect(result.entryPrice).toBeCloseTo(2648.5, 10);
        expect(result.stopLoss).toBe(2640);
        expect(result.takeProfit).toBe(2660); // 固定体系不动止盈
        expect(result.invalidReason).toBeUndefined();
        expect(result.applied.entryOffsetFixed).toBe(1.5);
    });

    it('让点入场：做空入场价上移', () => {
        const result = applyOpenPriceAdjustments({
            side: 'sell',
            entryPrice: 2650,
            stopLoss: 2660,
            R: 10,
            riskConfig: buildConfig({ paddingMode: 'fixed', entryOffsetFixed: 1.2 }),
            defaults: DEFAULTS,
        });
        expect(result.entryPrice).toBeCloseTo(2651.2, 10);
        expect(result.stopLoss).toBe(2660);
    });

    it('固定止损距离：做多 SL = 入场价 − X（忽略信号止损）', () => {
        const result = applyOpenPriceAdjustments({
            side: 'buy',
            entryPrice: 2650,
            stopLoss: 2640,
            currentPrice: 2655,
            R: 10,
            riskConfig: buildConfig({ paddingMode: 'fixed', fixedSlDistance: 5 }),
            defaults: DEFAULTS,
        });
        expect(result.stopLoss).toBeCloseTo(2645, 10);
        expect(result.entryPrice).toBe(2650);
        expect(result.invalidReason).toBeUndefined();
    });

    it('固定止损距离：做空 SL = 入场价 + X', () => {
        const result = applyOpenPriceAdjustments({
            side: 'sell',
            entryPrice: 2650,
            stopLoss: 2660,
            currentPrice: 2645,
            R: 10,
            riskConfig: buildConfig({ paddingMode: 'fixed', fixedSlDistance: 6 }),
            defaults: DEFAULTS,
        });
        expect(result.stopLoss).toBeCloseTo(2656, 10);
        expect(result.invalidReason).toBeUndefined();
    });

    it('固定止损距离以让点后的入场价为基准', () => {
        const result = applyOpenPriceAdjustments({
            side: 'buy',
            entryPrice: 2650,
            stopLoss: 2640,
            currentPrice: 2655,
            R: 10,
            riskConfig: buildConfig({ paddingMode: 'fixed', entryOffsetFixed: 1.5, fixedSlDistance: 5 }),
            defaults: DEFAULTS,
        });
        expect(result.entryPrice).toBeCloseTo(2648.5, 10);
        expect(result.stopLoss).toBeCloseTo(2643.5, 10); // 2648.5 - 5
    });

    it('止损后移：做多 SL 向下移 X（信号止损基础上）', () => {
        const result = applyOpenPriceAdjustments({
            side: 'buy',
            entryPrice: 2650,
            stopLoss: 2640,
            currentPrice: 2655,
            R: 10,
            riskConfig: buildConfig({ paddingMode: 'fixed', slBackOffsetFixed: 1.5 }),
            defaults: DEFAULTS,
        });
        expect(result.stopLoss).toBeCloseTo(2638.5, 10);
        expect(result.entryPrice).toBe(2650);
    });

    it('止损后移：做空 SL 向上移 X', () => {
        const result = applyOpenPriceAdjustments({
            side: 'sell',
            entryPrice: 2650,
            stopLoss: 2660,
            currentPrice: 2645,
            R: 10,
            riskConfig: buildConfig({ paddingMode: 'fixed', slBackOffsetFixed: 1 }),
            defaults: DEFAULTS,
        });
        expect(result.stopLoss).toBeCloseTo(2661, 10);
    });

    it('三者组合：让点 1.5 + 固定止损距离 5 + 止损后移 1（做多）', () => {
        const result = applyOpenPriceAdjustments({
            side: 'buy',
            entryPrice: 2650,
            stopLoss: 2640,
            currentPrice: 2655,
            R: 10,
            riskConfig: buildConfig({
                paddingMode: 'fixed',
                entryOffsetFixed: 1.5,
                fixedSlDistance: 5,
                slBackOffsetFixed: 1,
            }),
            defaults: DEFAULTS,
        });
        expect(result.entryPrice).toBeCloseTo(2648.5, 10);
        expect(result.stopLoss).toBeCloseTo(2642.5, 10); // 2648.5 - 5 - 1
        expect(result.applied.entryOffsetFixed).toBe(1.5);
        expect(result.applied.fixedSlDistance).toBe(5);
        expect(result.applied.slBackOffsetFixed).toBe(1);
    });

    it('固定体系下 R 百分比滑点全部忽略', () => {
        const result = applyOpenPriceAdjustments({
            side: 'buy',
            entryPrice: 2650,
            stopLoss: 2640,
            takeProfit: 2660,
            R: 10,
            riskConfig: buildConfig({
                paddingMode: 'fixed',
                entryPaddingR: 0.5,
                tpPaddingR: 0.5,
                slPaddingR: 0.5,
            }),
            defaults: DEFAULTS,
        });
        expect(result.entryPrice).toBe(2650);
        expect(result.stopLoss).toBe(2640);
        expect(result.takeProfit).toBe(2660);
        expect(result.applied.entryPaddingR).toBeUndefined();
        expect(result.applied.slPaddingR).toBeUndefined();
        expect(result.applied.tpPaddingR).toBeUndefined();
    });

    it('固定值为 0 / 负数 / NaN 时视为未配置', () => {
        for (const bad of [0, -1, NaN, Infinity]) {
            const result = applyOpenPriceAdjustments({
                side: 'buy',
                entryPrice: 2650,
                stopLoss: 2640,
                currentPrice: 2655,
                R: 10,
                riskConfig: buildConfig({
                    paddingMode: 'fixed',
                    entryOffsetFixed: bad,
                    fixedSlDistance: bad,
                    slBackOffsetFixed: bad,
                }),
                defaults: DEFAULTS,
            });
            expect(result.entryPrice).toBe(2650);
            expect(result.stopLoss).toBe(2640);
            expect(result.invalidReason).toBeUndefined();
        }
    });

    describe('非法结果拒绝', () => {
        it('做多：让点过大致入场价低于止损 → invalidReason', () => {
            const result = applyOpenPriceAdjustments({
                side: 'buy',
                entryPrice: 100,
                stopLoss: 99,
                R: 1,
                riskConfig: buildConfig({ paddingMode: 'fixed', entryOffsetFixed: 2 }),
                defaults: DEFAULTS,
            });
            expect(result.invalidReason).toContain('穿越入场价');
        });

        it('做空：让点过大致入场价高于止损 → invalidReason', () => {
            const result = applyOpenPriceAdjustments({
                side: 'sell',
                entryPrice: 100,
                stopLoss: 101,
                R: 1,
                riskConfig: buildConfig({ paddingMode: 'fixed', entryOffsetFixed: 2 }),
                defaults: DEFAULTS,
            });
            expect(result.invalidReason).toContain('穿越入场价');
        });

        it('做多：固定止损距离过小致 SL 不低于当前价 → invalidReason（避免成交即止损）', () => {
            const result = applyOpenPriceAdjustments({
                side: 'buy',
                entryPrice: 2650,
                stopLoss: 2640,
                currentPrice: 2640, // 当前价已低于 SL=2645
                R: 10,
                riskConfig: buildConfig({ paddingMode: 'fixed', fixedSlDistance: 5 }),
                defaults: DEFAULTS,
            });
            expect(result.stopLoss).toBeCloseTo(2645, 10);
            expect(result.invalidReason).toContain('当前价');
        });

        it('做空：固定止损距离过大致 SL 不高于当前价 → invalidReason', () => {
            const result = applyOpenPriceAdjustments({
                side: 'sell',
                entryPrice: 2650,
                stopLoss: 2660,
                currentPrice: 2660, // 当前价已高于 SL=2656
                R: 10,
                riskConfig: buildConfig({ paddingMode: 'fixed', fixedSlDistance: 6 }),
                defaults: DEFAULTS,
            });
            expect(result.stopLoss).toBeCloseTo(2656, 10);
            expect(result.invalidReason).toContain('当前价');
        });

        it('未提供 currentPrice 时跳过立即触发校验', () => {
            const result = applyOpenPriceAdjustments({
                side: 'buy',
                entryPrice: 2650,
                stopLoss: 2640,
                R: 10,
                riskConfig: buildConfig({ paddingMode: 'fixed', fixedSlDistance: 5 }),
                defaults: DEFAULTS,
            });
            expect(result.stopLoss).toBeCloseTo(2645, 10);
            expect(result.invalidReason).toBeUndefined();
        });

        it('R 体系不做非法校验（历史行为：SL 只会远离价格）', () => {
            const result = applyOpenPriceAdjustments({
                side: 'buy',
                entryPrice: 2650,
                stopLoss: 2640,
                currentPrice: 2640.5,
                R: 10,
                riskConfig: buildConfig({ entryPaddingR: 0.5, slPaddingR: 0.5 }),
                defaults: DEFAULTS,
            });
            expect(result.invalidReason).toBeUndefined();
        });
    });
});
