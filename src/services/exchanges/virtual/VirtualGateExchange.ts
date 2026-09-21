import {
  AccountBalance,
  Candle,
  ExchangeConfig,
  IExchange,
  MarketInfo,
  OrderParams,
  OrderResult,
  Position,
  Ticker,
  Trade,
} from '../IExchange';
import fs from 'fs';
import path from 'path';
import { MarketDataHub } from '../../marketData/MarketDataHub';
import { MarketTick } from '../../marketData/types';
import { VirtualOrder, VirtualPosition, VirtualTrade, PendingProtection } from '../../../models';
import { VirtualMatchingEngine } from './VirtualMatchingEngine';
import { VirtualStateStore } from './VirtualStateStore';
import MarkPriceCache from './MarkPriceCache';
import { normalizeSymbolCase } from '../../../utils/normalizeSymbol';
import { nowOrSim, simTimeMs } from '../../../backtest/Clock';

type VirtualGateConfig = ExchangeConfig & {
  initialBalance?: string;
  maxTickAgeMs?: number;
};

type FillWaiter = {
  resolve: (order: OrderResult) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout | null;
};

export type ProtectionFillInfo = {
  virtualOrderId: string;
  symbol: string;
  side: 'buy' | 'sell';
  orderRole: 'sl' | 'tp' | 'close';
  fillPrice: string;
  filledAmount: string;
  realizedPnl: number;
  text: string | null;
  exchangeInstanceId: string;
  timestamp: Date;
};

export class VirtualGateExchange implements IExchange {
  public id: string;
  public name: string;

  private readonly initialBalance: string;
  private readonly maxTickAgeMs: number;
  private readonly store: VirtualStateStore;
  private readonly engine: VirtualMatchingEngine;
  private readonly fillWaiters = new Map<string, FillWaiter[]>();
  private readonly subscriptions = new Map<string, () => Promise<void> | void>();
  private readonly tickQueues = new Map<string, Promise<void>>();
  protected marketsCache: MarketInfo[] | null = null;
  private marketMapCache: Map<string, MarketInfo> | null = null;
  private stopped = false;

  constructor(
    config: VirtualGateConfig,
    private readonly hub: MarketDataHub,
    private readonly onProtectionFill?: (info: ProtectionFillInfo) => Promise<void>,
  ) {
    this.id = config.id;
    this.name = config.name;
    this.initialBalance = config.initialBalance ?? '10000';
    this.maxTickAgeMs = config.maxTickAgeMs ?? 10000;
    this.store = new VirtualStateStore(this.id);
    this.engine = new VirtualMatchingEngine(this.store, {
      exchangeInstanceId: this.id,
      multiplierBySymbol: this.getMultiplier.bind(this),
    });
  }

