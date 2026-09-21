export type StrategyAction = 'open' | 'close' | 'cancel' | 'update';

export interface ParsedStrategy {
  action: StrategyAction;
  symbol: string;
  
  // For 'open' / 'update'
  side?: 'buy' | 'sell';
  entryPrice?: string;
  targets?: string[];
  stopLoss?: string;
  leverage?: string;
  orderType?: 'market' | 'limit';
  
  // Risk Management
  weight?: number; // 0-1, default 1. Used to split risk across multiple entries
  averageEntryPrice?: number; // For size_based calculation in multi-entry strategies
  riskMultiplier?: number; // 0.1-2, default 1. Multiplier for position size calculation

  // For 'cancel'
  orderId?: string;

  // For 'close'
  closePercentage?: number; // 0-100
  quantity?: number; // Raw contract count from signal, used when riskMode is ratio_based
  isAddPosition?: boolean; // true = add to existing position, not a new independent position
  closePrice?: string; // Optional limit price for close
  closeAmount?: string; // Optional exact quantity for partial close

  // Multi-entry support
  entries?: Array<{ type: 'market' | 'limit'; price?: number }>;
  confidence?: number;

  // 多入场点组元数据（解析器把多入场点信号拆分成多条 ParsedStrategy 时填写，
  // 供路由级 entrySelection='nearest_sl' 判断"哪个入场点最靠近止损"使用）
  entryIndex?: number; // 0-based，本条策略在入场点组内的序号
  entryCount?: number; // 组内入场点总数
  groupEntries?: Array<{ type: 'market' | 'limit'; price?: number }>; // 组内全部入场点快照（market/CMP 入场点无价格）

  // 信号来源：'text' = 纯文本解析，'image' = 图片视觉识别，'text_inferred' = 截断信号均值反推补全
  // （用于事后排查，写入 strategy.signalOrigin）。
  sourceType?: 'text' | 'image' | 'text_inferred';

  raw: any;
}

export interface DiscordMessage {
  id: string;
  channel_id: string;
  content: string;
  ts: string;
  username: string;
  edited_timestamp?: string | null;
}

export interface StrategyRiskConfig {
  riskMode: 'percentage' | 'fixed' | 'ratio_based'; // 'percentage' of equity, 'fixed' USDT amount, or 'ratio_based' following signal quantity
  riskValue: number; // 2 for 2%, or 50 for 50 USDT (Unified 0-100 for %)
  
  defaultLeverage: string; // e.g. '10'
  priceTolerance: number; // e.g. 0.01 for 0.01R (Max deviation in R units for Market Order)
  maxPositionSize?: number; // Optional max size in USDT
  
  // Slippage/Padding Configuration (in R-multiples usually, or fixed ratio)
  // User requested "0.01R" default.
  entryPaddingR?: number; // Advance entry by N * R
  entryOrderMode?: 'maker' | 'taker'; // Limit entry mode. maker => postOnly, taker => normal limit
  tpPaddingR?: number;    // Advance TP by N * R
  slPaddingR?: number;    // Delay SL by N * R

  // ── 价格调整体系（两套互斥，由 paddingMode 切换，不会叠加）──
  // 'r'（默认）：R 百分比体系，使用上面的 entryPaddingR/tpPaddingR/slPaddingR；
  // 'fixed'：固定金额（美元）体系，使用下面三个字段，R 百分比滑点全部忽略。
  // 适用场景：止盈止损距离较紧密的策略，按 R 百分比无法精确控制时改用固定金额。
  paddingMode?: 'r' | 'fixed';
  // 让点提前入场（美元）。做多：入场价 − X（更低价位提前挂单成交）；做空：入场价 + X。
  // 所有入场点共享同一个值（路由级配置，逐入场点统一应用）。
  entryOffsetFixed?: number;
  // 固定止损距离（美元）。做多：SL = 入场价 − X；做空：SL = 入场价 + X。
  // 覆盖信号自带止损（提前止损），基准为让点后的实际入场价。
  fixedSlDistance?: number;
  // 止损后移（美元）。做多：SL − X；做空：SL + X（把止损往远离价格方向拖后）。
  // 在固定止损距离（若有）结果之上再叠加。
  slBackOffsetFixed?: number;

