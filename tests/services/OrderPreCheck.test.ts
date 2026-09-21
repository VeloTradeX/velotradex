// tests/services/OrderPreCheck.test.ts
import { OrderPreCheck } from '../../src/services/OrderPreCheck';

describe('OrderPreCheck', () => {
  const mockExchange = {
    getPositions: jest.fn(),
    getOpenOrders: jest.fn(),
  };
  const mockMarkets = [{ symbol: 'BTC_USDT', amountPrecision: 2, pricePrecision: 2 }];

  beforeEach(() => { jest.clearAllMocks(); });

  const makePosition = (size: number) => ({
    symbol: 'BTC_USDT', size: size.toString(),
    entryPrice: '10000', leverage: '10',
  });

  const makeOpenOrder = (id: string, price: number, text = 't-trader') => ({
    id, price: price.toString(), side: 'buy', text, amount: '1',
  });

  const makeDbOrder = (id: number, status: string, price: number, sl: number, type?: string) => ({
    id, lifecycleStatus: status, price: price.toString(),
    initialSl: sl.toString(), exchangeOrderId: `ex-${id}`,
    symbol: 'BTC_USDT', side: 'buy', createdAt: new Date(),
    save: jest.fn(),
    type: type || undefined,
  });

  describe('checkConflict', () => {
    it('无冲突时返回 null', async () => {
      mockExchange.getPositions.mockResolvedValue([makePosition(5)]);
      const checker = new OrderPreCheck(mockExchange as any, mockMarkets as any);
      const result = await checker.checkConflict('BTC_USDT', 'buy');
      expect(result).toBeNull();
    });

    it('有反向持仓时返回该持仓', async () => {
      mockExchange.getPositions.mockResolvedValue([makePosition(-5)]);
      const checker = new OrderPreCheck(mockExchange as any, mockMarkets as any);
      const result = await checker.checkConflict('BTC_USDT', 'buy');
      expect(result).not.toBeNull();
      expect(parseFloat(result!.size)).toBe(-5);
    });

    it('无持仓时返回 null', async () => {
      mockExchange.getPositions.mockResolvedValue([]);
      const checker = new OrderPreCheck(mockExchange as any, mockMarkets as any);
      const result = await checker.checkConflict('BTC_USDT', 'buy');
      expect(result).toBeNull();
    });

    it('不同币种的持仓不算冲突', async () => {
      const ewyPosition = { symbol: 'EWY_USDT', size: '-5', entryPrice: '100', leverage: '10' };
      mockExchange.getPositions.mockResolvedValue([ewyPosition]);
      const checker = new OrderPreCheck(mockExchange as any, mockMarkets as any);
      const result = await checker.checkConflict('BTC_USDT', 'buy');
      expect(result).toBeNull();
    });
  });

  describe('checkDuplicate', () => {
    it('相同价格和 SL 判定为重复', async () => {
      const checker = new OrderPreCheck(mockExchange as any, mockMarkets as any);
      const result = await checker.checkDuplicate(
        'BTC_USDT', 'buy', 100, 95,
        [makeOpenOrder('ex-1', 100)],
        [makeDbOrder(1, 'PROTECTED', 100, 95) as any],
      );
      expect(result.isDuplicate).toBe(true);
    });

    it('价格不同不算重复', async () => {
      const checker = new OrderPreCheck(mockExchange as any, mockMarkets as any);
      const result = await checker.checkDuplicate(
        'BTC_USDT', 'buy', 100, 95,
        [makeOpenOrder('ex-1', 101)],
        [makeDbOrder(1, 'PROTECTED', 100, 95) as any],
      );
      expect(result.isDuplicate).toBe(false);
    });

    // === 混合单 duplicate 修复测试 ===

    describe('方案 A: orderType 维度', () => {
      it('不同 orderType (market vs limit) → 不视为重复', async () => {
        const checker = new OrderPreCheck(mockExchange as any, mockMarkets as any);
        // 市价腿已成交 @ 100 (DB 记录 type=market)
        const dbOrders = [makeDbOrder(10, 'OPEN', 100, 95, 'market') as any];
        // 限价腿进入检查 (entryPrice=100, orderType=limit)
        const result = await checker.checkDuplicate(
          'BTC_USDT', 'buy', 100, 95,
          [],
          dbOrders,
          'limit',
        );
        expect(result.isDuplicate).toBe(false);
      });

      it('相同 orderType + 相同价格/SL → 视为重复', async () => {
        const checker = new OrderPreCheck(mockExchange as any, mockMarkets as any);
        const dbOrders = [makeDbOrder(10, 'OPEN', 100, 95, 'market') as any];
        const result = await checker.checkDuplicate(
          'BTC_USDT', 'buy', 100, 95,
          [],
          dbOrders,
          'market',
        );
        expect(result.isDuplicate).toBe(true);
      });

      it('传入 orderType 但 DB 订单无 type 字段 → 仍按重复处理（兼容旧数据）', async () => {
        const checker = new OrderPreCheck(mockExchange as any, mockMarkets as any);
        const dbOrders = [makeDbOrder(10, 'OPEN', 100, 95) as any]; // type 未设置
        const result = await checker.checkDuplicate(
          'BTC_USDT', 'buy', 100, 95,
          [],
          dbOrders,
          'market',
        );
        // dbOrder.type 为 undefined，条件 `dbOrder.type !== orderType` 不成立
        // 所以仍会判定为重复
        expect(result.isDuplicate).toBe(true);
      });

      it('openOrders 路径: 不同 orderType → 不视为重复', async () => {
        const checker = new OrderPreCheck(mockExchange as any, mockMarkets as any);
        const openOrders = [makeOpenOrder('ex-1', 100)];
        const dbOrders = [makeDbOrder(10, 'OPEN', 100, 95, 'market') as any];
        const result = await checker.checkDuplicate(
          'BTC_USDT', 'buy', 100, 95,
          openOrders,
          dbOrders,
          'limit',
        );
        expect(result.isDuplicate).toBe(false);
      });
    });

    describe('方案 C: INIT/PENDING 状态跳过', () => {
      it('DB 订单为 INIT 状态 → 跳过，不视为重复', async () => {
        const checker = new OrderPreCheck(mockExchange as any, mockMarkets as any);
        const dbOrders = [makeDbOrder(20, 'INIT', 100, 95, 'market') as any];
        const result = await checker.checkDuplicate(
          'BTC_USDT', 'buy', 100, 95,
          [],
          dbOrders,
          'market',
        );
        expect(result.isDuplicate).toBe(false);
      });

      it('DB 订单为 PENDING 状态 → 跳过，不视为重复', async () => {
        const checker = new OrderPreCheck(mockExchange as any, mockMarkets as any);
        const dbOrders = [makeDbOrder(20, 'PENDING', 100, 95, 'market') as any];
        const result = await checker.checkDuplicate(
          'BTC_USDT', 'buy', 100, 95,
          [],
          dbOrders,
          'market',
        );
        expect(result.isDuplicate).toBe(false);
      });

      it('混合: INIT 订单被跳过，OPEN 订单匹配仍视为重复', async () => {
        const checker = new OrderPreCheck(mockExchange as any, mockMarkets as any);
        const dbOrders = [
          makeDbOrder(20, 'INIT', 100, 95, 'market') as any,    // 被跳过
          makeDbOrder(21, 'OPEN', 100, 95, 'market') as any,    // 匹配
        ];
        const result = await checker.checkDuplicate(
          'BTC_USDT', 'buy', 100, 95,
          [],
          dbOrders,
          'market',
        );
        expect(result.isDuplicate).toBe(true);
        expect(result.existingOrderId).toBe('21');
      });
    });

    describe('混合单完整场景模拟', () => {
      it('CMP 混合单: 市价腿(market)先创建，限价腿(limit)不应被拦截', async () => {
        const checker = new OrderPreCheck(mockExchange as any, mockMarkets as any);

        // 市价腿先执行：创建了 INIT 状态的 DB 记录 + 已成交的 OPEN 记录
        const dbOrders = [
          makeDbOrder(30, 'INIT', 4629, 4600, 'market') as any,      // 刚创建，尚未成交
          makeDbOrder(31, 'OPEN', 4629, 4600, 'market') as any,      // 已成交
        ];

        // 限价腿后执行：entryPrice=4630, orderType=limit
        const result = await checker.checkDuplicate(
          'XAU_USDT', 'buy', 4630, 4600,
          [],
          dbOrders,
          'limit',
        );
        // 4630 vs 4629 价差约 0.02%，在 0.1% 容差内
        // 但因为 orderType 不同 (limit vs market)，且 INIT 被跳过
        // 所以不应视为重复
        expect(result.isDuplicate).toBe(false);
      });
    });
  });

  describe('cleanupStaleOrders', () => {
    it('PENDING 单不在 openOrders 且无持仓 → 标记 CLOSED', async () => {
      const oldDate = new Date(Date.now() - 120000);
      const dbOrder = makeDbOrder(1, 'PENDING', 100, 95) as any;
      dbOrder.createdAt = oldDate;
      await new OrderPreCheck(mockExchange as any, mockMarkets as any).cleanupStaleOrders(
        [dbOrder], [], [],
      );
      expect(dbOrder.lifecycleStatus).toBe('CLOSED');
      expect(dbOrder.save).toHaveBeenCalled();
    });

    it('PENDING 单在 openOrders 中存在 → 不处理', async () => {
      const dbOrder = makeDbOrder(1, 'PENDING', 100, 95) as any;
      await new OrderPreCheck(mockExchange as any, mockMarkets as any).cleanupStaleOrders(
        [dbOrder], [{ id: 'ex-1' }], [{ symbol: 'BTC_USDT', size: '5' }],
      );
      expect(dbOrder.lifecycleStatus).toBe('PENDING');
      expect(dbOrder.save).not.toHaveBeenCalled();
    });
  });
});
