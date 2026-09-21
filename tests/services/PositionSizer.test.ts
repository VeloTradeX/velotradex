// tests/services/PositionSizer.test.ts
import { PositionSizer } from '../../src/services/PositionSizer';
import { StrategyRiskConfig } from '../../src/services/parsers/types';

describe('PositionSizer', () => {
  const sizer = new PositionSizer();

  const makeMarket = (multiplier = 0.0001, amountPrecision = 2) => ({
    symbol: 'BTC_USDT',
    multiplier: multiplier.toString(),
    leverageMax: '125',
    amountPrecision,
  });

  const makeBalance = (total = 10000) => ({ total: total.toString(), available: total.toString() });

  const makeRiskConfig = (overrides: Partial<StrategyRiskConfig> = {}): StrategyRiskConfig => ({
    riskMode: 'percentage',
    riskValue: 1,
    defaultLeverage: '10',
    priceTolerance: 0.005,
    entryPaddingR: 0,
    tpPaddingR: 0,
    slPaddingR: 0,
    ...overrides,
  });

  describe('risk_based mode', () => {
    it('按风险百分比计算合约数', () => {
      // equity=10000, risk=1% → riskAmount=100, R=5, multiplier=0.0001
      // contracts = 100 / 5 / 0.0001 = 200000
      const result = sizer.calculate({
        balance: makeBalance(10000),
        market: makeMarket(0.0001, 2),
        entryPrice: 100,
        stopLoss: 95,
        riskConfig: makeRiskConfig({ riskMode: 'percentage', riskValue: 1 }),
        weight: undefined,
      });
      expect(result.contracts).toBe(200000);
      expect(result.riskAmount).toBeCloseTo(100);
    });

    it('应用权重 0.5 减半合约数', () => {
      const result = sizer.calculate({
        balance: makeBalance(10000),
        market: makeMarket(0.0001, 2),
        entryPrice: 100,
        stopLoss: 95,
        riskConfig: makeRiskConfig({ riskMode: 'percentage', riskValue: 1 }),
        weight: 0.5,
      });
      expect(result.contracts).toBe(100000); // half of 200K
    });

    it('fixed 风险模式直接使用金额', () => {
      const result = sizer.calculate({
        balance: makeBalance(10000),
        market: makeMarket(0.0001, 2),
        entryPrice: 100,
        stopLoss: 95,
        riskConfig: makeRiskConfig({ riskMode: 'fixed', riskValue: 50 }),
        weight: undefined,
      });
      // riskAmount=50, R=5, multiplier=0.0001
      // contracts = 50 / 5 / 0.0001 = 100000
      expect(result.contracts).toBe(100000);
      expect(result.riskAmount).toBe(50);
    });

    it('preserves decimal base amounts for Lighter spot-sized markets (floor)', () => {
      const result = sizer.calculate({
        balance: makeBalance(1000),
        market: makeMarket(1, 5),
        entryPrice: 81212,
        stopLoss: 79988,
        riskConfig: makeRiskConfig({ riskMode: 'fixed', riskValue: 1.5 }),
        weight: undefined,
      });

      // 1.5 / 1224 = 0.00122549...，向下取整到精度5 → 0.00122（不因进位突破风险预算）
      expect(result.contracts).toBe(0.00122);
      expect(result.amount).toBe('0.00122');
    });
  });

  describe('cross-exchange multiplier safety', () => {
    it('高乘数低精度品种（Gate CFD XAU）预算不足时升格到最小可交易单位而非拒单', () => {
      // 生产事故复现：riskValue=12.5, R=22.2, multiplier=100, amountPrecision=2
      // 12.5/22.2/100 = 0.00563 张 < 最小单位 0.01 张
      // 最小风险原则：可表达时 floor（上例预算充足场景）。此处预算不足，
      // 允许适当放大 → 升格到 0.01 张执行，避免信号失效
      const result = sizer.calculate({
        balance: makeBalance(1000),
        market: makeMarket(100, 2),
        entryPrice: 4436.8,
        stopLoss: 4459.0,
        riskConfig: makeRiskConfig({ riskMode: 'fixed', riskValue: 12.5 }),
        weight: undefined,
      });

      expect(result.contracts).toBe(0.01);
      expect(result.actualRisk).toBeCloseTo(0.01 * 100 * 22.2, 6);
      expect(result.underfunded).toBeDefined();
      expect(result.underfunded?.minUnit).toBe(0.01);
      expect(result.underfunded?.multiplier).toBe(100);
      expect(result.underfunded?.rawContracts).toBeGreaterThan(0);
      expect(result.underfunded?.rawContracts).toBeLessThan(0.01);
      expect(result.underfunded?.minUnitRisk).toBeCloseTo(0.01 * 100 * 22.2, 6);
    });

    it('同品种 Lighter 口径（multiplier=1, precision=4）可正常下单且实际风险不超预算', () => {
      const result = sizer.calculate({
        balance: makeBalance(1000),
        market: makeMarket(1, 4),
        entryPrice: 4436.8,
        stopLoss: 4459.0,
        riskConfig: makeRiskConfig({ riskMode: 'fixed', riskValue: 12.5 }),
        weight: undefined,
      });

      // 12.5 / 22.2 = 0.56306... → floor 精度4 → 0.563，实际风险 0.563×22.2 = 12.4986 ≤ 12.5
      expect(result.contracts).toBe(0.563);
      expect(result.underfunded).toBeUndefined();
      expect(result.actualRisk).toBeLessThanOrEqual(12.5);
    });

    it('风险预算充足时高乘数品种按 floor 下单，实际风险不超设定', () => {
      // riskValue=100, R=22.2, multiplier=100 → 100/22.2/100 = 0.045045 ≥ 0.01 → floor 0.04
      // （旧 round 逻辑得 0.05，实际风险 111 > 100；floor 得 0.04，更符合最小风险原则）
      const result = sizer.calculate({
        balance: makeBalance(1000),
        market: makeMarket(100, 2),
        entryPrice: 4436.8,
        stopLoss: 4459.0,
        riskConfig: makeRiskConfig({ riskMode: 'fixed', riskValue: 100 }),
        weight: undefined,
      });

      expect(result.contracts).toBe(0.04);
      expect(result.actualRisk).toBeCloseTo(0.04 * 100 * 22.2, 6);
      expect(result.actualRisk).toBeLessThanOrEqual(100);
      expect(result.underfunded).toBeUndefined();
    });

    it('整数精度品种向下取整避免 round 进位突破（33.5 → 33 而非 34）', () => {
      // riskAmount=100.5, R=3, multiplier=1, precision=0 → 33.5
      // round 会得 34（风险 102 > 100.5），floor 得 33（风险 99）
      const result = sizer.calculate({
        balance: makeBalance(1000),
        market: makeMarket(1, 0),
        entryPrice: 100,
        stopLoss: 97,
        riskConfig: makeRiskConfig({ riskMode: 'fixed', riskValue: 100.5 }),
        weight: undefined,
      });

      expect(result.contracts).toBe(33);
      expect(result.actualRisk).toBeCloseTo(99, 6);
    });

    it('actualRisk 按乘数换算真实敞口', () => {
      const result = sizer.calculate({
        balance: makeBalance(10000),
        market: makeMarket(0.0001, 2),
        entryPrice: 100,
        stopLoss: 95,
        riskConfig: makeRiskConfig({ riskMode: 'percentage', riskValue: 1 }),
        weight: undefined,
      });

      expect(result.contracts).toBe(200000);
      expect(result.actualRisk).toBeCloseTo(200000 * 0.0001 * 5, 6);
    });

    it('size_based 模式同样升格到最小单位并标记 underfunded', () => {
      const result = sizer.calculate({
        balance: makeBalance(1000),
        market: makeMarket(100, 2),
        entryPrice: 4436.8,
        stopLoss: 4459.0,
        riskConfig: makeRiskConfig({ riskMode: 'fixed', riskValue: 12.5, positionSizingMode: 'size_based' }),
        weight: undefined,
        averageEntryPrice: 4436.8,
      });

      expect(result.contracts).toBe(0.01);
      expect(result.underfunded).toBeDefined();
    });
  });

  describe('size_based mode', () => {
    it('按平均入场价计算仓位大小', () => {
      const result = sizer.calculate({
        balance: makeBalance(10000),
        market: makeMarket(0.0001, 4),
        entryPrice: 100,
        stopLoss: 95,
        riskConfig: makeRiskConfig({ riskMode: 'percentage', riskValue: 1, positionSizingMode: 'size_based' }),
        weight: undefined,
        averageEntryPrice: 100,
      });
      // riskAmount=100, avgR=5, totalSizeCoins=20, contracts=round(20/0.0001)=200000
      expect(result.contracts).toBe(200000);
    });

    it('size_based 应用权重', () => {
      const result = sizer.calculate({
        balance: makeBalance(10000),
        market: makeMarket(0.0001, 4),
        entryPrice: 100,
        stopLoss: 95,
        riskConfig: makeRiskConfig({ riskMode: 'percentage', riskValue: 1, positionSizingMode: 'size_based' }),
        weight: 0.5,
        averageEntryPrice: 100,
      });
      expect(result.contracts).toBe(100000); // half of 200K
    });
  });

  describe('boundary conditions', () => {
    it('equity=0 返回 0 合约', () => {
      const result = sizer.calculate({
        balance: makeBalance(0),
        market: makeMarket(0.0001, 2),
        entryPrice: 100,
        stopLoss: 95,
        riskConfig: makeRiskConfig({ riskMode: 'percentage', riskValue: 1 }),
        weight: undefined,
      });
      expect(result.contracts).toBe(0);
    });

    it('R=0 返回 0 合约', () => {
      const result = sizer.calculate({
        balance: makeBalance(10000),
        market: makeMarket(0.0001, 2),
        entryPrice: 100,
        stopLoss: 100,
        riskConfig: makeRiskConfig({ riskMode: 'percentage', riskValue: 1 }),
        weight: undefined,
      });
      expect(result.contracts).toBe(0);
    });

    it('maxPositionSize 上限裁剪', () => {
      // Without cap: 10000*0.01/5/0.0001 = 20000
      // With cap: maxContracts = (100 / 100) / 0.0001 = 10000
      const result = sizer.calculate({
        balance: makeBalance(10000),
        market: makeMarket(0.0001, 2),
        entryPrice: 100,
        stopLoss: 95,
        riskConfig: makeRiskConfig({ riskMode: 'percentage', riskValue: 1, maxPositionSize: 100 }),
        weight: undefined,
      });
      expect(result.contracts).toBe(10000);
    });
  });

  describe('ratio_based riskMode', () => {
    it('uses quantity from signal directly', () => {
      const result = sizer.calculate({
        balance: makeBalance(10000),
        market: makeMarket(0.0001, 2),
        entryPrice: 100,
        stopLoss: 95,
        riskConfig: makeRiskConfig({ riskMode: 'ratio_based', riskValue: 1 }),
        weight: undefined,
        quantity: 3,
      });
      expect(result.contracts).toBe(3);
      expect(result.sizingMode).toBe('ratio_based');
    });

    it('scales quantity by riskValue as multiplier', () => {
      const result = sizer.calculate({
        balance: makeBalance(10000),
        market: makeMarket(0.0001, 2),
        entryPrice: 100,
        stopLoss: 95,
        riskConfig: makeRiskConfig({ riskMode: 'ratio_based', riskValue: 2 }),
        weight: undefined,
        quantity: 3,
      });
      expect(result.contracts).toBe(6); // 3 * 2
    });

    it('defaults to 1 contract when quantity is not provided', () => {
      const result = sizer.calculate({
        balance: makeBalance(10000),
        market: makeMarket(0.0001, 2),
        entryPrice: 100,
        stopLoss: 95,
        riskConfig: makeRiskConfig({ riskMode: 'ratio_based', riskValue: 1 }),
        weight: undefined,
      });
      expect(result.contracts).toBe(1);
    });

    it('ignores positionSizingMode when riskMode is ratio_based', () => {
      const result = sizer.calculate({
        balance: makeBalance(10000),
        market: makeMarket(0.0001, 2),
        entryPrice: 100,
        stopLoss: 95,
        riskConfig: makeRiskConfig({ riskMode: 'ratio_based', riskValue: 1, positionSizingMode: 'size_based' }),
        weight: undefined,
        quantity: 5,
      });
      expect(result.contracts).toBe(5); // positionSizingMode ignored
    });

    it('does not require stopLoss (R=0 is fine)', () => {
      const result = sizer.calculate({
        balance: makeBalance(10000),
        market: makeMarket(0.0001, 2),
        entryPrice: 100,
        stopLoss: 100, // R = 0
        riskConfig: makeRiskConfig({ riskMode: 'ratio_based', riskValue: 1 }),
        weight: undefined,
        quantity: 2,
      });
      expect(result.contracts).toBe(2);
    });

    it('rounds fractional results and enforces minimum 1', () => {
      const result = sizer.calculate({
        balance: makeBalance(10000),
        market: makeMarket(0.0001, 2),
        entryPrice: 100,
        stopLoss: 95,
        riskConfig: makeRiskConfig({ riskMode: 'ratio_based', riskValue: 0.3 }),
        weight: undefined,
        quantity: 2,
      });
      expect(result.contracts).toBe(1); // 2 * 0.3 = 0.6, rounds to 1 (minimum)
    });
  });
});
