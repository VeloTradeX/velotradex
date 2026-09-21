/**
 * 回归测试：recoverMonitors 遇到 exchangeInstanceId 已不存在的 open 订单时，
 * 应跳过该订单并继续恢复其余订单，不得让整个恢复流程中断。
 *
 * 背景：数据库中存在 status='open' 的历史订单，但其交易所实例已被删除/停用，
 * exchangeRegistry.getExchange(id) 会 throw；原实现中该调用位于单订单
 * try 块之外，异常冒泡到外层 catch 后整个恢复循环终止，其余有效订单
 * 全部失去恢复机会。
 */
import { StartupRecoveryService } from '../../src/services/StartupRecoveryService';

jest.mock('../../src/models', () => ({
  Order: { findAll: jest.fn() },
  Strategy: { findByPk: jest.fn() },
}));

jest.mock('../../src/services/exchanges', () => ({
  __esModule: true,
  default: {
    getExchange: jest.fn(),
    getAllExchanges: jest.fn(),
  },
}));

jest.mock('../../src/services/parsers', () => ({
  __esModule: true,
  default: { getParserByName: jest.fn(() => null) },
}));

jest.mock('../../src/services/ParserConfigService', () => ({
  __esModule: true,
  default: { getEffectiveConfig: jest.fn() },
}));

jest.mock('../../src/services/AuditService', () => ({
  __esModule: true,
  default: { log: jest.fn() },
}));

import { Order, Strategy } from '../../src/models';
import exchangeRegistry from '../../src/services/exchanges';
import auditService from '../../src/services/AuditService';

function makeExecutor() {
  const mockOrchestrator = { run: jest.fn().mockResolvedValue(undefined) };
  const executor = {
    getProtectionPipeline: jest.fn(),
    createPostFillOrchestrator: jest.fn().mockReturnValue(mockOrchestrator),
    getFillWaitTimeout: jest.fn(),
    runWithStrategyTrace: jest.fn((_id: number, fn: () => Promise<unknown>) => fn()),
    noStopLossMonitor: {},
  };
  return { executor, mockOrchestrator };
}

describe('StartupRecoveryService.recoverMonitors', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('某订单的交易所实例不存在时跳过该订单，并继续恢复其余订单', async () => {
    const orderA = {
      id: 1,
      exchangeInstanceId: 'v-always-win', // 已删除/停用的实例
      exchangeOrderId: 'exA',
      symbol: 'BTC_USDT',
      strategyId: 10,
      type: 'market',
      status: 'open',
      lifecycleStatus: 'PENDING',
      isSimulated: false,
      save: jest.fn(),
    };
    const orderB = {
      id: 2,
      exchangeInstanceId: 'gate_main',
      exchangeOrderId: 'exB',
      symbol: 'ETH_USDT',
      strategyId: 11,
      type: 'limit',
      status: 'open',
      lifecycleStatus: 'PENDING',
      isSimulated: false,
      save: jest.fn(),
    };

    (Order.findAll as jest.Mock).mockResolvedValue([orderA, orderB]);

    const mockExchange = {
      getOrder: jest.fn().mockResolvedValue({
        status: 'filled', amount: '1', price: '3000', raw: {},
      }),
    };
    (exchangeRegistry.getExchange as jest.Mock).mockImplementation((id: string) => {
      if (id === 'gate_main') return mockExchange;
      throw new Error(`Exchange instance ${id} not found`);
    });

    (Strategy.findByPk as jest.Mock).mockResolvedValue({
      id: 11,
      action: 'open',
      symbol: 'ETH_USDT',
      side: 'buy',
      entryPrice: '2900',
      targets: '[]',
      stopLoss: '2800',
      leverage: '10',
      rawMessage: null,
      parserName: null,
      source: 'test',
    });

    const { executor, mockOrchestrator } = makeExecutor();
    const service = new StartupRecoveryService(executor as any);

    // 修复前：getExchange('v-always-win') 抛错冒泡到外层 catch，
    // recoverMonitors 直接走 "Failed to recover monitors" 分支，orderB 永不处理
    await expect(service.recoverMonitors()).resolves.toBeUndefined();

    // 不存在的实例被跳过：A 的 getOrder 不应被调用
    expect(mockExchange.getOrder).not.toHaveBeenCalledWith('exA', 'BTC_USDT');
    // 其余订单恢复流程未被中断：B 正常查询并执行 post-fill
    expect(mockExchange.getOrder).toHaveBeenCalledWith('exB', 'ETH_USDT');
    expect(mockOrchestrator.run).toHaveBeenCalled();
    expect(orderB.status).toBe('filled');
    expect(orderB.lifecycleStatus).toBe('OPEN');
  });

  it('全部订单实例存在时，逐个正常恢复', async () => {
    const order = {
      id: 3,
      exchangeInstanceId: 'gate_main',
      exchangeOrderId: 'exC',
      symbol: 'BTC_USDT',
      strategyId: 12,
      type: 'market',
      status: 'open',
      lifecycleStatus: 'PENDING',
      isSimulated: false,
      save: jest.fn(),
    };
    (Order.findAll as jest.Mock).mockResolvedValue([order]);

    const mockExchange = {
      getOrder: jest.fn().mockResolvedValue({ status: 'cancelled', raw: {} }),
    };
    (exchangeRegistry.getExchange as jest.Mock).mockReturnValue(mockExchange);
    (Strategy.findByPk as jest.Mock).mockResolvedValue({
      id: 12, action: 'open', symbol: 'BTC_USDT', side: 'buy',
      entryPrice: '64000', targets: '[]', stopLoss: '62000',
      leverage: '10', rawMessage: null, parserName: null, source: 'test',
    });

    const { executor } = makeExecutor();
    const service = new StartupRecoveryService(executor as any);

    await expect(service.recoverMonitors()).resolves.toBeUndefined();

    expect(mockExchange.getOrder).toHaveBeenCalledWith('exC', 'BTC_USDT');
    expect(order.status).toBe('cancelled');
    expect(order.lifecycleStatus).toBe('CLOSED');
    expect(auditService.log).not.toHaveBeenCalled();
  });
});
