// tests/e2e/GateIOMockedE2E.Test.ts
import 'dotenv/config';
import { sequelize, Order, PendingProtection } from '../../src/models';
import { MockedGateFixture, createMockedGateExchange } from './helpers/mockedGate';
import { SYMBOL, makeOrderText, toExchangePrice } from './helpers/priceUtils';
import { buildTakeProfitOrderText } from '../../src/utils/orderText';

/** Poll until condition is true or timeout. More reliable than fixed setTimeout. */
async function waitFor(
  condition: () => boolean | Promise<boolean>,
  timeoutMs = 5000,
  intervalMs = 100,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await condition()) return;
    await new Promise(r => setTimeout(r, intervalMs));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

/** Find the SL price order in the priceOrders list (position-level SL uses rule 2 for long, rule 1 for short). */
function findSlOrder(priceOrders: any[], side: 'buy' | 'sell'): any | undefined {
  const slRule = side === 'buy' ? 2 : 1;
  return priceOrders.find(o =>
    o.trigger?.rule === slRule || (o.text && o.text.includes('-sl-'))
  );
}

describe('GateIO mocked e2e — real exchange logic with mocked I/O', () => {
  let fixture: MockedGateFixture;

  beforeEach(async () => {
    await sequelize.sync({ force: true });
  });

  afterEach(async () => {
    if (fixture) {
      const { exchange } = fixture;
      // Clean up mock store
      const openOrders = await exchange.getOpenOrders(SYMBOL);
      for (const o of openOrders) {
        await exchange.cancelOrder(o.id, SYMBOL);
      }
      const priceOrders = await exchange.getPriceOrders(SYMBOL);
      for (const o of priceOrders) {
        await exchange.cancelPriceOrder(o.id, SYMBOL);
      }
    }
  });

  afterAll(async () => {
    await sequelize.close();
  });

  // ─── Scenario 1: Market order open + WS fill + SL/TP placement ─────────

  it('market buy fills immediately, triggers SL/TP placement via WS event', async () => {
    fixture = await createMockedGateExchange('market-open-long', '0.6000');
    const { exchange, mockWs } = fixture;

    const text = makeOrderText(1);
    // Cross margin (leverage='0') — placeOrder enforces this before opening orders
    await exchange.setLeverage(SYMBOL, '0');

    const result = await exchange.placeOrder({
      symbol: SYMBOL,
      side: 'buy',
      amount: '1',
      type: 'market',
      text,
      stopLoss: toExchangePrice(0.6000 * (1 - 0.003)),
      takeProfit: toExchangePrice(0.6000 * (1 + 0.003)),
    });

    expect(result.status).toBe('finished');
    expect(result.id).toBeTruthy();

    // Create a DB Order so the persistence handler can find it
    await Order.create({
      symbol: SYMBOL,
      side: 'buy',
      amount: '1',
      type: 'market',
      lifecycleStatus: 'INIT',
      exchangeOrderId: result.id,
    });

    // Simulate WS fill event → triggers full pipeline:
    // WSEventRouter → handleWsOrderUpdate → OrderPersistenceHandler → ProtectionPipeline
    mockWs.simulateFill(result.id, '0.6', 1, text, false, SYMBOL);

    // Wait for SL/TP to be placed (observable outcome of the async pipeline)
    await waitFor(async () => {
      const priceOrders = await exchange.getPriceOrders(SYMBOL);
      return priceOrders.length >= 1;
    });

    // Verify SL/TP orders were placed via mock REST
    const priceOrders = await exchange.getPriceOrders(SYMBOL);
    expect(priceOrders.length).toBeGreaterThanOrEqual(1);

    // Verify DB order updated — check lifecycle status moved past INIT
    const updatedOrder = await Order.findOne({ where: { exchangeOrderId: result.id } });
    expect(updatedOrder).not.toBeNull();
    expect(['OPEN', 'PROTECTED']).toContain(updatedOrder!.lifecycleStatus);
  });

  // ─── Scenario 2: Limit order open + WS fill after delay ──────────────────

  it('limit buy stays open until WS fill event, then places SL/TP', async () => {
    fixture = await createMockedGateExchange('limit-open-long', '0.6000');
    const { exchange, mockWs, mockRest } = fixture;
    mockRest.setLastPrice(SYMBOL, '0.6000');

    const text = makeOrderText(2);
    await exchange.setLeverage(SYMBOL, '0');

    const result = await exchange.placeOrder({
      symbol: SYMBOL,
      side: 'buy',
      amount: '1',
      type: 'limit',
      price: '0.5990',
      text,
      stopLoss: toExchangePrice(0.5990 * (1 - 0.003)),
      takeProfit: toExchangePrice(0.5990 * (1 + 0.003)),
    });

    expect(result.status).toBe('open');
    expect(result.id).toBeTruthy();

    // Create DB order so persistence handler can find it
    await Order.create({
      symbol: SYMBOL, side: 'buy', amount: '1', type: 'limit',
      lifecycleStatus: 'INIT', exchangeOrderId: result.id,
    });

    // Register fill listener (simulates waitForOrderFill)
    const fillPromise = exchange.waitForOrderFill(result.id, SYMBOL, 5000);

    // Simulate WS fill event
    mockWs.simulateFill(result.id, '0.599', 1, text, false, SYMBOL);

    const fillResult = await fillPromise;
    expect(fillResult).toBeTruthy();

    // Update the mock position store (in the real system, the WS event handler
    // would eventually call getPosition which returns updated data)
    mockRest.setPosition(SYMBOL, '1', '0.599', '0', 'cross');

    // Wait for SL/TP placement
    await waitFor(async () => {
      const priceOrders = await exchange.getPriceOrders(SYMBOL);
      return priceOrders.length >= 1;
    });

    // Verify position exists
    const position = await exchange.getPosition(SYMBOL);
    expect(position).not.toBeNull();
    expect(parseFloat(position!.size)).toBeGreaterThan(0);
  });

  // ─── Scenario 3: SL trigger + position close cancels remaining TP ────────

  it('SL fill + position close cancels remaining TP', async () => {
    fixture = await createMockedGateExchange('sl-trigger-close', '0.6000');
    const { exchange, mockWs } = fixture;

    const text = makeOrderText(3);
    await exchange.setLeverage(SYMBOL, '0');

    // Open position
    const openResult = await exchange.placeOrder({
      symbol: SYMBOL, side: 'buy', amount: '1', type: 'market', text,
      stopLoss: toExchangePrice(0.6000 * (1 - 0.003)),
      takeProfit: toExchangePrice(0.6000 * (1 + 0.003)),
    });
    expect(openResult.status).toBe('finished');

    // Create DB order (OPEN with filledPrice so moveStopLossToBreakeven can read entry price)
    await Order.create({
      symbol: SYMBOL, side: 'buy', amount: '1', type: 'market',
      lifecycleStatus: 'OPEN', exchangeOrderId: openResult.id,
      filledPrice: '0.6',
    });

    // Simulate fill event to trigger protection placement
    mockWs.simulateFill(openResult.id, '0.6', 1, text, false, SYMBOL);

    // Wait for SL/TP to be placed
    await waitFor(async () => {
      const priceOrders = await exchange.getPriceOrders(SYMBOL);
      return priceOrders.length >= 1;
    });

    // Find the SL order (position-level SL text: t-sl-pos-{symbol}-{side})
    const priceOrdersBefore = await exchange.getPriceOrders(SYMBOL);
    const slOrder = findSlOrder(priceOrdersBefore, 'buy');
    expect(slOrder).toBeTruthy();

    // Simulate SL fill event (reduce-only) — use position-level SL text format
    const slText = `t-sl-pos-${SYMBOL}-buy`;
    mockWs.simulateFill(slOrder!.id, '0.5982', 1, slText, true, SYMBOL);

    // Simulate position close event
    mockWs.simulatePositionClose(SYMBOL);

    // Wait for all price orders to be cleaned up
    await waitFor(async () => {
      const priceOrders = await exchange.getPriceOrders(SYMBOL);
      return priceOrders.length === 0;
    }, 8000);
  });

  // ─── Scenario 4: Single TP fill + SL move to breakeven ─────────────────

  it('single TP fill moves SL to breakeven', async () => {
    fixture = await createMockedGateExchange('tp1-breakeven', '0.6000');
    const { exchange, mockWs, mockRest } = fixture;
    mockRest.setLastPrice(SYMBOL, '0.6000');

    const text = makeOrderText(4);
    await exchange.setLeverage(SYMBOL, '0');

    const entryPrice = '0.6000';
    const slPrice = toExchangePrice(parseFloat(entryPrice) * (1 - 0.003));
    const tpPrice = toExchangePrice(parseFloat(entryPrice) * (1 + 0.003));

    // Open position
    const openResult = await exchange.placeOrder({
      symbol: SYMBOL, side: 'buy', amount: '1', type: 'market', text,
      stopLoss: slPrice,
      takeProfit: tpPrice,
    });
    expect(openResult.status).toBe('finished');

    // Create DB order (OPEN with filledPrice so moveStopLossToBreakeven can read entry price)
    await Order.create({
      symbol: SYMBOL, side: 'buy', amount: '1', type: 'market',
      lifecycleStatus: 'OPEN', exchangeOrderId: openResult.id,
      filledPrice: entryPrice,
    });

    // Wait for SL to be placed

    // Trigger protection placement via WS fill event
    mockWs.simulateFill(openResult.id, entryPrice, 1, text, false, SYMBOL);

    // Wait for SL/TP to be placed
    await waitFor(async () => {
      const priceOrders = await exchange.getPriceOrders(SYMBOL);
      return priceOrders.some(o => o.trigger?.rule === 2 || (o.text && o.text.includes('-sl-')));
    });

    // Find the TP order placed by ProtectionPipeline — it uses buildTakeProfitOrderText
    const openOrdersBefore = await exchange.getOpenOrders(SYMBOL);
    const tpOrder = openOrdersBefore.find(o =>
      o.text && o.text.includes('-tp-') && o.text.includes(`-ord-${openResult.id}`)
    );
    expect(tpOrder).toBeTruthy();

    // Simulate TP1 fill — use the actual TP order ID and buildTakeProfitOrderText format
    // so extractLinkedOrderIdFromText can parse the orderId correctly
    const tp1Text = buildTakeProfitOrderText(1, openResult.id);
    mockWs.simulateFill(tpOrder!.id, tpPrice, 1, tp1Text, true, SYMBOL);

    // Wait for SL to move to breakeven — tolerance < 0.0001 to distinguish
    // entry price (0.6000) from initial SL price (0.5982, diff=0.0018)
    await waitFor(async () => {
      const priceOrders = await exchange.getPriceOrders(SYMBOL);
      const sl = findSlOrder(priceOrders, 'buy');
      if (!sl) return false;
      const slP = sl.trigger?.price || sl.price;
      return Math.abs(parseFloat(slP) - parseFloat(entryPrice)) < 0.0001;
    }, 8000);
  });

  // ─── Scenario 4b: Two TPs — TP1 breakeven, TP2 no change ──────────────

  it('two TPs: TP1 fill moves SL to breakeven, TP2 fill keeps SL', async () => {
    fixture = await createMockedGateExchange('two-tp', '0.6000');
    const { exchange, mockWs, mockRest } = fixture;
    mockRest.setLastPrice(SYMBOL, '0.6000');

    const text = makeOrderText(5);
    await exchange.setLeverage(SYMBOL, '0');

    const entryPrice = '0.6000';
    const slPrice = toExchangePrice(parseFloat(entryPrice) * (1 - 0.003));
    const tp1Price = toExchangePrice(parseFloat(entryPrice) * (1 + 0.003));
    const tp2Price = toExchangePrice(parseFloat(entryPrice) * (1 + 0.006));

    // Open position with 2 TPs
    const openResult = await exchange.placeOrder({
      symbol: SYMBOL, side: 'buy', amount: '2', type: 'market', text,
      stopLoss: slPrice,
      tpOrders: [
        { price: tp1Price, amount: '1' },
        { price: tp2Price, amount: '1' },
      ],
    });
    expect(openResult.status).toBe('finished');

    // Create DB order (OPEN with filledPrice so moveStopLossToBreakeven can read entry price)
    await Order.create({
      symbol: SYMBOL, side: 'buy', amount: '2', type: 'market',
      lifecycleStatus: 'OPEN', exchangeOrderId: openResult.id,
      filledPrice: entryPrice,
    });

    // Trigger protection placement
    mockWs.simulateFill(openResult.id, entryPrice, 2, text, false, SYMBOL);

    // Wait for SL/TP to be placed
    await waitFor(async () => {
      const priceOrders = await exchange.getPriceOrders(SYMBOL);
      return priceOrders.some(o => o.trigger?.rule === 2 || (o.text && o.text.includes('-sl-')));
    });

    // Find TP orders placed by ProtectionPipeline
    const openOrdersBefore = await exchange.getOpenOrders(SYMBOL);
    const tp1Order = openOrdersBefore.find(o =>
      o.text && o.text === buildTakeProfitOrderText(1, openResult.id)
    );
    const tp2Order = openOrdersBefore.find(o =>
      o.text && o.text === buildTakeProfitOrderText(2, openResult.id)
    );
    expect(tp1Order).toBeTruthy();
    expect(tp2Order).toBeTruthy();

    // --- TP1 fill — use actual order ID and buildTakeProfitOrderText format ---
    const tp1Text = buildTakeProfitOrderText(1, openResult.id);
    mockWs.simulateFill(tp1Order!.id, tp1Price, 1, tp1Text, true, SYMBOL);

    // Wait for SL to move to breakeven after TP1 (tolerance < 0.0001)
    await waitFor(async () => {
      const priceOrders = await exchange.getPriceOrders(SYMBOL);
      const sl = findSlOrder(priceOrders, 'buy');
      if (!sl) return false;
      const slP = sl.trigger?.price || sl.price;
      return Math.abs(parseFloat(slP) - parseFloat(entryPrice)) < 0.0001;
    }, 8000);

    // Record SL price after TP1
    const priceOrdersAfterTp1 = await exchange.getPriceOrders(SYMBOL);
    const slAfterTp1 = findSlOrder(priceOrdersAfterTp1, 'buy');
    expect(slAfterTp1).toBeTruthy();
    const slPriceAfterTp1 = slAfterTp1!.trigger?.price || slAfterTp1!.price;

    // --- TP2 fill — SL should not move further ---
    const tp2Text = buildTakeProfitOrderText(2, openResult.id);
    mockWs.simulateFill(tp2Order!.id, tp2Price, 1, tp2Text, true, SYMBOL);
    await new Promise(r => setTimeout(r, 1000));

    // SL should stay at breakeven (no further move)
    const priceOrdersAfterTp2 = await exchange.getPriceOrders(SYMBOL);
    const slAfterTp2 = findSlOrder(priceOrdersAfterTp2, 'buy');
    expect(slAfterTp2).toBeTruthy();
    const slPriceAfterTp2 = slAfterTp2!.trigger?.price || slAfterTp2!.price;
    expect(slPriceAfterTp2).toBe(slPriceAfterTp1);
  });

  // ─── Scenario 4c: Three TPs — TP1 breakeven, TP2/TP3 no change, full close

  it('three TPs: TP1 breakeven, TP2/TP3 keep SL, full close cancels SL', async () => {
    fixture = await createMockedGateExchange('three-tp', '0.6000');
    const { exchange, mockWs, mockRest } = fixture;
    mockRest.setLastPrice(SYMBOL, '0.6000');

    const text = makeOrderText(6);
    await exchange.setLeverage(SYMBOL, '0');

    const entryPrice = '0.6000';
    const slPrice = toExchangePrice(parseFloat(entryPrice) * (1 - 0.003));
    const tp1Price = toExchangePrice(parseFloat(entryPrice) * (1 + 0.003));
    const tp2Price = toExchangePrice(parseFloat(entryPrice) * (1 + 0.006));
    const tp3Price = toExchangePrice(parseFloat(entryPrice) * (1 + 0.009));

    const openResult = await exchange.placeOrder({
      symbol: SYMBOL, side: 'buy', amount: '3', type: 'market', text,
      stopLoss: slPrice,
      tpOrders: [
        { price: tp1Price, amount: '1' },
        { price: tp2Price, amount: '1' },
        { price: tp3Price, amount: '1' },
      ],
    });
    expect(openResult.status).toBe('finished');

    await Order.create({
      symbol: SYMBOL, side: 'buy', amount: '3', type: 'market',
      lifecycleStatus: 'OPEN', exchangeOrderId: openResult.id,
      filledPrice: entryPrice,
    });

    // Trigger protection placement
    mockWs.simulateFill(openResult.id, entryPrice, 3, text, false, SYMBOL);

    // Wait for SL to be placed
    await waitFor(async () => {
      const priceOrders = await exchange.getPriceOrders(SYMBOL);
      return priceOrders.some(o => o.trigger?.rule === 2 || (o.text && o.text.includes('-sl-')));
    });

    // Find TP orders placed by ProtectionPipeline
    const openOrdersBefore = await exchange.getOpenOrders(SYMBOL);
    const tp1Order = openOrdersBefore.find(o =>
      o.text && o.text === buildTakeProfitOrderText(1, openResult.id)
    );
    const tp2Order = openOrdersBefore.find(o =>
      o.text && o.text === buildTakeProfitOrderText(2, openResult.id)
    );
    const tp3Order = openOrdersBefore.find(o =>
      o.text && o.text === buildTakeProfitOrderText(3, openResult.id)
    );
    expect(tp1Order).toBeTruthy();
    expect(tp2Order).toBeTruthy();
    expect(tp3Order).toBeTruthy();

    // TP1 → breakeven (tolerance < 0.0001)
    const tp1Text = buildTakeProfitOrderText(1, openResult.id);
    mockWs.simulateFill(tp1Order!.id, tp1Price, 1, tp1Text, true, SYMBOL);

    await waitFor(async () => {
      const priceOrders = await exchange.getPriceOrders(SYMBOL);
      const sl = findSlOrder(priceOrders, 'buy');
      if (!sl) return false;
      const slP = sl.trigger?.price || sl.price;
      return Math.abs(parseFloat(slP) - parseFloat(entryPrice)) < 0.0001;
    }, 8000);

    let priceOrders = await exchange.getPriceOrders(SYMBOL);
    let sl = findSlOrder(priceOrders, 'buy');
    const slPriceAfterTp1 = sl!.trigger?.price || sl!.price;

    // TP2 → SL stays at breakeven
    const tp2Text = buildTakeProfitOrderText(2, openResult.id);
    mockWs.simulateFill(tp2Order!.id, tp2Price, 1, tp2Text, true, SYMBOL);
    await new Promise(r => setTimeout(r, 1000));

    priceOrders = await exchange.getPriceOrders(SYMBOL);
    sl = findSlOrder(priceOrders, 'buy');
    expect(sl).toBeTruthy();
    const slPriceAfterTp2 = sl!.trigger?.price || sl!.price;
    expect(slPriceAfterTp2).toBe(slPriceAfterTp1);

    // TP3 → all TPs filled, position closes
    const tp3Text = buildTakeProfitOrderText(3, openResult.id);
    mockWs.simulateFill(tp3Order!.id, tp3Price, 1, tp3Text, true, SYMBOL);
    mockWs.simulatePositionClose(SYMBOL);

    // Wait for all price orders to be cancelled
    await waitFor(async () => {
      const priceOrders = await exchange.getPriceOrders(SYMBOL);
      return priceOrders.length === 0;
    }, 8000);
  });

  // ─── Scenario 5: Manual position close cancels all SL/TP ───────────────

  it('manual closePosition cancels all associated SL/TP orders', async () => {
    fixture = await createMockedGateExchange('manual-close', '0.6000');
    const { exchange, mockWs, mockRest } = fixture;
    mockRest.setLastPrice(SYMBOL, '0.6000');

    const text = makeOrderText(7);
    await exchange.setLeverage(SYMBOL, '0');

    const entryPrice = '0.6000';
    const slPrice = toExchangePrice(parseFloat(entryPrice) * (1 - 0.003));
    const tp1Price = toExchangePrice(parseFloat(entryPrice) * (1 + 0.003));
    const tp2Price = toExchangePrice(parseFloat(entryPrice) * (1 + 0.006));

    // Open with 2 TPs
    const openResult = await exchange.placeOrder({
      symbol: SYMBOL, side: 'buy', amount: '2', type: 'market', text,
      stopLoss: slPrice,
      tpOrders: [
        { price: tp1Price, amount: '1' },
        { price: tp2Price, amount: '1' },
      ],
    });
    expect(openResult.status).toBe('finished');

    await Order.create({
      symbol: SYMBOL, side: 'buy', amount: '2', type: 'market',
      lifecycleStatus: 'OPEN', exchangeOrderId: openResult.id,
      filledPrice: entryPrice,
    });

    // Trigger protection placement
    mockWs.simulateFill(openResult.id, entryPrice, 2, text, false, SYMBOL);

    // Wait for SL/TP to be placed
    await waitFor(async () => {
      const priceOrders = await exchange.getPriceOrders(SYMBOL);
      return priceOrders.length >= 1;
    });

    // Manual close position
    const closed = await exchange.closePosition(SYMBOL, 'sell');
    expect(closed).toBe(true);

    // Simulate WS events for the close order fill + position close
    const closeOrders = await exchange.getOpenOrders(SYMBOL);
    for (const o of closeOrders) {
      mockWs.simulateFill(o.id, '0.6', 2, o.text || '', true, SYMBOL);
    }
    mockWs.simulatePositionClose(SYMBOL);

    // Wait for all price orders to be cancelled
    await waitFor(async () => {
      const priceOrders = await exchange.getPriceOrders(SYMBOL);
      return priceOrders.length === 0;
    }, 8000);
  });

  // ─── Scenario 6: Update SL (cancel old, place new) ─────────────────────

  it('updateStopLoss cancels old SL and places new one', async () => {
    fixture = await createMockedGateExchange('update-sl', '0.6000');
    const { exchange, mockWs, mockRest } = fixture;
    mockRest.setLastPrice(SYMBOL, '0.6000');

    const text = makeOrderText(8);
    await exchange.setLeverage(SYMBOL, '0');

    const entryPrice = '0.6000';
    const slPrice = toExchangePrice(parseFloat(entryPrice) * (1 - 0.003));
    const tpPrice = toExchangePrice(parseFloat(entryPrice) * (1 + 0.003));

    // Open position
    const openResult = await exchange.placeOrder({
      symbol: SYMBOL, side: 'buy', amount: '1', type: 'market', text,
      stopLoss: slPrice, takeProfit: tpPrice,
    });
    expect(openResult.status).toBe('finished');

    await Order.create({
      symbol: SYMBOL, side: 'buy', amount: '1', type: 'market',
      lifecycleStatus: 'OPEN', exchangeOrderId: openResult.id,
    });

    // Trigger protection placement
    mockWs.simulateFill(openResult.id, entryPrice, 1, text, false, SYMBOL);

    // Wait for SL to be placed
    await waitFor(async () => {
      const priceOrders = await exchange.getPriceOrders(SYMBOL);
      return priceOrders.some(o => o.trigger?.rule === 2 || (o.text && o.text.includes('-sl-')));
    });

    // Find current SL
    const priceOrdersBefore = await exchange.getPriceOrders(SYMBOL);
    const slBefore = findSlOrder(priceOrdersBefore, 'buy');
    expect(slBefore).toBeTruthy();
    const oldSlId = slBefore!.id;

    // Update SL to breakeven — use position-level SL text to match the
    // SL that ProtectionPipeline placed (t-sl-pos-{symbol}-{side})
    const breakeven = toExchangePrice(parseFloat(entryPrice));
    const slText = `t-sl-pos-${SYMBOL}-buy`;
    const newSlId = await exchange.updateStopLoss(SYMBOL, 'buy', breakeven, slText);
    expect(newSlId).toBeTruthy();

    // Verify: old SL gone, new SL at breakeven (tolerance < 0.0001)
    const priceOrdersAfter = await exchange.getPriceOrders(SYMBOL);
    expect(priceOrdersAfter.find(o => o.id === oldSlId)).toBeUndefined();
    const newSl = priceOrdersAfter.find(o => o.id === newSlId);
    expect(newSl).toBeTruthy();
    const newSlPrice = newSl!.trigger?.price || newSl!.price;
    expect(Math.abs(parseFloat(newSlPrice) - parseFloat(breakeven))).toBeLessThan(0.0001);
  });

  // ─── Scenario 7: API error — no orphaned state ─────────────────────────

  it('createOrder API error does not leave orphaned PendingProtection', async () => {
    fixture = await createMockedGateExchange('api-error', '0.6000');
    const { exchange, mockRest } = fixture;
    mockRest.setLastPrice(SYMBOL, '0.6000');

    const text = makeOrderText(9);

    // Inject API error
    mockRest.setError('createOrder', {
      message: 'Insufficient margin',
      status: 400,
      label: 'INVALID_PARAM_VALUE',
    });

    await expect(exchange.placeOrder({
      symbol: SYMBOL, side: 'buy', amount: '1', type: 'market', text,
      stopLoss: '0.5982', takeProfit: '0.6018',
    })).rejects.toThrow();

    // Verify: no orphaned PendingProtection records for this order text
    const allPending = await PendingProtection.findAll();
    const orphaned = allPending.filter(p => p.orderId === text);
    expect(orphaned.length).toBe(0);
  });

  // ─── Scenario 8: WS fill triggers protection placement from PendingProtection ──

  it('WS fill correctly processes PendingProtection placed by placeOrder', async () => {
    fixture = await createMockedGateExchange('ws-race', '0.6000');
    const { exchange, mockWs, mockRest } = fixture;
    mockRest.setLastPrice(SYMBOL, '0.6000');

    const text = makeOrderText(10);
    await exchange.setLeverage(SYMBOL, '0');

    const entryPrice = '0.6000';
    const slPrice = toExchangePrice(parseFloat(entryPrice) * (1 - 0.003));
    const tpPrice = toExchangePrice(parseFloat(entryPrice) * (1 + 0.003));

    // placeOrder creates PendingProtection keyed by clientOrderId (text),
    // then migrates it to orderId after getting the REST response
    const result = await exchange.placeOrder({
      symbol: SYMBOL, side: 'buy', amount: '1', type: 'market', text,
      stopLoss: slPrice, takeProfit: tpPrice,
    });
    expect(result.status).toBe('finished');
    const orderId = result.id;
    const clientOrderId = text; // text was used as clientOrderId in placeOrder

    // Create DB order so persistence handler can find it
    await Order.create({
      symbol: SYMBOL, side: 'buy', amount: '1', type: 'market',
      lifecycleStatus: 'INIT', exchangeOrderId: orderId,
    });

    // Simulate WS fill — triggers handleOrderFilled which finds PendingProtection
    mockWs.simulateFill(orderId, entryPrice, 1, text, false, SYMBOL);

    // Wait for SL/TP to be placed (observable outcome)
    await waitFor(async () => {
      const priceOrders = await exchange.getPriceOrders(SYMBOL);
      return priceOrders.length >= 1;
    });

    // Verify: the old clientOrderId record was cleaned up
    const pendingByClientId = await PendingProtection.findByPk(clientOrderId);
    expect(pendingByClientId).toBeNull();
  });
});