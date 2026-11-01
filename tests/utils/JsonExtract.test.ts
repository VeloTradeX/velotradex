import { extractFirstJsonObject } from '../../src/utils/jsonExtract';

describe('extractFirstJsonObject', () => {
  it('extracts a plain JSON object', () => {
    expect(extractFirstJsonObject('{"action":"close","symbol":"TAO_USDT"}'))
      .toBe('{"action":"close","symbol":"TAO_USDT"}');
  });

  it('ignores trailing tool-call leftovers that break JSON.parse', () => {
    const content = '{"action":"close","symbol":null,"closePercentage":100}<function';
    expect(extractFirstJsonObject(content))
      .toBe('{"action":"close","symbol":null,"closePercentage":100}');
  });

  it('ignores leading prose and markdown fences', () => {
    const content = 'Here is the result:\n```json\n{"action":"update","stopLoss":"breakeven"}\n```\nDone.';
    expect(extractFirstJsonObject(content)).toBe('{"action":"update","stopLoss":"breakeven"}');
  });

  it('handles braces and escaped quotes inside strings', () => {
    const content = '{"reasoning":"entry {box} and \\"quoted\\" text","action":"open"}';
    expect(extractFirstJsonObject(content)).toBe(content);
  });

  it('handles nested objects', () => {
    const content = '{"a":{"b":{"c":1}},"d":2} trailing';
    expect(extractFirstJsonObject(content)).toBe('{"a":{"b":{"c":1}},"d":2}');
  });

  it('returns null for truncated output', () => {
    expect(extractFirstJsonObject('{"action":"close","symbol":"BTC_USDT"')).toBeNull();
  });

  it('returns null when there is no object', () => {
    expect(extractFirstJsonObject('no json here')).toBeNull();
  });
});
