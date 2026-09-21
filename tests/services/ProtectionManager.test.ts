import { ProtectionManager } from '../../src/services/ProtectionManager';
import { Order } from '../../src/models';
import logger from '../../src/utils/logger';

jest.mock('../../src/models', () => ({
  Order: {
    findOne: jest.fn(),
  },
}));

jest.mock('../../src/utils/logger', () => ({
  __esModule: true,
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
  formatError: jest.fn((e: any) => ({ errorMessage: e?.message, errorName: e?.name })),
}));

describe('ProtectionManager', () => {
  let exchange: any;

  beforeEach(() => {
    exchange = {
      updateStopLoss: jest.fn(),
      placeOrder: jest.fn(),
      getPriceOrders: jest.fn().mockResolvedValue([]),
      getOpenOrders: jest.fn().mockResolvedValue([]),
      getTicker: jest.fn(),
      getMarkets: jest.fn().mockResolvedValue([]),
      cancelPriceOrder: jest.fn().mockResolvedValue(undefined),
      cancelOrder: jest.fn().mockResolvedValue(undefined),
    };
    (Order.findOne as jest.Mock).mockResolvedValue(null);
  });

  describe('placeStopLoss', () => {
    it('returns the exchange SL id (not text)', async () => {
      exchange.updateStopLoss.mockResolvedValue('82472171406124380');

      const manager = new ProtectionManager(exchange);
      const result = await manager.placeStopLoss({
        orderId: '82472171406123676',
        symbol: 'BTC_USDT',
        side: 'buy',
        amount: '1',
        stopLossPrice: '73900',
        source: 'test',
      });

      expect(exchange.updateStopLoss).toHaveBeenCalledWith(
        'BTC_USDT',
        'buy',
        '73900',
        't-sl-pos-BTC_USDT-sell',
        '1',
      );
      expect(result).toBe('82472171406124380');
    });

    it('returns null when exchange did not create a new SL order', async () => {
      exchange.updateStopLoss.mockResolvedValue(null);

      const manager = new ProtectionManager(exchange);
      const result = await manager.placeStopLoss({
        orderId: '82472171406123676',
        symbol: 'BTC_USDT',
        side: 'buy',
        amount: '1',
        stopLossPrice: '73900',
        source: 'test',
      });

      expect(result).toBeNull();
    });

    it('skips placement when no stopLossPrice is provided', async () => {
      const manager = new ProtectionManager(exchange);
      const result = await manager.placeStopLoss({
        orderId: '1',
        symbol: 'BTC_USDT',
        side: 'buy',
        amount: '1',
        source: 'test',
      });

      expect(result).toBeNull();
      expect(exchange.updateStopLoss).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalled();
    });

    it('returns null when the exchange throws', async () => {
      exchange.updateStopLoss.mockRejectedValue(new Error('insufficient margin'));

      const manager = new ProtectionManager(exchange);
      const result = await manager.placeStopLoss({
        orderId: '1',
        symbol: 'BTC_USDT',
        side: 'buy',
        amount: '1',
        stopLossPrice: '100',
        source: 'test',
      });

      expect(result).toBeNull();
      expect(logger.error).toHaveBeenCalled();
    });
  });

  describe('placeTakeProfit', () => {
    it('places a reduce-only limit sell TP for a long entry', async () => {
      exchange.placeOrder.mockResolvedValue({ id: 42 });

      const manager = new ProtectionManager(exchange);
      const result = await manager.placeTakeProfit({
        orderId: '123',
        symbol: 'BTC_USDT',
        side: 'buy',
        amount: '2',
        takeProfitPrice: '120',
        source: 'test',
      });

      expect(exchange.placeOrder).toHaveBeenCalledWith({
        symbol: 'BTC_USDT',
        side: 'sell',
        amount: '2',
        reduceOnly: true,
        type: 'limit',
        price: '120',
        text: 't-tp-1-ord-123',
      });
      expect(result).toEqual(['42']);
    });

    it('places a buy TP for a short entry', async () => {
      exchange.placeOrder.mockResolvedValue({ id: 43 });

      const manager = new ProtectionManager(exchange);
      await manager.placeTakeProfit({
        orderId: '123',
        symbol: 'BTC_USDT',
        side: 'sell',
        amount: '2',
        takeProfitPrice: '80',
        source: 'test',
      });

      expect(exchange.placeOrder).toHaveBeenCalledWith(
        expect.objectContaining({ side: 'buy', price: '80' }),
      );
    });

    it('skips placement when no takeProfitPrice is provided', async () => {
      const manager = new ProtectionManager(exchange);
      const result = await manager.placeTakeProfit({
        orderId: '123',
        symbol: 'BTC_USDT',
        side: 'buy',
        amount: '2',
        source: 'test',
      });

      expect(result).toEqual([]);
      expect(exchange.placeOrder).not.toHaveBeenCalled();
    });

    it('returns an empty array when the result has no id', async () => {
      exchange.placeOrder.mockResolvedValue({});

      const manager = new ProtectionManager(exchange);
      const result = await manager.placeTakeProfit({
        orderId: '123',
        symbol: 'BTC_USDT',
        side: 'buy',
        amount: '2',
        takeProfitPrice: '120',
        source: 'test',
      });

      expect(result).toEqual([]);
    });

    it('returns an empty array when the exchange throws', async () => {
      exchange.placeOrder.mockRejectedValue(new Error('rate limited'));

      const manager = new ProtectionManager(exchange);
      const result = await manager.placeTakeProfit({
        orderId: '123',
        symbol: 'BTC_USDT',
        side: 'buy',
        amount: '2',
        takeProfitPrice: '120',
        source: 'test',
      });

      expect(result).toEqual([]);
      expect(logger.error).toHaveBeenCalled();
    });
  });

  describe('cancelProtections', () => {
    it('cancels matching SL and TP orders and skips unrelated ones', async () => {
      exchange.getPriceOrders.mockResolvedValue([
        { id: 'sl-1', text: 't-sl-pos-BTC_USDT-sell' },
        { id: 'sl-2', text: 't-sl-pos-ETH_USDT-sell' },
      ]);
      exchange.getOpenOrders.mockResolvedValue([
        // lighter-style raw order matching the order id suffix
        { id: 'tp-1', raw: { text: 't-tp-1-ord-ord1', reduceOnly: true, size: -5 } },
        // different linked order id — must be skipped
        { id: 'tp-2', raw: { text: 't-tp-1-ord-ord2', reduceOnly: true, size: -5 } },
        // gate-style order without raw wrapper
        { id: 'tp-3', text: 't-tp-1-ord-ord1', reduceOnly: true, side: 'sell' },
      ]);

      const manager = new ProtectionManager(exchange);
      await manager.cancelProtections('BTC_USDT', 'buy', 'ord1');

      expect(exchange.cancelPriceOrder).toHaveBeenCalledTimes(1);
      expect(exchange.cancelPriceOrder).toHaveBeenCalledWith('sl-1', 'BTC_USDT');
      expect(exchange.cancelOrder).toHaveBeenCalledTimes(2);
      expect(exchange.cancelOrder).toHaveBeenCalledWith('tp-1', 'BTC_USDT');
      expect(exchange.cancelOrder).toHaveBeenCalledWith('tp-3', 'BTC_USDT');
    });

    it('keeps cancelling remaining orders when one cancel fails', async () => {
      exchange.getPriceOrders.mockResolvedValue([
        { id: 'sl-1', text: 't-sl-pos-BTC_USDT-sell' },
        { id: 'sl-2', text: 't-sl-pos-BTC_USDT-sell' },
      ]);
      exchange.cancelPriceOrder
        .mockRejectedValueOnce(new Error('already gone'))
        .mockResolvedValueOnce(undefined);

      const manager = new ProtectionManager(exchange);
      await manager.cancelProtections('BTC_USDT', 'buy', 'ord1');

      expect(exchange.cancelPriceOrder).toHaveBeenCalledTimes(2);
      expect(logger.error).toHaveBeenCalled();
    });
  });

  describe('cancelTpOrders', () => {
    it('only cancels reduce-only TP orders on the close side scoped to the given order id', async () => {
      exchange.getOpenOrders.mockResolvedValue([
        { id: 'tp-a', raw: { text: 't-tp-2-ord-ord1', reduceOnly: true, size: -1 } },
        // different order suffix
        { id: 'tp-b', raw: { text: 't-tp-2-ord-other', reduceOnly: true, size: -1 } },
        // not reduce-only
        { id: 'tp-c', raw: { text: 't-tp-2-ord-ord1', reduceOnly: false, size: -1 } },
        // wrong side (buy TP while closing side is sell)
        { id: 'tp-d', raw: { text: 't-tp-2-ord-ord1', reduceOnly: true, size: 1 } },
      ]);

      const manager = new ProtectionManager(exchange);
      await manager.cancelTpOrders('BTC_USDT', 'buy', 'ord1');

      expect(exchange.cancelOrder).toHaveBeenCalledTimes(1);
      expect(exchange.cancelOrder).toHaveBeenCalledWith('tp-a', 'BTC_USDT');
    });

    it('without orderId cancels every reduce-only TP order on the close side', async () => {
      exchange.getOpenOrders.mockResolvedValue([
        { id: 'tp-a', raw: { text: 't-tp-2-ord-ord1', reduceOnly: true, size: -1 } },
        // SL order, not a TP
        { id: 'sl-x', raw: { text: 't-sl-pos-BTC_USDT-sell', reduceOnly: true, size: -1 } },
        // buy-side TP
        { id: 'tp-c', raw: { text: 't-tp-2-ord-other', reduceOnly: true, size: 1 } },
      ]);

      const manager = new ProtectionManager(exchange);
      await manager.cancelTpOrders('BTC_USDT', 'buy');

      expect(exchange.cancelOrder).toHaveBeenCalledTimes(1);
      expect(exchange.cancelOrder).toHaveBeenCalledWith('tp-a', 'BTC_USDT');
    });
  });

  describe('checkBreakeven', () => {
    it('returns false when the order is not found', async () => {
      const manager = new ProtectionManager(exchange);
      const result = await manager.checkBreakeven('BTC_USDT', '55');

      expect(result).toBe(false);
      expect(Order.findOne).toHaveBeenCalledWith({ where: { id: 55 } });
      expect(exchange.updateStopLoss).not.toHaveBeenCalled();
    });

    it('returns false when the entry price is invalid', async () => {
      (Order.findOne as jest.Mock).mockResolvedValue({
        side: 'buy',
        filledPrice: '0',
        price: '0',
        activeStopLossId: 'sl-9',
      });

      const manager = new ProtectionManager(exchange);
      const result = await manager.checkBreakeven('BTC_USDT', '55');

      expect(result).toBe(false);
      expect(logger.warn).toHaveBeenCalled();
    });

    it('returns false when the order has no activeStopLossId', async () => {
      (Order.findOne as jest.Mock).mockResolvedValue({
        side: 'buy',
        filledPrice: '100',
        activeStopLossId: null,
      });

      const manager = new ProtectionManager(exchange);
      const result = await manager.checkBreakeven('BTC_USDT', '55');

      expect(result).toBe(false);
      expect(exchange.getPriceOrders).not.toHaveBeenCalled();
    });

    it('returns true without updating when the SL is already at breakeven', async () => {
      (Order.findOne as jest.Mock).mockResolvedValue({
        side: 'buy',
        filledPrice: '100',
        activeStopLossId: 'sl-9',
        filledAmount: '2',
      });
      exchange.getPriceOrders.mockResolvedValue([
        { id: 'sl-9', trigger: { price: '100.05' } },
      ]);

      const manager = new ProtectionManager(exchange);
      const result = await manager.checkBreakeven('BTC_USDT', '55');

      expect(result).toBe(true);
      expect(exchange.getTicker).not.toHaveBeenCalled();
      expect(exchange.updateStopLoss).not.toHaveBeenCalled();
    });

    it('refuses to move a long SL to breakeven when the buffered price would cross the last price', async () => {
      (Order.findOne as jest.Mock).mockResolvedValue({
        side: 'buy',
        filledPrice: '100',
        activeStopLossId: 'sl-9',
        filledAmount: '2',
      });
      exchange.getPriceOrders.mockResolvedValue([
        { id: 'sl-9', trigger: { price: '90' } },
      ]);
      exchange.getTicker.mockResolvedValue({ lastPrice: '100.02' });

      const manager = new ProtectionManager(exchange);
      const result = await manager.checkBreakeven('BTC_USDT', '55', 0.0005);

      expect(result).toBe(false);
      expect(exchange.updateStopLoss).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalled();
    });

    it('moves the SL to the buffered breakeven price using market precision', async () => {
      (Order.findOne as jest.Mock).mockResolvedValue({
        side: 'buy',
        filledPrice: '200',
        activeStopLossId: 'sl-9',
        filledAmount: '2',
      });
      exchange.getPriceOrders.mockResolvedValue([
        { id: 'sl-9', trigger: { price: '180' } },
      ]);
      exchange.getTicker.mockResolvedValue({ lastPrice: '250' });
      exchange.getMarkets.mockResolvedValue([
        { symbol: 'BTC_USDT', pricePrecision: 1 },
      ]);

      const manager = new ProtectionManager(exchange);
      const result = await manager.checkBreakeven('BTC_USDT', '55', 0.01);

      expect(result).toBe(true);
      // 200 * (1 + 0.01) = 202.00000000000003 -> toFixed(1) -> '202.0'
      expect(exchange.updateStopLoss).toHaveBeenCalledWith(
        'BTC_USDT',
        'buy',
        '202.0',
        't-sl-pos-BTC_USDT-sell',
        '2',
      );
    });
  });
});
