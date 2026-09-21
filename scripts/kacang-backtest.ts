/**
 * Kacang 解析器回测工具（双层入场 · 1 分钟 K 线 · 收盘价模型）。
 *
 * 与 huice/kacang backtest.py 的回测方法论完全对齐：
 * - K 线周期固定 1 分钟，数据源 Gate.io tradfi（XAUUSD 现货金），本地缓存到 data/backtest_cache。
 * - 入场以收盘价成交：
 *   * Layer 1 市价：信号后第一根命中 K 线收盘价；
 *   * Layer 2 限价：某根 K 线收盘价触及入场区间另一端后以该收盘价入场（未触及记为 no_fill）。
 * - 出场用 K 线最高/最低价触发，按多空方向应用让点（止盈让 5.5 / 止损让 0.9）。
 * - 双层退出：L1 持有到 TP1 或 SL，L2 持有到 TP2 或 SL；TP1 命中后 L2 止损移至入场价（保本）。
 * - 同根 K 线 TP/SL 冲突裁决：取离入场价更近的价位成交（保守）。
 * - 持仓过夜不设超时；数据结束仍未平仓记为「未平仓」(open)。
 *
 * 资金/仓位模型（对齐 mansoor 通用回测框架）：
 * - 初始资金默认 $1000，每单风险默认 $50（--initial-capital / --risk-per-trade 调整）。
 * - 双层入场各承担 risk/2；手数标签（normal=1 / double=2）作为 riskMultiplier 放大仓位。
 * - 仓位大小 = 承担风险 / |入场价 - 有效止损价|。
 * - 回测结果同时输出盈亏点位（pips）与美元盈亏、账户余额，并按月/按周统计收益，
 *   明细列含「信号来源」列（本解析器为纯文本程序解析）。
 *
 * 用法：
 *   # 阶段一：干跑解析历史消息，输出 Kacang 信号 JSON
 *   npx ts-node scripts/kacang-backtest.ts parse \
 *     --input examples/kacang.json \
 *     --output examples/kacang_signals.json
 *
 *   # 阶段二：拉取 K 线回测，填充结果并导出 XLSX（默认 docs/backtest/KacangParser_{YYYYMMDDHHmmss}.xlsx）
 *   npx ts-node scripts/kacang-backtest.ts backtest \
 *     --input examples/kacang_signals.json
 *
 *   # 一键：解析 + 回测
 *   npx ts-node scripts/kacang-backtest.ts run
 */
import fs from 'fs';
import path from 'path';
import axios from 'axios';
import AdmZip from 'adm-zip';
import { Command } from 'commander';
import { KacangParser } from '../src/services/parsers/KacangParser';
import * as XLSX from 'xlsx-js-style';

// ─── 类型 ────────────────────────────────────────────────────────────────

type Candle = { ts: number; o: number; h: number; l: number; c: number };

type KacangSignal = {
  id: number;
  timestamp: string;
  symbol: string;
  side: 'buy' | 'sell';
  lotSize: number;
  lotLabel: string;
  entryZone: number[]; // [high, low] 降序
  tp1: number | null;
  tp2: number | null;
  sl: number | null;
  rawMessage: string;
  sourceType: string;
  backtest: KacangResult | null;
};

type KacangResult = {
  signalId: number;
  timestamp: string;
  direction: string;
  sourceType: string;
  lotSize: number;
  entryZone: number[];
  entryPrice: number | null; // 指定入场价
  actualEntry: number | null; // 实际加权入场价
  tp1: number | null; // 原始 TP1
  tp2: number | null; // 原始 TP2
  sl: number | null; // 原始 SL
  effTp1: number | null;
  effTp2: number | null;
  effSl: number | null;
  outcome: 'tp2' | 'tp1' | 'sl' | 'open' | 'no_data';
  tp1Hit: boolean;
  tp2Hit: boolean;
  slHit: boolean;
  tp1TimeMin: number | null;
  tp2TimeMin: number | null;
  slTimeMin: number | null;
  durationMin: number | null;
  layer1Price: number | null;
  layer2Price: number | null;
  layersFilled: number;
  layer1Outcome: string;
  layer2Outcome: string;
  maxFavorablePrice: number | null;
  maxFavorablePips: number;
  profitPips: number;
  positionSize: number | null;
  profitUsd: number;
  accountBalance: number;
};

type SignalsFile = {
  meta: { parser: string; source: string; parsedAt: string; textOnly: boolean };
  signals: KacangSignal[];
};

// ─── 常量 ────────────────────────────────────────────────────────────────

const GATE_API_BASE = 'https://api.gateio.ws/api/v4';
const CFD_SYMBOL_MAP: Record<string, string> = { XAU_USDT: 'XAUUSD' };
const TRADFI_PAGE_SIZE = 500;

// 让点（USDT）：止盈统一让 1.2（不管 TP1/TP2），止损让 0.9
const TP_SLIPPAGE = 1.2;
const SL_SLIPPAGE = 0.9;

