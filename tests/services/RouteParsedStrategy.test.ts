import { applyAIResultToParsedStrategy } from '../../src/services/RouteParsedStrategy';

describe('applyAIResultToParsedStrategy', () => {
  it('does not overwrite an existing stop loss with null from AI analysis', () => {
    const parsed = {
      action: 'open',
      symbol: 'eth',
      side: 'buy',
      entryPrice: '3500',
      stopLoss: '3400',
      targets: ['3600'],
      raw: {},
    };

    const result = applyAIResultToParsedStrategy(parsed as any, {
      action: 'open',
      symbol: 'ETH_USDT',
      side: 'buy',
      entryPrice: 3500,
      stopLoss: null,
      targets: [3600],
      confidence: 0.9,
    } as any);

    expect(result.stopLoss).toBe('3400');
  });

  it('preserves close management fields from AI analysis', () => {
    const parsed = {
      action: 'close',
      symbol: 'btc',
      side: 'unknown',
      raw: {},
    };

    const result = applyAIResultToParsedStrategy(parsed as any, {
      action: 'close',
      symbol: 'BTC_USDT',
      side: 'sell',
      closePercentage: 70,
      closePrice: null,
      stopLoss: 'breakeven',
      confidence: 0.95,
    } as any);

    expect(result).toEqual(expect.objectContaining({
      action: 'close',
      symbol: 'BTC_USDT',
      side: 'sell',
      closePercentage: 70,
      stopLoss: 'breakeven',
    }));
  });
});
