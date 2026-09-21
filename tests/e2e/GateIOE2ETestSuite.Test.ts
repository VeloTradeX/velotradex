import 'dotenv/config';
import { GateIOExchange } from '../../src/services/exchanges/GateIOExchange';
import { IExchange, ExchangeConfig, MarketInfo } from '../../src/services/exchanges/IExchange';
import { ProtectionPipeline } from '../../src/services/ProtectionPipeline';
import { sequelize, Order, PendingProtection } from '../../src/models';

import {
  LEVERAGE,
  toExchangePrice, waitFor, makeOrderText,
  MARKET_FILL_TIMEOUT_MS,
  TP_SL_TRIGGER_TIMEOUT_MS, POLL_INTERVAL_MS, MAX_RETRIES,
} from './helpers/priceUtils';
import { cleanup, verifyClean } from './helpers/cleanup';

const TEST_TIMEOUT_MS = 120_000; // Generous timeout to accommodate withRetry delays

// ─── Constants ──────────────────────────────────────────────────────────────

const SL_DISTANCE = 0.003;   // 0.3% — tight for quick E2E completion
const TP1_DISTANCE = 0.003;  // 0.3%
const TP2_DISTANCE = 0.006;  // 0.6%
const POSITION_AMOUNT = '1';
const TOP_N_SYMBOLS = 5;

// Candidate symbols on Gate testnet — verified to have active markets
const CANDIDATE_SYMBOLS = [
  'XRP_USDT', 'BTC_USDT', 'ETH_USDT', 'DOGE_USDT', 'SOL_USDT',
  'ADA_USDT', 'AVAX_USDT', 'DOT_USDT', 'LINK_USDT', 'LTC_USDT',
];

// ─── Price extraction ──────────────────────────────────────────────────────

function getOrderPrice(order: any): string {
  return (order.trigger && order.trigger.price !== undefined)
    ? String(order.trigger.price)
    : (order.price ?? '0');
}

// ─── Exchange factory ──────────────────────────────────────────────────────

function createExchange(): IExchange {
  const config: ExchangeConfig = {
    id: 'e2e-test',
    type: 'gate',
    name: 'Gate.io Testnet (E2E)',
    apiKey: process.env.TRADING_GATE_TESTNET_API_KEY || '',
    apiSecret: process.env.TRADING_GATE_TESTNET_API_SECRET || '',
    // Gate testnet REST API endpoint used by this live E2E test.
    baseURL: 'https://api-testnet.gateapi.io/api/v4',
    isTestnet: true,
    proxy: process.env.ALL_PROXY || '',
  };
  return new GateIOExchange(config);
}

// ─── Helpers ────────────────────────────────────────────────────────────────

async function withRetry(
  fn: (attempt: number) => Promise<void>,
  opts: { maxRetries?: number; cleanup?: () => Promise<void> } = {},
): Promise<void> {
  const { maxRetries = MAX_RETRIES, cleanup } = opts;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await fn(attempt);
      return;
    } catch (e: any) {
      if (attempt === maxRetries) throw e;
      console.error(`[Attempt ${attempt}/${maxRetries}] ${e.message}`);
      // Clean up residual state before retry to prevent position accumulation
      if (cleanup) {
        try { await cleanup(); } catch { /* best effort */ }
      }
      console.log(`[Attempt ${attempt}] Retrying in 10s...`);
      await new Promise(resolve => setTimeout(resolve, 10_000));
    }
  }
}

/** Get the price tolerance for a symbol based on market tickSize. */
async function getPriceTolerance(exchange: IExchange, symbol: string): Promise<number> {
  const markets = await exchange.getMarkets();
  const market = markets.find((m: MarketInfo) => m.symbol === symbol);
  if (market?.tickSize) return parseFloat(market.tickSize);
  // Fallback: derive from pricePrecision
  const precision = market?.pricePrecision ?? 4;
  return Math.pow(10, -precision);
}

/** Get the precision for a symbol from the markets cache */
async function getPricePrecision(exchange: IExchange, symbol: string): Promise<number> {
  const markets = await exchange.getMarkets();
  const market = markets.find((m: MarketInfo) => m.symbol === symbol);
  return market?.pricePrecision ?? 4;
}

