/**
 * Gate-CFD（/tradfi/*）REST 客户端
 *
 * 基于 gate-api SDK 的 TradFiApi，封装全部 /tradfi 业务接口：
 * 下单/改单/撤单、订单查询、持仓查询/改保/平仓、品种规格/行情、用户资产、子账户创建。
 *
 * 复用 exchanges/gate/GateClientFactory（axios + HttpsProxyAgent + setApiKeySecret +
 * normalizeError/extractBody/withRetry），不重复实现横切逻辑。
 * 类型契约见 ./types.ts（CfdRestClientLike）。
 *
 * 注意（gate-api SDK 的 camelCase 陷阱）：
 *   TradFiOrderRequest / TradFiOrderUpdateRequest / TradFiPositionUpdateRequest /
 *   TradFiClosePositionRequest 等请求模型字段均为 camelCase（priceTp / priceSl /
 *   priceType / closeVolume），SDK 序列化时按 attributeTypeMap 的 name 读取，
 *   故调用方必须传 camelCase 字段，禁止用 snake_case。
 *
 * 响应拆包约定：
 *   gate-api SDK 统一返回 { response, body }；CFD 各接口 body 普遍为
 *   { timestamp, data } 包装，其中 data 可能为 { list: [...] }（列表）或直接为
 *   业务对象（如 CreateOrder2Data / OrderLogData / UserAssetRespData）。本类通过
 *   unwrapData / unwrapList 统一剥离这两层外壳，返回纯业务数据。
 */
import * as GateApi from 'gate-api';
import { ExchangeConfig } from '../IExchange';
import { createGateApiClient, extractBody, withRetry } from '../gate/GateClientFactory';
import {
  CfdOrderRow,
  CfdPositionRow,
  CfdRestClientLike,
  CfdSymbolCategory,
  CfdSymbolListRow,
  CfdSymbolSpec,
} from './types';
// 符号转换：系统内部用 BASE_USDT，Gate /tradfi 接口用 BASEUSD，请求/响应在边界统一转换。
import { toTradFiSymbol, fromTradFiSymbol } from './cfdSymbol';
import logger from '../../../utils/logger';
import config from '../../../config';

export class GateCFDRestClient implements CfdRestClientLike {
  private tradFiApi: InstanceType<typeof GateApi.TradFiApi>;
  private readonly apiClient: InstanceType<typeof GateApi.ApiClient>;
  private readonly basePath: string;

  /**
   * 历史持仓（含 TP/SL）补齐缓存：活动持仓列表（queryPositionList）实测【不返回】
   * price_tp/price_sl（仅 9 字段），读活动仓保护必须借历史接口（queryPositionHistoryList，
   * 唯一携带 TP/SL 且同时含活动仓）。4s 高频轮询下加 5s TTL，避免每轮都打历史接口。
   */
  private posProtectionCache: { at: number; map: Map<string, { priceTp?: string; priceSl?: string }> } | null = null;
  private static readonly POS_PROTECTION_TTL_MS = 5_000;

  constructor(exchangeConfig: ExchangeConfig) {
    // 代理优先级：实例 proxy > 实例 proxyUrl（UI 兼容两种命名） > 全局 apiProxy
    const proxyUrl = exchangeConfig.proxy || (exchangeConfig as any).proxyUrl || config.trading.apiProxy;
    const { apiClient, basePath } = createGateApiClient({
      baseURL: exchangeConfig.baseURL || undefined,
      apiKey: exchangeConfig.apiKey,
      apiSecret: exchangeConfig.apiSecret,
      proxy: proxyUrl,
      isTestnet: exchangeConfig.isTestnet,
    });
    this.apiClient = apiClient;
    this.basePath = basePath;
    this.tradFiApi = new GateApi.TradFiApi(apiClient);
    logger.debug(`[GateCFDRestClient] initialized basePath=${basePath} proxy=${proxyUrl ? 'enabled' : 'none'}`);
  }

