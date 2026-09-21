/**
 * CfdVirtualMatcher — 统一 CFD 虚拟撮合引擎（单例，一个订阅、统一撮合、统一事件）。
 *
 * 设计目标（对应需求）：
 * - 全软件共用【一个】GateTradFiMarketDataStream（单条 tradfi WS 连接），
 *   本引擎是行情订阅的消费方之一，通过 onTick 接收 tick 做撮合；
 * - 撮合逻辑借鉴现有 VirtualMatchingEngine（限价成交方向、SL/TP 触发、均价与盈亏），
 *   但不修改任何现有虚拟交易所代码，订单为内存态、不落库；
 * - 统一事件输出：所有成交经 events.on('fill') 统一发出（CfdFillEvent），
 *   消费方按 orderId/parentId/symbol 归属自己的实例。
 *
 * 使用：
 *   const stream = getCfdMarketDataStream();
 *   const matcher = createCfdVirtualMatcher();
 *   matcher.onFill(e => routeToInstance(e));
 *   matcher.registerOrder({ id: 'o1', symbol: 'XAU_USDT', side: 'buy', type: 'limit',
 *                           role: 'entry', price: '2900', amount: '1', createdAt: Date.now() });
 *   matcher.registerOrder({ id: 'o1-sl', symbol: 'XAU_USDT', side: 'sell', type: 'limit',
 *                           role: 'sl', price: '2880', amount: '1', parentId: 'o1', createdAt: Date.now() });
 */
import { EventEmitter } from 'events';
import { GateTradFiMarketDataStream } from '../marketData/GateTradFiMarketDataStream';
import { normalizeSymbolCase } from '../../utils/normalizeSymbol';
import { CfdVirtualOrder, CfdFillEvent, CfdPositionState } from './types';

export interface CfdVirtualMatcherOptions {
  /** 合约乘数（盈亏/名义换算），默认 1 */
  multiplierBySymbol?: (symbol: string) => number;
}

export class CfdVirtualMatcher {
  /** 统一事件出口：'fill' 事件携带 CfdFillEvent */
  public readonly events = new EventEmitter();

  private readonly orders = new Map<string, CfdVirtualOrder>();
  private readonly positions = new Map<string, CfdPositionState>();
  /** 内部符号 → 行情退订函数（保证同一品种只订阅一次） */
  private readonly unsubs = new Map<string, () => void>();
  private readonly multiplier: (symbol: string) => number;
  private started = false;

  constructor(
    private readonly stream: GateTradFiMarketDataStream,
    options: CfdVirtualMatcherOptions = {},
  ) {
    this.multiplier = options.multiplierBySymbol ?? (() => 1);
  }

  public start(): void {
    if (this.started) return;
    this.started = true;
  }

  public stop(): void {
    this.started = false;
    for (const cleanup of this.unsubs.values()) {
      try { cleanup(); } catch { /* ignore */ }
    }
    this.unsubs.clear();
    this.orders.clear();
    this.positions.clear();
  }

  // ─── 订单管理 ─────────────────────────────────────────────────────────────

  /** 注册订单并参与撮合；market 开仓单立即按最新价成交 */
  public registerOrder(order: CfdVirtualOrder): void {
    if (this.orders.has(order.id)) {
      throw new Error(`CfdVirtualMatcher: duplicate order id ${order.id}`);
    }

    const normalized: CfdVirtualOrder = {
      ...order,
      symbol: normalizeSymbolCase(order.symbol),
      status: 'open',
    };
    this.orders.set(normalized.id, normalized);
    this.ensureSubscribed(normalized.symbol);
    this.started = true;

    // market 开仓：立即按当前最新价成交
    if (normalized.type === 'market' && normalized.role === 'entry') {
      const tick = this.stream.getLatestTick(normalized.symbol);
      const price = tick ? Number(tick.lastPrice) : NaN;
      if (Number.isFinite(price) && price > 0) {
        this.fillOrder(normalized, price, String(price));
      }
    }
  }

  /** 撤销订单（未成交的 open 单置为 cancelled，不再参与撮合） */
  public cancelOrder(id: string): void {
    const order = this.orders.get(id);
    if (!order || order.status !== 'open') return;
    order.status = 'cancelled';
  }

  public getOrder(id: string): CfdVirtualOrder | undefined {
    const order = this.orders.get(id);
    return order ? { ...order } : undefined;
  }

  public listOpenOrders(symbol?: string): CfdVirtualOrder[] {
    const normalized = symbol ? normalizeSymbolCase(symbol) : undefined;
    return Array.from(this.orders.values())
      .filter(o => o.status === 'open' && (!normalized || o.symbol === normalized))
      .map(o => ({ ...o }));
  }

  public getPosition(symbol: string): CfdPositionState {
    return this.positions.get(normalizeSymbolCase(symbol)) ?? { size: 0, entryPrice: 0 };
  }

  /** 统一事件监听便捷方法：返回退订函数 */
  public onFill(listener: (event: CfdFillEvent) => void): () => void {
    this.events.on('fill', listener);
    return () => this.events.off('fill', listener);
  }

  // ─── 撮合 ─────────────────────────────────────────────────────────────────

  private ensureSubscribed(symbol: string): void {
    if (this.unsubs.has(symbol)) return;
    const cleanup = this.stream.onTick(symbol, tick => {
      this.handleTick(symbol, tick.lastPrice);
    });
    this.stream.subscribe(symbol);
    this.unsubs.set(symbol, cleanup);
  }

