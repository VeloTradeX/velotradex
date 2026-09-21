/** 统一 CFD 虚拟撮合的订单/事件/持仓类型定义 */

/** 订单角色：entry=开仓，close=主动平仓（限价），sl/tp=保护触发（止损/止盈） */
export type CfdOrderRole = 'entry' | 'close' | 'sl' | 'tp';

export type CfdOrderStatus = 'open' | 'filled' | 'cancelled';

/** 供统一撮合引擎撮合的虚拟订单（内存态，不落库、不依赖现有模型） */
export interface CfdVirtualOrder {
  /** 全局唯一订单 ID（调用方保证唯一） */
  id: string;
  /** 内部符号（BASE_USDT，如 XAU_USDT） */
  symbol: string;
  /** 方向：buy/sell（sl/tp 时为平仓方向，如多单止损 side=sell） */
  side: 'buy' | 'sell';
  /** 类型：market 仅用于开仓立即成交；limit 用于限价成交；保护单恒为触发型 */
  type: 'market' | 'limit';
  /** 角色 */
  role: CfdOrderRole;
  /** 触发/限价价：entry/close 为限价；sl/tp 为止损/止盈触发价 */
  price?: string;
  /** 数量（正数） */
  amount: string;
  /** sl/tp 归属的入场单 ID */
  parentId?: string;
  /** 状态；注册时可省略，引擎统一置为 open */
  status?: CfdOrderStatus;
  createdAt: number;
}

/** 统一成交事件（撮合引擎的唯一对外输出） */
export interface CfdFillEvent {
  orderId: string;
  parentId?: string;
  symbol: string;
  side: 'buy' | 'sell';
  role: CfdOrderRole;
  /** 成交价 */
  fillPrice: string;
  /** 触发时的最新价 */
  lastPrice: string;
  /** 实际成交数量（减仓单可能小于 order.amount） */
  amount: string;
  /** 已实现盈亏（开仓为 0） */
  realizedPnl: number;
  /** 成交后该品种剩余仓位（带符号：>0 多，<0 空） */
  positionSize: string;
  filledAt: Date;
}

/** 撮合引擎内部维护的品种仓位状态 */
export interface CfdPositionState {
  /** 带符号仓位：>0 多，<0 空 */
  size: number;
  /** 平均开仓价 */
  entryPrice: number;
}
