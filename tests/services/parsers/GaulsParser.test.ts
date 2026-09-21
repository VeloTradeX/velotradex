import { GaulsParser } from '../../../src/services/parsers/GaulsParser';
import { GaulsAISignal, ParsedStrategy } from '../../../src/services/parsers/types';

jest.mock('../../../src/services/MarketService', () => ({
  __esModule: true,
  default: {
    getCurrentPrice: jest.fn().mockResolvedValue(100),
  },
}));

jest.mock('../../../src/services/AIParserService', () => ({
  __esModule: true,
  default: {
    isConfigured: jest.fn().mockReturnValue(false),
    analyzeRaw: jest.fn(),
  },
}));

describe('GaulsParser', () => {
  let parser: GaulsParser;

  beforeEach(() => {
    parser = new GaulsParser();
  });

  describe('getRiskConfig', () => {
    it('should return correct risk configuration', () => {
      const config = parser.getRiskConfig();

      expect(config.riskMode).toBe('percentage');
      expect(config.riskValue).toBe(2);
      expect(config.defaultLeverage).toBe('5');
      expect(config.priceTolerance).toBe(0.01);
      expect(config.entryOrderMode).toBe('taker');
      expect(config.tpDistribution).toEqual([0.5, 0.5]);
      expect(config.autoCloseOppositePosition).toBe(false);
    });
  });

  describe('postProcess', () => {
    it('should convert open buy signal to ParsedStrategy', async () => {
      const signal: GaulsAISignal = {
        action: 'open',
        side: 'buy',
        symbol: 'WIF',
        entries: [{ type: 'market' }],
        takeProfits: [0.2362],
        stopLoss: 0.1841,
        confidence: 0.9,
        reasoning: 'Buying setup for WIF'
      };

      const result = await parser.postProcess(signal);

      expect(result).not.toBeNull();
      expect(result).toHaveLength(1);
      expect(result![0].action).toBe('open');
      expect(result![0].symbol).toBe('WIF_USDT');
      expect(result![0].side).toBe('buy');
      expect(result![0].orderType).toBe('market');
      expect(result![0].entryPrice).toBe('CMP');
      expect(result![0].targets).toEqual(['0.2362']);
      expect(result![0].stopLoss).toBe('0.1841');
      expect(result![0].confidence).toBe(0.9);
    });

    it('should convert open sell signal with multiple entries', async () => {
      const signal: GaulsAISignal = {
        action: 'open',
        side: 'sell',
        symbol: 'BONK',
        entries: [
          { type: 'market' },
          { type: 'limit', price: 6119 }
        ],
        takeProfits: [5413],
        stopLoss: 6119,
        confidence: 0.85
      };

      const result = await parser.postProcess(signal);

      expect(result).not.toBeNull();
      expect(result).toHaveLength(2);

      expect(result![0].action).toBe('open');
      expect(result![0].symbol).toBe('BONK_USDT');
      expect(result![0].side).toBe('sell');
      expect(result![0].orderType).toBe('market');
      expect(result![0].entryPrice).toBe('CMP');
      expect(result![0].targets).toEqual(['5413']);
      expect(result![0].stopLoss).toBe('6119');
      expect(result![0].weight).toBe(0.5);

      expect(result![1].action).toBe('open');
      expect(result![1].symbol).toBe('BONK_USDT');
      expect(result![1].side).toBe('sell');
      expect(result![1].orderType).toBe('limit');
      expect(result![1].entryPrice).toBe('6119');
      expect(result![1].targets).toEqual(['5413']);
      expect(result![1].stopLoss).toBe('6119');
      expect(result![1].weight).toBe(0.5);
    });

    it('should convert close signal', async () => {
      const signal: GaulsAISignal = {
        action: 'close',
        symbol: 'ETH',
        closePercentage: 100,
        referencedSymbol: 'ETH',
        confidence: 0.95,
        reasoning: 'Closing at entry'
      };

      const result = await parser.postProcess(signal);

      expect(result).not.toBeNull();
      expect(result).toHaveLength(1);
      expect(result![0].action).toBe('close');
      expect(result![0].symbol).toBe('ETH_USDT');
      expect(result![0].closePercentage).toBe(100);
    });

    it('should convert close signal with partial percentage', async () => {
      const signal: GaulsAISignal = {
        action: 'close',
        symbol: 'KAITO',
        closePercentage: 50,
        confidence: 0.9
      };

      const result = await parser.postProcess(signal);

      expect(result).not.toBeNull();
      expect(result).toHaveLength(1);
      expect(result![0].action).toBe('close');
      expect(result![0].symbol).toBe('KAITO_USDT');
      expect(result![0].closePercentage).toBe(50);
    });

    it('should convert update signal with new stop loss', async () => {
      const signal: GaulsAISignal = {
        action: 'update',
        symbol: 'NEAR',
        newStopLoss: 1.317,
        confidence: 0.9,
        reasoning: 'Moving SL to breakeven'
      };

      const result = await parser.postProcess(signal);

      expect(result).not.toBeNull();
      expect(result).toHaveLength(1);
      expect(result![0].action).toBe('update');
      expect(result![0].symbol).toBe('NEAR_USDT');
      expect(result![0].stopLoss).toBe('1.317');
    });

    it('should convert update signal with breakeven stop loss', async () => {
      const signal: GaulsAISignal = {
        action: 'update',
        symbol: 'VET',
        newStopLoss: 'breakeven',
        confidence: 0.9
      };

      const result = await parser.postProcess(signal);

      expect(result).not.toBeNull();
      expect(result).toHaveLength(1);
      expect(result![0].action).toBe('update');
      expect(result![0].symbol).toBe('VET_USDT');
      expect(result![0].stopLoss).toBe('breakeven');
    });

    it('should return null for ignore action', async () => {
      const signal: GaulsAISignal = {
        action: 'ignore',
        confidence: 0.1,
        reasoning: 'Non-trading message'
      };

      const result = await parser.postProcess(signal);
      expect(result).toBeNull();
    });

    it('should return null for open signal without symbol', async () => {
      const signal: GaulsAISignal = {
        action: 'open',
        side: 'buy',
        entries: [{ type: 'market' }],
        confidence: 0.5
      };

      const result = await parser.postProcess(signal);
      expect(result).toBeNull();
    });

    it('should return null for close signal without symbol', async () => {
      const signal: GaulsAISignal = {
        action: 'close',
        closePercentage: 100,
        confidence: 0.9
      };

      const result = await parser.postProcess(signal);
      expect(result).toBeNull();
    });

    it('should normalize symbol to BASE_USDT format', async () => {
      const signal: GaulsAISignal = {
        action: 'open',
        side: 'buy',
        symbol: 'BTC',
        entries: [{ type: 'market' }],
        takeProfits: [72000],
        stopLoss: 69000,
        confidence: 0.9
      };

      const result = await parser.postProcess(signal);

      expect(result).not.toBeNull();
      expect(result![0].symbol).toBe('BTC_USDT');
    });

    it('should preserve riskMultiplier from signal', async () => {
      const signal: GaulsAISignal = {
        action: 'open',
        side: 'buy',
        symbol: 'ETH',
        entries: [{ type: 'market' }],
        takeProfits: [2389],
        stopLoss: 1979,
        riskMultiplier: 0.5,
        confidence: 0.9
      };

      const result = await parser.postProcess(signal);

      expect(result).not.toBeNull();
      expect(result![0].riskMultiplier).toBe(0.5);
    });

    it('should handle stopLoss as number and convert to string', async () => {
      const signal: GaulsAISignal = {
        action: 'open',
        side: 'buy',
        symbol: 'WIF',
        entries: [{ type: 'limit', price: 0.19 }],
        takeProfits: [0.2362],
        stopLoss: 0.1841,
        confidence: 0.9
      };

      const result = await parser.postProcess(signal);

      expect(result).not.toBeNull();
      expect(result).toHaveLength(1);
      expect(typeof result![0].stopLoss).toBe('string');
      expect(result![0].stopLoss).toBe('0.1841');
    });

    it('should handle takeProfits as number array and convert to string array', async () => {
      const signal: GaulsAISignal = {
        action: 'open',
        side: 'buy',
        symbol: 'NEAR',
        entries: [{ type: 'market' }],
        takeProfits: [1.4, 1.635],
        stopLoss: 1.275,
        confidence: 0.9
      };

      const result = await parser.postProcess(signal);

      expect(result).not.toBeNull();
      expect(result![0].targets).toEqual(['1.4', '1.635']);
      result![0].targets!.forEach(t => expect(typeof t).toBe('string'));
    });

    it('should handle empty takeProfits array', async () => {
      const signal: GaulsAISignal = {
        action: 'open',
        side: 'buy',
        symbol: 'WIF',
        entries: [{ type: 'market' }],
        takeProfits: [],
        stopLoss: 0.1841,
        confidence: 0.9
      };

      const result = await parser.postProcess(signal);

      expect(result).not.toBeNull();
      expect(result![0].targets).toEqual([]);
    });

    it('should handle referencedSymbol in close signal', async () => {
      const signal: GaulsAISignal = {
        action: 'close',
        symbol: 'KAITO',
        referencedSymbol: 'KAITO',
        closePercentage: 100,
        confidence: 0.9
      };

      const result = await parser.postProcess(signal);

      expect(result).not.toBeNull();
      expect(result).toHaveLength(1);
      expect(result![0].symbol).toBe('KAITO_USDT');
    });

    it('should handle open signal with CMP (market) entry only', async () => {
      const signal: GaulsAISignal = {
        action: 'open',
        side: 'buy',
        symbol: 'SYRUP',
        entries: [{ type: 'market' }, { type: 'limit', price: 0.2080 }],
        takeProfits: [0.2623],
        stopLoss: 0.2010,
        confidence: 0.9
      };

      const result = await parser.postProcess(signal);

      expect(result).not.toBeNull();
      expect(result).toHaveLength(2);
      expect(result![0].orderType).toBe('market');
      expect(result![0].entryPrice).toBe('CMP');
      expect(result![0].weight).toBe(0.5);
      expect(result![1].orderType).toBe('limit');
      expect(result![1].entryPrice).toBe('0.208');
      expect(result![1].weight).toBe(0.5);
    });
  });

  describe('buildPrompt', () => {
    it('should return a non-empty prompt string', () => {
      const prompt = parser.buildPrompt();

      expect(typeof prompt).toBe('string');
      expect(prompt.length).toBeGreaterThan(0);
    });

    it('should include key rules about signal types', () => {
      const prompt = parser.buildPrompt();

      expect(prompt).toContain('Buying Setup');
      expect(prompt).toContain('Long Setup');
      expect(prompt).toContain('Short Setup');
      expect(prompt).toContain('TRADE UPDATE');
    });

    it('should include CMP entry rules', () => {
      const prompt = parser.buildPrompt();

      expect(prompt).toContain('CMP');
      expect(prompt).toContain('market');
    });

    it('should include symbol format rule', () => {
      const prompt = parser.buildPrompt();

      expect(prompt).toContain('BASE_USDT');
    });

    it('should include breakeven rule', () => {
      const prompt = parser.buildPrompt();

      expect(prompt).toContain('breakeven');
    });

    it('should include risk multiplier rules', () => {
      const prompt = parser.buildPrompt();

      expect(prompt).toContain('low risk');
      expect(prompt).toContain('riskMultiplier');
      expect(prompt).toContain('0.5');
    });
  });

  describe('buildResponseFormat', () => {
    it('should return a valid JSON schema object', () => {
      const format = parser.buildResponseFormat() as any;
      const schema = format.json_schema.schema;

      expect(schema).toBeDefined();
      expect(typeof schema).toBe('object');
    });

    it('should have action field with correct enum values', () => {
      const format = parser.buildResponseFormat() as any;
      const schema = format.json_schema.schema;

      expect(schema.properties.action).toBeDefined();
      expect(schema.properties.action.enum).toContain('open');
      expect(schema.properties.action.enum).toContain('close');
      expect(schema.properties.action.enum).toContain('update');
      expect(schema.properties.action.enum).toContain('ignore');
    });

    it('should have entries array property', () => {
      const format = parser.buildResponseFormat() as any;
      const schema = format.json_schema.schema;

      expect(schema.properties.entries).toBeDefined();
      expect(schema.properties.entries.type).toBe('array');
    });

    it('should have takeProfits array property', () => {
      const format = parser.buildResponseFormat() as any;
      const schema = format.json_schema.schema;

      expect(schema.properties.takeProfits).toBeDefined();
      expect(schema.properties.takeProfits.type).toBe('array');
    });

    it('should have stopLoss property', () => {
      const format = parser.buildResponseFormat() as any;
      const schema = format.json_schema.schema;

      expect(schema.properties.stopLoss).toBeDefined();
    });

    it('should have confidence property', () => {
      const format = parser.buildResponseFormat() as any;
      const schema = format.json_schema.schema;

      expect(schema.properties.confidence).toBeDefined();
    });
  });
});
