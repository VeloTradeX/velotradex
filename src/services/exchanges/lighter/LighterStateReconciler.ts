import { EventEmitter } from 'events';
import { Op } from 'sequelize';
import { OrderResult, Position } from '../IExchange';
import logger from '../../../utils/logger';
import { firstString } from '../../../utils/coalesceString';

type FillWaiter = {
  symbol: string;
  resolve: (value: OrderResult) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout | null;
};

type LighterOrderStatus = 'FILLED' | 'CANCELLED' | 'REJECTED' | string;

export class LighterStateReconciler extends EventEmitter {
  private readonly fillWaiters = new Map<string, FillWaiter>();

  constructor(private readonly deps: {
    journalModel: any;
    lookupOrder?: (clientOrderIndex: string, symbol: string) => Promise<OrderResult | null>;
    lookupTx?: (identifier: string, identifierType?: 'nonce' | 'txInfoHash') => Promise<unknown>;
  }) {
    super();
  }

  waitForFill(clientOrderIndex: string, symbol: string, timeoutMs: number = 15000): Promise<OrderResult> {
    const key = String(clientOrderIndex);
    this.rejectExistingWaiter(key);
    logger.info(`[Reconciler] waitForFill: ${key} (${symbol}), timeout=${timeoutMs > 0 ? `${timeoutMs}ms` : 'disabled'}`);

    return new Promise((resolve, reject) => {
      const waiter: FillWaiter = {
        symbol,
        resolve,
        reject,
        timer: timeoutMs > 0 ? setTimeout(async () => {
          if (this.fillWaiters.get(key) !== waiter) return;
          this.fillWaiters.delete(key);
          logger.warn(`[Reconciler] waitForFill TIMEOUT for ${key} (${symbol}), trying REST fallback...`);
          try {
            const fallback = await this.deps.lookupOrder?.(key, symbol);
            if (fallback && fallback.status === 'filled') {
              logger.info(`[Reconciler] REST fallback found order ${key} filled, resolving`);
              resolve(fallback);
              return;
            }
            logger.warn(`[Reconciler] REST fallback: order ${key} status=${fallback?.status ?? 'not found'}`);
          } catch (err) {
            logger.warn(`[Reconciler] REST fallback error for ${key}: ${err}`);
          }
          reject(new Error(`Timed out waiting for Lighter order fill: ${key} ${symbol}`));
        }, timeoutMs) : null,
      };

      this.fillWaiters.set(key, waiter);
    });
  }

  async reconcileStartup(exchangeInstanceId: string): Promise<{ safeToTrade: boolean; unknownTxCount: number }> {
    const rows = await this.deps.journalModel.findAll({
      where: {
        exchangeInstanceId,
        status: { [Op.in]: ['UNKNOWN', 'SENT', 'ACCEPTED'] },
      },
    });

    let unresolvedCount = rows.length;

    for (const row of rows) {
      if (!this.isUnsignedLocalFailure(row)) continue;
      row.status = 'REJECTED';
      row.confirmedAt = new Date();
      row.error = row.error ?? 'tx was never signed or submitted';
      await row.save();
      unresolvedCount--;
    }

    if (this.deps.lookupTx) {
      for (const row of rows) {
        if (row.status === 'REJECTED' || row.status === 'CONFIRMED') continue;

        const identifier = row.txInfoHash ?? row.nonce;
        if (!identifier) continue;

        try {
          const identifierType = row.txInfoHash ? 'txInfoHash' as const : 'nonce' as const;
          const remote = await this.deps.lookupTx(identifier, identifierType);
          if (!remote || typeof remote !== 'object') continue;

          const normalized = this.normalizeTxStatus(remote);
          if (normalized === 'CONFIRMED') {
            row.status = 'CONFIRMED';
            row.confirmedAt = new Date();
            row.error = null;
            await row.save();
            unresolvedCount--;
          } else if (normalized === 'REJECTED') {
            row.status = 'REJECTED';
            row.confirmedAt = new Date();
            row.error = (remote as any).error ?? (remote as any).message ?? (remote as any).reason ?? 'tx rejected';
            await row.save();
            unresolvedCount--;
          }
        } catch {
          // Leave row as unresolved if lookup fails
        }
      }
    }

    return {
      safeToTrade: unresolvedCount === 0,
      unknownTxCount: unresolvedCount,
    };
  }

