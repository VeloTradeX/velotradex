// tests/services/TpSlCalculator.test.ts
import { TpSlCalculator } from '../../src/services/TpSlCalculator';

describe('TpSlCalculator', () => {
  const calc = new TpSlCalculator();

  describe('calculate', () => {
    it('均分 TP 数量到所有目标', () => {
      const result = calc.calculate({
        entryPrice: 100,
        stopLoss: 95,
        side: 'buy',
        targets: ['102', '103', '104'],
        tpDistribution: [],
        tpPaddingR: 0,
        tpOrderType: 'limit',
        fixedRiskRewardClose: undefined,
      }, 9, 2, 2);

      expect(result.allocated).toEqual([3, 3, 3]);
    });

    it('按比例分配 TP 数量', () => {
      const result = calc.calculate({
        entryPrice: 100,
        stopLoss: 95,
        side: 'buy',
        targets: ['102', '103', '104'],
        tpDistribution: [0.5, 0.3, 0.2],
        tpPaddingR: 0,
        tpOrderType: 'limit',
        fixedRiskRewardClose: undefined,
      }, 10, 2, 2);

      expect(result.allocated).toEqual([5, 3, 2]);
    });

    it('Long targets 升序排列', () => {
      const result = calc.calculate({
        entryPrice: 100,
        stopLoss: 95,
        side: 'buy',
        targets: ['105', '103', '104'],
        tpDistribution: [],
        tpPaddingR: 0,
        tpOrderType: 'limit',
        fixedRiskRewardClose: undefined,
      }, 9, 2, 2);

      expect(result.targets).toEqual(['103', '104', '105']);
    });

    it('Short targets 降序排列', () => {
      const result = calc.calculate({
        entryPrice: 100,
        stopLoss: 105,
        side: 'sell',
        targets: ['98', '101', '99'],
        tpDistribution: [],
        tpPaddingR: 0,
        tpOrderType: 'limit',
        fixedRiskRewardClose: undefined,
      }, 9, 2, 2);

      expect(result.targets).toEqual(['101', '99', '98']);
    });

    it('fixedRiskRewardClose 插入 RR 目标', () => {
      // Long: entry=100, stopLoss=95, R=5, fixedRR=2 → TP=100+10=110
      const result = calc.calculate({
        entryPrice: 100,
        stopLoss: 95,
        side: 'buy',
        targets: ['102'],
        tpDistribution: [],
        tpPaddingR: 0,
        tpOrderType: 'limit',
        fixedRiskRewardClose: 2,
      }, 5, 2, 2);

      expect(result.targets).toContain('110');
      expect(result.R).toBe(5);
    });

    it('fixedRiskRewardClose=null 不插入 RR 目标，不覆盖 distribution', () => {
      // null = explicitly disabled, should behave like undefined
      const result = calc.calculate({
        entryPrice: 100,
        stopLoss: 95,
        side: 'buy',
        targets: ['102', '103'],
        tpDistribution: [0.6, 0.4],
        tpPaddingR: 0,
        tpOrderType: 'limit',
        fixedRiskRewardClose: null,
      }, 10, 2, 2);

      // Should NOT insert RR target
      expect(result.targets).toEqual(['102', '103']);
      // Should NOT force equal-split — tpDistribution [0.6, 0.4] should be used
      expect(result.distribution).toEqual([0.6, 0.4]);
      expect(result.allocated[0]).toBe(6);
      expect(result.allocated[1]).toBe(4);
    });

    it('TP padding 正确应用到价格', () => {
      // tpPaddingR=0.01, R=5 → price -= 0.05
      const result = calc.calculate({
        entryPrice: 100,
        stopLoss: 95,
        side: 'buy',
        targets: ['103'],
        tpDistribution: [1],
        tpPaddingR: 0.01,
        tpOrderType: 'limit',
        fixedRiskRewardClose: undefined,
      }, 5, 2, 2);

      // 103 - (5 * 0.01) = 102.95
      expect(result.tpOrders[0].price).toBe('102.95');
    });

    it('tpPaddingR=0 时 TP 保持信号原值（固定金额体系接线）', () => {
      // paddingMode='fixed' 时 OpenPositionService 传 tpPaddingR=0
      // → TP 不下修，断言与信号原值一致
      const result = calc.calculate({
        entryPrice: 100,
        stopLoss: 95,
        side: 'buy',
        targets: ['103'],
        tpDistribution: [1],
        tpPaddingR: 0,
        tpOrderType: 'limit',
        fixedRiskRewardClose: undefined,
      }, 5, 2, 2);

      // 103 - 0 = 103（与信号一致，不再按 0.01R 下修）；toFixed(2) → '103.00'
      expect(result.tpOrders[0].price).toBe('103.00');
      expect(result.targets).toEqual(['103']);
    });

    it('数量按精度截断', () => {
      const result = calc.calculate({
        entryPrice: 100,
        stopLoss: 95,
        side: 'buy',
        targets: ['102', '103'],
        tpDistribution: [0.5, 0.5],
        tpPaddingR: 0,
        tpOrderType: 'limit',
        fixedRiskRewardClose: undefined,
      }, 3, 2, 2);

      expect(result.allocated[0]).toBeCloseTo(1.5);
    });

    it('空 targets 返回等比 fallback (1:1 RR)', () => {
      const result = calc.calculate({
        entryPrice: 100,
        stopLoss: 95,
        side: 'buy',
        targets: [],
        tpDistribution: [],
        tpPaddingR: 0,
        tpOrderType: 'limit',
        fixedRiskRewardClose: undefined,
      }, 5, 2, 2);

      // Fallback: 1:1 RR = 100 + 5 = 105
      expect(result.targets).toEqual(['105']);
      expect(result.allocated).toEqual([5]);
    });

    it('R = |entry - stopLoss|', () => {
      const result = calc.calculate({
        entryPrice: 100,
        stopLoss: 90,
        side: 'buy',
        targets: [],
        tpDistribution: [],
        tpPaddingR: 0,
        tpOrderType: 'limit',
        fixedRiskRewardClose: undefined,
      }, 5, 2, 2);
      expect(result.R).toBe(10);
    });
  });
});