  /** 剥离 CFD 响应的 { timestamp, data } 外壳，返回 data 业务本体；无 data 字段时原样返回 */
  private unwrapData(payload: any): any {
    if (payload && typeof payload === 'object' && 'data' in payload) {
      return payload.data;
    }
    return payload;
  }

  /** 列表类接口统一拆包：data.list 或 data 直接为数组，缺省返回 [] */
  private unwrapList(payload: any): any[] {
    const data = this.unwrapData(payload);
    if (Array.isArray(data)) {
      return data;
    }
    if (data && Array.isArray(data.list)) {
      return data.list;
    }
    return [];
  }

  /**
   * 列表响应符号归一化：行内 symbol 由 tradfi（XAUUSD）转为系统内部（XAU_USDT），
   * 使持仓/订单/规格在系统内始终以 BASE_USDT 表达（与信号、虚拟撮合、比对逻辑一致）。
   */
  private toInternalRows<T>(rows: any[]): T[] {
    return (rows || []).map((r) => this.toInternalRow(r));
  }

  /** 单行符号归一化：转换顶层 symbol 与嵌套 raw.symbol（保持审计原始信息同步）。 */
  private toInternalRow(row: any): any {
    if (!row || typeof row !== 'object') return row;
    const copy = { ...row } as any;
    if (copy.symbol !== undefined) copy.symbol = fromTradFiSymbol(copy.symbol);
    if (copy.raw && typeof copy.raw === 'object') {
      copy.raw = { ...copy.raw };
      if (copy.raw.symbol !== undefined) copy.raw.symbol = fromTradFiSymbol(copy.raw.symbol);
    }
    return copy;
  }

  /**
   * 下单
   * SDK: createTradFiOrder(TradFiOrderRequest) → POST /tradfi/orders
   * 请求体字段用 camelCase（priceTp/priceSl/priceType，见文件头注释）。
   * 响应 body 为 { timestamp, data: { id, log_id, transfer_amount } }：
   *   - id：请求序号（非真实订单号，不能用于撤单/查 log）；
   *   - log_id：订单日志号，传给 queryOrderLog(log_id) 可取真实 orderId（= positionId，实盘实测）；
   *   - 注意：市价单【不要】在 body 里带 priceTp/priceSl，否则引擎会静默拒单（state=0，
   *     orderId=0），TP/SL 须在建仓后由 updatePosition 设置（见 GateCFDExchange.placeOrder）。
   */
  async createOrder(body: any): Promise<{ id: string | number; logId?: string | number }> {
    return withRetry(
      async () => {
        // 请求符号：系统内部 BASE_USDT → tradfi BASEUSD（如 XAU_USDT → XAUUSD）
        const wireBody =
          body && typeof body === 'object' && body.symbol
            ? {
                ...body,
                symbol: toTradFiSymbol(body.symbol),
                // priceType 归一化：内部约定用 'Market'/'Trigger'（设计稿 §1.2 口径），
                // 但 Gate /tradfi API 枚举值是小写 'market'/'trigger'（SDK 原样透传不做转换），
                // 大写会被服务器以 INVALID_ARGUMENT「Invalid parameter」拒绝
                // （2026-08-20 gate-tradfi-test USDJPY 实盘实测）。
                priceType:
                  body.priceType === 'Market'
                    ? 'market'
                    : body.priceType === 'Trigger'
                      ? 'trigger'
                      : body.priceType,
              }
            : body;
        const sdkResp: any = await this.tradFiApi.createTradFiOrder(wireBody);
        // ⚠️ SDK 反序列化陷阱：gate-api 的 CreateOrder2Data 模型只有 id 字段，
        // 反序列化时把响应里的 log_id 丢弃了；真实 log_id 仅存在于原始 axios 响应
        // r.response.data.data.log_id（2026-08-20 gate-tradfi-test USDJPY 实盘实测）。
        // log_id 用于 queryOrderLog 取真实 orderId（= positionId），必须从此处取。
        const rawResp = sdkResp?.response?.data ?? sdkResp?.body;
        const rawInner = rawResp?.data ?? rawResp;
        const bizData = this.unwrapData(extractBody(sdkResp));
        return {
          id: bizData?.id ?? bizData?.orderId ?? '',
          // log_id 来自原始响应，而非 SDK 反序列化后的 body
          logId: rawInner?.log_id ?? rawInner?.logId,
        };
      },
      'POST', '/api/v4/tradfi/orders', body,
    );
  }