  private isUnsignedLocalFailure(row: any): boolean {
    return row.status === 'UNKNOWN' && !row.txInfoHash && Boolean(row.error);
  }

  handleOrderEvent(event: any): void {
    const clientOrderIndex = this.normalizeClientOrderIndex(event);
    if (!clientOrderIndex) {
      logger.debug('[Reconciler] handleOrderEvent: no clientOrderIndex, dropping event');
      return;
    }

    const status = String(event.status || '').toUpperCase() as LighterOrderStatus;
    const hasWaiter = this.fillWaiters.has(clientOrderIndex);
    logger.debug(`[Reconciler] handleOrderEvent: coi=${clientOrderIndex}, status=${status}, hasWaiter=${hasWaiter}`);

    const result: OrderResult = {
      id: clientOrderIndex,
      status: this.normalizeOrderStatus(status),
      amount: firstString(event.filled_base_amount, event.filledBaseAmount, event.base_amount, event.baseAmount),
      price: firstString(event.avg_price, event.avgPrice, event.price),
      raw: event,
    };

    this.resolveTerminalWaiter(clientOrderIndex, status, result);
    this.emit('order', result);
    this.finalizeJournalFromOrderEvent(clientOrderIndex, status).catch(() => undefined);
  }

  handleTxEvent(event: any): void {
    this.finalizeJournalFromTxEvent(event).catch(() => undefined);
  }

  normalizePosition(event: any): Position {
    const rawSize = firstString(event.size, event.position_size, event.positionSize, event.position) || '0';
    const side = this.normalizePositionSide(event);
    const signedSize = side === 'short' && !rawSize.startsWith('-') && rawSize !== '0'
      ? `-${rawSize}`
      : rawSize;

    return {
      symbol: String(event.symbol || event.market || ''),
      size: signedSize,
      entryPrice: firstString(event.entry_price, event.entryPrice, event.avg_entry_price, event.avgEntryPrice) || '0',
      markPrice: firstString(event.mark_price, event.markPrice, event.index_price, event.indexPrice) || '0',
      unrealizedPnl: firstString(event.unrealized_pnl, event.unrealizedPnl, event.pnl) || '0',
      leverage: firstString(event.leverage) || this.leverageFromMarginFraction(event.initial_margin_fraction ?? event.initialMarginFraction) || '1',
      marginType: this.normalizeMarginType(event.margin_mode ?? event.marginMode ?? event.margin_type ?? event.marginType),
    };
  }

  private resolveTerminalWaiter(clientOrderIndex: string, status: LighterOrderStatus, result: OrderResult): void {
    if (!this.isTerminalStatus(status)) return;

    const waiter = this.fillWaiters.get(clientOrderIndex);
    if (!waiter) {
      logger.debug(`[Reconciler] terminal status ${status} for ${clientOrderIndex} but no waiter`);
      return;
    }

    if (result.raw?.symbol && String(result.raw.symbol) !== waiter.symbol) {
      logger.warn(`[Reconciler] symbol mismatch for ${clientOrderIndex}: event=${result.raw.symbol} vs waiter=${waiter.symbol}`);
      return;
    }

    logger.info(`[Reconciler] resolving waiter for ${clientOrderIndex} with status=${status}`);
    if (waiter.timer) clearTimeout(waiter.timer);
    this.fillWaiters.delete(clientOrderIndex);

    if (status === 'FILLED') {
      waiter.resolve(result);
      return;
    }

    waiter.reject(new Error(`Lighter order ${clientOrderIndex} ended with status: ${status.toLowerCase()}`));
  }

  private normalizeClientOrderIndex(event: any): string {
    const value = event.client_order_index ?? event.clientOrderIndex;
    return value === undefined || value === null ? '' : String(value);
  }

  private normalizeOrderStatus(status: LighterOrderStatus): string {
    if (status === 'FILLED') return 'filled';
    if (this.isCancelledStatus(status)) return 'cancelled';
    if (status === 'REJECTED') return 'rejected';
    return 'open';
  }

  private isTerminalStatus(status: LighterOrderStatus): boolean {
    return status === 'FILLED' || this.isCancelledStatus(status) || status === 'REJECTED';
  }

