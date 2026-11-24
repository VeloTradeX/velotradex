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

export interface NearDuplicateParams {
  exchangeInstanceId: string;
  routeId: number;
  symbol: string;
  side: string;
  entryPrice?: string;
  stopLoss?: string;
  windowMs?: number;       // default 30 * 60 * 1000
  priceDistanceR?: number; // default 0.5
}

export interface NearDuplicateResult {
  isNearDuplicate: boolean;
  existingOrderId?: number;
  existingStrategyId?: number;
  existingEntryPrice?: string;
}

const DEFAULT_NEAR_DUPLICATE_WINDOW_MS = 30 * 60 * 1000;
const DEFAULT_NEAR_DUPLICATE_PRICE_DISTANCE_R = 0.5;

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
   * 近似重复开仓检查（near-duplicate guard，第三层幂等）。
   *
   * 同一 exchangeInstance + route + symbol + side，在最近 windowMs 内已存在
   * 价格相距不超过 priceDistanceR × R 的挂单/持仓时，视为近似重复。
   * 用于覆盖「同一笔交易被拆成两条略有差异的信号重复开仓」的情况；
   * 精确重复仍由 check() 负责。
   */
  public async checkNearDuplicate(params: NearDuplicateParams): Promise<NearDuplicateResult> {
    const { exchangeInstanceId, routeId, symbol, side } = params;
    const windowMs = params.windowMs && params.windowMs > 0
      ? params.windowMs
      : DEFAULT_NEAR_DUPLICATE_WINDOW_MS;
    const priceDistanceR = typeof params.priceDistanceR === 'number' && Number.isFinite(params.priceDistanceR) && params.priceDistanceR > 0
      ? params.priceDistanceR
      : DEFAULT_NEAR_DUPLICATE_PRICE_DISTANCE_R;

    const entry = parseFloat(params.entryPrice || '');
    const stopLoss = parseFloat(params.stopLoss || '');
    if (!Number.isFinite(entry) || entry <= 0) {
      return { isNearDuplicate: false };
    }
    const risk = Math.abs(entry - stopLoss);
    const tolerance = Number.isFinite(risk) && risk > 0
      ? priceDistanceR * risk
      : Math.abs(entry) * 0.005;
    if (!Number.isFinite(tolerance) || tolerance <= 0) {
      return { isNearDuplicate: false };
    }

    const since = new Date(Date.now() - windowMs);
    const candidates = await Order.findAll({
      where: {
        exchangeInstanceId,
        routeId,
        symbol,
        side,
        createdAt: { [Op.gte]: since },
        lifecycleStatus: { [Op.in]: ['INIT', 'PENDING', 'OPEN', 'PROTECTED'] },
      } as any,
      order: [['createdAt', 'DESC']],
    });

    for (const candidate of candidates) {
      // Entry price first; market/CMP entries have no numeric price so fall back
      // to the fill price when available.
      let candidatePriceRaw = (candidate as any).price;
      let candidatePrice = parseFloat(candidatePriceRaw || '');
      if (!Number.isFinite(candidatePrice)) {
        candidatePriceRaw = (candidate as any).filledPrice;
        candidatePrice = parseFloat(candidatePriceRaw || '');
      }
      if (!Number.isFinite(candidatePrice) || candidatePrice <= 0) continue;
      if (Math.abs(candidatePrice - entry) > tolerance) continue;

      const existingOrderId = (candidate as any).id as number | undefined;
      const existingStrategyId = (candidate as any).strategyId ?? undefined;
      logger.info(
        `[StrategyDeduplication] Near-duplicate strategy detected: order=${existingOrderId}, ` +
        `route=${routeId}, symbol=${symbol}, entry=${entry}, existing=${candidatePrice}, ` +
        `tolerance=${tolerance} (R=${Number.isFinite(risk) ? risk : 'n/a'}, ${priceDistanceR}R)`
      );
      return {
        isNearDuplicate: true,
        existingOrderId,
        existingStrategyId,
        existingEntryPrice: String(candidatePriceRaw),
      };
    }

    return { isNearDuplicate: false };
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
