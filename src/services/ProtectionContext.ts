import { Order, PendingProtection } from '../models';
import { NoStopLossMonitor } from './NoStopLossMonitor';
import { ProtectionManager } from './ProtectionManager';
import { ProtectionPipeline } from './ProtectionPipeline';
import { PostFillOrchestrator } from './PostFillOrchestrator';
import type { CloseExecutor } from './executor/types';
import exchangeRegistry from './exchanges';

/**
 * Bundles the "protection layer" lifecycle: per-instance ProtectionManager /
 * ProtectionPipeline construction + caching, plus the PostFillOrchestrator
 * factory. TradeExecutor (and any facade) delegates protection-layer
 * construction here instead of holding the maps inline.
 */
export class ProtectionContext {
  private protectionManagers = new Map<string, ProtectionManager>();
  private protectionPipelines = new Map<string, ProtectionPipeline>();

  public getProtectionManager(exchangeInstanceId?: string): ProtectionManager {
      const key = exchangeInstanceId || 'default';
      if (!this.protectionManagers.has(key)) {
          const exchange = exchangeRegistry.getExchange(exchangeInstanceId);
          this.protectionManagers.set(key, new ProtectionManager(exchange));
      }
      return this.protectionManagers.get(key)!;
  }

  public getProtectionPipeline(exchangeInstanceId?: string): ProtectionPipeline {
      const key = exchangeInstanceId || 'default';
      if (!this.protectionPipelines.has(key)) {
          const exchange = exchangeRegistry.getExchange(exchangeInstanceId);
          this.protectionPipelines.set(key, new ProtectionPipeline(exchange, PendingProtection, Order));
      }
      return this.protectionPipelines.get(key)!;
  }

  public createPostFillOrchestrator(exchange: any, noStopLossMonitor: NoStopLossMonitor, tradeExecutor: CloseExecutor): PostFillOrchestrator {
      return new PostFillOrchestrator(exchange, noStopLossMonitor, this.getProtectionPipelineForExchange(exchange), tradeExecutor);
  }

  private getProtectionPipelineForExchange(exchange: any): ProtectionPipeline {
      return this.getProtectionPipeline(exchange?.id || 'default');
  }
}