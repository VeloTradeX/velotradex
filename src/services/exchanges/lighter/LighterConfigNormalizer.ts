import { ExchangeConfig } from '../IExchange';
import logger from '../../../utils/logger';
import { LighterExchangeConfig, LighterMarketConfig } from './types';

export type NormalizedLighterExchangeConfig = LighterExchangeConfig & {
  signerPath: string;
  proxy?: string;
  balanceCurrency: string;
  marketOrderSlippage: number;
  defaultSlippageBps: number;
};

export function normalizeConfig(config: ExchangeConfig): NormalizedLighterExchangeConfig {
  const raw = config as ExchangeConfig & {
    signerPath?: unknown;
    markets?: unknown;
    balanceCurrency?: unknown;
    proxy?: unknown;
    marketOrderSlippage?: unknown;
    defaultSlippageBps?: unknown;
  };

  const accountIndex = config.accountIndex;
  const apiKeyIndex = config.apiKeyIndex;

  if (typeof accountIndex !== 'number' || !Number.isInteger(accountIndex)) {
    throw new Error('Lighter accountIndex is required');
  }
  if (accountIndex < 0) {
    throw new Error('Lighter accountIndex must be non-negative');
  }
  if (typeof apiKeyIndex !== 'number' || !Number.isInteger(apiKeyIndex)) {
    throw new Error('Lighter apiKeyIndex is required');
  }
  if (typeof raw.signerPath !== 'string' || raw.signerPath.length === 0) {
    throw new Error('Lighter signerPath is required');
  }
  if (typeof config.privateKey !== 'string' || config.privateKey.length === 0) {
    throw new Error('Lighter privateKey is required');
  }

  // Always load markets from dict file
  let markets: LighterMarketConfig[];
  try {
    const fs = require('fs');
    const path = require('path');
    const dictPath = path.join(process.cwd(), 'dict/lighter_markets.json');
    markets = JSON.parse(fs.readFileSync(dictPath, 'utf-8'));
    logger.info(`[Lighter] Loaded ${markets.length} markets from dict/lighter_markets.json`);
  } catch (error) {
    throw new Error(`Failed to load Lighter markets from dict: ${error instanceof Error ? error.message : String(error)}`);
  }

  return {
    exchangeInstanceId: config.id,
    privateKey: config.privateKey,
    accountIndex,
    apiKeyIndex,
    baseURL: config.baseURL,
    wsURL: config.wsURL,
    signerPath: raw.signerPath,
    proxy: typeof raw.proxy === 'string' ? raw.proxy : config.proxy,
    balanceCurrency: typeof raw.balanceCurrency === 'string' ? raw.balanceCurrency : 'USDT',
    markets,
    marketOrderSlippage: typeof raw.marketOrderSlippage === 'number' ? raw.marketOrderSlippage : 0.005,
    defaultSlippageBps: typeof raw.defaultSlippageBps === 'number' ? raw.defaultSlippageBps : 200,
  };
}
