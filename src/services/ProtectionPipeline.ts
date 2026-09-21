/**
 * ProtectionPipeline - Position-Level Stop Loss Management
 * 
 * This module manages stop loss (SL) and take profit (TP) orders for trading positions.
 * 
 * **Stop Loss Strategy: Position-Level**
 * - All orders for the same symbol+side share a single stop loss order
 * - Gate.io API limitation: Only one close-position trigger order per contract
 * - When a new order is filled, the SL is updated to cover the entire position
 * - All OPEN/PROTECTED orders have their activeStopLossId updated to the same value
 * 
 * **Take Profit Strategy: Per-Order**
 * - Each order has its own TP orders (reduce-only limit orders)
 * - TP orders are identified by text: t-tp-{index}-ord-{orderId}
 * - When TP1 fills, SL is moved to breakeven to protect profits
 * - When all TPs fill and position is closed, SL is cancelled
 * 
 * **Key Methods:**
 * - placeProtections(): Place position-level SL and per-order TPs
 * - moveStopLossToBreakeven(): Move SL to entry price after TP1 fills
 * - cancelProtections(): Cancel all SL and TP orders for a symbol+side
 * 
 * **Integration:**
 * - Called by PostFillOrchestrator after order fills
 * - Called by GateIOOrderPersistenceHandler when TP fills
 * - Called by GateIOWSEventRouter when position closes
 */

import { Order, PendingProtection } from '../models';
import logger, { formatError } from '../utils/logger';
import { buildTakeProfitOrderText } from '../utils/orderText';

// 默认滑点基点（bps），当交易所未配置 defaultSlippageBps 时使用
const DEFAULT_SLIPPAGE_BPS = 30;
// bps 换算除数：1 bps = 0.0001
const BPS_DIVISOR = 10_000;

export interface PlaceProtectionsParams {
  orderId: string;
  symbol: string;
  side: 'buy' | 'sell';
  stopLossPrice?: string;
  tpOrders?: { price: string; amount: string }[];
  amount: string;
  source: string;
  strategyId?: number;
  /** 入场单已自带止损（Gate tpsl_sl_trigger_price）：跳过 SL 挂单，slPlaced 直接视为 true。 */
  slPreAttached?: boolean;
  /** 入场单已自带止盈（Gate tpsl_tp_trigger_price）：跳过 TP 挂单，tpPlaced 直接视为 true。 */
  tpPreAttached?: boolean;
}

export interface PlaceProtectionsResult {
  slPlaced: boolean;
  tpPlaced: boolean;
  claimed: boolean;
}

export class ProtectionPipeline {
  constructor(
    private exchange: any,
    private pendingProtectionModel: typeof PendingProtection,
    private orderModel: typeof Order,
  ) {}

  /**
   * 判断挂单方向：优先取 side 字段，缺失时从 raw.size 正负推断（Gate raw.size 正=买、负=卖）。
   */
  private _orderSide(o: any): 'buy' | 'sell' | undefined {
    if (o?.side === 'buy' || o?.side === 'sell') return o.side;
    const rawSize = parseFloat(o?.raw?.size ?? '0');
    if (Number.isFinite(rawSize) && rawSize !== 0) return rawSize > 0 ? 'buy' : 'sell';
    const initialSize = parseFloat(o?.initial?.size ?? '0');
    if (Number.isFinite(initialSize) && initialSize !== 0) return initialSize > 0 ? 'buy' : 'sell';
    return undefined;
  }

  async claimProtection(orderId: string): Promise<boolean> {
    try {
      // Atomic claim: UPDATE only succeeds if status is still PENDING
      // This prevents race conditions in distributed/multi-instance deployments
      const result = await (this.pendingProtectionModel as any).sequelize.query(
        `UPDATE pending_protections SET status = 'CLAIMED' WHERE orderId = :orderId AND status = 'PENDING'`,
        { replacements: { orderId }, type: (this.pendingProtectionModel as any).sequelize.QueryTypes.UPDATE }
      );
      const rows = this._extractAffectedRows(result);
      if (rows > 0) {
        logger.debug(`[ProtectionPipeline] Claim succeeded for ${orderId}`);
        return true;
      }
      // Claim failed — record either doesn't exist or is already CLAIMED/COMPLETED/FAILED
      logger.debug(`[ProtectionPipeline] Claim skipped for ${orderId} — not PENDING`);
      return false;
    } catch (err) {
      logger.warn(`[ProtectionPipeline] claimProtection failed for ${orderId}`, formatError(err));
      return false;
    }
  }

