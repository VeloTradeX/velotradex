/**
 * Gate-CFD（/tradfi/*）品种规格缓存工具。
 *
 * 职责：维护 GET /tradfi/symbols/detail 的品种规格（CfdSymbolSpec），
 * 供 GateCFDExchange.getMarkets / CfdLegPlanner（min/maxOrderVolume、contractVolume）
 * 使用。缓存策略（对齐现有 GateIOExchange 合约缓存模式）：
 *   1. 内存缓存 + TTL（30 分钟，首次调用即拉取，TTL 内直接命中）；
 *   2. rest 拉取成功后写入文件缓存 dict/gate_cfd_symbols.json（格式与
 *      dict/ 兜底字典一致：{ "_comment", "symbols" }）；
 *   3. rest 失败时回退读取该文件缓存（首次运行且接口不可用时即为
 *      dict/gate_cfd_symbols.json 的静态兜底内容）；
 *   4. 都失败则返回空数组并告警日志（上层 CfdLegPlanner 会因缺规格而拒绝信号）。
 *
 * 架构设计见 内部设计文档 §3.1/§3.3。
 */
import fs from 'fs';
import path from 'path';
import logger from '../../../utils/logger';
import { MarketInfo } from '../IExchange';
import { CfdSymbolSpec, CfdRestClientLike } from './types';
import { GateCFDMapper } from './GateCFDMapper';
import { fromTradFiSymbol } from './cfdSymbol';

export class GateCFDSymbolUtils {
  /** 品种规格内存缓存（首次拉取后常驻，TTL 内不再请求接口） */
  private specsCache: CfdSymbolSpec[] | null = null;
  /** 最近一次成功拉取/回退读取的时间戳（ms） */
  private lastLoadedAt = 0;
  /** 内存缓存有效期：30 分钟（与 GateIOExchange.getMarkets 的 30min 一致） */
  private readonly cacheTtlMs = 30 * 60 * 1000;
  /** 文件缓存路径：dict/gate_cfd_symbols.json（既有兜底字典，rest 成功后覆写为最新缓存） */
  private readonly cacheFilePath = path.join(process.cwd(), 'dict', 'gate_cfd_symbols.json');

  /**
   * @param restClient RestClient 最小能力接口（CfdRestClientLike.querySymbolDetail）。
   *   gate_cfd 各模块通过该接口互相注入，避免与具体实现循环依赖。
   */
  constructor(private readonly restClient: CfdRestClientLike) {}

  /**
   * 获取全量品种规格。
   * @param forceRefresh true 时绕过内存 TTL 强制重新拉取。
   * 返回顺序：rest 拉取 → 文件缓存（含静态兜底字典）→ 空数组（告警）。
   */
  async getSpecs(forceRefresh: boolean = false): Promise<CfdSymbolSpec[]> {
    // 内存缓存命中（TTL 有效期内）直接返回，避免高频调用重复请求接口。
    if (
      !forceRefresh &&
      this.specsCache &&
      this.specsCache.length > 0 &&
      Date.now() - this.lastLoadedAt < this.cacheTtlMs
    ) {
      return this.specsCache;
    }

    // 1. 优先 rest 拉取：GET /tradfi/symbols/detail 必须带 symbols 且单次 ≤10（实测：
    //    空参/11+ 均报 INVALID_ARGUMENT），故先经公开接口 GET /tradfi/symbols 拿全量
    //    品种列表（无需凭据），再按每批 10 个查规格。
    try {
      const list = await this.restClient.querySymbols();
      const openSymbols = (Array.isArray(list) ? list : [])
        .filter((r: any) => !r.status || r.status === 'open')
        .map((r: any) => r.symbol)
        .filter(Boolean);
      const specs: CfdSymbolSpec[] = [];
      for (let i = 0; i < openSymbols.length; i += 10) {
        const batch = openSymbols.slice(i, i + 10);
        const rows = await this.restClient.querySymbolDetail(batch);
        if (Array.isArray(rows)) specs.push(...rows);
      }

      if (specs.length > 0) {
        this.specsCache = specs;
        this.lastLoadedAt = Date.now();
        // 写入文件缓存：覆盖 dict/gate_cfd_symbols.json（格式与兜底字典一致），
        // 供后续启动时 rest 失败回退使用。
        this.saveToFile(specs);
        logger.info(
          `[GateCFDSymbolUtils] Fetched ${specs.length} CFD symbols from /tradfi/symbols + detail`
        );
        return specs;
      }
      logger.warn('[GateCFDSymbolUtils] /tradfi/symbols or detail returned empty list');
    } catch (err: any) {
      logger.warn('[GateCFDSymbolUtils] Failed to fetch symbol detail, falling back to file cache', {
        error: err?.message || err,
      });
    }

    // 2. rest 失败/空结果 → 回退读取文件缓存（dict/gate_cfd_symbols.json，
    //    可能为上次成功缓存或静态兜底字典内容）
    const fileSpecs = this.loadFromFile();
    if (fileSpecs.length > 0) {
      this.specsCache = fileSpecs;
      this.lastLoadedAt = Date.now();
      logger.warn(
        `[GateCFDSymbolUtils] Loaded ${fileSpecs.length} CFD symbols from file cache as fallback`
      );
      return fileSpecs;
    }

    // 3. 都失败：返回空数组并告警（上层将因缺规格拒绝 CFD 信号）
    logger.error(
      '[GateCFDSymbolUtils] Both REST and file cache failed, returning empty symbol list'
    );
    return [];
  }

