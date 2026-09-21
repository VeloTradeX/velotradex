/**
 * CfdSessionGuard —— Gate-CFD（/tradfi/*）交易时段守卫。
 *
 * 背景：CFD 与 7×24 的加密合约不同，有固定交易时段（如 XAUUSD 周一至周五
 * 交易、周末休市）。ticker 通过 status / openTime / closeTime / tradeMode
 * 描述当前时段，本模块据此在信号到达时判断是否可下单：
 *   - 休市 → 拒单并审计 MARKET_CLOSED（见 内部设计文档 §3.7）
 *   - Trigger（限价）挂单跨休市是合法的：交易所侧保留挂单，由 CfdOrderPoller
 *     在开市后继续跟踪成交，本守卫不做拦截。
 *
 * 纯函数、零外部依赖，便于单测与复用。
 */

// ---------------------------------------------------------------------------
// 类型与常量
// ---------------------------------------------------------------------------

/** ticker 中与交易时段相关的字段（对应 gate-api TradFiTickerData 的子集） */
export interface CfdTickerLike {
  /** 交易所状态：'OPEN'/'TRADING'（开市）、'CLOSED'/'PAUSED'（休市）等 */
  status?: string;
  /** 本时段开市时间（epoch，秒或毫秒） */
  openTime?: number;
  /** 本时段闭市时间（epoch，秒或毫秒） */
  closeTime?: number;
  /** 下一时段开市时间（epoch，秒或毫秒；供 poller 提示用，不参与本次判断） */
  nextOpenTime?: number;
  /** 交易时段描述（如 "Mon-Fri 22:00-06:00"），用于可读化提示 */
  tradeMode?: string;
}

/** 当前时间提供者：返回毫秒时间戳；注入便于测试 */
export type NowProvider = () => number;

/**
 * epoch 时间戳单位判定阈值：
 * 1e12 毫秒 ≈ 2001-09，秒级时间戳 1e12 ≈ 33658 年 —— 用 1e12 区分两种单位。
 */
const MS_UNIT_THRESHOLD = 1e12;

/** 明确表示休市的状态（直接拦截，不再走时段窗口判断） */
const CLOSED_STATUSES = new Set(['CLOSED', 'PAUSED', 'HALTED', 'SUSPENDED', 'CLOSE', 'NOT_TRADING']);

/** 明确表示开市的状态（直接放行，信任交易所状态优先于本地时间窗） */
const OPEN_STATUSES = new Set(['OPEN', 'TRADING', 'LIVE']);

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------

/** 统一转为毫秒：> 1e12 视为毫秒原样返回；否则视为秒 ×1000；非法值返回 0 */
function toEpochMs(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return 0;
  return value > MS_UNIT_THRESHOLD ? value : value * 1000;
}

/** 把毫秒时间戳格式化为本地 HH:mm，用于 reason 可读化 */
function formatHHmm(ms: number): string {
  if (ms <= 0) return '未知';
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * 核心判断：ticker 是否处于开市状态（无状态版本）。
 *
 * 判断规则（按优先级）：
 * 1. status 明确表示休市（'CLOSED'/'PAUSED' 等）→ 直接 false；
 *    status 明确表示开市（'OPEN'/'TRADING' 等）→ 直接 true（以交易所状态为准）。
 * 2. openTime/closeTime 为 epoch 时间戳：
 *    - 值 > 1e12 视为毫秒原样使用，否则视为秒并 ×1000 换算为毫秒（兼容两种单位）；
 *    - openTime<=0 或 closeTime<=0（缺失/非法）→ 无时段信息，视为开放（兜底，避免误拒）。
 * 3. 常规时段 openTime < closeTime：now 落在 [openTime, closeTime) 内为开放。
 * 4. 跨午夜时段 openTime > closeTime（如 22:00-06:00）：now ≥ openTime 或 now < closeTime 为开放。
 * 5. openTime === closeTime（退化的 24h 时段）：视为开放，避免误拒。
 */
export function isSessionOpen(ticker: CfdTickerLike, now: number = Date.now()): boolean {
  // 规则 1：交易所状态优先
  const status = ticker.status ? String(ticker.status).trim().toUpperCase() : '';
  if (status && CLOSED_STATUSES.has(status)) return false;
  if (status && OPEN_STATUSES.has(status)) return true;

  // 规则 2：时段时间戳换算（秒/毫秒兼容），缺失或非法视为无时段信息
  const openMs = toEpochMs(ticker.openTime);
  const closeMs = toEpochMs(ticker.closeTime);
  if (openMs <= 0 || closeMs <= 0) return true; // 兜底：无时段信息 → 开放，避免误拒

  // 规则 3 / 4 / 5：常规时段、跨午夜时段、退化时段
  if (openMs === closeMs) return true; // 24h 时段，全程开放
  if (openMs < closeMs) {
    return now >= openMs && now < closeMs;
  }
  // 跨午夜：now ≥ 开市时间（当日后半段）或 now < 闭市时间（次日凌晨段）
  return now >= openMs || now < closeMs;
}

// ---------------------------------------------------------------------------
// CfdSessionGuard
// ---------------------------------------------------------------------------

export class CfdSessionGuard {
  private readonly nowProvider: NowProvider;

  /**
   * @param nowProvider 当前毫秒时间戳提供者，缺省 Date.now()；注入便于测试固定时刻。
   */
  constructor(nowProvider: NowProvider = Date.now) {
    this.nowProvider = nowProvider;
  }

  /** ticker 是否开市（实例方法，使用注入的 nowProvider） */
  isOpen(ticker: CfdTickerLike): boolean {
    return isSessionOpen(ticker, this.nowProvider());
  }

  /**
   * 交易前校验：休市时返回 ok=false，reason 含「休市 / MARKET_CLOSED」中文说明。
   * 供信号到达时（OpenPositionService / 审计）调用。
   */
  checkCanTrade(ticker: CfdTickerLike): { ok: boolean; reason?: string } {
    if (this.isOpen(ticker)) return { ok: true };

    const tradeMode = ticker.tradeMode ? `，时段说明：${ticker.tradeMode}` : '';
    const reason =
      `市场休市（MARKET_CLOSED）：当前不在 CFD 交易时段内，暂不可下单` +
      `（开市 ${formatHHmm(toEpochMs(ticker.openTime))}，闭市 ${formatHHmm(toEpochMs(ticker.closeTime))}）` +
      tradeMode;

    return { ok: false, reason };
  }
}