  async placeProtections(params: PlaceProtectionsParams): Promise<PlaceProtectionsResult> {
    let { orderId, symbol, side, stopLossPrice, tpOrders = [], amount, strategyId } = params;
    const claimed = await this.claimProtection(orderId);
    if (!claimed) {
      logger.debug(`[ProtectionPipeline] placeProtections skipped for ${orderId} — not claimed`);
      return { slPlaced: false, tpPlaced: false, claimed: false };
    }

    // OTOCO path: Limit order + single TP + SL on Lighter exchange
    // TODO: To enable OTOCO, need to integrate at TradeExecutor level:
    //   1. Detect limit order + single TP + SL before calling placeOrder
    //   2. Call exchange.placeOtocoOrder() instead of placeOrder + placeProtections
    //   3. Skip PendingProtection creation for OTOCO orders
    // Note: OTOCO is only used for NEW orders, not for post-fill protection placement
    // This path is currently disabled because it requires the main order to be placed first
    const isLighter = false; // Disabled: (this.exchange as any).constructor?.name === 'LighterExchange';
    if (isLighter && stopLossPrice && tpOrders.length === 1) {
      try {
        logger.info(`[ProtectionPipeline] Using OTOCO for ${orderId}: limit + SL + TP`);
        
        // Get the main order to extract entry price
        const mainOrder = await this.orderModel.findOne({ where: { exchangeOrderId: orderId } });
        if (!mainOrder) {
          logger.warn(`[ProtectionPipeline] Main order ${orderId} not found for OTOCO`);
          await this._markFailed(orderId);
          return { slPlaced: false, tpPlaced: false, claimed: true };
        }

        const entryPrice = mainOrder.price;
        const tpPrice = tpOrders[0].price;

        // Calculate SL trigger and execution prices
        const slippagePercent = ((this.exchange as any).config?.defaultSlippageBps || DEFAULT_SLIPPAGE_BPS) / BPS_DIVISOR;
        const stopLossTrigger = stopLossPrice;
        const stopLossExec = side === 'buy'
          ? (parseFloat(stopLossPrice) * (1 - slippagePercent)).toFixed(8)
          : (parseFloat(stopLossPrice) * (1 + slippagePercent)).toFixed(8);

        const result = await (this.exchange as any).placeOtocoOrder({
          symbol,
          side,
          amount: mainOrder.amount,
          entryPrice,
          slTrigger: stopLossTrigger,
          slExec: stopLossExec,
          tpPrice,
          orderId,
        });

        logger.info(`[ProtectionPipeline] OTOCO placed: main=${result.mainOrderId}, sl=${result.slOrderId}, tp=${result.tpOrderId}`);
        
        await this._markCompleted(orderId);
        return { slPlaced: true, tpPlaced: true, claimed: true };
      } catch (err) {
        logger.error(`[ProtectionPipeline] OTOCO placement failed for ${orderId}`, formatError(err));
        await this._markFailed(orderId);
        return { slPlaced: false, tpPlaced: false, claimed: true };
      }
    }

    // Standard path: Place SL and TP separately
    let slPlaced = !!params.slPreAttached;
    let tpPlaced = !!params.tpPreAttached;

    try {
      // Position-Level Stop Loss: Cover entire position, not just this order
      // slPreAttached=true 表示入场单已通过 tpsl_sl_trigger_price 自带止损，
      // 此时绝不能再挂第二道 SL（Gate 同方向只允许一个 close 触发单）。
      if (stopLossPrice && !params.slPreAttached) {
        const newSlId = await this._placePositionLevelStopLoss(symbol, side, stopLossPrice, strategyId);
        if (newSlId) {
          slPlaced = true;
          logger.info('Position-level SL placed', { symbol, side, stopLossPrice, stopLossId: newSlId, strategyId });
        } else {
          logger.warn('Position-level SL placement failed', { orderId, symbol, side, strategyId });
          await this._releaseClaim(orderId);
          return { slPlaced: false, tpPlaced: false, claimed: true };
        }
      }

      // Per-Order Take Profit: Each order has its own TP orders
      if (tpOrders.length > 0) {
        // 多 TP 接管：撤销入场单自带的 TP 腿（order_type=close-*-order + TP 方向 rule），
        // 保留自带 SL。best-effort —— 撤销失败不阻塞限价 TP 挂单（自带 TP 与 TP1 同价，
        // 即使抢先触发结果也一致）。
        if (typeof (this.exchange as any).cancelAttachedTpslTp === 'function') {
          try {
            await (this.exchange as any).cancelAttachedTpslTp(symbol, side, orderId);
          } catch (err) {
            logger.warn(`[ProtectionPipeline] cancelAttachedTpslTp failed for ${orderId}`, formatError(err));
          }
        }

        // P0-2: 部分成交时，TP 总量不得超过实际成交量。
        // amount 由调用方传入（WS 路径 = filledQty，REST 路径 = order.filledAmount），
        // 而 tpOrders 是按请求量预分的，这里统一按成交量缩放，覆盖所有路径。
        const targetAmount = parseFloat(amount);
        if (Number.isFinite(targetAmount) && targetAmount > 0) {
          const totalTp = tpOrders.reduce((sum, t) => sum + (parseFloat(t.amount) || 0), 0);
          if (totalTp > targetAmount + 1e-8) {
            const scale = targetAmount / totalTp;
            tpOrders = tpOrders.map(t => ({
              ...t,
              amount: (parseFloat(t.amount) * scale).toString(),
            }));
            logger.info(`[ProtectionPipeline] TP total ${totalTp} exceeds filled ${targetAmount}, scaled by ${scale.toFixed(4)}`);
          }
        }

        // P0-3: Gate reduce-only TP 不能超过净敞口（position - pendingSameSide）。
        // 当同 symbol 存在反向挂单时（如 position 327 + pending sell -392），直接挂 TP
        // 会被 Gate 拒绝（"position size ... and pending order ..."）。挂 TP 前先查询
        // 持仓与挂单，按净敞口裁剪 TP 数量；净敞口为 0 时跳过 TP。
        let tpSkippedDueToExposure = false;
        let availableNetTp: number | null = null; // 可用净敞口（供 P0-4 整数归一化使用）
        try {
          const [positions, openOrders] = await Promise.all([
            this.exchange.getPositions ? this.exchange.getPositions() : [],
            this.exchange.getOpenOrders ? this.exchange.getOpenOrders(symbol) : [],
          ]);
          const position = (positions || []).find((p: any) => p.symbol === symbol);
          const positionSize = Math.abs(parseFloat(position?.size ?? amount ?? '0') || 0);
          const tpSide = side === 'buy' ? 'sell' : 'buy';
          const pendingSameSide = (openOrders || [])
            .filter((o: any) => o.symbol === symbol && this._orderSide(o) === tpSide && String(o.status ?? '').toLowerCase() === 'open')
            .reduce((sum: number, o: any) => sum + Math.abs(parseFloat(o.amount ?? o.raw?.size ?? '0') || 0), 0);
          const availableTp = Math.max(0, positionSize - pendingSameSide);
          availableNetTp = availableTp;
          if (availableTp < 1e-8) {
            tpSkippedDueToExposure = true;
            logger.warn(`[ProtectionPipeline] Skipping TP for ${symbol} ${side}: no net exposure (position=${positionSize}, pending ${tpSide}=${pendingSameSide})`, { orderId, symbol, side, strategyId });
          } else {
            const totalTp = tpOrders.reduce((s, t) => s + (parseFloat(t.amount) || 0), 0);
            if (totalTp > availableTp + 1e-8) {
              const scale = availableTp / totalTp;
              tpOrders = tpOrders.map(t => ({ ...t, amount: (parseFloat(t.amount) * scale).toString() }));
              logger.info(`[ProtectionPipeline] TP total ${totalTp} clipped to net exposure ${availableTp} for ${symbol}`, { orderId, symbol, side, strategyId });
            }
          }
        } catch (err) {
          logger.warn(`[ProtectionPipeline] Net exposure check failed, using original TP plan`, formatError(err, { orderId, symbol, side, strategyId }));
        }

        // P0-4: 净敞口缩放/分配可能产生小数张（如 0.8 张），而 Gate 等交易所 size 必须为
        // 合约步进整数倍（BTC/ETH/SOL USDT 均为整数张，amountPrecision=0）。小数张会被
        // Gate 拒绝（"invalid size with close-order"），导致 reduce-only TP 保护全部失败。
        // 这里以可用净敞口为上限、按合约步进重新做整数分配：每档 ≥1 单位、各档总和达标。
        try {
          const markets = await (this.exchange.getMarkets ? this.exchange.getMarkets() : []);
          const market = (markets || []).find((m: any) => m.symbol === symbol);
          const ap = Number(market?.amountPrecision);
          const step = Number.isFinite(ap) && ap >= 0 ? Math.pow(10, -ap) : 1;
          const netForStep = availableNetTp !== null ? availableNetTp : (parseFloat(amount) || 0);
          if (Number.isFinite(step) && step > 0 && Number.isFinite(netForStep) && netForStep > 0 && tpOrders.length > 0) {
            const availUnits = Math.max(0, Math.floor(netForStep / step + 1e-9));
            const tiers = Math.min(tpOrders.length, availUnits);
            if (tiers <= 0) {
              tpOrders = [];
              logger.warn(`[ProtectionPipeline] TP skipped for ${symbol}: net exposure ${netForStep} smaller than one step ${step}`, { orderId, symbol, side, strategyId });
            } else {
              if (tiers < tpOrders.length) {
                logger.warn(`[ProtectionPipeline] TP tier count reduced from ${tpOrders.length} to ${tiers} for ${symbol} at step ${step} (net exposure too small)`, { orderId, symbol, side, strategyId });
              }
              const base = Math.floor(availUnits / tiers);
              const rem = availUnits % tiers;
              tpOrders = tpOrders.slice(0, tiers).map((t, i) => ({
                ...t,
                amount: ((base + (i < rem ? 1 : 0)) * step).toFixed(ap),
              }));
            }
          }
        } catch (err) {
          logger.warn(`[ProtectionPipeline] TP size step normalization failed, using unnormalized plan`, formatError(err, { orderId, symbol, side, strategyId }));
        }

        let tpFailed = false;
        for (const [index, tp] of tpOrders.entries()) {
          const tpText = buildTakeProfitOrderText(index + 1, orderId);
          const tpSide = side === 'buy' ? 'sell' : 'buy';
          try {
            // For Lighter exchange, use TAKE_PROFIT_LIMIT order type
            const isLighter = (this.exchange as any).constructor?.name === 'LighterExchange';
            const orderParams: any = {
              symbol,
              side: tpSide,
              amount: tp.amount,
              reduceOnly: true,
              type: 'limit',
              price: tp.price,
              text: tpText,
              timeInForce: 'GTC',
            };

            if (isLighter) {
              // For Lighter: TP uses trigger_price = execution_price (no extra slippage)
              orderParams.triggerPrice = tp.price;
              orderParams.lighterOrderType = 'TAKE_PROFIT_LIMIT';
            }

            await this.exchange.placeOrder(orderParams);
          } catch (tpErr) {
            tpFailed = true;
            logger.warn('TP placement failed', formatError(tpErr, { tpIndex: index + 1, symbol, side, orderId, strategyId }));
          }
        }
        tpPlaced = !tpFailed && !tpSkippedDueToExposure;
      }

      await this._markCompleted(orderId);
      logger.info('Protection placement completed', { orderId, symbol, side, slPlaced, tpPlaced, strategyId });
      return { slPlaced, tpPlaced, claimed: true };

    } catch (err) {
      logger.error('Protection placement unexpected error', formatError(err, { orderId, symbol, side, strategyId }));
      await this._markFailed(orderId);
      return { slPlaced: false, tpPlaced: false, claimed: true };
    }
  }

