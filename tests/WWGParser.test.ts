import registry from '../src/services/parsers';
import { WWGParser } from '../src/services/parsers/WWGParser';
import aiParserService from '../src/services/AIParserService';
import fs from 'fs';
import os from 'os';
import path from 'path';

jest.mock('../src/services/AIParserService', () => ({
  __esModule: true,
  default: {
    isConfigured: jest.fn(() => true),
    analyzeRaw: jest.fn(),
    buildPositions: jest.fn(async () => '<positions></positions>'),
    getCurrentRouteContext: jest.fn(() => ({ routeIds: [101], routeNames: ['Route 101'] })),
  },
}));

jest.mock('../src/services/MarketService', () => ({
  __esModule: true,
  default: {
    getCommonMarketPricesXml: jest.fn(async () =>
      '<market_prices><market symbol="BTC_USDT" price="65000" /><market symbol="ETH_USDT" price="2000" /></market_prices>'
    ),
  },
}));

const mockedAI = aiParserService as jest.Mocked<typeof aiParserService> & {
  getCurrentRouteContext: jest.Mock;
};

function wwgMessage(id: string, description: string) {
  return {
    id,
    channel_id: 'wwg-channel',
    content: '🏷️ 交易员：woods\n-# Last update - <t:1771982668:R>',
    timestamp: '2026-02-25T01:24:29.193000+00:00',
    ts: '2026-02-25T01:24:29.193000+00:00',
    embeds: [{ description }],
  };
}

function createParser(): WWGParser {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wwg-parser-'));
  return new WWGParser({ snapshotCacheFile: path.join(tempDir, 'snapshots.json') });
}

const noTrades = `<#100000000000000001>

__**现有持仓（可入场）**__
- No trades available

__**未成交挂单**__
- No trades available

__**失效单**__
- No trades available`;

const btcEthOrders = `<#100000000000000001>

__**现有持仓（可入场）**__
- No trades available

__**未成交挂单**__
- 做多 **BTC** | **入场点:** 65200 − 64480 | **止损:** 62160
- 做空 **ETH** | **入场点:** 1988 − 2000 | **止损:** 2061

__**失效单**__
- No trades available`;

const linkedEthShortOrder = `<#100000000000000001>

__**现有持仓（可入场）**__
- No trades available

__**未成交挂单**__
- **做空 [ETH](https://discord.com/channels/1/2/3)** | **入场点:** 2389 | **止损:** 2491 | **Risk:** 1.5%

__**失效单**__
- No trades available`;

const inactiveBtcOnly = `<#100000000000000001>

__**现有持仓（可入场）**__
- No trades available

__**未成交挂单**__
- No trades available

__**失效单**__
- **做空 BTC** | **入场点:** 78400 − 79200 | **止损:** 盈亏平衡 | **PnL:** +0.43%`;