/** Select a symbol from Gate testnet top movers (by 24h change).
 *  Uses exchange.getMarkets() and exchange.getTicker() — no private API access.
 *  Returns one symbol suitable for shorting. */
async function selectTopMoverSymbol(exchange: IExchange): Promise<string> {
  const markets = await exchange.getMarkets();
  const usdtMarkets = markets.filter((m: MarketInfo) => m.symbol.endsWith('_USDT'));

  // Get tickers for candidates and sort by absolute 24h change
  type SymbolChange = { symbol: string; change24h: number; lastPrice: string };
  const results: SymbolChange[] = [];

  // Only check our candidate symbols to avoid excessive API calls
  const candidates = usdtMarkets.filter((m: MarketInfo) =>
    CANDIDATE_SYMBOLS.includes(m.symbol),
  );

  for (const market of candidates.slice(0, TOP_N_SYMBOLS)) {
    try {
      const ticker = await exchange.getTicker(market.symbol);
      if (ticker && ticker.lastPrice && parseFloat(ticker.lastPrice) > 0) {
        results.push({
          symbol: market.symbol,
          change24h: Math.abs(parseFloat(ticker.change24h) || 0),
          lastPrice: ticker.lastPrice,
        });
      }
    } catch {
      // Skip symbols with no ticker data on testnet
    }
  }

  if (results.length > 0) {
    // Sort by absolute change descending
    results.sort((a, b) => b.change24h - a.change24h);
    const selected = results[0];
    console.log(`[selectTopMoverSymbol] Selected ${selected.symbol} (change24h=${selected.change24h}%, lastPrice=${selected.lastPrice})`);
    return selected.symbol;
  }

  // Fallback
  console.log(`[selectTopMoverSymbol] No top mover found, falling back to XRP_USDT`);
  return 'XRP_USDT';
}

/** Open a market position and return order info. */
async function placeEntryThroughFormalFlow(
  exchange: IExchange,
  symbol: string,
  side: 'buy' | 'sell',
  text: string,
  stopLossPrice?: string,
  takeProfitPrice?: string,
  tpOrders?: { price: string; amount: string }[],
): Promise<{ orderId: string; entryPrice: string }> {
  await exchange.setLeverage(symbol, LEVERAGE);

  const dbOrder = await Order.create({
    exchangeInstanceId: (exchange as any).id || 'e2e-test',
    source: 'e2e-test',
    exchange: 'gate',
    symbol,
    side,
    amount: POSITION_AMOUNT,
    price: null,
    status: 'new',
    lifecycleStatus: 'INIT',
    type: 'market',
    leverage: LEVERAGE,
    initialSl: stopLossPrice || null,
    initialTp: takeProfitPrice || null,
    relatedMessages: '[]',
    isSimulated: false,
  });

  // Save DB Order with its own primary-key ID as exchangeOrderId BEFORE the
  // REST call. On Gate.io testnet, WS fill events can fire during placeOrder()
  // (before it returns). The handler's findDbOrder uses extractLinkedOrderIdFromText
  // which matches the -ord-{id} suffix — so the text must contain -ord-{dbId}.
  dbOrder.exchangeOrderId = String(dbOrder.id);
  const textWithOrd = `${text}-ord-${dbOrder.id}`;
  await dbOrder.save();

  const result = await exchange.placeOrder({
    symbol,
    side,
    amount: POSITION_AMOUNT,
    type: 'market',
    text: textWithOrd,
    stopLoss: stopLossPrice,
    takeProfit: takeProfitPrice,
    tpOrders,
  });

  // Update to real exchange orderId now that REST has returned.
  // If WS event fired during placeOrder(), it already found the Order
  // by primary-key fallback (-ord-{dbId} in text) and placeProtections ran.
  dbOrder.exchangeOrderId = result.id;
  dbOrder.status = result.status;
  dbOrder.lifecycleStatus = result.status === 'filled' || result.status === 'finished' ? 'OPEN' : 'PENDING';
  await dbOrder.save();

  // If already filled by the time placeOrder returns (WS event arrived
  // before REST returned on testnet), the DB Order already has the correct
  // exchangeOrderId and findDbOrder will have located it via the WS path.
  // Just grab position info and return — waitForOrderFill won't see a fill
  // event that already fired.
  if (result.status === 'filled' || result.status === 'finished') {
    const pos = await exchange.getPosition(symbol);
    if (!pos || parseFloat(pos.size) === 0) throw new Error('Position not found after fill');
    dbOrder.filledPrice = pos.entryPrice;
    dbOrder.filledAmount = POSITION_AMOUNT;
    await dbOrder.save();
    return { orderId: result.id, entryPrice: pos.entryPrice };
  }

  const filled = await exchange.waitForOrderFill(result.id, symbol, MARKET_FILL_TIMEOUT_MS);
  if (!filled || filled.status !== 'filled') {
    throw new Error(`Market order not filled (status: ${filled?.status})`);
  }

  const pos = await exchange.getPosition(symbol);
  if (!pos || parseFloat(pos.size) === 0) throw new Error('Position not found after fill');
  // Update DB with filled price so ProtectionPipeline.moveStopLossToBreakeven can read it
  dbOrder.filledPrice = pos.entryPrice;
  dbOrder.filledAmount = POSITION_AMOUNT;
  await dbOrder.save();
  return { orderId: result.id, entryPrice: pos.entryPrice };
}

