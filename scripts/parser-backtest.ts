/**
 * 通用解析器回测框架（两阶段，含仓位/资金模拟）。
 *
 * 阶段一 parse：调用任意已注册解析器（如 MansoorParser）对历史消息做「干跑」解析（不触发订单执行），
 *              把开仓信号输出为 JSON 文件（含信号来源、全部 TP、入场价）。
 * 阶段二 backtest：读取信号文件，从 Gate 公开接口拉取分钟 K 线（缓存到 data 目录，不写主库），
 *              按仓位模型执行回测，把结果填充回信号文件，并导出 XLSX。
 *
 * 仓位/资金模型（实盘模拟）：
 * - 初始资金默认 $1000，每单风险默认 $50（可用 --initial-capital / --risk-per-trade 调整）。
 * - 多入场位置时每个入场均分风险（N 个入场各承担 risk/N）。
 * - 仓位大小 = 承担风险 / |入场价 - 止损价|。
 * - 分批止盈：N 个止盈目标各平掉 1/N 仓位；止损触发则平掉剩余仓位。
 * - 平均入场价 / 平均出场价 = 按仓位加权的均价。
 * - 回测结果除盈亏点位（pips）外，还输出美元盈亏、账户余额，并按月/按周统计收益。
 *
 * 行情数据来源（均无需认证凭证）：
 * - CFD 品种（黄金 XAUUSD、白银 XAGUSD、外汇等）→ GET /api/v4/tradfi/symbols/{symbol}/klines
 * - 加密货币（BTC_USDT、ETH_USDT 等）→ GET /api/v4/futures/usdt/candlesticks
 *
 * 回测规则（K 线周期固定为分钟）：
 * - 入场：市价单取信号后首根 K 线收盘价；限价单等收盘价触及入场位。
 * - 出场：TP/SL 用 K 线最高/最低价触发，按多空方向应用让点（默认止盈让 5.5 / 止损让 0.9）。
 * - 持仓过夜不设超时，数据结束仍未平仓按最后一根收盘价标记市值（记为「未平仓」）。
 *
 * 用法：
 *   # 阶段一：解析并输出信号文件（输出文件已存在时会按秒级时间戳去重，
 *   #          与已有信号时间戳重复的消息直接跳过不解析，新信号增量追加到末尾）
 *   npx ts-node scripts/parser-backtest.ts parse \
 *     --parser MansoorParser \
 *     --input examples/mansoor.json \
 *     --output examples/mansoor_signals.json
 *
 *   # 阶段二：拉取 K 线回测，填充结果并导出 XLSX（默认输出到 docs/backtest/{解析器}_{时间戳}.xlsx）
 *   npx ts-node scripts/parser-backtest.ts backtest \
 *     --input examples/mansoor_signals.json \
 *     --output docs/backtest/MansoorParser_20260822013000.xlsx
 */
import fs from 'fs';
import path from 'path';
import axios from 'axios';
import { AsyncLocalStorage } from 'async_hooks';
import AdmZip from 'adm-zip';
import { Command } from 'commander';
import registry from '../src/services/parsers';
import { ParsedStrategy } from '../src/services/parsers/types';
import aiParserService from '../src/services/AIParserService';
import marketService from '../src/services/MarketService';
import * as XLSX from 'xlsx-js-style';

// ─── 类型 ────────────────────────────────────────────────────────────────

type Candle = { ts: number; o: number; h: number; l: number; c: number };

type BacktestSignal = {
  id: number;
  timestamp: string;
  symbol: string;
  side: 'buy' | 'sell';
  entryPrice: number | null;
  entries: number[];
  tps: number[];
  sl: number | null;
  sourceType: string;
  rawMessage: string;
  backtest: BacktestResult | null;
};

type BacktestResult = {
  signalId: number;
  timestamp: string;
  symbol: string;
  direction: string;
  sourceType: string;
  entryPrice: number | null;
  actualEntry: number | null;
  avgExit: number | null;
  tp: number | null;
  sl: number | null;
  tps: number[];
  effTps: number[];
  effSl: number | null;
  outcome: 'tp' | 'partial' | 'sl' | 'open' | 'no_data';
  tpHit: boolean;
  slHit: boolean;
  tpHitCount: number;
  tpTimeMin: number | null;
  slTimeMin: number | null;
  durationMin: number | null;
  maxFavorablePrice: number | null;
  maxFavorablePips: number | null;
  profitPips: number;
  positionSize: number | null;
  profitUsd: number;
  accountBalance: number;
};

type SignalsFile = {
  meta: { parser: string; source: string; parsedAt: string; textOnly: boolean };
  signals: BacktestSignal[];
};

// ─── 常量 ────────────────────────────────────────────────────────────────

const GATE_API_BASE = 'https://api.gateio.ws/api/v4';