// ─── 回测方案定义 ────────────────────────────────────────────────────────
// 每个方案都复用同一批信号与同一套入场/出场价格逻辑，仅调整「入场层」与「止盈规则」，
// 用于对比分析不同策略形态对盈亏/胜率/回撤的影响。
type BacktestMode = {
  key: string;
  name: string;
  desc: string;
  layer1: boolean; // 是否在市价层（Layer 1）入场
  layer2: boolean; // 是否在限价层（Layer 2，区间另一端）入场
  exitAtTp2: boolean; // true=L2 持有到 TP2；false=L2 与 L1 一起在 TP1 全部平仓
};

const BACKTEST_MODES: BacktestMode[] = [
  {
    key: 's1',
    name: '方案1 · 严格双TP双入场',
    desc: 'L1市价+L2限价入场，L1→TP1，L2→TP2（TP1命中后L2止损保本）',
    layer1: true,
    layer2: true,
    exitAtTp2: true,
  },
  {
    key: 's2',
    name: '方案2 · 只入场2 · TP1全部平',
    desc: '仅L2限价入场（L1跳过），全仓在TP1或SL平仓',
    layer1: false,
    layer2: true,
    exitAtTp2: false,
  },
  {
    key: 's3',
    name: '方案3 · 双入场 · TP1全部平',
    desc: 'L1+L2都入场，止损不变，全仓在TP1或SL平仓（不用TP2）',
    layer1: true,
    layer2: true,
    exitAtTp2: false,
  },
];

