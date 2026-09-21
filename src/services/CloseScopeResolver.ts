// src/services/CloseScopeResolver.ts
import { Op } from 'sequelize';
import logger from '../utils/logger';
import { Order, Strategy } from '../models';
import { ParsedStrategy } from './parsers/types';
import { nowOrSim } from '../backtest/Clock';

export interface ScopeParams {
  parsed: ParsedStrategy;
  strategyId?: number;
  exchangeInstanceId?: string;
  targetPositionSide?: 'buy' | 'sell';
}

export interface CloseScope {
  scopedOrders: Order[];
  scopeOrderIds: number[];
  scopeStrategyIds: number[];
  expectedPositionSide: 'buy' | 'sell';
  scopeMode: string;
}

export class CloseScopeResolver {
  async resolve(params: ScopeParams): Promise<CloseScope> {
    const { parsed, strategyId, exchangeInstanceId, targetPositionSide } = params;

    const whereBase: any = {
      symbol: parsed.symbol,
      lifecycleStatus: ['OPEN', 'PROTECTED'],
      // 回测导入的订单不参与实盘平仓范围解析（子进程内订单未打标，行为不变）
      backtestRunId: { [Op.is]: null },
      ...(targetPositionSide ? { side: targetPositionSide } : {}),
      ...(exchangeInstanceId ? { exchangeInstanceId } : {}),
    };

    let allActive = await Order.findAll({ where: whereBase, order: [['createdAt', 'DESC']] });

    let scopedOrders: Order[] = [];
    let scopeMode = 'fallback-latest-order';

    if (parsed.orderId) {
      const orderIdNum = parseInt(parsed.orderId, 10);
      scopedOrders = allActive.filter(o =>
        o.exchangeOrderId === parsed.orderId ||
        (Number.isFinite(orderIdNum) && o.id === orderIdNum)
      );
      scopeMode = 'order-id';
    } else if (strategyId) {
      scopedOrders = allActive.filter(o => o.strategyId === strategyId);
      scopeMode = 'strategy-id';

      // When strategyId matches no active orders, widen scope to routeId/source/parser.
      // This handles the case where a close signal (e.g. TP1) has its own strategyId
      // different from the original open strategyId, and the open orders may already
      // be CLOSED (e.g. closed by WSEventRouter on position size=0).
      if (scopedOrders.length === 0) {
        logger.info(`[CloseScopeResolver] strategyId=${strategyId} matched no active orders for ${parsed.symbol}, widening scope`, { strategyId, symbol: parsed.symbol });
        scopedOrders = this.tryWiderScope(parsed, allActive, exchangeInstanceId);
        if (scopedOrders.length > 0) {
          scopeMode = 'strategy-id-widened';
        }
      }
    } else if (parsed.raw?.routeId) {
      scopedOrders = allActive.filter(o => o.routeId === parsed.raw?.routeId);
      scopeMode = 'route-id';
    } else if (parsed.raw?.source) {
      scopedOrders = allActive.filter(o => o.source === parsed.raw?.source);
      scopeMode = 'source';
    } else if (parsed.raw?.parserName || parsed.raw?.parser) {
      const parserStrategies = await Strategy.findAll({
        where: { parserName: parsed.raw?.parserName || parsed.raw?.parser },
        attributes: ['id'],
      });
      const parserIds = new Set(parserStrategies.map(s => s.id));
      scopedOrders = allActive.filter(o => parserIds.has(o.strategyId));
      scopeMode = 'parser';
    }

    // If still no match among active orders, look for recently CLOSED orders
    // that may have been closed by WSEventRouter/SL/TP before this close signal arrived.
    if (scopedOrders.length === 0) {
      scopedOrders = await this.tryClosedOrders(parsed, strategyId, exchangeInstanceId);
      if (scopedOrders.length > 0) {
        scopeMode = scopeMode === 'strategy-id-widened' ? 'strategy-id-widened-closed' : 'recently-closed';
      }
    }

    if (scopedOrders.length === 0 && allActive.length > 0) {
      scopedOrders = [allActive[0]];
    }

    const scopeStrategyIds = Array.from(
      new Set(scopedOrders.map(o => o.strategyId).filter((v): v is number => Number.isFinite(v)))
    );

    return {
      scopedOrders,
      scopeOrderIds: scopedOrders.map(o => o.id),
      scopeStrategyIds,
      expectedPositionSide: targetPositionSide || (scopedOrders[0]?.side as 'buy' | 'sell') || 'buy',
      scopeMode,
    };
  }

