/**
 * Gate-CFD（/tradfi/*）数据映射器 —— 纯静态映射类，无任何 I/O。
 *
 * 职责：把 gate-api SDK 反序列化后的 CFD 模型（ContractDetailDataList /
 * OrderListDataList / PositionListDataList / TradFiTickerData / UserAssetRespData）
 * 归一化为 gate_cfd 契约（CfdOrderRow / CfdPositionRow / CfdSymbolSpec）与
 * 统一模型（Ticker / MarketInfo / Position / AccountBalance）。
 *
 * 架构设计见 内部设计文档 §3.1。
 * 注意 gate-api SDK 的 camelCase 陷阱：SDK 反序列化后字段为 camelCase
 * （如 priceTp / priceSl / minOrderVolume），本类直接读取 camelCase 字段。
 */
import {
  Ticker,
  MarketInfo,
  Position,
  AccountBalance,
} from '../IExchange';
import {
  CfdOrderRow,
  CfdPositionRow,
  CfdSymbolSpec,
} from './types';

export class GateCFDMapper {
  // -------------------------------------------------------------------------
  // 订单行：GET /tradfi/orders、/orders/history、/orders/log/{id}
  // 对应 SDK 模型 OrderListDataList，响应外层为 { timestamp, data: { list? } }
  // 拆包在 RestClient 完成，本方法仅做字段归一化。
  // -------------------------------------------------------------------------
  static mapOrderRow(raw: any): CfdOrderRow {
    return {
      // 订单 ID：SDK OrderListDataList.orderId（number）
      orderId: raw?.orderId,
      // 品种代码：SDK symbol，如 XAUUSD
      symbol: raw?.symbol,
      // 品种中文名：SDK symbolDesc
      symbolDesc: raw?.symbolDesc,
      // 价格类型归一化：SDK PriceType 枚举 Market/Trigger（数字 0/1）→ 'Market'/'Trigger'
      priceType: GateCFDMapper.normalizePriceType(raw?.priceType),
      // 订单状态码：SDK OrderListDataList.state（数字，0=待成交等）
      state: raw?.state,
      // 状态描述归一化：优先取 SDK stateDesc，缺失时按 state 数字生成兜底描述
      stateDesc: GateCFDMapper.normalizeStateDesc(raw?.stateDesc, raw?.state),
      // 是否已结束：SDK Finished 枚举（NUMBER_0/NUMBER_1 或 0/1）→ boolean
      finished: GateCFDMapper.normalizeFinished(raw?.finished),
      // 方向归一化：SDK Side 枚举 NUMBER_1=买 / NUMBER_2=卖 → 'buy'/'sell'
      side: GateCFDMapper.normalizeSide(raw?.side),
      // 手数：SDK volume（手）
      volume: raw?.volume,
      // 委托价：SDK price（市价单为 0 或空）
      price: raw?.price,
      // 止盈价：SDK priceTp（MT5 语义，触发即整仓平掉该仓位）
      priceTp: raw?.priceTp,
      // 止损价：SDK priceSl
      priceSl: raw?.priceSl,
      // 下单时间戳（秒）：SDK timeSetup
      timeSetup: raw?.timeSetup,
      // 原始行保留，供 Poller/Persistence 对账与审计使用
      raw,
    };
  }

  // -------------------------------------------------------------------------
  // 持仓行：GET /tradfi/positions
  // 对应 SDK 模型 PositionListDataList。
  // -------------------------------------------------------------------------
  static mapPositionRow(raw: any): CfdPositionRow {
    return {
      // 持仓 ID：SDK PositionListDataList.positionId（同品种可并存多个独立仓位，对冲模式）
      positionId: raw?.positionId,
      // 品种代码：SDK symbol
      symbol: raw?.symbol,
      // 品种中文名：SDK symbolDesc
      symbolDesc: raw?.symbolDesc,
      // 手数：SDK volume
      volume: raw?.volume,
      // 开仓均价：SDK priceOpen
      priceOpen: raw?.priceOpen,
      // 方向归一化：SDK positionDir 可能为 'buy'/'sell' 或数字（1买/2卖）→ 'buy'/'sell'
      positionDir: GateCFDMapper.normalizePositionDir(raw?.positionDir),
      // 占用保证金：SDK margin
      margin: raw?.margin,
      // 未实现盈亏：SDK unrealizedPnl
      unrealizedPnl: raw?.unrealizedPnl,
      // 未实现盈亏率：SDK unrealizedPnlRate
      unrealizedPnlRate: raw?.unrealizedPnlRate,
      // 止盈价：SDK 持仓属性 priceTp（PositionListDataList 未声明，兼容透传）
      priceTp: raw?.priceTp,
      // 止损价：SDK 持仓属性 priceSl
      priceSl: raw?.priceSl,
      // 原始行保留
      raw,
    };
  }

