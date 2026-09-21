import {
  candleToTicks,
  candlesToTicks,
  priceAtTime,
  CANDLE_MS,
  ReplayTick,
} from '../../src/backtest/TickGenerator';
import { BacktestCandle } from '../../src/backtest/CandleFetcher';

function candle(ts: number, o: number, h: number, l: number, c: number): BacktestCandle {
  return { ts, o, h, l, c } as BacktestCandle;
}

describe('TickGenerator（K线 → tick 展开）', () => {
  it('阳线按 O→L→H→C 展开（先逆行极值，避免乐观偏差）', () => {
    // 阳线：c >= o，逆行极值为 L，顺行极值为 H
    const c = candle(1000, 100, 120, 90, 110);
    const ticks = candleToTicks(c);
    expect(ticks).toHaveLength(4);
    expect(ticks.map(t => t.price)).toEqual([100, 90, 120, 110]);
  });

  it('阴线按 O→H→L→C 展开', () => {
    // 阴线：c < o，逆行极值为 H，顺行极值为 L
    const c = candle(1000, 110, 120, 90, 100);
    const ticks = candleToTicks(c);
    expect(ticks.map(t => t.price)).toEqual([110, 120, 90, 100]);
  });

  it('平盘线（c === o）按阳线规则处理', () => {
    const c = candle(1000, 100, 105, 95, 100);
    const ticks = candleToTicks(c);
    expect(ticks.map(t => t.price)).toEqual([100, 95, 105, 100]);
  });

  it('tick 时间锚点位于同一分钟内且单调不减', () => {
    const c = candle(1000, 100, 120, 90, 110);
    const ticks = candleToTicks(c);
    const openMs = 1000 * 1000;
    expect(ticks[0]!.simTimeMs).toBe(openMs);
    expect(ticks[1]!.simTimeMs).toBe(openMs + Math.floor(CANDLE_MS / 3));
    expect(ticks[2]!.simTimeMs).toBe(openMs + Math.floor((CANDLE_MS * 2) / 3));
    expect(ticks[3]!.simTimeMs).toBe(openMs + CANDLE_MS - 1);
    for (let i = 1; i < ticks.length; i++) {
      expect(ticks[i]!.simTimeMs).toBeGreaterThan(ticks[i - 1]!.simTimeMs);
    }
  });

  it('candlesToTicks 拼接多根 K 线并保持时间升序', () => {
    const candles = [
      candle(1000, 100, 120, 90, 110),
      candle(1060, 110, 130, 95, 105),
      candle(1120, 105, 108, 88, 102),
    ];
    const ticks = candlesToTicks(candles);
    expect(ticks).toHaveLength(12);
    for (let i = 1; i < ticks.length; i++) {
      expect(ticks[i]!.simTimeMs).toBeGreaterThan(ticks[i - 1]!.simTimeMs);
    }
    // 首尾对齐首根开盘与末根收盘
    expect(ticks[0]!.price).toBe(100);
    expect(ticks[ticks.length - 1]!.price).toBe(102);
  });

  it('priceAtTime 返回指定时刻前最近一根已收盘 K 线的收盘价', () => {
    const candles = [
      candle(1000, 100, 120, 90, 110), // [1000,1060)s
      candle(1060, 110, 130, 95, 105), // [1060,1120)s
      candle(1120, 105, 108, 88, 102),
    ];
    // 第一根 K 线尚在盘中（收盘于 1060s）
    expect(priceAtTime(candles, 1000 * 1000)).toBeNull();
    expect(priceAtTime(candles, 1059 * 1000)).toBeNull();
    // 第二根开始时第一根刚收盘
    expect(priceAtTime(candles, 1060 * 1000)).toBe(110);
    expect(priceAtTime(candles, 1119 * 1000)).toBe(110);
    expect(priceAtTime(candles, 1120 * 1000)).toBe(105);
    // 远超最后一根：仍返回最后一根收盘价
    expect(priceAtTime(candles, 9999 * 1000)).toBe(102);
  });
});
