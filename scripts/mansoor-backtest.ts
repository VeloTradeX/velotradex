/**
 * Mansoor 解析器回测工具（单入场 · 多止盈逐层 · 1 分钟 K 线 · 收盘价模型）。
 *
 * 回测方法论（与 kacang-backtest.ts / huice 框架对齐）：
 * - K 线周期固定 1 分钟，数据源 Gate.io tradfi（XAUUSD 现货金），本地缓存到 data/backtest_cache。
 * - 入场：信号后第一根命中 K 线收盘价成交（Mansoor 为即时市价信号，指定入场价仅作参考列）。
 * - 出场：用 K 线最高/最低价触发，按多空方向应用让点。
 *   * 止损让点统一 1.2；止盈让点：仅 1 个止盈点让 5.2，多个止盈点（≥2）统一让 1.5。
 *   * 多个止盈点按层逐层止盈（每层 1/N 仓位），逐根 K 线触发。
 *   * 同根 K 线 TP/SL 冲突裁决：取离入场价更近的价位成交（保守）。
 * - 持仓过夜/过周末不设超时；数据结束仍未平仓记为「未平仓」(open)，未平部分不计浮盈亏。
 *
 * 双方案对比：
 * - S1 严格：严格按照信号的 TP/SL 逐层止盈、止损离场。
 * - S2 保本：盈亏比达到 1 倍（浮盈 = 止损距离）时，将止损移动至开仓价（保本）；
 *   此后价格回落触及开仓价即保本平仓，继续上行则拿到止盈；其余让点与 S1 完全一致。
 *
 * 资金/仓位模型：
 * - 初始资金默认 $1000，每单风险默认 $50。
 * - XAU 合约：0.01 手 = 1 盎司，1 美元价差 = 1 美元盈亏；手数下限 0.01、上限 0.02。
 * - 仓位(盎司) = clamp(50 / |入场价 - 有效止损价|, 1, 2)（对应 0.01 ~ 0.02 手）。
 * - 回测结果同时输出盈亏点位（pips）与美元盈亏、账户余额，并按月/按周统计收益，
 *   明细列含「信号来源」列（程序解析 / AI 图片解析）。
 *
 * 用法：
 *   # 阶段二：读取信号文件，拉取 K 线回测，导出 XLSX（默认 docs/backtest/MansoorParser_{时间戳}.xlsx）
 *   npx ts-node scripts/mansoor-backtest.ts backtest \
 *     --input examples/mansoor_signals.json
 */
import fs from 'fs';
import path from 'path';
import axios from 'axios';
import AdmZip from 'adm-zip';
import { Command } from 'commander';
import * as XLSX from 'xlsx-js-style';

// ─── 类型 ────────────────────────────────────────────────────────────────

type Candle = { ts: number; o: number; h: number; l: number; c: number };

type MansoorSignal = {
  id: number;
  timestamp: string;
  symbol: string;
  side: 'buy' | 'sell';
  entryPrice: number | null; // 信号指定入场价（可能为 null = 市价）
  entries: number[];
  tps: number[]; // 1 个或多个止盈点
  sl: number | null;
  rawMessage: string;
  sourceType: string;
  backtest: MansoorResult | null;
};

type MansoorResult = {
  signalId: number;
  timestamp: string;
  direction: string;
  sourceType: string;
  entryPrice: number | null; // 信号指定入场价
  actualEntry: number | null; // 实际入场价（收盘价）
  tps: number[];
  sl: number | null;
  effTps: (number | null)[];
  effSl: number | null;
  outcome: 'tp' | 'sl' | 'be' | 'open' | 'no_data';
  tpHitCount: number;
  beHit: boolean; // 保本离场（S2）
  slHit: boolean;
  tpExitTimes: (number | null)[];
  slExitTime: number | null;
  beExitTime: number | null;
  durationMin: number | null;
  maxFavorablePrice: number | null;
  maxFavorablePips: number;
  profitPips: number;
  positionSize: number | null; // 盎司
  lotSize: number | null; // 手
  profitUsd: number;
  accountBalance: number;
};

type SignalsFile = {
  meta: { parser: string; source: string; parsedAt: string; textOnly: boolean };
  signals: MansoorSignal[];
};

// ─── 常量 ────────────────────────────────────────────────────────────────

const GATE_API_BASE = 'https://api.gateio.ws/api/v4';
const CFD_SYMBOL_MAP: Record<string, string> = { XAU_USDT: 'XAUUSD' };
const TRADFI_PAGE_SIZE = 500;

// 让点（USDT）：止损统一让 1.2；止盈让点按止盈点数量区分
const SL_SLIPPAGE = 1.2;
const TP_SLIPPAGE_SINGLE = 5.2; // 仅 1 个止盈点
const TP_SLIPPAGE_MULTI = 1.5; // 多个止盈点（≥2）

// ─── 回测方案定义 ────────────────────────────────────────────────────────
type BacktestMode = {
  key: string;
  name: string;
  desc: string;
  breakeven: boolean; // true=盈亏比 1 倍后止损移至开仓价保本
};

const BACKTEST_MODES: BacktestMode[] = [
  {
    key: 's1',
    name: '方案1 · 严格止盈止损',
    desc: '严格按照信号的 TP/SL 逐层止盈、止损离场',
    breakeven: false,
  },
  {
    key: 's2',
    name: '方案2 · 盈亏比1倍保本',
    desc: '盈亏比达 1 倍时止损移至开仓价保本，其余不变',
    breakeven: true,
  },
];