/** 内部符号 → Gate tradfi CFD 符号。未在此表内的符号默认走加密货币合约。 */
const CFD_SYMBOL_MAP: Record<string, string> = {
  XAU_USDT: 'XAUUSD',
  XAG_USDT: 'XAGUSD',
  USDJPY: 'USDJPY',
  EURUSD: 'EURUSD',
  GBPUSD: 'GBPUSD',
  AUDUSD: 'AUDUSD',
  NZDUSD: 'NZDUSD',
  USDCAD: 'USDCAD',
  USDCHF: 'USDCHF',
};

const TRADFI_PAGE_SIZE = 500;
const CRYPTO_CHUNK_CANDLES = 1000;

// ─── K 线获取（公开接口，无需凭证；缓存到 data 目录，不写主库） ──────────

function resolveDataSource(symbol: string): { type: 'cfd' | 'crypto'; apiSymbol: string } {
  const cfd = CFD_SYMBOL_MAP[symbol];
  if (cfd) return { type: 'cfd', apiSymbol: cfd };
  // 常见 CFD/外汇形态兜底（去掉 _USDT 后缀后按 tradfi 符号请求）
  if (/^(XAU|XAG|USDJPY|EURUSD|GBPUSD|AUDUSD|NZDUSD|USDCAD|USDCHF|EURJPY|GBPJPY)/.test(symbol)) {
    return { type: 'cfd', apiSymbol: symbol.replace(/_USDT$/, '') };
  }
  return { type: 'crypto', apiSymbol: symbol };
}

