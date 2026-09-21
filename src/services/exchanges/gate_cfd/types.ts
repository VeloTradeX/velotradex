/**
 * Gate-CFD（/tradfi/*）共享类型契约 —— 各模块（RestClient / Mapper / SymbolUtils /
 * LegPlanner / Poller / PersistenceHandler / Exchange）的单一事实来源。
 * 架构设计见 内部设计文档。
 *
 * 与现有加密合约链路的关系：
 * - 统一模型（Ticker / MarketInfo / OrderResult / Position 等）复用
 *   src/services/exchanges/IExchange.ts；
 * - 本文件只定义 CFD 特有的结构（品种规格、多腿计划、CFD 持仓/订单行、轮询事件）。
 */

// ---------------------------------------------------------------------------
// 品种规格（GET /tradfi/symbols/detail 的 ContractDetailDataList）
// ---------------------------------------------------------------------------
export interface CfdSymbolSpec {
  symbol: string;
  symbolDesc?: string;
  categoryName?: string;
  /** 合约大小（每手对应的标的数量，如 XAUUSD = 100 oz/手） */
  contractVolume: string;
  /** 结算货币（接口返回，如 USD/HKD；账户保证金统一为 USDT/USDx） */
  settlementCurrency?: string;
  /** 最小下单量（手） */
  minOrderVolume: string;
  /** 最大下单量（手） */
  maxOrderVolume: string;
  /** 平台预设杠杆（API 不可调） */
  leverage?: string;
  /** 价格精度（小数位） */
  pricePrecision?: number;
  /** 交易时段描述 */
  tradeMode?: string;
  /** 交易时区 */
  tradeTimezone?: string;
  /** 隔夜费类型/费率（CFD 特有，非资金费率） */
  swapCostType?: string;
  buySwapCostRate?: string;
  sellSwapCostRate?: string;
  swapCost3day?: string;
  raw?: any;
}

// ---------------------------------------------------------------------------
// 全量品种列表行（GET /tradfi/symbols，公开接口，SDK SymbolsDataList，camelCase）
// 注意：该接口只给"有哪些品种/状态/类别/杠杆档位"，不给合约规格
// （contractVolume / min-max 手数），规格须再调 querySymbolDetail。
// ---------------------------------------------------------------------------
export interface CfdSymbolListRow {
  /** 品种代码（已归一化为内部 BASE_USDT 格式，如 XAU_USDT / NAS100） */
  symbol: string;
  /** 品种英文描述（如 Gold / Nasdaq 100） */
  symbolDesc?: string;
  /** 分类 ID（1=贵金属 2=股票 3=指数 4=外汇 5=大宗商品，见 queryCategories） */
  categoryId?: number;
  /** 交易状态：'open'（开市可交易）/ 'closed'（下架/休市） */
  status?: string;
  /** 交易时段代码（如 '4'） */
  tradeMode?: string;
  /** 本次交易时段开始时间（Unix 秒） */
  openTime?: number;
  /** 本次交易时段结束时间（Unix 秒） */
  closeTime?: number;
  /** 下次开市时间（Unix 秒，跨休市时 > 0） */
  nextOpenTime?: number;
  /** 结算货币（如 USD） */
  settlementCurrency?: string;
  /** 价格精度（小数位） */
  pricePrecision?: number;
  /** 平台可选杠杆档位（如 ['20','50','100','200','500']） */
  leverages?: string[];
  /** 是否基准品种 */
  isBase?: boolean;
  raw?: any;
}

// ---------------------------------------------------------------------------
// 品种分类（GET /tradfi/symbols/categories，公开接口）
// ---------------------------------------------------------------------------
export interface CfdSymbolCategory {
  /** 分类 ID（0=Favorites 1=Metals 2=Stocks 3=Indices 4=Forex 5=Commodities） */
  categoryId?: number;
  /** 分类名（如 Metals / Forex） */
  categoryName?: string;
}

// ---------------------------------------------------------------------------
// CFD 订单行（GET /tradfi/orders、/orders/history、/orders/log/{id}）
// ---------------------------------------------------------------------------
export interface CfdOrderRow {
  orderId: number | string;
  symbol: string;
  symbolDesc?: string;
  /** 'Market'（市价单）| 'Trigger'（限价/触发单） */
  priceType?: string;
  /** 订单状态码（SDK OrderListDataList.state，0=待成交等） */
  state?: number;
  stateDesc?: string;
  /** 是否已结束 */
  finished?: boolean | string;
  /** 1=买 2=卖（SDK Side 枚举） */
  side?: number | string;
  /** 手数 */
  volume?: string;
  price?: string;
  priceTp?: string;
  priceSl?: string;
  timeSetup?: number;
  raw?: any;
}

// ---------------------------------------------------------------------------
// CFD 持仓行（GET /tradfi/positions）
// ---------------------------------------------------------------------------
export interface CfdPositionRow {
  positionId: number | string;
  symbol: string;
  symbolDesc?: string;
  /** 手数 */
  volume?: string;
  /** 开仓均价 */
  priceOpen?: string;
  /** 方向（SDK positionDir，可能为 'buy'/'sell' 或数字，Mapper 归一化） */
  positionDir?: string;
  margin?: string;
  unrealizedPnl?: string;
  unrealizedPnlRate?: string;
  priceTp?: string;
  priceSl?: string;
  raw?: any;
}