  async moveStopLossToBreakeven(orderId: string, bufferPercent = 0): Promise<boolean> {
    try {
      const order = await this.orderModel.findOne({ where: { exchangeOrderId: orderId } });
      if (!order) {
        logger.warn(`[ProtectionPipeline] Order ${orderId} not found for breakeven`);
        return false;
      }

      const symbol = order.symbol;
      const side = order.side as 'buy' | 'sell';

      // Calculate breakeven price from order entry
      const entryPrice = parseFloat(order.filledPrice || order.price || '0');
      if (!Number.isFinite(entryPrice) || entryPrice <= 0) {
        logger.warn(`[ProtectionPipeline] Invalid entry price for order ${orderId}`);
        return false;
      }

      const isLong = side === 'buy';
      const bufferedPrice = isLong
        ? entryPrice * (1 + bufferPercent)
        : entryPrice * (1 - bufferPercent);

      // Validate against current market price
      const ticker = await this.exchange.getTicker(symbol);
      const lastPrice = parseFloat(ticker.lastPrice);
      const minDistancePercent = Math.max(bufferPercent, 0.001);
      let targetPrice = bufferedPrice;

      if (isLong && targetPrice >= lastPrice) {
        targetPrice = lastPrice * (1 - minDistancePercent);
        logger.warn(`[ProtectionPipeline] Breakeven SL above market for ${symbol}; fallback to ${targetPrice}`);
      }
      if (!isLong && targetPrice <= lastPrice) {
        targetPrice = lastPrice * (1 + minDistancePercent);
        logger.warn(`[ProtectionPipeline] Breakeven SL below market for ${symbol}; fallback to ${targetPrice}`);
      }

      if (!Number.isFinite(targetPrice) || targetPrice <= 0) {
        logger.warn(`[ProtectionPipeline] Invalid fallback SL price for ${orderId}: ${targetPrice}`);
        return false;
      }

      const markets = await this.exchange.getMarkets();
      const market = markets.find((m: any) => m.symbol === symbol);
      const newPrice = market ? targetPrice.toFixed(market.pricePrecision) : targetPrice.toString();

      // Use position-level SL placement (will cancel old SL and create new one)
      const newSlId = await this._placePositionLevelStopLoss(symbol, side, newPrice, order.strategyId);
      
      if (newSlId) {
        logger.info('Moved position-level SL to breakeven', { symbol, side, newSlPrice: newPrice, stopLossId: newSlId });
        return true;
      }
      
      return false;
    } catch (err) {
      logger.error('Move SL to breakeven failed', formatError(err, { orderId }));
      return false;
    }
  }

