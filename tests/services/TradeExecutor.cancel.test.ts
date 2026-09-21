import tradeExecutor from '../../src/services/TradeExecutor';
import exchangeRegistry from '../../src/services/exchanges';
import auditService from '../../src/services/AuditService';
import { Order } from '../../src/models';

jest.mock('../../src/services/exchanges', () => ({
  __esModule: true,
  default: {
    getExchange: jest.fn(),
  },
}));

jest.mock('../../src/services/AuditService', () => ({
  __esModule: true,
  default: {
    log: jest.fn(),
  },
}));

jest.mock('../../src/models', () => ({
  Order: {
    findOne: jest.fn(),
  },
  Strategy: {},
  StrategyPosition: {
    findOne: jest.fn(),
    create: jest.fn(),
  },
  AuditLog: {},
  PendingProtection: {},
  SoftStopLoss: {},
  sequelize: {},
}));

describe('TradeExecutor cancel by scoped symbol', () => {
  const mockExchange = {
    name: 'Mock Gate',
    cancelOrder: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    (exchangeRegistry.getExchange as jest.Mock).mockReturnValue(mockExchange);
    mockExchange.cancelOrder.mockResolvedValue(true);
    (auditService.log as jest.Mock).mockResolvedValue(undefined);
  });

  it('cancels the latest pending route order when parser has no exchange order id', async () => {
    const order = {
      id: 88,
      exchangeOrderId: 'entry-88',
      exchangeInstanceId: 'ex-1',
      symbol: 'BTC_USDT',
      side: 'buy',
      status: 'open',
      lifecycleStatus: 'PENDING',
      save: jest.fn(),
    };
    (Order.findOne as jest.Mock).mockResolvedValue(order);

    const result = await tradeExecutor.execute(
      {
        action: 'cancel',
        symbol: 'BTC_USDT',
        side: 'buy',
        raw: {},
      },
      {} as any,
      'wwg-channel',
      42,
      'ex-1',
      9,
    );

    expect(Order.findOne).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        symbol: 'BTC_USDT',
        side: 'buy',
        routeId: 9,
        exchangeInstanceId: 'ex-1',
      }),
    }));
    expect(mockExchange.cancelOrder).toHaveBeenCalledWith('entry-88', 'BTC_USDT');
    expect(order.status).toBe('cancelled');
    expect(order.lifecycleStatus).toBe('CLOSED');
    expect(order.save).toHaveBeenCalled();
    expect(result).toEqual({ id: 'entry-88', status: 'cancelled', symbol: 'BTC_USDT' });
  });
});