  // -------------------------------------------------------------------------
  // 品种规格：GET /tradfi/symbols/detail
  // 对应 SDK 模型 ContractDetailDataList（字段名与 CfdSymbolSpec 一一对应）。
  // -------------------------------------------------------------------------
  static mapSymbolSpec(raw: any): CfdSymbolSpec {
    // 幂等：入参已是归一化后的 CfdSymbolSpec（如 RestClient 已 map 过或来自文件缓存
    // 二次读取）时直接返回，避免 raw 字段嵌套。
    if (
      raw &&
      typeof raw === 'object' &&
      typeof raw.symbol === 'string' &&
      raw.contractVolume != null &&
      raw.raw &&
      typeof raw.raw === 'object'
    ) {
      return raw as CfdSymbolSpec;
    }

    return {
      // 品种代码：SDK symbol，如 XAUUSD
      symbol: raw?.symbol,
      // 品种中文名：SDK symbolDesc
      symbolDesc: raw?.symbolDesc,
      // 分类（贵金属/外汇/指数等）：SDK categoryName
      categoryName: raw?.categoryName,
      // 合约大小（每手标的数量，XAUUSD=100 oz/手）：SDK contractVolume
      contractVolume: raw?.contractVolume,
      // 结算货币：SDK settlementCurrency（USDT）
      settlementCurrency: raw?.settlementCurrency,
      // 最小下单量（手）：SDK minOrderVolume
      minOrderVolume: raw?.minOrderVolume,
      // 最大下单量（手）：SDK maxOrderVolume
      maxOrderVolume: raw?.maxOrderVolume,
      // 平台预设杠杆（API 不可调）：SDK leverage
      leverage: raw?.leverage,
      // 价格精度（小数位）：SDK pricePrecision
      pricePrecision: raw?.pricePrecision,
      // 交易时段描述：SDK tradeMode
      tradeMode: raw?.tradeMode,
      // 交易时区：SDK tradeTimezone
      tradeTimezone: raw?.tradeTimezone,
      // 隔夜费类型：SDK swapCostType（CFD 特有，非资金费率）
      swapCostType: raw?.swapCostType,
      // 买入隔夜费率：SDK buySwapCostRate
      buySwapCostRate: raw?.buySwapCostRate,
      // 卖出隔夜费率：SDK sellSwapCostRate
      sellSwapCostRate: raw?.sellSwapCostRate,
      // 周三隔夜费 3 倍标记：SDK swapCost3day
      swapCost3day: raw?.swapCost3day,
      // 原始对象保留，供后续新增字段透传
      raw,
    };
  }

  // -------------------------------------------------------------------------
  // 行情：GET /tradfi/symbols/{symbol}/tickers
  // 对应 SDK 模型 TradFiTickerData。Ticker 统一模型含 fundingRate，
  // 但 CFD 无资金费率（隔夜费以持仓 swap 字段体现），固定填 '0'。
  // -------------------------------------------------------------------------
  static mapTicker(tradFiTicker: any, symbol?: string): Ticker {
    // 注意：TradFiTickerData 本身不含 symbol 字段（调用方 GateCFDExchange.getTicker
    // 会传入 symbol），此处优先取入参，其次 raw.symbol 兜底。
    const sym = symbol || tradFiTicker?.symbol || '';
    return {
      symbol: sym,
      // 最新成交价：SDK lastPrice
      lastPrice: tradFiTicker?.lastPrice ?? '0',
      // 标记价：CFD 无独立标记价，用最新价兜底（计算用价均为点差内 lastPrice）
      markPrice: tradFiTicker?.lastPrice ?? '0',
      // 指数价：CFD 无独立指数价字段，用最新价兜底
      indexPrice: tradFiTicker?.lastPrice ?? '0',
      // 资金费率：CFD 无资金费率（XAUUSD 等贵金属/外汇 CFD 按隔夜费 swap 计息，
      // 由持仓明细的 buySwapCostRate/sellSwapCostRate 体现），固定 '0'。
      fundingRate: '0',
      // 24h 成交量：TradFiTickerData 无该字段，填 '0'（CFD 盘口不展示成交量）
      volume24h: '0',
      // 24h 涨跌幅：SDK priceChange（百分比数值）
      change24h: tradFiTicker?.priceChange ?? '0',
    };
  }

