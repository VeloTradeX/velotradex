import {
  analyzeManagementContext,
  isStopToEntryText,
} from '../../../src/services/parsers/RaizexbtTextMatchers';
import { convertToStrategies } from '../../../src/services/parsers/RaizexbtStrategyConversion';
import { LLMResult } from '../../../src/services/parsers/RaizexbtAiPrompts';

function message(content: string) {
  return { id: 'test-msg', channel_id: 'test-channel', content, ts: new Date().toISOString(), username: 'raizelxbt' };
}

function result(overrides: Partial<LLMResult> = {}): LLMResult {
  return {
    action: 'open',
    symbol: 'BTC_USDT',
    side: 'sell',
    entryPrice: 82487.5,
    stopLoss: 83019.1,
    targets: [80715.9],
    orderType: 'limit',
    confidence: 0.85,
    reasoning: 'chart signal',
    ...overrides,
  };
}

describe('raizexbt stop-to-entry (breakeven) detection', () => {
  describe('isStopToEntryText', () => {
    const positives = [
      'Stops entry',
      'stops entry and manage trade',
      'stops to entry',
      'sl to entry',
      'stop loss to entry',
      'move my stop loss to entry',
      'moving stops up to entry',
      'stops at entry',
      'sl at entry price',
      'stop to be',
    ];

    it.each(positives)('detects "%s"', (text) => {
      expect(isStopToEntryText(text)).toBe(true);
    });

    const negatives = [
      'entry and stops in chart',
      'stops above entry',
      'longed $BTC',
      'limit long set',
      '',
    ];

    it.each(negatives)('does not detect "%s"', (text) => {
      expect(isStopToEntryText(text)).toBe(false);
    });
  });

  describe('analyzeManagementContext', () => {
    it('flags stop-to-entry shorthand', () => {
      const ctx = analyzeManagementContext(message('Stops entry'));
      expect(ctx.hasStopToEntryIntent).toBe(true);
      expect(ctx.hasCloseVerb).toBe(false);
    });

    it('does not flag "entry and stops in chart" as stop-to-entry', () => {
      const ctx = analyzeManagementContext(message('$BTC\nlimit long set\nentry and stops in chart'));
      expect(ctx.hasStopToEntryIntent).toBe(false);
      expect(ctx.hasBreakevenWord).toBe(false);
    });

    it('still flags classic breakeven wording', () => {
      expect(analyzeManagementContext(message('stops be')).hasBreakevenWord).toBe(true);
      expect(analyzeManagementContext(message('move to breakeven')).hasBreakevenWord).toBe(true);
    });
  });

  describe('convertToStrategies', () => {
    it('turns a chart-signal open into an update+breakeven for "Stops entry"', () => {
      const strategies = convertToStrategies(result(), message('Stops entry'), 'test:');
      expect(strategies).toEqual([
        { action: 'update', symbol: 'BTC_USDT', stopLoss: 'breakeven', raw: expect.any(Object) },
      ]);
    });

    it('applies even when the message replies to an earlier entry', () => {
      const strategies = convertToStrategies(
        result(),
        message('> Reply to: longed $BTC https://discord.com/channels/1/2/3\n\nStops entry\n\n止损移至入场价'),
        'test:'
      );
      expect(strategies).toHaveLength(1);
      expect(strategies![0]).toMatchObject({ action: 'update', symbol: 'BTC_USDT', stopLoss: 'breakeven' });
    });

    it('keeps a genuine chart open untouched when there is no management intent', () => {
      const strategies = convertToStrategies(
        result(),
        message('$BTC\nlimit long set\nentry and stops in chart'),
        'test:'
      );
      expect(strategies).toHaveLength(1);
      expect(strategies![0].action).toBe('open');
    });

    it('keeps the existing behavior for plain breakeven + open (LLM decision trusted)', () => {
      const strategies = convertToStrategies(
        result({ stopLoss: 'breakeven', entryPrice: null, orderType: 'market' }),
        message('breakeven'),
        'test:'
      );
      expect(strategies![0].action).toBe('open');
    });

    it('still converts an update+breakeven for "stops entry"', () => {
      const strategies = convertToStrategies(
        result({ action: 'update', entryPrice: null, targets: [], orderType: undefined }),
        message('stops entry'),
        'test:'
      );
      expect(strategies).toEqual([
        { action: 'update', symbol: 'BTC_USDT', stopLoss: 'breakeven', raw: expect.any(Object) },
      ]);
    });
  });
});
