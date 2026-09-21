import fs from 'node:fs';
import path from 'node:path';
import registry from '../src/services/parsers';
import { MansoorParser, IMAGE_PRICE_TOLERANCE } from '../src/services/parsers/MansoorParser';
import aiParserService from '../src/services/AIParserService';
import { downloadImageAsBase64 } from '../src/services/imageDownload';
import { StrategyPosition } from '../src/models';

// 测试引入了 registry（会构造全部解析器，含 RaizexbtParser），其依赖的模块需要 mock；
// MansoorParser 继承 AiParserBase，后者运行时依赖 AIParserService / MarketService /
// 图片下载 / 持仓查询，也需 mock。
jest.mock('../src/services/AIParserService', () => ({
  __esModule: true,
  default: {
    isConfigured: jest.fn(),
    buildPositions: jest.fn(),
    analyzeRaw: jest.fn(),
    runWithRouteContext: jest.fn(),
  },
}));

jest.mock('../src/services/MarketService', () => ({
  __esModule: true,
  default: {
    getCommonMarketPricesXml: jest.fn(),
    getCurrentPrice: jest.fn(),
  },
}));

jest.mock('../src/services/imageDownload', () => ({
  __esModule: true,
  downloadImageAsBase64: jest.fn(),
}));

jest.mock('../src/models', () => ({
  ImageDownloadCache: {
    findOne: jest.fn(),
    upsert: jest.fn(),
  },
  StrategyPosition: {
    findOne: jest.fn(),
  },
}));

const ROOT_DIR = path.resolve(__dirname, '..');

function message(id: string, content: string, attachments: any[] = [], extra: Record<string, any> = {}) {
  return {
    id,
    channel_id: 'mansoor-channel',
    content,
    ts: '2026-04-06T06:54:11.211000+00:00',
    timestamp: '2026-04-06T06:54:11.211000+00:00',
    username: 'Mansoor',
    attachments,
    ...extra,
  };
}

function createParser() {
  const parser = new MansoorParser();
  (parser as any).writeDebugLog = jest.fn();
  return parser;
}

function imageAttachment() {
  return { id: 'img-1', is_image: true, url: 'https://cdn.example.com/a.png', proxy_url: 'https://cdn.example.com/a.png' };
}

/** 构造一个视觉模型将返回的新鲜开仓结果。 */
function visionOpen(overrides: Record<string, any> = {}) {
  return {
    action: 'open',
    symbol: 'XAUUSD',
    side: 'sell',
    entryPrice: 4683.2,
    stopLoss: 4701,
    takeProfits: [4600],
    confidence: 0.9,
    reasoning: 'fresh short setup near market',
    ...overrides,
  };
}

function setupVision(response: Record<string, any>, opts: { price?: number; hasPosition?: boolean } = {}) {
  (aiParserService as any).isConfigured.mockReturnValue(true);
  (aiParserService as any).buildPositions.mockResolvedValue('');
  (aiParserService as any).analyzeRaw.mockResolvedValue({
    content: JSON.stringify(response),
    usage: {},
    raw: {},
  });
  (downloadImageAsBase64 as any).mockResolvedValue('ZmFrZWJhc2U2NA==');
  (StrategyPosition as any).findOne.mockResolvedValue(opts.hasPosition ? { id: 1 } : null);
  const { default: marketService } = require('../src/services/MarketService');
  (marketService.getCommonMarketPricesXml as any).mockResolvedValue('');
  (marketService.getCurrentPrice as any).mockResolvedValue(opts.price ?? 4684);
}