  async cancelProtections(symbol: string, side: 'buy' | 'sell', orderId?: string): Promise<void> {
    // Cancel SL trigger orders and TP limit orders independently —
    // a failure in one path must not prevent the other from running.
    await Promise.all([
      this._cancelSlOrders(symbol, side),
      this.cancelTpOrders(symbol, side, orderId),
      this._cancelAttachedTpLegs(symbol, side, orderId),
    ]);
  }

  /**
   * 撤销入场单自带的 TP 腿（close-*-order 类型的价格触发单）。
   * 单 TP 全自带场景（tpsl_tp_trigger_price）下，TP 不是普通限价单而是
   * 服务端托管的价格触发单，cancelTpOrders（查 open orders）覆盖不到，需单独撤销。
   */
  private async _cancelAttachedTpLegs(symbol: string, side: 'buy' | 'sell', orderId?: string): Promise<void> {
    const cancelFn = (this.exchange as any).cancelAttachedTpslTp;
    if (typeof cancelFn !== 'function') return;
    try {
      // 不带 entryOrderId 时按类型+rule 匹配该方向的所有自带 TP 腿。
      await cancelFn.call(this.exchange, symbol, side, orderId || '');
    } catch (err) {
      logger.warn(`[ProtectionPipeline] _cancelAttachedTpLegs failed for ${symbol} ${side}`, formatError(err));
    }
  }

