import logger from '../utils/logger';
import { ExchangeInstance } from '../models';
import { GateCFDRestClient } from './exchanges/gate_cfd/GateCFDRestClient';

/**
 * CfdPriceSyncService —— 「跟 CFD 价格同步 (syncCfdPrice)」后端消费。
 *
 * 用途：当信号路由配置 riskSettings.syncCfdPrice=true 时，执行链路的价格
 * 判断基准应从 CFD 市场（gate_tradfi，如 XAUUSD）获取，而不是只依赖
 * Lighter 等流动性较差的交易所盘口价，从而保证「按 CFD 价格执行、无价差」。
 *
 * 实现：
 * - 从 DB 找活跃的 gate_tradfi / gate_cfd 交易所实例（如 gate-tradfi-test），
 *   直接构造 GateCFDRestClient（不依赖 exchangeRegistry，避免模块缓存不一致）；
 * - 调用 querySymbolTicker(symbol) 取 CFD 实时价（内部 XAU_USDT<->XAUUSD 转换）；
 * - 5s 短缓存，避免高频轮询打爆 API；
 * - 找不到 CFD 实例或取价失败时降级返回 null（调用方保持原有行为）。
 */
class CfdPriceSyncService {
  private readonly CACHE_TTL_MS = 5_000;
  private readonly cache = new Map<string, { price: number; at: number }>();

  /** 当前活跃的 CFD 交易所实例配置（进程内缓存，避免每次查 DB）。 */
  private cfdClient: GateCFDRestClient | null | undefined;

  public resetCache(): void {
    this.cache.clear();
    this.cfdClient = undefined;
  }

  /** 取 CFD 市场实时价；失败/未配置时返回 null（调用方降级）。 */
  public async getCfdLastPrice(symbol: string): Promise<number | null> {
    const cached = this.cache.get(symbol);
    if (cached && Date.now() - cached.at < this.CACHE_TTL_MS) {
      return cached.price;
    }

    const client = await this.resolveCfdClient();
    if (!client) {
      return null;
    }

    try {
      const ticker = await client.querySymbolTicker(symbol);
      const price = parseFloat((ticker as any)?.lastPrice);
      if (!Number.isFinite(price) || price <= 0) {
        logger.warn('[CfdPriceSync] CFD ticker returned invalid price', { symbol, ticker });
        return null;
      }
      this.cache.set(symbol, { price, at: Date.now() });
      logger.info(`[CfdPriceSync] CFD ${symbol} last=${price}`);
      return price;
    } catch (err: any) {
      logger.warn('[CfdPriceSync] failed to fetch CFD price', { symbol, error: err?.message });
      return null;
    }
  }

  /** 解析并构造 CFD REST 客户端；缓存结果，DB 为空时返回 null。 */
  private async resolveCfdClient(): Promise<GateCFDRestClient | null> {
    if (this.cfdClient !== undefined) {
      return this.cfdClient;
    }
    try {
      const instances = await ExchangeInstance.findAll({
        where: { status: 'active' },
      });
      const cfd = instances.find(
        (i: any) => i.type === 'gate_tradfi' || i.type === 'gate_cfd',
      );
      if (!cfd) {
        logger.warn('[CfdPriceSync] no active gate_tradfi/gate_cfd exchange instance found; sync disabled');
        this.cfdClient = null;
        return null;
      }
      const cfg = JSON.parse(cfd.config || '{}');
      this.cfdClient = new GateCFDRestClient({
        id: cfd.id,
        name: cfd.name,
        type: cfd.type,
        apiKey: cfg.apiKey,
        apiSecret: cfg.apiSecret,
        baseURL: cfg.baseURL || 'https://api.gateio.ws/api/v4',
        proxy: cfg.proxyUrl || cfg.proxy || undefined,
        isTestnet: !!cfg.isTestnet,
      } as any);
      logger.info(`[CfdPriceSync] using CFD instance: ${cfd.id}`);
    } catch (err: any) {
      logger.warn('[CfdPriceSync] failed to resolve CFD instance', { error: err?.message });
      this.cfdClient = null;
    }
    return this.cfdClient;
  }
}

export default new CfdPriceSyncService();
