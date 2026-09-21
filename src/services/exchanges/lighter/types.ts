export interface LighterMarketConfig {
  symbol: string;
  marketIndex: number;
  baseCurrency: string;
  quoteCurrency: string;
  priceDecimals: number;
  sizeDecimals: number;
  minBaseAmount: string;
  tickSize?: string;
  multiplier?: string;
  leverageMin?: string;
  leverageMax?: string;
}

export interface LighterExchangeConfig {
  exchangeInstanceId: string;
  privateKey: string;
  accountIndex: number;
  apiKeyIndex: number;
  baseURL?: string;
  wsURL?: string;
  markets: LighterMarketConfig[];
  marketOrderSlippage?: number;
  defaultSlippageBps?: number;
}

export interface LighterSignedTx {
  txId: string;
  txType: number;
  txInfoHash: string;
  nonce: string;
  signedTx: string;
  clientOrderIndex?: string;
}

export interface LighterTxIntent {
  action: string;
  symbol?: string;
  marketIndex?: number;
  side?: 'buy' | 'sell';
  price?: string;
  amount?: string;
  orderId?: string;
  clientOrderIndex?: string;
  nonce?: string;
  reduceOnly?: boolean;
  postOnly?: boolean;
  payload?: Record<string, unknown>;
}