  // -------------------------------------------------------------------------
  // 品种规格 → 统一市场信息 MarketInfo（IExchange）
  // 字段换算说明：
  // - baseCurrency = symbol（CFD 品种代码即标的，如 XAUUSD）
  // - quoteCurrency 固定 'USDT'（结算货币，与 spec.settlementCurrency 一致）
  // - minSize = minOrderVolume（最小下单量，手）
  // - multiplier = contractVolume（合约大小，每手标的数量）
  // - tickSize 由 pricePrecision 换算：精度 2 → 最小报价步长 0.01
  // - leverageMin/leverageMax 均取 leverage（平台固定杠杆，API 不可调）
  // -------------------------------------------------------------------------
  static toMarketInfo(spec: CfdSymbolSpec): MarketInfo {
    const pricePrecision =
      Number.isFinite(Number(spec?.pricePrecision)) ? Number(spec.pricePrecision) : 2;
    return {
      symbol: spec?.symbol ?? '',
      // CFD 品种代码即基础标的（如 XAUUSD），无独立币种拆分
      baseCurrency: spec?.symbol ?? '',
      // CFD 统一以 USDT 结算（与 spec.settlementCurrency 一致）
      quoteCurrency: 'USDT',
      // 最小下单量：GET /tradfi/symbols/detail 的 minOrderVolume（手）
      minSize: spec?.minOrderVolume ?? '0',
      // 价格精度：GET /tradfi/symbols/detail 的 pricePrecision（小数位）
      pricePrecision,
      // 手数精度：CFD 手数步长固定 2 位小数（0.01 手起，V3 验证项兜底值）
      amountPrecision: 2,
      // 合约乘数：contractVolume（每手标的数量，如 XAUUSD=100 oz/手）
      multiplier: spec?.contractVolume ?? '1',
      // 最小报价步长：由 pricePrecision 换算（精度 2 → 0.01）
      tickSize: GateCFDMapper.tickSizeFromPrecision(pricePrecision),
      // 杠杆下限：平台固定档位，取 spec.leverage
      leverageMin: spec?.leverage ?? '1',
      // 杠杆上限：同上，取 spec.leverage
      leverageMax: spec?.leverage ?? '100',
      // 最大下单量：GET /tradfi/symbols/detail 的 maxOrderVolume（手，硬限）
      maxSize: spec?.maxOrderVolume ?? '0',
      // 交易时段：openTime/closeTime 由 ticker 提供，此处仅占位
      tradeSession: undefined,
    };
  }

  // -------------------------------------------------------------------------
  // CFD 持仓行 → 统一持仓模型 Position（IExchange）
  // - size 带符号：positionDir 'buy' → +volume（多），'sell' → −volume（空）
  // - marginType 固定 'cross'（CFD 强平线按保证金率 50% 全仓计算，无逐仓概念）
  // - price_sl / price_tp / position_id 从行内透传（MT5 语义，TP/SL 为仓位属性）
  // -------------------------------------------------------------------------
  static toPosition(row: CfdPositionRow): Position {
    const dir = String(row?.positionDir || '').toLowerCase();
    const volume = Number.isFinite(Number(row?.volume)) ? Number(row.volume) : 0;
    // size 带符号：多头为正、空头为负（对齐 IExchange.Position 契约）
    const size = dir === 'sell' ? -volume : volume;
    return {
      symbol: row?.symbol ?? '',
      // 带符号持仓量（手）：positionDir 'buy' → +volume / 'sell' → −volume
      size: String(size),
      // 开仓均价：GET /tradfi/positions 的 priceOpen
      entryPrice: row?.priceOpen ?? '0',
      // 标记价：CFD 持仓无独立 markPrice 字段，用开仓均价兜底
      markPrice: row?.priceOpen ?? '0',
      // 未实现盈亏：GET /tradfi/positions 的 unrealizedPnl
      unrealizedPnl: row?.unrealizedPnl ?? '0',
      // 杠杆：CFD 平台固定杠杆（API 不可调），此处填 '0' 表示不适用/全仓
      leverage: '0',
      // 保证金模式：CFD 固定全仓（强平线 50%），无逐仓概念
      marginType: 'cross',
      // 止损价透传：持仓属性 priceSl（触发即整仓平掉该仓位）
      price_sl: row?.priceSl,
      // 止盈价透传：持仓属性 priceTp
      price_tp: row?.priceTp,
      // 交易所持仓 ID 透传：positionId（closePosition/updatePosition 的锚点）
      position_id: row?.positionId != null ? String(row.positionId) : undefined,
    };
  }

