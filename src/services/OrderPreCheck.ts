// src/services/OrderPreCheck.ts
import { Order, VirtualTrade } from '../models';
import { Op } from 'sequelize';
import { ParsedStrategy } from './parsers/types';

interface Position {
  symbol: string;
  size: string;
  [key: string]: any;
}

interface OpenOrder {
  id: string;
  price?: string;
  side?: string;
  text?: string;
  amount?: string;
  [key: string]: any;
}

export interface PreCheckResult {
  shouldSkip: boolean;
  skipReason?: string;
  duplicateOrderId?: string;
  conflictPosition?: Position;
}

export class OrderPreCheck {
  constructor(
    private exchange: { getPositions: (symbol: string) => Promise<Position[]>; getOpenOrders: (symbol: string) => Promise<OpenOrder[]> },
    private markets: { symbol: string; [key: string]: any }[]
  ) {}

  async checkConflict(symbol: string, side: 'buy' | 'sell'): Promise<Position | null> {
    const positions = await this.exchange.getPositions(symbol);
    const oppositeSide = side === 'buy' ? 'sell' : 'buy';
    return positions.find(p => {
      if (p.symbol !== symbol) return false;
      const size = parseFloat(p.size);
      if (!Number.isFinite(size) || size === 0) return false;
      return oppositeSide === 'buy' ? size > 0 : size < 0;
    }) || null;
  }

  async checkDuplicate(
    symbol: string,
    side: 'buy' | 'sell',
    entryPrice: number,
    stopLoss: number,
    openOrders: OpenOrder[],
    activeDbOrders: Order[],
    orderType?: 'market' | 'limit'
  ): Promise<{ isDuplicate: boolean; existingOrderId?: string }> {
    // Check openOrders
    for (const o of openOrders) {
      if (o.side !== side) continue;
      const p1 = parseFloat(o.price || '0');
      const p2 = entryPrice;
      if (Math.abs(p1 - p2) > (p2 * 0.001)) {
        // openOrder exists on this symbol+side but price differs → not a duplicate
        return { isDuplicate: false };
      }
      const dbOrd = activeDbOrders.find(db => db.exchangeOrderId === o.id);
      if (dbOrd) {
        // Strategy A+ fix: different order types (market vs limit) should not be treated as duplicates
        if (orderType && dbOrd.type && dbOrd.type !== orderType) {
          return { isDuplicate: false };
        }
        const dbSl = parseFloat(dbOrd.initialSl || '0');
        if (Math.abs(dbSl - stopLoss) < (stopLoss * 0.001)) {
          return { isDuplicate: true, existingOrderId: o.id };
        }
        return { isDuplicate: false };
      }
    }
    // No openOrder on this symbol+side — check active DB orders directly
    for (const dbOrder of activeDbOrders) {
      // Strategy A+ fix: skip INIT/PENDING — orders still being processed should not block sibling strategies
      if (dbOrder.lifecycleStatus === 'INIT' || dbOrder.lifecycleStatus === 'PENDING') {
        continue;
      }
      // Strategy A+ fix: different order types should not be duplicates
      if (orderType && dbOrder.type && dbOrder.type !== orderType) {
        continue;
      }
      const dbPrice = parseFloat(dbOrder.price || dbOrder.filledPrice || '0');
      const isPriceMatch = Math.abs(dbPrice - entryPrice) < (entryPrice * 0.001);
      const dbSl = parseFloat(dbOrder.initialSl || '0');
      const isSlMatch = Math.abs(dbSl - stopLoss) < (stopLoss * 0.001);
      if (isPriceMatch && isSlMatch) {
        return { isDuplicate: true, existingOrderId: String(dbOrder.id) };
      }
    }
    return { isDuplicate: false };
  }

  async cleanupStaleOrders(
    activeDbOrders: Order[],
    openOrders: OpenOrder[],
    allPositions: Position[]
  ): Promise<void> {
    const openOrderIds = new Set(openOrders.map(o => o.id));
    for (const dbOrder of activeDbOrders) {
      const dbStatus = dbOrder.lifecycleStatus;
      const inOpenOrders = openOrderIds.has(dbOrder.exchangeOrderId);
      if (['OPEN', 'PROTECTED'].includes(dbStatus)) {
        const hasPosition = allPositions.some(p => {
          const size = parseFloat(p.size);
          return p.symbol === dbOrder.symbol && (dbOrder.side === 'buy' ? size > 0 : size < 0);
        });
        if (!hasPosition) {
          dbOrder.lifecycleStatus = 'CLOSED';
          dbOrder.status = 'closed';
          dbOrder.closedAt = dbOrder.closedAt || new Date();
          if (!dbOrder.realizedPnl && dbOrder.exchangeInstanceId?.startsWith('v-')) {
            await this.backfillPnl(dbOrder);
          }
          await dbOrder.save();
        }
      } else if (['INIT', 'PENDING'].includes(dbStatus)) {
        if (!inOpenOrders) {
          const hasPosition = allPositions.some(p => {
            const size = parseFloat(p.size);
            return p.symbol === dbOrder.symbol && (dbOrder.side === 'buy' ? size > 0 : size < 0);
          });
          if (hasPosition) {
            dbOrder.lifecycleStatus = 'OPEN';
            dbOrder.status = 'open';
            await dbOrder.save();
          } else {
            const age = Date.now() - dbOrder.createdAt.getTime();
            if (age > 60000) {
              dbOrder.lifecycleStatus = 'CLOSED';
              dbOrder.status = 'cancelled';
              await dbOrder.save();
            }
          }
        }
      }
    }
  }

  async run(
    parsed: ParsedStrategy,
    allPositions: Position[],
    openOrders: OpenOrder[],
    activeDbOrders: Order[],
    riskConfig: { autoCloseOppositePosition?: boolean }
  ): Promise<PreCheckResult> {
    const hasConflict = allPositions.some(p => {
      const size = parseFloat(p.size);
      if (!Number.isFinite(size) || size === 0) return false;
      const oppositeSide = parsed.side === 'buy' ? 'sell' : 'buy';
      return oppositeSide === 'buy' ? size > 0 : size < 0;
    });
    if (hasConflict) {
      if (riskConfig.autoCloseOppositePosition) {
        const conflictPos = allPositions.find(p => {
          const size = parseFloat(p.size);
          return p.symbol === parsed.symbol && (
            (parsed.side === 'buy' ? size < 0 : size > 0)
          );
        });
        return { shouldSkip: true, skipReason: 'conflict', conflictPosition: conflictPos || undefined };
      }
      return { shouldSkip: false };
    }
    return { shouldSkip: false };
  }

  private async backfillPnl(dbOrder: any): Promise<void> {
    try {
      const trades = await VirtualTrade.findAll({
        where: {
          exchangeInstanceId: dbOrder.exchangeInstanceId,
          symbol: dbOrder.symbol,
          [Op.or]: [
            { text: { [Op.like]: `%${dbOrder.exchangeOrderId}%` } },
            { text: { [Op.like]: `%-ord-${dbOrder.id}%` } },
          ],
        },
      });

      if (trades.length === 0) return;

      const totalPnl = trades.reduce((sum: number, t: any) => sum + parseFloat(t.realizedPnl || '0'), 0);
      const lastTrade = trades[trades.length - 1];

      dbOrder.realizedPnl = totalPnl.toFixed(4);
      dbOrder.exitPrice = lastTrade.price;
      dbOrder.closePrice = lastTrade.price;
      dbOrder.closedAt = dbOrder.closedAt || lastTrade.executedAt;
    } catch (err) {
      // Silently fail — this is a best-effort backfill
    }
  }
}