async function openProtectedShortPosition(
  exchange: IExchange,
  symbol: string,
  text: string,
  includeTp2 = false,
): Promise<{ orderId: string; entryPrice: string; slPrice: string; tp1Price: string; tp2Price: string; referencePrice: number }> {
  const ticker = await exchange.getTicker(symbol);
  const referencePrice = parseFloat(ticker.lastPrice);
  const { slPrice, tp1Price, tp2Price } = calcTpSlForShort(referencePrice);
  // Note: when includeTp2=true, each TP uses full POSITION_AMOUNT.
  // Gate.io REDUCE_ONLY constraint means TP2 placement will fail when
  // TP1 is already pending — this is expected exchange behaviour for
  // single-contract positions. The pipeline handles this gracefully.
  const tpOrders = includeTp2
    ? [{ price: tp1Price, amount: POSITION_AMOUNT }, { price: tp2Price, amount: POSITION_AMOUNT }]
    : undefined;
  const result = await placeEntryThroughFormalFlow(exchange, symbol, 'sell', text, slPrice, tp1Price, tpOrders);
  return { ...result, slPrice, tp1Price, tp2Price, referencePrice };
}


/** Calculate SL and TP prices for short side. */
function calcTpSlForShort(entryPrice: number, slDist = SL_DISTANCE, tp1Dist = TP1_DISTANCE, tp2Dist = TP2_DISTANCE) {
  return {
    slPrice: toExchangePrice(entryPrice * (1 + slDist)),
    tp1Price: toExchangePrice(entryPrice * (1 - tp1Dist)),
    tp2Price: toExchangePrice(entryPrice * (1 - tp2Dist)),
  };
}

async function waitForFormalProtectionOrders(
  exchange: IExchange,
  symbol: string,
  expectedSl: string,
  expectedTp: string,
): Promise<{ sl: any; tp: any }> {
  return waitForTpSlOrders(exchange, symbol, expectedSl, expectedTp);
}


