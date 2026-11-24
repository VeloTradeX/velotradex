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

  // Reply-chain target (filled by parsers that resolve Discord quotes).
  // Used by management actions to target the original signal's position and,
  // when the entry is still pending, to cancel the unfilled order instead.
  referencedSymbol?: string;
  replyStrategyId?: number;
  replyOrderId?: number;
  replyOrderStatus?: string;

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

  // ── 频道级风险管理机制（仅 Raizexbt 等显式设置的解析器会填写；────────────
  // ── 其他解析器不设置这些字段时，执行层行为与改动前完全一致。────────────

  /**
   * update 专用：按本策略的 `riskMultiplier` 把「目标仓位/挂单」缩放到目标 R 倍数。
   * 执行层行为：
   * - 已有持仓：市价部分平仓，使剩余仓位对应目标 R（比例按当前剩余仓位计算）；
   * - 只有未成交挂单：amend 挂单数量到目标 R；
   * - 两者都没有：安全跳过（返回 null）。
   */
  riskResize?: boolean;

  /**
   * update 专用（stopLoss='breakeven' 时生效）：
   * - 'protect'（默认）：保护性移到保本。若执行时价格已在浮亏侧，则恢复原止损，
   *   绝不市价全平；
   * - 'exit_at_entry'：交易员语义是「回到入场价就平仓」。若执行时已浮亏，
   *   改为在入场价挂 reduce-only 限价平仓单（回本平仓），保留原止损。
   */
  breakevenMode?: 'protect' | 'exit_at_entry';

  /**
   * update 专用：在入场价 ± planRMultiple × R 的价位，为现有持仓加挂
   * `planClosePercentage`（默认 50%）的 reduce-only 限价止盈单；
   * 成交后由 TP1 成交→移 BE 的既有链路自动移保本。
   */
  planRMultiple?: number;
  planClosePercentage?: number;

  /** open 专用：开启「近似重复开仓」拦截（同币同向、价差 ≤0.5R、30 分钟内、已有持仓/挂单 → 跳过）。 */
  nearDuplicateGuard?: boolean;

  /** open 专用：DCA/加仓语义，豁免近似重复拦截（仍走加仓逻辑）。 */
  allowAddPosition?: boolean;

  /**
   * close 专用：部分平仓时不要撤销该仓位的 SL/TP 保护单，
   * 避免剩余仓位裸奔（NoStopLossMonitor 会全平剩余仓位）。
   */
  keepPartialProtections?: boolean;

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

  // 迟到入场（市价追单）风险重锚：
  // true  = 市价追单时用实际执行价重算 R，仓位/TP padding 按新 R 计算（SL/TP 绝对价保持信号原值）；
  // false/undefined = 保持历史行为（仓位始终按信号入场价计算）。
  reanchorEntryOnChase?: boolean;
  // 追单重锚后要求的最低剩余盈亏比 |TP - entry| / |entry - SL|；null/undefined = 不校验。
  minEntryRR?: number | null;

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