  async start(): Promise<void> {
    this.stopped = false;
    await this.store.getOrCreateAccount(this.initialBalance, 'USDT');
    await this.hub.start();
    const orders = await this.store.findOpenOrders();
    const positions = await VirtualPosition.findAll({ where: { exchangeInstanceId: this.id } });
    const symbols = new Set([
      ...orders.map((order: any) => order.symbol).filter(Boolean),
      ...positions
        .filter((position: any) => Number(position.size) !== 0)
        .map((position: any) => position.symbol)
        .filter(Boolean),
    ]);
    for (const symbol of symbols) {
      this.subscribeSymbol(symbol);
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    const cleanups = Array.from(this.subscriptions.values());
    this.subscriptions.clear();
    this.tickQueues.clear();
    await Promise.all(cleanups.map(cleanup => cleanup()));
  }

  async placeOrder(params: OrderParams): Promise<OrderResult> {
    const type = params.type ?? 'market';
    const virtualOrderId = this.nextOrderId();
    const order = await this.store.createOrder({
      virtualOrderId,
      symbol: params.symbol,
      side: params.side,
      type,
      orderRole: params.reduceOnly ? 'tp' : 'entry',
      parentSide: params.reduceOnly ? (params.side === 'buy' ? 'sell' : 'buy') : null,
      price: params.price ?? null,
      amount: params.amount,
      status: 'open',
      reduceOnly: params.reduceOnly ?? false,
      postOnly: params.postOnly ?? false,
      triggerPrice: params.triggerPrice ?? null,
      triggerCondition: params.triggerCondition ?? null,
      text: params.text ?? null,
      raw: JSON.stringify(params),
    });

    if (params.stopLoss || params.takeProfit) {
      try {
        await PendingProtection.create({
          orderId: virtualOrderId,
          symbol: params.symbol,
          side: params.side,
          stopLoss: params.stopLoss || null,
          takeProfit: params.takeProfit || null,
          tpOrdersJson: params.tpOrders ? JSON.stringify(params.tpOrders) : null,
        } as any);
      } catch (dbErr) {
        console.error(`[VirtualGateExchange] Failed to persist pending protection for ${virtualOrderId}`, dbErr);
      }
    }

    if (type === 'market') {
      const tick = this.assertFreshTick(params.symbol);
      const fill = await this.engine.fillOrder(order, tick.lastPrice);
      this.subscribeSymbol(params.symbol);
      if (fill.filled) {
        await this.resolveFillListener(virtualOrderId, params.symbol);
        await this.store.cancelStaleReduceOnlyOrders(normalizeSymbolCase(params.symbol));
        await this.emitProtectionFill(order, tick.lastPrice, tick.lastPrice, fill.realizedPnl);
      }
      return { id: virtualOrderId, status: 'filled', amount: params.amount, price: tick.lastPrice, raw: order.raw };
    }

    const tick = this.hub.getLatestTick(normalizeSymbolCase(params.symbol));
    if (tick && this.isFreshTick(tick)) {
      const numericPrice = Number(tick.lastPrice);
      const shouldFill = Number.isFinite(numericPrice) && numericPrice > 0 && (
        order.orderRole === 'entry' || order.orderRole === 'close'
          ? this.engine.shouldFillLimit(order, numericPrice)
          : this.engine.shouldTriggerProtection(order, numericPrice)
      );
      if (shouldFill) {
        const fillPrice = order.triggerPrice ?? order.price ?? tick.lastPrice;
        console.log(`[VirtualGateExchange] Immediate limit fill: order=${virtualOrderId} type=${type} price=${params.price} lastPrice=${tick.lastPrice} fillPrice=${fillPrice}`);
        const fill = await this.engine.fillOrder(order, fillPrice);
        this.subscribeSymbol(params.symbol);
        if (fill.filled) {
          await this.resolveFillListener(virtualOrderId, params.symbol);
          await this.store.cancelStaleReduceOnlyOrders(normalizeSymbolCase(params.symbol));
          return this.toOrderResult(await this.findOrder(virtualOrderId, params.symbol));
        }
      }
    }

    this.subscribeSymbol(params.symbol);
    return this.toOrderResult(order);
  }

  async amendOrder(orderId: string, symbol: string, price?: string, amount?: string): Promise<OrderResult> {
    const order = await this.findOrder(orderId, symbol);
    if (order.status !== 'open') throw new Error(`Order ${orderId} is not open`);

    await order.update({
      ...(price !== undefined ? { price } : {}),
      ...(amount !== undefined ? { amount } : {}),
    });
    return this.toOrderResult(order);
  }

  async cancelOrder(orderId: string, symbol: string): Promise<boolean> {
    const order = await this.findOrder(orderId, symbol);
    if (order.status !== 'open' || !this.isRegularOpenOrder(order)) return false;

    await order.update({ status: 'cancelled' });
    // 唤醒可能还在等待成交的 waitForOrderFill 调用方（订单已撤销，不再可能成交）
    await this.resolveFillListener(orderId, symbol);
    return true;
  }

  async cancelPriceOrder(orderId: string, symbol: string): Promise<boolean> {
    const order = await this.findOrder(orderId, symbol);
    if (order.status !== 'open' || !this.isPriceOrder(order)) return false;

    await order.update({ status: 'cancelled' });
    await this.resolveFillListener(orderId, symbol);
    return true;
  }

  /**
   * 等待所有 per-symbol tick 处理队列排空（含其级联的撮合/回调）。
   * 回测引擎在注入一批 tick 后调用，确保进入下一根 K 线前撮合全部完成。
   */
  async drainTicks(): Promise<void> {
    while (this.tickQueues.size > 0) {
      const queues = Array.from(this.tickQueues.values());
      await Promise.all(queues);
    }
  }

  async updateStopLoss(symbol: string, side: 'buy' | 'sell', price: string, text = 'sl-trigger', amount?: string): Promise<string | null> {
    const resolvedAmount = amount ?? await this.getStopLossAmount(symbol, side);
    if (!resolvedAmount) return null;

    await this.cancelExistingStopLossOrders(symbol, side, text);

    const virtualOrderId = this.nextOrderId();
    const closeSide = side === 'buy' ? 'sell' : 'buy';
    await this.store.createOrder({
      virtualOrderId,
      symbol,
      side: closeSide,
      type: 'limit',
      orderRole: 'sl',
      parentSide: side,
      price,
      amount: resolvedAmount,
      status: 'open',
      reduceOnly: true,
      postOnly: false,
      triggerPrice: price,
      triggerCondition: side === 'buy' ? 'le' : 'ge',
      text,
      raw: JSON.stringify({ symbol, side, price, text, amount: resolvedAmount }),
    });
    this.subscribeSymbol(symbol);
    return virtualOrderId;
  }

  async closePosition(symbol: string, _side: 'buy' | 'sell', price?: string, amount?: string, _text?: string): Promise<boolean> {
    const position = await this.store.getPosition(symbol);
    const size = Number(position?.size ?? '0');
    if (!Number.isFinite(size) || size === 0) return true;

    const closeAmount = amount ?? Math.abs(size).toString();
    const closeSide = size > 0 ? 'sell' : 'buy';
    const fillPrice = price ?? this.assertFreshTick(symbol).lastPrice;
    const order = await this.store.createOrder({
      virtualOrderId: this.nextOrderId(),
      symbol,
      side: closeSide,
      type: 'market',
      orderRole: 'close',
      price: price ?? null,
      amount: closeAmount,
      status: 'open',
      reduceOnly: true,
      postOnly: false,
      triggerPrice: null,
      triggerCondition: null,
      text: 'close-position',
      raw: JSON.stringify({ symbol, price, amount }),
    });
    const fill = await this.engine.fillOrder(order, fillPrice);
    if (fill.filled) {
      await this.resolveFillListener(order.virtualOrderId, symbol);
      await this.store.cancelStaleReduceOnlyOrders(normalizeSymbolCase(symbol));
      await this.emitProtectionFill(order, fillPrice, fillPrice, fill.realizedPnl);
    }
    return true;
  }

  async getBalance(currency = 'USDT'): Promise<AccountBalance> {
    const account = await this.store.getOrCreateAccount(this.initialBalance, currency);

    let unrealizedPnl = 0;
    const positions = await VirtualPosition.findAll({ where: { exchangeInstanceId: this.id } });
    for (const pos of positions) {
      const size = Number(pos.size || '0');
      if (!Number.isFinite(size) || size === 0) continue;
      const entry = Number(pos.entryPrice || '0');
      const mark = Number(pos.markPrice || '0');
      if (!Number.isFinite(entry) || !Number.isFinite(mark)) continue;
      const multiplier = this.getMultiplier(pos.symbol);
      unrealizedPnl += (mark - entry) * size * multiplier;
    }

    const total = parseFloat(account.availableBalance || '0') + unrealizedPnl;
    return {
      currency: account.currency,
      available: account.availableBalance,
      total: total.toFixed(4),
      unrealizedPnl: unrealizedPnl.toFixed(4),
    };
  }

  async getPosition(symbol: string): Promise<Position | null> {
    const position = await this.store.getPosition(symbol);
    if (!position || Number(position.size) === 0) return null;
    return this.toPosition(position);
  }

  async getPositions(): Promise<Position[]> {
    const rows = await VirtualPosition.findAll({ where: { exchangeInstanceId: this.id } });
    return rows.filter((row: any) => Number(row.size) !== 0).map(row => this.toPosition(row));
  }

  async getOrder(orderId: string, symbol: string): Promise<OrderResult> {
    return this.toOrderResult(await this.findOrder(orderId, symbol));
  }

  async getOpenOrders(symbol?: string): Promise<OrderResult[]> {
    const rows = await this.store.findOpenOrders(symbol);
    return rows
      .filter((row: any) => this.isRegularOpenOrder(row))
      .map(row => this.toOrderResult(row));
  }

  async getFinishedOrders(symbol: string, limit = 50): Promise<OrderResult[]> {
    const rows = await this.store.findFinishedOrders(symbol, limit);
    return rows.map(row => this.toOrderResult(row));
  }

  async getPriceOrders(symbol?: string): Promise<OrderResult[]> {
    const rows = await this.store.findOpenOrders(symbol);
    return rows
      .filter((row: any) => this.isPriceOrder(row))
      .map(row => this.toOrderResult(row));
  }

  async waitForOrderFill(orderId: string, symbol: string, timeoutMs = 60000): Promise<OrderResult> {
    const order = await this.findOrder(orderId, symbol);
    if (order.status === 'filled') return this.toOrderResult(order);

    return new Promise((resolve, reject) => {
      const waiter: FillWaiter = { resolve, reject, timeout: null };
      if (timeoutMs > 0) {
        waiter.timeout = setTimeout(() => {
          this.removeWaiter(orderId, waiter);
          reject(new Error(`Timed out waiting for order ${orderId} fill`));
        }, timeoutMs);
      }
      const waiters = this.fillWaiters.get(orderId) ?? [];
      waiters.push(waiter);
      this.fillWaiters.set(orderId, waiters);
    });
  }

  async getTradeHistory(symbol: string, limit = 50): Promise<Trade[]> {
    const rows = await VirtualTrade.findAll({
      where: { exchangeInstanceId: this.id, symbol },
      limit,
      order: [['executedAt', 'DESC']],
    });
    return rows.map((row: any) => ({
      id: row.tradeId,
      orderId: row.virtualOrderId,
      symbol: row.symbol,
      side: row.side,
      price: row.price,
      amount: row.amount,
      role: row.role,
      time: row.executedAt.getTime(),
      text: row.text ?? undefined,
      fee: '0',
      feeCurrency: 'USDT',
    }));
  }

  async getMarkets(): Promise<MarketInfo[]> {
    return this.getMarketList();
  }

  async getTicker(symbol: string): Promise<Ticker> {
    const normalizedSymbol = normalizeSymbolCase(symbol);
    const latestTick = this.hub.getLatestTick(normalizedSymbol);
    if (latestTick && this.isFreshTick(latestTick)) {
      return this.hub.getTicker(normalizedSymbol);
    }

    // 回测子进程：tick 只由回测引擎在 K 线推进时注入，引擎此刻正阻塞等待消息处理完成，
    // 等待新 tick 会造成 10s 级卡顿甚至死锁 —— 直接返回最新快照（无 tick 时为 hub 的零价空态）。
    if (simTimeMs() !== null) {
      this.subscribeSymbol(normalizedSymbol);
      return this.hub.getTicker(normalizedSymbol);
    }

    this.subscribeSymbol(normalizedSymbol);
    const tick = await this.waitForFreshTick(normalizedSymbol);
    return this.toTicker(tick);
  }

  async getCandles(_symbol: string, _timeframe: string, _limit?: number): Promise<Candle[]> {
    return [];
  }

  async setLeverage(symbol: string, leverage: string): Promise<boolean> {
    const position = await this.store.getPosition(symbol);
    if (position) await position.update({ leverage });
    return true;
  }

  async setMarginMode(symbol: string, marginMode: 'cross' | 'isolated', leverage?: string): Promise<boolean> {
    const position = await this.store.getPosition(symbol);
    if (position) await position.update({ marginType: marginMode, ...(leverage ? { leverage } : {}) });
    return true;
  }

  async getMarginMode(symbol: string): Promise<{ marginMode: 'cross' | 'isolated'; leverage: string }> {
    const position = await this.store.getPosition(symbol);
    return {
      marginMode: position?.marginType ?? 'cross',
      leverage: position?.leverage ?? '1',
    };
  }

  getWebSocketStats(): any {
    return { isConnected: true, type: 'virtual_gate' };
  }

  private nextOrderId(): string {
    return `vo-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  private getMultiplier(symbol: string): number {
    const market = this.getMarketMap().get(normalizeSymbolCase(symbol));
    const marketMultiplier = Number(market?.multiplier);
    if (Number.isFinite(marketMultiplier) && marketMultiplier > 0) return marketMultiplier;

    const base = symbol.split('_')[0].toUpperCase();
    if (base === 'BTC') return 0.0001;
    if (base === 'ETH') return 0.01;
    return 1;
  }

  private getMarketMap(): Map<string, MarketInfo> {
    if (!this.marketMapCache) {
      this.marketMapCache = new Map(this.getMarketList().map(market => [market.symbol, market]));
    }
    return this.marketMapCache;
  }

  protected getMarketList(): MarketInfo[] {
    if (this.marketsCache) return this.marketsCache;

    const dictPath = path.join(process.cwd(), 'dict', 'gate_contracts.json');
    try {
      const raw = fs.readFileSync(dictPath, 'utf8');
      const contracts = JSON.parse(raw);
      if (!Array.isArray(contracts)) throw new Error('Gate contract dictionary must be an array');

      const markets = contracts
        .filter((contract: any) => this.isSupportedGateUsdtContract(contract))
        .map((contract: any) => this.marketFromGateContract(contract));

      if (markets.length > 0) {
        this.marketsCache = markets;
        return markets;
      }
    } catch (error: any) {
      console.warn(`[VirtualGateExchange] Failed to load Gate contract dictionary from ${dictPath}: ${error?.message ?? error}`);
    }

    this.marketsCache = [
      this.market('BTC_USDT', 'BTC', 'USDT', '0.0001', 1, 0),
      this.market('ETH_USDT', 'ETH', 'USDT', '0.01', 2, 0),
      this.market('SOL_USDT', 'SOL', 'USDT', '1', 3, 0),
    ];
    return this.marketsCache;
  }

  private isSupportedGateUsdtContract(contract: any): boolean {
    const name = typeof contract?.name === 'string' ? normalizeSymbolCase(contract.name) : '';
    return Boolean(name.endsWith('_USDT') && !contract?.in_delisting);
  }

  private marketFromGateContract(contract: any): MarketInfo {
    const symbol = normalizeSymbolCase(contract.name);
    const tickSize = String(contract.order_price_round || contract.mark_price_round || '0.01');
    const pricePrecision = this.precisionFromTickSize(tickSize);
    return this.market(
      symbol,
      symbol.split('_')[0],
      'USDT',
      String(contract.quanto_multiplier || '1'),
      pricePrecision,
      0,
      tickSize,
      contract.leverage_min ? String(contract.leverage_min) : '1',
      contract.leverage_max ? String(contract.leverage_max) : '100',
    );
  }

  private precisionFromTickSize(tickSize: string): number {
    const normalized = tickSize.trim();
    if (!normalized.includes('.')) return 0;
    return normalized.split('.')[1].replace(/0+$/, '').length || normalized.split('.')[1].length;
  }

  private assertFreshTick(symbol: string): MarketTick {
    const tick = this.hub.getLatestTick(symbol);
    if (!tick) throw new Error(`No market price for ${symbol}`);

    if (!this.isFreshTick(tick)) {
      throw new Error(`stale market price for ${symbol}`);
    }
    return tick;
  }

  private waitForFreshTick(symbol: string): Promise<MarketTick> {
    const existingTick = this.hub.getLatestTick(symbol);
    if (existingTick && this.isFreshTick(existingTick)) {
      return Promise.resolve(existingTick);
    }

    return new Promise((resolve, reject) => {
      let cleanup: (() => Promise<void> | void) | null = null;
      const timeout = setTimeout(() => {
        void cleanup?.();
        reject(new Error(`No market price for ${symbol}`));
      }, this.maxTickAgeMs);

      cleanup = this.hub.subscribe(symbol, tick => {
        if (tick.symbol !== symbol || !this.isFreshTick(tick)) return;
        clearTimeout(timeout);
        void cleanup?.();
        resolve(tick);
      });
    });
  }

  private isFreshTick(tick: MarketTick): boolean {
    const lastPrice = Number(tick.lastPrice);
    if (!Number.isFinite(lastPrice) || lastPrice <= 0) return false;
    // 回测子进程：以模拟时钟衡量新鲜度（tick.receivedAt 即 K 线时间），
    // 否则历史 tick 会因真实时间差被误判为过期。
    const now = simTimeMs() ?? Date.now();
    return now - tick.receivedAt.getTime() <= this.maxTickAgeMs;
  }

  private toTicker(tick: MarketTick): Ticker {
    return {
      symbol: tick.symbol,
      lastPrice: tick.lastPrice,
      markPrice: tick.markPrice ?? tick.lastPrice,
      indexPrice: tick.indexPrice ?? tick.markPrice ?? tick.lastPrice,
      fundingRate: '0',
      volume24h: '0',
      change24h: '0',
      raw: {
        receivedAt: tick.receivedAt,
        ageMs: Date.now() - tick.receivedAt.getTime(),
        source: tick.source,
      },
    } as Ticker;
  }

  private subscribeSymbol(symbol: string): void {
    symbol = normalizeSymbolCase(symbol);
    if (this.subscriptions.has(symbol)) return;

    const cleanup = this.hub.subscribe(symbol, tick => {
      if (this.stopped) return;
      this.enqueueTick(tick.symbol, tick.lastPrice);
    });
    this.subscriptions.set(symbol, cleanup);
  }

  private enqueueTick(symbol: string, lastPrice: string): void {
    symbol = normalizeSymbolCase(symbol);
    const previous = this.tickQueues.get(symbol) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(async () => {
        if (this.stopped) return;
        await this.processTick(symbol, lastPrice);
      })
      .catch(error => {
        console.error(`[VirtualGateExchange] processTick failed for ${symbol}`, error);
      })
      .finally(() => {
        if (this.tickQueues.get(symbol) === next) {
          this.tickQueues.delete(symbol);
        }
      });

    this.tickQueues.set(symbol, next);
  }

  private async processTick(symbol: string, lastPrice: string): Promise<void> {
    symbol = normalizeSymbolCase(symbol);
    if (this.stopped) return;

    const numericPrice = Number(lastPrice);
    if (!Number.isFinite(numericPrice) || numericPrice <= 0) return;

    const orders = await this.store.findOpenOrders(symbol);
    for (const order of orders) {
      if (this.stopped) return;

      const shouldFill = order.orderRole === 'entry' || order.orderRole === 'close'
        ? this.engine.shouldFillLimit(order, numericPrice)
        : this.engine.shouldTriggerProtection(order, numericPrice);
      if (!shouldFill || order.status !== 'open') continue;

      const fillPrice = order.triggerPrice ?? order.price ?? lastPrice;

      // Diagnostic: log limit entry fills with price comparison
      if (order.orderRole === 'entry' && order.type === 'limit') {
        const meetsCondition = this.engine.shouldFillLimit(order, numericPrice);
        if (!meetsCondition) {
          console.error(`[VirtualGateExchange] LIMIT FILL ANOMALY: order ${order.virtualOrderId} fillPrice=${fillPrice} lastPrice=${lastPrice} orderPrice=${order.price} shouldFillLimit=${meetsCondition}`);
        } else {
          console.log(`[VirtualGateExchange] Limit entry fill: order=${order.virtualOrderId} lastPrice=${lastPrice} orderPrice=${order.price} fillPrice=${fillPrice}`);
        }
      }

      const fill = await this.engine.fillOrder(order, fillPrice);
      if (fill.filled) {
        await this.resolveFillListener(order.virtualOrderId, symbol);
        await this.store.cancelStaleReduceOnlyOrders(symbol);
        await this.emitProtectionFill(order, fillPrice, lastPrice, fill.realizedPnl);
      }
    }

    MarkPriceCache.set(this.id, symbol, lastPrice);
  }

  private async resolveFillListener(orderId: string, symbol: string): Promise<void> {
    const waiters = this.fillWaiters.get(orderId);
    if (!waiters?.length) return;

    this.fillWaiters.delete(orderId);
    const result = await this.getOrder(orderId, symbol);
    for (const waiter of waiters) {
      if (waiter.timeout) clearTimeout(waiter.timeout);
      waiter.resolve(result);
    }
  }

  private removeWaiter(orderId: string, waiter: FillWaiter): void {
    const waiters = this.fillWaiters.get(orderId);
    if (!waiters) return;

    const next = waiters.filter(item => item !== waiter);
    if (next.length === 0) {
      this.fillWaiters.delete(orderId);
    } else {
      this.fillWaiters.set(orderId, next);
    }
  }

  private async emitProtectionFill(order: any, fillPrice: string, lastPrice: string, realizedPnl: number): Promise<void> {
    if (!this.onProtectionFill) return;
    if (!['sl', 'tp', 'close'].includes(order.orderRole)) return;
    try {
      await this.onProtectionFill({
        virtualOrderId: order.virtualOrderId,
        symbol: order.symbol,
        side: order.side,
        orderRole: order.orderRole,
        fillPrice,
        filledAmount: order.amount,
        realizedPnl,
        text: order.text ?? null,
        exchangeInstanceId: this.id,
        // 回测子进程：保护单成交时间记录为对应 K 线时间；实盘 nowOrSim() === new Date()
        timestamp: nowOrSim(),
      });
    } catch (err) {
      console.error(`[VirtualGateExchange] onProtectionFill callback error for ${order.virtualOrderId}`, err);
    }
  }

  private async findOrder(orderId: string, symbol: string): Promise<any> {
    const order = await VirtualOrder.findOne({
      where: {
        exchangeInstanceId: this.id,
        virtualOrderId: orderId,
        symbol,
      },
    });
    if (!order) throw new Error(`Order ${orderId} not found`);
    return order;
  }

  private toOrderResult(row: any): OrderResult {
    const result: OrderResult = {
      id: row.virtualOrderId,
      status: row.status,
      amount: row.filledAmount ?? row.amount,
      price: row.filledPrice ?? row.price ?? row.triggerPrice ?? undefined,
      symbol: row.symbol,
      side: row.side,
      text: row.text ?? undefined,
      raw: row.raw,
    };

    if (this.isPriceOrder(row)) {
      const rule = row.parentSide === 'buy' ? 2 : 1;
      result.trigger = { rule, price: row.triggerPrice ?? row.price };
      result.initial = {
        contract: row.symbol,
        price: row.price ?? row.triggerPrice,
        size: row.amount,
        text: row.text,
        reduce_only: row.reduceOnly === true,
        is_reduce_only: row.reduceOnly === true,
      };
      result.reduce_only = row.reduceOnly === true;
      result.is_reduce_only = row.reduceOnly === true;
    }

    return result;
  }

  private toPosition(row: any): Position {
    return {
      symbol: row.symbol,
      size: row.size,
      entryPrice: row.entryPrice,
      markPrice: row.markPrice,
      unrealizedPnl: '0',
      leverage: row.leverage ?? '1',
      marginType: row.marginType ?? 'cross',
    };
  }

  protected market(
    symbol: string,
    baseCurrency: string,
    quoteCurrency: string,
    multiplier: string,
    pricePrecision: number,
    amountPrecision: number,
    tickSize = pricePrecision === 1 ? '0.1' : '0.01',
    leverageMin = '1',
    leverageMax = '100',
  ): MarketInfo {
    return {
      symbol,
      baseCurrency,
      quoteCurrency,
      minSize: '1',
      pricePrecision,
      amountPrecision,
      multiplier,
      tickSize,
      leverageMin,
      leverageMax,
    };
  }

  private isRegularOpenOrder(row: any): boolean {
    return ['entry', 'close'].includes(row.orderRole) || (row.orderRole === 'tp' && !row.triggerPrice);
  }

  private isPriceOrder(row: any): boolean {
    return row.orderRole === 'sl' || Boolean(row.triggerPrice);
  }

  private async getStopLossAmount(symbol: string, side: 'buy' | 'sell'): Promise<string | null> {
    const position = await this.store.getPosition(symbol);
    const size = Number(position?.size ?? '0');
    const sameSide = side === 'buy' ? size > 0 : size < 0;
    if (!Number.isFinite(size) || !sameSide) return null;

    const amount = Math.abs(size);
    return amount > 0 ? amount.toString() : null;
  }

  private async cancelExistingStopLossOrders(symbol: string, side: 'buy' | 'sell', text: string): Promise<void> {
    const openOrders = await this.store.findOpenOrders(symbol);
    const isPositionLevel = text.includes('t-sl-pos-');

    const toCancel = openOrders.filter((order: any) => {
      if (order.orderRole !== 'sl') return false;
      if (order.parentSide !== side) return false;
      if (isPositionLevel) return true;
      return String(order.text || '') === text;
    });

    for (const order of toCancel) {
      await order.update({ status: 'cancelled' });
    }
  }
}