  private async _cancelSlOrders(symbol: string, side: 'buy' | 'sell'): Promise<void> {
    try {
      const orders = await this.exchange.getPriceOrders(symbol);
      const slRule = side === 'buy' ? 2 : 1; // Long SL uses rule 2, Short SL uses rule 1

      logger.info(`[ProtectionPipeline] _cancelSlOrders: symbol=${symbol}, side=${side}, slRule=${slRule}, priceOrders=${orders.length}`);

      const toCancel = orders.filter((o: any) => {
        const rule = o.trigger?.rule;

        logger.info(`[ProtectionPipeline] Checking price order: id=${o.id}, rule=${rule}, slRule=${slRule}, match=${rule === slRule}`);

        // Match by rule (position-level SL for this side) AND text prefix AND reduce_only
        // SL orders are price-triggered orders with:
        //   - specific rule (1 for short, 2 for long)
        //   - text starting with 't-sl-pos-'
        //   - reduce_only = true (SDK camelCase) or reduce_only = true (raw snake_case)
        const orderText = String(o.text || o.initial?.text || '');
        const isReduceOnly = o.initial?.reduceOnly ?? o.initial?.reduce_only ?? o.reduce_only;
        const isPositionSl = rule === slRule && orderText.startsWith('t-sl-pos-') && isReduceOnly === true;
        // 入场单自带 SL（Gate tpsl_sl_trigger_price 生成的 close-*-order）：全平撤保护时一并撤销。
        const attachedOrderType = side === 'buy' ? 'close-long-order' : 'close-short-order';
        const rawOrderType = String(o.orderType ?? o.order_type ?? o.raw?.order_type ?? '').toLowerCase();
        const isAttachedSl = rule === slRule && rawOrderType === attachedOrderType;
        return isPositionSl || isAttachedSl;
      });

      logger.info(`[ProtectionPipeline] Found ${toCancel.length} SL orders to cancel for ${symbol} ${side}`);

      for (const order of toCancel) {
        try {
          await this.exchange.cancelPriceOrder(order.id, symbol);
          logger.info(`[ProtectionPipeline] Cancelled SL order ${order.id} for ${symbol} ${side}`);
        } catch (err: any) {
          logger.error(`[ProtectionPipeline] Failed to cancel SL order ${order.id}`, formatError(err));
        }
      }
    } catch (err) {
      logger.error('Cancel SL orders failed', formatError(err, { symbol, side }));
    }
  }