  /**
   * 改单（改价格 / 改挂单自带保护价）
   * SDK: updateOrder(orderId, TradFiOrderUpdateRequest) → PUT /tradfi/orders/{order_id}
   * 请求体字段用 camelCase（priceTp/priceSl，见文件头注释）。
   */
  async updateOrder(orderId: number | string, body: any): Promise<any> {
    return withRetry(
      async () => this.unwrapData(extractBody(await this.tradFiApi.updateOrder(orderId as any, body))),
      'PUT', `/api/v4/tradfi/orders/${orderId}`, body,
    );
  }

  /**
   * 撤单（撤在途挂单）
   * SDK: deleteOrder(orderId) → DELETE /tradfi/orders/{order_id}
   */
  async cancelOrder(orderId: number | string): Promise<any> {
    return withRetry(
      async () => this.unwrapData(extractBody(await this.tradFiApi.deleteOrder(orderId as any))),
      'DELETE', `/api/v4/tradfi/orders/${orderId}`,
    );
  }

  /**
   * 活动订单列表
   * SDK: queryOrderList() → GET /tradfi/orders
   * 响应 body 为 { timestamp, data: { list: [...] } }，返回 data.list 订单行数组。
   */
  async queryOrderList(): Promise<CfdOrderRow[]> {
    return withRetry(
      async () => this.toInternalRows<CfdOrderRow>(this.unwrapList(extractBody(await this.tradFiApi.queryOrderList()))),
      'GET', '/api/v4/tradfi/orders',
    );
  }

  /**
   * 历史订单列表
   * SDK: queryOrderHistoryList(opts?) → GET /tradfi/orders/history
   * opts 可选字段：{ beginTime?, endTime?, symbol?, side? }。
   * 返回 data.list 订单行数组。
   */
  async queryOrderHistoryList(params?: any): Promise<CfdOrderRow[]> {
    return withRetry(
      async () => {
        // 兼容上层 { days } 语义（CfdPersistenceHandler 启动对账传 days）：
        // SDK queryOrderHistoryList 仅支持 beginTime/endTime（Unix 秒），此处转换为 beginTime。
        let wireParams = params;
        if (params && typeof params === 'object' && params.days != null && params.beginTime == null) {
          const days = Number(params.days);
          if (Number.isFinite(days)) {
            wireParams = { ...params, beginTime: Math.floor(Date.now() / 1000) - Math.ceil(days * 86400) };
            delete (wireParams as any).days;
          }
        }
        // 请求符号：过滤参数 symbol 由内部格式转 tradfi 格式
        if (wireParams && typeof wireParams === 'object' && wireParams.symbol) {
          wireParams = { ...wireParams, symbol: toTradFiSymbol(wireParams.symbol) };
        }
        const rows = this.toInternalRows<CfdOrderRow>(
          this.unwrapList(extractBody(await this.tradFiApi.queryOrderHistoryList(wireParams))),
        );
        return rows;
      },
      'GET', '/api/v4/tradfi/orders/history', params,
    );
  }

  /**
   * 订单日志（下单后按 logId 轮询成交状态，替代 WS 回调）
   * SDK: queryOrderLog(logId) → GET /tradfi/orders/log/{log_id}
   * 响应 data 为单条订单日志；兼容 data.list 包装；无记录返回 null。
   */
  async queryOrderLog(logId: number | string): Promise<CfdOrderRow | null> {
    return withRetry(
      async () => {
        const data = this.unwrapData(extractBody(await this.tradFiApi.queryOrderLog(logId as any)));
        if (Array.isArray(data)) {
          return this.toInternalRow(data[0]) as CfdOrderRow;
        }
        if (data && Array.isArray(data.list)) {
          return this.toInternalRow(data.list[0]) as CfdOrderRow;
        }
        return this.toInternalRow(data) as CfdOrderRow;
      },
      'GET', `/api/v4/tradfi/orders/log/${logId}`,
    );
  }

