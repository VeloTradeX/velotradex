import type { ParsedStrategy, StrategyRiskConfig } from '../parsers/types';
import type { OrderResult } from '../exchanges/IExchange';
import type { ProtectionPipeline } from '../ProtectionPipeline';

/**
 * Narrow collaboration interface replacing the `any`-typed cross-dependencies
 * that NoStopLossMonitor / PostFillOrchestrator previously used to avoid a
 * circular dependency on the full TradeExecutor.
 */
export interface CloseExecutor {
  getProtectionPipeline(exchangeInstanceId?: string): ProtectionPipeline;
  handleClose(
    parsed: ParsedStrategy,
    source: string,
    riskConfig: StrategyRiskConfig | undefined,
    strategyId?: number,
    targetPositionSide?: 'buy' | 'sell',
    exchangeInstanceId?: string
  ): Promise<OrderResult | null>;
}