  /**
   * 获取单个品种规格。
   * @param symbol 品种代码（如 XAUUSD），不存在时返回 null。
   */
  async getSpec(symbol: string): Promise<CfdSymbolSpec | null> {
    if (!symbol) return null;
    const specs = await this.getSpecs();
    return specs.find((s) => s.symbol === symbol) ?? null;
  }

  /**
   * 组合 Mapper：品种规格 → 统一 MarketInfo（IExchange）。
   * 规格缺失（未收录/接口与兜底均失败）时返回 null。
   */
  async toMarketInfo(symbol: string): Promise<MarketInfo | null> {
    const spec = await this.getSpec(symbol);
    if (!spec) {
      logger.warn(`[GateCFDSymbolUtils] No symbol spec found for ${symbol}, cannot build MarketInfo`);
      return null;
    }
    return GateCFDMapper.toMarketInfo(spec);
  }

  // -------------------------------------------------------------------------
  // 私有：文件缓存读写（同步 fs，与 GateIOSymbolUtils.loadMarketsFromDict 一致）
  // -------------------------------------------------------------------------

  /** 读取文件缓存：兼容数组或 { "_comment", "symbols": [...] } 两种结构 */
  private loadFromFile(): CfdSymbolSpec[] {
    try {
      if (!fs.existsSync(this.cacheFilePath)) return [];
      const raw = JSON.parse(fs.readFileSync(this.cacheFilePath, 'utf-8'));
      // 兼容：既有字典可能为纯数组，运行时缓存为 { symbols: [...] } 对象
      const list = Array.isArray(raw) ? raw : Array.isArray(raw?.symbols) ? raw.symbols : [];
      return list
        .map((r: any) => GateCFDMapper.mapSymbolSpec(r))
        // 文件兜底字典用 tradfi 符号（XAUUSD），统一归一化为内部格式（XAU_USDT）
        .map((s: CfdSymbolSpec) => (s && s.symbol ? { ...s, symbol: fromTradFiSymbol(String(s.symbol)) } : s))
        .filter((s: CfdSymbolSpec) => s && s.symbol);
    } catch (err: any) {
      logger.warn('[GateCFDSymbolUtils] Failed to read symbol file cache', {
        error: err?.message || err,
      });
      return [];
    }
  }

  /** 写入文件缓存（对象结构含 _comment 说明，与 dict/ 兜底字典格式一致） */
  private saveToFile(specs: CfdSymbolSpec[]): void {
    try {
      const dir = path.dirname(this.cacheFilePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const payload = {
        _comment:
          'Gate-CFD 品种规格缓存（由 GateCFDSymbolUtils 自动覆写，仅兜底，实际以 GET /tradfi/symbols/detail 为准）',
        symbols: specs,
      };
      fs.writeFileSync(this.cacheFilePath, JSON.stringify(payload, null, 2));
      logger.info(`[GateCFDSymbolUtils] Saved ${specs.length} CFD symbols to ${this.cacheFilePath}`);
    } catch (err: any) {
      logger.warn('[GateCFDSymbolUtils] Failed to save symbol file cache', {
        error: err?.message || err,
      });
    }
  }
}