  /**
   * 历史持仓列表（含 TP/SL，同时含活动仓）—— 唯一能读取持仓 TP/SL 的接口。
   * SDK: queryPositionHistoryList(opts?) → GET /tradfi/positions/history
   * opts 可选：{ page?, pageSize?, beginTime?, endTime?, symbol?, positionDir? }。
   * 注意：SDK 不支持 positionId 精确查询，调用方需传 symbol/时间窗后本地按 positionId 过滤。
   *
   * 返回 data.list 持仓历史行（含 priceTp/priceSl/positionStatus/closePrice 等）。
   * symbol 已归一化为内部 BASE_USDT 格式。
   */
  async queryPositionHistoryList(params?: any): Promise<CfdPositionRow[]> {
    return withRetry(
      async () => {
        let wireParams = params;
        // 请求符号：过滤参数 symbol 由内部格式转 tradfi 格式
        if (wireParams && typeof wireParams === 'object' && wireParams.symbol) {
          wireParams = { ...wireParams, symbol: toTradFiSymbol(wireParams.symbol) };
        }
        const rows = this.toInternalRows<CfdPositionRow>(
          this.unwrapList(extractBody(await this.tradFiApi.queryPositionHistoryList(wireParams))),
        );
        return rows;
      },
      'GET', '/api/v4/tradfi/positions/history', params,
    );
  }

  /**
   * 活动持仓列表（poller 轮询 source，TP/SL 触发平仓、强平、手工干预均由此检测）
   * SDK: queryPositionList() → GET /tradfi/positions
   * 返回 data.list 持仓行数组。
   *
   * 【关键】活动持仓接口（PositionListDataList）实测【不返回】 price_tp/price_sl
   * （仅 9 字段），因此系统无法通过活动接口读取持仓保护。补齐方案：借历史接口
   * （queryPositionHistoryList，含活动仓且带完整 TP/SL）构建 positionId→保护 映射，
   * 回填到活动持仓行，使 CfdPersistenceHandler.isProtected / GateCFDMapper.toPosition
   * 能读到真实保护状态（否则 updatePosition 失败会被静默漏检）。
   * 高频轮询下用 5s TTL 缓存历史结果，降低接口压力。
   */
  async queryPositionList(): Promise<CfdPositionRow[]> {
    return withRetry(
      async () => {
        const activeRows = this.toInternalRows<CfdPositionRow>(
          this.unwrapList(extractBody(await this.tradFiApi.queryPositionList())),
        );
        // 仅当活动持仓里任一需要保护判定的行缺少 TP/SL 时，才尝试从历史补齐
        const needEnrich = activeRows.length > 0 && activeRows.some((r) => r.priceTp === undefined && r.priceSl === undefined);
        if (!needEnrich) return activeRows;

        const protection = await this.getActivePositionProtection();
        if (protection.size === 0) return activeRows;

        return activeRows.map((r) => {
          const p = protection.get(String(r.positionId));
          if (!p) return r;
          return { ...r, priceTp: r.priceTp ?? p.priceTp, priceSl: r.priceSl ?? p.priceSl };
        });
      },
      'GET', '/api/v4/tradfi/positions',
    );
  }

