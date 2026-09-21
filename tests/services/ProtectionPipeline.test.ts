import { ProtectionPipeline } from '../../src/services/ProtectionPipeline';
import { GATE_ORDER_TEXT_MAX_LENGTH } from '../../src/utils/orderText';

const mockExchange = {
  updateStopLoss: jest.fn(),
  placeOrder: jest.fn(),
  getPriceOrders: jest.fn(),
  cancelPriceOrder: jest.fn(),
  getOpenOrders: jest.fn(),
  cancelOrder: jest.fn(),
  getTicker: jest.fn(),
  getMarkets: jest.fn(),
  getPosition: jest.fn(),
};

const mockQuery = jest.fn();

const mockPendingProtection = {
  findByPk: jest.fn(),
  update: jest.fn(),
  destroy: jest.fn(),
  create: jest.fn(),
  sequelize: {
    query: mockQuery,
    QueryTypes: { UPDATE: 'UPDATE' },
  },
};

const mockOrder = {
  findOne: jest.fn(),
  findAll: jest.fn(),
  update: jest.fn(),
};

describe('ProtectionPipeline', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockQuery.mockReset();
    Object.values(mockExchange).forEach((mockFn: any) => mockFn.mockReset());
    Object.values(mockPendingProtection)
      .filter((value: any) => typeof value?.mockReset === 'function')
      .forEach((mockFn: any) => mockFn.mockReset());
    Object.values(mockOrder)
      .filter((value: any) => typeof value?.mockReset === 'function')
      .forEach((mockFn: any) => mockFn.mockReset());
  });

  describe('claimProtection', () => {
    it('returns true when claim succeeds (status updated from PENDING)', async () => {
      mockQuery.mockResolvedValue([1, {}]);
      const pipeline = new (ProtectionPipeline as any)(mockExchange, mockPendingProtection, mockOrder);
      const result = await pipeline.claimProtection('123');
      expect(result).toBe(true);
    });

    it('returns true for sqlite update result shape [null, 1]', async () => {
      mockQuery.mockResolvedValue([null, 1]);
      const pipeline = new (ProtectionPipeline as any)(mockExchange, mockPendingProtection, mockOrder);
      const result = await pipeline.claimProtection('123');
      expect(result).toBe(true);
    });

    it('returns false when already CLAIMED', async () => {
      mockQuery.mockResolvedValue([0, {}]);
      const pipeline = new (ProtectionPipeline as any)(mockExchange, mockPendingProtection, mockOrder);
      const result = await pipeline.claimProtection('123');
      expect(result).toBe(false);
    });

    it('returns false when record not found', async () => {
      mockQuery.mockResolvedValue([0, {}]);
      const pipeline = new (ProtectionPipeline as any)(mockExchange, mockPendingProtection, mockOrder);
      const result = await pipeline.claimProtection('nonexistent');
      expect(result).toBe(false);
    });
  });

  describe('placeProtections', () => {
    it('skips when claim fails (already claimed by another path)', async () => {
      mockQuery.mockResolvedValue([0, {}]);
      const pipeline = new (ProtectionPipeline as any)(mockExchange, mockPendingProtection, mockOrder);
      const result = await pipeline.placeProtections({
        orderId: '123', symbol: 'BTC_USDT', side: 'buy',
        stopLossPrice: '74000', amount: '5', source: 'test',
      });
      expect(result).toEqual({ slPlaced: false, tpPlaced: false, claimed: false });
      expect(mockExchange.updateStopLoss).not.toHaveBeenCalled();
    });

    it('slPreAttached=true 时跳过 SL 挂单且 slPlaced=true（入场单已自带止损）', async () => {
      mockQuery.mockResolvedValueOnce([1, {}]); // claim succeeds
      mockPendingProtection.findByPk.mockResolvedValue(null); // _markCompleted no-op
      const pipeline = new (ProtectionPipeline as any)(mockExchange, mockPendingProtection, mockOrder);
      const result = await pipeline.placeProtections({
        orderId: '123', symbol: 'BTC_USDT', side: 'buy',
        stopLossPrice: '74000', amount: '5', source: 'test',
        slPreAttached: true,
      });
      expect(result.slPlaced).toBe(true);
      expect(mockExchange.updateStopLoss).not.toHaveBeenCalled();
      expect(mockExchange.getPosition).not.toHaveBeenCalled();
    });

    it('tpPreAttached=true 时 tpPlaced=true（入场单已自带止盈，无 TP 限价单需要挂）', async () => {
      mockQuery.mockResolvedValueOnce([1, {}]);
      mockPendingProtection.findByPk.mockResolvedValue(null);
      const pipeline = new (ProtectionPipeline as any)(mockExchange, mockPendingProtection, mockOrder);
      const result = await pipeline.placeProtections({
        orderId: '123', symbol: 'BTC_USDT', side: 'buy',
        amount: '5', source: 'test',
        tpPreAttached: true,
      });
      expect(result.tpPlaced).toBe(true);
      expect(mockExchange.placeOrder).not.toHaveBeenCalled();
    });

    it('多 TP 接管：有 tpOrders 且 exchange 支持时调用 cancelAttachedTpslTp 撤销自带 TP 腿', async () => {
      const exchangeWithCancel = {
        ...mockExchange,
        cancelAttachedTpslTp: jest.fn().mockResolvedValue(1),
      };
      mockQuery.mockResolvedValueOnce([1, {}]);
      mockPendingProtection.findByPk.mockResolvedValue(null);
      exchangeWithCancel.placeOrder.mockResolvedValue({ id: 'tp-1' });
      const pipeline = new (ProtectionPipeline as any)(exchangeWithCancel, mockPendingProtection, mockOrder);
      const result = await pipeline.placeProtections({
        orderId: '123', symbol: 'BTC_USDT', side: 'buy',
        stopLossPrice: '74000', amount: '5', source: 'test',
        slPreAttached: true,
        tpOrders: [{ price: '75000', amount: '2.5' }, { price: '76000', amount: '2.5' }],
      });
      expect(exchangeWithCancel.cancelAttachedTpslTp).toHaveBeenCalledWith('BTC_USDT', 'buy', '123');
      expect(result.slPlaced).toBe(true);
      expect(result.tpPlaced).toBe(true);
      expect(exchangeWithCancel.updateStopLoss).not.toHaveBeenCalled();
    });

    it('places SL and returns slPlaced=true on success', async () => {
      mockQuery
        .mockResolvedValueOnce([1, {}])  // claimProtection succeeds
        .mockResolvedValueOnce([0, {}]); // _markCompleted: findByPk returns null (destroy already happened)
      mockExchange.updateStopLoss.mockResolvedValue('sl-new-1');
      mockExchange.getPosition.mockResolvedValue({ size: '5' });
      mockOrder.findOne.mockResolvedValue({ id: 123, update: jest.fn() });
      const pipeline = new (ProtectionPipeline as any)(mockExchange, mockPendingProtection, mockOrder);
      const result = await pipeline.placeProtections({
        orderId: '123', symbol: 'BTC_USDT', side: 'buy',
        stopLossPrice: '74000', amount: '5', source: 'test',
      });
      expect(result.slPlaced).toBe(true);
      expect(mockExchange.updateStopLoss).toHaveBeenCalledWith('BTC_USDT', 'buy', '74000', 't-sl-pos-BTC_USDT-sell', '5');
    });

    it('uses compact TP text when source is long so GateIO limit is not exceeded', async () => {
      mockQuery
        .mockResolvedValueOnce([1, {}])
        .mockResolvedValueOnce([0, {}]);
      mockExchange.updateStopLoss.mockResolvedValue('sl-new-2');
      mockExchange.getPosition.mockResolvedValue({ size: '180' });
      mockExchange.placeOrder.mockResolvedValue({ id: 'tp-1' });
      mockOrder.findOne.mockResolvedValue({ id: 123, update: jest.fn() });

      const pipeline = new (ProtectionPipeline as any)(mockExchange, mockPendingProtection, mockOrder);
      await pipeline.placeProtections({
        orderId: '82472171401387542',
        symbol: 'BTC_USDT',
        side: 'buy',
        stopLossPrice: '73000',
        tpOrders: [{ price: '75000', amount: '108' }],
        amount: '180',
        source: '100000000000000001',
      });

      const placedText = mockExchange.placeOrder.mock.calls[0][0].text;
      expect(placedText).toBe('t-tp-1-ord-82472171401387542');
      expect(placedText.length).toBeLessThanOrEqual(GATE_ORDER_TEXT_MAX_LENGTH);
    });
  });

  describe('cancelProtections', () => {
    it('cancels SL orders matching rule + reduce_only filter', async () => {
      // Mock data uses Gate.io response structure: trigger.rule + initial.reduce_only
      mockExchange.getPriceOrders.mockResolvedValue([
        { id: 'sl-1', text: 't-sl-pos-BTC_USDT-sell', trigger: { rule: 2 }, initial: { contract: 'BTC_USDT', reduce_only: true } },
        { id: 'sl-2', text: 't-sl-pos-BTC_USDT-sell', trigger: { rule: 2 }, initial: { contract: 'BTC_USDT', reduce_only: false } },
      ]);
      mockExchange.getOpenOrders.mockResolvedValue([]);
      mockExchange.cancelPriceOrder.mockResolvedValue(true);
      const pipeline = new (ProtectionPipeline as any)(mockExchange, mockPendingProtection, mockOrder);
      await pipeline.cancelProtections('BTC_USDT', 'buy', '123');
      expect(mockExchange.cancelPriceOrder).toHaveBeenCalledWith('sl-1', 'BTC_USDT');
      expect(mockExchange.cancelPriceOrder).not.toHaveBeenCalledWith('sl-2', 'BTC_USDT');
    });

    it('cancels TP limit orders matching reduce_only + t-tp- text + close side', async () => {
      mockExchange.getPriceOrders.mockResolvedValue([]);
      mockExchange.getOpenOrders.mockResolvedValue([
        { id: 'tp-1', text: 't-tp-1-ord-123', side: 'sell', reduceOnly: true, raw: { reduce_only: true, size: -5 } },
        { id: 'tp-2', text: 't-tp-2-ord-123', side: 'sell', reduceOnly: true, raw: { reduce_only: true, size: -5 } },
        { id: 'other', text: 'some-other-order', side: 'sell', reduceOnly: false, raw: {} },
      ]);
      mockExchange.cancelOrder.mockResolvedValue(true);
      const pipeline = new (ProtectionPipeline as any)(mockExchange, mockPendingProtection, mockOrder);
      await pipeline.cancelProtections('BTC_USDT', 'buy', '123');
      expect(mockExchange.cancelOrder).toHaveBeenCalledWith('tp-1', 'BTC_USDT');
      expect(mockExchange.cancelOrder).toHaveBeenCalledWith('tp-2', 'BTC_USDT');
      expect(mockExchange.cancelOrder).not.toHaveBeenCalledWith('other', 'BTC_USDT');
    });

    it('cancels both SL and TP orders', async () => {
      mockExchange.getPriceOrders.mockResolvedValue([
        { id: 'sl-1', text: 't-sl-pos-BTC_USDT-sell', trigger: { rule: 2 }, initial: { contract: 'BTC_USDT', reduce_only: true } },
      ]);
      mockExchange.getOpenOrders.mockResolvedValue([
        { id: 'tp-1', text: 't-tp-1-ord-123', side: 'sell', reduceOnly: true, raw: { reduce_only: true, size: -5 } },
      ]);
      mockExchange.cancelPriceOrder.mockResolvedValue(true);
      mockExchange.cancelOrder.mockResolvedValue(true);
      const pipeline = new (ProtectionPipeline as any)(mockExchange, mockPendingProtection, mockOrder);
      await pipeline.cancelProtections('BTC_USDT', 'buy', '123');
      expect(mockExchange.cancelPriceOrder).toHaveBeenCalledWith('sl-1', 'BTC_USDT');
      expect(mockExchange.cancelOrder).toHaveBeenCalledWith('tp-1', 'BTC_USDT');
    });

    it('filters TP orders by orderId when provided', async () => {
      mockExchange.getPriceOrders.mockResolvedValue([]);
      mockExchange.getOpenOrders.mockResolvedValue([
        { id: 'tp-1', text: 't-tp-1-ord-123', side: 'sell', reduceOnly: true, raw: { reduce_only: true, size: -5 } },
        { id: 'tp-2', text: 't-tp-1-ord-456', side: 'sell', reduceOnly: true, raw: { reduce_only: true, size: -5 } },
      ]);
      mockExchange.cancelOrder.mockResolvedValue(true);
      const pipeline = new (ProtectionPipeline as any)(mockExchange, mockPendingProtection, mockOrder);
      await pipeline.cancelProtections('BTC_USDT', 'buy', '123');
      expect(mockExchange.cancelOrder).toHaveBeenCalledWith('tp-1', 'BTC_USDT');
      expect(mockExchange.cancelOrder).not.toHaveBeenCalledWith('tp-2', 'BTC_USDT');
    });

    it('cancels all TP orders for symbol+side when orderId is not provided', async () => {
      mockExchange.getPriceOrders.mockResolvedValue([]);
      mockExchange.getOpenOrders.mockResolvedValue([
        { id: 'tp-1', text: 't-tp-1-ord-123', side: 'sell', reduceOnly: true, raw: { reduce_only: true, size: -5 } },
        { id: 'tp-2', text: 't-tp-1-ord-456', side: 'sell', reduceOnly: true, raw: { reduce_only: true, size: -5 } },
      ]);
      mockExchange.cancelOrder.mockResolvedValue(true);
      const pipeline = new (ProtectionPipeline as any)(mockExchange, mockPendingProtection, mockOrder);
      await pipeline.cancelProtections('BTC_USDT', 'buy');
      expect(mockExchange.cancelOrder).toHaveBeenCalledWith('tp-1', 'BTC_USDT');
      expect(mockExchange.cancelOrder).toHaveBeenCalledWith('tp-2', 'BTC_USDT');
    });

    it('logs when no SL or TP orders found', async () => {
      mockExchange.getPriceOrders.mockResolvedValue([]);
      mockExchange.getOpenOrders.mockResolvedValue([]);
      const pipeline = new (ProtectionPipeline as any)(mockExchange, mockPendingProtection, mockOrder);
      await pipeline.cancelProtections('BTC_USDT', 'buy', '123');
      expect(mockExchange.cancelPriceOrder).not.toHaveBeenCalled();
      expect(mockExchange.cancelOrder).not.toHaveBeenCalled();
    });
  });

  describe('moveStopLossToBreakeven', () => {
    it('uses fallback near-market SL when buffered breakeven is invalid against last price', async () => {
      const orderUpdate = jest.fn();
      mockExchange.getTicker.mockResolvedValue({ lastPrice: '100.5' });
      mockExchange.getMarkets.mockResolvedValue([{ symbol: 'BTC_USDT', pricePrecision: 1 }]);
      mockExchange.updateStopLoss.mockResolvedValue('sl-2');
      mockExchange.getPosition.mockResolvedValue({ size: '2' });
      mockOrder.findOne.mockResolvedValue({
        exchangeOrderId: '123',
        symbol: 'BTC_USDT',
        side: 'buy',
        filledPrice: '100',
        filledAmount: '2',
        amount: '2',
        activeStopLossId: 'sl-1',
        update: orderUpdate,
      });
      mockOrder.findAll.mockResolvedValue([
        { id: 123, activeStopLossId: 'sl-1', update: orderUpdate },
      ]);

      const pipeline = new (ProtectionPipeline as any)(mockExchange, mockPendingProtection, mockOrder);
      const moved = await pipeline.moveStopLossToBreakeven('123', 0.01);

      expect(moved).toBe(true);
      expect(mockExchange.updateStopLoss).toHaveBeenCalledWith(
        'BTC_USDT',
        'buy',
        '99.5',
        't-sl-pos-BTC_USDT-sell',
        '2',
      );
      expect(orderUpdate).toHaveBeenCalledWith({ activeStopLossId: 'sl-2' });
    });
  });

  describe('_placePositionLevelStopLoss retry on position not available', () => {
    it('retries getPosition when position returns null on first attempt', async () => {
      mockQuery.mockResolvedValue([1, {}]); // claim succeeds
      mockExchange.getPosition
        .mockResolvedValueOnce(null)  // first attempt: not available
        .mockResolvedValueOnce(null)  // second attempt: still not available
        .mockResolvedValueOnce({ size: '10', contract: 'BTC_USDT' }); // third: success
      mockExchange.updateStopLoss.mockResolvedValue('sl-id-123');

      const pipeline = new (ProtectionPipeline as any)(mockExchange, mockPendingProtection, mockOrder);
      const result = await pipeline.placeProtections({
        orderId: 'order-1',
        symbol: 'BTC_USDT',
        side: 'buy',
        stopLossPrice: '75000',
        tpOrders: [],
        amount: '10',
        source: 'test',
      });

      expect(result.slPlaced).toBe(true);
      expect(mockExchange.getPosition).toHaveBeenCalledTimes(3);
      expect(mockExchange.updateStopLoss).toHaveBeenCalledWith(
        'BTC_USDT', 'buy', '75000', expect.any(String), '10'
      );
    });

    it('returns null after exhausting retries when position never appears', async () => {
      mockQuery.mockResolvedValue([1, {}]);
      mockExchange.getPosition.mockResolvedValue(null); // always null

      const pipeline = new (ProtectionPipeline as any)(mockExchange, mockPendingProtection, mockOrder);
      const result = await pipeline.placeProtections({
        orderId: 'order-1',
        symbol: 'BTC_USDT',
        side: 'buy',
        stopLossPrice: '75000',
        tpOrders: [],
        amount: '10',
        source: 'test',
      });

      expect(result.slPlaced).toBe(false);
      expect(mockExchange.getPosition).toHaveBeenCalledTimes(3);
    });

    it('succeeds on second attempt without third call', async () => {
      mockQuery.mockResolvedValue([1, {}]);
      mockExchange.getPosition
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ size: '-5', contract: 'BTC_USDT' });
      mockExchange.updateStopLoss.mockResolvedValue('sl-id-456');

      const pipeline = new (ProtectionPipeline as any)(mockExchange, mockPendingProtection, mockOrder);
      const result = await pipeline.placeProtections({
        orderId: 'order-2',
        symbol: 'BTC_USDT',
        side: 'sell',
        stopLossPrice: '80000',
        tpOrders: [],
        amount: '5',
        source: 'test',
      });

      expect(result.slPlaced).toBe(true);
      expect(mockExchange.getPosition).toHaveBeenCalledTimes(2);
    });
  });

  describe('placeProtections SL failure releases claim for retry', () => {
    it('releases claim back to PENDING on SL failure instead of marking FAILED', async () => {
      mockQuery.mockResolvedValue([1, {}]); // claim and release both succeed
      mockExchange.getPosition.mockResolvedValue(null); // position never available after retries

      const pipeline = new (ProtectionPipeline as any)(mockExchange, mockPendingProtection, mockOrder);
      const result = await pipeline.placeProtections({
        orderId: 'order-3',
        symbol: 'BTC_USDT',
        side: 'buy',
        stopLossPrice: '75000',
        tpOrders: [],
        amount: '10',
        source: 'test',
      });

      expect(result.slPlaced).toBe(false);
      expect(result.claimed).toBe(true);
      // _markFailed uses findByPk (not mockQuery), so we verify _releaseClaim was called
      // by checking that mockQuery was called at least twice: once for claim, once for release.
      // The release query sets status back to PENDING where status is CLAIMED.
      expect(mockQuery.mock.calls.length).toBeGreaterThanOrEqual(2);
      // Second call should be the release: UPDATE ... SET status = 'PENDING' ... WHERE ... status = 'CLAIMED'
      const releaseCall = mockQuery.mock.calls[1];
      expect(releaseCall[0]).toContain("status = 'PENDING'");
      expect(releaseCall[0]).toContain("status = 'CLAIMED'");
      // _markFailed should NOT have been called — findByPk is not invoked
      expect(mockPendingProtection.findByPk).not.toHaveBeenCalled();
    });
  });

  describe('OTOCO support', () => {
    it('should skip OTOCO path when exchange is not Lighter', async () => {
      const pipeline = new (ProtectionPipeline as any)(mockExchange, mockPendingProtection, mockOrder);
      mockQuery.mockResolvedValue([1, {}]); // Claim succeeds
      
      const result = await pipeline.placeProtections({
        orderId: '123',
        symbol: 'BTC_USDT',
        side: 'buy',
        stopLossPrice: '49000',
        tpOrders: [{ price: '51000', amount: '0.1' }],
        amount: '0.1',
        source: 'test',
      });

      expect(result.claimed).toBe(true);
      // Should not attempt OTOCO path for non-Lighter exchange
      expect(mockOrder.findOne).not.toHaveBeenCalled();
    });

    it('should handle OTOCO path when conditions are met but currently disabled', async () => {
      // Mock Lighter exchange
      const lighterExchange = {
        ...mockExchange,
        constructor: { name: 'LighterExchange' },
        placeOtocoOrder: jest.fn(),
      };
      
      const pipeline = new (ProtectionPipeline as any)(lighterExchange, mockPendingProtection, mockOrder);
      mockQuery.mockResolvedValue([1, {}]); // Claim succeeds
      
      const result = await pipeline.placeProtections({
        orderId: '123',
        symbol: 'BTC_USDT',
        side: 'buy',
        stopLossPrice: '49000',
        tpOrders: [{ price: '51000', amount: '0.1' }],
        amount: '0.1',
        source: 'test',
      });

      expect(result.claimed).toBe(true);
      // OTOCO is currently disabled, so should not call placeOtocoOrder
      expect(lighterExchange.placeOtocoOrder).not.toHaveBeenCalled();
    });
  });
});
