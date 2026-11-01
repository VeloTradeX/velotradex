import { LLMResult } from '../../src/services/parsers/RaizexbtAiPrompts';
import {
  convertToStrategies,
  resolveClosePercentage,
} from '../../src/services/parsers/RaizexbtStrategyConversion';

const partialAndBe = {
  content: '1.8R+ partials\n\nSl entry\n\n1.8R+ 分批止盈\n\n止损 入场\n--------------\n<@&1>',
};

const partialOnly = {
  content: '1.8R+ partials\n\n1.8R+ 分批止盈\n--------------\n<@&1>',
};

const partialWithPercent = {
  content: '1.8R+ partials 30%\n\nSl entry',
};

describe('Raizexbt partial-exit conversion', () => {
  it('turns a close result with partial wording into close 50% + breakeven update', () => {
    const result: LLMResult = {
      action: 'close',
      symbol: 'ETH_USDT',
      side: 'buy',
      closePercentage: null,
      stopLoss: 'breakeven',
      confidence: 0.9,
    };

    const strategies = convertToStrategies(result, partialAndBe, 'test');

    expect(strategies).toHaveLength(2);
    expect(strategies?.[0]).toMatchObject({
      action: 'close',
      symbol: 'ETH_USDT',
      closePercentage: 50,
    });
    expect(strategies?.[1]).toMatchObject({
      action: 'update',
      symbol: 'ETH_USDT',
      stopLoss: 'breakeven',
    });
  });

  it('recovers the partial even when the LLM labelled the message as update', () => {
    const result: LLMResult = {
      action: 'update',
      symbol: 'ETH_USDT',
      side: 'buy',
      stopLoss: 'breakeven',
      confidence: 0.9,
    };

    const strategies = convertToStrategies(result, partialAndBe, 'test');

    expect(strategies).toHaveLength(2);
    expect(strategies?.[0]).toMatchObject({ action: 'close', closePercentage: 50 });
    expect(strategies?.[1]).toMatchObject({ action: 'update', stopLoss: 'breakeven' });
  });

  it('never defaults partial intent to 100 even when the LLM says 100', () => {
    const result: LLMResult = {
      action: 'close',
      symbol: 'ETH_USDT',
      closePercentage: 100,
      confidence: 0.9,
    };

    const strategies = convertToStrategies(result, partialOnly, 'test');

    expect(strategies).toHaveLength(1);
    expect(strategies?.[0].closePercentage).toBe(50);
  });

  it('keeps an explicit percentage from the message', () => {
    const result: LLMResult = {
      action: 'close',
      symbol: 'ETH_USDT',
      closePercentage: null,
      stopLoss: 'breakeven',
      confidence: 0.9,
    };

    const strategies = convertToStrategies(result, partialWithPercent, 'test');

    expect(strategies).toHaveLength(2);
    expect(strategies?.[0].closePercentage).toBe(30);
    expect(strategies?.[1]).toMatchObject({ action: 'update', stopLoss: 'breakeven' });
  });

  it('keeps an explicit full close at 100 and does not add a breakeven update', () => {
    const result: LLMResult = {
      action: 'close',
      symbol: 'ETH_USDT',
      closePercentage: 100,
      confidence: 0.9,
    };

    const strategies = convertToStrategies(result, { content: 'all out\n\nclosed' }, 'test');

    expect(strategies).toHaveLength(1);
    expect(strategies?.[0].closePercentage).toBe(100);
  });

  it('does not treat a pure breakeven message as a partial exit', () => {
    const result: LLMResult = {
      action: 'update',
      symbol: 'ETH_USDT',
      stopLoss: 'breakeven',
      confidence: 0.9,
    };

    const strategies = convertToStrategies(result, { content: 'Sl entry' }, 'test');

    expect(strategies).toHaveLength(1);
    expect(strategies?.[0]).toMatchObject({ action: 'update', stopLoss: 'breakeven' });
  });

  it('defaults resolveClosePercentage to 50 for partial intent without a percentage', () => {
    const result: LLMResult = { action: 'close', symbol: 'ETH_USDT' };
    expect(resolveClosePercentage(result, partialOnly)).toBe(50);
  });
});