  /**
   * 取活动仓位的 TP/SL 映射（positionId → { priceTp, priceSl }）。
   * 来源：历史接口（queryPositionHistoryList）中 positionStatus 仍为活动态的行。
   * 用 5s TTL 缓存，避免与活动持仓轮询同频时每轮打历史接口。
   * 失败返回空 Map（退化：保护判定走 isProtected 的「退化信任」分支，与修复前一致）。
   */
  private async getActivePositionProtection(): Promise<Map<string, { priceTp?: string; priceSl?: string }>> {
    const now = Date.now();
    if (this.posProtectionCache && now - this.posProtectionCache.at < GateCFDRestClient.POS_PROTECTION_TTL_MS) {
      return this.posProtectionCache.map;
    }
    const map = new Map<string, { priceTp?: string; priceSl?: string }>();
    try {
      // 近 1 天历史足够覆盖当前活动仓；不传 symbol（全账户，活动仓必然在内）
      const history = await this.queryPositionHistoryList({ beginTime: Math.floor(now / 1000) - 86400 });
      for (const h of history) {
        const status = this.normalizePositionStatus(h);
        if (status && status !== 'open' && status !== 'active' && status !== '1' && status !== 1) continue;
        const pid = String(h.positionId);
        map.set(pid, {
          priceTp: h.priceTp ?? undefined,
          priceSl: h.priceSl ?? undefined,
        });
      }
    } catch (err) {
      // 历史接口异常不致命：返回空（上层退化保护判定），仅打日志
      logger.warn('[GateCFDRestClient] getActivePositionProtection failed, falling back', { err: String(err) });
      return this.posProtectionCache?.map ?? map;
    }
    this.posProtectionCache = { at: now, map };
    return map;
  }

  /** 归一化持仓历史状态：兼容 'open'/'active'/数字 1（活动）与其他（已平仓） */
  private normalizePositionStatus(row: any): any {
    const raw = row?.positionStatus ?? row?.raw?.position_status ?? row?.raw?.positionStatus;
    return raw;
  }

  /**
   * 修改持仓保护（移动保本：改 priceSl / 改 priceTp）
   * SDK: updatePosition(positionId, TradFiPositionUpdateRequest) → PUT /tradfi/positions/{position_id}
   * 请求体字段用 camelCase（priceTp/priceSl，见文件头注释）。
   */
  async updatePosition(positionId: number | string, body: { priceTp?: string; priceSl?: string }): Promise<any> {
    return withRetry(
      async () => this.unwrapData(extractBody(await this.tradFiApi.updatePosition(positionId as any, body))),
      'PUT', `/api/v4/tradfi/positions/${positionId}`, body,
    );
  }

  /**
   * 平仓（整仓 closeType=2 / 部分平仓 closeType=1 + closeVolume）
   * SDK: closePosition(positionId, TradFiClosePositionRequest) → POST /tradfi/positions/{position_id}/close
   * 【2026-08-20 实盘实测纠正】closeType 数值语义：2 = 全部平仓（无需 closeVolume），
   * 1 = 按手数部分平仓（必须带 closeVolume）；空 body {} 会报 INVALID_ARGUMENT。
   * 注意 GateCFDExchange 中常量 CLOSE_FULL=2 / CLOSE_PARTIAL=1 与之一致。
   * 请求体字段用 camelCase（closeVolume，见文件头注释）。
   */
  async closePosition(positionId: number | string, body: any): Promise<any> {
    return withRetry(
      async () => this.unwrapData(extractBody(await this.tradFiApi.closePosition(positionId as any, body))),
      'POST', `/api/v4/tradfi/positions/${positionId}/close`, body,
    );
  }

  /**
   * 品种规格（需 apiv4 签名，凭据来自实例 config / env）。
   * - symbols 为内部格式（XAU_USDT），内部转为 tradfi 格式（XAUUSD）请求。
   * - 【实测约束】该接口必须传 symbols 且单次最多 10 个：空参数报
   *   INVALID_ARGUMENT「Invalid parameter」，11+ 个同样报错（≤10 正常返回）。
   *   因此"全量品种"请先用 querySymbols()（公开接口）拿列表，再分批（≤10/批）查询。
   * 返回 data.list 品种规格数组（行内符号已归一化为内部 BASE_USDT 格式）。
   */
  async querySymbolDetail(symbols?: string[]): Promise<CfdSymbolSpec[]> {
    return withRetry(
      async () => {
        const wireSymbols = Array.isArray(symbols) ? symbols.map((s) => toTradFiSymbol(s)) : [];
        const payload = extractBody(await this.tradFiApi.querySymbolDetail(wireSymbols as any));
        return this.toInternalRows<CfdSymbolSpec>(this.unwrapList(payload));
      },
      'GET', '/api/v4/tradfi/symbols/detail',
    );
  }

