/**
 * K 线 → tick 序列生成器。
 *
 * 虚拟撮合引擎以最新价驱动限价成交 / TP / SL 触发，回测引擎把每根 1m K 线
 * 展开为一串有序 tick 注入回放 MarketDataHub。
 *
 * 展开规则（业界常用近似，兼顾 TP/SL 同 K 线竞争的公平性）：
 *   O → 先试探「逆行极值」→ 再试探「顺行极值」→ C
 * 即阳线（c>=o）走 O→L→H→C，阴线走 O→H→L→C。
 * 这样开盘后价格先向不利于持仓方向摆动一格再折返，避免同一根 K 线内
 * 「顺行 TP 与逆行 SL 都被触达时永远先成交有利方向」的乐观偏差。
 */
import { BacktestCandle } from './CandleFetcher';

export interface ReplayTick {
  /** tick 对应的模拟时间（epoch 毫秒） */
  simTimeMs: number;
  price: number;
}

export const CANDLE_MS = 60_000;

/** 单根 K 线 → 4 个 tick（O → 逆行极值 → 顺行极值 → C） */
export function candleToTicks(candle: BacktestCandle): ReplayTick[] {
  const openMs = candle.ts * 1000;
  const bull = candle.c >= candle.o;
  // 盘中两个极值的时间锚点：逆行极值在前 1/3，顺行极值在后 2/3（近似）
  const adverseAt = openMs + Math.floor(CANDLE_MS / 3);
  const favorAt = openMs + Math.floor((CANDLE_MS * 2) / 3);
  const closeAt = openMs + CANDLE_MS - 1;

  const firstExtreme = bull ? candle.l : candle.h;
  const secondExtreme = bull ? candle.h : candle.l;

  return [
    { simTimeMs: openMs, price: candle.o },
    { simTimeMs: adverseAt, price: firstExtreme },
    { simTimeMs: favorAt, price: secondExtreme },
    { simTimeMs: closeAt, price: candle.c },
  ];
}

/** 整段 K 线 → tick 流（按时间升序） */
export function candlesToTicks(candles: BacktestCandle[]): ReplayTick[] {
  const ticks: ReplayTick[] = [];
  for (const candle of candles) {
    ticks.push(...candleToTicks(candle));
  }
  return ticks;
}

/**
 * 指定时刻（毫秒）之前最近一根已收盘 K 线的收盘价（供解析器市价守卫用）。
 *
 * 「已收盘」= 该 K 线收盘时刻（ts + 60s）<= 指定时刻；包含指定时刻的
 * 那根 K 线尚在盘中，其收盘价属于未来数据，不能用（避免前视偏差）。
 */
export function priceAtTime(candles: BacktestCandle[], timeMs: number): number | null {
  const tsSec = Math.floor(timeMs / 1000);
  const closedBefore = tsSec - CANDLE_MS / 1000;
  let latest: BacktestCandle | null = null;
  for (const candle of candles) {
    if (candle.ts > closedBefore) break;
    latest = candle;
  }
  return latest ? latest.c : null;
}