  /**
   * Try wider scope matching when strategyId fails:
   * 1. routeId from parsed.raw
   * 2. source from parsed.raw
   * 3. parser from parsed.raw (matching via Strategy table)
   * 4. If exchangeInstanceId is given, any order for that exchange
   */
  private tryWiderScope(parsed: ParsedStrategy, allActive: Order[], exchangeInstanceId?: string): Order[] {
    // Try routeId
    if (parsed.raw?.routeId) {
      const byRoute = allActive.filter(o => o.routeId === parsed.raw?.routeId);
      if (byRoute.length > 0) return byRoute;
    }

    // Try source
    if (parsed.raw?.source) {
      const bySource = allActive.filter(o => o.source === parsed.raw?.source);
      if (bySource.length > 0) return bySource;
    }

    // Try exchangeInstanceId only
    if (exchangeInstanceId) {
      const byExchange = allActive.filter(o => o.exchangeInstanceId === exchangeInstanceId);
      if (byExchange.length > 0) return byExchange;
    }

    return [];
  }

  /**
   * Look for recently CLOSED orders when no OPEN/PROTECTED orders are found.
   * This handles the case where WSEventRouter/SL/TP already closed the position
   * before the close signal (e.g. TP1) arrived. We find the original open order
   * so the close handler can decide what to do (skip vs. partial close).
   *
   * Search strategy:
   * 1. By strategyId (the close signal's own strategyId won't match, but the
   *    open strategyId may be in relatedMessages or the same source/channel)
   * 2. By source (same Discord channel = same trader)
   * 3. By routeId
   * 4. By parser
   * Only considers orders closed within the last 30 minutes.
   */
  private async tryClosedOrders(parsed: ParsedStrategy, strategyId?: number, exchangeInstanceId?: string): Promise<Order[]> {
    // 回测子进程按模拟时钟计算“30 分钟前”，实盘等价于 Date.now()
    const now = nowOrSim().getTime();
    const thirtyMinutesAgo = new Date(now - 30 * 60 * 1000);

    const whereBase: any = {
      symbol: parsed.symbol,
      lifecycleStatus: 'CLOSED',
      closedAt: { [Op.gte]: thirtyMinutesAgo },
      backtestRunId: { [Op.is]: null },
      ...(exchangeInstanceId ? { exchangeInstanceId } : {}),
    };

    const recentClosed = await Order.findAll({ where: whereBase, order: [['closedAt', 'DESC']], limit: 20 });
    if (recentClosed.length === 0) return [];

    // Try source (same Discord channel)
    if (parsed.raw?.source) {
      const bySource = recentClosed.filter(o => o.source === parsed.raw?.source);
      if (bySource.length > 0) return bySource;
    }

    // Try routeId
    if (parsed.raw?.routeId) {
      const byRoute = recentClosed.filter(o => o.routeId === parsed.raw?.routeId);
      if (byRoute.length > 0) return byRoute;
    }

    // Try parser via Strategy table
    if (parsed.raw?.parserName || parsed.raw?.parser) {
      const parserStrategies = await Strategy.findAll({
        where: { parserName: parsed.raw?.parserName || parsed.raw?.parser },
        attributes: ['id'],
      });
      const parserIds = new Set(parserStrategies.map(s => s.id));
      const byParser = recentClosed.filter(o => parserIds.has(o.strategyId));
      if (byParser.length > 0) return byParser;
    }

    // Try the strategyId itself (unlikely to match for close signals, but cheap check)
    if (strategyId) {
      const byStrategyId = recentClosed.filter(o => o.strategyId === strategyId);
      if (byStrategyId.length > 0) return byStrategyId;
    }

    return [];
  }
}
