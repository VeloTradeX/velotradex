/**
 * 回测 K 线拉取器（1 分钟级，公开接口无需凭证）。
 *
 * 数据源与 scripts/parser-backtest.ts 保持一致：
 * - CFD/TradFi 品种（XAU_USDT → XAUUSD 等）→ GET /api/v4/tradfi/symbols/{symbol}/klines
 * - 加密合约 → GET /api/v4/futures/usdt/candlesticks
 * 拉取结果缓存到 data/backtest/candles/{apiSymbol}_1m.json（含范围元数据），
 * 重复回测同时间段不重复请求。
 */
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { toTradFiSymbol } from '../services/exchanges/gate_cfd/cfdSymbol';
import logger from '../utils/logger';

export interface BacktestCandle {
  /** K 线开盘时间（秒） */
  ts: number;
  o: number;
  h: number;
  l: number;
  c: number;
}

const GATE_API_BASE = process.env.GATE_API_BASE || 'https://api.gateio.ws/api/v4';
const TRADFI_PAGE_SIZE = 500;
const CRYPTO_CHUNK_CANDLES = 1000;
const MAX_CANDLES = 400_000; // 单品种安全上限

/** 判定内部符号的数据源；CFD 形态走 tradfi，其余走 USDT 合约 */
export function resolveDataSource(symbol: string): { type: 'cfd' | 'crypto'; apiSymbol: string } {
  const normalized = symbol.toUpperCase();
  if (/^(XAU|XAG|USDJPY|EURUSD|GBPUSD|AUDUSD|NZDUSD|USDCAD|USDCHF|EURJPY|GBPJPY)/.test(normalized)) {
    return { type: 'cfd', apiSymbol: normalized.replace(/_USDT$/, '') };
  }
  // 其余 BASE_USDT 形态：toTradFiSymbol 幂等转换后仍含 '_' 视为加密合约
  const tradfi = toTradFiSymbol(normalized);
  if (tradfi.includes('_')) {
    return { type: 'crypto', apiSymbol: normalized };
  }
  return { type: 'cfd', apiSymbol: tradfi };
}

async function fetchTradFiKlines(apiSymbol: string, startTs: number, endTs: number): Promise<BacktestCandle[]> {
  const candles: BacktestCandle[] = [];
  let currentEnd = endTs;
  while (currentEnd > startTs) {
    const { data } = await axios.get(`${GATE_API_BASE}/tradfi/symbols/${apiSymbol}/klines`, {
      params: { kline_type: '1m', end_time: currentEnd, limit: TRADFI_PAGE_SIZE },
      timeout: 30_000,
    });
    const list: any[] = data?.data?.list || [];
    if (!list.length) break;
    for (const c of list) {
      const t = Number(c.t);
      if (t >= startTs && t <= endTs) {
        candles.push({ ts: t, o: Number(c.o), h: Number(c.h), l: Number(c.l), c: Number(c.c) });
      }
    }
    const earliest = Math.min(...list.map((c: any) => Number(c.t)));
    if (earliest <= startTs) break;
    currentEnd = earliest - 60;
    if (candles.length > MAX_CANDLES) break;
  }
  candles.sort((a, b) => a.ts - b.ts);
  return candles;
}

async function fetchCryptoKlines(contract: string, startTs: number, endTs: number): Promise<BacktestCandle[]> {
  const candles: BacktestCandle[] = [];
  let from = startTs;
  while (from < endTs) {
    const to = Math.min(from + CRYPTO_CHUNK_CANDLES * 60, endTs);
    const { data } = await axios.get(`${GATE_API_BASE}/futures/usdt/candlesticks`, {
      params: { contract, interval: '1m', from, to },
      timeout: 30_000,
    });
    if (!Array.isArray(data) || data.length === 0) break;
    for (const c of data) {
      const t = Number(c.t);
      if (t >= startTs && t <= endTs) {
        candles.push({ ts: t, o: Number(c.o), h: Number(c.h), l: Number(c.l), c: Number(c.c) });
      }
    }
    const last = Math.max(...data.map((c: any) => Number(c.t)));
    if (last >= endTs) break;
    from = last + 60;
    if (candles.length > MAX_CANDLES) break;
  }
  candles.sort((a, b) => a.ts - b.ts);
  return candles;
}

export class CandleFetcher {
  constructor(private readonly cacheDir = path.join(process.cwd(), 'data', 'backtest', 'candles')) {}

  private cacheFile(apiSymbol: string): string {
    return path.join(this.cacheDir, `${apiSymbol}_1m.json`);
  }

  private loadCache(apiSymbol: string, startTs: number, endTs: number): BacktestCandle[] | null {
    const file = this.cacheFile(apiSymbol);
    if (!fs.existsSync(file)) return null;
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      const candles: BacktestCandle[] = Array.isArray(data?.candles) ? data.candles : null;
      if (!candles || candles.length === 0) return null;
      const first = candles[0].ts;
      const last = candles[candles.length - 1].ts;
      if (first <= startTs && last >= endTs) return candles;
      return null;
    } catch {
      return null;
    }
  }

  private saveCache(apiSymbol: string, candles: BacktestCandle[]): void {
    fs.mkdirSync(this.cacheDir, { recursive: true });
    const payload = {
      meta: { symbol: apiSymbol, interval: '1m', count: candles.length, cachedAt: new Date().toISOString() },
      candles,
    };
    fs.writeFileSync(this.cacheFile(apiSymbol), JSON.stringify(payload));
  }

  /** 获取 [startTs, endTs]（秒）的 1m K 线（含边界） */
  async fetch(symbol: string, startTs: number, endTs: number): Promise<BacktestCandle[]> {
    const { type, apiSymbol } = resolveDataSource(symbol);

    const cached = this.loadCache(apiSymbol, startTs, endTs);
    if (cached) {
      logger.info(`[CandleFetcher] ${symbol} 命中 K 线缓存 ${cached.length} 根 (${apiSymbol})`);
      return cached;
    }

    logger.info(`[CandleFetcher] ${symbol} 拉取 1m K 线 (${type}:${apiSymbol}) ${startTs}~${endTs} ...`);
    const candles = type === 'cfd'
      ? await fetchTradFiKlines(apiSymbol, startTs, endTs)
      : await fetchCryptoKlines(apiSymbol, startTs, endTs);
    if (candles.length > 0) {
      this.saveCache(apiSymbol, candles);
    }
    logger.info(`[CandleFetcher] ${symbol} 拉取完成 ${candles.length} 根`);
    return candles;
  }
}
