/**
 * Mocked GateIO e2e test helpers.
 *
 * Constructs a real GateIOExchange but replaces its internal restClient and ws
 * with in-memory mocks, so all upper-layer code (WSEventRouter,
 * OrderPersistenceHandler, ProtectionPipeline) exercises real code paths
 * without hitting the network.
 */

import { EventEmitter } from 'events';
import { ExchangeConfig } from '../../../src/services/exchanges/IExchange';
import { GateIOExchange } from '../../../src/services/exchanges/GateIOExchange';
import { ProtectionPipeline } from '../../../src/services/ProtectionPipeline';
import { PendingProtection, Order } from '../../../src/models';

// ---------------------------------------------------------------------------
// Types that mirror Gate.io REST / WS payloads
// ---------------------------------------------------------------------------

export interface ErrorConfig {
  message: string;
  status?: number;
  label?: string;
  responseBody?: any;
}

// ---------------------------------------------------------------------------
// 1. MockGateIORestClient
// ---------------------------------------------------------------------------

export class MockGateIORestClient {
  private orders = new Map<string, any>();
  private priceOrders = new Map<string, any>();
  private positions = new Map<string, any>();
  private nextOrderId = 1;
  private nextPriceOrderId = 1;
  private lastPrice = new Map<string, string>();
  private errors = new Map<string, ErrorConfig>();

  /** Inject an error that will be thrown on the next call to `method`. */
  setError(method: string, error: ErrorConfig): void {
    this.errors.set(method, error);
  }

  /** Clear a previously set error. */
  clearError(method: string): void {
    this.errors.delete(method);
  }

  private checkError(method: string): void {
    const err = this.errors.get(method);
    if (err) {
      const error: any = new Error(err.message);
      error.status = err.status;
      error.label = err.label;
      error.responseBody = err.responseBody;
      throw error;
    }
  }

  /** Set the current market price for a contract. */
  setLastPrice(contract: string, price: string): void {
    this.lastPrice.set(contract, price);
    const pos = this.positions.get(contract);
    if (pos) pos.markPrice = price;
  }

  /** Get the current market price for a contract. */
  getLastPrice(contract: string): string {
    return this.lastPrice.get(contract) ?? '0.6000';
  }

  /** Directly set a position in the store (string size like real Gate API). */
  setPosition(
    contract: string,
    size: string,
    entryPrice: string,
    leverage = '10',
    mode = 'single',
  ): void {
    this.positions.set(contract, {
      contract,
      size,
      entryPrice: entryPrice,
      markPrice: this.lastPrice.get(contract) || entryPrice,
      unrealisedPnl: '0',
      leverage,
      mode,
    });
  }

  /** Remove a position from the store. */
  removePosition(contract: string): void {
    this.positions.delete(contract);
  }

  // -- REST API simulation ---------------------------------------------------

  async createOrder(body: any): Promise<any> {
    this.checkError('createOrder');

    const id = String(this.nextOrderId++);
    const now = Math.floor(Date.now() / 1000);
    const isMarket = !body.price || body.price === '0';
    const fillPrice = isMarket ? this.getLastPrice(body.contract) : '0';
    const status = isMarket ? 'finished' : 'open';
    const left = isMarket ? '0' : String(Math.abs(body.size));

    const order: any = {
      id,
      contract: body.contract,
      status,
      size: body.size,
      price: body.price || '0',
      fill_price: fillPrice,   // WS event reads snake_case
      fillPrice,                // REST SDK reads camelCase
      left,
      text: body.text || '',
      is_reduce_only: body.reduce_only || false,
      is_close: false,
      tif: body.tif || (isMarket ? 'ioc' : 'gtc'),
      reduce_only: body.reduce_only || false,
      createTime: now,
      create_time: now,         // WS event reads snake_case
      finish_time: isMarket ? now : 0,
    };

    this.orders.set(id, order);

    // Update position for market fills
    if (isMarket && status === 'finished') {
      this.applyFillToPosition(order, fillPrice);
    }

    return { ...order };
  }