  /**
   * 全量品种列表（公开接口 GET /tradfi/symbols，无需鉴权）。
   * 返回 data.list 品种列表行（symbolDesc/categoryId/status/openTime/closeTime/
   * settlementCurrency/pricePrecision/leverages 等，SDK SymbolsDataList camelCase）。
   * 注意：该接口只给"有哪些品种"，不给合约规格；规格须再调 querySymbolDetail（≤10/批）。
   */
  async querySymbols(): Promise<CfdSymbolListRow[]> {
    return withRetry(
      async () => {
        const payload = extractBody(await this.tradFiApi.querySymbols());
        return this.toInternalRows<CfdSymbolListRow>(this.unwrapList(payload));
      },
      'GET', '/api/v4/tradfi/symbols',
    );
  }

  /**
   * 品种分类列表（公开接口 GET /tradfi/symbols/categories，无需鉴权）。
   * 返回 [{ categoryId, categoryName }]，如 1=Metals 2=Stocks 3=Indices 4=Forex 5=Commodities。
   */
  async queryCategories(): Promise<CfdSymbolCategory[]> {
    return withRetry(
      async () => {
        const payload = extractBody(await this.tradFiApi.queryCategories());
        return this.unwrapList(payload).map((r: any) => ({
          categoryId: r?.categoryId,
          categoryName: r?.categoryName,
        }));
      },
      'GET', '/api/v4/tradfi/symbols/categories',
    );
  }

  /**
   * 单个品种行情（最新价 / 涨跌幅 / 交易时段状态等）
   * SDK: querySymbolTicker(symbol) → GET /tradfi/symbols/{symbol}/tickers
   * 返回 data（TradFiTickerData）；无数据时返回 null。
   */
  async querySymbolTicker(symbol: string): Promise<any | null> {
    return withRetry(
      async () => {
        const data = this.unwrapData(extractBody(await this.tradFiApi.querySymbolTicker(toTradFiSymbol(symbol))));
        return data ?? null;
      },
      'GET', `/api/v4/tradfi/symbols/${toTradFiSymbol(symbol)}/tickers`,
    );
  }

  /**
   * 用户资产（equity/marginFree → available，供 getBalance）
   * SDK: queryUserAssets() → GET /tradfi/users/assets
   * 返回 data（UserAssetRespData）；无数据时返回 null。
   */
  async queryUserAssets(): Promise<any | null> {
    return withRetry(
      async () => this.unwrapData(extractBody(await this.tradFiApi.queryUserAssets())) ?? null,
      'GET', '/api/v4/tradfi/users/assets',
    );
  }

  /**
   * K 线（供 getCandles）
   * SDK: querySymbolKline(symbol, interval, limit) → GET /tradfi/symbols/{symbol}/klines
   */
  async querySymbolKline(symbol: string, interval?: string, limit?: number): Promise<any[] | null> {
    return withRetry(
      async () => {
        // SDK interval 为受限枚举（"1m"|"15m"|"1h"|"4h"|"1d"|"7d"|"30d"），入参为通用 string 时按枚举透传
        const data = this.unwrapList(extractBody(await this.tradFiApi.querySymbolKline(toTradFiSymbol(symbol), interval as any, limit != null ? { limit } : undefined)));
        return data ?? null;
      },
      'GET', `/api/v4/tradfi/symbols/${toTradFiSymbol(symbol)}/klines`,
    );
  }

  /**
   * 创建 CFD 子账户（MT5 懒初始化，POST /tradfi/users）
   * SDK: createTradFiUser() → POST /tradfi/users
   * 返回 data（CreateUserRespData：status/mt5Uid 等）。
   */
  async createTradFiUser(): Promise<any> {
    return withRetry(
      async () => this.unwrapData(extractBody(await this.tradFiApi.createTradFiUser())),
      'POST', '/api/v4/tradfi/users',
    );
  }
}
