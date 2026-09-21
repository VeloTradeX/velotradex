import tradingStatsService from '../../src/services/TradingStatsService';
import exchangeRegistry from '../../src/services/exchanges';
import { Order } from '../../src/models';

jest.mock('../../src/services/exchanges', () => ({
  __esModule: true,
  default: { getExchange: jest.fn() },
}));

jest.mock('../../src/models', () => ({
  Order: { findByPk: jest.fn() },
  SignalRoute: {},
  Strategy: {},
}));

describe('TradingStatsService exchange market lookup', () => {
  it('uses order.exchangeInstanceId when recording stats', async () => {
    const save = jest.fn();
    (Order.findByPk as jest.Mock).mockResolvedValue({
      id: 1,
      exchangeInstanceId: 'virtual_1',
      symbol: 'BTC_USDT',
      side: 'buy',
      amount: '100',
      filledAmount: '100',
      price: '65000',
      filledPrice: '65000',
      initialSl: '64000',
      leverage: '1',
      realizedPnl: null,
      save,
    });
    (exchangeRegistry.getExchange as jest.Mock).mockReturnValue({
      getMarkets: jest.fn().mockResolvedValue([{ symbol: 'BTC_USDT', multiplier: '0.0001' }]),
    });

    await tradingStatsService.recordOrderStats(1, '66000', new Date('2026-05-04T00:00:00.000Z'));

    expect(exchangeRegistry.getExchange).toHaveBeenCalledWith('virtual_1');
    expect(save).toHaveBeenCalled();
  });
});
