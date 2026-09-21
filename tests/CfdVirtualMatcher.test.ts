import { CfdVirtualMatcher } from '../src/services/virtualMatching';
import { CfdVirtualOrder, CfdFillEvent } from '../src/services/virtualMatching';
import type { GateTradFiMarketDataStream } from '../src/services/marketData/GateTradFiMarketDataStream';

/** 假行情流：手动推 tick，无需真实 WS */
class FakeStream {
  latest = new Map<string, any>();
  private listeners = new Map<string, Set<(tick: any) => void>>();
  subscribed: string[] = [];

  onTick(symbol: string, cb: (tick: any) => void): () => void {
    let set = this.listeners.get(symbol);
    if (!set) {
      set = new Set();
      this.listeners.set(symbol, set);
    }
    set.add(cb);
    return () => {
      set!.delete(cb);
      if (set!.size === 0) this.listeners.delete(symbol);
    };
  }

  subscribe(symbol: string): void {
    this.subscribed.push(symbol);
  }

  getLatestTick(symbol: string): any {
    return this.latest.get(symbol) ?? null;
  }

  emitTick(symbol: string, lastPrice: string): void {
    const tick = { symbol, lastPrice, receivedAt: new Date(), source: 'gate' as const };
    this.latest.set(symbol, tick);
    for (const cb of this.listeners.get(symbol) ?? []) {
      cb(tick);
    }
  }
}

const SYM = 'XAU_USDT';

function entryOrder(id: string, side: 'buy' | 'sell', type: 'market' | 'limit', price?: string): CfdVirtualOrder {
  return { id, symbol: SYM, side, type, role: 'entry', price, amount: '1', createdAt: Date.now() };
}

function protectionOrder(id: string, role: 'sl' | 'tp', parentId: string, price: string): CfdVirtualOrder {
  return { id, symbol: SYM, side: 'sell', type: 'limit', role, price, amount: '1', parentId, createdAt: Date.now() };
}

describe('CfdVirtualMatcher', () => {
  let stream: FakeStream;
  let matcher: CfdVirtualMatcher;
  let fills: CfdFillEvent[];

  const createMatcher = () => {
    matcher = new CfdVirtualMatcher(stream as unknown as GateTradFiMarketDataStream, {
      multiplierBySymbol: () => 1,
    });
    fills = [];
    matcher.onFill(e => fills.push(e));
    return matcher;
  };

  beforeEach(() => {
    stream = new FakeStream();
    createMatcher();
  });

  it('fills a limit buy entry when price falls to the limit', () => {
    matcher.registerOrder(entryOrder('o1', 'buy', 'limit', '2900'));
    stream.emitTick(SYM, '2901');
    expect(fills).toHaveLength(0); // 未到价

    stream.emitTick(SYM, '2900');
    expect(fills).toHaveLength(1);
    expect(fills[0]).toMatchObject({ orderId: 'o1', role: 'entry', symbol: SYM, fillPrice: '2900', realizedPnl: 0 });
    expect(matcher.getPosition(SYM)).toEqual({ size: 1, entryPrice: 2900 });
  });

  it('fills a market entry immediately at latest price', () => {
    stream.latest.set(SYM, { symbol: SYM, lastPrice: '2905', receivedAt: new Date(), source: 'gate' });
    matcher.registerOrder(entryOrder('o1', 'buy', 'market'));

    expect(fills).toHaveLength(1);
    expect(fills[0]).toMatchObject({ orderId: 'o1', role: 'entry', fillPrice: '2905' });
    expect(matcher.getPosition(SYM)).toEqual({ size: 1, entryPrice: 2905 });
  });

  it('triggers SL for a long position and computes realized PnL', () => {
    stream.latest.set(SYM, { symbol: SYM, lastPrice: '2905', receivedAt: new Date(), source: 'gate' });
    matcher.registerOrder(entryOrder('o1', 'buy', 'market'));
    matcher.registerOrder(protectionOrder('o1-sl', 'sl', 'o1', '2880'));

    stream.emitTick(SYM, '2881');
    expect(fills).toHaveLength(1); // 仅入场成交

    stream.emitTick(SYM, '2880');
    expect(fills).toHaveLength(2);
    expect(fills[1]).toMatchObject({ orderId: 'o1-sl', role: 'sl', parentId: 'o1', fillPrice: '2880' });
    expect(fills[1].realizedPnl).toBeCloseTo((2880 - 2905) * 1, 6); // -25
    expect(matcher.getPosition(SYM).size).toBe(0);
  });

  it('triggers TP for a long position with positive PnL', () => {
    stream.latest.set(SYM, { symbol: SYM, lastPrice: '2905', receivedAt: new Date(), source: 'gate' });
    matcher.registerOrder(entryOrder('o1', 'buy', 'market'));
    matcher.registerOrder(protectionOrder('o1-tp', 'tp', 'o1', '2950'));

    stream.emitTick(SYM, '2950');
    expect(fills).toHaveLength(2);
    expect(fills[1]).toMatchObject({ orderId: 'o1-tp', role: 'tp', fillPrice: '2950' });
    expect(fills[1].realizedPnl).toBeCloseTo((2950 - 2905) * 1, 6); // +45
    expect(matcher.getPosition(SYM).size).toBe(0);
  });

  it('does not fill a limit buy above the limit price', () => {
    matcher.registerOrder(entryOrder('o1', 'buy', 'limit', '2900'));
    stream.emitTick(SYM, '2900.5');
    expect(fills).toHaveLength(0);
  });

  it('cancelled orders never fill', () => {
    matcher.registerOrder(entryOrder('o1', 'buy', 'limit', '2900'));
    matcher.cancelOrder('o1');
    stream.emitTick(SYM, '2899');
    expect(fills).toHaveLength(0);
  });

  it('cancels an invalid-direction SL instead of filling', () => {
    stream.latest.set(SYM, { symbol: SYM, lastPrice: '2905', receivedAt: new Date(), source: 'gate' });
    matcher.registerOrder(entryOrder('o1', 'sell', 'market')); // 空仓
    // 空仓的 SL 平仓方向应为 buy，这里错误注册为 sell → 方向无效
    matcher.registerOrder({ ...protectionOrder('o1-sl', 'sl', 'o1', '2920'), side: 'sell' });

    stream.emitTick(SYM, '2921');
    expect(fills).toHaveLength(1); // 仅入场成交
    expect(matcher.getOrder('o1-sl')?.status).toBe('cancelled');
  });

  it('shares one subscription per symbol across orders', () => {
    matcher.registerOrder(entryOrder('o1', 'buy', 'limit', '2900'));
    matcher.registerOrder(entryOrder('o2', 'sell', 'limit', '3000'));
    // 同一品种只订阅一次
    const subscribedCount = stream.subscribed.filter(s => s === SYM).length;
    expect(subscribedCount).toBe(1);
  });
});