  async cancelTpOrders(symbol: string, side: 'buy' | 'sell', orderId?: string): Promise<void> {
    try {
      const openOrders = await this.exchange.getOpenOrders(symbol);
      const closeSide = side === 'buy' ? 'sell' : 'buy';

      logger.info(`[ProtectionPipeline] _cancelTpOrders: symbol=${symbol}, side=${side}, closeSide=${closeSide}, openOrders=${openOrders.length}, orderId=${orderId || 'none'}`);

      const toCancel = openOrders.filter((o: any) => {
        const raw = o.raw || o;
        const text = String(raw?.text || o.text || raw?.initial?.text || '');
        
        // TP orders are identified by text pattern: t-tp-{index}-ord-{orderId}
        if (!text.includes('t-tp-')) {
          return false;
        }

        // If orderId provided, only cancel TPs linked to that order
        if (orderId && !text.includes(`-ord-${orderId}`)) {
          return false;
        }

        // Verify close side matches
        const rawSize = parseFloat(raw?.size ?? o.amount ?? '0');
        const fallbackSide = String(o.side || '').toLowerCase();
        const orderSide = Number.isFinite(rawSize) && rawSize !== 0
          ? (rawSize < 0 ? 'sell' : 'buy')
          : (fallbackSide === 'sell' || fallbackSide === 'buy' ? fallbackSide : '');
        
        const match = orderSide === closeSide;
        logger.info(`[ProtectionPipeline] TP order ${o.id}: text=${text}, rawSize=${rawSize}, orderSide=${orderSide}, closeSide=${closeSide}, match=${match}`);
        
        return match;
      });

      logger.info(`[ProtectionPipeline] Found ${toCancel.length} TP orders to cancel for ${symbol} ${side}`);

      for (const order of toCancel) {
        try {
          await this.exchange.cancelOrder(order.id, symbol);
          logger.info(`[ProtectionPipeline] Cancelled TP order ${order.id} for ${symbol} ${side}`);
        } catch (err: any) {
          logger.error(`[ProtectionPipeline] Failed to cancel TP order ${order.id}`, formatError(err));
        }
      }
    } catch (err) {
      logger.error('Cancel TP orders failed', formatError(err, { symbol, side }));
    }
  }

