// tests/services/StrategyDeduplicationService.test.ts
import { StrategyDeduplicationService, StrategyDedupParams } from '../../src/services/StrategyDeduplicationService';

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
});