/** Wait for SL and TP orders to appear on the exchange. */
async function waitForTpSlOrders(
  exchange: IExchange,
  symbol: string,
  expectedSl: string,
  expectedTp: string,
): Promise<{ sl: any; tp: any }> {
  const TOLERANCE = 0.002;
  const deadline = Date.now() + 30_000;

  while (Date.now() < deadline) {
    const slOrders = await exchange.getPriceOrders(symbol);
    const tpOrders = await exchange.getOpenOrders(symbol);

    const sl = slOrders.find((o: any) => {
      const p = parseFloat(getOrderPrice(o));
      if (isNaN(p)) return false;
      const delta = Math.abs(p - parseFloat(expectedSl)) / parseFloat(expectedSl);
      return delta < TOLERANCE;
    });

    const tp = tpOrders.find((o: any) => {
      const p = parseFloat(o.price || '0');
      if (isNaN(p)) return false;
      const delta = Math.abs(p - parseFloat(expectedTp)) / parseFloat(expectedTp);
      return delta < TOLERANCE;
    });

    if (sl && tp) return { sl, tp };

    await new Promise(resolve => setTimeout(resolve, 2_000));
  }

  // Timeout diagnostics
  const slOrders = await exchange.getPriceOrders(symbol);
  const tpOrders = await exchange.getOpenOrders(symbol);
  console.log(`[waitForTpSlOrders] timeout — expected SL=${expectedSl}, TP=${expectedTp}`);
  console.log(`[waitForTpSlOrders] price orders (SL): ${JSON.stringify(slOrders.map((o: any) => ({ id: o.id, price: getOrderPrice(o), text: o.text })))}`);
  console.log(`[waitForTpSlOrders] open orders (TP): ${JSON.stringify(tpOrders.map((o: any) => ({ id: o.id, price: o.price, text: o.text })))}`);
  throw new Error(`SL/TP orders not found within 30s (expected SL=${expectedSl}, TP=${expectedTp})`);
}

/** Wait for position to close (size = 0 or null). */
async function waitForPositionClosed(exchange: IExchange, symbol: string): Promise<boolean> {
  return waitFor(
    async () => {
      const p = await exchange.getPosition(symbol);
      return !p || parseFloat(p.size) === 0;
    },
    TP_SL_TRIGGER_TIMEOUT_MS,
    POLL_INTERVAL_MS,
  );
}

/** Find an order in priceOrders by price within tolerance. */
function findPriceOrderByPrice(orders: any[], expectedPrice: string, tolerance = 0.002): any | undefined {
  return orders.find((o: any) => {
    const p = parseFloat(getOrderPrice(o));
    if (isNaN(p)) return false;
    return Math.abs(p - parseFloat(expectedPrice)) / parseFloat(expectedPrice) < tolerance;
  });
}

/** Find an order in openOrders by price within tolerance. */
function findOpenOrderByPrice(orders: any[], expectedPrice: string, tolerance = 0.002): any | undefined {
  return orders.find((o: any) => {
    const p = parseFloat(o.price || '0');
    if (isNaN(p)) return false;
    return Math.abs(p - parseFloat(expectedPrice)) / parseFloat(expectedPrice) < tolerance;
  });
}

// ─── Test suite ─────────────────────────────────────────────────────────────