describe('WWGParser', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedAI.isConfigured.mockReturnValue(true);
    mockedAI.buildPositions.mockResolvedValue('<positions></positions>');
    mockedAI.getCurrentRouteContext.mockReturnValue({ routeIds: [101], routeNames: ['Route 101'] });
    mockedAI.analyzeRaw.mockResolvedValue({
      content: JSON.stringify({
        actions: [
          {
            action: 'open',
            symbol: 'BTC_USDT',
            side: 'buy',
            orderType: 'limit',
            entryPrice: 64840,
            stopLoss: 62160,
            targets: [],
            confidence: 0.91,
          },
          {
            action: 'open',
            symbol: 'ETH_USDT',
            side: 'sell',
            orderType: 'limit',
            entryPrice: 1994,
            stopLoss: 2061,
            targets: [],
            confidence: 0.9,
          },
        ],
      }),
      usage: {},
      raw: {},
    });
  });

  it('is registered by parser name', () => {
    expect(registry.getParserByName('WWGParser')?.name).toBe('WWGParser');
  });

  it('uses the first route-scoped snapshot as baseline without calling AI', async () => {
    const parser = createParser();

    const first = await parser.parse(wwgMessage('wwg-1', noTrades));

    expect(first).toBeNull();
    expect(mockedAI.analyzeRaw).not.toHaveBeenCalled();
  });

  it('opens every pending entry price from the first route-scoped snapshot without diffing', async () => {
    const parser = createParser();

    const first = await parser.parse(wwgMessage('wwg-1', btcEthOrders));

    expect(first).toEqual([
      expect.objectContaining({
        action: 'open',
        symbol: 'BTC_USDT',
        side: 'buy',
        orderType: 'limit',
        entryPrice: '65200',
        stopLoss: '62160',
        weight: 0.5,
        averageEntryPrice: 64840,
      }),
      expect.objectContaining({
        action: 'open',
        symbol: 'BTC_USDT',
        side: 'buy',
        orderType: 'limit',
        entryPrice: '64480',
        stopLoss: '62160',
        weight: 0.5,
        averageEntryPrice: 64840,
      }),
      expect.objectContaining({
        action: 'open',
        symbol: 'ETH_USDT',
        side: 'sell',
        orderType: 'limit',
        entryPrice: '1988',
        stopLoss: '2061',
        weight: 0.5,
        averageEntryPrice: 1994,
      }),
      expect.objectContaining({
        action: 'open',
        symbol: 'ETH_USDT',
        side: 'sell',
        orderType: 'limit',
        entryPrice: '2000',
        stopLoss: '2061',
        weight: 0.5,
        averageEntryPrice: 1994,
      }),
    ]);
    expect(first![0].raw.wwg.routeId).toBe(101);
    expect(first![0].raw.wwg.previousDescription).toBe('');
    expect(first![0].raw.wwg.currentDescription).toContain('做多 **BTC**');
    expect(mockedAI.analyzeRaw).not.toHaveBeenCalled();
  });

  it('injects previous and current descriptions and converts multiple AI actions', async () => {
    const parser = createParser();

    await parser.parse(wwgMessage('wwg-1', noTrades));
    const result = await parser.parse(wwgMessage('wwg-2', btcEthOrders));

    expect(result).toEqual([
      expect.objectContaining({
        action: 'open',
        symbol: 'BTC_USDT',
        side: 'buy',
        orderType: 'limit',
        entryPrice: '64840',
        stopLoss: '62160',
      }),
      expect.objectContaining({
        action: 'open',
        symbol: 'ETH_USDT',
        side: 'sell',
        orderType: 'limit',
        entryPrice: '1994',
        stopLoss: '2061',
      }),
    ]);
    expect(result![0].raw.wwg.routeId).toBe(101);
    expect(result![0].raw.wwg.previousDescription).toContain('No trades available');
    expect(result![0].raw.wwg.currentDescription).toContain('做多 **BTC**');

    const request = mockedAI.analyzeRaw.mock.calls[0][0] as any;
    expect(request.systemPrompt).toContain('WWG');
    expect(request.userContent).toContain('<previous_snapshot');
    expect(request.userContent).toContain('<current_snapshot');
    expect(request.userContent).toContain('做空 **ETH**');
    expect(request.userContent).toContain('<positions>');
    expect(request.userContent).toContain('<market_prices>');
  });

  it('keeps previous snapshots independent per route id on one parser instance', async () => {
    const parser = createParser();

    mockedAI.getCurrentRouteContext.mockReturnValue({ routeIds: [101], routeNames: ['Route 101'] });
    await parser.parse(wwgMessage('wwg-1', noTrades));

    mockedAI.getCurrentRouteContext.mockReturnValue({ routeIds: [202], routeNames: ['Route 202'] });
    await parser.parse(wwgMessage('wwg-1', btcEthOrders));

    mockedAI.getCurrentRouteContext.mockReturnValue({ routeIds: [101], routeNames: ['Route 101'] });
    await parser.parse(wwgMessage('wwg-2', btcEthOrders));

    const request = mockedAI.analyzeRaw.mock.calls[0][0] as any;
    expect(request.userContent).toContain('<route id="101"');
    expect(request.userContent).toContain('<previous_snapshot');
    expect(request.userContent).toContain('- No trades available');
    expect(request.userContent).not.toContain('<route id="202"');
  });

  it('corrects AI side from WWG linked markdown rows when a pending order disappears', async () => {
    mockedAI.analyzeRaw.mockResolvedValueOnce({
      content: JSON.stringify({
        actions: [
          {
            action: 'cancel',
            symbol: 'ETH_USDT',
            side: 'buy',
            confidence: 0.9,
            reasoning: 'ETH row disappeared from pending section',
          },
        ],
      }),
      usage: {},
      raw: {},
    });
    const parser = createParser();

    await parser.parse(wwgMessage('wwg-1', linkedEthShortOrder));
    const result = await parser.parse(wwgMessage('wwg-2', noTrades));

    expect(result).toEqual([
      expect.objectContaining({
        action: 'cancel',
        symbol: 'ETH_USDT',
        side: 'sell',
      }),
    ]);
  });

  it('does not convert AI open actions sourced only from invalidated rows', async () => {
    mockedAI.analyzeRaw.mockResolvedValueOnce({
      content: JSON.stringify({
        actions: [
          {
            action: 'open',
            symbol: 'BTC_USDT',
            side: 'sell',
            orderType: 'limit',
            entryPrice: 78400,
            stopLoss: 81100,
            confidence: 0.9,
            reasoning: 'Mistakenly treated invalidated BTC row as a new pending order',
          },
        ],
      }),
      usage: {},
      raw: {},
    });
    const parser = createParser();

    await parser.parse(wwgMessage('wwg-1', noTrades));
    const result = await parser.parse(wwgMessage('wwg-2', inactiveBtcOnly));

    expect(result).toBeNull();
  });

  it('strips Discord markdown links from snapshots before sending them to AI', async () => {
    const parser = createParser();
    const linkedBtc = `<#100000000000000001>

__**现有持仓（可入场）**__
- No trades available

__**未成交挂单**__
- **做多 [BTC](https://discord.com/channels/100000000000000001/100000000000000002/100000000000000003)** | **入场点:** 73676 − 73290 | **止损:** 72150

__**失效单**__
- No trades available`;

    await parser.parse(wwgMessage('wwg-1', noTrades));
    await parser.parse(wwgMessage('wwg-2', linkedBtc));

    const request = mockedAI.analyzeRaw.mock.calls[0][0] as any;
    expect(request.userContent).toContain('做多 BTC');
    expect(request.userContent).not.toContain('https://discord.com/channels');
    expect(request.userContent).not.toContain('[BTC](');
  });

  it('uses only embeds[0].description as the WWG message snapshot', async () => {
    const parser = createParser();

    const first = await parser.parse({
      ...wwgMessage('wwg-1', noTrades),
      content: btcEthOrders,
      embeds: [
        { description: noTrades },
        { description: btcEthOrders },
      ],
    });
    const second = await parser.parse(wwgMessage('wwg-2', noTrades));

    expect(first).toBeNull();
    expect(second).toBeNull();
    expect(mockedAI.analyzeRaw).not.toHaveBeenCalled();
  });

  it('restores the previous route snapshot from disk after parser restart', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wwg-parser-'));
    const snapshotCacheFile = path.join(tempDir, 'snapshots.json');

    const firstParser = new WWGParser({ snapshotCacheFile });
    await firstParser.parse(wwgMessage('wwg-1', noTrades));

    const restartedParser = new WWGParser({ snapshotCacheFile });
    const result = await restartedParser.parse(wwgMessage('wwg-2', btcEthOrders));

    expect(result).toEqual([
      expect.objectContaining({
        action: 'open',
        symbol: 'BTC_USDT',
      }),
      expect.objectContaining({
        action: 'open',
        symbol: 'ETH_USDT',
      }),
    ]);
    expect(mockedAI.analyzeRaw).toHaveBeenCalledTimes(1);
    const request = mockedAI.analyzeRaw.mock.calls[0][0] as any;
    expect(request.userContent).toContain('<previous_snapshot');
    expect(request.userContent).toContain('- No trades available');
  });
});
