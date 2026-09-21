import { sequelize } from '../../../src/models';
import { IExchange, OrderResult } from '../../../src/services/exchanges/IExchange';
import { VirtualGateExchange } from '../../../src/services/exchanges/virtual/VirtualGateExchange';
import { MarketDataHub } from '../../../src/services/marketData/MarketDataHub';
import { MarketDataStream, MarketTickListener } from '../../../src/services/marketData/types';
import { ProtectionManager } from '../../../src/services/ProtectionManager';
import {
  POLL_INTERVAL_MS,
  SYMBOL,
  calcTpSlForLong,
  calcTpSlForShort,
  waitFor,
} from './priceUtils';

// ---------------------------------------------------------------------------
// NoopMarketDataStream
// ---------------------------------------------------------------------------

export class NoopMarketDataStream implements MarketDataStream {
  async start(_listener: MarketTickListener): Promise<void> {
    // no-op — ticks are injected deterministically via hub.ingestTick()
  }

  async stop(): Promise<void> {
    // no-op
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DeterministicGateFixture {
  exchange: IExchange;
  hub: MarketDataHub;
  injectPrice: (price: string) => void;
  stop: () => Promise<void>;
}

// ---------------------------------------------------------------------------
// getOrderPrice
// ---------------------------------------------------------------------------

export function getOrderPrice(order: OrderResult): string {
  if (order.trigger?.price) return String(order.trigger.price);
  if (order.price) return String(order.price);
  return '0';
}

// ---------------------------------------------------------------------------
// resetDeterministicGateDb
// ---------------------------------------------------------------------------

export async function resetDeterministicGateDb(): Promise<void> {
  await sequelize.sync({ force: true });
}

// ---------------------------------------------------------------------------
// createDeterministicGateFixture
// ---------------------------------------------------------------------------

export async function createDeterministicGateFixture(
  testName: string,
  initialPrice = '0.6000',
  maxTickAgeMs?: number,
): Promise<DeterministicGateFixture> {
  const hub = new MarketDataHub({
    createStream: () => new NoopMarketDataStream(),
  });

  const instanceId = `det-gate-${testName}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const exchange = new VirtualGateExchange(
    {
      id: instanceId,
      name: instanceId,
      type: 'virtual_gate',
      apiKey: '',
      apiSecret: '',
      baseURL: '',
      initialBalance: '10000',
      maxTickAgeMs: maxTickAgeMs ?? 60_000,
    },
    hub,
  );

  const injectPrice = (price: string): void => {
    hub.ingestTick({
      symbol: SYMBOL,
      lastPrice: price,
      markPrice: price,
      indexPrice: price,
      source: 'gate',
      receivedAt: new Date(),
    });
  };

  await exchange.start?.();
  if (initialPrice) injectPrice(initialPrice);

  const stop = async (): Promise<void> => {
    await exchange.stop?.();
    await hub.stop();
  };

  return { exchange, hub, injectPrice, stop };
}

// ---------------------------------------------------------------------------
// openMarketPosition
// ---------------------------------------------------------------------------

export async function openMarketPosition(
  exchange: IExchange,
  side: 'buy' | 'sell',
  text: string,
): Promise<{ orderId: string; entryPrice: string }> {
  await exchange.setLeverage(SYMBOL, '10');

  const result = await exchange.placeOrder({
    symbol: SYMBOL,
    side,
    amount: '1',
    type: 'market',
    text,
  });

  if (result.status !== 'filled') {
    throw new Error(
      `Expected market order to be filled, got status=${result.status} (id=${result.id})`,
    );
  }

  const position = await exchange.getPosition(SYMBOL);
  if (!position || Number(position.size) === 0) {
    throw new Error(
      `Expected open position after market ${side}, but got none or size=0`,
    );
  }

  return { orderId: result.id, entryPrice: position.entryPrice };
}

// ---------------------------------------------------------------------------
// placeProtectionOrders
// ---------------------------------------------------------------------------

export async function placeProtectionOrders(
  exchange: IExchange,
  side: 'buy' | 'sell',
  amount: string,
  entryPrice: string,
  text: string,
): Promise<{ slPrice: string; tpPrice: string }> {
  const protectionManager = new ProtectionManager(exchange);

  const entryNum = Number(entryPrice);
  const prices = side === 'buy'
    ? calcTpSlForLong(entryNum)
    : calcTpSlForShort(entryNum);

  const slId = await protectionManager.placeStopLoss({
    orderId: text,
    symbol: SYMBOL,
    side,
    amount,
    stopLossPrice: prices.slPrice,
    source: text,
  });

  if (!slId || !/^vo-/.test(slId)) {
    throw new Error(
      `Expected SL id matching /^vo-/, got "${slId}"`,
    );
  }

  const tpResults = await protectionManager.placeTakeProfit({
    orderId: text,
    symbol: SYMBOL,
    side,
    amount,
    takeProfitPrice: prices.tpPrice,
    source: text,
  });

  if (tpResults.length !== 1) {
    throw new Error(
      `Expected exactly 1 TP order, got ${tpResults.length}: [${tpResults.join(', ')}]`,
    );
  }

  return prices;
}

// ---------------------------------------------------------------------------
// waitForTpSlOrders
// ---------------------------------------------------------------------------

export async function waitForTpSlOrders(
  exchange: IExchange,
  expectedSl: string,
  expectedTp: string,
): Promise<{ sl: OrderResult; tp: OrderResult }> {
  const TOLERANCE = 0.002; // 0.2%

  function priceMatches(order: OrderResult, expected: string): boolean {
    const orderPrice = Number(getOrderPrice(order));
    const expectedNum = Number(expected);
    if (!Number.isFinite(orderPrice) || !Number.isFinite(expectedNum)) return false;
    return Math.abs(orderPrice - expectedNum) / expectedNum <= TOLERANCE;
  }

  const found = await waitFor(
    async () => {
      const priceOrders = await exchange.getPriceOrders(SYMBOL);
      const openOrders = await exchange.getOpenOrders(SYMBOL);

      const sl = priceOrders.find((o) => priceMatches(o, expectedSl));
      const tp = openOrders.find((o) => priceMatches(o, expectedTp));

      return Boolean(sl && tp);
    },
    2000,
    50,
  );

  if (!found) {
    const priceOrders = await exchange.getPriceOrders(SYMBOL);
    const openOrders = await exchange.getOpenOrders(SYMBOL);
    throw new Error(
      `Timed out waiting for TP/SL orders. `
      + `Expected SL=${expectedSl}, TP=${expectedTp}. `
      + `Price orders: [${priceOrders.map((o) => getOrderPrice(o)).join(', ')}]. `
      + `Open orders: [${openOrders.map((o) => getOrderPrice(o)).join(', ')}].`,
    );
  }

  const priceOrders = await exchange.getPriceOrders(SYMBOL);
  const openOrders = await exchange.getOpenOrders(SYMBOL);

  const sl = priceOrders.find((o) => priceMatches(o, expectedSl))!;
  const tp = openOrders.find((o) => priceMatches(o, expectedTp))!;

  return { sl, tp };
}

// ---------------------------------------------------------------------------
// waitForFlatPosition
// ---------------------------------------------------------------------------

export async function waitForFlatPosition(
  exchange: IExchange,
  timeoutMs = 2000,
): Promise<void> {
  const isFlat = await waitFor(
    async () => {
      const position = await exchange.getPosition(SYMBOL);
      return !position || Number(position.size) === 0;
    },
    timeoutMs,
    50,
  );

  if (!isFlat) {
    const position = await exchange.getPosition(SYMBOL);
    const openOrders = await exchange.getOpenOrders(SYMBOL);
    const priceOrders = await exchange.getPriceOrders(SYMBOL);
    throw new Error(
      `Timed out waiting for flat position. `
      + `Position: size=${position?.size ?? 'null'}, entry=${position?.entryPrice ?? 'null'}. `
      + `Open orders: [${openOrders.map((o) => o.id).join(', ')}]. `
      + `Price orders: [${priceOrders.map((o) => o.id).join(', ')}].`,
    );
  }
}

// ---------------------------------------------------------------------------
// cleanupDeterministicGate
// ---------------------------------------------------------------------------

export async function cleanupDeterministicGate(exchange: IExchange): Promise<void> {
  // Cancel all open orders
  const openOrders = await exchange.getOpenOrders(SYMBOL);
  for (const order of openOrders) {
    await exchange.cancelOrder(order.id, SYMBOL);
  }

  // Cancel all price orders
  const priceOrders = await exchange.getPriceOrders(SYMBOL);
  for (const order of priceOrders) {
    await exchange.cancelPriceOrder(order.id, SYMBOL);
  }

  // Close position if size != 0
  const position = await exchange.getPosition(SYMBOL);
  if (position && Number(position.size) !== 0) {
    const side: 'buy' | 'sell' = Number(position.size) > 0 ? 'sell' : 'buy';
    await exchange.closePosition(SYMBOL, side);
  }
}

// ---------------------------------------------------------------------------
// verifyCleanDeterministicGate
// ---------------------------------------------------------------------------

// VirtualGateExchange.getPosition returns null when size=0, so checking
// position !== null is equivalent to the testnet verifyClean's check of
// position && parseFloat(size) !== 0. Both reject any non-flat state.
export async function verifyCleanDeterministicGate(exchange: IExchange): Promise<void> {
  const openOrders = await exchange.getOpenOrders(SYMBOL);
  if (openOrders.length > 0) {
    throw new Error(
      `Expected no open orders, found ${openOrders.length}: ${openOrders.map((o) => o.id).join(', ')}`,
    );
  }

  const priceOrders = await exchange.getPriceOrders(SYMBOL);
  if (priceOrders.length > 0) {
    throw new Error(
      `Expected no price orders, found ${priceOrders.length}: ${priceOrders.map((o) => o.id).join(', ')}`,
    );
  }

  const position = await exchange.getPosition(SYMBOL);
  if (position !== null) {
    throw new Error(
      `Expected no position, found size=${position.size} entryPrice=${position.entryPrice}`,
    );
  }
}