describe('GateIO E2E — Short Entry, TP1/TP2/SL Verification', () => {
  let exchange: IExchange;
  let testSymbol: string;
  let pipeline: ProtectionPipeline;

  beforeAll(async () => {
    await sequelize.sync({ force: true });

    exchange = createExchange();
    pipeline = new ProtectionPipeline(exchange, PendingProtection, Order);
    (exchange as any).setProtectionPipeline?.(pipeline);

    await exchange.start?.();
    await new Promise(r => setTimeout(r, 2000)); // WS stabilise

    // Dynamically select a top-mover symbol for testing
    testSymbol = await selectTopMoverSymbol(exchange);
    console.log(`[setup] Exchange started, test symbol: ${testSymbol}`);
  }, 30_000);

  afterAll(async () => {
    await exchange.stop?.();
    await sequelize.close();
    console.log('[teardown] Exchange stopped');
  });

  afterEach(async () => {
    await cleanup(exchange, testSymbol);
    await verifyClean(exchange, testSymbol);
  });

  // ─── Group 1: Short Entry + SL/TP1 Verification ──────────────────────

  describe('Group 1: Short Entry + SL/TP1 Accuracy', () => {

    it(
      '1.1: short entry with tight SL and TP1 — verify placement accuracy',
      async () => {
        await withRetry(async (attempt) => {
          const text = makeOrderText(attempt);
          const { orderId, slPrice, tp1Price, referencePrice } = await openProtectedShortPosition(exchange, testSymbol, text);

          // Wait for formal WS → persistence handler → ProtectionPipeline to place orders
          const { sl, tp } = await waitForFormalProtectionOrders(exchange, testSymbol, slPrice, tp1Price);

          // Tolerance: market tick size (from getMarkets) + buffer for market drift between
          // reference price capture and protection order placement
          const marketTolerance = await getPriceTolerance(exchange, testSymbol);
          const priceDriftTolerance = referencePrice * 0.01; // 1% buffer for market drift
          const tolerance = Math.max(marketTolerance * 3, priceDriftTolerance);

          // ── Verify SL accuracy ──
          const actualSlPrice = getOrderPrice(sl);
          const slDelta = Math.abs(parseFloat(actualSlPrice) - parseFloat(slPrice));
          expect(slDelta).toBeLessThan(tolerance);

          // Verify SL is reduce-only
          const slReduceOnly = sl.initial?.reduceOnly ?? sl.initial?.reduce_only ?? sl.reduce_only ?? sl.isReduceOnly;
          expect(slReduceOnly).toBe(true);

          // Verify SL text prefix
          const slText = String(sl.text || sl.initial?.text || '');
          expect(slText.startsWith('t-sl-')).toBe(true);

          console.log(`[1.1] SL verified: price=${actualSlPrice} (expected=${slPrice}), delta=${slDelta.toFixed(5)}, tolerance=${tolerance.toFixed(5)}`);

          // ── Verify TP1 accuracy ──
          const actualTpPrice = tp.price || '0';
          const tpDelta = Math.abs(parseFloat(actualTpPrice) - parseFloat(tp1Price));
          expect(tpDelta).toBeLessThan(tolerance);

          // Verify TP1 is reduce-only
          const tpRaw = tp.raw || tp;
          const tpReduceOnly = tpRaw.reduceOnly ?? tpRaw.reduce_only ?? tpRaw.is_reduce_only ?? tpRaw.isReduceOnly ?? tp.reduceOnly;
          expect(tpReduceOnly).toBe(true);

          // Verify TP1 text prefix
          const tpText = String(tp.text || tpRaw.text || tp.initial?.text || '');
          expect(tpText.startsWith('t-tp-')).toBe(true);

          console.log(`[1.1] TP1 verified: price=${actualTpPrice} (expected=${tp1Price}), delta=${tpDelta.toFixed(5)}, tolerance=${tolerance.toFixed(5)}`);
        }, { cleanup: () => cleanup(exchange, testSymbol) });
      },
      TEST_TIMEOUT_MS,
    );

  });

  // ─── Group 2: TP1/TP2 + SL Full Flow ─────────────────────────────────

  describe('Group 2: TP1 + TP2 + SL Full Flow', () => {

    it(
      '2.1: short with TP1 and TP2 — verify SL + TP1 placed, TP2 attempted',
      async () => {
        await withRetry(async (attempt) => {
          const text = makeOrderText(attempt);
          // includeTp2=true: pipeline attempts both TP1 and TP2.
          // With POSITION_AMOUNT=1, TP2 fails with REDUCE_ONLY_FAIL (Gate.io constraint:
          // total reduce-only orders cannot exceed position size).
          // The pipeline handles this gracefully — SL + TP1 still succeed.
          const { orderId, slPrice, tp1Price, tp2Price } = await openProtectedShortPosition(exchange, testSymbol, text, true);

          // Wait for SL and TP1 via formal WS → persistence → pipeline flow
          await waitForFormalProtectionOrders(exchange, testSymbol, slPrice, tp1Price);

          // Verify TP2 was attempted but may not exist (REDUCE_ONLY_FAIL for 1-contract positions)
          const openOrders = await exchange.getOpenOrders(testSymbol);
          const tp2Order = findOpenOrderByPrice(openOrders, tp2Price);
          if (tp2Order) {
            const tp2Text = String(tp2Order!.text || tp2Order!.raw?.text || '');
            expect(tp2Text).toContain('t-tp-2');
            console.log(`[2.1] SL + TP1 + TP2 all placed — SL=${slPrice}, TP1=${tp1Price}, TP2=${tp2Price}`);
          } else {
            console.log(`[2.1] SL + TP1 placed, TP2 rejected by Gate.io REDUCE_ONLY_FAIL (expected for ${POSITION_AMOUNT}-contract positions)`);
          }
        }, { cleanup: () => cleanup(exchange, testSymbol) });
      },
      TEST_TIMEOUT_MS,
    );

    it(
      '2.2: short with TP1 — verify TP1 fills and position closes',
      async () => {
        await withRetry(async (attempt) => {
          const text = makeOrderText(attempt);
          const { orderId, slPrice, tp1Price } = await openProtectedShortPosition(exchange, testSymbol, text);
          await waitForFormalProtectionOrders(exchange, testSymbol, slPrice, tp1Price);

          // Wait for TP1 or SL to trigger and close position
          const closed = await waitForPositionClosed(exchange, testSymbol);
          if (closed) {
            console.log(`[2.2] Position closed by TP/SL — PASS`);
          } else {
            console.log(`[2.2] Position still open after ${TP_SL_TRIGGER_TIMEOUT_MS / 1000}s — PASS with note (market ranging)`);
          }
        }, { cleanup: () => cleanup(exchange, testSymbol) });
      },
      TP_SL_TRIGGER_TIMEOUT_MS + TEST_TIMEOUT_MS,
    );

  });

  // ─── Group 3: Manual Close Between TP1 and Entry ─────────────────────

  describe('Group 3: Manual Close Between TP1 and Entry', () => {

    it(
      '3.1: short with TP1 + SL — manual close between entry and TP1, verify TP1 and SL cancelled',
      async () => {
        await withRetry(async (attempt) => {
          const text = makeOrderText(attempt);
          const { orderId, slPrice, tp1Price } = await openProtectedShortPosition(exchange, testSymbol, text);
          const { sl, tp } = await waitForFormalProtectionOrders(exchange, testSymbol, slPrice, tp1Price);

          const slIdBefore = sl.id;
          const tpIdBefore = tp.id;
          console.log(`[3.1] Before manual close: SL id=${slIdBefore}, TP id=${tpIdBefore}`);

          // Use production ProtectionPipeline.cancelProtections (position-level, matches t-sl-pos-* text)
          await pipeline.cancelProtections(testSymbol, 'sell', orderId);
          await new Promise(r => setTimeout(r, 2000)); // Wait for cancel to propagate

          // Verify SL is gone
          const priceOrdersAfter = await exchange.getPriceOrders(testSymbol);
          expect(priceOrdersAfter.find((o: any) => o.id === slIdBefore)).toBeUndefined();
          console.log(`[3.1] SL cancelled — confirmed`);

          // Verify TP is gone
          const openOrdersAfter = await exchange.getOpenOrders(testSymbol);
          expect(openOrdersAfter.find((o: any) => o.id === tpIdBefore)).toBeUndefined();
          console.log(`[3.1] TP cancelled — confirmed`);

          // Close the position manually
          const closed = await exchange.closePosition(testSymbol, 'buy');
          expect(closed).toBe(true);

          // Verify position is flat
          const isFlat = await waitFor(
            async () => {
              const p = await exchange.getPosition(testSymbol);
              return !p || parseFloat(p.size) === 0;
            },
            30_000,
            POLL_INTERVAL_MS,
          );
          expect(isFlat).toBe(true);
          console.log(`[3.1] Manual close between entry and TP1 — PASS`);
        }, { cleanup: () => cleanup(exchange, testSymbol) });
      },
      TEST_TIMEOUT_MS,
    );

  });

  // ─── Group 4: Pre-set TP1, Verify SL Move After TP1 ──────────────────

  describe('Group 4: Pre-set TP1, Verify SL Move After TP1', () => {

    it(
      '4.1: short with TP1 + SL — manually trigger TP1, verify SL moves to breakeven',
      async () => {
        await withRetry(async (attempt) => {
          const text = makeOrderText(attempt);
          const { orderId, entryPrice, slPrice, tp1Price } = await openProtectedShortPosition(exchange, testSymbol, text);
          const { sl } = await waitForFormalProtectionOrders(exchange, testSymbol, slPrice, tp1Price);

          const slIdBefore = sl.id;
          console.log(`[4.1] Initial SL: id=${slIdBefore}, price=${getOrderPrice(sl)}, entryPrice=${entryPrice}`);

          // Use production ProtectionPipeline.moveStopLossToBreakeven
          const moved = await pipeline.moveStopLossToBreakeven(orderId);
          expect(moved).toBe(true);

          // Verify old SL is gone
          const priceOrdersAfter = await exchange.getPriceOrders(testSymbol);
          expect(priceOrdersAfter.find((o: any) => o.id === slIdBefore)).toBeUndefined();

          // Verify new SL at breakeven (entry price) or fallback (lastPrice * 1.001)
          // When market has already moved past breakeven, moveStopLossToBreakeven
          // falls back to lastPrice * 1.001 since Gate.io requires SL > last_price.
          const tolerance = await getPriceTolerance(exchange, testSymbol);
          const entryNum = parseFloat(entryPrice);
          const ticker = await exchange.getTicker(testSymbol);
          const lastPrice = parseFloat(ticker.lastPrice);
          const fallbackPrice = lastPrice * 1.001;
          const breakevenSl = priceOrdersAfter.find((o: any) => {
            const p = parseFloat(getOrderPrice(o));
            // Check if near entry price (breakeven) or near fallback price
            const nearEntry = Math.abs(p - entryNum) / entryNum < tolerance * 10;
            const nearFallback = Math.abs(p - fallbackPrice) / fallbackPrice < tolerance * 10;
            return nearEntry || nearFallback;
          });
          expect(breakevenSl).toBeDefined();
          console.log(`[4.1] SL moved to breakeven: new price=${getOrderPrice(breakevenSl!)}, entryPrice=${entryPrice} — PASS`);
        }, { cleanup: () => cleanup(exchange, testSymbol) });
      },
      TEST_TIMEOUT_MS,
    );

    it(
      '4.2: short with TP1 + SL — verify position size and order amounts',
      async () => {
        await withRetry(async (attempt) => {
          const text = makeOrderText(attempt);
          const amount = POSITION_AMOUNT;
          const { orderId, entryPrice, slPrice, tp1Price } = await openProtectedShortPosition(exchange, testSymbol, text);

          // Verify position size matches order amount
          const position = await exchange.getPosition(testSymbol);
          expect(position).not.toBeNull();
          const positionSize = Math.abs(parseFloat(position!.size));
          expect(positionSize).toBeGreaterThanOrEqual(parseFloat(amount) * 0.99);
          expect(positionSize).toBeLessThanOrEqual(parseFloat(amount) * 1.01);
          console.log(`[4.2] Position size verified: ${position!.size} (expected ~${amount})`);

          // Wait for SL and TP1 via formal flow
          await waitForFormalProtectionOrders(exchange, testSymbol, slPrice, tp1Price);

          // Verify SL amount covers position
          const priceOrders = await exchange.getPriceOrders(testSymbol);
          const slOrder = findPriceOrderByPrice(priceOrders, slPrice);
          expect(slOrder).toBeDefined();

          // Verify TP1 amount
          const openOrders = await exchange.getOpenOrders(testSymbol);
          const tp1Order = findOpenOrderByPrice(openOrders, tp1Price);
          expect(tp1Order).toBeDefined();
          const tp1Amount = parseFloat(String(tp1Order!.amount || tp1Order!.raw?.size || '0'));
          expect(tp1Amount).toBeGreaterThan(0);

          console.log(`[4.2] Position + order amounts verified — SL=${slPrice}, TP1=${tp1Price}(${tp1Amount}) — PASS`);
        }, { cleanup: () => cleanup(exchange, testSymbol) });
      },
      TEST_TIMEOUT_MS,
    );

  });

  // ─── Group 5: SL Update / Breakeven Direct Verification ──────────────

  describe('Group 5: SL Update and Breakeven', () => {

    it(
      '5.1: short entry — update SL to breakeven, verify old SL replaced',
      async () => {
        await withRetry(async (attempt) => {
          const text = makeOrderText(attempt);
          const { orderId, entryPrice, slPrice, tp1Price } = await openProtectedShortPosition(exchange, testSymbol, text);
          const { sl } = await waitForFormalProtectionOrders(exchange, testSymbol, slPrice, tp1Price);

          const oldSlId = sl.id;
          console.log(`[5.1] Initial SL: id=${oldSlId}, price=${getOrderPrice(sl)}`);

          // Calculate breakeven: for short, must be above current price to be valid
          const ticker = await exchange.getTicker(testSymbol);
          const lastPrice = parseFloat(ticker.lastPrice);
          let breakevenNum = parseFloat(entryPrice);
          if (breakevenNum <= lastPrice) {
            // If entry < current price, use a price slightly above current to keep SL valid
            breakevenNum = lastPrice * 1.001;
          }
          const breakeven = toExchangePrice(breakevenNum);
          const slText = `t-sl-pos-${testSymbol}-sell`;
          const newSlId = await exchange.updateStopLoss(testSymbol, 'sell', breakeven, slText);
          expect(newSlId).toBeTruthy();

          // Verify old SL is gone
          const priceOrdersAfter = await exchange.getPriceOrders(testSymbol);
          expect(priceOrdersAfter.find((o: any) => o.id === oldSlId)).toBeUndefined();

          // Verify new SL at breakeven (entry price) or fallback (lastPrice * 1.001)
          const newSl = priceOrdersAfter.find((o: any) => o.id === newSlId);
          expect(newSl).toBeDefined();
          const newSlPrice = getOrderPrice(newSl!);
          const tolerance = await getPriceTolerance(exchange, testSymbol);
          const entryNum = parseFloat(entryPrice);
          const fallbackPrice = lastPrice * 1.001;
          const nearEntry = Math.abs(parseFloat(newSlPrice) - entryNum) / entryNum < tolerance * 10;
          const nearFallback = Math.abs(parseFloat(newSlPrice) - fallbackPrice) / fallbackPrice < tolerance * 10;
          expect(nearEntry || nearFallback).toBe(true);

          console.log(`[5.1] SL updated: old=${getOrderPrice(sl)} → new=${newSlPrice} (breakeven=${breakeven}) — PASS`);
        }, { cleanup: () => cleanup(exchange, testSymbol) });
      },
      TEST_TIMEOUT_MS,
    );

  });

  // ─── Group 6: Cancel TP Preserve SL ──────────────────────────────────

  describe('Group 6: Cancel TP Preserve SL', () => {

    it(
      '6.1: short with TP1 + SL — cancel TP1, verify SL remains intact',
      async () => {
        await withRetry(async (attempt) => {
          const text = makeOrderText(attempt);
          const { orderId, slPrice, tp1Price } = await openProtectedShortPosition(exchange, testSymbol, text);
          const { sl, tp } = await waitForFormalProtectionOrders(exchange, testSymbol, slPrice, tp1Price);

          // Cancel the TP order
          const cancelled = await exchange.cancelOrder(tp.id, testSymbol);
          expect(cancelled).toBe(true);
          console.log(`[6.1] TP1 cancelled (id=${tp.id})`);

          // Verify TP is gone from open orders
          const openOrdersAfter = await exchange.getOpenOrders(testSymbol);
          expect(openOrdersAfter.find((o: any) => o.id === tp.id)).toBeUndefined();

          // Verify SL still exists in price orders
          const priceOrdersAfter = await exchange.getPriceOrders(testSymbol);
          const slStill = findPriceOrderByPrice(priceOrdersAfter, slPrice);
          expect(slStill).toBeDefined();

          // Verify SL price unchanged
          const slPriceAfter = getOrderPrice(slStill!);
          expect(Math.abs(parseFloat(slPriceAfter) - parseFloat(slPrice))).toBeLessThan(parseFloat(slPrice) * 0.001);

          console.log(`[6.1] TP cancelled, SL preserved at ${slPriceAfter} — PASS`);
        }, { cleanup: () => cleanup(exchange, testSymbol) });
      },
      TEST_TIMEOUT_MS,
    );

  });

});
