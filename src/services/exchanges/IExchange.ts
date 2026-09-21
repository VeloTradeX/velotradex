export interface OrderParams {
  symbol: string;
  side: 'buy' | 'sell';
  amount: string;
  price?: string;
  type?: 'limit' | 'market';
  text?: string; // Custom source ID or text
  stopLoss?: string; // Trigger price for Stop Loss
  takeProfit?: string; // Trigger price for Take Profit
  tpOrders?: { price: string; amount: string }[]; // Full TP orders with distribution-based amounts
  reduceOnly?: boolean;
  postOnly?: boolean; // Post only (Maker only)
  triggerPrice?: string; // For conditional/trigger orders
  triggerCondition?: 'ge' | 'le'; // >= or <=
  timeInForce?: 'GTC' | 'IOC' | 'FOK'; // Time in force
  tpslTpTriggerPrice?: string; // Exchange-side attached TP trigger (Gate.io tpsl_tp_trigger_price, server-managed from placement)
  tpslSlTriggerPrice?: string; // Exchange-side attached SL trigger (Gate.io tpsl_sl_trigger_price, server-managed from placement)
}

export interface OrderResult {
  id: string;
  status: string;
  amount?: string;
  price?: string;
  slPlaced?: boolean;
  tpPlaced?: boolean;
  [key: string]: any;
}

export interface AccountBalance {
  currency: string;
  available: string;
  total: string;
  unrealizedPnl?: string;
}

export interface Position {
  symbol: string;
  size: string; // Positive for long, negative for short
  entryPrice: string;
  markPrice: string;
  unrealizedPnl: string;
  leverage: string;
  marginType: 'cross' | 'isolated';
  price_sl?: string;
  price_tp?: string;
  position_id?: string;
}

export interface OpenOrder {
  id: string;
  symbol: string;
  side: 'buy' | 'sell';
  price: string;
  amount: string;
  status: string;
}

export interface MarketInfo {
  symbol: string;
  baseCurrency: string; // e.g., BTC
  quoteCurrency: string; // e.g., USDT
  minSize: string;
  pricePrecision: number;
  amountPrecision: number;
  multiplier: string; // Contract multiplier
  tickSize?: string; // Minimum price increment
  leverageMin?: string;
  leverageMax?: string;
  /** CFD：最大下单量（手，maxOrderVolume）—— 向后兼容可选字段 */
  maxSize?: string;
  /** CFD：交易时段（openTime/closeTime，epoch ms）—— 向后兼容可选字段 */
  tradeSession?: { openTime?: number; closeTime?: number };
}

export interface Ticker {
  symbol: string;
  lastPrice: string;
  markPrice: string;
  indexPrice: string;
  fundingRate: string;
  volume24h: string;
  change24h: string;
}

export interface Candle {
  timestamp: number;
  open: string;
  high: string;
  low: string;
  close: string;
  volume?: string;
}

export interface Trade {
  id: string;
  orderId: string;
  symbol: string;
  side: 'buy' | 'sell';
  price: string;
  amount: string;
  role: 'maker' | 'taker';
  time: number;
  text?: string;
  /** 成交手续费（绝对值，计价币为 feeCurrency）；未提供则为 undefined */
  fee?: string;
  feeCurrency?: string;
}

export interface ExchangeConfig {
    id: string;
    type: string;
    name: string;
    apiKey: string;
    apiSecret: string;
    baseURL: string;
    wsURL?: string;
    proxy?: string;
    isTestnet?: boolean;
    // For Lighter or others
    privateKey?: string;
    accountIndex?: number;
    apiKeyIndex?: number;
}

export interface IExchange {
  id: string; // instance id
  name: string;
  start?(): Promise<void>;
  stop?(): Promise<void>;
  placeOrder(params: OrderParams): Promise<OrderResult>;
  amendOrder(orderId: string, symbol: string, price?: string, amount?: string): Promise<OrderResult>;
  cancelOrder(orderId: string, symbol: string): Promise<boolean>;
  cancelPriceOrder(orderId: string, symbol: string): Promise<boolean>;
  updateStopLoss(symbol: string, side: 'buy' | 'sell', price: string, text?: string, amount?: string): Promise<string | null>;
  closePosition(symbol: string, side: 'buy' | 'sell', price?: string, amount?: string, text?: string): Promise<boolean>;
  
  // Queries
  getBalance(currency?: string): Promise<AccountBalance>;
  getPosition(symbol: string): Promise<Position | null>;
  getPositions(): Promise<Position[]>;
  getOrder(orderId: string, symbol: string): Promise<OrderResult>;
  getOpenOrders(symbol?: string): Promise<OrderResult[]>;
  getFinishedOrders(symbol: string, limit?: number): Promise<OrderResult[]>;
  getPriceOrders(symbol?: string): Promise<OrderResult[]>; // Trigger/Stop orders
  
  // Real-time
  waitForOrderFill(orderId: string, symbol: string, timeoutMs?: number): Promise<OrderResult>;

  getTradeHistory(symbol: string, limit?: number): Promise<Trade[]>;
  
  // Market Data
  getMarkets(): Promise<MarketInfo[]>;
  getTicker(symbol: string): Promise<Ticker>;
  getCandles(symbol: string, timeframe: string, limit?: number): Promise<Candle[]>;
  
  // Actions
  setLeverage(symbol: string, leverage: string): Promise<boolean>;
  setMarginMode(symbol: string, marginMode: 'cross' | 'isolated', leverage?: string): Promise<boolean>;
  getMarginMode(symbol: string): Promise<{ marginMode: 'cross' | 'isolated', leverage: string }>;
  
  // Stats
  getWebSocketStats?(): any;

  // Optional persistence pipeline injection (optional, implemented by some adapters)
  setProtectionPipeline?(pipeline: unknown): void;

  // Optional event emitter surface (e.g. Lighter reconnect reconciliation)
  on?(event: string, listener: (...args: any[]) => void): unknown;

  // Transient set of symbols currently being opened, so WSEventRouter doesn't
  // misinterpret transient size=0 events as a position close.
  pendingOpenSymbols?: Set<string>;
}
