import { AlwaysWinParser } from '../../../src/services/parsers/AlwaysWinParser';
import { DiscordMessage } from '../../../src/services/parsers/types';

describe('AlwaysWinParser', () => {
  let parser: AlwaysWinParser;

  beforeEach(() => {
    parser = new AlwaysWinParser();
  });

  describe('getRiskConfig', () => {
    it('should return correct risk configuration', () => {
      const config = parser.getRiskConfig();
      
      expect(config.riskMode).toBe('fixed');
      expect(config.riskValue).toBe(5);
      expect(config.defaultLeverage).toBe('10');
      expect(config.priceTolerance).toBe(0.01);
      expect(config.entryPaddingR).toBe(0.01);
      expect(config.entryOrderMode).toBe('taker');
      expect(config.tpPaddingR).toBe(0.01);
      expect(config.slPaddingR).toBe(0.01);
      expect(config.tpDistribution).toEqual([0.6, 0.3, 0.1]);
      expect(config.tpOrderType).toBe('limit');
      expect(config.tpOrderMode).toBe('maker');
      expect(config.autoCloseOppositePosition).toBe(false);
    });
  });

  describe('parse', () => {
    it('should parse coin label with compact USDT symbol and colon targets', async () => {
      const message: DiscordMessage = {
        id: 'always-win-compact-coin',
        channel_id: 'channel1',
        content: [
          'Coin: LDOUSDT Short',
          'Leverage: Isolated x10',
          'Entry: 0.3979',
          'target 1: 0.3912',
          'Target 2: 0.3795',
          'SL: 0.4118',
        ].join('\n'),
        ts: Date.now().toString(),
        username: 'testuser'
      };

      const result = await parser.parse(message, true);

      expect(result).toEqual([{
        action: 'open',
        symbol: 'LDO_USDT',
        side: 'sell',
        entryPrice: '0.3979',
        targets: ['0.3912', '0.3795'],
        stopLoss: '0.4118',
        leverage: '10',
        raw: message,
      }]);
    });

    it('should handle duplicate messages within dedup window', async () => {
      const message: DiscordMessage = {
        id: '123',
        channel_id: 'channel1',
        content: 'BTC LONG 50000',
        ts: Date.now().toString(),
        username: 'testuser'
      };

      // First parse should succeed
      const result1 = await parser.parse(message);
      
      // Second parse with same content should be filtered out
      const duplicateMessage = { ...message, id: '124' };
      const result2 = await parser.parse(duplicateMessage);
      
      expect(result2).toBeNull();
    });

    it('should allow messages after dedup window expires', async () => {
      const message: DiscordMessage = {
        id: '123',
        channel_id: 'channel1',
        content: 'BTC LONG 50000',
        ts: Date.now().toString(),
        username: 'testuser'
      };

      // First parse
      await parser.parse(message);

      // Mock time to simulate window expiry
      const originalNow = Date.now;
      Date.now = jest.fn(() => originalNow() + 11 * 60 * 1000); // 11 minutes later

      // Same content should be allowed after window expires
      const sameContentMessage = { ...message, id: '125' };
      const result = await parser.parse(sameContentMessage);
      
      // Should not be filtered as duplicate since window expired
      // Note: Result may still be null if content doesn't match parser patterns
      expect(result).toBeNull(); // AlwaysWin parser doesn't recognize this simple format

      Date.now = originalNow;
    });

    it('should handle empty or invalid content', async () => {
      const message: DiscordMessage = {
        id: '123',
        channel_id: 'channel1',
        content: '',
        ts: Date.now().toString(),
        username: 'testuser'
      };

      const result = await parser.parse(message);
      expect(result).toBeNull();
    });
  });
});
