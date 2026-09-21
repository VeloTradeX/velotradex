import { SoftStopLoss } from '../../src/models';
import exchangeRegistry from '../../src/services/exchanges';
import { SoftStopLossMonitor } from '../../src/services/SoftStopLossMonitor';

jest.mock('../../src/models', () => ({
  SoftStopLoss: {
    findAll: jest.fn(),
    update: jest.fn(),
  },
  Order: {
    findOne: jest.fn().mockResolvedValue(null),
  },
}));

jest.mock('../../src/services/exchanges', () => ({
  __esModule: true,
  default: {
    getExchange: jest.fn(),
    hasExchange: jest.fn(),
  },
}));

jest.mock('../../src/services/AuditService', () => ({
  __esModule: true,
  default: { log: jest.fn() },
}));

describe('SoftStopLossMonitor', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // 交易所实例存在（不在孤儿清理路径）
    (exchangeRegistry as any).hasExchange.mockReturnValue(true);
  });

  it('triggers long close only on closed candle below soft stop', async () => {
    const record: any = {
      id: 1,
      strategyId: 11,
      exchangeInstanceId: 'gate-main',
      symbol: 'INIT_USDT',
      side: 'buy',
      timeframe: '4h',
      direction: 'close_under',
      price: '0.081',
      status: 'ACTIVE',
      save: jest.fn(),
      reload: jest.fn().mockImplementation(async function(this: any) {
        this.status = 'TRIGGERED';
        this.triggerClosePrice = '0.0809';
      }),
    };
    (SoftStopLoss.findAll as jest.Mock).mockResolvedValue([record]);
    (SoftStopLoss.update as jest.Mock).mockResolvedValue([1]);
    const exchange = {
      getCandles: jest.fn().mockResolvedValue([
        { timestamp: Date.now() - 5 * 60 * 60 * 1000, close: '0.0809', open: '0.082', high: '0.083', low: '0.08' },
      ]),
    };
    (exchangeRegistry.getExchange as jest.Mock).mockReturnValue(exchange);
    const handleClose = jest.fn().mockResolvedValue({ status: 'filled' });

    const monitor = new SoftStopLossMonitor({ handleClose });
    await monitor.scanOnce();

    expect(handleClose).toHaveBeenCalledWith(expect.objectContaining({
      symbol: 'INIT_USDT',
      side: 'buy',
      exchangeInstanceId: 'gate-main',
      strategyId: 11,
    }));
    expect(SoftStopLoss.update).toHaveBeenCalledWith(
      { status: 'TRIGGERED', triggeredAt: expect.any(Date), triggerClosePrice: '0.0809' },
      { where: { id: 1, status: 'ACTIVE' }, limit: 1 },
    );
    expect(record.reload).toHaveBeenCalledTimes(1);
    expect(record.status).toBe('TRIGGERED');
    expect(record.triggerClosePrice).toBe('0.0809');
  });

  it('does not trigger on long candle above soft stop', async () => {
    const record: any = {
      id: 2,
      strategyId: 12,
      exchangeInstanceId: 'gate-main',
      symbol: 'INIT_USDT',
      side: 'buy',
      timeframe: '4h',
      direction: 'close_under',
      price: '0.081',
      status: 'ACTIVE',
      save: jest.fn(),
      reload: jest.fn(),
    };
    (SoftStopLoss.findAll as jest.Mock).mockResolvedValue([record]);
    (SoftStopLoss.update as jest.Mock).mockResolvedValue([0]);
    (exchangeRegistry.getExchange as jest.Mock).mockReturnValue({
      getCandles: jest.fn().mockResolvedValue([{ timestamp: Date.now() - 5 * 60 * 60 * 1000, close: '0.0811' }]),
    });
    const handleClose = jest.fn();

    const monitor = new SoftStopLossMonitor({ handleClose });
    await monitor.scanOnce();

    expect(handleClose).not.toHaveBeenCalled();
    expect(SoftStopLoss.update).not.toHaveBeenCalled();
    expect(record.reload).not.toHaveBeenCalled();
  });

  it('triggers short close on closed candle above soft stop', async () => {
    const record: any = {
      id: 3,
      strategyId: 13,
      exchangeInstanceId: 'gate-main',
      symbol: 'SOL_USDT',
      side: 'sell',
      timeframe: '15m',
      direction: 'close_above',
      price: '90.16',
      status: 'ACTIVE',
      save: jest.fn(),
      reload: jest.fn().mockImplementation(async function(this: any) {
        this.status = 'TRIGGERED';
        this.triggerClosePrice = '90.17';
      }),
    };
    (SoftStopLoss.findAll as jest.Mock).mockResolvedValue([record]);
    (SoftStopLoss.update as jest.Mock).mockResolvedValue([1]);
    (exchangeRegistry.getExchange as jest.Mock).mockReturnValue({
      getCandles: jest.fn().mockResolvedValue([{ timestamp: Date.now() - 20 * 60 * 1000, close: '90.17' }]),
    });
    const handleClose = jest.fn().mockResolvedValue({ status: 'filled' });

    const monitor = new SoftStopLossMonitor({ handleClose });
    await monitor.scanOnce();

    expect(handleClose).toHaveBeenCalledTimes(1);
    expect(SoftStopLoss.update).toHaveBeenCalledWith(
      { status: 'TRIGGERED', triggeredAt: expect.any(Date), triggerClosePrice: '90.17' },
      { where: { id: 3, status: 'ACTIVE' }, limit: 1 },
    );
    expect(record.reload).toHaveBeenCalledTimes(1);
    expect(record.status).toBe('TRIGGERED');
  });

  it('does not trigger on an in-progress candle', async () => {
    const record: any = {
      id: 4,
      strategyId: 14,
      exchangeInstanceId: 'gate-main',
      symbol: 'INIT_USDT',
      side: 'buy',
      timeframe: '4h',
      direction: 'close_under',
      price: '0.081',
      status: 'ACTIVE',
      save: jest.fn(),
      reload: jest.fn(),
    };
    (SoftStopLoss.findAll as jest.Mock).mockResolvedValue([record]);
    (SoftStopLoss.update as jest.Mock).mockResolvedValue([0]);
    (exchangeRegistry.getExchange as jest.Mock).mockReturnValue({
      getCandles: jest.fn().mockResolvedValue([{ timestamp: Date.now() - 30 * 60 * 1000, close: '0.0809' }]),
    });
    const handleClose = jest.fn();

    const monitor = new SoftStopLossMonitor({ handleClose });
    await monitor.scanOnce();

    expect(handleClose).not.toHaveBeenCalled();
    expect(SoftStopLoss.update).not.toHaveBeenCalled();
    expect(record.reload).not.toHaveBeenCalled();
  });
});
