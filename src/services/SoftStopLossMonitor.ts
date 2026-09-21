import { SoftStopLoss, Order } from '../models';
import exchangeRegistry from './exchanges';
import auditService from './AuditService';
import logger, { formatError, buildLogContextFromOrder, logContext } from '../utils/logger';

type CloseHandler = (params: {
  symbol: string;
  side: 'buy' | 'sell';
  strategyId?: number;
  exchangeInstanceId?: string;
  source: string;
  riskConfig?: any;
}) => Promise<any>;

export class SoftStopLossMonitor {
  private timer: NodeJS.Timeout | null = null;
  private readonly intervalMs: number;
  private readonly handleClose: CloseHandler;

  constructor(params: { handleClose: CloseHandler; intervalMs?: number }) {
    this.handleClose = params.handleClose;
    this.intervalMs = params.intervalMs || 60_000;
  }

  public start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.scanOnce().catch((error) => logger.error('SoftStopLossMonitor scan failed', formatError(error)));
    }, this.intervalMs);
  }

  public stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  public async scanOnce(): Promise<void> {
    const records = await SoftStopLoss.findAll({ where: { status: 'ACTIVE' } });
    for (const record of records as any[]) {
      // 单条记录校验失败不应中断整轮扫描；记录级异常在此捕获并记录。
      try {
        await this.checkRecord(record);
      } catch (error) {
        logger.error(`[SoftStopLoss] record id=${record.id} check failed`, formatError(error));
      }
    }
  }

  private async checkRecord(record: any): Promise<void> {
    // Restore log context from strategy's most recent order
    if (record.strategyId) {
      const order = await Order.findOne({
        where: { strategyId: record.strategyId },
        order: [['createdAt', 'DESC']],
      });
      if (order) {
        await logContext.run(new Map([['context', buildLogContextFromOrder(order)]]), async () => {
          await this._checkRecordInner(record);
        });
        return;
      }
    }
    await this._checkRecordInner(record);
  }

  private async _checkRecordInner(record: any): Promise<void> {
    // 交易所实例已不存在（如被删除）时，该停损记录永远无法评估，属于孤儿数据：
    // 将其清理并记录告警，避免每轮扫描反复报错。
    if (record.exchangeInstanceId && !exchangeRegistry.hasExchange(record.exchangeInstanceId)) {
      logger.warn(
        `[SoftStopLoss] Exchange instance ${record.exchangeInstanceId} missing for record id=${record.id}; cleaning up stale record`
      );
      await SoftStopLoss.destroy({ where: { id: record.id } });
      return;
    }
    const exchange = exchangeRegistry.getExchange(record.exchangeInstanceId || undefined);
    const candles = await exchange.getCandles(record.symbol, record.timeframe, 3);
    const candle = this.latestClosedCandle(candles, record.timeframe);
    if (!candle) return;

    const close = Number(candle.close);
    const stop = Number(record.price);
    if (!Number.isFinite(close) || !Number.isFinite(stop)) return;

    const shouldTrigger =
      record.side === 'buy' && record.direction === 'close_under'
        ? close < stop
        : record.side === 'sell' && record.direction === 'close_above'
          ? close > stop
          : false;

    if (!shouldTrigger) return;

    const [affectedRows] = await (SoftStopLoss as any).update(
      { status: 'TRIGGERED', triggeredAt: new Date(), triggerClosePrice: candle.close },
      { where: { id: record.id, status: 'ACTIVE' }, limit: 1 }
    );
    if (affectedRows === 0) {
      logger.info(`[SoftStopLoss] Skipping already-triggered record id=${record.id}`);
      return;
    }
    await record.reload();

    if (record.strategyId) {
      await auditService.log(record.strategyId, 'SOFT_STOP_TRIGGERED', {
        symbol: record.symbol,
        side: record.side,
        timeframe: record.timeframe,
        direction: record.direction,
        stopPrice: record.price,
        closePrice: candle.close,
        candleTimestamp: candle.timestamp,
      });
    }

    await this.handleClose({
      symbol: record.symbol,
      side: record.side,
      strategyId: record.strategyId || undefined,
      exchangeInstanceId: record.exchangeInstanceId || undefined,
      source: 'soft-stop-loss-monitor',
    });
  }

  private latestClosedCandle(candles: any[], timeframe: string): any | null {
    if (!Array.isArray(candles) || candles.length === 0) return null;

    const durationMs = this.timeframeDurationMs(timeframe);
    if (!durationMs) return null;

    const now = Date.now();
    const sorted = [...candles].sort((a, b) => Number(b.timestamp) - Number(a.timestamp));
    return sorted.find((c) => {
      const ts = Number(c.timestamp);
      return Number.isFinite(ts) && ts + durationMs <= now;
    }) || null;
  }

  private timeframeDurationMs(timeframe: string): number | null {
    const normalized = String(timeframe || '').toLowerCase();
    if (normalized === '15m') return 15 * 60 * 1000;
    if (normalized === '1h') return 60 * 60 * 1000;
    if (normalized === '4h') return 4 * 60 * 60 * 1000;
    if (normalized === '12h') return 12 * 60 * 60 * 1000;
    if (normalized === '1d') return 24 * 60 * 60 * 1000;
    return null;
  }
}

export default SoftStopLossMonitor;