async function fetchTradFiKlines(apiSymbol: string, interval: string, startTs: number, endTs: number): Promise<Candle[]> {
  const candles: Candle[] = [];
  let currentEnd = endTs;
  while (currentEnd > startTs) {
    const { data } = await axios.get(`${GATE_API_BASE}/tradfi/symbols/${apiSymbol}/klines`, {
      params: { kline_type: interval, end_time: currentEnd, limit: TRADFI_PAGE_SIZE },
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
    if (candles.length > 300000) break; // 安全上限
  }
  candles.sort((a, b) => a.ts - b.ts);
  return candles;
}

async function fetchCryptoKlines(contract: string, interval: string, startTs: number, endTs: number): Promise<Candle[]> {
  const candles: Candle[] = [];
  let from = startTs;
  while (from < endTs) {
    const to = Math.min(from + CRYPTO_CHUNK_CANDLES * 60, endTs);
    const { data } = await axios.get(`${GATE_API_BASE}/futures/usdt/candlesticks`, {
      params: { contract, interval, from, to },
      timeout: 30000,
    });
    if (!Array.isArray(data) || !data.length) break;
    for (const c of data) {
      const t = Number(c.t);
      if (t >= startTs && t <= endTs) {
        candles.push({ ts: t, o: Number(c.o), h: Number(c.h), l: Number(c.l), c: Number(c.c) });
      }
    }
    const last = Math.max(...data.map((c) => Number(c.t)));
    if (last >= endTs) break;
    from = last + 60;
    if (candles.length > 300000) break; // 安全上限
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
  const payload = {
    meta: { symbol, interval, count: candles.length, cachedAt: new Date().toISOString() },
    candles,
  };
  fs.writeFileSync(cacheFile, JSON.stringify(payload));
}

async function getKlines(
  symbol: string,
  interval: string,
  startTs: number,
  endTs: number,
  cacheDir: string,
): Promise<Candle[]> {
  const { type, apiSymbol } = resolveDataSource(symbol);
  const cacheFile = path.join(cacheDir, `${apiSymbol}_${interval}.json`);

  const cached = loadCachedKlines(cacheFile);
  if (cached && cached.length) {
    const first = cached[0].ts;
    const last = cached[cached.length - 1].ts;
    if (first <= startTs && last >= endTs) {
      console.log(`  [${symbol}] 命中 K 线缓存 ${cached.length} 根 (${apiSymbol})`);
      return cached;
    }
    console.log(`  [${symbol}] 缓存范围不足（缓存 ${first}~${last}，需要 ${startTs}~${endTs}），重新拉取`);
  }

  console.log(`  [${symbol}] 拉取 ${type} 分钟 K 线 (${apiSymbol})...`);
  const candles =
    type === 'cfd'
      ? await fetchTradFiKlines(apiSymbol, interval, startTs, endTs)
      : await fetchCryptoKlines(apiSymbol, interval, startTs, endTs);
  saveCachedKlines(cacheFile, candles, symbol, interval);
  console.log(`  [${symbol}] 拉取完成 ${candles.length} 根 → ${cacheFile}`);
  return candles;
}

/**
 * 拉取某品种在指定时刻附近的分钟 K 线收盘价（公开接口）。
 * 用于独立脚本环境下给解析器的 G3 贴近市价守卫提供历史价格。
 */
async function fetchPriceAt(symbol: string, ts: number): Promise<number> {
  const { type, apiSymbol } = resolveDataSource(symbol);
  const from = Math.floor(ts) - 120;
  const to = Math.floor(ts) + 60;
  let candles: Candle[] = [];
  if (type === 'cfd') {
    candles = await fetchTradFiKlines(apiSymbol, '1m', from, to);
  } else {
    candles = await fetchCryptoKlines(apiSymbol, '1m', from, to);
  }
  // 取信号时刻之前最近一根已收盘 K 线的收盘价
  const prior = candles.filter((c) => c.ts <= ts);
  if (prior.length) return prior[prior.length - 1].c;
  if (candles.length) return candles[0].c;
  return 0;
}

// ─── 回测引擎（仓位模型 · 分批止盈 · 分钟级） ───────────────────────────

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

function backtestSignal(
  signal: BacktestSignal,
  candles: Candle[],
  tpSlippage: number,
  slSlippage: number,
  riskPerTrade: number,
): BacktestResult {
  const result: BacktestResult = {
    signalId: signal.id,
    timestamp: signal.timestamp,
    symbol: signal.symbol,
    direction: signal.side,
    sourceType: signal.sourceType,
    entryPrice: signal.entryPrice,
    actualEntry: null,
    avgExit: null,
    tp: signal.tps.length ? signal.tps[0] : null,
    sl: signal.sl,
    tps: signal.tps,
    effTps: [],
    effSl: null,
    outcome: 'no_data',
    tpHit: false,
    slHit: false,
    tpHitCount: 0,
    tpTimeMin: null,
    slTimeMin: null,
    durationMin: null,
    maxFavorablePrice: null,
    maxFavorablePips: null,
    profitPips: 0,
    positionSize: null,
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
  if (startIdx >= candles.length) return result;

  const entries = signal.entries.length
    ? signal.entries
    : signal.entryPrice != null
      ? [signal.entryPrice]
      : [];
  if (!entries.length) return result;

  const nEntry = entries.length;
  const nTp = signal.tps.length;
  const riskPerEntry = riskPerTrade / nEntry;

  const effTps = signal.tps.map((tp) => (isBuy ? round2(tp - tpSlippage) : round2(tp + tpSlippage)));
  const effSl = isBuy ? round2(signal.sl + slSlippage) : round2(signal.sl - slSlippage);
  result.effTps = effTps;
  result.effSl = effSl;

  let totalProfitUsd = 0;
  let totalPips = 0;
  let totalSize = 0;
  let entrySum = 0;
  let exitSum = 0;
  let totalFilledFraction = 0;
  let firstEntryTime: number | null = null;
  let lastFillTime: number | null = null;
  let firstTpTime: number | null = null;
  let slTime: number | null = null;
  let anyTpHit = false;
  let anySlHit = false;
  let maxTpIndex = -1;
  let maxFavorable = entries[0];
  let anyEntryFilled = false;

  for (const E of entries) {
    // 入场（收盘价）
    let entryPrice: number;
    let entryIdx: number;
    if (signal.entryPrice == null) {
      entryPrice = candles[startIdx].c;
      entryIdx = startIdx;
    } else {
      entryIdx = -1;
      for (let i = startIdx; i < candles.length; i++) {
        const c = candles[i];
        if ((isBuy && c.c <= E) || (!isBuy && c.c >= E)) {
          entryPrice = c.c;
          entryIdx = i;
          break;
        }
      }
      if (entryIdx === -1) continue; // 数据结束前未触及入场价 → 该入场未成交
      entryPrice = candles[entryIdx].c;
    }

    const size = riskPerEntry / Math.abs(E - signal.sl);
    totalSize += size;
    entrySum += E * size;
    anyEntryFilled = true;
    const entryTime = candles[entryIdx].ts;
    if (firstEntryTime == null) firstEntryTime = entryTime;

    // 分批止盈出场
    let remaining = 1;
    let tpIndex = 0;
    let entryMaxFav = entryPrice;
    const fills: { price: number; fraction: number; time: number }[] = [];

    for (let j = entryIdx + 1; j < candles.length; j++) {
      const c = candles[j];
      entryMaxFav = isBuy ? Math.max(entryMaxFav, c.h) : Math.min(entryMaxFav, c.l);

      let slTouched = (isBuy && c.l <= effSl) || (!isBuy && c.h >= effSl);
      const tpTouched: number[] = [];
      for (let k = tpIndex; k < nTp; k++) {
        if ((isBuy && c.h >= effTps[k]) || (!isBuy && c.l <= effTps[k])) tpTouched.push(k);
        else break;
      }

      // 同一根 K 线同时触及 TP/SL，取离入场价更近的价位成交（保守）
      if (slTouched && tpTouched.length) {
        if (Math.abs(effSl - E) <= Math.abs(effTps[tpTouched[0]] - E)) tpTouched.length = 0;
        else slTouched = false;
      }

      if (slTouched) {
        fills.push({ price: effSl, fraction: remaining, time: c.ts });
        slTime = c.ts;
        anySlHit = true;
        remaining = 0;
        break;
      }

      for (const k of tpTouched) {
        fills.push({ price: effTps[k], fraction: 1 / nTp, time: c.ts });
        anyTpHit = true;
        maxTpIndex = Math.max(maxTpIndex, k);
        if (firstTpTime == null) firstTpTime = c.ts;
        remaining -= 1 / nTp;
        tpIndex = k + 1;
        if (remaining <= 0) break;
      }
      if (remaining <= 0) break;
    }

    if (remaining > 0) {
      // 数据结束仍未平仓 → 按最后一根收盘价标记市值
      const last = candles[candles.length - 1];
      fills.push({ price: last.c, fraction: remaining, time: last.ts });
    }

    for (const f of fills) {
      const profit = (isBuy ? f.price - E : E - f.price) * size * f.fraction;
      totalProfitUsd += profit;
      totalPips += (isBuy ? f.price - E : E - f.price) * f.fraction * 100;
      exitSum += f.price * size * f.fraction;
      totalFilledFraction += size * f.fraction;
      lastFillTime = f.time;
    }
    maxFavorable = isBuy ? Math.max(maxFavorable, entryMaxFav) : Math.min(maxFavorable, entryMaxFav);
  }

  if (!anyEntryFilled || totalSize <= 0) {
    result.outcome = 'open';
    return result;
  }

  const avgEntry = entrySum / totalSize;
  result.actualEntry = round2(avgEntry);
  result.avgExit = totalFilledFraction > 0 ? round2(exitSum / totalFilledFraction) : null;
  result.positionSize = round2(totalSize);
  result.profitUsd = round2(totalProfitUsd);
  result.profitPips = round1(totalPips);
  result.maxFavorablePrice = round2(maxFavorable);
  result.maxFavorablePips = round1(Math.abs(maxFavorable - avgEntry) * 100);
  result.tpHitCount = maxTpIndex + 1;

  if (anySlHit && anyTpHit) result.outcome = 'partial';
  else if (anySlHit) result.outcome = 'sl';
  else if (anyTpHit) result.outcome = 'tp';
  else result.outcome = 'open';

  result.tpHit = anyTpHit;
  result.slHit = anySlHit;
  if (firstTpTime != null && firstEntryTime != null) result.tpTimeMin = round1((firstTpTime - firstEntryTime) / 60);
  if (slTime != null && firstEntryTime != null) result.slTimeMin = round1((slTime - firstEntryTime) / 60);
  if (lastFillTime != null && firstEntryTime != null) result.durationMin = Math.round((lastFillTime - firstEntryTime) / 60);

  return result;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** 时间戳秒级去重键：统一转 UTC 后取秒精度（YYYY-MM-DDTHH:mm:ss），毫秒及以下忽略。 */
function secondKey(ts: unknown): string | null {
  if (typeof ts !== 'string' || !ts) return null;
  const t = new Date(ts).getTime();
  if (!Number.isFinite(t)) return null;
  return new Date(t).toISOString().slice(0, 19);
}

// ─── 阶段一：解析器干跑 ─────────────────────────────────────────────────

function buildDiscordMessage(message: any, index: number): any {
  const attachments = (message.attachments || []).map((a: any) => {
    const url = a.proxy_url || a.url || '';
    const isImage = /\.(png|jpg|jpeg|gif|webp)(\?|$)/i.test(url);
    return { ...a, is_image: isImage };
  });
  return {
    id: `backtest-${index + 1}`,
    channel_id: message.channel_id || 'unknown-channel',
    content: message.content || '',
    ts: message.timestamp || new Date().toISOString(),
    username: 'backtest',
    attachments,
  };
}

/**
 * 并发池：以 limit 个 worker 并行处理 items，结果按原顺序返回。
 * 用于 AI（图片）解析——最多 3 个并发调用视觉大模型，其余排队等待。
 */
async function mapLimit<T, R>(items: T[], limit: number, worker: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const idx = next++;
      results[idx] = await worker(items[idx], idx);
    }
  });
  await Promise.all(runners);
  return results;
}

/** 每条消息的「信号时刻」上下文：并发解析时给 G3 贴近市价守卫提供各自的历史价格。 */
const priceContext = new AsyncLocalStorage<number>();

async function replayParser(
  parserName: string,
  messages: any[],
  textOnly: boolean,
  concurrency = 3,
  seenSeconds: Set<string> = new Set(),
): Promise<BacktestSignal[]> {
  const parser = registry.getParserByName(parserName);
  if (!parser) {
    throw new Error(`解析器不存在: ${parserName}。可用: ${registry.getAllParsers().map((p) => p.name).join(', ')}`);
  }

  await aiParserService.reloadConfig();

  // 独立脚本环境下无交易所实例，marketService.getCurrentPrice 恒返回 0，
  // 会导致解析器的 G3 贴近市价守卫误拒图片信号。这里打补丁：真实实现返回 0 时，
  // 回退到从公开接口拉取「当前正在解析的消息」时刻的历史价格。
  // 并发场景下用 AsyncLocalStorage 按异步上下文区分各消息的时刻，避免互相覆盖。
  const originalGetCurrentPrice = marketService.getCurrentPrice.bind(marketService);
  marketService.getCurrentPrice = async (symbol: string) => {
    const real = await originalGetCurrentPrice(symbol);
    if (real > 0) return real;
    const signalTime = priceContext.getStore();
    if (signalTime && signalTime > 0) {
      const historical = await fetchPriceAt(symbol, signalTime);
      if (historical > 0) return historical;
    }
    return 0;
  };

  const parsedResults = await mapLimit(messages, concurrency, async (msg, i) => {
    const signalTime = new Date(msg.timestamp || Date.now()).getTime() / 1000;
    const parseInput = buildDiscordMessage(msg, i);

    // textOnly 模式：去掉附件，强制只走文本解析（跳过视觉 AI 调用）
    if (textOnly) {
      parseInput.attachments = [];
    }

    const parsed = await priceContext.run(signalTime, () => parser.parse(parseInput, true));
    return { msg, parsed };
  });

  const signals: BacktestSignal[] = [];
  for (let i = 0; i < parsedResults.length; i++) {
    const { msg, parsed } = parsedResults[i];
    if (!parsed) continue;

    // 秒级时间戳去重：本批消息中已有信号占用的时刻，直接跳过该消息（不产出信号）
    const msgKey = secondKey(msg.timestamp);
    if (msgKey && seenSeconds.has(msgKey)) {
      console.log(`  跳过消息 [${msg.timestamp}]：秒级时间戳与已有信号重复`);
      continue;
    }

    const produced: BacktestSignal[] = [];
    for (const s of parsed) {
      if (s.action !== 'open') continue;
      const entryPrice = s.entryPrice ? parseFloat(s.entryPrice) : null;
      const tps = (s.targets || [])
        .map((t) => parseFloat(t))
        .filter((v) => Number.isFinite(v));
      const sl = s.stopLoss ? parseFloat(s.stopLoss) : null;
      produced.push({
        id: 0, // 稍后统一编号
        timestamp: msg.timestamp || new Date().toISOString(),
        symbol: s.symbol,
        side: s.side === 'sell' ? 'sell' : 'buy',
        entryPrice: Number.isFinite(entryPrice as number) ? entryPrice : null,
        entries: Number.isFinite(entryPrice as number) ? [entryPrice as number] : [],
        tps,
        sl: Number.isFinite(sl as number) ? sl : null,
        sourceType: s.sourceType || 'text',
        rawMessage: msg.content || '',
        backtest: null,
      });
    }

    if (produced.length) {
      if (msgKey) seenSeconds.add(msgKey);
      for (const s of produced) {
        s.id = signals.length + 1;
        signals.push(s);
      }
    }

    if ((i + 1) % 50 === 0 || i === parsedResults.length - 1) {
      console.log(`  解析进度 ${i + 1}/${parsedResults.length}，累计开仓信号 ${signals.length}`);
    }
  }

  return signals;
}

// ─── XLSX 导出 ──────────────────────────────────────────────────────────

const DETAIL_HEADERS = [
  '信号#', '日期', '时间', '方向', '信号来源',
  '指定入场价', '实际入场价', '平均出场价', '最大浮盈价',
  'TP', 'SL', '有效TP', '有效SL',
  '结果', 'TP命中', 'SL触发',
  'TP耗时(分)', 'SL耗时(分)', '持仓时间(分)',
  '最大浮盈(pips)', '盈亏(pips)',
  '仓位(单位)', '盈亏($)', '账户余额($)',
];

const OUTCOME_DISPLAY: Record<string, string> = {
  tp: '🟢 TP',
  partial: '🟡 部分止盈',
  sl: '🔴 SL',
  open: '🔵 未平仓',
  no_data: '⚪ 无数据',
};

function sourceDisplay(sourceType: string): string {
  return sourceType === 'image' ? 'AI 解析' : '程序解析';
}

function buildDetailRows(results: BacktestResult[]): (string | number)[][] {
  return results.map((r) => [
    r.signalId,
    r.timestamp ? r.timestamp.slice(0, 10) : '',
    r.timestamp ? r.timestamp.slice(11, 19) : '',
    r.direction.toUpperCase(),
    sourceDisplay(r.sourceType),
    r.entryPrice ?? '',
    r.actualEntry ?? '',
    r.avgExit ?? '',
    r.maxFavorablePrice ?? '',
    r.tps.length ? r.tps.join('/') : '',
    r.sl ?? '',
    r.effTps.length ? r.effTps.join('/') : '',
    r.effSl ?? '',
    OUTCOME_DISPLAY[r.outcome] || r.outcome,
    r.tpHit ? (r.tps.length > 1 ? `TP1-${r.tpHitCount}` : '✅') : '',
    r.slHit ? '✅' : '',
    r.tpTimeMin ?? '',
    r.slTimeMin ?? '',
    r.durationMin ?? '',
    r.maxFavorablePips ?? '',
    r.profitPips,
    r.positionSize ?? '',
    round2(r.profitUsd),
    round2(r.accountBalance),
  ]);
}

function weekStartKey(timestamp: string): string {
  const d = new Date(timestamp);
  const day = (d.getDay() + 6) % 7; // 周一=0
  const monday = new Date(d);
  monday.setDate(d.getDate() - day);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${monday.getFullYear()}-${p(monday.getMonth() + 1)}-${p(monday.getDate())}`;
}

function buildSummaryRows(results: BacktestResult[], initialCapital: number): (string | number)[][] {
  const total = results.length;
  const wins = results.filter((r) => r.profitUsd > 0);
  const losses = results.filter((r) => r.profitUsd < 0);
  const opens = results.filter((r) => r.outcome === 'open');
  const totalProfitUsd = results.reduce((s, r) => s + r.profitUsd, 0);
  const finalCapital = initialCapital + totalProfitUsd;
  const totalPips = results.reduce((s, r) => s + r.profitPips, 0);

  const avgWin = wins.length ? wins.reduce((s, r) => s + r.profitUsd, 0) / wins.length : 0;
  const avgLoss = losses.length ? losses.reduce((s, r) => s + Math.abs(r.profitUsd), 0) / losses.length : 0;
  const profitFactor = avgLoss > 0 ? avgWin / avgLoss : Infinity;

  const maxProfitTrade = results.length ? results.reduce((a, b) => (b.profitUsd > a.profitUsd ? b : a)) : null;
  const maxLossTrade = results.length ? results.reduce((a, b) => (b.profitUsd < a.profitUsd ? b : a)) : null;

  const unfilled = results.filter((r) => !r.tpHit && (r.maxFavorablePips || 0) > 0);
  const avgMaxFav = unfilled.length ? unfilled.reduce((s, r) => s + (r.maxFavorablePips || 0), 0) / unfilled.length : 0;
  const maxFavTrade = unfilled.length ? unfilled.reduce((a, b) => ((b.maxFavorablePips || 0) > (a.maxFavorablePips || 0) ? b : a)) : null;

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

  const rows: (string | number)[][] = [];
  rows.push(['回测统计汇总（收盘价入场 · 高低价触发 · 分批止盈 · 止盈让5.5/止损让0.9）']);
  rows.push([]);
  rows.push(['初始资金 ($)', round2(initialCapital)]);
  rows.push(['最终资金 ($)', round2(finalCapital)]);
  rows.push(['总盈亏 ($)', `${totalProfitUsd >= 0 ? '+' : ''}${round2(totalProfitUsd)}`]);
  rows.push(['收益率', `${((totalProfitUsd / initialCapital) * 100).toFixed(2)}%`]);
  rows.push([]);
  rows.push(['总信号数', total]);
  rows.push(['盈利单数', wins.length]);
  rows.push(['亏损单数', losses.length]);
  rows.push(['未平仓数', opens.length]);
  rows.push(['总利润 (pips)', round1(totalPips)]);
  rows.push(['胜率', wins.length + losses.length ? `${((wins.length / (wins.length + losses.length)) * 100).toFixed(1)}%` : 'N/A']);
  rows.push(['盈亏比', results.length ? round2(profitFactor) : 'N/A']);
  rows.push(['平均盈利 ($)', results.length ? round2(avgWin) : 'N/A']);
  rows.push(['平均亏损 ($)', results.length ? round2(avgLoss) : 'N/A']);
  if (maxProfitTrade) rows.push(['单笔最大盈利 ($)', `${maxProfitTrade.profitUsd >= 0 ? '+' : ''}${round2(maxProfitTrade.profitUsd)} (#${maxProfitTrade.signalId})`]);
  if (maxLossTrade) rows.push(['单笔最大亏损 ($)', `${maxLossTrade.profitUsd >= 0 ? '+' : ''}${round2(maxLossTrade.profitUsd)} (#${maxLossTrade.signalId})`]);
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
    rows.push(['最高最大浮盈', `${(maxFavTrade.maxFavorablePips || 0) >= 0 ? '+' : ''}${(maxFavTrade.maxFavorablePips || 0).toFixed(1)} pips (#${maxFavTrade.signalId} ${maxFavTrade.timestamp.slice(0, 10)} ${maxFavTrade.direction.toUpperCase()})`]);
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

// ─── XLSX 样式 ─────────────────────────────────────────────────────────

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
    partial: { patternType: 'solid', fgColor: { rgb: 'FFEB9C' } },
    sl: { patternType: 'solid', fgColor: { rgb: 'FFC7CE' } },
    open: { patternType: 'solid', fgColor: { rgb: 'DDEBF7' } },
    no_data: { patternType: 'solid', fgColor: { rgb: 'F2F2F2' } },
  },
};

function applyCellStyle(ws: XLSX.WorkSheet, r: number, c: number, style: any): void {
  const cell = ws[XLSX.utils.encode_cell({ r, c })];
  if (cell) cell.s = { ...(cell.s || {}), ...style };
}

/**
 * xlsx-js-style 不写冻结窗格，这里用 adm-zip 后处理注入 <pane>。
 * sheetIndex 从 1 开始（对应 xl/worksheets/sheet{N}.xml）。
 */
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

function exportToXlsx(results: BacktestResult[], outputPath: string, initialCapital: number): void {
  const wb = XLSX.utils.book_new();

  // ── 交易明细 ──
  const detailRows = buildDetailRows(results);
  const detailWs = XLSX.utils.aoa_to_sheet([DETAIL_HEADERS, ...detailRows]);
  detailWs['!cols'] = [8, 12, 10, 8, 11, 12, 12, 12, 12, 14, 10, 14, 10, 13, 10, 8, 12, 12, 12, 14, 12, 12, 12, 12].map((wch) => ({ wch }));

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
      if (c === 13 && res && STYLE.outcomeFills[res.outcome]) {
        style.fill = STYLE.outcomeFills[res.outcome];
        style.font = { bold: true };
      }
      if (c === 22) {
        const v = res?.profitUsd || 0;
        style.numFmt = '+0.00;-0.00;0.00';
        style.font = v > 0 ? STYLE.greenFont : v < 0 ? STYLE.redFont : undefined;
      }
      if (c === 23) style.numFmt = '0.00';
      applyCellStyle(detailWs, r, c, style);
    }
  }
  XLSX.utils.book_append_sheet(wb, detailWs, '交易明细');

  // ── 统计汇总 ──
  const summaryRows = buildSummaryRows(results, initialCapital);
  const summaryWs = XLSX.utils.aoa_to_sheet(summaryRows);
  summaryWs['!cols'] = [{ wch: 26 }, { wch: 40 }];

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
  XLSX.utils.book_append_sheet(wb, summaryWs, '统计汇总');

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  XLSX.writeFile(wb, outputPath);
  injectFreezePane(outputPath, 1, 1); // 交易明细冻结首行
  console.log(`\nXLSX 已导出: ${outputPath}`);
}

