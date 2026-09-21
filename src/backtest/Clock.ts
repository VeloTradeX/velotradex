/**
 * 回测模拟时钟与价格钩子（仅回测子进程内激活）。
 *
 * 设计约束：实盘进程中本模块状态永远为空（simMs=null / priceProvider=null），
 * 因此所有使用 simNowDate()/getBacktestPrice() 的调用点在实盘路径下行为完全不变。
 *
 * 回测子进程一次只运行一个回测，故用模块级全局状态即可（无需 ALS）。
 * 引擎在发布消息 / 注入 tick 前同步设置时钟，保证管线各环节写入的
 * createdAt / executedAt / closedAt 等时间戳与「原始信号时间 / K线触发时间」一致。
 */

let simMs: number | null = null;
let priceProvider: ((symbol: string) => number | null) | null = null;

/** 设置当前模拟时间（epoch 毫秒） */
export function setSimTime(ms: number | null): void {
  simMs = ms;
}

/** 当前模拟时间；非回测环境返回 null */
export function simTimeMs(): number | null {
  return simMs;
}

/** 当前模拟时间 Date；非回测环境返回 null */
export function simNowDate(): Date | null {
  return simMs === null ? null : new Date(simMs);
}

/** 时间戳写入点统一助手：回测环境用模拟时间，实盘保持 new Date() */
export function nowOrSim(): Date {
  return simMs === null ? new Date() : new Date(simMs);
}

/**
 * 注册回测价格提供者：marketService.getCurrentPrice 优先咨询它，
 * 返回当前模拟时刻该品种的价格（来自回放 K 线）；实盘环境为 null。
 */
export function setBacktestPriceProvider(provider: ((symbol: string) => number | null) | null): void {
  priceProvider = provider;
}

/** 询问回测价格（symbol 归一化前由调用方处理）；无提供者/无价格返回 null */
export function getBacktestPrice(symbol: string): number | null {
  if (!priceProvider) return null;
  try {
    const price = priceProvider(symbol);
    return Number.isFinite(price as number) && (price as number) > 0 ? (price as number) : null;
  } catch {
    return null;
  }
}