  async amendOrder(orderId: string, body: any): Promise<any> {
    this.checkError('amendOrder');
    const order = this.orders.get(orderId);
    if (!order) {
      const error: any = new Error('Order not found');
      error.status = 404;
      error.label = 'AUTO_ORDER_NOT_FOUND';
      throw error;
    }
    if (body.price) order.price = body.price;
    if (body.size !== undefined) {
      order.size = body.size;
      order.left = String(Math.abs(body.size));
    }
    return { ...order };
  }

  async cancelOrder(orderId: string, _contract: string): Promise<any> {
    this.checkError('cancelOrder');
    const order = this.orders.get(orderId);
    if (!order) {
      const error: any = new Error('Order not found');
      error.status = 404;
      error.label = 'AUTO_ORDER_NOT_FOUND';
      throw error;
    }
    order.status = 'cancelled';
    order.left = String(Math.abs(order.size));
    order.finish_time = Math.floor(Date.now() / 1000);
    return { id: orderId, status: 'cancelled' };
  }

  async createPriceOrder(body: any): Promise<any> {
    this.checkError('createPriceOrder');

    const id = `vo-${this.nextPriceOrderId++}`;
    const priceOrder: any = {
      id,
      initial: { ...body.initial },
      trigger: { ...body.trigger },
      text: body.initial?.text || '',
    };
    this.priceOrders.set(id, priceOrder);
    return { id, ...priceOrder };
  }

  async cancelPriceOrder(orderId: string): Promise<any> {
    this.checkError('cancelPriceOrder');
    this.priceOrders.delete(orderId);
    return { id: orderId };
  }

  async cancelAllPriceOrders(contract: string): Promise<any> {
    this.checkError('cancelAllPriceOrders');
    for (const [id, po] of this.priceOrders.entries()) {
      if (po.initial.contract === contract) {
        this.priceOrders.delete(id);
      }
    }
    return [];
  }

  async getOrder(_contract: string, orderId: string): Promise<any> {
    this.checkError('getOrder');
    const order = this.orders.get(orderId);
    if (!order) {
      const error: any = new Error('Order not found');
      error.status = 404;
      throw error;
    }
    return { ...order };
  }

  async listOrders(options: { contract?: string; status: string; limit?: number }): Promise<any[]> {
    this.checkError('listOrders');
    let results = Array.from(this.orders.values());
    if (options.status) {
      results = results.filter(o => o.status === options.status);
    }
    if (options.contract) {
      results = results.filter(o => o.contract === options.contract);
    }
    if (options.limit) {
      results = results.slice(0, options.limit);
    }
    return results.map(o => ({ ...o }));
  }

  async listPriceOrders(options: { status: string; contract?: string }): Promise<any[]> {
    this.checkError('listPriceOrders');
    let results = Array.from(this.priceOrders.values());
    if (options.contract) {
      results = results.filter(po => po.initial.contract === options.contract);
    }
    return results.map(po => ({ id: po.id, ...po }));
  }

  async getAccount(): Promise<any> {
    this.checkError('getAccount');
    return { available: '10000', total: '10000', unrealisedPnl: '0' };
  }

  async getPosition(contract: string): Promise<any> {
    this.checkError('getPosition');
    return this.positions.get(contract) || null;
  }

  async listPositions(): Promise<any[]> {
    this.checkError('listPositions');
    return Array.from(this.positions.values());
  }

  async listTickers(contract: string): Promise<any[]> {
    this.checkError('listTickers');
    const last = this.getLastPrice(contract);
    return [{
      contract,
      last: last,
      markPrice: last,
      indexPrice: last,
      fundingRate: '0',
      volume24h: '0',
      changePercentage: '0',
    }];
  }

