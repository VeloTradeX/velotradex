import AILog from '../../src/models/AILog';
import Strategy from '../../src/models/Strategy';
import SignalRoute from '../../src/models/SignalRoute';
import aiParserService from '../../src/services/AIParserService';

// We test the route handler by calling it with a mock Koa context.
// The retry endpoint is defined in src/routes/aiConfig.ts.

describe('POST /logs/:id/retry triggerOrder', () => {
  let handler: Function;

  beforeAll(() => {
    // Require the router module so the handler is loaded
    const router = require('../../src/routes/aiConfig').default;
    // Find the retry route handler. The layer's middleware chain is
    // [checkAdmin, handler]; pick the last entry (the actual handler).
    const retryLayer = router.stack.find((l: any) => l.path === '/logs/:id/retry' && l.methods.includes('POST'));
    expect(retryLayer).toBeDefined();
    handler = retryLayer.stack[retryLayer.stack.length - 1];
  });

  function mockCtx(overrides: Record<string, any> = {}) {
    const ctx: any = {
      params: { id: '1' },
      request: { body: {} },
      body: null,
      status: 200,
    };
    return Object.assign(ctx, overrides);
  }

  let logFindByPkSpy: jest.SpyInstance;
  let strategyFindByPkSpy: jest.SpyInstance;
  let routeFindByPkSpy: jest.SpyInstance;
  let retryLogAnalysisSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.restoreAllMocks();

    // Default: log exists with strategyId and routeIds
    logFindByPkSpy = jest.spyOn(AILog, 'findByPk').mockResolvedValue({
      id: 1,
      strategyId: 10,
      routeIds: JSON.stringify([5]),
      systemPrompt: 'system prompt',
      prompt: 'test prompt',
    } as any);

    // Default: retry succeeds
    retryLogAnalysisSpy = jest.spyOn(aiParserService, 'retryLogAnalysis').mockResolvedValue({
      logId: 2,
      content: '{"action":"long","symbol":"BTC_USDT","confidence":0.9,"side":"long"}',
      usage: { total_tokens: 10 },
    } as any);
  });

  test('triggerOrder not sent defaults to false, no order triggered', async () => {
    const ctx = mockCtx();
    await handler(ctx);

    expect(ctx.status).toBe(200);
    expect(ctx.body.success).toBe(true);
    expect(ctx.body).not.toHaveProperty('orderResult');
  });

  test('triggerOrder=false does not trigger order', async () => {
    const ctx = mockCtx({ request: { body: { triggerOrder: false } } });
    await handler(ctx);

    expect(ctx.status).toBe(200);
    expect(ctx.body.success).toBe(true);
    expect(ctx.body).not.toHaveProperty('orderResult');
  });

  test('triggerOrder=true returns warning if log has no strategyId', async () => {
    logFindByPkSpy.mockResolvedValue({
      id: 1,
      strategyId: null,
      routeIds: JSON.stringify([5]),
      systemPrompt: 'system prompt',
      prompt: 'test prompt',
    } as any);

    const ctx = mockCtx({ request: { body: { triggerOrder: true } } });
    await handler(ctx);

    expect(ctx.body.success).toBe(true);
    expect(ctx.body.warning).toMatch(/strategyId/i);
    expect(ctx.body).not.toHaveProperty('orderResult');
  });

  test('triggerOrder=true returns warning if Strategy not found', async () => {
    strategyFindByPkSpy = jest.spyOn(Strategy, 'findByPk').mockResolvedValue(null);

    const ctx = mockCtx({ request: { body: { triggerOrder: true } } });
    await handler(ctx);

    expect(ctx.body.success).toBe(true);
    expect(ctx.body.warning).toMatch(/strategy/i);
    expect(ctx.body).not.toHaveProperty('orderResult');
  });

  test('triggerOrder=true returns warning if AI result action is ignore', async () => {
    retryLogAnalysisSpy.mockResolvedValue({
      logId: 2,
      content: '{"action":"ignore","symbol":"BTC_USDT","confidence":0.9}',
      usage: { total_tokens: 10 },
    } as any);

    strategyFindByPkSpy = jest.spyOn(Strategy, 'findByPk').mockResolvedValue({
      id: 10,
      parserName: 'DefaultParser',
      rawMessage: '{"content":"BTC long signal"}',
      source: 'test',
      aiAnalysis: null,
      save: jest.fn().mockResolvedValue(undefined),
    } as any);

    const ctx = mockCtx({ request: { body: { triggerOrder: true } } });
    await handler(ctx);

    expect(ctx.body.success).toBe(true);
    expect(ctx.body.warning).toMatch(/ignore/i);
    expect(ctx.body).not.toHaveProperty('orderResult');
  });

  test('triggerOrder=true returns warning if confidence < 0.5', async () => {
    retryLogAnalysisSpy.mockResolvedValue({
      logId: 2,
      content: '{"action":"long","symbol":"BTC_USDT","confidence":0.3,"side":"long"}',
      usage: { total_tokens: 10 },
    } as any);

    strategyFindByPkSpy = jest.spyOn(Strategy, 'findByPk').mockResolvedValue({
      id: 10,
      parserName: 'DefaultParser',
      rawMessage: '{"content":"BTC long signal"}',
      source: 'test',
      aiAnalysis: null,
      save: jest.fn().mockResolvedValue(undefined),
    } as any);

    const ctx = mockCtx({ request: { body: { triggerOrder: true } } });
    await handler(ctx);

    expect(ctx.body.success).toBe(true);
    expect(ctx.body.warning).toMatch(/confidence/i);
    expect(ctx.body).not.toHaveProperty('orderResult');
  });

  test('triggerOrder=true returns warning if SignalRoute not found', async () => {
    strategyFindByPkSpy = jest.spyOn(Strategy, 'findByPk').mockResolvedValue({
      id: 10,
      parserName: 'DefaultParser',
      rawMessage: '{"content":"BTC long signal"}',
      source: 'test',
      aiAnalysis: null,
      save: jest.fn().mockResolvedValue(undefined),
    } as any);

    routeFindByPkSpy = jest.spyOn(SignalRoute, 'findByPk').mockResolvedValue(null);

    const ctx = mockCtx({ request: { body: { triggerOrder: true } } });
    await handler(ctx);

    expect(ctx.body.success).toBe(true);
    expect(ctx.body.warning).toMatch(/route/i);
    expect(ctx.body).not.toHaveProperty('orderResult');
  });

  test('triggerOrder=true returns warning if SignalRoute is disabled (isActive=false)', async () => {
    strategyFindByPkSpy = jest.spyOn(Strategy, 'findByPk').mockResolvedValue({
      id: 10,
      parserName: 'DefaultParser',
      rawMessage: '{"content":"BTC long signal"}',
      source: 'test',
      aiAnalysis: null,
      save: jest.fn().mockResolvedValue(undefined),
    } as any);

    routeFindByPkSpy = jest.spyOn(SignalRoute, 'findByPk').mockResolvedValue({
      id: 5,
      isActive: false,
      exchangeInstanceId: 'exchange-1',
      riskSettings: '{}',
      symbolSpecificSettings: '{}',
    } as any);

    const ctx = mockCtx({ request: { body: { triggerOrder: true } } });
    await handler(ctx);

    expect(ctx.body.success).toBe(true);
    expect(ctx.body.warning).toMatch(/route/i);
    expect(ctx.body).not.toHaveProperty('orderResult');
  });

  test('triggerOrder=true calls tradeExecutor and returns orderResult on success', async () => {
    strategyFindByPkSpy = jest.spyOn(Strategy, 'findByPk').mockResolvedValue({
      id: 10,
      parserName: 'DefaultParser',
      rawMessage: '{"content":"BTC long signal at 50000"}',
      source: 'test',
      aiAnalysis: null,
      save: jest.fn().mockResolvedValue(undefined),
    } as any);

    routeFindByPkSpy = jest.spyOn(SignalRoute, 'findByPk').mockResolvedValue({
      id: 5,
      isActive: true,
      exchangeInstanceId: 'exchange-1',
      riskSettings: '{}',
      symbolSpecificSettings: '{}',
    } as any);

    // Mock parser
    const strategyParserRegistry = require('../../src/services/parsers').default;
    const mockParser = {
      name: 'DefaultParser',
      getRiskConfig: jest.fn().mockReturnValue({ riskMode: 'fixed', riskValue: 10 }),
      parse: jest.fn().mockResolvedValue([{
        symbol: 'BTC_USDT',
        side: 'long',
        entryPrice: '50000',
        targets: ['55000'],
        stopLoss: '48000',
      }]),
    };
    jest.spyOn(strategyParserRegistry, 'getParserByName').mockReturnValue(mockParser);

    // Mock parserConfigService
    const parserConfigService = require('../../src/services/ParserConfigService').default;
    jest.spyOn(parserConfigService, 'getEffectiveConfig').mockResolvedValue({ riskMode: 'fixed', riskValue: 10 });

    // Mock tradeExecutor
    const tradeExecutor = require('../../src/services/TradeExecutor').default;
    const executeSpy = jest.spyOn(tradeExecutor, 'execute').mockResolvedValue({
      id: 'order-123',
      status: 'filled',
    } as any);

    const ctx = mockCtx({ request: { body: { triggerOrder: true } } });
    await handler(ctx);

    expect(ctx.body.success).toBe(true);
    expect(ctx.body.orderResult).toEqual({ id: 'order-123', status: 'filled' });
    expect(executeSpy).toHaveBeenCalledTimes(1);

    // Verify execute was called with the right parameters
    const [parsedArg, riskConfigArg, sourceArg, strategyIdArg, exchangeInstanceIdArg, routeIdArg] = executeSpy.mock.calls[0] as [any, any, any, any, any, any];
    expect(parsedArg.symbol).toBe('BTC_USDT');
    expect(sourceArg).toBe('test');
    expect(strategyIdArg).toBe(10);
    expect(exchangeInstanceIdArg).toBe('exchange-1');
    expect(routeIdArg).toBe(5);
  });

  test('triggerOrder=true with parse failure does not trigger order', async () => {
    retryLogAnalysisSpy.mockResolvedValue({
      logId: 2,
      content: 'not valid json at all',
      usage: { total_tokens: 10 },
    } as any);

    strategyFindByPkSpy = jest.spyOn(Strategy, 'findByPk').mockResolvedValue({
      id: 10,
      parserName: 'DefaultParser',
      rawMessage: '{"content":"BTC long signal"}',
      source: 'test',
      aiAnalysis: null,
      save: jest.fn().mockResolvedValue(undefined),
    } as any);

    const ctx = mockCtx({ request: { body: { triggerOrder: true } } });
    await handler(ctx);

    expect(ctx.body.success).toBe(true);
    expect(ctx.body.warning).toMatch(/parse/i);
    expect(ctx.body).not.toHaveProperty('orderResult');
  });

  test('triggerOrder=true with empty content does not trigger order', async () => {
    retryLogAnalysisSpy.mockResolvedValue({
      logId: 2,
      content: null,
      usage: { total_tokens: 10 },
    } as any);

    strategyFindByPkSpy = jest.spyOn(Strategy, 'findByPk').mockResolvedValue({
      id: 10,
      parserName: 'DefaultParser',
      rawMessage: '{"content":"BTC long signal"}',
      source: 'test',
      aiAnalysis: null,
      save: jest.fn().mockResolvedValue(undefined),
    } as any);

    const ctx = mockCtx({ request: { body: { triggerOrder: true } } });
    await handler(ctx);

    expect(ctx.body.success).toBe(true);
    expect(ctx.body.warning).toMatch(/parse/i);
    expect(ctx.body).not.toHaveProperty('orderResult');
  });

  test('triggerOrder=true applies route riskSettings override', async () => {
    strategyFindByPkSpy = jest.spyOn(Strategy, 'findByPk').mockResolvedValue({
      id: 10,
      parserName: 'DefaultParser',
      rawMessage: '{"content":"BTC long signal at 50000"}',
      source: 'test',
      aiAnalysis: null,
      save: jest.fn().mockResolvedValue(undefined),
    } as any);

    routeFindByPkSpy = jest.spyOn(SignalRoute, 'findByPk').mockResolvedValue({
      id: 5,
      isActive: true,
      exchangeInstanceId: 'exchange-1',
      riskSettings: JSON.stringify({ riskValue: 5 }),
      symbolSpecificSettings: '{}',
    } as any);

    const strategyParserRegistry = require('../../src/services/parsers').default;
    const mockParser = {
      name: 'DefaultParser',
      getRiskConfig: jest.fn().mockReturnValue({ riskMode: 'fixed', riskValue: 10 }),
      parse: jest.fn().mockResolvedValue([{
        symbol: 'BTC_USDT',
        side: 'long',
        entryPrice: '50000',
        targets: ['55000'],
        stopLoss: '48000',
      }]),
    };
    jest.spyOn(strategyParserRegistry, 'getParserByName').mockReturnValue(mockParser);

    const parserConfigService = require('../../src/services/ParserConfigService').default;
    jest.spyOn(parserConfigService, 'getEffectiveConfig').mockResolvedValue({ riskMode: 'fixed', riskValue: 10 });

    const tradeExecutor = require('../../src/services/TradeExecutor').default;
    const executeSpy = jest.spyOn(tradeExecutor, 'execute').mockResolvedValue({
      id: 'order-456',
      status: 'filled',
    } as any);

    const ctx = mockCtx({ request: { body: { triggerOrder: true } } });
    await handler(ctx);

    expect(executeSpy).toHaveBeenCalledTimes(1);
    const riskConfigArg = executeSpy.mock.calls[0][1] as any;
    // Route override should set riskValue to 5
    expect(riskConfigArg.riskValue).toBe(5);
  });
});