// ─── 回测统计（含权益曲线与最大回撤） ────────────────────────────────────
type BacktestStats = {
  modeKey: string;
  modeName: string;
  totalSignals: number;
  filled: number;
  tpCount: number;
  slCount: number;
  beCount: number;
  openCount: number;
  noDataCount: number;
  wins: number;
  losses: number;
  winRate: number;
  totalProfitUsd: number;
  totalProfitPips: number;
  netProfit: number;
  returnPct: number;
  profitFactor: number;
  avgWin: number;
  avgLoss: number;
  maxProfitTrade: number;
  maxLossTrade: number;
  buyCount: number;
  buyWins: number;
  buyProfit: number;
  sellCount: number;
  sellWins: number;
  sellProfit: number;
  maxDrawdownUsd: number;
  maxDrawdownPct: number;
  initialCapital: number;
  finalBalance: number;
};

// ─── K 线获取（公开接口，缓存到 data/backtest_cache，不写主库） ───────────

async function fetchTradFiKlines(apiSymbol: string, interval: string, startTs: number, endTs: number): Promise<Candle[]> {
  const candles: Candle[] = [];
  let currentEnd = Math.floor(endTs);
  while (currentEnd > startTs) {
    const { data } = await axios.get(`${GATE_API_BASE}/tradfi/symbols/${apiSymbol}/klines`, {
      params: { kline_type: interval, end_time: Math.floor(currentEnd), limit: TRADFI_PAGE_SIZE },
      timeout: 30000,
    });
    const list: any[] = data?.data?.list || [];
    if (!list.length) break;
    for (const c of list) {
      const t = Number(c.t);
      if (t >= startTs && t <= endTs) {
        candles.push({ ts: t, o: Number(c.o), h: Number(c.h), l: Number(c.l), c: Number(c.c) });
      }
    }
    const earliest = Math.min(...list.map((c) => Number(c.t)));
    if (earliest <= startTs) break;
    currentEnd = earliest - 60;
    if (candles.length > 300000) break;
  }
  candles.sort((a, b) => a.ts - b.ts);
  return candles;
}

function loadCachedKlines(cacheFile: string): Candle[] | null {
  if (!fs.existsSync(cacheFile)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    return Array.isArray(data.candles) ? data.candles : null;
  } catch {
    return null;
  }
}

function saveCachedKlines(cacheFile: string, candles: Candle[], symbol: string, interval: string): void {
  fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
  fs.writeFileSync(cacheFile, JSON.stringify({ meta: { symbol, interval, count: candles.length, cachedAt: new Date().toISOString() }, candles }));
}

async function getKlines(symbol: string, interval: string, startTs: number, endTs: number, cacheDir: string): Promise<Candle[]> {
  const apiSymbol = CFD_SYMBOL_MAP[symbol] || symbol.replace(/_USDT$/, '');
  const cacheFile = path.join(cacheDir, `${apiSymbol}_${interval}.json`);
  const cached = loadCachedKlines(cacheFile);
  if (cached && cached.length) {
    if (cached[0].ts <= startTs && cached[cached.length - 1].ts >= endTs) {
      console.log(`  [${symbol}] 命中 K 线缓存 ${cached.length} 根 (${apiSymbol})`);
      return cached;
    }
    console.log(`  [${symbol}] 缓存范围不足，重新拉取`);
  }
  console.log(`  [${symbol}] 拉取 ${apiSymbol} ${interval} K 线...`);
  const candles = await fetchTradFiKlines(apiSymbol, interval, startTs, endTs);
  saveCachedKlines(cacheFile, candles, symbol, interval);
  console.log(`  [${symbol}] 拉取完成 ${candles.length} 根 → ${cacheFile}`);
  return candles;
}

// ─── 工具 ────────────────────────────────────────────────────────────────