describe('MansoorParser', () => {
  it('is registered by parser name', () => {
    expect(registry.getParserByName('MansoorParser')?.name).toBe('MansoorParser');
  });

  it('documents open-only, text-first and reply-pin behavior in the source', () => {
    const source = fs.readFileSync(
      path.join(ROOT_DIR, 'src', 'services', 'parsers', 'MansoorParser.ts'),
      'utf8',
    );
    expect(source).toContain('open-only');
    expect(source).toContain('文本优先');
    expect(source).toContain('never responds to BE');
    expect(source).toContain('reply quote is historical context');
    // 继承自通用 AI/视觉基类，而非 RaizexbtParser
    expect(source).not.toContain('extends RaizexbtParser');
    expect(source).toContain('extends AiParserBase');
  });

  it('exposes the fixed risk config required by the interface', () => {
    const riskConfig = createParser().getRiskConfig();
    expect(riskConfig.riskMode).toBe('fixed');
    expect(riskConfig.riskValue).toBe(10);
    expect(riskConfig.autoCloseOppositePosition).toBe(true);
  });

  it('parses a standalone open signal without LLM (text path)', async () => {
    const result = await createParser().parse(
      message('mansoor-open-basic', 'SELL XAUUSD \n\nSL : 4682.00\n\nTP : 4600.90'),
      true,
    );

    expect(result).toEqual([
      expect.objectContaining({
        action: 'open',
        symbol: 'XAU_USDT',
        side: 'sell',
        orderType: 'market',
        stopLoss: '4682',
        targets: ['4600.9'],
        sourceType: 'text',
      }),
    ]);
  });

  it('recovers a full Gold update open signal from text', async () => {
    const result = await createParser().parse(
      message(
        'mansoor-gold-update',
        [
          'Gold update',
          '',
          'I AM SELLING HERE',
          '',
          'PRICE: 4685.00',
          'MY SL: 4701.00',
          '',
          'MY TARGETS:',
          'TP1: 4675.00',
          'TP2: 4665.00',
          'TP3: 4655.00',
          'TP4: 4645.00',
          'TP5: 4635.00',
          'Long term TP: 4601.00',
        ].join('\n'),
      ),
      true,
    );

    expect(result).toEqual([
      expect.objectContaining({
        action: 'open',
        symbol: 'XAU_USDT',
        side: 'sell',
        orderType: 'market',
        entryPrice: '4685',
        stopLoss: '4701',
        targets: ['4675', '4665', '4655', '4645', '4635', '4601'],
      }),
    ]);
  });

  it('ignores reply/pin messages that quote the earlier open message', async () => {
    const result = await createParser().parse(
      message(
        'mansoor-reply-full-signal',
        [
          '回复: [SELL XAUUSD SL : 4682.00 TP : 4600.90](https://discord.com/channels/1/2/3)',
          'Gold update 📉 I AM SELLING HERE 📈',
          'PRICE: 4685.00',
          '🛑 MY SL: 4701.00',
        ].join('\n'),
      ),
      true,
    );

    expect(result).toBeNull();
  });

  it('ignores reply with only performance text', async () => {
    const result = await createParser().parse(
      message(
        'mansoor-reply-performance',
        '回复: [SELL XAUUSD SL : 4682.00 TP : 4600.90](https://discord.com/channels/1/2/3)\n$XAUUSD 200 Pips',
      ),
      true,
    );

    expect(result).toBeNull();
  });

  it('ignores quote-block-only messages (no reply prefix)', async () => {
    const result = await createParser().parse(
      message('mansoor-quote-only', '> SELL XAUUSD\n> SL : 4682.00\n> TP : 4600.90'),
      true,
    );

    expect(result).toBeNull();
  });

  it('skips before parse when message carries a structured message_reference', async () => {
    const result = await createParser().parse(
      message('mansoor-ref-field', 'SELL XAUUSD\nSL : 4682.00\nTP : 4600.90', [
        imageAttachment(),
      ], { message_reference: { message_id: '123', channel_id: 'mansoor-channel' } }),
      true,
    );

    expect(result).toBeNull();
    expect((aiParserService as any).analyzeRaw).not.toHaveBeenCalled();
  });

  it('skips before parse when message type is 19 (Discord reply type)', async () => {
    const result = await createParser().parse(
      message('mansoor-type19', 'SELL XAUUSD\nSL : 4682.00\nTP : 4600.90', [], { type: 19 }),
      true,
    );

    expect(result).toBeNull();
  });

  it('skips before parse when a normalized reply/in_reply_to field is present', async () => {
    const result = await createParser().parse(
      message('mansoor-reply-to', 'SELL XAUUSD\nSL : 4682.00\nTP : 4600.90', [
        imageAttachment(),
      ], { reply_to: '123' }),
      true,
    );

    expect(result).toBeNull();
    expect((aiParserService as any).analyzeRaw).not.toHaveBeenCalled();
  });

  it('never responds to BE / breakeven messages', async () => {
    const result = await createParser().parse(message('mansoor-be', 'BE SET NOW'), true);
    expect(result).toBeNull();
  });

  it('never responds to early close / stop-out messages', async () => {
    const closeResult = await createParser().parse(message('mansoor-close', 'Closing XAUUSD position'), true);
    expect(closeResult).toBeNull();

    const stoppedResult = await createParser().parse(message('mansoor-stopped', 'Stopped out of Gold'), true);
    expect(stoppedResult).toBeNull();
  });

  it('ignores performance announcements like "200 Pips"', async () => {
    const result = await createParser().parse(message('mansoor-pips', 'XAUUSD 200 Pips done'), true);
    expect(result).toBeNull();
  });

  it('requires SL to consider a message an open signal', async () => {
    const result = await createParser().parse(
      message('mansoor-no-sl', 'Gold update\nI AM SELLING HERE\nPRICE: 4685.00'),
      true,
    );

    expect(result).toBeNull();
  });

  it('does not call vision when text already produced an open (text priority)', async () => {
    setupVision(visionOpen());
    const result = await createParser().parse(
      message('mansoor-text-priority', 'SELL XAUUSD\nSL : 4682.00\nTP : 4600.90', [imageAttachment()]),
      true,
    );
    expect(result).toHaveLength(1);
    expect((result as any)[0].sourceType).toBe('text');
    expect((aiParserService as any).analyzeRaw).not.toHaveBeenCalled();
  });
});

