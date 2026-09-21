import 'dotenv/config';
import { IExchange } from '../../src/services/exchanges/IExchange';
import { SYMBOL, makeOrderText, toExchangePrice } from './helpers/priceUtils';
import {
  DeterministicGateFixture,
  cleanupDeterministicGate,
  createDeterministicGateFixture,
  openMarketPosition,
  placeProtectionOrders,
  resetDeterministicGateDb,
  verifyCleanDeterministicGate,
  waitForFlatPosition,
  waitForTpSlOrders,
} from './helpers/deterministicGate';

describe('GateIO deterministic e2e — scripted ticks', () => {
  let fixture: DeterministicGateFixture;
  let exchange: IExchange;

  beforeEach(async () => {
    await resetDeterministicGateDb();
  });

  afterEach(async () => {
    if (exchange) {
      await cleanupDeterministicGate(exchange);
      await verifyCleanDeterministicGate(exchange);
    }
    await fixture?.stop();
  });

  it('market long creates protection and closes on scripted TP tick', async () => {
    fixture = await createDeterministicGateFixture('long-tp', '0.6000');
    exchange = fixture.exchange;

    const text = makeOrderText(1);
    const { entryPrice } = await openMarketPosition(exchange, 'buy', text);
    const { slPrice, tpPrice } = await placeProtectionOrders(exchange, 'buy', '1', entryPrice, text);

    await waitForTpSlOrders(exchange, slPrice, tpPrice);
    fixture.injectPrice(tpPrice);

    await waitForFlatPosition(exchange);
    expect(await exchange.getPriceOrders(SYMBOL)).toEqual([]);
  });

  it('market long creates protection and closes on scripted SL tick', async () => {
    fixture = await createDeterministicGateFixture('long-sl', '0.6000');
    exchange = fixture.exchange;

    const text = makeOrderText(2);
    const { entryPrice } = await openMarketPosition(exchange, 'buy', text);
    const { slPrice, tpPrice } = await placeProtectionOrders(exchange, 'buy', '1', entryPrice, text);

    await waitForTpSlOrders(exchange, slPrice, tpPrice);
    fixture.injectPrice(slPrice);

    await waitForFlatPosition(exchange);
    expect(await exchange.getOpenOrders(SYMBOL)).toEqual([]);
  });

  it('market short creates protection and closes on scripted TP tick', async () => {
    fixture = await createDeterministicGateFixture('short-tp', '0.6000');
    exchange = fixture.exchange;

    const text = makeOrderText(3);
    const { entryPrice } = await openMarketPosition(exchange, 'sell', text);
    const { slPrice, tpPrice } = await placeProtectionOrders(exchange, 'sell', '1', entryPrice, text);

    await waitForTpSlOrders(exchange, slPrice, tpPrice);
    fixture.injectPrice(tpPrice);

    await waitForFlatPosition(exchange);
    expect(await exchange.getPriceOrders(SYMBOL)).toEqual([]);
  });

  it('market short creates protection and closes on scripted SL tick', async () => {
    fixture = await createDeterministicGateFixture('short-sl', '0.6000');
    exchange = fixture.exchange;

    const text = makeOrderText(9);
    const { entryPrice } = await openMarketPosition(exchange, 'sell', text);
    const { slPrice, tpPrice } = await placeProtectionOrders(exchange, 'sell', '1', entryPrice, text);

    await waitForTpSlOrders(exchange, slPrice, tpPrice);
    fixture.injectPrice(slPrice);

    await waitForFlatPosition(exchange);
    expect(await exchange.getPriceOrders(SYMBOL)).toEqual([]);
  });

  it('fills a limit buy only after a scripted crossing tick', async () => {
    fixture = await createDeterministicGateFixture('limit-buy', '0.6000');
    exchange = fixture.exchange;

    const order = await exchange.placeOrder({
      symbol: SYMBOL,
      side: 'buy',
      amount: '1',
      type: 'limit',
      price: '0.5990',
      text: makeOrderText(4),
    });

    expect(order.status).toBe('open');
    await expect(exchange.getOpenOrders(SYMBOL)).resolves.toEqual([
      expect.objectContaining({ id: order.id, status: 'open', price: '0.5990' }),
    ]);

    const fill = exchange.waitForOrderFill(order.id, SYMBOL, 2_000);
    fixture.injectPrice('0.5990');

    await expect(fill).resolves.toEqual(expect.objectContaining({
      id: order.id,
      status: 'filled',
      price: '0.599',
    }));
  });

  it('fills a limit sell only after a scripted crossing tick', async () => {
    fixture = await createDeterministicGateFixture('limit-sell', '0.6000');
    exchange = fixture.exchange;

    const order = await exchange.placeOrder({
      symbol: SYMBOL,
      side: 'sell',
      amount: '1',
      type: 'limit',
      price: '0.6010',
      text: makeOrderText(5),
    });

    expect(order.status).toBe('open');
    await expect(exchange.getOpenOrders(SYMBOL)).resolves.toEqual([
      expect.objectContaining({ id: order.id, status: 'open', price: '0.6010' }),
    ]);

    const fill = exchange.waitForOrderFill(order.id, SYMBOL, 2_000);
    fixture.injectPrice('0.6010');

    await expect(fill).resolves.toEqual(expect.objectContaining({
      id: order.id,
      status: 'filled',
      price: '0.601',
    }));
  });

  it('fills a limit buy then places TP/SL protection', async () => {
    fixture = await createDeterministicGateFixture('limit-tpsl', '0.6000');
    exchange = fixture.exchange;

    const text = makeOrderText(10);
    const entryPrice = '0.5990';
    await exchange.setLeverage(SYMBOL, '10');
    const order = await exchange.placeOrder({
      symbol: SYMBOL, side: 'buy', amount: '1', type: 'limit',
      price: entryPrice, text,
    });
    expect(order.status).toBe('open');

    const fill = exchange.waitForOrderFill(order.id, SYMBOL, 2_000);
    fixture.injectPrice('0.5990');
    await expect(fill).resolves.toEqual(expect.objectContaining({ status: 'filled' }));

    const position = await exchange.getPosition(SYMBOL);
    expect(position).not.toBeNull();
    expect(Number(position!.size)).toBeGreaterThan(0);

    const { slPrice, tpPrice } = await placeProtectionOrders(exchange, 'buy', '1', position!.entryPrice, text);
    await waitForTpSlOrders(exchange, slPrice, tpPrice);

    fixture.injectPrice(tpPrice);
    await waitForFlatPosition(exchange);
    expect(await exchange.getPriceOrders(SYMBOL)).toEqual([]);
  });

  it('moves long stop loss to breakeven and closes on scripted breakeven tick', async () => {
    fixture = await createDeterministicGateFixture('breakeven-sl', '0.6000');
    exchange = fixture.exchange;

    const text = makeOrderText(6);
    const { entryPrice } = await openMarketPosition(exchange, 'buy', text);
    const { slPrice, tpPrice } = await placeProtectionOrders(exchange, 'buy', '1', entryPrice, text);
    const { sl: oldSl } = await waitForTpSlOrders(exchange, slPrice, tpPrice);

    const priceOrdersBefore = await exchange.getPriceOrders(SYMBOL);
    const slCountBefore = priceOrdersBefore.length;

    // Use the same SL text prefix so cancelExistingStopLossOrders finds the old one
    const breakeven = toExchangePrice(Number(entryPrice));
    const slText = `t-sl-ord-${text}`;
    const updatedId = await exchange.updateStopLoss(SYMBOL, 'buy', breakeven, slText);
    expect(updatedId).toEqual(expect.stringMatching(/^vo-/));

    // updateStopLoss must replace the old SL — count stays the same, old ID gone
    const priceOrdersAfter = await exchange.getPriceOrders(SYMBOL);
    expect(priceOrdersAfter.length).toBe(slCountBefore);
    expect(priceOrdersAfter.find(o => o.id === oldSl.id)).toBeUndefined();

    const updatedSL = priceOrdersAfter.find(o => o.id === updatedId);
    expect(updatedSL).toEqual(expect.objectContaining({
      id: updatedId,
      trigger: expect.objectContaining({ price: breakeven }),
      initial: expect.objectContaining({ text: slText, reduce_only: true }),
    }));

    fixture.injectPrice(breakeven);
    await waitForFlatPosition(exchange);
  });

  it('cancels TP while preserving SL', async () => {
    fixture = await createDeterministicGateFixture('cancel-tp', '0.6000');
    exchange = fixture.exchange;

    const text = makeOrderText(7);
    const { entryPrice } = await openMarketPosition(exchange, 'buy', text);
    const { slPrice, tpPrice } = await placeProtectionOrders(exchange, 'buy', '1', entryPrice, text);
    const { tp } = await waitForTpSlOrders(exchange, slPrice, tpPrice);

    await expect(exchange.cancelOrder(tp.id, SYMBOL)).resolves.toBe(true);
    await expect(exchange.getOpenOrders(SYMBOL)).resolves.toEqual([]);

    const priceOrders = await exchange.getPriceOrders(SYMBOL);
    expect(priceOrders).toHaveLength(1);
    expect(priceOrders[0]).toEqual(expect.objectContaining({
      trigger: expect.objectContaining({ price: slPrice }),
      reduce_only: true,
      is_reduce_only: true,
    }));
  });

  it('uses Gate-compatible TP and SL text prefixes', async () => {
    fixture = await createDeterministicGateFixture('text-prefix', '0.6000');
    exchange = fixture.exchange;

    const text = makeOrderText(8);
    const { entryPrice } = await openMarketPosition(exchange, 'buy', text);
    const { slPrice, tpPrice } = await placeProtectionOrders(exchange, 'buy', '1', entryPrice, text);
    const { sl, tp } = await waitForTpSlOrders(exchange, slPrice, tpPrice);

    const slText = String(sl.text || sl.initial?.text || '');
    expect(slText.startsWith('t-sl-ord-')).toBe(true);
    expect(slText.length).toBeLessThanOrEqual(30);

    const tpText = String(tp.text || tp.raw?.text || tp.initial?.text || '');
    expect(tpText.startsWith('t-tp-')).toBe(true);
    expect(tpText.length).toBeLessThanOrEqual(30);
  });

  it('keeps ticker values sourced from scripted Gate ticks', async () => {
    fixture = await createDeterministicGateFixture('ticker', '0.6000');
    exchange = fixture.exchange;

    fixture.injectPrice('0.6123');

    await expect(exchange.getTicker(SYMBOL)).resolves.toEqual(expect.objectContaining({
      symbol: SYMBOL,
      lastPrice: '0.6123',
      markPrice: '0.6123',
      indexPrice: '0.6123',
    }));
  });

  // ─── Boundary / error scenarios ────────────────────────────────────────

  it('throws on market order when no tick exists', async () => {
    // Create fixture without injecting an initial price
    fixture = await createDeterministicGateFixture('no-tick', '');
    exchange = fixture.exchange;

    await expect(exchange.placeOrder({
      symbol: SYMBOL, side: 'buy', amount: '1', type: 'market', text: makeOrderText(11),
    })).rejects.toThrow(/No market price/);
  });

  it('throws on market order when tick is stale', async () => {
    fixture = await createDeterministicGateFixture('stale-tick', '0.6000', 100);
    exchange = fixture.exchange;

    // Wait for the short maxTickAgeMs to expire
    await new Promise(r => setTimeout(r, 200));

    await expect(exchange.placeOrder({
      symbol: SYMBOL, side: 'buy', amount: '1', type: 'market', text: makeOrderText(12),
    })).rejects.toThrow(/stale market price/);
  });

  it('returns false when cancelling an already-cancelled order', async () => {
    fixture = await createDeterministicGateFixture('double-cancel', '0.6000');
    exchange = fixture.exchange;

    const order = await exchange.placeOrder({
      symbol: SYMBOL, side: 'buy', amount: '1', type: 'limit', price: '0.5900', text: makeOrderText(13),
    });
    expect(order.status).toBe('open');

    const first = await exchange.cancelOrder(order.id, SYMBOL);
    expect(first).toBe(true);

    const second = await exchange.cancelOrder(order.id, SYMBOL);
    expect(second).toBe(false);
  });

  it('closePosition is a no-op when no position exists', async () => {
    fixture = await createDeterministicGateFixture('no-position-close', '0.6000');
    exchange = fixture.exchange;

    const result = await exchange.closePosition(SYMBOL, 'sell');
    expect(result).toBe(true);

    const position = await exchange.getPosition(SYMBOL);
    expect(position).toBeNull();
  });
});
