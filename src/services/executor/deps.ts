import { NoStopLossMonitor } from '../NoStopLossMonitor';
import { ParsedStrategy } from '../parsers/types';
import { ProtectionContext } from '../ProtectionContext';
import type { CloseExecutor } from './types';
import exchangeRegistry from '../exchanges';
import auditService from '../AuditService';
import orderPersistenceHandler from '../OrderPersistenceHandler';
import tradingStatsService from '../TradingStatsService';

/**
 * Shared dependency bundle injected into the open/close/update executor
 * services. These are process-wide singletons held by TradeExecutor and
 * passed down so the services stay decoupled from the full TradeExecutor.
 */
export interface ExecutorServices {
  exchangeRegistry: typeof exchangeRegistry;
  auditService: typeof auditService;
  orderPersistenceHandler: typeof orderPersistenceHandler;
  tradingStatsService: typeof tradingStatsService;
  protectionContext: ProtectionContext;
}

export interface PersistSoftStopLossParams {
  strategyId?: number;
  orderId?: number;
  source: string;
  parserName?: string;
  exchangeInstanceId?: string;
  parsed: ParsedStrategy;
}

/**
 * Narrow capability surface that TradeExecutor implements. The executor
 * services use this instead of reaching into TradeExecutor directly, and no
 * `as any` is required anywhere.
 */
export interface ExecutorCapabilities extends CloseExecutor {
  noStopLossMonitor: NoStopLossMonitor;
  protectionQtyEpsilon: number;
  getFillWaitTimeout(exchange: any): number | undefined;
  runWithStrategyTrace<T>(strategyId: number | undefined, fn: () => Promise<T>): Promise<T>;
  persistSoftStopLossIfPresent(params: PersistSoftStopLossParams): Promise<void>;
}

export function summarizeParsedForDebug(parsed: ParsedStrategy) {
  return {
    action: parsed.action,
    symbol: parsed.symbol,
    side: parsed.side,
    entryPrice: parsed.entryPrice,
    targets: parsed.targets,
    stopLoss: parsed.stopLoss,
    leverage: parsed.leverage,
    orderType: parsed.orderType,
    orderId: parsed.orderId,
    closePercentage: parsed.closePercentage,
    closePrice: parsed.closePrice,
    closeAmount: parsed.closeAmount,
    weight: parsed.weight,
    averageEntryPrice: parsed.averageEntryPrice,
    riskMultiplier: parsed.riskMultiplier,
  };
}