  private isCancelledStatus(status: LighterOrderStatus): boolean {
    return status === 'CANCELLED' || status === 'CANCELED' || status.startsWith('CANCELLED') || status.startsWith('CANCELED');
  }

  private normalizeMarginType(value: any): 'cross' | 'isolated' {
    if (value === 1) return 'isolated';
    return String(value || '').toLowerCase() === 'isolated' ? 'isolated' : 'cross';
  }

  private rejectExistingWaiter(clientOrderIndex: string): void {
    const existing = this.fillWaiters.get(clientOrderIndex);
    if (!existing) return;

    if (existing.timer) clearTimeout(existing.timer);
    this.fillWaiters.delete(clientOrderIndex);
    existing.reject(new Error(`Lighter already waiting for order fill: ${clientOrderIndex}`));
  }

  private normalizePositionSide(event: any): 'long' | 'short' | '' {
    const side = String(event.side || event.position_side || event.positionSide || '').toLowerCase();
    if (side === 'short' || side === 'sell') return 'short';
    if (side === 'long' || side === 'buy') return 'long';
    const sign = Number(event.sign);
    if (Number.isFinite(sign) && sign < 0) return 'short';
    if (Number.isFinite(sign) && sign > 0) return 'long';
    return '';
  }

  private leverageFromMarginFraction(value: any): string | undefined {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return undefined;
    return Number((1 / n).toFixed(8)).toString();
  }

  private async finalizeJournalFromOrderEvent(clientOrderIndex: string, status: LighterOrderStatus): Promise<void> {
    if (!this.isTerminalStatus(status) || typeof this.deps.journalModel.findOne !== 'function') return;
    const journal = await this.deps.journalModel.findOne({
      where: {
        clientOrderIndex,
        status: { [Op.in]: ['ACCEPTED', 'SENT', 'UNKNOWN'] },
      },
    });
    if (!journal) return;
    journal.status = status === 'REJECTED' ? 'REJECTED' : 'CONFIRMED';
    journal.error = status === 'REJECTED' ? `order rejected: ${clientOrderIndex}` : null;
    journal.confirmedAt = new Date();
    await journal.save();
  }

  private async finalizeJournalFromTxEvent(event: any): Promise<void> {
    if (typeof this.deps.journalModel.findOne !== 'function') return;
    const nonce = firstString(event.nonce, event.tx_nonce, event.txNonce);
    const clientOrderIndex = firstString(event.client_order_index, event.clientOrderIndex);
    if (!nonce && !clientOrderIndex) return;

    const status = this.normalizeTxStatus(event);
    if (!status) return;

    const where: any = {
      status: { [Op.in]: ['ACCEPTED', 'SENT', 'UNKNOWN'] },
    };
    if (nonce) where.nonce = nonce;
    if (clientOrderIndex) where.clientOrderIndex = clientOrderIndex;

    const journal = await this.deps.journalModel.findOne({ where });
    if (!journal) return;

    journal.status = status;
    journal.error = status === 'REJECTED' ? firstString(event.error, event.message, event.reason) || 'tx rejected' : null;
    journal.confirmedAt = new Date();
    await journal.save();
  }

  private normalizeTxStatus(event: any): 'CONFIRMED' | 'REJECTED' | null {
    const rawStatus = String(event.status ?? event.tx_status ?? event.txStatus ?? '').toLowerCase();
    if (['confirmed', 'success', 'succeeded', 'executed', 'complete', 'completed'].includes(rawStatus)) return 'CONFIRMED';
    if (['rejected', 'failed', 'failure', 'cancelled', 'canceled'].includes(rawStatus)) return 'REJECTED';

    // Integer status codes (Lighter EnrichedTx.status)
    // 0 = pending/queued, 1 = executed, 2 = committed/verified
    const status = Number(event.status);
    if (Number.isFinite(status)) {
      if (status >= 1) return 'CONFIRMED';
      if (status < 0) return 'REJECTED';
    }

    // API-level code (from wrapper response or error)
    const code = Number(event.code);
    if (Number.isFinite(code) && code !== status) {
      if (code === 200) return 'CONFIRMED';
      if (code < 0 || code >= 3) return 'REJECTED';
    }

    // If tx has an executed_at timestamp, it was confirmed
    if (event.executed_at && Number(event.executed_at) > 0) return 'CONFIRMED';

    return null;
  }
}

export default LighterStateReconciler;