// ─── 阶段二：回测主流程 ─────────────────────────────────────────────────

async function runBacktest(opts: any): Promise<void> {
  const inputFile = path.resolve(process.cwd(), opts.input);
  const cacheDir = path.resolve(process.cwd(), opts.cacheDir);
  const tpSlippage = parseFloat(opts.tpSlippage);
  const slSlippage = parseFloat(opts.slSlippage);
  const marginDays = parseInt(opts.klineMarginDays, 10) || 1;
  const interval = opts.interval || '1m';
  const initialCapital = parseFloat(opts.initialCapital) || 1000;
  const riskPerTrade = parseFloat(opts.riskPerTrade) || 50;

  if (!fs.existsSync(inputFile)) {
    throw new Error(`信号文件不存在: ${inputFile}`);
  }

  const signalsFile = JSON.parse(fs.readFileSync(inputFile, 'utf8')) as SignalsFile;
  const signals = signalsFile.signals || [];
  const parserName = signalsFile.meta?.parser || 'Parser';

  // 默认输出到 docs/backtest/{解析器}_{YYYYMMDDHHmmss}.xlsx
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

  // 1. 按品种拉取 K 线（缓存到 data 目录）
  const tsList = signals.map((s) => new Date(s.timestamp).getTime() / 1000);
  const minTs = Math.floor(Math.min(...tsList)) - marginDays * 86400;
  const maxTs = Math.floor(Math.max(...tsList)) + marginDays * 86400;
  const symbols = Array.from(new Set(signals.map((s) => s.symbol)));

  console.log(`\n[1/3] 拉取 ${symbols.length} 个品种 K 线 (${interval})...`);
  const klinesBySymbol: Record<string, Candle[]> = {};
  for (const symbol of symbols) {
    klinesBySymbol[symbol] = await getKlines(symbol, interval, minTs, maxTs, cacheDir);
  }

  // 2. 执行回测（按时间顺序跟踪账户余额）
  console.log(`\n[2/3] 执行回测 ${signals.length} 条信号...`);
  const sorted = [...signals].sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
  );
  let capital = initialCapital;
  const results: BacktestResult[] = [];
  for (const s of sorted) {
    const r = backtestSignal(s, klinesBySymbol[s.symbol] || [], tpSlippage, slSlippage, riskPerTrade);
    capital += r.profitUsd;
    r.accountBalance = round2(capital);
    results.push(r);
  }

  // 3. 把回测结果填充回信号文件
  const byId = new Map(results.map((r) => [r.signalId, r]));
  for (const s of signals) {
    s.backtest = byId.get(s.id) || null;
  }
  fs.writeFileSync(inputFile, JSON.stringify(signalsFile, null, 2));
  console.log(`回测结果已填充回: ${inputFile}`);

  const tpCount = results.filter((r) => r.outcome === 'tp').length;
  const partialCount = results.filter((r) => r.outcome === 'partial').length;
  const slCount = results.filter((r) => r.outcome === 'sl').length;
  const openCount = results.filter((r) => r.outcome === 'open').length;
  const noDataCount = results.filter((r) => r.outcome === 'no_data').length;
  const totalProfit = results.reduce((s, r) => s + r.profitUsd, 0);
  console.log(
    `回测完成: TP=${tpCount} 部分止盈=${partialCount} SL=${slCount} 未平仓=${openCount} 无数据=${noDataCount}`,
  );
  console.log(`总盈亏: ${totalProfit >= 0 ? '+' : ''}$${round2(totalProfit)}（初始 $${initialCapital} → 最终 $${round2(capital)}）`);

  // 4. 导出 XLSX
  exportToXlsx(results, outputFile, initialCapital);
}

