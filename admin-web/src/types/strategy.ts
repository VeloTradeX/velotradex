export interface StrategyDetail {
  id: number;
  rawMessage: string;
  action: string;
  symbol: string;
  side: string;
  source: string;
  parserName: string;
  entryPrice: number | null;
  targets: string; // JSON string from API, e.g. '["1.5","2.0","2.5"]'
  stopLoss: number | null;
  status: string;
  routes: any;
  aiAnalysis: string | null;
  riskMultiplier: number | null;
  createdAt: string;
  orderCount?: number;
}

export interface RelatedOrder {
  id: number;
  exchangeOrderId: string | null;
  exchangeInstanceId: string | null;
  symbol: string;
  side: string;
  amount: number;
  price: number | null;
  filledAmount: number | null;
  filledPrice: number | null;
  status: string;
  lifecycleStatus: string;
  type: string;
  leverage: number | null;
  realizedPnl: number | null;
  closePrice: number | null;
  lastPrice: number | null;
  createdAt: string;
}

export interface AuditLogEntry {
  id: number;
  action: string;
  strategyId: number | null;
  orderId: number | null;
  routeId: number | null;
  exchangeInstanceId: string | null;
  lifecycleStatus: string | null;
  details: any;
  createdAt: string;
}

export interface StrategyDetailResponse {
  strategy: StrategyDetail;
  orders: RelatedOrder[];
  auditLogs: AuditLogEntry[];
}