  private handleTick(symbol: string, lastPrice: string): void {
    if (!this.started) return;
    const price = Number(lastPrice);
    if (!Number.isFinite(price) || price <= 0) return;

    // 快照遍历，避免撮合过程中修改订单导致迭代异常
    const openOrders = Array.from(this.orders.values())
      .filter(o => o.symbol === symbol && o.status === 'open');

    for (const order of openOrders) {
      if (order.role === 'sl' || order.role === 'tp') {
        if (this.shouldTriggerProtection(order, price)) {
          this.fillOrder(order, price, lastPrice);
        }
      } else if (order.type === 'limit') {
        if (this.shouldFillLimit(order, price)) {
          this.fillOrder(order, price, lastPrice);
        }
      }
    }
  }

  /** 限价成交判定（借鉴 VirtualMatchingEngine.shouldFillLimit）：买 ≤ 价，卖 ≥ 价 */
  private shouldFillLimit(order: CfdVirtualOrder, lastPrice: number): boolean {
    const price = Number(order.price);
    if (!Number.isFinite(price) || price <= 0) return false;
    if (order.side === 'buy') return lastPrice <= price;
    if (order.side === 'sell') return lastPrice >= price;
    return false;
  }

  /** SL/TP 触发判定（借鉴 VirtualMatchingEngine.shouldTriggerProtection） */
  private shouldTriggerProtection(order: CfdVirtualOrder, lastPrice: number): boolean {
    const parent = order.parentId ? this.orders.get(order.parentId) : undefined;
    const parentSide = parent?.side ?? (order.side === 'sell' ? 'buy' : 'sell');
    const trigger = Number(order.price);
    if (!Number.isFinite(trigger) || trigger <= 0) return false;
    if (order.role === 'sl') return parentSide === 'buy' ? lastPrice <= trigger : lastPrice >= trigger;
    if (order.role === 'tp') return parentSide === 'buy' ? lastPrice >= trigger : lastPrice <= trigger;
    return false;
  }

  /** 执行成交：更新订单状态与品种仓位，统一发出 fill 事件 */
  private fillOrder(order: CfdVirtualOrder, fillPriceNum: number, lastPrice: string): void {
    if (order.status !== 'open') return;
    order.status = 'filled';

    const amount = Number(order.amount);
    if (!Number.isFinite(amount) || amount <= 0) return;

    const multiplier = this.multiplier(order.symbol);
    if (!Number.isFinite(multiplier) || multiplier <= 0) return;

    const position = this.getPosition(order.symbol);
    let realizedPnl = 0;
    let filledAmount = amount;
    let nextSize: number;

    if (order.role === 'entry') {
      // 开仓：同向加仓（均价更新）或反向（部分对冲，镜像现有引擎语义）
      const signedAmount = order.side === 'buy' ? amount : -amount;
      if (position.size === 0 || Math.sign(position.size) === Math.sign(signedAmount)) {
        const totalAbs = Math.abs(position.size) + amount;
        const nextEntry = totalAbs > 0
          ? (Math.abs(position.size) * position.entryPrice + amount * fillPriceNum) / totalAbs
          : 0;
        nextSize = position.size + signedAmount;
        this.positions.set(order.symbol, { size: nextSize, entryPrice: nextEntry });
      } else {
        const closingAmount = Math.min(Math.abs(position.size), amount);
        realizedPnl = this.calcPnl(position, fillPriceNum, closingAmount, multiplier);
        nextSize = position.size + signedAmount;
        const nextEntry = nextSize === 0
          ? 0
          : (Math.sign(nextSize) === Math.sign(position.size) ? position.entryPrice : fillPriceNum);
        this.positions.set(order.symbol, { size: nextSize, entryPrice: nextEntry });
      }
    } else {
      // 减仓（close/sl/tp）：方向必须与当前仓位相反，否则视为无效减仓
      const signedAmount = order.side === 'buy' ? amount : -amount;
      if (position.size === 0 || Math.sign(position.size) === Math.sign(signedAmount)) {
        order.status = 'cancelled'; // 无效减仓方向：不成交，标记取消（镜像引擎的 cancelInvalidReduceOnly）
        return;
      }
      const closingAmount = Math.min(Math.abs(position.size), amount);
      realizedPnl = this.calcPnl(position, fillPriceNum, closingAmount, multiplier);
      nextSize = Math.sign(position.size) * (Math.abs(position.size) - closingAmount);
      this.positions.set(order.symbol, {
        size: nextSize,
        entryPrice: nextSize === 0 ? 0 : position.entryPrice,
      });
      filledAmount = closingAmount;
    }

    const event: CfdFillEvent = {
      orderId: order.id,
      parentId: order.parentId,
      symbol: order.symbol,
      side: order.side,
      role: order.role,
      fillPrice: this.fmt(fillPriceNum),
      lastPrice,
      amount: this.fmt(filledAmount),
      realizedPnl: Number(realizedPnl.toFixed(12)),
      positionSize: this.fmt(this.positions.get(order.symbol)?.size ?? 0),
      filledAt: new Date(),
    };
    this.events.emit('fill', event);
  }

  private calcPnl(position: CfdPositionState, price: number, closingAmount: number, multiplier: number): number {
    if (position.size > 0) return (price - position.entryPrice) * closingAmount * multiplier;
    if (position.size < 0) return (position.entryPrice - price) * closingAmount * multiplier;
    return 0;
  }

  private fmt(value: number): string {
    return Number(value.toFixed(12)).toString();
  }
}
