import {
  setSimTime,
  simTimeMs,
  simNowDate,
  nowOrSim,
  setBacktestPriceProvider,
  getBacktestPrice,
} from '../../src/backtest/Clock';

describe('回测模拟时钟 (Clock)', () => {
  afterEach(() => {
    // 还原全局状态，避免影响其他用例
    setSimTime(null);
    setBacktestPriceProvider(null);
  });

  it('未设置模拟时间时处于实盘模式', () => {
    expect(simTimeMs()).toBeNull();
    expect(simNowDate()).toBeNull();
    // nowOrSim 在实盘模式返回当前真实时间（允许微小误差）
    const before = Date.now();
    const d = nowOrSim().getTime();
    const after = Date.now();
    expect(d).toBeGreaterThanOrEqual(before);
    expect(d).toBeLessThanOrEqual(after);
    // 无价格提供者：getBacktestPrice 恒为 null
    expect(getBacktestPrice('XAU_USDT')).toBeNull();
  });

  it('设置模拟时间后各接口返回同一模拟时刻', () => {
    const ms = Date.UTC(2025, 5, 1, 12, 30, 0);
    setSimTime(ms);
    expect(simTimeMs()).toBe(ms);
    expect(simNowDate()?.getTime()).toBe(ms);
    expect(nowOrSim().getTime()).toBe(ms);
    expect(nowOrSim().toISOString()).toBe('2025-06-01T12:30:00.000Z');

    setSimTime(null);
    expect(simTimeMs()).toBeNull();
  });

  it('价格提供者：有效价格透传，非法/异常价格返回 null', () => {
    setBacktestPriceProvider(symbol => {
      if (symbol === 'XAU_USDT') return 4325.5;
      if (symbol === 'BAD') return Number.NaN;
      if (symbol === 'NEG') return -1;
      if (symbol === 'ZERO') return 0;
      if (symbol === 'THROW') throw new Error('boom');
      return null;
    });

    expect(getBacktestPrice('XAU_USDT')).toBe(4325.5);
    expect(getBacktestPrice('BAD')).toBeNull();
    expect(getBacktestPrice('NEG')).toBeNull();
    expect(getBacktestPrice('ZERO')).toBeNull();
    expect(getBacktestPrice('THROW')).toBeNull();
    expect(getBacktestPrice('UNKNOWN')).toBeNull();
  });

  it('清除价格提供者后恢复 null', () => {
    setBacktestPriceProvider(() => 100);
    expect(getBacktestPrice('A')).toBe(100);
    setBacktestPriceProvider(null);
    expect(getBacktestPrice('A')).toBeNull();
  });
});