  // 多入场点选择：
  // 'all'（默认）：全部入场点按 weight 均分仓位（现状行为）；
  // 'nearest_sl'：仅在与止损价距离最近的入场点入场，该点全仓（weight=1），其余入场点跳过。
  // 市价/CMP 入场点无价格，不参与"最近"比较（会被跳过）；单入场点信号不受影响。
  entrySelection?: 'all' | 'nearest_sl';

  // Profit Taking Configuration
  fixedRiskRewardClose?: number | null; // Close position at fixed RR (e.g., 1.3 for 1.3R) if set. Null = explicitly disabled, undefined = use parser default.
  tpDistribution?: number[]; // Distribution of position to close at each target level (e.g., [0.8, 0.2]).
  // Parser-specific hard stop widening, measured in R from entry to original stop.
  hardStopRMultiplier?: number;
  
  // TP Order Configuration
  tpOrderType?: 'limit' | 'market'; // Default 'limit'
  tpOrderMode?: 'maker' | 'taker'; // TP limit mode. maker => postOnly, taker => normal limit
  tpPostOnly?: boolean; // Deprecated: use tpOrderMode
  
  // Position Sizing Mode (Controls how total position size is distributed across multiple entries)
  // 'risk_based': Distribute risk equally (Current default). Size = (TotalRisk * Weight) / (Entry - SL)
  // 'size_based': Distribute position size equally. Size = (TotalRisk / (AvgEntry - SL)) * Weight
  positionSizingMode?: 'risk_based' | 'size_based';

  // Entry Merge (Controls merging of close entry prices into one)
  // When two limit entries are within this threshold * R, they merge into one entry (closer to current price kept).
  // 0 or undefined = no merging. Default per-parser.
  entryMergeThresholdR?: number;

  // Conflict Handling
  autoCloseOppositePosition?: boolean; // If true, closes existing opposite position before opening new one (One-way mode simulation)

  // CFD 价格同步（跟 CFD 价格同步 syncCfdPrice）
  // 启用后：价格判断基准从交易所盘口价切换为 CFD 市场（gate_tradfi）实时价，
  // 保证「按 CFD 价格执行、无价差」。来自 route.riskSettings.syncCfdPrice（前端开关）。
  syncCfdPrice?: boolean;
}

export interface IStrategyParser {
  name: string;
  parse(message: any, isDryRun?: boolean): Promise<ParsedStrategy[] | null>;
  getRiskConfig(): StrategyRiskConfig;
}

/** Gauls 频道 AI 解析返回的结构化信号 */
export interface GaulsAISignal {
  action: 'open' | 'close' | 'update' | 'ignore';

  // open 信号
  side?: 'buy' | 'sell';
  symbol?: string;
  entries?: Array<{
    type: 'market' | 'limit';
    price?: number;
  }>;
  takeProfits?: number[];
  stopLoss?: number | 'breakeven';

  // close 信号
  closePercentage?: number;

  // update 信号
  newStopLoss?: number | 'breakeven';

  // 通用
  riskMultiplier?: 0.5 | 1;
  referencedSymbol?: string;
  confidence?: number;
  reasoning?: string;
}

/** Kacang Ketagih 频道 AI 解析返回的结构化信号 */
export interface KacangAISignal {
  action: 'open' | 'close' | 'update' | 'ignore';

  // open 信号
  side?: 'buy' | 'sell';
  entries?: Array<{
    type: 'market' | 'limit';
    price?: number;
  }>;
  takeProfits?: number[];
  stopLoss?: number | 'breakeven';

  // close 信号
  closePercentage?: number;

  // update 信号
  newStopLoss?: number | 'breakeven';

  // 通用
  riskMultiplier?: 0.5 | 1 | 2;
  confidence?: number;
  reasoning?: string;
}
