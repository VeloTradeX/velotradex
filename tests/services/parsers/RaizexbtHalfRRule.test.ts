import { RaizexbtParser } from '../../../src/services/parsers/RaizexbtParser';
import aiParserService from '../../../src/services/AIParserService';
import marketService from '../../../src/services/MarketService';
import { replyContextResolver, ReplyContext } from '../../../src/services/parsers/ReplyContextResolver';

function message(id: string, content: string, ts: number) {
    return {
        id,
        channel_id: 'test-channel',
        content,
        ts,
        username: 'raizelxbt',
        attachments: [],
    } as any;
}

function llm(content: any, logId = 1) {
    return {
        content: JSON.stringify(content),
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        raw: { id: 'raw' },
        logId,
    } as any;
}

function replyTo(symbol: string, lifecycleStatus: string | null, strategyId = 42): ReplyContext {
    return {
        chain: [{ id: 'origin-msg', content: `$${symbol}`, referencedIds: [], depth: 1 }],
        origin: {
            messageId: 'origin-msg',
            strategyId,
            symbol,
            side: 'buy',
            action: 'open',
            entryPrice: '83917',
            stopLoss: '83360.2',
            orderId: 7,
            exchangeOrderId: 'EX-1',
            orderStatus: lifecycleStatus,
            lifecycleStatus,
        },
        symbol,
    };
}