function bisectRight(tsList: number[], target: number): number {
  let lo = 0;
  let hi = tsList.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (tsList[mid] <= target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

function tpSlippageFor(tps: number[]): number {
  return tps.length <= 1 ? TP_SLIPPAGE_SINGLE : TP_SLIPPAGE_MULTI;
}

// ─── 回测引擎（1m K 线 · 收盘价入场 · 多TP逐层） ───────────────────────

function backtestSignal(signal: MansoorSignal, candles: Candle[], riskPerTrade: number, mode: BacktestMode): MansoorResult {
  const result: MansoorResult = {
    signalId: signal.id,
    timestamp: signal.timestamp,
    direction: signal.side,
    sourceType: signal.sourceType,
    entryPrice: signal.entryPrice,
    actualEntry: null,
    tps: signal.tps,
    sl: signal.sl,
    effTps: [],
    effSl: null,
    outcome: 'no_data',
    tpHitCount: 0,
    beHit: false,
    slHit: false,
    tpExitTimes: [],
    slExitTime: null,
    beExitTime: null,
    durationMin: null,
    maxFavorablePrice: null,
    maxFavorablePips: 0,
    profitPips: 0,
    positionSize: null,
    lotSize: null,
    profitUsd: 0,
    accountBalance: 0,
  };

  if (!candles.length || signal.sl == null || !signal.tps.length) {
    return result;
  }

  const signalTime = new Date(signal.timestamp).getTime() / 1000;
  if (!Number.isFinite(signalTime)) return result;

  const isBuy = signal.side === 'buy';
  const tsList = candles.map((c) => c.ts);
  const startIdx = bisectRight(tsList, signalTime);
  if (startIdx >= candles.length) {
    result.outcome = 'no_data';
    return result;
  }

  // 让点后的有效 TP / SL
  const tpSlip = tpSlippageFor(signal.tps);
  const effTps = signal.tps.map((tp) => round2(isBuy ? tp - tpSlip : tp + tpSlip));
  const effSl = round2(isBuy ? signal.sl! + SL_SLIPPAGE : signal.sl! - SL_SLIPPAGE);
  result.effTps = effTps;
  result.effSl = effSl;

  // ── 入场：信号后第一根 K 线收盘价 ──
  const entryIdx = startIdx;
  const entryPrice = candles[entryIdx].c;
  result.actualEntry = round2(entryPrice);
  const entryTime = candles[entryIdx].ts;

  const N = signal.tps.length;
  const remaining: number[] = new Array(N).fill(1 / N); // 每层剩余仓位比例

  // 总仓位（盎司）：clamp(risk / 有效止损距离, 1, 2) → 0.01~0.02 手
  const dist = Math.abs(entryPrice - effSl);
  const totalSizeOz = dist > 0 ? clamp(riskPerTrade / dist, 1, 2) : 1;
  const layerSize = totalSizeOz / N; // 每层仓位（盎司）

  // ── 出场（从入场 K 线的下一根开始）──
  const rl = Math.abs(entryPrice - signal.sl!); // 止损距离（盈亏比 1 倍阈值）
  let breakevenArmed = false; // S2：盈亏比已达 1 倍，止损移至开仓价
  let lastExitTime: number | null = null;
  let lastExitType: 'tp' | 'sl' | 'be' | null = null;
  let maxFavorable = entryPrice;

  for (let j = entryIdx + 1; j < candles.length; j++) {
    const c = candles[j];
    const high = c.h;
    const low = c.l;

    if (remaining.some((r) => r > 0)) {
      maxFavorable = isBuy ? Math.max(maxFavorable, high) : Math.min(maxFavorable, low);
    }

    // S2：盈亏比达 1 倍（浮盈 = 止损距离）→ 止损移至开仓价
    if (mode.breakeven && !breakevenArmed) {
      const rrReached = isBuy ? high >= entryPrice + rl : low <= entryPrice - rl;
      if (rrReached) breakevenArmed = true;
    }

    // 当前有效止损：S2 且已触发盈亏比 1 倍 → 开仓价（保本）；否则原始有效止损
    const stop = breakevenArmed ? entryPrice : effSl;

    for (let i = 0; i < N; i++) {
      if (remaining[i] <= 0) continue;
      const tpTouch = effTps[i] != null && ((isBuy && high >= effTps[i]!) || (!isBuy && low <= effTps[i]!));
      const slTouch = (isBuy && low <= stop) || (!isBuy && high >= stop);
      let exitPrice: number | null = null;
      let exitType: 'tp' | 'sl' | 'be' | null = null;

      if (tpTouch && slTouch) {
        // 同根 TP/SL 冲突：取离入场价更近的价位（保守）
        if (Math.abs(effTps[i]! - entryPrice) <= Math.abs(stop - entryPrice)) {
          exitPrice = effTps[i]!;
          exitType = 'tp';
        } else {
          exitPrice = stop;
          exitType = breakevenArmed ? 'be' : 'sl';
        }
      } else if (tpTouch) {
        exitPrice = effTps[i]!;
        exitType = 'tp';
      } else if (slTouch) {
        exitPrice = stop;
        exitType = breakevenArmed ? 'be' : 'sl';
      }

      if (exitPrice != null && exitType != null) {
        // 记录该层盈亏（按每层固定仓位计算）
        result.profitUsd += (isBuy ? exitPrice - entryPrice : entryPrice - exitPrice) * layerSize;
        result.profitPips += (isBuy ? exitPrice - entryPrice : entryPrice - exitPrice) * 100;
        remaining[i] = 0;
        lastExitTime = c.ts;
        lastExitType = exitType;
        if (exitType === 'tp') {
          result.tpHitCount += 1;
          result.tpExitTimes[i] = c.ts;
        } else if (exitType === 'be') {
          result.beHit = true;
          result.beExitTime = c.ts;
        } else {
          result.slHit = true;
          result.slExitTime = c.ts;
        }
      }
    }

    if (remaining.every((r) => r <= 0)) break;
  }

  // ── 汇总 ──
  const anyFilled = startIdx < candles.length;
  if (anyFilled) {
    if (lastExitType === 'tp') result.outcome = 'tp';
    else if (lastExitType === 'be') result.outcome = 'be';
    else if (lastExitType === 'sl') result.outcome = 'sl';
    else result.outcome = 'open';
  } else {
    result.outcome = 'no_data';
  }

  const endTime = lastExitTime ?? candles[candles.length - 1].ts;
  result.durationMin = Math.round((endTime - entryTime) / 60);
  result.maxFavorablePrice = round2(maxFavorable);
  result.maxFavorablePips = round1(Math.abs(maxFavorable - entryPrice) * 100);

  // 仓位（盎司）：clamp(risk / 有效止损距离, 1, 2) → 0.01~0.02 手
  result.positionSize = round2(totalSizeOz);
  result.lotSize = round2(totalSizeOz / 100);
  result.profitUsd = round2(result.profitUsd);
  result.profitPips = round1(result.profitPips);

  return result;
}

// ─── 多方案统计汇总（含权益曲线与最大回撤） ─────────────────────────────────

function computeStats(mode: BacktestMode, results: MansoorResult[], initialCapital: number): BacktestStats {
  let capital = initialCapital;
  let peak = initialCapital;
  let maxDrawdownUsd = 0;
  let maxDrawdownPct = 0;

  const sorted = [...results].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  for (const r of sorted) {
    capital += r.profitUsd;
    if (capital > peak) peak = capital;
    const ddUsd = peak - capital;
    if (ddUsd > maxDrawdownUsd) maxDrawdownUsd = ddUsd;
    if (peak > 0 && ddUsd / peak > maxDrawdownPct) maxDrawdownPct = ddUsd / peak;
  }

  const filled = results.filter((r) => r.outcome !== 'no_data');
  const wins = results.filter((r) => r.profitUsd > 0);
  const losses = results.filter((r) => r.profitUsd < 0);
  const closed = wins.length + losses.length;
  const totalProfitUsd = results.reduce((s, r) => s + r.profitUsd, 0);
  const totalProfitPips = results.reduce((s, r) => s + r.profitPips, 0);
  const avgWin = wins.length ? wins.reduce((s, r) => s + r.profitUsd, 0) / wins.length : 0;
  const avgLoss = losses.length ? losses.reduce((s, r) => s + Math.abs(r.profitUsd), 0) / losses.length : 0;
  const profitFactor = avgLoss > 0 ? avgWin / avgLoss : Infinity;

  const buy = results.filter((r) => r.direction === 'buy');
  const sell = results.filter((r) => r.direction === 'sell');
  const maxProfitTrade = results.length ? Math.max(...results.map((r) => r.profitUsd)) : 0;
  const maxLossTrade = results.length ? Math.min(...results.map((r) => r.profitUsd)) : 0;

  return {
    modeKey: mode.key,
    modeName: mode.name,
    totalSignals: results.length,
    filled: filled.length,
    tpCount: results.filter((r) => r.outcome === 'tp').length,
    slCount: results.filter((r) => r.outcome === 'sl').length,
    beCount: results.filter((r) => r.outcome === 'be').length,
    openCount: results.filter((r) => r.outcome === 'open').length,
    noDataCount: results.filter((r) => r.outcome === 'no_data').length,
    wins: wins.length,
    losses: losses.length,
    winRate: closed ? wins.length / closed : 0,
    totalProfitUsd,
    totalProfitPips,
    netProfit: totalProfitUsd,
    returnPct: initialCapital ? (totalProfitUsd / initialCapital) * 100 : 0,
    profitFactor,
    avgWin,
    avgLoss,
    maxProfitTrade: round2(maxProfitTrade),
    maxLossTrade: round2(maxLossTrade),
    buyCount: buy.length,
    buyWins: buy.filter((r) => r.profitUsd > 0).length,
    buyProfit: buy.reduce((s, r) => s + r.profitUsd, 0),
    sellCount: sell.length,
    sellWins: sell.filter((r) => r.profitUsd > 0).length,
    sellProfit: sell.reduce((s, r) => s + r.profitUsd, 0),
    maxDrawdownUsd: round2(maxDrawdownUsd),
    maxDrawdownPct: maxDrawdownPct * 100,
    initialCapital,
    finalBalance: round2(initialCapital + totalProfitUsd),
  };
}

// ─── XLSX 导出 ──────────────────────────────────────────────────────────

const DETAIL_HEADERS = [
  '信号#', '日期', '时间', '方向', '信号来源', '指定入场价', '实际入场价',
  '止盈点(原)', '止损(原)', '有效止盈', '有效止损', '结果',
  'TP命中数', 'SL触发', '保本离场',
  'TP命中时间', 'SL时间', '保本时间', '持仓时间(分)',
  '最大浮盈价', '最大浮盈(pips)', '盈亏(pips)',
  '仓位(盎司)', '手数', '盈亏($)', '账户余额($)',
];

const OUTCOME_DISPLAY: Record<string, string> = {
  tp: '🟢 TP止盈',
  sl: '🔴 SL止损',
  be: '⚪ 保本平仓',
  open: '🔵 未平仓',
  no_data: '⚪ 无数据',
};

function sourceDisplay(sourceType: string): string {
  return sourceType === 'image' ? 'AI 解析' : '程序解析';
}

function buildDetailRows(results: MansoorResult[]): (string | number)[][] {
  return results.map((r) => [
    r.signalId,
    r.timestamp ? r.timestamp.slice(0, 10) : '',
    r.timestamp ? r.timestamp.slice(11, 19) : '',
    r.direction.toUpperCase(),
    sourceDisplay(r.sourceType),
    r.entryPrice ?? '市价',
    r.actualEntry ?? '',
    r.tps.length ? r.tps.join('/') : '',
    r.sl ?? '',
    r.effTps.filter((v) => v != null).join('/'),
    r.effSl ?? '',
    OUTCOME_DISPLAY[r.outcome] || r.outcome,
    r.tpHitCount,
    r.slHit ? '✅' : '',
    r.beHit ? '✅' : '',
    r.tpExitTimes.filter((v) => v != null).map((v) => v ? new Date(v * 1000).toISOString().slice(11, 19) : '').join('/'),
    r.slExitTime ? new Date(r.slExitTime * 1000).toISOString().slice(11, 19) : '',
    r.beExitTime ? new Date(r.beExitTime * 1000).toISOString().slice(11, 19) : '',
    r.durationMin ?? '',
    r.maxFavorablePrice ?? '',
    r.maxFavorablePips,
    r.profitPips,
    r.positionSize ?? '',
    r.lotSize ?? '',
    round2(r.profitUsd),
    round2(r.accountBalance),
  ]);
}

function weekStartKey(timestamp: string): string {
  const d = new Date(timestamp);
  const day = (d.getDay() + 6) % 7;
  const monday = new Date(d);
  monday.setDate(d.getDate() - day);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${monday.getFullYear()}-${p(monday.getMonth() + 1)}-${p(monday.getDate())}`;
}

function buildSummaryRows(results: MansoorResult[], initialCapital: number, mode: BacktestMode): (string | number)[][] {
  const total = results.length;
  const wins = results.filter((r) => r.profitUsd > 0);
  const losses = results.filter((r) => r.profitUsd < 0);
  const totalProfitUsd = results.reduce((s, r) => s + r.profitUsd, 0);
  const finalCapital = initialCapital + totalProfitUsd;
  const totalPips = results.reduce((s, r) => s + r.profitPips, 0);

  let capital = initialCapital;
  let peak = initialCapital;
  let maxDrawdownUsd = 0;
  let maxDrawdownPct = 0;
  const ordered = [...results].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  for (const r of ordered) {
    capital += r.profitUsd;
    if (capital > peak) peak = capital;
    const ddUsd = peak - capital;
    if (ddUsd > maxDrawdownUsd) maxDrawdownUsd = ddUsd;
    if (peak > 0 && ddUsd / peak > maxDrawdownPct) maxDrawdownPct = ddUsd / peak;
  }

  const avgWin = wins.length ? wins.reduce((s, r) => s + r.profitUsd, 0) / wins.length : 0;
  const avgLoss = losses.length ? losses.reduce((s, r) => s + Math.abs(r.profitUsd), 0) / losses.length : 0;
  const profitFactor = avgLoss > 0 ? avgWin / avgLoss : Infinity;

  const maxProfitTrade = results.length ? results.reduce((a, b) => (b.profitUsd > a.profitUsd ? b : a)) : null;
  const maxLossTrade = results.length ? results.reduce((a, b) => (b.profitUsd < a.profitUsd ? b : a)) : null;

  const monthly: Record<string, { count: number; wins: number; losses: number; profit: number }> = {};
  const weekly: Record<string, { count: number; wins: number; losses: number; profit: number }> = {};
  for (const r of results) {
    const month = r.timestamp ? r.timestamp.slice(0, 7) : '';
    const week = r.timestamp ? weekStartKey(r.timestamp) : '';
    for (const [key, map] of [[month, monthly], [week, weekly]] as const) {
      if (!key) continue;
      map[key] = map[key] || { count: 0, wins: 0, losses: 0, profit: 0 };
      map[key].count += 1;
      if (r.profitUsd > 0) map[key].wins += 1;
      else if (r.profitUsd < 0) map[key].losses += 1;
      map[key].profit += r.profitUsd;
    }
  }

  const buy = results.filter((r) => r.direction === 'buy');
  const sell = results.filter((r) => r.direction === 'sell');

  const rows: (string | number)[][] = [];
  rows.push([`回测统计汇总 · ${mode.name}`]);
  rows.push([]);
  rows.push(['初始资金 ($)', round2(initialCapital)]);
  rows.push(['最终资金 ($)', round2(finalCapital)]);
  rows.push(['总盈亏 ($)', `${totalProfitUsd >= 0 ? '+' : ''}${round2(totalProfitUsd)}`]);
  rows.push(['收益率', `${((totalProfitUsd / initialCapital) * 100).toFixed(2)}%`]);
  rows.push([]);
  rows.push(['总信号数', total]);
  rows.push(['TP 止盈(全部平)', results.filter((r) => r.outcome === 'tp').length]);
  rows.push(['SL 止损', results.filter((r) => r.outcome === 'sl').length]);
  rows.push(['保本平仓', results.filter((r) => r.outcome === 'be').length]);
  rows.push(['未平仓', results.filter((r) => r.outcome === 'open').length]);
  rows.push(['无数据', results.filter((r) => r.outcome === 'no_data').length]);
  rows.push(['盈利单数', wins.length]);
  rows.push(['亏损单数', losses.length]);
  rows.push(['总利润 (pips)', round1(totalPips)]);
  rows.push(['胜率', wins.length + losses.length ? `${((wins.length / (wins.length + losses.length)) * 100).toFixed(1)}%` : 'N/A']);
  rows.push(['盈亏比', Number.isFinite(profitFactor) ? round2(profitFactor) : '∞']);
  rows.push(['平均盈利 ($)', wins.length ? round2(avgWin) : 'N/A']);
  rows.push(['平均亏损 ($)', losses.length ? round2(avgLoss) : 'N/A']);
  if (maxProfitTrade) rows.push(['单笔最大盈利 ($)', `${maxProfitTrade.profitUsd >= 0 ? '+' : ''}${round2(maxProfitTrade.profitUsd)} (#${maxProfitTrade.signalId})`]);
  if (maxLossTrade) rows.push(['单笔最大亏损 ($)', `${maxLossTrade.profitUsd >= 0 ? '+' : ''}${round2(maxLossTrade.profitUsd)} (#${maxLossTrade.signalId})`]);
  rows.push(['最大回撤 ($)', `${maxDrawdownUsd > 0 ? '-' : ''}${round2(maxDrawdownUsd)}`]);
  rows.push(['最大回撤 (%)', `${maxDrawdownPct > 0 ? '-' : ''}${maxDrawdownPct.toFixed(2)}%`]);
  rows.push([]);
  rows.push(['方向统计']);
  rows.push(['BUY 信号数', buy.length]);
  rows.push(['BUY 胜率', `${((buy.filter((r) => r.profitUsd > 0).length / Math.max(buy.length, 1)) * 100).toFixed(1)}%`]);
  rows.push(['BUY 总盈亏 ($)', `${buy.reduce((s, r) => s + r.profitUsd, 0) >= 0 ? '+' : ''}${round2(buy.reduce((s, r) => s + r.profitUsd, 0))}`]);
  rows.push(['SELL 信号数', sell.length]);
  rows.push(['SELL 胜率', `${((sell.filter((r) => r.profitUsd > 0).length / Math.max(sell.length, 1)) * 100).toFixed(1)}%`]);
  rows.push(['SELL 总盈亏 ($)', `${sell.reduce((s, r) => s + r.profitUsd, 0) >= 0 ? '+' : ''}${round2(sell.reduce((s, r) => s + r.profitUsd, 0))}`]);
  rows.push([]);
  rows.push(['月度收益统计 ($)']);
  rows.push(['月份', '交易数', '胜', '负', '胜率', '月度盈亏($)', '累计盈亏($)']);
  let cumulative = 0;
  for (const month of Object.keys(monthly).sort()) {
    const m = monthly[month];
    cumulative += m.profit;
    const winRate = m.count ? ((m.wins / m.count) * 100).toFixed(1) : '0.0';
    rows.push([month, m.count, m.wins, m.losses, `${winRate}%`, round2(m.profit), round2(cumulative)]);
  }
  rows.push([]);
  rows.push(['周度收益统计 ($)']);
  rows.push(['周(周一)', '交易数', '胜', '负', '胜率', '周盈亏($)', '累计盈亏($)']);
  cumulative = 0;
  for (const week of Object.keys(weekly).sort()) {
    const w = weekly[week];
    cumulative += w.profit;
    const winRate = w.count ? ((w.wins / w.count) * 100).toFixed(1) : '0.0';
    rows.push([week, w.count, w.wins, w.losses, `${winRate}%`, round2(w.profit), round2(cumulative)]);
  }

  return rows;
}

function timestampSuffix(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

const STYLE = {
  headerFill: { patternType: 'solid', fgColor: { rgb: '1F4E79' } },
  headerFont: { bold: true, color: { rgb: 'FFFFFF' }, sz: 11 },
  sectionFill: { patternType: 'solid', fgColor: { rgb: 'DDEBF7' } },
  sectionFont: { bold: true, sz: 12, color: { rgb: '1F4E79' } },
  labelFont: { bold: true },
  border: {
    top: { style: 'thin', color: { rgb: 'BFBFBF' } },
    bottom: { style: 'thin', color: { rgb: 'BFBFBF' } },
    left: { style: 'thin', color: { rgb: 'BFBFBF' } },
    right: { style: 'thin', color: { rgb: 'BFBFBF' } },
  },
  greenFont: { color: { rgb: '1E7B34' } },
  redFont: { color: { rgb: 'C00000' } },
  outcomeFills: {
    tp: { patternType: 'solid', fgColor: { rgb: 'C6EFCE' } },
    sl: { patternType: 'solid', fgColor: { rgb: 'FFC7CE' } },
    be: { patternType: 'solid', fgColor: { rgb: 'FFEB9C' } },
    open: { patternType: 'solid', fgColor: { rgb: 'DDEBF7' } },
    no_data: { patternType: 'solid', fgColor: { rgb: 'F2F2F2' } },
  },
};

function applyCellStyle(ws: XLSX.WorkSheet, r: number, c: number, style: any): void {
  const cell = ws[XLSX.utils.encode_cell({ r, c })];
  if (cell) cell.s = { ...(cell.s || {}), ...style };
}

function injectFreezePane(xlsxPath: string, sheetIndex: number, ySplit: number): void {
  const zip = new AdmZip(xlsxPath);
  const entryName = `xl/worksheets/sheet${sheetIndex}.xml`;
  let xml = zip.readAsText(entryName);
  if (/<pane/.test(xml)) return;
  const pane = `<pane ySplit="${ySplit}" topLeftCell="A${ySplit + 1}" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A${ySplit + 1}" sqref="A${ySplit + 1}"/>`;
  xml = xml.replace(/<sheetView[^>]*>/, (m) => `${m}${pane}`);
  zip.updateFile(entryName, Buffer.from(xml, 'utf8'));
  zip.writeZip(xlsxPath);
}

function buildComparisonRows(statsList: BacktestStats[]): (string | number)[][] {
  const rows: (string | number)[][] = [['指标', ...statsList.map((s) => s.modeName)]];
  const usd = (v: number) => `${v >= 0 ? '+' : ''}${round2(v)}`;
  const pct = (v: number) => `${v.toFixed(2)}%`;
  const items: [string, (s: BacktestStats) => string | number][] = [
    ['总信号数', (s) => s.totalSignals],
    ['实际成交', (s) => s.filled],
    ['TP 止盈', (s) => s.tpCount],
    ['SL 止损', (s) => s.slCount],
    ['保本平仓', (s) => s.beCount],
    ['未平仓', (s) => s.openCount],
    ['无数据', (s) => s.noDataCount],
    ['盈利单数', (s) => s.wins],
    ['亏损单数', (s) => s.losses],
    ['胜率', (s) => pct(s.winRate * 100)],
    ['总盈亏 ($)', (s) => usd(s.totalProfitUsd)],
    ['收益率', (s) => pct(s.returnPct)],
    ['总盈亏 (pips)', (s) => round1(s.totalProfitPips)],
    ['盈亏比', (s) => (Number.isFinite(s.profitFactor) ? round2(s.profitFactor) : '∞')],
    ['平均盈利 ($)', (s) => round2(s.avgWin)],
    ['平均亏损 ($)', (s) => round2(s.avgLoss)],
    ['单笔最大盈利 ($)', (s) => usd(s.maxProfitTrade)],
    ['单笔最大亏损 ($)', (s) => usd(s.maxLossTrade)],
    ['最大回撤 ($)', (s) => `-${round2(s.maxDrawdownUsd)}`],
    ['最大回撤 (%)', (s) => `-${s.maxDrawdownPct.toFixed(2)}%`],
    ['初始资金 ($)', (s) => s.initialCapital],
    ['最终资金 ($)', (s) => round2(s.finalBalance)],
    ['BUY 数/胜率/盈亏', (s) => `${s.buyCount} / ${(s.buyCount ? (s.buyWins / s.buyCount) * 100 : 0).toFixed(1)}% / ${usd(s.buyProfit)}`],
    ['SELL 数/胜率/盈亏', (s) => `${s.sellCount} / ${(s.sellCount ? (s.sellWins / s.sellCount) * 100 : 0).toFixed(1)}% / ${usd(s.sellProfit)}`],
  ];
  for (const [label, fn] of items) rows.push([label, ...statsList.map(fn)]);
  return rows;
}

function appendDetailSheet(wb: XLSX.WorkBook, sheetName: string, results: MansoorResult[]): void {
  const detailRows = buildDetailRows(results);
  const detailWs = XLSX.utils.aoa_to_sheet([DETAIL_HEADERS, ...detailRows]);
  detailWs['!cols'] = [8, 12, 10, 8, 11, 12, 12, 22, 12, 22, 12, 12, 9, 8, 8, 26, 8, 8, 12, 12, 14, 12, 10, 8, 12, 12].map((wch) => ({ wch }));

  for (let c = 0; c < DETAIL_HEADERS.length; c++) {
    applyCellStyle(detailWs, 0, c, {
      font: STYLE.headerFont,
      fill: STYLE.headerFill,
      border: STYLE.border,
      alignment: { horizontal: 'center', vertical: 'center' },
    });
  }
  detailWs['!freeze'] = { xSplit: 0, ySplit: 1 };
  detailWs['!autofilter'] = { ref: `A1:${XLSX.utils.encode_cell({ r: 0, c: DETAIL_HEADERS.length - 1 })}${detailRows.length + 1}` };

  for (let i = 0; i < detailRows.length; i++) {
    const r = i + 1;
    const res = results[i];
    for (let c = 0; c < detailRows[i].length; c++) {
      const style: any = { border: STYLE.border };
      if (c === 11 && res && STYLE.outcomeFills[res.outcome]) {
        style.fill = STYLE.outcomeFills[res.outcome];
        style.font = { bold: true };
      }
      if (c === 20) {
        const v = res?.profitPips || 0;
        style.font = v > 0 ? STYLE.greenFont : v < 0 ? STYLE.redFont : undefined;
      }
      if (c === 24) {
        const v = res?.profitUsd || 0;
        style.numFmt = '+0.00;-0.00;0.00';
        style.font = v > 0 ? STYLE.greenFont : v < 0 ? STYLE.redFont : undefined;
      }
      if (c === 25) style.numFmt = '0.00';
      applyCellStyle(detailWs, r, c, style);
    }
  }
  XLSX.utils.book_append_sheet(wb, detailWs, sheetName);
}

function appendSummarySheet(wb: XLSX.WorkBook, sheetName: string, results: MansoorResult[], initialCapital: number, mode: BacktestMode): void {
  const summaryRows = buildSummaryRows(results, initialCapital, mode);
  const summaryWs = XLSX.utils.aoa_to_sheet(summaryRows);
  summaryWs['!cols'] = [{ wch: 30 }, { wch: 48 }];

  const SECTION_TITLES = new Set(['回测统计汇总', '方向统计', '月度收益统计', '周度收益统计']);
  for (let r = 0; r < summaryRows.length; r++) {
    const row = summaryRows[r];
    const first = String(row[0] || '');
    const isSection = row.length === 1 || SECTION_TITLES.has(first);
    const isTableHeader = first === '月份' || first === '周(周一)';
    for (let c = 0; c < Math.max(row.length, 2); c++) {
      const style: any = {};
      if (isSection) {
        style.font = STYLE.sectionFont;
        style.fill = STYLE.sectionFill;
      } else if (isTableHeader) {
        style.font = STYLE.headerFont;
        style.fill = STYLE.headerFill;
        style.alignment = { horizontal: 'center' };
      } else if (c === 0) {
        style.font = STYLE.labelFont;
      }
      if (row.length === 7 && (c === 5 || c === 6)) {
        const v = Number(row[c]);
        style.numFmt = '+0.00;-0.00;0.00';
        style.font = { ...(style.font || {}), color: v > 0 ? STYLE.greenFont.color : v < 0 ? STYLE.redFont.color : undefined };
      }
      applyCellStyle(summaryWs, r, c, style);
    }
  }
  XLSX.utils.book_append_sheet(wb, summaryWs, sheetName);
}

function exportToXlsx(
  modesWithResults: { mode: BacktestMode; results: MansoorResult[] }[],
  outputPath: string,
  initialCapital: number,
): void {
  const wb = XLSX.utils.book_new();
  const statsList = modesWithResults.map(({ mode, results }) => computeStats(mode, results, initialCapital));

  const cmpRows = buildComparisonRows(statsList);
  const cmpWs = XLSX.utils.aoa_to_sheet(cmpRows);
  cmpWs['!cols'] = [{ wch: 26 }, ...statsList.map(() => ({ wch: 24 }))];
  for (let r = 0; r < cmpRows.length; r++) {
    for (let c = 0; c < cmpRows[r].length; c++) {
      const style: any = { border: STYLE.border };
      if (r === 0) {
        style.font = STYLE.headerFont;
        style.fill = STYLE.headerFill;
        style.alignment = { horizontal: 'center', vertical: 'center' };
      } else if (c === 0) {
        style.font = STYLE.labelFont;
      } else {
        const label = String(cmpRows[r][0] || '');
        const raw = cmpRows[r][c];
        const num = typeof raw === 'number' ? raw : Number.parseFloat(String(raw).replace(/[-+%$∞/]/g, ''));
        if (Number.isFinite(num) && num !== 0 && /盈亏|收益|盈利|亏损|回撤|资金/.test(label)) {
          style.font = { ...(style.font || {}), color: num < 0 ? STYLE.redFont.color : STYLE.greenFont.color };
        }
      }
      applyCellStyle(cmpWs, r, c, style);
    }
  }
  cmpWs['!freeze'] = { xSplit: 1, ySplit: 1 };
  XLSX.utils.book_append_sheet(wb, cmpWs, '多方案汇总');

  const detailSheetIndexes: number[] = [];
  modesWithResults.forEach(({ mode, results }, idx) => {
    const dq = mode.key.toUpperCase();
    appendDetailSheet(wb, `${dq}明细`, results);
    detailSheetIndexes.push(2 + idx * 2);
    appendSummarySheet(wb, `${dq}统计`, results, initialCapital, mode);
  });

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  XLSX.writeFile(wb, outputPath);
  for (const si of detailSheetIndexes) injectFreezePane(outputPath, si, 1);
  console.log(`\nXLSX 已导出: ${outputPath}`);
}

// ─── 回测主流程 ─────────────────────────────────────────────────────────

async function runBacktest(opts: any): Promise<void> {
  const inputFile = path.resolve(process.cwd(), opts.input);
  const cacheDir = path.resolve(process.cwd(), opts.cacheDir);
  const marginDays = parseInt(opts.klineMarginDays, 10) || 1;
  const interval = opts.interval || '1m';
  const initialCapital = parseFloat(opts.initialCapital) || 1000;
  const riskPerTrade = parseFloat(opts.riskPerTrade) || 50;

  if (!fs.existsSync(inputFile)) throw new Error(`信号文件不存在: ${inputFile}`);

  const signalsFile = JSON.parse(fs.readFileSync(inputFile, 'utf8')) as SignalsFile;
  let signals = signalsFile.signals || [];
  const parserName = signalsFile.meta?.parser || 'MansoorParser';

  // 排除无止盈目标（只有 SL）的信号：严格方案无法执行
  const skipped = signals.filter((s) => !s.tps.length || s.sl == null);
  if (skipped.length) {
    console.log(`跳过无止盈目标信号 ${skipped.length} 条（#${skipped.map((s) => s.id).join(',')}）`);
    signals = signals.filter((s) => s.tps.length && s.sl != null);
  }

  const outputFile = opts.output
    ? path.resolve(process.cwd(), opts.output)
    : path.resolve(process.cwd(), 'docs', 'backtest', `${parserName}_${timestampSuffix(new Date())}.xlsx`);

  console.log(`信号文件: ${inputFile}（${signalsFile.signals.length} 条信号，解析器 ${parserName}，参与回测 ${signals.length} 条）`);
  console.log(`输出: ${outputFile}`);
  console.log(`K 线周期: ${interval}（分钟级）`);
  console.log(`资金模型: 初始资金 $${initialCapital}，每单风险 $${riskPerTrade}`);
  console.log(`让点: 止损 ${SL_SLIPPAGE} / 止盈 单TP ${TP_SLIPPAGE_SINGLE} / 多TP ${TP_SLIPPAGE_MULTI}`);

  if (!signals.length) {
    console.log('无信号，跳过回测。');
    await exportToXlsx([], outputFile, initialCapital);
    return;
  }

  const tsList = signals.map((s) => new Date(s.timestamp).getTime() / 1000);
  const minTs = Math.floor(Math.min(...tsList)) - marginDays * 86400;
  const maxTs = Math.floor(Math.max(...tsList)) + marginDays * 86400;
  const symbols = Array.from(new Set(signals.map((s) => s.symbol)));

  console.log(`\n[1/3] 拉取 ${symbols.length} 个品种 K 线 (${interval})...`);
  const klinesBySymbol: Record<string, Candle[]> = {};
  for (const symbol of symbols) {
    klinesBySymbol[symbol] = await getKlines(symbol, interval, minTs, maxTs, cacheDir);
  }

  console.log(`\n[2/3] 执行回测 ${signals.length} 条信号 × ${BACKTEST_MODES.length} 个方案...`);
  const sorted = [...signals].sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  const modesWithResults = BACKTEST_MODES.map((mode) => {
    let capital = initialCapital;
    const results: MansoorResult[] = [];
    for (const s of sorted) {
      const r = backtestSignal(s, klinesBySymbol[s.symbol] || [], riskPerTrade, mode);
      capital += r.profitUsd;
      r.accountBalance = round2(capital);
      results.push(r);
    }
    results.sort((a, b) => a.signalId - b.signalId);
    return { mode, results };
  });

  const base = modesWithResults.find((m) => m.mode.key === 's1');
  if (base) {
    const byId = new Map(base.results.map((r) => [r.signalId, r]));
    for (const s of signalsFile.signals) s.backtest = byId.get(s.id) || null;
    fs.writeFileSync(inputFile, JSON.stringify(signalsFile, null, 2));
    console.log(`回测结果已填充回: ${inputFile}`);
  }

  console.log(`\n[3/3] 导出统计...`);
  const summaryLines: string[] = [];
  for (const { mode, results } of modesWithResults) {
    const stats = computeStats(mode, results, initialCapital);
    summaryLines.push(
      `${mode.name}: TP=${stats.tpCount} SL=${stats.slCount} 保本=${stats.beCount} 未平仓=${stats.openCount} 无数据=${stats.noDataCount}`,
    );
    summaryLines.push(
      `  总盈亏 $${round2(stats.totalProfitUsd)}（${stats.returnPct.toFixed(2)}%），` +
        `胜率 ${(stats.winRate * 100).toFixed(1)}%，盈亏比 ${Number.isFinite(stats.profitFactor) ? round2(stats.profitFactor) : '∞'}，` +
        `最大回撤 $${round2(stats.maxDrawdownUsd)}（-${stats.maxDrawdownPct.toFixed(2)}%），初始 $${initialCapital} → 最终 $${round2(stats.finalBalance)}`,
    );
  }
  console.log('\n' + summaryLines.join('\n'));

  exportToXlsx(modesWithResults, outputFile, initialCapital);
}

// ─── 主入口 ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const program = new Command();
  program.name('mansoor-backtest').description('Mansoor 解析器回测工具：单入场 · 多TP逐层 · 1分钟K线 · 收盘价模型');

  program.command('backtest').description('读取信号文件，拉取 K 线执行回测，导出 XLSX')
    .option('--input <path>', '信号 JSON 输入文件', 'examples/mansoor_signals.json')
    .option('--output <path>', 'XLSX 输出路径（默认 docs/backtest/MansoorParser_{时间戳}.xlsx）')
    .option('--interval <interval>', 'K 线周期（分钟级，默认 1m）', '1m')
    .option('--kline-margin-days <n>', '信号区间前后额外拉取 K 线的天数', '1')
    .option('--cache-dir <path>', 'K 线本地缓存目录', 'data/backtest_cache')
    .option('--initial-capital <n>', '初始资金 ($)', '1000')
    .option('--risk-per-trade <n>', '每单风险 ($)', '50')
    .action(async (opts) => await runBacktest(opts));

  await program.parseAsync(process.argv);
}

main().catch((error) => {
  console.error(error?.message || error);
  process.exit(1);
});
