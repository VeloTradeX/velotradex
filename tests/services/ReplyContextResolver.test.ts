import {
  ReplyContext,
  ReplyContextResolver,
  applyReplyTargetToResult,
  buildManagementFallback,
  detectMentionedSymbols,
  extractReferenceIds,
  formatReplyContextXml,
} from '../../src/services/parsers/ReplyContextResolver';
import type { LLMResult } from '../../src/services/parsers/RaizexbtAiPrompts';

const TAO_CONTEXT: ReplyContext = {
  chain: [
    {
      id: '1565406471443972218',
      content: '> Reply to: $TAO\n\nNeed to break high then send pls',
      referencedIds: ['1565282397468233771'],
      depth: 1,
    },
    {
      id: '1565282397468233771',
      content: '$TAO Swing longed 1R',
      referencedIds: [],
      depth: 2,
    },
  ],
  origin: {
    messageId: '1565282397468233771',
    strategyId: 224,
    symbol: 'TAO_USDT',
    side: 'buy',
    action: 'open',
    entryPrice: '246.68',
    stopLoss: '225.22',
    orderId: 137,
    exchangeOrderId: '180988411078278951',
    orderStatus: 'open',
    lifecycleStatus: 'PROTECTED',
  },
  symbol: 'TAO_USDT',
};

describe('extractReferenceIds', () => {
  it('extracts the quoted Discord message id from the reply header', () => {
    const content = '> **回复：Need to break high then send pls** https://discord.com/channels/1295108691275813036/1445101762519367811/1565406471443972218\n\nCutting here lil above entry';
    expect(extractReferenceIds({ content })).toEqual(['1565406471443972218']);
  });

  it('returns an empty list for plain messages', () => {
    expect(extractReferenceIds({ content: 'Longed $BTC stops 77.8k' })).toEqual([]);
  });
});

describe('ReplyContextResolver chain walking', () => {
  it('walks two hops from a management reply to the original TAO signal', async () => {
    const messages = new Map([
      ['1565406471443972218', '> Reply to: $TAO https://discord.com/channels/1/2/1565282397468233771\n\nNeed to break high then send pls'],
      ['1565282397468233771', '$TAO Swing longed 1R'],
    ]);
    const resolver = new ReplyContextResolver(
      async (id) => (messages.has(id) ? { id, content: messages.get(id)! } : null),
      3,
      6,
      async () => null,
    );

    const context = await resolver.resolve({
      content: '> Reply to: Need to break high https://discord.com/channels/1/2/1565406471443972218\n\nCutting here lil above entry',
    });

    expect(context.chain.map((message) => message.id)).toEqual([
      '1565406471443972218',
      '1565282397468233771',
    ]);
    expect(context.chain[1].depth).toBe(2);
  });
});

describe('detectMentionedSymbols', () => {
  it('detects cash tags and known bare tickers', () => {
    expect(detectMentionedSymbols('Stops to entry $BTC and $TAO')).toEqual(
      expect.arrayContaining(['BTC_USDT', 'TAO_USDT']),
    );
  });

  it('does not treat ordinary words as symbols', () => {
    expect(detectMentionedSymbols('Cutting here lil above entry')).toEqual([]);
  });
});

describe('applyReplyTargetToResult', () => {
  it('fills a missing symbol from the reply origin', () => {
    const result = { action: 'close', symbol: undefined } as unknown as LLMResult;
    applyReplyTargetToResult(result, 'Cutting here lil above entry', TAO_CONTEXT);
    expect(result.symbol).toBe('TAO_USDT');
    expect(result.replyOrderId).toBe(137);
    expect(result.replyStrategyId).toBe(224);
  });

  it('overrides a wrong LLM guess when the text does not mention a symbol', () => {
    const result = { action: 'close', symbol: 'BTC_USDT' } as LLMResult;
    applyReplyTargetToResult(result, 'Cutting here lil above entry', TAO_CONTEXT);
    expect(result.symbol).toBe('TAO_USDT');
  });

  it('keeps an explicitly mentioned symbol', () => {
    const result = { action: 'update', symbol: 'BTC_USDT' } as LLMResult;
    applyReplyTargetToResult(result, 'Stops to entry $BTC', TAO_CONTEXT);
    expect(result.symbol).toBe('BTC_USDT');
  });
});

describe('buildManagementFallback', () => {
  it('parses a cutting message as a full close for the reply target', () => {
    const result = buildManagementFallback('Cutting here lil above entry', TAO_CONTEXT);
    expect(result?.action).toBe('close');
    expect(result?.symbol).toBe('TAO_USDT');
    expect(result?.closePercentage).toBe(100);
  });

  it('parses stop-to-entry as a breakeven update', () => {
    const result = buildManagementFallback('Stops to entry', TAO_CONTEXT);
    expect(result?.action).toBe('update');
    expect(result?.stopLoss).toBe('breakeven');
  });

  it('does not fire on retrospective recap messages', () => {
    expect(buildManagementFallback('Well good cut on BTC & TAO', TAO_CONTEXT)).toBeNull();
  });

  it('does nothing without a resolvable reply target', () => {
    expect(buildManagementFallback('Cutting here', null)).toBeNull();
  });
});

describe('formatReplyContextXml', () => {
  it('renders the quoted messages and the origin signal', () => {
    const xml = formatReplyContextXml(TAO_CONTEXT);
    expect(xml).toContain('<reply_to>');
    expect(xml).toContain('symbol="TAO_USDT"');
    expect(xml).toContain('order_id="137"');
    expect(xml).toContain('lifecycle_status="PROTECTED"');
    expect(xml).toContain('Need to break high');
  });
});
