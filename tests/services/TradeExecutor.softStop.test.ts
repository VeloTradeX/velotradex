import tradeExecutor from '../../src/services/TradeExecutor';
import { SoftStopLoss } from '../../src/models';

describe('TradeExecutor soft stop persistence', () => {
  beforeEach(() => {
    jest.restoreAllMocks();
  });

  it('persists active Neil soft stop metadata from parsed raw', async () => {
    const createSpy = jest.spyOn(SoftStopLoss, 'create').mockResolvedValue({} as any);

    await (tradeExecutor as any).persistSoftStopLossIfPresent({
      strategyId: 11,
      orderId: 22,
      source: 'neil-channel',
      parserName: 'NeilParser',
      exchangeInstanceId: 'gate-main',
      parsed: {
        symbol: 'INIT_USDT',
        side: 'buy',
        raw: {
          neil: {
            softStop: {
              price: 0.081,
              timeframe: '4h',
              direction: 'close_under',
              sourceText: '4H close under 0.081 for stops',
              status: 'active',
            },
            hardStopLoss: 0.0775,
            hardStopRMultiplier: 2,
          },
        },
      },
    });

    expect(createSpy).toHaveBeenCalledWith(expect.objectContaining({
      parserName: 'NeilParser',
      strategyId: 11,
      orderId: 22,
      source: 'neil-channel',
      exchangeInstanceId: 'gate-main',
      symbol: 'INIT_USDT',
      side: 'buy',
      timeframe: '4h',
      direction: 'close_under',
      price: '0.081',
      status: 'ACTIVE',
    }));
  });

  it('does not persist unknown or manual-review soft stops', async () => {
    const createSpy = jest.spyOn(SoftStopLoss, 'create').mockResolvedValue({} as any);

    await (tradeExecutor as any).persistSoftStopLossIfPresent({
      strategyId: 11,
      orderId: 22,
      source: 'neil-channel',
      parserName: 'NeilParser',
      exchangeInstanceId: 'gate-main',
      parsed: {
        symbol: 'INIT_USDT',
        side: 'buy',
        raw: {
          neil: {
            softStop: {
              price: 0.081,
              timeframe: 'unknown',
              direction: 'close_under',
              status: 'requiresManualReview',
            },
          },
        },
      },
    });

    expect(createSpy).not.toHaveBeenCalled();
  });
});