describe('MansoorParser image fallback (vision)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    setupVision(visionOpen());
  });

  it('accepts a valid fresh entry image near current price, marked as image source', async () => {
    const result = await createParser().parse(
      message('mansoor-img-ok', '', [imageAttachment()]),
      true,
    );

    expect(result).toEqual([
      expect.objectContaining({
        action: 'open',
        symbol: 'XAU_USDT',
        side: 'sell',
        orderType: 'market',
        entryPrice: '4683.2',
        stopLoss: '4701',
        targets: ['4600'],
        sourceType: 'image',
      }),
    ]);
  });

  it('rejects image signal when that symbol already has an open position (G1 by symbol)', async () => {
    (StrategyPosition as any).findOne.mockResolvedValue({ id: 7 });
    const result = await createParser().parse(message('mansoor-img-pos', '', [imageAttachment()]), true);
    expect(result).toBeNull();
  });

  it('rejects image signal when entry is too far from current price (G3)', async () => {
    const { default: marketService } = require('../src/services/MarketService');
    (marketService.getCurrentPrice as any).mockResolvedValue(5200); // huge deviation
    const result = await createParser().parse(message('mansoor-img-far', '', [imageAttachment()]), true);
    expect(result).toBeNull();
  });

  it('conservatively rejects image signal when current price is unavailable (G3)', async () => {
    const { default: marketService } = require('../src/services/MarketService');
    (marketService.getCurrentPrice as any).mockResolvedValue(0);
    const result = await createParser().parse(message('mansoor-img-noprice', '', [imageAttachment()]), true);
    expect(result).toBeNull();
  });

  it('rejects an image inside a reply message (must be a non-reply fresh entry image)', async () => {
    const result = await createParser().parse(
      message('mansoor-img-reply', '回复: [SELL XAUUSD](https://discord.com/channels/1/2/3)\nGold update', [imageAttachment()]),
      true,
    );
    expect(result).toBeNull();
    expect((aiParserService as any).analyzeRaw).not.toHaveBeenCalled();
  });

  it('ignores image when vision classifies as non-open (retro/commentary)', async () => {
    setupVision({ action: 'ignore', symbol: 'XAUUSD', confidence: 0.3, reasoning: 'recap' });
    const result = await createParser().parse(message('mansoor-img-ignore', '', [imageAttachment()]), true);
    expect(result).toBeNull();
  });

  it('ignores image when open strategy lacks a stop loss (G2)', async () => {
    setupVision(visionOpen({ stopLoss: null }));
    const result = await createParser().parse(message('mansoor-img-no-sl', '', [imageAttachment()]), true);
    expect(result).toBeNull();
  });

  it('ignores image when symbol is outside the Mansoor whitelist (G4)', async () => {
    setupVision(visionOpen({ symbol: 'SOL' }));
    const result = await createParser().parse(message('mansoor-img-badsym', '', [imageAttachment()]), true);
    expect(result).toBeNull();
  });

  it('respects IMAGE_PRICE_TOLERANCE default of 0.2% (relative)', () => {
    expect(IMAGE_PRICE_TOLERANCE).toBe(0.002);
  });
});