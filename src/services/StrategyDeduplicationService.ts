import { Order } from '../models';
import auditService from './AuditService';
import logger from '../utils/logger';
import { Op } from 'sequelize';

export interface StrategyDedupParams {
  parserName: string;
  symbol: string;
  side: string;
  entryPrice: string;
  targets: string;      // JSON string, already sorted by parser
  stopLoss: string;
  source: string;       // channel_id
  exchangeInstanceId: string;
  routeId: number;
  orderType?: string;   // 'market' | 'limit' — same symbol/SL/TP but different order type should not be deduped
}

export interface StrategyDedupResult {
  isDuplicate: boolean;
  duplicateOrderId?: number;
  duplicateStrategyId?: number;
}

export class StrategyDeduplicationService {
  /**
   * 检查策略是否重复（第二层幂等）
   *
   * 通过在 Order 表中查找完全相同的 active 订单来判断。
   * 完全相同 = exchangeInstanceId + routeId + symbol + side +
   *            price(entryPrice) + initialTp(targets) + initialSl(stopLoss)
   * 仅查找 lifecycleStatus 为 OPEN 或 PROTECTED 的订单
   */
  public async check(params: StrategyDedupParams): Promise<StrategyDedupResult> {
    const activeStatuses = ['OPEN', 'PROTECTED'];

    const where: any = {
      exchangeInstanceId: params.exchangeInstanceId,
      routeId: params.routeId,
      symbol: params.symbol,
      side: params.side,
      price: params.entryPrice ? params.entryPrice : { [Op.or]: [null, ''] as any },
      initialTp: params.targets ? params.targets : { [Op.or]: [null, ''] as any },
      initialSl: params.stopLoss ? params.stopLoss : { [Op.or]: [null, ''] as any },
      lifecycleStatus: activeStatuses,
    };

    if (params.orderType) {
      where.type = params.orderType;
    }

    const duplicate = await Order.findOne({ where });

    if (duplicate) {
      logger.info(
        `[StrategyDeduplication] Duplicate strategy detected: order=${duplicate.id}, ` +
        `route=${params.routeId}, symbol=${params.symbol}`
      );
      return {
        isDuplicate: true,
        duplicateOrderId: duplicate.id,
        duplicateStrategyId: duplicate.strategyId ?? undefined,
      };
    }

    return { isDuplicate: false };
  }

  /**
   * 记录策略幂等命中的审计日志
   */
  public async logDuplicate(
    strategyId: number,
    params: StrategyDedupParams,
    duplicateOrderId: number
  ): Promise<void> {
    const dedupKey = [
      `routeId=${params.routeId}`,
      `exchangeInstanceId=${params.exchangeInstanceId}`,
      `symbol=${params.symbol}`,
      `side=${params.side}`,
      `orderType=${params.orderType || 'null'}`,
      `price=${params.entryPrice || 'null'}`,
      `initialTp=${params.targets || 'null'}`,
      `initialSl=${params.stopLoss || 'null'}`,
    ].join(' | ');

    await auditService.log(strategyId, 'STRATEGY_DEDUPLICATED', {
      symbol: params.symbol,
      side: params.side,
      entryPrice: params.entryPrice,
      duplicateOrderId,
      exchangeInstanceId: params.exchangeInstanceId,
      routeId: params.routeId,
    });
  }
}

export default new StrategyDeduplicationService();