  async listContracts(): Promise<any[]> {
    this.checkError('listContracts');
    return [{
      name: 'XRP_USDT',
      order_price_round: '0.0001',
      quanto_multiplier: '1',
      leverage_min: '1',
      leverage_max: '100',
      in_delisting: false,
    }];
  }

  async updateLeverage(contract: string, leverage: string): Promise<any> {
    this.checkError('updateLeverage');
    const pos = this.positions.get(contract);
    if (pos) {
      pos.leverage = leverage;
      // Gate.io: leverage='0' means cross margin, otherwise isolated (mode='single')
      pos.mode = leverage === '0' ? 'cross' : 'single';
    }
    return { leverage };
  }

  // -- Internal helpers ------------------------------------------------------

  private applyFillToPosition(order: any, fillPrice: string): void {
    const contract = order.contract;
    const fillSize = Math.abs(order.size);
    const isBuy = order.size > 0;
    let pos = this.positions.get(contract);

    if (order.is_reduce_only || order.reduce_only) {
      // Closing position
      if (pos) {
        const currentSize = Math.abs(parseFloat(pos.size));
        const newSize = Math.max(0, currentSize - fillSize);
        pos.size = (parseFloat(pos.size) > 0 ? '' : '-') + newSize;
      }
    } else {
      // Opening / adding to position
      if (!pos) {
        pos = {
          contract,
          size: (isBuy ? '' : '-') + fillSize,
          entryPrice: fillPrice,
          markPrice: fillPrice,
          unrealisedPnl: '0',
          leverage: '10',
          mode: 'single',
        };
        this.positions.set(contract, pos);
      } else {
        const currentSize = parseFloat(pos.size);
        const currentEntry = parseFloat(pos.entryPrice);
        const currentAbsSize = Math.abs(currentSize);
        if ((currentSize > 0 && isBuy) || (currentSize < 0 && !isBuy)) {
          // Same direction: average entry
          const newAbsSize = currentAbsSize + fillSize;
          const newEntry = (currentEntry * currentAbsSize + parseFloat(fillPrice) * fillSize) / newAbsSize;
          pos.size = (currentSize > 0 ? '' : '-') + newAbsSize;
          pos.entryPrice = newEntry.toString();
        } else {
          // Opposite direction: reduce position
          const newAbsSize = Math.max(0, currentAbsSize - fillSize);
          pos.size = (currentSize > 0 ? '' : '-') + newAbsSize;
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 2. MockGateIOWebSocket
// ---------------------------------------------------------------------------

export class MockGateIOWebSocket extends EventEmitter {
  private connected = false;

  /** Fill-promise listeners used by GateIOWSEventRouter. */
  public fillListeners = new Map<string, { resolve: (v: any) => void; reject: (e: any) => void }>();

  /** Connect without opening a real socket. */
  async connect(): Promise<void> {
    this.connected = true;
    this.emit('connected');
  }

  /** Disconnect. */
  async disconnect(): Promise<void> {
    this.connected = false;
    this.emit('disconnected');
  }

  /** Compatible with real GateIOWebSocket.waitForOpen(). */
  async waitForOpen(): Promise<void> {
    if (this.connected) return;
    return new Promise((resolve) => {
      this.once('connected', () => resolve());
    });
  }

  /** Compatible with real GateIOWebSocket.getStats(). */
  getStats(): { isConnected: boolean } {
    return { isConnected: this.connected };
  }

  // -- Simulation helpers ----------------------------------------------------

  /** Emit an 'order_update' event with the order object directly. */
  emitOrderUpdate(event: any): void {
    this.emit('order_update', event);
  }

  /** Emit a 'position_update' event. */
  emitPositionUpdate(event: any): void {
    this.emit('position_update', event);
  }

  /** Emit a 'balance_update' event. */
  emitBalanceUpdate(event: any): void {
    this.emit('balance_update', event);
  }

  /**
   * Simulate a fill for an order. Constructs a Gate.io order object matching
   * what GateIOExchange.handleWsOrderUpdate expects and emits it
   * as an 'order_update'.
   *
   * The GateIOExchange listener receives the order object and calls:
   *   this.eventRouter.route({ channel: 'futures.orders', result: order })
   * then also calls this.handleWsOrderUpdate(rawOrder) directly.
   */
  simulateFill(
    orderId: string,
    fillPrice: string,
    size: number,
    text = '',
    isReduceOnly = false,
    contract = 'XRP_USDT',
  ): void {
    const now = Math.floor(Date.now() / 1000);
    const event = {
      id: orderId,
      user: 1,
      contract,
      status: 'finished',
      size,
      left: 0,
      price: '0',
      fill_price: fillPrice,
      text,
      is_reduce_only: isReduceOnly,
      is_close: isReduceOnly,
      tif: 'ioc',
      reduce_only: isReduceOnly,
      create_time: now - 1,
      finish_time: now,
    };
    this.emitOrderUpdate(event);
  }

  /** Simulate a cancel for an order (left = remaining size). */
  simulateCancel(
    orderId: string,
    size: number,
    text = '',
    contract = 'XRP_USDT',
  ): void {
    const now = Math.floor(Date.now() / 1000);
    const event = {
      id: orderId,
      user: 1,
      contract,
      status: 'finished',
      size,
      left: size,
      price: '0',
      fill_price: '0',
      text,
      is_reduce_only: false,
      is_close: false,
      tif: 'gtc',
      reduce_only: false,
      create_time: now - 1,
      finish_time: now,
    };
    this.emitOrderUpdate(event);
  }

  /** Simulate a position close by emitting a position_update with size=0. */
  simulatePositionClose(contract = 'XRP_USDT'): void {
    const event = {
      contract,
      size: '0',
      entry_price: '0',
      mark_price: '0',
      unrealised_pnl: '0',
      leverage: '10',
      mode: 'single',
    };
    this.emitPositionUpdate(event);
  }
}

// ---------------------------------------------------------------------------
// 3. createMockedGateExchange factory
// ---------------------------------------------------------------------------

export interface MockedGateFixture {
  exchange: GateIOExchange;
  mockRest: MockGateIORestClient;
  mockWs: MockGateIOWebSocket;
  pipeline: ProtectionPipeline;
}

export async function createMockedGateExchange(
  testName: string,
  initialPrice = '0.6000',
): Promise<MockedGateFixture> {
  const instanceId = `mocked-gate-${testName}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const config: ExchangeConfig = {
    id: instanceId,
    name: instanceId,
    type: 'gate',
    apiKey: 'fake-key',
    apiSecret: 'fake-secret',
    baseURL: 'https://fake-gate.local',
    wsURL: 'wss://fake-gate.local/ws',
  };

  // Construct real GateIOExchange — its constructor calls initialize() → setupWebSocket()
  // which registers listeners on the original WS. We'll replace and re-register below.
  const exchange = new GateIOExchange(config);
  const mockRest = new MockGateIORestClient();
  const mockWs = new MockGateIOWebSocket();

  // Set initial price
  mockRest.setLastPrice('XRP_USDT', initialPrice);

  // Replace internals so all exchange code paths use the mocks
  (exchange as any).restClient = mockRest;
  (exchange as any).ws = mockWs;

  // Re-register WS listeners on the mock WS.
  // The constructor already called setupWebSocket(), but that registered
  // listeners on the original WS instance. We must re-register on mockWs.
  (exchange as any).setupWebSocket();

  // Wire up ProtectionPipeline
  const pipeline = new ProtectionPipeline(exchange, PendingProtection, Order);
  exchange.setProtectionPipeline(pipeline);
  (exchange as any).orderPersistenceHandler?.setProtectionPipeline(pipeline);

  return { exchange, mockRest, mockWs, pipeline };
}