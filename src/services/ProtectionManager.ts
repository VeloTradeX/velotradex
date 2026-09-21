import logger, { formatError } from '../utils/logger';
import { buildTakeProfitOrderText } from '../utils/orderText';

interface ProtectionParams {
  orderId: string;
  symbol: string;
  side: 'buy' | 'sell';
  amount: string;         // exact filled amount — DO NOT query position
  stopLossPrice?: string;
  takeProfitPrice?: string;
  source: string;
}

export class ProtectionManager {
  constructor(private exchange: any) {}

  /**
   * Place a stop loss for a specific filled order.
   * Uses the passed `amount` directly — does NOT query the full position size.
   */
  public async placeStopLoss(params: ProtectionParams): Promise<string | null> {
    if (!params.stopLossPrice) {
      logger.warn('[ProtectionManager] No stopLossPrice provided, skipping SL placement');
      return null;
    }

    const closeSide = params.side === 'buy' ? 'sell' : 'buy';
    const slText = `t-sl-pos-${params.symbol}-${closeSide}`;
    try {
      const newSlId = await this.exchange.updateStopLoss(
        params.symbol,
        params.side,
        params.stopLossPrice,
        slText,
        params.amount
      );
      if (!newSlId) {
        logger.warn(`[ProtectionManager] SL update returned null for ${params.symbol} (text: ${slText})`);
        return null;
      }
      logger.info(`[ProtectionManager] Placed SL for ${params.symbol} at ${params.stopLossPrice} (id: ${newSlId}, text: ${slText})`);
      return newSlId;
    } catch (error: any) {
      logger.error(`[ProtectionManager] Failed to place SL for ${params.symbol}`, formatError(error));
      return null;
    }
  }

  /**
   * Place a take profit for a specific filled order.
   * Uses the passed `amount` directly — does NOT query the full position size.
   * Closes the position: sell for long, buy for short.
   */
  public async placeTakeProfit(params: ProtectionParams): Promise<string[]> {
    if (!params.takeProfitPrice) {
      logger.warn('[ProtectionManager] No takeProfitPrice provided, skipping TP placement');
      return [];
    }

    const isLong = params.side === 'buy';
    const tpSide = isLong ? 'sell' : 'buy';
    const text = buildTakeProfitOrderText(1, params.orderId);

    try {
      const result = await this.exchange.placeOrder({
        symbol: params.symbol,
        side: tpSide,
        amount: params.amount,
        reduceOnly: true,
        type: 'limit',
        price: params.takeProfitPrice,
        text,
      });
      const tpOrderId = result?.id?.toString() || null;
      logger.info(`[ProtectionManager] Placed TP for ${params.symbol} at ${params.takeProfitPrice} (id: ${tpOrderId}, text: ${text})`);
      return tpOrderId ? [tpOrderId] : [];
    } catch (error: any) {
      logger.error(`[ProtectionManager] Failed to place TP for ${params.symbol}`, formatError(error));
      return [];
    }
  }

  /**
   * Cancel all protection orders scoped to a specific filled order.
   * Includes:
   * 1. SL orders with text `t-sl-pos-${symbol}-${closeSide}`
   * 2. TP orders with text matching `t-tp-*-ord-${orderId}`
   */
  public async cancelProtections(symbol: string, side: 'buy' | 'sell', orderId: string): Promise<void> {
    const closeSide = side === 'buy' ? 'sell' : 'buy';
    const slText = `t-sl-pos-${symbol}-${closeSide}`;
    const tpTextSuffix = `-ord-${orderId}`;

    try {
      // Cancel SL orders (price orders)
      const priceOrders = await this.exchange.getPriceOrders(symbol);
      const slToCancel = priceOrders.filter((o: any) => {
        const orderText = String(o.text || o.initial?.text || '');
        return orderText === slText;
      });

      for (const order of slToCancel) {
        try {
          await this.exchange.cancelPriceOrder(order.id, symbol);
          logger.info(`[ProtectionManager] Cancelled SL order ${order.id} (text: ${slText})`);
        } catch (err: any) {
          logger.error(`[ProtectionManager] Failed to cancel SL order ${order.id}`, formatError(err));
        }
      }

      // Cancel TP orders (open limit orders)
      const openOrders = await this.exchange.getOpenOrders(symbol);
      const tpToCancel = openOrders.filter((o: any) => {
        const raw = o.raw || o;
        const orderText = String(raw.text || o.text || raw.initial?.text || '');
        const isReduceOnly = raw.reduceOnly === true || raw.is_reduce_only === true || o.reduceOnly === true;
        const orderSide = Number.isFinite(raw.size)
          ? (raw.size < 0 ? 'sell' : 'buy')
          : String(o.side || '').toLowerCase();

        return isReduceOnly
          && orderText.includes('t-tp-')
          && orderText.includes(tpTextSuffix)
          && orderSide === closeSide;
      });

      for (const order of tpToCancel) {
        try {
          await this.exchange.cancelOrder(order.id, symbol);
          logger.info(`[ProtectionManager] Cancelled TP order ${order.id} (text: ${order.raw?.text || order.text})`);
        } catch (err: any) {
          logger.error(`[ProtectionManager] Failed to cancel TP order ${order.id}`, formatError(err));
        }
      }
    } catch (error: any) {
      logger.error(`[ProtectionManager] Failed to cancel protections for ${symbol}`, formatError(error));
    }
  }