  // -------------------------------------------------------------------------
  // 账户资产 → 统一账户余额 AccountBalance（IExchange）
  // 对应 SDK 模型 UserAssetRespData（GET /tradfi/users/assets）。
  // - available = marginFree（可用保证金，即可用下单资金）
  // - total = equity（账户净值 = 余额 + 未实现盈亏）
  // - currency 固定 'USDT'（CFD 子账户统一以 USDT 结算）
  // -------------------------------------------------------------------------
  static toAccountBalance(userAsset: any): AccountBalance {
    return {
      currency: 'USDT',
      // 可用余额：SDK marginFree
      available: userAsset?.marginFree ?? '0',
      // 账户净值：SDK equity
      total: userAsset?.equity ?? '0',
      // 未实现盈亏：SDK unrealizedPnl（可空）
      unrealizedPnl: userAsset?.unrealizedPnl,
    };
  }

  // -------------------------------------------------------------------------
  // 内部归一化辅助（全部纯函数，无状态）
  // -------------------------------------------------------------------------

  /** 归一化订单方向：SDK Side 枚举 NUMBER_1=买 / NUMBER_2=卖（或 1/2 数字）→ 'buy'/'sell' */
  private static normalizeSide(raw: any): 'buy' | 'sell' | undefined {
    if (raw === 1 || raw === '1' || raw === 'buy' || raw === 'BUY') return 'buy';
    if (raw === 2 || raw === '2' || raw === 'sell' || raw === 'SELL') return 'sell';
    return undefined;
  }

  /** 归一化价格类型：SDK PriceType 枚举（Market/Trigger 或 0/1）→ 'Market'/'Trigger' */
  private static normalizePriceType(raw: any): 'Market' | 'Trigger' | undefined {
    if (raw === 0 || raw === '0' || raw === 'Market' || raw === 'market') return 'Market';
    if (raw === 1 || raw === '1' || raw === 'Trigger' || raw === 'trigger') return 'Trigger';
    return undefined;
  }

  /** 归一化订单结束标记：SDK Finished 枚举（NUMBER_0/NUMBER_1 或 0/1）→ boolean */
  private static normalizeFinished(raw: any): boolean | undefined {
    if (typeof raw === 'boolean') return raw;
    if (raw === 0 || raw === '0' || raw === 'NUMBER_0') return false;
    if (raw === 1 || raw === '1' || raw === 'NUMBER_1') return true;
    return undefined;
  }

  /** 归一化状态描述：优先 SDK stateDesc，缺失时按 state 数字生成兜底描述 */
  private static normalizeStateDesc(rawDesc: any, rawState: any): string {
    if (typeof rawDesc === 'string' && rawDesc.length > 0) return rawDesc;
    if (rawState !== undefined && rawState !== null) return `state_${rawState}`;
    return '';
  }

  /** 归一化持仓方向：SDK positionDir（'buy'/'sell' 或数字 1买/2卖）→ 'buy'/'sell' */
  private static normalizePositionDir(raw: any): 'buy' | 'sell' | undefined {
    if (raw === 'buy' || raw === 'BUY' || raw === 1 || raw === '1') return 'buy';
    if (raw === 'sell' || raw === 'SELL' || raw === 2 || raw === '2') return 'sell';
    return undefined;
  }

  /** 由价格精度换算最小报价步长：精度 2 → '0.01' */
  private static tickSizeFromPrecision(precision: number): string {
    const p = Math.max(0, Math.floor(precision));
    return (1 / Math.pow(10, p)).toFixed(p);
  }
}