describe('RaizexbtParser — half-R rule & deterministic management overrides', () => {
    let parser: RaizexbtParser;
    const base = Date.parse('2026-11-24T00:00:00Z');

    beforeEach(() => {
        parser = new RaizexbtParser();
        jest.spyOn(aiParserService, 'isConfigured').mockReturnValue(true);
        jest.spyOn(aiParserService, 'buildPositions').mockResolvedValue('<positions>\n  <empty>No active positions</empty>\n</positions>');
        jest.spyOn(marketService, 'getCommonMarketPricesXml').mockResolvedValue('');
        jest.spyOn(replyContextResolver, 'resolve').mockResolvedValue({ chain: [], origin: null, symbol: null });
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    it('resizes the most recent open signal when a bare half-R note follows it', async () => {
        jest.spyOn(aiParserService, 'analyzeRaw').mockResolvedValue(llm({
            action: 'open',
            symbol: 'BTC_USDT',
            side: 'buy',
            entryPrice: 63108.1,
            stopLoss: 62562.1,
            targets: [64612.6],
            orderType: 'limit',
            confidence: 0.75,
        }));

        const opened = await parser.parse(message('m1', 'Risky long\n\n高风险做多\n--------------', base));
        expect(opened).not.toBeNull();
        expect(opened![0].riskMultiplier).toBe(0.5);

        const resize = await parser.parse(message('m2', '0.5R\n\n0.5R\n--------------', base + 5000));
        expect(resize).not.toBeNull();
        expect(resize![0].action).toBe('update');
        expect(resize![0].riskResize).toBe(true);
        expect(resize![0].riskMultiplier).toBe(0.5);
        expect(resize![0].symbol).toBe('BTC_USDT');
        expect(resize![0].side).toBe('buy');
    });

    it('pairs a risk note up to 2m30s after the open signal', async () => {
        jest.spyOn(aiParserService, 'analyzeRaw').mockResolvedValue(llm({
            action: 'open', symbol: 'BTC_USDT', side: 'buy',
            entryPrice: 63108.1, stopLoss: 62562.1, targets: [64612.6],
            orderType: 'limit', confidence: 0.75,
        }));
        await parser.parse(message('m1', 'Risky long\n\n做多\n--------------', base));
        const resize = await parser.parse(message('m2', '0.5R\n\n0.5R\n--------------', base + 149_000));
        expect(resize).not.toBeNull();
        expect(resize![0].action).toBe('update');
        expect(resize![0].riskResize).toBe(true);
        expect(resize![0].riskMultiplier).toBe(0.5);
    });

    it('does not pair a risk note more than 2m30s after the open signal', async () => {
        jest.spyOn(aiParserService, 'analyzeRaw').mockResolvedValue(llm({
            action: 'open', symbol: 'BTC_USDT', side: 'buy',
            entryPrice: 63108.1, stopLoss: 62562.1, targets: [64612.6],
            orderType: 'limit', confidence: 0.75,
        }));
        await parser.parse(message('m1', 'Risky long\n\n做多\n--------------', base));
        const resize = await parser.parse(message('m2', '0.5R\n\n0.5R\n--------------', base + 151_000));
        expect(resize).toBeNull();
    });

    it('defers a bare risk note and applies it to the next open signal', async () => {
        jest.spyOn(aiParserService, 'analyzeRaw').mockResolvedValue(llm({
            action: 'open',
            symbol: 'ETH_USDT',
            side: 'buy',
            entryPrice: 1806.26,
            stopLoss: 1793.5,
            targets: [1843.36],
            orderType: 'limit',
            confidence: 0.75,
        }));

        const deferred = await parser.parse(message('n1', 'low risk\n\n低风险\n--------------', base));
        expect(deferred).toBeNull();

        const open = await parser.parse(message('n2', '$ETH\n\n$ETH\n--------------', base + 1000));
        expect(open).not.toBeNull();
        expect(open![0].action).toBe('open');
        expect(open![0].riskMultiplier).toBe(0.5);
    });

    it('keeps the specific numeric note when a generic "low risk" note follows it', async () => {
        jest.spyOn(aiParserService, 'analyzeRaw').mockResolvedValue(llm({
            action: 'open',
            symbol: 'ETH_USDT',
            side: 'sell',
            entryPrice: 1621.15,
            stopLoss: 1642.2,
            targets: [1553.39],
            orderType: 'limit',
            confidence: 0.6,
        }));

        // 2341: "Low risk> 0.3-0.5R only" → 0.3
        expect(await parser.parse(message('q1', 'Low risk> 0.3-0.5R only\n\n低风险 > 仅0.3-0.5R\n--------------', base))).toBeNull();
        // 2342: "Low risk again" 不得覆盖成 0.5
        expect(await parser.parse(message('q2', 'Low risk again\n\n又是低风险\n--------------', base + 100))).toBeNull();
        // 2343: 开仓应使用 0.3R
        const open = await parser.parse(message('q3', '$ETH\n\n$ETH\n--------------', base + 200));
        expect(open![0].action).toBe('open');
        expect(open![0].riskMultiplier).toBe(0.3);
    });

    it('does not let a risk note open a new position (no stop loss, no target)', async () => {
        const analyzeSpy = jest.spyOn(aiParserService, 'analyzeRaw');
        const result = await parser.parse(message('r1', 'Risk 0.5R\n\n风险为0.5R\n--------------', base));
        // 没有近邻信号 → 暂存，不调用 LLM，也不开仓
        expect(result).toBeNull();
        expect(analyzeSpy).not.toHaveBeenCalled();
        expect((parser as any).pendingRiskNote?.multiplier).toBe(0.5);
    });

    it('turns "No limits for now" answering a pending entry into a cancel', async () => {
        jest.spyOn(replyContextResolver, 'resolve').mockResolvedValue(replyTo('BTC_USDT', 'PENDING'));
        jest.spyOn(aiParserService, 'analyzeRaw').mockResolvedValue(llm({ action: 'ignore', symbol: null }));

        const strategies = await parser.parse(message(
            'c1',
            '> Reply to: $BTC https://discord.com/channels/1/2/3\n\nNo limits for now\n\nWill give you update manually\n--------------',
            base,
        ));
        expect(strategies).not.toBeNull();
        expect(strategies![0].action).toBe('cancel');
        expect(strategies![0].symbol).toBe('BTC_USDT');
    });

    it('turns "Cutting this entry" answering a filled position into a close', async () => {
        jest.spyOn(replyContextResolver, 'resolve').mockResolvedValue(replyTo('ETH_USDT', 'PROTECTED'));
        jest.spyOn(aiParserService, 'analyzeRaw').mockResolvedValue(llm({ action: 'ignore', symbol: null }));

        const strategies = await parser.parse(message(
            'c2',
            '> Reply to: $ETH https://discord.com/channels/1/2/3\n\nCutting this entry\n\nChoppy PA\n--------------',
            base,
        ));
        expect(strategies).not.toBeNull();
        expect(strategies![0].action).toBe('close');
        expect(strategies![0].symbol).toBe('ETH_USDT');
    });

    it('does not execute "full tp soon" as a close', async () => {
        jest.spyOn(replyContextResolver, 'resolve').mockResolvedValue(replyTo('SOL_USDT', 'OPEN'));
        jest.spyOn(aiParserService, 'analyzeRaw').mockResolvedValue(llm({ action: 'close', symbol: 'SOL_USDT', closePercentage: 100 }));

        const strategies = await parser.parse(message(
            'e1',
            '> Reply to: $SOL https://discord.com/channels/1/2/3\n\nfull tp soon\n\nstops alr flat\n--------------',
            base,
        ));
        expect(strategies).toBeNull();
    });

    it('converts "manage after 1R" into a 1R management plan', async () => {
        jest.spyOn(replyContextResolver, 'resolve').mockResolvedValue(replyTo('BTC_USDT', 'OPEN'));
        jest.spyOn(aiParserService, 'analyzeRaw').mockResolvedValue(llm({ action: 'ignore', symbol: null }));

        const strategies = await parser.parse(message(
            'p1',
            '> Reply to: $BTC https://discord.com/channels/1/2/3\n\nCan manage your position after 1R accordingly\n--------------',
            base,
        ));
        expect(strategies).not.toBeNull();
        expect(strategies![0].action).toBe('update');
        expect(strategies![0].planRMultiple).toBe(1);
        expect(strategies![0].planClosePercentage).toBe(50);
    });
});