describe('POST /logs/:id/retry triggerOrder boundary conditions', () => {
  let handler: Function;

  beforeAll(() => {
    const router = require('../../src/routes/aiConfig').default;
    const retryLayer = router.stack.find((l: any) => l.path === '/logs/:id/retry' && l.methods.includes('POST'));
    expect(retryLayer).toBeDefined();
    // [checkAdmin, handler] — pick the actual handler.
    handler = retryLayer.stack[retryLayer.stack.length - 1];
  });

  function mockCtx(overrides: Record<string, any> = {}) {
    const ctx: any = {
      params: { id: '1' },
      request: { body: {} },
      body: null,
      status: 200,
    };
    return Object.assign(ctx, overrides);
  }

  let logFindByPkSpy: jest.SpyInstance;
  let strategyFindByPkSpy: jest.SpyInstance;
  let routeFindByPkSpy: jest.SpyInstance;
  let retryLogAnalysisSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.restoreAllMocks();

    logFindByPkSpy = jest.spyOn(AILog, 'findByPk').mockResolvedValue({
      id: 1,
      strategyId: 10,
      routeIds: JSON.stringify([5]),
      systemPrompt: 'system prompt',
      prompt: 'test prompt',
    } as any);

    retryLogAnalysisSpy = jest.spyOn(aiParserService, 'retryLogAnalysis').mockResolvedValue({
      logId: 2,
      content: '{"action":"long","symbol":"BTC_USDT","confidence":0.9,"side":"long"}',
      usage: { total_tokens: 10 },
    } as any);
  });

  test('triggerOrder=true returns warning if log has no routeIds', async () => {
    logFindByPkSpy.mockResolvedValue({
      id: 1,
      strategyId: 10,
      routeIds: null,
      systemPrompt: 'system prompt',
      prompt: 'test prompt',
    } as any);

    strategyFindByPkSpy = jest.spyOn(Strategy, 'findByPk').mockResolvedValue({
      id: 10,
      parserName: 'DefaultParser',
      rawMessage: '{"content":"msg"}',
      source: 'test',
      aiAnalysis: null,
      save: jest.fn().mockResolvedValue(undefined),
    } as any);

    const ctx = mockCtx({ request: { body: { triggerOrder: true } } });
    await handler(ctx);

    expect(ctx.body.success).toBe(true);
    expect(ctx.body.warning).toMatch(/routeId/i);
    expect(ctx.body).not.toHaveProperty('orderResult');
  });

  test('triggerOrder=true returns warning if log has empty routeIds array', async () => {
    logFindByPkSpy.mockResolvedValue({
      id: 1,
      strategyId: 10,
      routeIds: '[]',
      systemPrompt: 'system prompt',
      prompt: 'test prompt',
    } as any);

    strategyFindByPkSpy = jest.spyOn(Strategy, 'findByPk').mockResolvedValue({
      id: 10,
      parserName: 'DefaultParser',
      rawMessage: '{"content":"msg"}',
      source: 'test',
      aiAnalysis: null,
      save: jest.fn().mockResolvedValue(undefined),
    } as any);

    const ctx = mockCtx({ request: { body: { triggerOrder: true } } });
    await handler(ctx);

    expect(ctx.body.success).toBe(true);
    expect(ctx.body.warning).toMatch(/routeId/i);
    expect(ctx.body).not.toHaveProperty('orderResult');
  });

  test('triggerOrder=true returns warning if parser not found', async () => {
    strategyFindByPkSpy = jest.spyOn(Strategy, 'findByPk').mockResolvedValue({
      id: 10,
      parserName: 'NonExistentParser',
      rawMessage: '{"content":"msg"}',
      source: 'test',
      aiAnalysis: null,
      save: jest.fn().mockResolvedValue(undefined),
    } as any);

    routeFindByPkSpy = jest.spyOn(SignalRoute, 'findByPk').mockResolvedValue({
      id: 5,
      isActive: true,
      exchangeInstanceId: 'exchange-1',
      riskSettings: '{}',
      symbolSpecificSettings: '{}',
    } as any);

    const strategyParserRegistry = require('../../src/services/parsers').default;
    jest.spyOn(strategyParserRegistry, 'getParserByName').mockReturnValue(null);

    const ctx = mockCtx({ request: { body: { triggerOrder: true } } });
    await handler(ctx);

    expect(ctx.body.success).toBe(true);
    expect(ctx.body.warning).toMatch(/parser/i);
    expect(ctx.body).not.toHaveProperty('orderResult');
  });

  test('triggerOrder=true returns warning if parser returns no strategies', async () => {
    strategyFindByPkSpy = jest.spyOn(Strategy, 'findByPk').mockResolvedValue({
      id: 10,
      parserName: 'DefaultParser',
      rawMessage: '{"content":"unrelated text"}',
      source: 'test',
      aiAnalysis: null,
      save: jest.fn().mockResolvedValue(undefined),
    } as any);

    routeFindByPkSpy = jest.spyOn(SignalRoute, 'findByPk').mockResolvedValue({
      id: 5,
      isActive: true,
      exchangeInstanceId: 'exchange-1',
      riskSettings: '{}',
      symbolSpecificSettings: '{}',
    } as any);

    const strategyParserRegistry = require('../../src/services/parsers').default;
    const mockParser = {
      name: 'DefaultParser',
      getRiskConfig: jest.fn().mockReturnValue({ riskMode: 'fixed', riskValue: 10 }),
      parse: jest.fn().mockResolvedValue(null),
    };
    jest.spyOn(strategyParserRegistry, 'getParserByName').mockReturnValue(mockParser);

    const ctx = mockCtx({ request: { body: { triggerOrder: true } } });
    await handler(ctx);

    expect(ctx.body.success).toBe(true);
    expect(ctx.body.warning).toMatch(/strateg/i);
    expect(ctx.body).not.toHaveProperty('orderResult');
  });

  test('triggerOrder=true returns warning if tradeExecutor.execute throws', async () => {
    strategyFindByPkSpy = jest.spyOn(Strategy, 'findByPk').mockResolvedValue({
      id: 10,
      parserName: 'DefaultParser',
      rawMessage: '{"content":"BTC long signal at 50000"}',
      source: 'test',
      aiAnalysis: null,
      save: jest.fn().mockResolvedValue(undefined),
    } as any);

    routeFindByPkSpy = jest.spyOn(SignalRoute, 'findByPk').mockResolvedValue({
      id: 5,
      isActive: true,
      exchangeInstanceId: 'exchange-1',
      riskSettings: '{}',
      symbolSpecificSettings: '{}',
    } as any);

    const strategyParserRegistry = require('../../src/services/parsers').default;
    const mockParser = {
      name: 'DefaultParser',
      getRiskConfig: jest.fn().mockReturnValue({ riskMode: 'fixed', riskValue: 10 }),
      parse: jest.fn().mockResolvedValue([{
        symbol: 'BTC_USDT',
        side: 'long',
        entryPrice: '50000',
        targets: ['55000'],
        stopLoss: '48000',
      }]),
    };
    jest.spyOn(strategyParserRegistry, 'getParserByName').mockReturnValue(mockParser);

    const parserConfigService = require('../../src/services/ParserConfigService').default;
    jest.spyOn(parserConfigService, 'getEffectiveConfig').mockResolvedValue({ riskMode: 'fixed', riskValue: 10 });

    const tradeExecutor = require('../../src/services/TradeExecutor').default;
    jest.spyOn(tradeExecutor, 'execute').mockRejectedValue(new Error('Exchange API error'));

    const ctx = mockCtx({ request: { body: { triggerOrder: true } } });
    await handler(ctx);

    expect(ctx.body.success).toBe(true);
    expect(ctx.body.warning).toMatch(/exchange api error/i);
    expect(ctx.body).not.toHaveProperty('orderResult');
  });
});
