// tests/e2e/tradfi-smoke.test.ts
// Mock-based integration smoke test for TradFi protection components.
// Verifies TradFiProtectionPipeline, TradFiTPScheduler, and isTradFiExchange wire together.

import { TradFiProtectionPipeline } from '../../src/services/exchanges/tradfi/TradFiProtectionPipeline';
import { TradFiTPScheduler } from '../../src/services/exchanges/tradfi/TradFiTPScheduler';
import { isTradFiExchange } from '../../src/utils/exchangeUtils';

describe('TradFi Integration Smoke Test', () => {

  // ── isTradFiExchange ─────────────────────────────────────────────────────

  it('should detect TradFi exchange by name', () => {
    expect(isTradFiExchange({ name: 'gate_tradfi' })).toBe(true);
    expect(isTradFiExchange({ name: 'gate_io' })).toBe(false);
    expect(isTradFiExchange(null)).toBe(false);
    expect(isTradFiExchange(undefined)).toBe(false);
  });

  it('should detect TradFi exchange by constructor name', () => {
    class TradFiExchange {}
    const ex = new TradFiExchange();
    expect(isTradFiExchange(ex)).toBe(true);
  });

  // ── Pipeline + Scheduler wiring ─────────────────────────────────────────

  it('should wire pipeline + scheduler together', async () => {
    // restClient is a separate constructor arg for TradFiProtectionPipeline
    const mockRestClient: any = {
      listPositions: jest.fn().mockResolvedValue([
        { position_id: 'pos-1', symbol: 'XAUUSD', position_dir: 'Long', volume: '0.1' },
      ]),
      modifyPosition: jest.fn().mockResolvedValue({ position_id: 'pos-1' }),
    };

    const mockExchange: any = {
      updateStopLoss: jest.fn().mockResolvedValue('sl-1'),
      getPosition: jest.fn().mockResolvedValue({
        symbol: 'XAUUSD', size: 0.1, price_sl: '0', price_tp: '0',
      }),
      closePosition: jest.fn().mockResolvedValue(true),
    };

    // PendingProtection model mock — claimProtection calls sequelize.query
    const mockPP: any = {
      sequelize: {
        query: jest.fn().mockResolvedValue([1, 1]), // affectedRows = 1
        QueryTypes: { UPDATE: 'UPDATE' },
      },
      findByPk: jest.fn().mockResolvedValue({
        update: jest.fn().mockResolvedValue(undefined),
        destroy: jest.fn().mockResolvedValue(undefined),
      }),
    };

    const mockOrder: any = {
      findOne: jest.fn(),
      findAll: jest.fn(),
    };

    const pipeline = new TradFiProtectionPipeline(mockExchange, mockPP, mockOrder, mockRestClient);
    const scheduler = new TradFiTPScheduler(mockExchange);
    pipeline.setTPScheduler(scheduler);

    const result = await pipeline.placeProtections({
      orderId: 'test-ord',
      symbol: 'XAUUSD',
      side: 'buy',
      stopLossPrice: '2000',
      tpOrders: [
        { price: '2200', amount: '0.05' },
        { price: '2300', amount: '0.03' },
        { price: '2400', amount: '0.02' },
      ],
      amount: '0.1',
      source: 'smoke-test',
      minOrderVolume: 0.01,
    });

    expect(result.slPlaced).toBe(true);
    expect(result.tpPlaced).toBe(true);
    expect(result.claimed).toBe(true);

    // SL placed via exchange.updateStopLoss
    expect(mockExchange.updateStopLoss).toHaveBeenCalledWith('XAUUSD', 'buy', '2000');

    // TP1 set via restClient.modifyPosition (embedded in position)
    expect(mockRestClient.modifyPosition).toHaveBeenCalledWith('pos-1', { price_tp: '2200' });

    // TP2/TP3 registered with scheduler
    expect(scheduler.getPendingTPCount('XAUUSD', 'buy')).toBe(2);

    // Simulate ticker hitting TP2 price (2300)
    await scheduler.onTickerUpdate('XAUUSD', 2310);
    expect(mockExchange.closePosition).toHaveBeenCalledWith('XAUUSD', 'buy', undefined, '0.03');
    expect(scheduler.getPendingTPCount('XAUUSD', 'buy')).toBe(1);

    // Simulate ticker hitting TP3 price (2400)
    await scheduler.onTickerUpdate('XAUUSD', 2410);
    expect(mockExchange.closePosition).toHaveBeenCalledWith('XAUUSD', 'buy', undefined, '0.02');
    expect(scheduler.getPendingTPCount('XAUUSD', 'buy')).toBe(0);
  });

  // ── Move SL to breakeven ────────────────────────────────────────────────

  it('should move SL to breakeven', async () => {
    const mockRestClient: any = {
      listPositions: jest.fn().mockResolvedValue([
        { position_id: 'pos-1', symbol: 'XAUUSD', position_dir: 'Long', volume: '0.1' },
      ]),
      modifyPosition: jest.fn().mockResolvedValue({ position_id: 'pos-1' }),
    };

    const mockExchange: any = {};
    const mockPP: any = {
      sequelize: { query: jest.fn(), QueryTypes: { UPDATE: 'UPDATE' } },
      findByPk: jest.fn(),
    };

    const mockOrder: any = {
      findOne: jest.fn().mockResolvedValue({
        exchangeOrderId: 'ord-1',
        symbol: 'XAUUSD',
        side: 'buy',
        filledPrice: '2050',
        price: '2050',
      }),
    };

    const pipeline = new TradFiProtectionPipeline(mockExchange, mockPP, mockOrder, mockRestClient);
    const result = await pipeline.moveStopLossToBreakeven('ord-1');

    expect(result).toBe(true);
    expect(mockRestClient.modifyPosition).toHaveBeenCalledWith('pos-1', { price_sl: '2050' });
  });

  // ── Min-volume TP merge ─────────────────────────────────────────────────

  it('should merge TPs below min volume', async () => {
    const mockRestClient: any = {
      listPositions: jest.fn().mockResolvedValue([
        { position_id: 'pos-1', symbol: 'XAUUSD', position_dir: 'Long', volume: '0.02' },
      ]),
      modifyPosition: jest.fn().mockResolvedValue({ position_id: 'pos-1' }),
    };

    const mockExchange: any = {
      updateStopLoss: jest.fn().mockResolvedValue('sl-1'),
      getPosition: jest.fn().mockResolvedValue({
        symbol: 'XAUUSD', size: 0.02, price_sl: '0', price_tp: '0',
      }),
    };

    const mockPP: any = {
      sequelize: {
        query: jest.fn().mockResolvedValue([1, 1]),
        QueryTypes: { UPDATE: 'UPDATE' },
      },
      findByPk: jest.fn().mockResolvedValue({
        update: jest.fn().mockResolvedValue(undefined),
        destroy: jest.fn().mockResolvedValue(undefined),
      }),
    };
    const mockOrder: any = { findOne: jest.fn(), findAll: jest.fn() };

    const pipeline = new TradFiProtectionPipeline(mockExchange, mockPP, mockOrder, mockRestClient);
    const scheduler = new TradFiTPScheduler(mockExchange);
    pipeline.setTPScheduler(scheduler);

    // Backward-merge algo: TP3(0.006) merges into TP2 → TP2=0.012 (>= min).
    // TP1(0.008) stays < min but has no predecessor to merge into.
    // Result: 2 TPs survive. Only TP2+ go to scheduler → 1 pending.
    const result = await pipeline.placeProtections({
      orderId: 'test-ord-merge',
      symbol: 'XAUUSD',
      side: 'buy',
      stopLossPrice: '2000',
      tpOrders: [
        { price: '2200', amount: '0.008' },
        { price: '2300', amount: '0.006' },
        { price: '2400', amount: '0.006' },
      ],
      amount: '0.02',
      source: 'smoke-test',
      minOrderVolume: 0.01,
    });

    expect(result.slPlaced).toBe(true);
    expect(result.tpPlaced).toBe(true);

    // TP3 collapsed into TP2; TP1 remains (no backward target).
    // Scheduler gets TP2 only → 1 pending TP.
    expect(scheduler.getPendingTPCount('XAUUSD', 'buy')).toBe(1);
  });

  it('should collapse all TPs into a single TP1 when chain merges fully', async () => {
    const mockRestClient: any = {
      listPositions: jest.fn().mockResolvedValue([
        { position_id: 'pos-1', symbol: 'XAUUSD', position_dir: 'Long', volume: '0.014' },
      ]),
      modifyPosition: jest.fn().mockResolvedValue({ position_id: 'pos-1' }),
    };

    const mockExchange: any = {
      updateStopLoss: jest.fn().mockResolvedValue('sl-1'),
      getPosition: jest.fn().mockResolvedValue({
        symbol: 'XAUUSD', size: 0.014, price_sl: '0', price_tp: '0',
      }),
    };

    const mockPP: any = {
      sequelize: {
        query: jest.fn().mockResolvedValue([1, 1]),
        QueryTypes: { UPDATE: 'UPDATE' },
      },
      findByPk: jest.fn().mockResolvedValue({
        update: jest.fn().mockResolvedValue(undefined),
        destroy: jest.fn().mockResolvedValue(undefined),
      }),
    };
    const mockOrder: any = { findOne: jest.fn(), findAll: jest.fn() };

    const pipeline = new TradFiProtectionPipeline(mockExchange, mockPP, mockOrder, mockRestClient);
    const scheduler = new TradFiTPScheduler(mockExchange);
    pipeline.setTPScheduler(scheduler);

    // Backward merge: TP4(0.003)→TP3 → TP3=0.006; TP3(0.006)→TP2 → TP2=0.009;
    // TP2(0.009)→TP1 → TP1=0.014. Only TP1 survives → no scheduler TPs.
    const result = await pipeline.placeProtections({
      orderId: 'test-ord-collapse',
      symbol: 'XAUUSD',
      side: 'buy',
      stopLossPrice: '2000',
      tpOrders: [
        { price: '2200', amount: '0.005' },
        { price: '2300', amount: '0.003' },
        { price: '2400', amount: '0.003' },
        { price: '2500', amount: '0.003' },
      ],
      amount: '0.014',
      source: 'smoke-test',
      minOrderVolume: 0.01,
    });

    expect(result.slPlaced).toBe(true);
    expect(result.tpPlaced).toBe(true);

    // All collapsed into TP1 — zero scheduler TPs
    expect(scheduler.getPendingTPCount('XAUUSD', 'buy')).toBe(0);
  });

  // ── Cancel protections clears scheduler ─────────────────────────────────

  it('should cancel protections and clear scheduler', async () => {
    const mockExchange: any = { closePosition: jest.fn().mockResolvedValue(true) };
    const scheduler = new TradFiTPScheduler(mockExchange);

    // Manually register some TPs
    scheduler.registerTP({ index: 2, price: 2300, volume: '0.03', symbol: 'XAUUSD', side: 'buy', orderId: 'o1' });
    scheduler.registerTP({ index: 3, price: 2400, volume: '0.02', symbol: 'XAUUSD', side: 'buy', orderId: 'o1' });
    expect(scheduler.getPendingTPCount('XAUUSD', 'buy')).toBe(2);

    const pipeline = new TradFiProtectionPipeline({}, {} as any, {} as any, {} as any);
    pipeline.setTPScheduler(scheduler);

    await pipeline.cancelProtections('XAUUSD', 'buy');
    expect(scheduler.getPendingTPCount('XAUUSD', 'buy')).toBe(0);
  });

  // ── Claim failure prevents placement ────────────────────────────────────

  it('should skip placement when claim fails', async () => {
    const mockPP: any = {
      sequelize: {
        query: jest.fn().mockResolvedValue([0, 0]), // no rows affected
        QueryTypes: { UPDATE: 'UPDATE' },
      },
      findByPk: jest.fn(),
    };

    const pipeline = new TradFiProtectionPipeline({}, mockPP, {} as any, {} as any);
    const result = await pipeline.placeProtections({
      orderId: 'unclaimed-ord',
      symbol: 'XAUUSD',
      side: 'buy',
      stopLossPrice: '2000',
      amount: '0.1',
      source: 'smoke-test',
    });

    expect(result.claimed).toBe(false);
    expect(result.slPlaced).toBe(false);
    expect(result.tpPlaced).toBe(false);
  });
});
