import { VirtualStateStore } from './VirtualStateStore';

export class VirtualMatchingEngine {
  constructor(
    private store: VirtualStateStore,
    private options: { exchangeInstanceId: string; multiplierBySymbol: (symbol: string) => number },
  ) {}

  shouldFillLimit(order: any, lastPrice: number): boolean {
    const price = Number(order.price);
    if (!Number.isFinite(price) || price <= 0) return false;
    if (order.side === 'buy') return lastPrice <= price;
    if (order.side === 'sell') return lastPrice >= price;
    return false;
  }

  shouldTriggerProtection(order: any, lastPrice: number): boolean {
    const parentSide = order.parentSide || (order.side === 'sell' ? 'buy' : 'sell');
    const trigger = Number(order.triggerPrice || order.price);
    if (!Number.isFinite(trigger) || trigger <= 0) return false;
    if (order.orderRole === 'sl') return parentSide === 'buy' ? lastPrice <= trigger : lastPrice >= trigger;
    if (order.orderRole === 'tp') return parentSide === 'buy' ? lastPrice >= trigger : lastPrice <= trigger;
    return false;
  }

  async fillOrder(order: any, fillPrice: string): Promise<{ realizedPnl: number; filled: boolean }> {
    if (order.side !== 'buy' && order.side !== 'sell') throw new Error('Invalid order side');

    const rawAmount = Number(order.amount);
    if (!Number.isFinite(rawAmount) || rawAmount <= 0) throw new Error('Invalid order amount');
    const amount = rawAmount;

    const price = Number(fillPrice);
    if (!Number.isFinite(price) || price <= 0) throw new Error('Invalid fill price');

    const multiplier = this.options.multiplierBySymbol(order.symbol);
    if (!Number.isFinite(multiplier) || multiplier <= 0) throw new Error('Invalid contract multiplier');

    const position = await this.store.getPosition(order.symbol);
    const currentSize = Number(position?.size || '0');
    const currentEntry = Number(position?.entryPrice || '0');
    if (!Number.isFinite(currentSize)) throw new Error('Invalid current position size');
    if (!Number.isFinite(currentEntry)) throw new Error('Invalid current entry price');

    const signedAmount = order.side === 'buy' ? amount : -amount;

    let nextSize = currentSize;
    let nextEntry = currentEntry;
    let realizedPnl = 0;
    let filledAmount = amount;

    if (!order.reduceOnly) {
      const sameDirection = currentSize === 0 || Math.sign(currentSize) === Math.sign(signedAmount);
      if (sameDirection) {
        const totalAbs = Math.abs(currentSize) + amount;
        nextEntry = totalAbs > 0 ? (Math.abs(currentSize) * currentEntry + amount * price) / totalAbs : 0;
        nextSize = currentSize + signedAmount;
      } else {
        const closingAmount = Math.min(Math.abs(currentSize), amount);
        realizedPnl = this.calculateRealizedPnl(currentSize, currentEntry, price, closingAmount, multiplier);
        nextSize = currentSize + signedAmount;
        if (nextSize === 0) {
          nextEntry = 0;
        } else if (Math.sign(nextSize) === Math.sign(currentSize)) {
          nextEntry = currentEntry;
        } else {
          nextEntry = price;
        }
      }
    } else {
      if (currentSize === 0 || Math.sign(currentSize) === Math.sign(signedAmount)) {
        await this.store.cancelInvalidReduceOnlyOrder(order, 'Invalid reduce-only direction');
        return { realizedPnl: 0, filled: false };
      }
      const closingAmount = Math.min(Math.abs(currentSize), amount);
      realizedPnl = this.calculateRealizedPnl(currentSize, currentEntry, price, closingAmount, multiplier);
      nextSize = Math.sign(currentSize) * (Math.abs(currentSize) - closingAmount);
      nextEntry = nextSize === 0 ? 0 : currentEntry;
      filledAmount = closingAmount;
    }

    const positionPayload = {
      symbol: order.symbol,
      size: this.normalizeNumber(nextSize),
      entryPrice: this.normalizeNumber(nextEntry),
      markPrice: this.normalizeNumber(price),
    };
    const tradePayload = {
      tradeId: `vt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      virtualOrderId: order.virtualOrderId,
      symbol: order.symbol,
      side: order.side,
      price: this.normalizeNumber(price),
      amount: this.normalizeNumber(filledAmount),
      role: order.type === 'limit' ? 'maker' : 'taker',
      realizedPnl: this.normalizeNumber(realizedPnl),
      text: order.text || null,
    };

    const result = await this.store.recordFill({
      position: positionPayload,
      order,
      fillPrice: this.normalizeNumber(price),
      filledAmount: this.normalizeNumber(filledAmount),
      trade: tradePayload,
      realizedPnl,
    });

    return { realizedPnl, filled: result?.filled !== false };
  }

  private calculateRealizedPnl(currentSize: number, currentEntry: number, price: number, closingAmount: number, multiplier: number): number {
    if (currentSize > 0) return (price - currentEntry) * closingAmount * multiplier;
    if (currentSize < 0) return (currentEntry - price) * closingAmount * multiplier;
    return 0;
  }

  private normalizeNumber(value: number): string {
    return Number(value.toFixed(12)).toString();
  }
}
