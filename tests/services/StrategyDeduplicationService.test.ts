// tests/services/StrategyDeduplicationService.test.ts
import { Op } from 'sequelize';
import { StrategyDeduplicationService, StrategyDedupParams, NearDuplicateParams } from '../../src/services/StrategyDeduplicationService';

describe('StrategyDeduplicationService', () => {
  let service: StrategyDeduplicationService;

  const baseParams: StrategyDedupParams = {
    parserName: 'GaulsParser',
    symbol: 'XAU_USDT',
    side: 'buy',
    entryPrice: '4629',
    targets: '["4700"]',
    stopLoss: '4600',
    source: 'v-tradfi-test',
    exchangeInstanceId: 'v-tradfi',
    routeId: 19,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    service = new StrategyDeduplicationService();
  });

  describe('check — orderType 维度', () => {
    it('相同 orderType + 相同字段 → 判定为重复', async () => {
      const spy = jest.spyOn(require('../../src/models').Order, 'findOne').mockResolvedValue({
        id: 100,
        strategyId: 50,
      } as any);

      const result = await service.check({
        ...baseParams,
        orderType: 'market',
      });

      expect(result.isDuplicate).toBe(true);
      expect(result.duplicateOrderId).toBe(100);
      expect(spy).toHaveBeenCalled();

      const where = (spy.mock.calls[0][0] as any).where;
      expect(where.type).toBe('market');
      expect(where.symbol).toBe('XAU_USDT');
      expect(where.side).toBe('buy');
      expect(where.lifecycleStatus).toEqual(['OPEN', 'PROTECTED']);
    });

    it('相同字段但不指定 orderType → 不按 type 过滤', async () => {
      const spy = jest.spyOn(require('../../src/models').Order, 'findOne').mockResolvedValue(null);

      await service.check(baseParams);

      const where = (spy.mock.calls[0][0] as any).where;
      expect(where.type).toBeUndefined();
    });

    it('不同 orderType 的限价腿与市价腿 → 查询条件不同，互不视为重复', async () => {
      const spy = jest.spyOn(require('../../src/models').Order, 'findOne').mockResolvedValue(null);

      // 市价腿
      await service.check({ ...baseParams, entryPrice: 'CMP', orderType: 'market' });
      // 限价腿
      await service.check({ ...baseParams, entryPrice: '4650', orderType: 'limit' });

      // 两次调用的 type 条件不同
      const where1 = (spy.mock.calls[0][0] as any).where;
      const where2 = (spy.mock.calls[1][0] as any).where;
      expect(where1.type).toBe('market');
      expect(where2.type).toBe('limit');
      expect(where1.price).toBe('CMP');
      expect(where2.price).toBe('4650');
    });

    it('仅查找 OPEN 和 PROTECTED 状态', async () => {
      const spy = jest.spyOn(require('../../src/models').Order, 'findOne').mockResolvedValue(null);

      await service.check(baseParams);

      const where = (spy.mock.calls[0][0] as any).where;
      expect(where.lifecycleStatus).toEqual(['OPEN', 'PROTECTED']);
    });
  });

  describe('logDuplicate — orderType 审计日志', () => {
    it('审计日志 key 中包含 orderType', async () => {
      const auditSpy = jest.spyOn(require('../../src/services/AuditService').default, 'log').mockResolvedValue(undefined as any);

      await service.logDuplicate(
        100,
        { ...baseParams, orderType: 'limit' },
        55
      );

      expect(auditSpy).toHaveBeenCalled();
      const callArgs = auditSpy.mock.calls[0];
      // log(strategyId, action, details, orderId, ...)
      expect(callArgs[0]).toBe(100);
      expect(callArgs[1]).toBe('STRATEGY_DEDUPLICATED');
    });
  });

  describe('checkNearDuplicate — near-duplicate open guard', () => {
    const nearParams: NearDuplicateParams = {
      exchangeInstanceId: 'v-tradfi',
      routeId: 19,
      symbol: 'XAU_USDT',
      side: 'buy',
      entryPrice: '4629',
      stopLoss: '4600', // R = 29, 0.5R tolerance = 14.5
    };

    function mockCandidates(candidates: any[]) {
      return jest.spyOn(require('../../src/models').Order, 'findAll').mockResolvedValue(candidates as any);
    }

    it('价格在 0.5R 内且在时间窗口内 → 判定为近似重复', async () => {
      const spy = mockCandidates([
        { id: 300, strategyId: 77, price: '4635', filledPrice: '4635', lifecycleStatus: 'PENDING' },
      ]);

      const result = await service.checkNearDuplicate(nearParams);

      expect(result.isNearDuplicate).toBe(true);
      expect(result.existingOrderId).toBe(300);
      expect(result.existingStrategyId).toBe(77);
      expect(result.existingEntryPrice).toBe('4635');

      const where = (spy.mock.calls[0][0] as any).where;
      expect(where.exchangeInstanceId).toBe('v-tradfi');
      expect(where.routeId).toBe(19);
      expect(where.symbol).toBe('XAU_USDT');
      expect(where.side).toBe('buy');
      expect(where.lifecycleStatus[Op.in]).toEqual(['INIT', 'PENDING', 'OPEN', 'PROTECTED']);
      expect(where.createdAt[Op.gte]).toBeInstanceOf(Date);
    });

    it('价格超出 0.5R 容差 → 不判定为近似重复', async () => {
      mockCandidates([
        { id: 301, strategyId: 78, price: '4645', filledPrice: '4645', lifecycleStatus: 'OPEN' }, // 16 > 14.5
      ]);

      const result = await service.checkNearDuplicate(nearParams);

      expect(result.isNearDuplicate).toBe(false);
      expect(result.existingOrderId).toBeUndefined();
    });

    it('同一窗口内没有候选挂单/持仓 → 不判定为近似重复', async () => {
      mockCandidates([]);

      const result = await service.checkNearDuplicate(nearParams);

      expect(result.isNearDuplicate).toBe(false);
    });

    it('默认只看最近 30 分钟：createdAt 条件为 now - 30min', async () => {
      const spy = mockCandidates([]);
      const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);

      await service.checkNearDuplicate(nearParams);

      const where = (spy.mock.calls[0][0] as any).where;
      const since: Date = where.createdAt[Op.gte];
      expect(since.getTime()).toBe(1_700_000_000_000 - 30 * 60 * 1000);

      nowSpy.mockRestore();
    });

    it('自定义窗口 windowMs 生效', async () => {
      const spy = mockCandidates([]);
      const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);

      await service.checkNearDuplicate({ ...nearParams, windowMs: 5 * 60 * 1000 });

      const where = (spy.mock.calls[0][0] as any).where;
      const since: Date = where.createdAt[Op.gte];
      expect(since.getTime()).toBe(1_700_000_000_000 - 5 * 60 * 1000);

      nowSpy.mockRestore();
    });

    it('price 不可解析时回退用 filledPrice 比较（pending entry 场景）', async () => {
      mockCandidates([
        { id: 302, strategyId: 79, price: 'CMP', filledPrice: '4620', lifecycleStatus: 'PENDING' },
      ]);

      const result = await service.checkNearDuplicate(nearParams);

      expect(result.isNearDuplicate).toBe(true);
      expect(result.existingOrderId).toBe(302);
    });

    it('止损缺失导致 R 非法时回退为 entry × 0.5% 容差', async () => {
      // entry=100, 容差 = 100 * 0.5% = 0.5；候选 100.4 在容差内
      mockCandidates([
        { id: 303, strategyId: 80, price: '100.4', filledPrice: '100.4', lifecycleStatus: 'OPEN' },
      ]);

      const result = await service.checkNearDuplicate({
        ...nearParams,
        entryPrice: '100',
        stopLoss: '',
      });

      expect(result.isNearDuplicate).toBe(true);
    });

    it('entryPrice 不可解析 → 直接返回 false 且不查询数据库', async () => {
      const spy = mockCandidates([]);

      const result = await service.checkNearDuplicate({ ...nearParams, entryPrice: 'CMP' });

      expect(result.isNearDuplicate).toBe(false);
      expect(spy).not.toHaveBeenCalled();
    });

    it('自定义 priceDistanceR 收紧容差后不再命中', async () => {
      mockCandidates([
        { id: 304, strategyId: 81, price: '4635', filledPrice: '4635', lifecycleStatus: 'OPEN' },
      ]);

      const result = await service.checkNearDuplicate({ ...nearParams, priceDistanceR: 0.1 }); // 0.1R = 2.9

      expect(result.isNearDuplicate).toBe(false);
    });
  });
});
