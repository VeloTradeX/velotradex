import aiParserService, { buildRetryAnalyzeOptions } from '../../src/services/AIParserService';
import { buildPrompt } from '../../src/services/AIParserPromptBuilder';
import { AILog } from '../../src/models';
import axios from 'axios';

describe('AIParserService retry helpers', () => {
  test('优先使用 originalMessage 中保存的多模态内容', () => {
    const options = buildRetryAnalyzeOptions({
      systemPrompt: 'system prompt',
      originalMessage: JSON.stringify([
        { type: 'text', text: 'hello' },
        { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,abc' } },
      ]),
      prompt: 'unused prompt',
      strategyId: 12,
      routeIds: '[3]',
      routeNames: '["主路由"]',
    });

    expect(options).toEqual({
      systemPrompt: 'system prompt',
      userContent: [
        { type: 'text', text: 'hello' },
        { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,abc' } },
      ],
      strategyId: 12,
      routeIds: [3],
      routeNames: ['主路由'],
      timeout: 60000,
    });
  });

  test('老日志可用 prompt 中的图片占位符和 imageBase64 重建多模态内容', () => {
    const options = buildRetryAnalyzeOptions({
      prompt: JSON.stringify([
        { type: 'text', text: 'prompt body' },
        { type: 'image_url', image_url: { url: '[IMAGE_DATA]' } },
      ]),
      imageBase64: 'data:image/png;base64,recovered',
    });

    expect(options.userContent).toEqual([
      { type: 'text', text: 'prompt body' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,recovered' } },
    ]);
  });

  test('文本日志回退到已保存 prompt', () => {
    const options = buildRetryAnalyzeOptions({
      systemPrompt: 'system prompt',
      originalMessage: '{"content":"raw event"}',
      prompt: '<current_message>prompt</current_message>',
    });

    expect(options).toEqual({
      systemPrompt: 'system prompt',
      userContent: '<current_message>prompt</current_message>',
      strategyId: undefined,
      timeout: 60000,
    });
  });

  test('没有可重放内容时抛错', () => {
    expect(() => buildRetryAnalyzeOptions({})).toThrow('No retryable AI input found in log');
  });
});

describe('AIParserService retryLogAnalysis', () => {
  test('使用重建后的参数重放解析请求', async () => {
    const analyzeRawSpy = jest.spyOn(aiParserService, 'analyzeRaw').mockResolvedValue({
      content: '{"action":"ignore","symbol":"BTC_USDT"}',
      usage: { total_tokens: 10 },
      raw: { id: 'resp_1' },
      logId: 101,
    });

    const result = await aiParserService.retryLogAnalysis({
      systemPrompt: 'system prompt',
      prompt: 'retry prompt',
      strategyId: 7,
    });

    expect(analyzeRawSpy).toHaveBeenCalledWith({
      systemPrompt: 'system prompt',
      userContent: 'retry prompt',
      strategyId: 7,
      timeout: 60000,
    });
    expect(result?.logId).toBe(101);

    analyzeRawSpy.mockRestore();
  });
});

describe('AIParserService analyzeRaw extraPayload', () => {
  const service = aiParserService as any;

  beforeEach(() => {
    jest.spyOn(AILog, 'create').mockResolvedValue({ id: 1 } as any);
  });

  afterEach(() => {
    service.client = null;
    service.config = null;
  });

  function setupService(configOverrides: Record<string, any> = {}, responseContent = '{"action":"ignore","symbol":"BTC_USDT"}') {
    const post = jest.fn().mockResolvedValue({
      data: {
        choices: [{ message: { content: responseContent } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      },
    });

    service.client = { post };
    service.config = {
      textModel: 'text-model',
      visionModel: 'vision-model',
      stripChinese: false,
      baseUrl: 'https://api.example.com/v1',
      extraPayload: null,
      ...configOverrides,
    };

    return { post };
  }

  test('analyzeRaw 合并配置中的 extraPayload 到请求体', async () => {
    const { post } = setupService({
      extraPayload: JSON.stringify({ thinking: { type: 'disabled' } }),
    });

    await aiParserService.analyzeRaw({
      systemPrompt: 'system',
      userContent: 'hello',
    });

    expect(post).toHaveBeenCalledWith(
      '/chat/completions',
      expect.objectContaining({
        model: 'text-model',
        thinking: { type: 'disabled' },
      }),
      expect.any(Object)
    );
  });

  test('请求级 extraPayload 覆盖配置中的同名字段', async () => {
    const { post } = setupService({
      extraPayload: JSON.stringify({
        thinking: { type: 'enabled' },
        enable_thinking: true,
      }),
    });

    await aiParserService.analyzeRaw({
      userContent: 'hello',
      extraPayload: {
        enable_thinking: false,
      },
    });

    expect(post).toHaveBeenCalledWith(
      '/chat/completions',
      expect.objectContaining({
        enable_thinking: false,
        thinking: { type: 'enabled' },
      }),
      expect.any(Object)
    );
  });

  test('阿里云兼容地址会把 thinking.type 转成 enable_thinking', async () => {
    const { post } = setupService({
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      extraPayload: JSON.stringify({ thinking: { type: 'disabled' } }),
    });

    await aiParserService.analyzeRaw({
      userContent: 'hello',
    });

    const payload = post.mock.calls[0][1];
    expect(payload.enable_thinking).toBe(false);
    expect(payload.thinking).toBeUndefined();
  });

  test('阿里云兼容地址下显式 enable_thinking 不会被 thinking.type 覆盖', async () => {
    const { post } = setupService({
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      extraPayload: JSON.stringify({
        thinking: { type: 'enabled' },
        enable_thinking: false,
      }),
    });

    await aiParserService.analyzeRaw({
      userContent: 'hello',
    });

    const payload = post.mock.calls[0][1];
    expect(payload.enable_thinking).toBe(false);
    expect(payload.thinking).toBeUndefined();
  });

  test('analyzeRaw 未显式传 timeout 时使用配置中的调用超时', async () => {
    const { post } = setupService({
      requestTimeoutMs: 45000,
    });

    await aiParserService.analyzeRaw({
      userContent: 'hello',
    });

    expect(post).toHaveBeenCalledWith(
      '/chat/completions',
      expect.any(Object),
      expect.objectContaining({
        timeout: 45000,
      })
    );
  });

  test('analyzeRaw 保存信号路由上下文到日志', async () => {
    setupService();

    await aiParserService.analyzeRaw({
      userContent: 'hello',
      strategyId: 88,
      routeIds: [3, 5],
      routeNames: ['主路由', '副路由'],
    });

    expect(AILog.create).toHaveBeenCalledWith(expect.objectContaining({
      strategyId: 88,
      routeIds: JSON.stringify([3, 5]),
      routeNames: JSON.stringify(['主路由', '副路由']),
    }));
  });

  test('analyzeRaw 使用当前异步解析上下文中的信号路由', async () => {
    setupService();

    await aiParserService.runWithRouteContext(
      { routeIds: [9], routeNames: ['内部 AI 路由'] },
      () => aiParserService.analyzeRaw({ userContent: 'hello' })
    );

    expect(AILog.create).toHaveBeenCalledWith(expect.objectContaining({
      routeIds: JSON.stringify([9]),
      routeNames: JSON.stringify(['内部 AI 路由']),
    }));
  });

  test('analyzeRaw 日志中的 originalMessage 使用显式传入的 Discord 原始消息', async () => {
    setupService();

    const discordMessage = {
      id: 'discord-1',
      content: 'Discord raw message',
      attachments: [{ url: 'https://example.com/chart.png' }],
    };

    await aiParserService.analyzeRaw({
      userContent: '<current_message>processed prompt</current_message>',
      originalMessage: discordMessage,
    });

    expect(AILog.create).toHaveBeenCalledWith(expect.objectContaining({
      originalMessage: JSON.stringify(discordMessage),
      prompt: '<current_message>processed prompt</current_message>',
    }));
  });
});

describe('AIParserService prompt market price context', () => {
  test('旧通用 AI prompt 注入常见交易对价格并禁止无依据默认 BTC', () => {
    const prompt = buildPrompt({
      message: { content: 'image-only setup' },
      currentPrice: 100,
      contextXml: '<context></context>',
      positionsXml: '<positions></positions>',
      marketPricesXml: '<market_prices><market symbol="XAU_USDT" price="2350" /></market_prices>',
      promptTemplate: '{{positions}}\n{{marketPrices}}\n{{context}}\n{{message}}\n{{currentPrice}}',
      stripChinese: false,
    });

    expect(prompt).toContain('<market_prices>');
    expect(prompt).toContain('XAU_USDT');
    expect(prompt).toContain('Do not default to BTC_USDT');
    expect(prompt).toContain('closest current price');
  });

  test('Discord embed 消息优先使用 embeds[0].description 作为 AI 消息正文', () => {
    const prompt = buildPrompt({
      message: {
        content: 'content should not be analyzed',
        embeds: [
          { description: 'WWG embed description should be analyzed' },
          { description: 'second embed should not be analyzed' },
        ],
      },
      currentPrice: 100,
      contextXml: '',
      positionsXml: '',
      marketPricesXml: '',
      promptTemplate: '{{message}}',
      stripChinese: false,
    });

    expect(prompt).toContain('WWG embed description should be analyzed');
    expect(prompt).not.toContain('content should not be analyzed');
    expect(prompt).not.toContain('second embed should not be analyzed');
  });
});

describe('AIParserService testConfig', () => {
  test('测试连接会调用文本模型并返回结果内容', async () => {
    const post = jest.fn().mockResolvedValue({
      data: {
        choices: [{ message: { content: '你好，有什么可以帮你？' } }],
      },
    });
    const createSpy = jest.spyOn(axios, 'create').mockReturnValue({ post } as any);

    const result = await aiParserService.testConfig({
      apiKey: 'key',
      baseUrl: 'https://api.example.com/v1',
      textModel: 'mimo-v2.5',
      extraPayload: JSON.stringify({ thinking: { type: 'disabled' } }),
      requestTimeoutMs: 42000,
    });

    expect(post).toHaveBeenCalledWith('/chat/completions', {
      model: 'mimo-v2.5',
      messages: [{ role: 'user', content: '你好' }],
      temperature: 0.3,
      thinking: { type: 'disabled' },
    });
    expect(result).toEqual({
      success: true,
      message: '你好，有什么可以帮你？',
    });

    createSpy.mockRestore();
  });
});