// ---------------------------------------------------------------------------
// 多腿计划（CfdLegPlanner 产出）
// ---------------------------------------------------------------------------
export interface CfdLeg {
  /** 腿序号（0-based） */
  legIndex: number;
  /** 该腿止盈价 */
  tpPrice: string;
  /** 该腿手数（已含放大/封顶后的最终值） */
  volume: string;
  /** 止损价（全腿共用，下单时随单附带） */
  priceSl?: string;
}

export interface CfdLegPlan {
  legs: CfdLeg[];
  /** 总手数（Σ 腿手数） */
  totalVolume: string;
  /** 总风险 = Σ(腿手数 × contractVolume × |entry − SL|)，USD */
  totalRisk: number;
  /** 总名义 = Σ(腿手数 × contractVolume × entry)，USD */
  totalNotional: number;
  /** 风险上限（来自现有 route.riskSettings riskMode+riskValue 换算，无 SL 时为 0） */
  riskAmount: number;
  /** 名义红线（现有 maxPositionSize，0 表示不校验） */
  maxPositionSize: number;
  /** 信号原始 TP 档位数；减腿后 < 原档位 */
  downgradedFrom?: number;
  /** 是否发生过最小下单量放大 */
  amplificationApplied: boolean;
  /** 原信号分配比例（与 targets 对齐） */
  distribution?: number[];
  /** 原信号 TP 档位 */
  originalTargets?: string[];
  /** true = 放弃信号（风控拒绝，审计 CFD_RISK_LIMIT_REJECTED） */
  rejected: boolean;
  rejectReason?: string;
}

export interface CfdLegPlannerInput {
  /** 入场价（已含 padding） */
  entryPrice: number;
  /** 止损价；0/NaN = 无 SL（ratio_based） */
  stopLoss: number;
  /** TP 档位（升序，已去重、已含 padding） */
  targets: number[];
  /** 分配比例（与 targets 对齐，和须为 1；缺省等分） */
  distribution?: number[];
  /** 合约大小（每手标的数量） */
  contractVolume: number;
  /** 最小下单量（手） */
  minOrderVolume: number;
  /** 最大下单量（手） */
  maxOrderVolume: number;
  /** 基线总手数（由 PositionSizer 计算，含 weight/riskMultiplier 修正；ratio_based 时为信号手数） */
  baseVolume: number;
  /** 风险上限 USD（PositionSizer 返回；ratio_based 传 0 跳过风险校验） */
  riskAmount: number;
  /** 名义价值红线 USD（现有 maxPositionSize；0 = 不校验） */
  maxPositionSize: number;
  /** 价格精度（用于 TP 加权均价取整） */
  pricePrecision: number;
  /** 手数精度（用于放大/封顶取整，缺省 2） */
  volumePrecision?: number;
}

// ---------------------------------------------------------------------------
// 轮询事件（CfdPositionPoller → CfdPersistenceHandler / Exchange）
// ---------------------------------------------------------------------------
export type CfdPositionEventType =
  | 'position_opened'
  | 'position_closed'
  | 'position_reduced'
  | 'foreign_position';

export interface CfdPositionEvent {
  type: CfdPositionEventType;
  positionId: number | string;
  symbol: string;
  volume: string;
  priceOpen: string;
  priceTp?: string;
  priceSl?: string;
  /** position_closed 时：平仓价（用于区分 TP/SL/手工） */
  closedPrice?: string;
  closeReason?: 'tp' | 'sl' | 'manual' | 'liquidation' | 'unknown';
  raw?: any;
}

// ---------------------------------------------------------------------------
// RestClient 能力接口（Poller / Exchange 依赖注入用，避免与具体实现循环依赖）
// ---------------------------------------------------------------------------
export interface CfdRestClientLike {
  createOrder(body: any): Promise<{ id: string | number; logId?: string | number }>;
  updateOrder(orderId: number | string, body: any): Promise<any>;
  cancelOrder(orderId: number | string): Promise<any>;
  queryOrderList(): Promise<CfdOrderRow[]>;
  queryOrderHistoryList(params?: any): Promise<CfdOrderRow[]>;
  queryOrderLog(logId: number | string): Promise<CfdOrderRow | null>;
  queryPositionList(): Promise<CfdPositionRow[]>;
  queryPositionHistoryList(params?: any): Promise<CfdPositionRow[]>;
  updatePosition(positionId: number | string, body: { priceTp?: string; priceSl?: string }): Promise<any>;
  closePosition(positionId: number | string, body: any): Promise<any>;
  querySymbolDetail(symbols?: string[]): Promise<CfdSymbolSpec[]>;
  querySymbolTicker(symbol: string): Promise<any | null>;
  querySymbolKline?(symbol: string, interval?: string, limit?: number): Promise<any[] | null>;
  queryUserAssets(): Promise<any | null>;
  createTradFiUser(): Promise<any>;
  /** 全量品种列表（公开接口 GET /tradfi/symbols，无需鉴权，用于品种发现/字典刷新） */
  querySymbols(): Promise<CfdSymbolListRow[]>;
  /** 品种分类列表（公开接口 GET /tradfi/symbols/categories，无需鉴权） */
  queryCategories(): Promise<CfdSymbolCategory[]>;
}