  /**
   * Cancel only TP orders scoped to a specific filled order, keeping SL alive.
   * Used for TP-triggered closes so the WS handler can move SL to breakeven.
   */
  public async cancelTpOrders(symbol: string, side: 'buy' | 'sell', orderId?: string): Promise<void> {
    const tpTextSuffix = orderId ? `-ord-${orderId}` : undefined;
    const closeSide = side === 'buy' ? 'sell' : 'buy';

    try {
      const openOrders = await this.exchange.getOpenOrders(symbol);
      const tpToCancel = openOrders.filter((o: any) => {
        const raw = o.raw || o;
        const orderText = String(raw.text || o.text || raw.initial?.text || '');
        const isReduceOnly = raw.reduceOnly === true || raw.is_reduce_only === true || o.reduceOnly === true;
        const orderSide = Number.isFinite(raw.size)
          ? (raw.size < 0 ? 'sell' : 'buy')
          : String(o.side || '').toLowerCase();

        if (!orderText.includes('t-tp-') || orderSide !== closeSide || !isReduceOnly) return false;
        if (tpTextSuffix && !orderText.includes(tpTextSuffix)) return false;
        return true;
      });

      for (const order of tpToCancel) {
        try {
          await this.exchange.cancelOrder(order.id, symbol);
          logger.info(`[ProtectionManager] Cancelled TP order ${order.id} (text: ${order.raw?.text || order.text})`);
        } catch (err: any) {
          logger.error(`[ProtectionManager] Failed to cancel TP order ${order.id}`, formatError(err));
        }
      }
    } catch (error: any) {
      logger.error(`[ProtectionManager] Failed to cancel TP orders for ${symbol}`, formatError(error));
    }
  }

  /**
   * Move the SL of a specific order to breakeven (entry price + buffer).
   * Uses Order.activeStopLossId for direct lookup instead of text matching.
   */
  public async checkBreakeven(symbol: string, orderId: string, bufferPercent = 0.0005): Promise<boolean> {
    try {
      const { Order } = require('../models');
      const order = await Order.findOne({ where: { id: parseInt(orderId, 10) } });
      if (!order) {
        logger.warn(`[ProtectionManager] Order ${orderId} not found for breakeven`);
        return false;
      }

      const side = order.side as 'buy' | 'sell';
      const entryPrice = parseFloat(order.filledPrice || order.price || '0');
      if (!Number.isFinite(entryPrice) || entryPrice <= 0) {
        logger.warn(`[ProtectionManager] Invalid entry price for order ${orderId}`);
        return false;
      }

      const isLong = side === 'buy';
      const bufferedPrice = isLong
        ? entryPrice * (1 + bufferPercent)
        : entryPrice * (1 - bufferPercent);

      // Use activeStopLossId for direct lookup
      const slId = order.activeStopLossId;
      if (!slId) {
        logger.warn(`[ProtectionManager] No activeStopLossId for order ${orderId}`);
        return false;
      }

      const priceOrders = await this.exchange.getPriceOrders(symbol);
      const slOrder = priceOrders.find((o: any) => {
        const orderId = String(o.id || '');
        const orderText = String(o.text || o.initial?.text || '');
        return orderId === String(slId) || orderText === String(slId);
      });

      if (!slOrder) {
        logger.warn(`[ProtectionManager] SL order not found with id ${slId}`);
        return false;
      }

      const currentSLPrice = parseFloat(slOrder.trigger?.price || slOrder.stopLoss || slOrder.price || '0');
      if (Math.abs(currentSLPrice - entryPrice) < (entryPrice * 0.001)) {
        logger.info(`[ProtectionManager] SL already at breakeven for ${symbol}`);
        return true;
      }

      const ticker = await this.exchange.getTicker(symbol);
      const lastPrice = parseFloat(ticker.lastPrice);

      if (isLong && bufferedPrice >= lastPrice) {
        logger.warn(`[ProtectionManager] Cannot set breakeven SL: buffered ${bufferedPrice} >= last ${lastPrice}`);
        return false;
      }
      if (!isLong && bufferedPrice <= lastPrice) {
        logger.warn(`[ProtectionManager] Cannot set breakeven SL: buffered ${bufferedPrice} <= last ${lastPrice}`);
        return false;
      }

      const markets = await this.exchange.getMarkets();
      const market = markets.find((m: any) => m.symbol === symbol);
      const newPrice = market ? bufferedPrice.toFixed(market.pricePrecision) : bufferedPrice.toString();

      const closeSide = side === 'buy' ? 'sell' : 'buy';
      const slText = `t-sl-pos-${symbol}-${closeSide}`;
      await this.exchange.updateStopLoss(symbol, side, newPrice, slText, order.filledAmount || order.amount);

      logger.info(`[ProtectionManager] Moved SL to breakeven for ${symbol}: ${newPrice}`);
      return true;
    } catch (error: any) {
      logger.error(`[ProtectionManager] checkBreakeven failed for ${symbol}`, formatError(error));
      return false;
    }
  }
}