// ─── 主入口 ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const program = new Command();
  program.name('parser-backtest').description('通用解析器回测框架：两阶段（parse 解析信号 → backtest 仓位模型回测导出 XLSX）');

  program
    .command('parse')
    .description('阶段一：干跑解析历史消息，输出开仓信号 JSON 文件')
    .option('--parser <name>', '解析器名称', 'MansoorParser')
    .option('--input <path>', '规范化消息 JSON 输入文件', 'examples/mansoor.json')
    .option('--output <path>', '信号 JSON 输出路径', 'examples/mansoor_signals.json')
    .option('--text-only', '仅文本解析，跳过图片视觉 AI 调用')
    .option('--concurrency <n>', 'AI（图片）解析最大并发数', '3')
    .action(async (opts) => {
      const inputFile = path.resolve(process.cwd(), opts.input);
      const outputFile = path.resolve(process.cwd(), opts.output);
      if (!fs.existsSync(inputFile)) throw new Error(`输入文件不存在: ${inputFile}`);

      console.log(`解析器: ${opts.parser}`);
      console.log(`输入: ${inputFile}`);
      console.log(`输出: ${outputFile}`);
      console.log(`文本模式: ${opts.textOnly ? '仅文本（跳过视觉 AI）' : '文本 + 图片视觉'}`);
      console.log(`AI 解析并发: ${opts.concurrency}`);

      const messages = JSON.parse(fs.readFileSync(inputFile, 'utf8')) as any[];

      // 已有输出文件中的信号：用于秒级时间戳去重，未重复的新信号将增量追加到文件末尾
      let existingSignals: BacktestSignal[] = [];
      if (fs.existsSync(outputFile)) {
        try {
          const existing = JSON.parse(fs.readFileSync(outputFile, 'utf8')) as SignalsFile;
          existingSignals = existing.signals || [];
          console.log(`检测到已有信号文件，已加载 ${existingSignals.length} 条信号，将做秒级去重并增量追加`);
        } catch {
          console.log(`警告: 输出文件 ${outputFile} 不是有效 JSON，将重新生成。`);
        }
      }

      // 秒级时间戳去重：消息时间戳（秒级）与已有信号重复 → 整条消息跳过，不做解析
      const seenSeconds = new Set<string>();
      for (const s of existingSignals) {
        const k = secondKey(s.timestamp);
        if (k) seenSeconds.add(k);
      }
      const toParse = messages.filter((m) => {
        const k = secondKey(m.timestamp);
        return !(k && seenSeconds.has(k));
      });
      const skippedCount = messages.length - toParse.length;
      if (skippedCount) {
        console.log(`秒级时间戳去重: 跳过 ${skippedCount} 条与已有信号时间戳重复的消息`);
      }

      console.log(`\n干跑解析 ${toParse.length} 条消息（输入共 ${messages.length} 条）...`);
      const signals = await replayParser(opts.parser, toParse, !!opts.textOnly, parseInt(opts.concurrency, 10) || 3, seenSeconds);

      // 增量追加：新信号接在已有信号之后，重新编号
      const merged = [...existingSignals];
      let nextId = merged.length;
      for (const s of signals) {
        s.id = ++nextId;
        merged.push(s);
      }

      const signalsFile: SignalsFile = {
        meta: {
          parser: opts.parser,
          source: inputFile,
          parsedAt: new Date().toISOString(),
          textOnly: !!opts.textOnly,
        },
        signals: merged,
      };
      fs.mkdirSync(path.dirname(outputFile), { recursive: true });
      fs.writeFileSync(outputFile, JSON.stringify(signalsFile, null, 2));
      console.log(`\n解析完成，新增 ${signals.length} 条开仓信号，累计 ${merged.length} 条 → ${outputFile}`);
    });

  program
    .command('backtest')
    .description('阶段二：读取信号文件，拉取分钟 K 线执行仓位模型回测，填充结果并导出 XLSX')
    .option('--input <path>', '信号 JSON 输入文件', 'examples/mansoor_signals.json')
    .option('--output <path>', 'XLSX 输出路径（默认 docs/backtest/{解析器}_{时间戳}.xlsx）')
    .option('--interval <interval>', 'K 线周期（分钟级，默认 1m）', '1m')
    .option('--tp-slippage <n>', '止盈让点', '5.5')
    .option('--sl-slippage <n>', '止损让点', '0.9')
    .option('--kline-margin-days <n>', '信号区间前后额外拉取 K 线的天数', '1')
    .option('--cache-dir <path>', 'K 线本地缓存目录（data 目录下）', 'data/backtest_cache')
    .option('--initial-capital <n>', '初始资金 ($)', '1000')
    .option('--risk-per-trade <n>', '每单风险 ($)', '50')
    .action(async (opts) => {
      await runBacktest(opts);
    });

  await program.parseAsync(process.argv);
}

main().catch((error) => {
  console.error(error?.message || error);
  process.exit(1);
});
