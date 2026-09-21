import { Order } from '../models';
import { ParsedStrategy, StrategyRiskConfig } from './parsers/types';
import { ProtectionPipeline } from './ProtectionPipeline';
import { NoStopLossMonitor } from './NoStopLossMonitor';
import type { CloseExecutor } from './executor/types';
import auditService from './AuditService';
import logger, { formatError } from '../utils/logger';

export interface PostFillParams {
  order: Order;
  parsed: ParsedStrategy;
  riskConfig: StrategyRiskConfig;
  source: string;
  strategyId?: number;
  exchangeInstanceId?: string;
  tpOrders?: { price: string; amount: string }[];
  minOrderVolume?: number;
  /** 入场单已通过 tpsl_sl_trigger_price 自带止损：管线不再挂 SL。 */
  slPreAttached?: boolean;
  /** 入场单已通过 tpsl_tp_trigger_price 自带止盈：管线不再挂 TP。 */
  tpPreAttached?: boolean;
}

export class PostFillOrchestrator {
  constructor(
    private exchange: any,
    private noStopLossMonitor: NoStopLossMonitor,
    private protectionPipeline: ProtectionPipeline,
    private tradeExecutor: CloseExecutor,
  ) {}

  async run(params: PostFillParams): Promise<{ slPlaced: boolean; tpPlaced: boolean }> {
    const { order, parsed, riskConfig, source, strategyId, exchangeInstanceId, tpOrders: preCalculatedTpOrders, minOrderVolume, slPreAttached, tpPreAttached } = params;
    let slPlaced = !!slPreAttached;
    let tpPlaced = !!tpPreAttached;
    let resultClaimed: boolean | undefined;

    // Build TP orders if not pre-calculated
    // tpPreAttached: 自带 TP 已覆盖，post-fill 不再补挂任何 TP 限价单。
    let tpOrdersToPlace = tpPreAttached ? [] : (preCalculatedTpOrders ?? []);
    if (!preCalculatedTpOrders && parsed.targets && parsed.targets.length > 0) {
      try {
        const totalAmount = parseFloat(order.filledAmount || order.amount || '0');
        const markets = await this.exchange.getMarkets();
        const market = markets.find((m: any) => m.symbol === parsed.symbol);
        const amountPrecision = market?.amountPrecision ?? 2;
        const perTarget = (totalAmount / parsed.targets.length).toFixed(amountPrecision);
        tpOrdersToPlace = parsed.targets.map(t => ({ price: t, amount: perTarget }));
      } catch {
        tpOrdersToPlace = [];
      }
    }

    // Place SL and TP through the unified Pipeline
    if (slPreAttached && tpPreAttached) {
      // 单 TP + SL 全自带：入场单已通过 tpsl_tp_trigger_price / tpsl_sl_trigger_price
      // 由交易所托管保护，post-fill 无需（也不得）再挂任何保护单。
      // 注意不能走 placeProtections —— 全自带时 placeOrder 不创建 PendingProtection，
      // claim 必然失败，反而会把已受保护的状态误判为未保护。
      logger.info('Post-fill protection skipped: TP/SL fully pre-attached on entry order', {
        orderId: order.id,
        exchangeOrderId: order.exchangeOrderId,
        symbol: order.symbol,
      });
    } else if (parsed.stopLoss || tpOrdersToPlace.length > 0) {
      try {
        const filledQty = order.filledAmount || order.amount;
        const result = await this.protectionPipeline.placeProtections({
          orderId: order.exchangeOrderId,
          symbol: parsed.symbol,
          side: parsed.side as 'buy' | 'sell',
          // P1-4: SL 统一以 order.initialSl 为准（已含 entryPaddingR/slPaddingR 调整），
          // 与 placeOrder 写入 PendingProtection 的值一致，避免 REST 串行路径
          // 使用未加 padding 的 parsed.stopLoss 导致 slPaddingR 不生效。
          stopLossPrice: order.initialSl || parsed.stopLoss,
          tpOrders: tpOrdersToPlace,
          amount: filledQty,
          source,
          strategyId,
          slPreAttached,
          tpPreAttached,
          ...(minOrderVolume != null ? { minOrderVolume } : {}),
        });
        slPlaced = result.slPlaced;
        tpPlaced = result.tpPlaced;
        resultClaimed = result.claimed;
      } catch (err) {
        logger.error('Post-fill protection pipeline failed', formatError(err, {
          orderId: order.id,
          symbol: order.symbol,
          side: order.side,
        }));
        if (order.strategyId) {
          await auditService.log(order.strategyId, 'PROTECTION_FAILED', {
            orderId: order.id,
            symbol: order.symbol,
            error: err instanceof Error ? err.message : String(err),
          }, order.id, 'OPEN');
        }
      }
    }

    // Update lifecycle status
    const toStatus = slPlaced && tpPlaced ? 'PROTECTED' : 'OPEN';
    if (resultClaimed === false) {
      // P1-5: claim 失败说明 WS persistence handler 已经认领并放置了保护，
      // 该订单的状态可能已被置为 PROTECTED，这里不能再覆盖写（避免降级）。
      // 只刷新内存对象，不落库。
      logger.info('Post-fill protection already claimed by WS handler — skipping lifecycle status overwrite', {
        orderId: order.id,
        exchangeOrderId: order.exchangeOrderId,
      });
      try {
        await order.reload();
      } catch {
        // DB 读取失败时保守处理：不修改状态，仅注册监控。
      }
    } else {
      order.lifecycleStatus = toStatus;
      await order.save();
      logger.info('Order lifecycle status changed', {
        orderId: order.id,
        exchangeOrderId: order.exchangeOrderId,
        fromStatus: 'OPEN',
        toStatus,
        reason: slPlaced && tpPlaced ? 'SL + TP placed successfully' : 'partial protection placed',
        slPlaced,
        tpPlaced,
      });
    }

    // Register with NoStopLossMonitor
    if (slPlaced || tpPlaced) {
      this.noStopLossMonitor.watchOrder(String(order.id), order.symbol);
    }

    return { slPlaced, tpPlaced };
  }
}