// ─── 回测统计（含权益曲线与最大回撤） ────────────────────────────────────
type BacktestStats = {
  modeKey: string;
  modeName: string;
  totalSignals: number;
  filled: number; // 至少一层成交的信号数
  tp1Count: number;
  tp2Count: number;
  slCount: number;
  openCount: number;
  noFillCount: number;
  wins: number;
  losses: number;
  winRate: number; // 基于已平仓（胜负）单
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
  maxDrawdownUsd: number; // 最大回撤 ($)
  maxDrawdown: number; // 最大回撤（无量纲，保留兼容）
  maxDrawdownPct: number; // 最大回撤（%，相对权益峰值）
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

// ─── 回测引擎（1m K 线 · 收盘价模型 · 双层入场） ───────────────────────

function backtestSignal(signal: KacangSignal, candles: Candle[], riskPerTrade: number, mode: BacktestMode): KacangResult {
  const result: KacangResult = {
    signalId: signal.id,
    timestamp: signal.timestamp,
    direction: signal.side,
    sourceType: signal.sourceType,
    lotSize: signal.lotSize,
    entryZone: signal.entryZone,
    entryPrice: signal.entryZone.length ? (signal.side === 'sell' ? Math.max(...signal.entryZone) : Math.min(...signal.entryZone)) : null,
    actualEntry: null,
    tp1: signal.tp1,
    tp2: signal.tp2,
    sl: signal.sl,
    effTp1: null,
    effTp2: null,
    effSl: null,
    outcome: 'no_data',
    tp1Hit: false,
    tp2Hit: false,
    slHit: false,
    tp1TimeMin: null,
    tp2TimeMin: null,
    slTimeMin: null,
    durationMin: null,
    layer1Price: null,
    layer2Price: null,
    layersFilled: 0,
    layer1Outcome: 'no_fill',
    layer2Outcome: 'no_fill',
    maxFavorablePrice: null,
    maxFavorablePips: 0,
    profitPips: 0,
    positionSize: null,
    profitUsd: 0,
    accountBalance: 0,
  };

  if (!candles.length || signal.sl == null || signal.tp1 == null || signal.entryZone.length < 2) {
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

  // 让点后的有效 TP / SL（止盈统一让 1.2，止损让 0.9，按多空方向应用）
  const effTp1 = round2(isBuy ? signal.tp1 - TP_SLIPPAGE : signal.tp1 + TP_SLIPPAGE);
  const effTp2 = signal.tp2 != null ? round2(isBuy ? signal.tp2 - TP_SLIPPAGE : signal.tp2 + TP_SLIPPAGE) : null;
  const effSl = round2(isBuy ? signal.sl + SL_SLIPPAGE : signal.sl - SL_SLIPPAGE);
  result.effTp1 = effTp1;
  result.effTp2 = effTp2;
  result.effSl = effSl;

  const zoneHigh = Math.max(...signal.entryZone);
  const zoneLow = Math.min(...signal.entryZone);

  // 计划参与的层数 → 每层分摊风险（S2 只入 L2 时整单风险给 L2）
  const plannedLayers = (mode.layer1 ? 1 : 0) + (mode.layer2 ? 1 : 0);
  const riskPerLayer = plannedLayers > 0 ? riskPerTrade / plannedLayers : riskPerTrade;

  // ── 入场（收盘价）──
  const l1Idx = startIdx;
  // Layer 1：市价，第一根命中 K 线收盘价（方案决定是否参与）
  const l1 = {
    active: mode.layer1,
    filled: mode.layer1,
    price: mode.layer1 ? candles[l1Idx].c : (null as number | null),
    idx: l1Idx,
    exit: null as number | null,
    exitSl: false,
  };
  // Layer 2：限价，收盘价触及区间另一端；target 依方案而定（exitAtTp2→TP2，否则→TP1）
  const l2 = {
    active: false,
    filled: false,
    price: null as number | null,
    idx: null as number | null,
    exit: null as number | null,
    exitSl: false,
  };
  const l2Target = mode.exitAtTp2 ? effTp2 : effTp1;

  if (mode.layer1) result.layer1Price = round2(l1.price!);
  if (mode.layer2) {
    const firstCandle = candles[l1Idx];
    if ((isBuy && firstCandle.c <= zoneHigh) || (!isBuy && firstCandle.c >= zoneLow)) {
      l2.filled = true;
      l2.active = true;
      l2.price = firstCandle.c;
      l2.idx = l1Idx;
      result.layer2Price = round2(l2.price);
    }
  }
  result.layersFilled = (l1.filled ? 1 : 0) + (l2.filled ? 1 : 0);

  const entryTime = candles[l1Idx].ts;

  // ── 出场（从入场 K 线的下一根开始，用最高/最低价触发）──
  let tp1Hit = false;
  let tp2Hit = false;
  let slHit = false;
  let tp1Time: number | null = null;
  let tp2Time: number | null = null;
  let slTime: number | null = null;
  let lastExitTime: number | null = null;
  let maxFavorable = l1.filled ? l1.price! : candles[l1Idx].c;

  for (let j = l1Idx + 1; j < candles.length; j++) {
    const c = candles[j];
    const high = c.h;
    const low = c.l;

    if (!tp1Hit && !slHit) {
      maxFavorable = isBuy ? Math.max(maxFavorable, high) : Math.min(maxFavorable, low);
    }

    // L2 限价触发入场（尚未成交）
    if (mode.layer2 && !l2.filled) {
      if ((isBuy && c.c <= zoneHigh) || (!isBuy && c.c >= zoneLow)) {
        l2.filled = true;
        l2.active = true;
        l2.price = c.c;
        l2.idx = j;
        result.layer2Price = round2(l2.price);
        result.layersFilled = 2;
      }
    }

    // ── L1 出场：target=TP1，stop=有效SL ──
    if (l1.active) {
      const tpTouch = effTp1 != null && ((isBuy && high >= effTp1) || (!isBuy && low <= effTp1));
      const slTouch = effSl != null && ((isBuy && low <= effSl) || (!isBuy && high >= effSl));
      if (tpTouch && slTouch) {
        // 同根 TP/SL 冲突：取离入场价更近的价位（保守）
        if (Math.abs(effTp1! - l1.price!) <= Math.abs(effSl! - l1.price!)) l1.exit = effTp1;
        else { l1.exit = effSl; l1.exitSl = true; }
      } else if (tpTouch) l1.exit = effTp1;
      else if (slTouch) { l1.exit = effSl; l1.exitSl = true; }

      if (l1.exit != null) {
        l1.active = false;
        lastExitTime = c.ts;
        if (l1.exitSl) {
          slHit = true;
          slTime = c.ts;
          // L1 止损触发时同时平掉 L2
          if (l2.active) { l2.active = false; l2.exit = effSl; l2.exitSl = true; }
        } else {
          tp1Hit = true;
          tp1Time = c.ts;
          // TP1 命中：若持有到 TP2 的方案，L2 止损在后续触发时移至入场价（保本）
        }
      }
    }

    // ── L2 出场：target=exitAtTp2?TP2:TP1，stop=有效SL（持有到 TP2 时 TP1 命中后保本为入场价）──
    if (l2.active && l2.idx != null && j > l2.idx) {
      const l2Stop = tp1Hit && mode.exitAtTp2 && l2.price != null ? l2.price : effSl;
      const tpTouch = l2Target != null && ((isBuy && high >= l2Target) || (!isBuy && low <= l2Target));
      const slTouch = l2Stop != null && ((isBuy && low <= l2Stop) || (!isBuy && high >= l2Stop));
      if (tpTouch && slTouch) {
        if (Math.abs(l2Target! - l2.price!) <= Math.abs(l2Stop! - l2.price!)) l2.exit = l2Target;
        else { l2.exit = l2Stop; l2.exitSl = true; }
      } else if (tpTouch) l2.exit = l2Target;
      else if (slTouch) { l2.exit = l2Stop; l2.exitSl = true; }

      if (l2.exit != null) {
        l2.active = false;
        lastExitTime = c.ts;
        if (l2.exitSl) { slHit = true; slTime = c.ts; }
        else if (mode.exitAtTp2) { tp2Hit = true; tp2Time = c.ts; }
        else { tp1Hit = true; tp1Time = c.ts; }
      }
    }

    if (!l1.active && !l2.active) break;
  }

  // ── 汇总 ──
  if (tp2Hit) result.outcome = 'tp2';
  else if (tp1Hit) result.outcome = 'tp1';
  else if (slHit) result.outcome = 'sl';
  else result.outcome = 'open';

  result.tp1Hit = tp1Hit;
  result.tp2Hit = tp2Hit;
  result.slHit = slHit;
  result.tp1TimeMin = tp1Time != null ? round1((tp1Time - entryTime) / 60) : null;
  result.tp2TimeMin = tp2Time != null ? round1((tp2Time - entryTime) / 60) : null;
  result.slTimeMin = slTime != null ? round1((slTime - entryTime) / 60) : null;
  const endTime = lastExitTime ?? candles[candles.length - 1].ts;
  result.durationMin = Math.round((endTime - entryTime) / 60);

  result.layer1Outcome = mode.layer1 ? (l1.exit != null ? (l1.exitSl ? 'sl' : 'tp') : 'open') : 'skip';
  result.layer2Outcome = mode.layer2
    ? l2.filled
      ? l2.exit != null
        ? l2.exitSl ? 'sl' : mode.exitAtTp2 ? 'tp2' : 'tp1'
        : 'open'
      : 'no_fill'
    : 'skip';

  // ── 盈亏（pips 与 USD，按实际成交层计）──
  let totalSize = 0;
  let profitUsd = 0;
  let profitPips = 0;
  let wEntry = 0;
  let wSize = 0;

  if (l1.filled && l1.price != null && l1.exit != null) {
    const size1 = (riskPerLayer * signal.lotSize) / Math.abs(l1.price - effSl);
    totalSize += size1;
    profitUsd += (isBuy ? l1.exit - l1.price : l1.price - l1.exit) * size1;
    profitPips += (isBuy ? l1.exit - l1.price : l1.price - l1.exit) * 100;
    wEntry += size1 * l1.price;
    wSize += size1;
  }
  if (l2.filled && l2.price != null && l2.exit != null) {
    const size2 = (riskPerLayer * signal.lotSize) / Math.abs(l2.price - effSl);
    totalSize += size2;
    profitUsd += (isBuy ? l2.exit - l2.price : l2.price - l2.exit) * size2;
    profitPips += (isBuy ? l2.exit - l2.price : l2.price - l2.exit) * 100;
    wEntry += size2 * l2.price;
    wSize += size2;
  }

  result.actualEntry = wSize > 0 ? round2(wEntry / wSize) : null;
  result.profitPips = round1(profitPips);
  result.profitUsd = round2(profitUsd);
  result.positionSize = round2(totalSize);
  result.maxFavorablePrice = round2(maxFavorable);
  result.maxFavorablePips = round1(Math.abs(maxFavorable - (result.actualEntry ?? maxFavorable)) * 100);

  return result;
}

// ─── 多方案统计汇总（含权益曲线与最大回撤） ─────────────────────────────────

function computeStats(mode: BacktestMode, results: KacangResult[], initialCapital: number): BacktestStats {
  let capital = initialCapital;
  let peak = initialCapital;
  let maxDrawdownUsd = 0;
  let maxDrawdown = 0;

  // 先按信号时间排序，逐单累加构建权益曲线并追踪最大回撤
  const sorted = [...results].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  for (const r of sorted) {
    capital += r.profitUsd;
    if (capital > peak) peak = capital;
    const ddUsd = peak - capital;
    if (ddUsd > maxDrawdownUsd) maxDrawdownUsd = ddUsd;
    const dd = peak > 0 ? ddUsd / peak : 0;
    if (dd > maxDrawdown) maxDrawdown = dd;
  }

  const filled = results.filter((r) => r.layersFilled > 0);
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
    tp1Count: results.filter((r) => r.outcome === 'tp1').length,
    tp2Count: results.filter((r) => r.outcome === 'tp2').length,
    slCount: results.filter((r) => r.outcome === 'sl').length,
    openCount: results.filter((r) => r.outcome === 'open').length,
    noFillCount: results.filter((r) => r.layersFilled === 0).length,
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
    maxDrawdown: round2(maxDrawdown),
    maxDrawdownPct: maxDrawdown * 100,
    initialCapital,
    finalBalance: round2(initialCapital + totalProfitUsd),
  };
}

// ─── 阶段一：解析器干跑 ─────────────────────────────────────────────────

function buildDiscordMessage(message: any, index: number): any {
  return {
    id: `kacang-backtest-${index + 1}`,
    channel_id: message.channel_id || 'unknown-channel',
    content: message.content || '',
    ts: message.timestamp || new Date().toISOString(),
    username: 'backtest',
    attachments: [],
  };
}

async function replayKacang(messages: any[]): Promise<KacangSignal[]> {
  const parser = new KacangParser();
  const signals: KacangSignal[] = [];
  let inferredCount = 0;

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const parsed = await parser.parse(buildDiscordMessage(msg, i), true);
    if (parsed) {
      for (const s of parsed) {
        if (s.action !== 'open') continue;

        const entryP = s.entryPrice ? parseFloat(s.entryPrice) : null;
        if (entryP == null || !Number.isFinite(entryP)) continue;
        const l2Limit = s.entries?.[1]?.price ?? null;
        const targets = (s.targets || []).map((t) => parseFloat(t)).filter((v) => Number.isFinite(v));
        const sl = s.stopLoss ? parseFloat(s.stopLoss) : null;
        if (!targets.length || sl == null) continue;

        // 由 side + 指定入场价 + L2 限价还原入场区间
        let zHigh: number;
        let zLow: number;
        if (s.side === 'sell') {
          zHigh = entryP;
          zLow = l2Limit ?? entryP;
        } else {
          zLow = entryP;
          zHigh = l2Limit ?? entryP;
        }

        signals.push({
          id: signals.length + 1,
          timestamp: msg.timestamp || new Date().toISOString(),
          symbol: s.symbol,
          side: s.side === 'sell' ? 'sell' : 'buy',
          lotSize: s.riskMultiplier || 1,
          lotLabel: (s.riskMultiplier || 1) >= 2 ? 'double' : 'normal',
          entryZone: [Math.max(zHigh, zLow), Math.min(zHigh, zLow)],
          tp1: targets[0] ?? null,
          tp2: targets[1] ?? null,
          sl,
          rawMessage: msg.content || '',
          sourceType: s.sourceType || 'text',
          backtest: null,
        });

        // 统计被截断经均值反推补全的信号（解析器已打逐条 warning 日志）
        if (s.sourceType === 'text_inferred') {
          inferredCount++;
        }
      }
      continue;
    }
  }

  for (const s of signals) s.id = signals.indexOf(s) + 1;
  signals.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  signals.forEach((s, i) => (s.id = i + 1));
  console.warn(`[WARN] 共 ${inferredCount} 条被截断信号使用均值反推补全 TP/SL（上方为解析器逐条 warning 日志）`);
  return signals;
}