  /**
   * Place a position-level stop loss that covers the entire position.
   * Cancels all existing SL orders for this symbol+side, then creates a new one.
   * Updates activeStopLossId for all OPEN/PROTECTED orders.
   */
  private async _placePositionLevelStopLoss(
    symbol: string,
    side: 'buy' | 'sell',
    stopLossPrice: string,
    strategyId?: number
  ): Promise<string | null> {
    try {
      // 1. Query current position with retry — GateIO REST API may lag behind WS fill
      const POSITION_RETRY_DELAYS = [500, 1500];
      let position = await this.exchange.getPosition(symbol);

      for (const delay of POSITION_RETRY_DELAYS) {
        const size = parseFloat(position?.size);
        // Use Number.isFinite to correctly detect valid numbers (NaN !== 0 is true, which would incorrectly break)
        if (position && Number.isFinite(size) && size !== 0) break;
        await new Promise(resolve => setTimeout(resolve, delay));
        position = await this.exchange.getPosition(symbol);
      }

      const finalSize = parseFloat(position?.size);
      if (!position || !Number.isFinite(finalSize) || finalSize === 0) {
        logger.warn(`[ProtectionPipeline] No position found for ${symbol} after retries, skipping SL placement`);
        return null;
      }

      const posSize = finalSize;
      // Defensive check: ensure posSize is a valid number (should always pass after above checks)
      if (!Number.isFinite(posSize)) {
        logger.warn(`[ProtectionPipeline] Invalid position size for ${symbol}: ${position?.size}, skipping SL placement`);
        return null;
      }
      const isLongPos = posSize > 0;
      const intendedLong = side === 'buy';
      
      if (isLongPos !== intendedLong) {
        logger.warn(`[ProtectionPipeline] Position side mismatch for ${symbol}: pos=${posSize > 0 ? 'long' : 'short'}, intended=${side}`);
        return null;
      }

      const totalAmount = Math.abs(posSize).toString();
      const closeSide = isLongPos ? 'sell' : 'buy';
      const slText = `t-sl-pos-${symbol}-${closeSide}`; // Close-side identifier (matches ProtectionManager convention)

      // Place new position-level SL (updateStopLoss will cancel old SLs internally)
      const newSlId = await this.exchange.updateStopLoss(symbol, side, stopLossPrice, slText, totalAmount);
      if (!newSlId) {
        logger.warn(`[ProtectionPipeline] updateStopLoss returned null for ${symbol}`);
        return null;
      }

      // 4. Update activeStopLossId for all OPEN/PROTECTED orders of this symbol+side
      await this._updateActiveStopLossIdForPosition(symbol, side, newSlId);

      logger.info('Position-level SL created', { symbol, side, stopLossPrice, amount: totalAmount, stopLossId: newSlId, strategyId });
      return newSlId;

    } catch (err: any) {
      logger.error('Place position-level SL failed', formatError(err, { symbol, side, stopLossPrice, strategyId }));
      return null;
    }
  }

  /**
   * Update activeStopLossId for all OPEN/PROTECTED orders of a given symbol+side.
   */
  private async _updateActiveStopLossIdForPosition(
    symbol: string,
    side: 'buy' | 'sell',
    slId: string
  ): Promise<void> {
    try {
      const orders = await this.orderModel.findAll({
        where: {
          symbol,
          side,
          exchangeInstanceId: this.exchange.id,
          lifecycleStatus: ['INIT', 'PENDING', 'OPEN', 'PROTECTED'],
        },
      });

      for (const order of orders) {
        await (order as any).update({ activeStopLossId: slId });
      }

      logger.info(`[ProtectionPipeline] Updated activeStopLossId=${slId} for ${orders.length} orders (${symbol} ${side})`);
    } catch (err: any) {
      logger.error(`[ProtectionPipeline] _updateActiveStopLossIdForPosition failed`, formatError(err));
    }
  }

  private _extractAffectedRows(result: any): number {
    if (typeof result === 'number') {
      return result;
    }

    if (Array.isArray(result)) {
      for (const item of result) {
        if (typeof item === 'number') {
          return item;
        }
        if (Array.isArray(item)) {
          return item.length;
        }
      }
    }

    return 0;
  }

  private async _markCompleted(orderId: string): Promise<void> {
    try {
      const record = await this.pendingProtectionModel.findByPk(orderId);
      if (record) {
        await (record as any).update({ status: 'COMPLETED' });
        await record.destroy();
      }
    } catch (err) {
      logger.warn(`[ProtectionPipeline] Failed to mark COMPLETED for ${orderId}`, formatError(err));
    }
  }

  private async _releaseClaim(orderId: string): Promise<void> {
    try {
      await (this.pendingProtectionModel as any).sequelize.query(
        `UPDATE pending_protections SET status = 'PENDING' WHERE orderId = :orderId AND status = 'CLAIMED'`,
        { replacements: { orderId }, type: (this.pendingProtectionModel as any).sequelize.QueryTypes.UPDATE }
      );
    } catch (err) {
      logger.warn(`[ProtectionPipeline] Failed to release claim for ${orderId}`, formatError(err));
    }
  }

  private async _markFailed(orderId: string): Promise<void> {
    try {
      const record = await this.pendingProtectionModel.findByPk(orderId);
      if (record) {
        await (record as any).update({ status: 'FAILED' });
      }
    } catch (err) {
      logger.warn(`[ProtectionPipeline] Failed to mark FAILED for ${orderId}`, formatError(err));
    }
  }
}
