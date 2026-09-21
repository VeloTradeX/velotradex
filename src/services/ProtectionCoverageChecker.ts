import { Order } from '../models';
import { isStopLossOrder, isTakeProfitTriggerOrder, isReduceOnlyTpOpenOrder } from './OrderClassifier';
import { Position } from './exchanges/IExchange';
import logger from '../utils/logger';

const PROTECTION_QTY_EPSILON = 1e-8;

export async function getTakeProfitCoverage(
    exchange: any,
    symbol: string,
    side: 'buy' | 'sell'
): Promise<number> {
    let coverage = 0;

    const [openOrders, priceOrders] = await Promise.all([
        exchange.getOpenOrders(symbol),
        exchange.getPriceOrders(symbol)
    ]);

    for (const order of openOrders) {
        if (!isReduceOnlyTpOpenOrder(order, side)) continue;
        const raw = order?.raw || order;
        const left = parseFloat(raw?.left ?? '');
        const size = parseFloat(raw?.size ?? order?.amount ?? '0');
        const qtyBase = Number.isFinite(left) && left > 0 ? left : size;
        const qty = Math.abs(qtyBase);
        if (Number.isFinite(qty)) coverage += qty;
    }

    for (const order of priceOrders) {
        if (!isTakeProfitTriggerOrder(order, side)) continue;
        const rawSize = Math.abs(parseFloat(order?.initial?.size || order?.amount || '0'));
        if (Number.isFinite(rawSize) && rawSize > 0) {
            coverage += rawSize;
            continue;
        }
        coverage = Number.POSITIVE_INFINITY;
    }

    return coverage;
}

export async function hasTakeProfitProtection(
    exchange: any,
    symbol: string,
    side: 'buy' | 'sell',
    positionSize?: number
): Promise<boolean> {
    const coverage = await getTakeProfitCoverage(exchange, symbol, side);
    if (!Number.isFinite(coverage)) return true;
    if (!positionSize || positionSize <= 0) return coverage > PROTECTION_QTY_EPSILON;
    return coverage + PROTECTION_QTY_EPSILON >= positionSize;
}

export async function shouldCheckBreakevenOnRecovery(exchangeInstanceId: string, position: Position): Promise<any[]> {
    const positionSize = Math.abs(parseFloat(position.size));
    if (!Number.isFinite(positionSize) || positionSize <= 0) {
        return [];
    }

    const side = parseFloat(position.size) > 0 ? 'buy' : 'sell';
    const activeOrders = await Order.findAll({
        where: {
            symbol: position.symbol,
            side,
            exchangeInstanceId,
            lifecycleStatus: ['OPEN', 'PROTECTED']
        }
    });

    if (activeOrders.length === 0) {
        logger.info(`TradeExecutor: Skip Breakeven recovery for ${position.symbol}, no tracked active order found.`);
        return [];
    }

    const trackedEntrySize = activeOrders.reduce((sum, order) => {
        const qty = parseFloat(order.filledAmount || order.amount || '0');
        return Number.isFinite(qty) ? sum + Math.abs(qty) : sum;
    }, 0);

    if (trackedEntrySize <= 0) {
        logger.info(`TradeExecutor: Skip Breakeven recovery for ${position.symbol}, tracked entry size unavailable.`);
        return [];
    }

    const hasReduced = trackedEntrySize > positionSize + PROTECTION_QTY_EPSILON;
    if (!hasReduced) {
        logger.info(`TradeExecutor: Skip Breakeven recovery for ${position.symbol}, no reduction detected (entry=${trackedEntrySize}, current=${positionSize}).`);
    }
    return hasReduced ? activeOrders : [];
}