// ─── XLSX 导出 ──────────────────────────────────────────────────────────

const DETAIL_HEADERS = [
  '信号#', '日期', '时间', '方向', '信号来源', '手数',
  '入场区间', '指定入场价', '实际入场价',
  'TP1', 'TP2', 'SL', '有效TP1', '有效TP2', '有效SL', '结果',
  'TP1命中', 'TP2命中', 'SL触发',
  'TP1耗时(分)', 'TP2耗时(分)', 'SL耗时(分)', '持仓时间(分)',
  'L1入场价', 'L2入场价', 'L1结果', 'L2结果', '层数',
  '最大浮盈价', '最大浮盈(pips)', '盈亏(pips)',
  '仓位(单位)', '盈亏($)', '账户余额($)',
];

const OUTCOME_DISPLAY: Record<string, string> = {
  tp2: '🟢 TP2',
  tp1: '🟡 TP1',
  sl: '🔴 SL',
  open: '🔵 未平仓',
  no_data: '⚪ 无数据',
};

function sourceDisplay(sourceType: string): string {
  return sourceType === 'image' ? 'AI 解析' : '程序解析';
}

function buildDetailRows(results: KacangResult[]): (string | number)[][] {
  return results.map((r) => [
    r.signalId,
    r.timestamp ? r.timestamp.slice(0, 10) : '',
    r.timestamp ? r.timestamp.slice(11, 19) : '',
    r.direction.toUpperCase(),
    sourceDisplay(r.sourceType),
    r.lotSize,
    r.entryZone.length ? `${r.entryZone[0]}-${r.entryZone[1]}` : '',
    r.entryPrice ?? '',
    r.actualEntry ?? '',
    r.tp1 ?? '',
    r.tp2 ?? '',
    r.sl ?? '',
    r.effTp1 ?? '',
    r.effTp2 ?? '',
    r.effSl ?? '',
    OUTCOME_DISPLAY[r.outcome] || r.outcome,
    r.tp1Hit ? '✅' : '',
    r.tp2Hit ? '✅' : '',
    r.slHit ? '✅' : '',
    r.tp1TimeMin ?? '',
    r.tp2TimeMin ?? '',
    r.slTimeMin ?? '',
    r.durationMin ?? '',
    r.layer1Price ?? '',
    r.layer2Price ?? '',
    r.layer1Outcome,
    r.layer2Outcome,
    r.layersFilled,
    r.maxFavorablePrice ?? '',
    r.maxFavorablePips,
    r.profitPips,
    r.positionSize ?? '',
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

function buildSummaryRows(results: KacangResult[], initialCapital: number): (string | number)[][] {
  const total = results.length;
  const wins = results.filter((r) => r.profitUsd > 0);
  const losses = results.filter((r) => r.profitUsd < 0);
  const opens = results.filter((r) => r.outcome === 'open');
  const totalProfitUsd = results.reduce((s, r) => s + r.profitUsd, 0);
  const finalCapital = initialCapital + totalProfitUsd;
  const totalPips = results.reduce((s, r) => s + r.profitPips, 0);

  // 最大回撤（按时间排序累加权益）
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

  const unfilled = results.filter((r) => !r.tp1Hit && !r.tp2Hit && r.maxFavorablePips > 0);
  const avgMaxFav = unfilled.length ? unfilled.reduce((s, r) => s + r.maxFavorablePips, 0) / unfilled.length : 0;
  const maxFavTrade = unfilled.length ? unfilled.reduce((a, b) => (b.maxFavorablePips > a.maxFavorablePips ? b : a)) : null;

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
  const buyWins = buy.filter((r) => r.profitUsd > 0);
  const sellWins = sell.filter((r) => r.profitUsd > 0);

  const tp1Count = results.filter((r) => r.outcome === 'tp1').length;
  const tp2Count = results.filter((r) => r.outcome === 'tp2').length;
  const slCount = results.filter((r) => r.outcome === 'sl').length;

  const rows: (string | number)[][] = [];
  rows.push(['回测统计汇总（1分钟K线 · 收盘价入场 · 高低价触发 · 止盈让1.2/止损让0.9 · 双层入场）']);
  rows.push([]);
  rows.push(['初始资金 ($)', round2(initialCapital)]);
  rows.push(['最终资金 ($)', round2(finalCapital)]);
  rows.push(['总盈亏 ($)', `${totalProfitUsd >= 0 ? '+' : ''}${round2(totalProfitUsd)}`]);
  rows.push(['收益率', `${((totalProfitUsd / initialCapital) * 100).toFixed(2)}%`]);
  rows.push([]);
  rows.push(['总信号数', total]);
  rows.push(['TP1 命中', tp1Count]);
  rows.push(['TP2 完全命中', tp2Count]);
  rows.push(['SL 触发', slCount]);
  rows.push(['未平仓数', opens.length]);
  rows.push(['盈利单数', wins.length]);
  rows.push(['亏损单数', losses.length]);
  rows.push(['总利润 (pips)', round1(totalPips)]);
  rows.push(['胜率 (TP)', wins.length + losses.length ? `${((wins.length / (wins.length + losses.length)) * 100).toFixed(1)}%` : 'N/A']);
  rows.push(['盈亏比', results.length ? round2(profitFactor) : 'N/A']);
  rows.push(['平均盈利 ($)', results.length ? round2(avgWin) : 'N/A']);
  rows.push(['平均亏损 ($)', results.length ? round2(avgLoss) : 'N/A']);
  if (maxProfitTrade) rows.push(['单笔最大盈利 ($)', `${maxProfitTrade.profitUsd >= 0 ? '+' : ''}${round2(maxProfitTrade.profitUsd)} (#${maxProfitTrade.signalId})`]);
  if (maxLossTrade) rows.push(['单笔最大亏损 ($)', `${maxLossTrade.profitUsd >= 0 ? '+' : ''}${round2(maxLossTrade.profitUsd)} (#${maxLossTrade.signalId})`]);
  rows.push(['最大回撤 ($)', `${maxDrawdownUsd > 0 ? '-' : ''}${round2(maxDrawdownUsd)}`]);
  rows.push(['最大回撤 (%)', `${maxDrawdownPct > 0 ? '-' : ''}${maxDrawdownPct.toFixed(2)}%`]);
  rows.push([]);
  rows.push(['方向统计']);
  rows.push(['BUY 信号数', buy.length]);
  rows.push(['BUY 胜率', `${((buyWins.length / Math.max(buy.length, 1)) * 100).toFixed(1)}%`]);
  rows.push(['BUY 总盈亏 ($)', `${buy.reduce((s, r) => s + r.profitUsd, 0) >= 0 ? '+' : ''}${round2(buy.reduce((s, r) => s + r.profitUsd, 0))}`]);
  rows.push(['SELL 信号数', sell.length]);
  rows.push(['SELL 胜率', `${((sellWins.length / Math.max(sell.length, 1)) * 100).toFixed(1)}%`]);
  rows.push(['SELL 总盈亏 ($)', `${sell.reduce((s, r) => s + r.profitUsd, 0) >= 0 ? '+' : ''}${round2(sell.reduce((s, r) => s + r.profitUsd, 0))}`]);
  rows.push([]);
  rows.push(['未达 TP 交易的最大浮盈']);
  rows.push(['涉及交易数', unfilled.length]);
  rows.push(['平均最大浮盈', `${avgMaxFav >= 0 ? '+' : ''}${avgMaxFav.toFixed(1)} pips`]);
  if (maxFavTrade) {
    rows.push(['最高最大浮盈', `${maxFavTrade.maxFavorablePips >= 0 ? '+' : ''}${maxFavTrade.maxFavorablePips.toFixed(1)} pips (#${maxFavTrade.signalId} ${maxFavTrade.timestamp.slice(0, 10)} ${maxFavTrade.direction.toUpperCase()})`]);
  }
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
    tp1: { patternType: 'solid', fgColor: { rgb: 'C6EFCE' } },
    tp2: { patternType: 'solid', fgColor: { rgb: 'A9D08E' } },
    sl: { patternType: 'solid', fgColor: { rgb: 'FFC7CE' } },
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

// ─── 多方案对比表 ─────────────────────────────────────────────────────────

function buildComparisonRows(statsList: BacktestStats[]): (string | number)[][] {
  const rows: (string | number)[][] = [['指标', ...statsList.map((s) => s.modeName)]];
  const usd = (v: number) => `${v >= 0 ? '+' : ''}${round2(v)}`;
  const pct = (v: number) => `${v.toFixed(2)}%`;
  const items: [string, (s: BacktestStats) => string | number][] = [
    ['总信号数', (s) => s.totalSignals],
    ['实际成交', (s) => s.filled],
    ['TP1 命中', (s) => s.tp1Count],
    ['TP2 命中', (s) => s.tp2Count],
    ['SL 触发', (s) => s.slCount],
    ['未平仓', (s) => s.openCount],
    ['未成交', (s) => s.noFillCount],
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

function appendDetailSheet(wb: XLSX.WorkBook, sheetName: string, results: KacangResult[]): void {
  const detailRows = buildDetailRows(results);
  const detailWs = XLSX.utils.aoa_to_sheet([DETAIL_HEADERS, ...detailRows]);
  detailWs['!cols'] = [8, 12, 10, 8, 11, 8, 14, 12, 12, 10, 10, 10, 10, 10, 10, 12, 8, 8, 8, 12, 12, 12, 12, 12, 12, 10, 10, 6, 12, 14, 12, 12, 12, 12].map((wch) => ({ wch }));

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
      if (c === 15 && res && STYLE.outcomeFills[res.outcome]) {
        style.fill = STYLE.outcomeFills[res.outcome];
        style.font = { bold: true };
      }
      if (c === 30) {
        const v = res?.profitPips || 0;
        style.font = v > 0 ? STYLE.greenFont : v < 0 ? STYLE.redFont : undefined;
      }
      if (c === 32) {
        const v = res?.profitUsd || 0;
        style.numFmt = '+0.00;-0.00;0.00';
        style.font = v > 0 ? STYLE.greenFont : v < 0 ? STYLE.redFont : undefined;
      }
      if (c === 33) style.numFmt = '0.00';
      applyCellStyle(detailWs, r, c, style);
    }
  }
  XLSX.utils.book_append_sheet(wb, detailWs, sheetName);
}

function appendSummarySheet(wb: XLSX.WorkBook, sheetName: string, results: KacangResult[], initialCapital: number): void {
  const summaryRows = buildSummaryRows(results, initialCapital);
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
  modesWithResults: { mode: BacktestMode; results: KacangResult[] }[],
  outputPath: string,
  initialCapital: number,
): void {
  const wb = XLSX.utils.book_new();
  const statsList = modesWithResults.map(({ mode, results }) => computeStats(mode, results, initialCapital));

  // 1) 多方案汇总对比（含 盈亏/胜率/盈亏比/最大回撤 等）
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
        const num = typeof raw === 'number' ? raw : Number.parseFloat(String(raw).replace(/[-+%$∞]/g, ''));
        if (
          Number.isFinite(num) &&
          num !== 0 &&
          /盈亏|收益|盈利|亏损|回撤|资金/.test(label)
        ) {
          style.font = { ...(style.font || {}), color: num < 0 ? STYLE.redFont.color : STYLE.greenFont.color };
        }
      }
      applyCellStyle(cmpWs, r, c, style);
    }
  }
  cmpWs['!freeze'] = { xSplit: 1, ySplit: 1 };
  XLSX.utils.book_append_sheet(wb, cmpWs, '多方案汇总');

  // 2) 每个方案的两张表：交易明细 + 统计汇总
  const detailSheetIndexes: number[] = [];
  modesWithResults.forEach(({ mode, results }, idx) => {
    const dq = mode.key.toUpperCase();
    appendDetailSheet(wb, `${dq}明细`, results);
    detailSheetIndexes.push(2 + idx * 2); // 首张为"多方案汇总"(sheet1)，方案明细依次为 2,4,6
    appendSummarySheet(wb, `${dq}统计`, results, initialCapital);
  });

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  XLSX.writeFile(wb, outputPath);
  for (const si of detailSheetIndexes) injectFreezePane(outputPath, si, 1);
  console.log(`\nXLSX 已导出: ${outputPath}`);
}

// ─── 阶段二：回测主流程 ─────────────────────────────────────────────────

async function runBacktest(opts: any): Promise<void> {
  const inputFile = path.resolve(process.cwd(), opts.input);
  const cacheDir = path.resolve(process.cwd(), opts.cacheDir || 'data/backtest_cache');
  const marginDays = parseInt(opts.klineMarginDays, 10) || 1;
  const interval = opts.interval || '1m';
  const initialCapital = parseFloat(opts.initialCapital) || 1000;
  const riskPerTrade = parseFloat(opts.riskPerTrade) || 50;

  if (!fs.existsSync(inputFile)) throw new Error(`信号文件不存在: ${inputFile}`);

  const signalsFile = JSON.parse(fs.readFileSync(inputFile, 'utf8')) as SignalsFile;
  const signals = signalsFile.signals || [];
  const parserName = signalsFile.meta?.parser || 'KacangParser';

  const outputFile = opts.output
    ? path.resolve(process.cwd(), opts.output)
    : path.resolve(process.cwd(), 'docs', 'backtest', `${parserName}_${timestampSuffix(new Date())}.xlsx`);

  console.log(`信号文件: ${inputFile}（${signals.length} 条信号，解析器 ${parserName}）`);
  console.log(`输出: ${outputFile}`);
  console.log(`K 线周期: ${interval}（分钟级）`);
  console.log(`资金模型: 初始资金 $${initialCapital}，每单风险 $${riskPerTrade}`);

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

  // 对每个方案独立计算权益与回撤（资金模型一致：初始/风险相同）
  const modesWithResults = BACKTEST_MODES.map((mode) => {
    let capital = initialCapital;
    const results: KacangResult[] = [];
    for (const s of sorted) {
      const r = backtestSignal(s, klinesBySymbol[s.symbol] || [], riskPerTrade, mode);
      capital += r.profitUsd;
      r.accountBalance = round2(capital);
      results.push(r);
    }
    results.sort((a, b) => a.signalId - b.signalId);
    return { mode, results };
  });

  // 回填基准方案（方案1）结果到信号文件，便于单独查看
  const base = modesWithResults.find((m) => m.mode.key === 's1');
  if (base) {
    const byId = new Map(base.results.map((r) => [r.signalId, r]));
    for (const s of signals) s.backtest = byId.get(s.id) || null;
    fs.writeFileSync(inputFile, JSON.stringify(signalsFile, null, 2));
    console.log(`回测结果已填充回: ${inputFile}`);
  }

  const summaryLines: string[] = [];
  for (const { mode, results } of modesWithResults) {
    const stats = computeStats(mode, results, initialCapital);
    summaryLines.push(
      `${mode.name}: TP1=${stats.tp1Count} TP2=${stats.tp2Count} SL=${stats.slCount} 未平仓=${stats.openCount} 未成交=${stats.noFillCount}`,
    );
    summaryLines.push(
      `  止盈让1.2/止损让0.9 → 总盈亏 $${round2(stats.totalProfitUsd)}（${stats.returnPct.toFixed(2)}%），` +
        `胜率 ${(stats.winRate * 100).toFixed(1)}%，盈亏比 ${Number.isFinite(stats.profitFactor) ? round2(stats.profitFactor) : '∞'}，` +
        `最大回撤 $${round2(stats.maxDrawdownUsd)}（-${stats.maxDrawdownPct.toFixed(2)}%），初始 $${initialCapital} → 最终 $${round2(stats.finalBalance)}`,
    );
  }
  console.log('\n' + summaryLines.join('\n'));

  exportToXlsx(modesWithResults, outputFile, initialCapital);
}

// ─── 主入口 ─────────────────────────────────────────────────────────────

async function runParse(opts: any): Promise<void> {
  const inputFile = path.resolve(process.cwd(), opts.input);
  const outputFile = path.resolve(process.cwd(), opts.output);
  if (!fs.existsSync(inputFile)) throw new Error(`输入文件不存在: ${inputFile}`);

  const messages = JSON.parse(fs.readFileSync(inputFile, 'utf8')) as any[];
  console.log(`干跑解析 ${messages.length} 条消息...`);
  const signals = await replayKacang(messages);

  const signalsFile: SignalsFile = {
    meta: {
      parser: 'KacangParser',
      source: inputFile,
      parsedAt: new Date().toISOString(),
      textOnly: true,
    },
    signals,
  };
  fs.mkdirSync(path.dirname(outputFile), { recursive: true });
  fs.writeFileSync(outputFile, JSON.stringify(signalsFile, null, 2));
  console.log(`解析完成，共 ${signals.length} 条开仓信号 → ${outputFile}`);

  const pad = (s: string, n: number) => String(s).padEnd(n);
  console.log(`\n  ${pad('No', 4)} ${pad('时间', 22)} ${pad('方向', 6)} ${pad('类型', 8)} ${pad('入场区间', 16)} ${pad('TP1', 10)} ${pad('TP2', 10)} ${pad('SL', 10)}`);
  for (const s of signals) {
    console.log(
      `${s.id.toString().padEnd(4)} `.padStart(6) + `${s.timestamp.slice(0, 19).padEnd(22)} ${s.side.toUpperCase().padEnd(6)} ` +
        `${s.lotLabel.padEnd(8)} ${`${s.entryZone[0]}-${s.entryZone[1]}`.padEnd(16)} ` +
        `${s.tp1 ?? '-'}${' '.repeat(9)} ${s.tp2 ?? '-'}${' '.repeat(9)} ${s.sl ?? '-'}`,
    );
  }
}

async function main(): Promise<void> {
  const program = new Command();
  program.name('kacang-backtest').description('Kacang 解析器回测工具：双层入场 · 1分钟K线 · 收盘价模型');

  program.command('parse').description('阶段一：干跑解析历史消息，输出 Kacang 信号 JSON')
    .option('--input <path>', '规范化消息 JSON 输入文件', 'examples/kacang.json')
    .option('--output <path>', '信号 JSON 输出路径', 'examples/kacang_signals.json')
    .action(async (opts) => await runParse(opts));

  program.command('backtest').description('阶段二：读取信号文件，拉取 K 线执行双层回测，导出 XLSX')
    .option('--input <path>', '信号 JSON 输入文件', 'examples/kacang_signals.json')
    .option('--output <path>', 'XLSX 输出路径（默认 docs/backtest/KacangParser_{时间戳}.xlsx）')
    .option('--interval <interval>', 'K 线周期（分钟级，默认 1m）', '1m')
    .option('--kline-margin-days <n>', '信号区间前后额外拉取 K 线的天数', '1')
    .option('--cache-dir <path>', 'K 线本地缓存目录', 'data/backtest_cache')
    .option('--initial-capital <n>', '初始资金 ($)', '1000')
    .option('--risk-per-trade <n>', '每单风险 ($)', '50')
    .action(async (opts) => await runBacktest(opts));

  program.command('run').description('一键：解析 + 回测')
    .option('--input <path>', '规范化消息 JSON 输入文件', 'examples/kacang.json')
    .option('--signal-output <path>', '信号 JSON 输出路径', 'examples/kacang_signals.json')
    .option('--interval <interval>', 'K 线周期（分钟级，默认 1m）', '1m')
    .action(async (opts) => {
      await runParse({ input: opts.input, output: opts.signalOutput });
      await runBacktest({ input: opts.signalOutput, interval: opts.interval });
    });

  await program.parseAsync(process.argv);
}

main().catch((error) => {
  console.error(error?.message || error);
  process.exit(1);
});