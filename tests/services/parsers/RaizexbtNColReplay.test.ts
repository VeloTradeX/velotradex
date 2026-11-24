import fs from 'fs';
import path from 'path';
import { RaizexbtParser } from '../../../src/services/parsers/RaizexbtParser';
import aiParserService from '../../../src/services/AIParserService';
import marketService from '../../../src/services/MarketService';
import { replyContextResolver, ReplyContext } from '../../../src/services/parsers/ReplyContextResolver';
import { ParsedStrategy } from '../../../src/services/parsers/types';

/**
 * N 列人工修正回放测试。
 *
 * 用 2026-10-01 ~ 2026-11-24 历史报文里人工标注过的 30 条消息（Excel「手动修正」N 列），
 * 按真实到达顺序喂给同一个 RaizexbtParser 实例：
 * - LLM 响应来自当时的原始输出（fixture 里的 llm 字段），不发起真实 AI 调用；
 * - 图片下载、持仓/行情、回复链全部 mock；
 * - 断言修复后每条消息产出的策略（风险倍数、半 R 缩放、部分平仓+BE、取消、1R 计划、近似重复标记等）。
 *
 * 唯一的人为构造：2375（0.3R + 完整图表）旧 LLM 输出是 ignore，
 * fixture 用「新提示词下应有的 open 输出」模拟，以验证确定性 0.3R 覆盖。
 */
interface FixtureMessage {
    seq: number;
    id: string;
    ts: number;
    content: string;
    hasImage: boolean;
    llm: Record<string, any> | null;
    replyTo: {
        id: string;
        seq: number;
        symbol: string | null;
        side: string | null;
        action: string | null;
        lifecycleStatus: string;
    } | null;
    excelManual: string;
}

const fixture: FixtureMessage[] = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, '../../fixtures/raizexbt_ncol_replay.json'), 'utf8'),
);

function buildReplyContext(msg: FixtureMessage): ReplyContext {
    if (!msg.replyTo) return { chain: [], origin: null, symbol: null };
    const origin = msg.replyTo;
    return {
        chain: [{ id: origin.id, content: `$${origin.symbol || 'UNKNOWN'}`, referencedIds: [], depth: 1 }],
        origin: {
            messageId: origin.id,
            strategyId: origin.seq * 10,
            symbol: origin.symbol,
            side: origin.side,
            action: origin.action,
            entryPrice: null,
            stopLoss: null,
            orderId: origin.seq * 10 + 1,
            exchangeOrderId: `ex-${origin.seq * 10 + 1}`,
            orderStatus: origin.lifecycleStatus,
            lifecycleStatus: origin.lifecycleStatus,
        },
        symbol: origin.symbol,
    };
}

type Expectation = Record<string, any> | null;

const EXPECTATIONS: Record<number, Expectation[] | null> = {
    // 1729: 引用上一条 open 说 "No limits for now" → 取消挂单（不是 ignore）
    1729: [{ action: 'cancel', symbol: 'BTC_USDT' }],
    // 1731: "high risk trade" → 0.5R（历史 bug 是 2.0R）
    1731: [{ action: 'open', symbol: 'BTC_USDT', side: 'sell', riskMultiplier: 0.5 }],
    // 1737: "2R+ sl to entry manage trade" → 仅移 BE，不当平仓（人工标注：正确）
    1737: [{ action: 'update', symbol: 'BTC_USDT', stopLoss: 'breakeven', breakevenMode: 'protect' }],
    // 1740: "2RR* Can do partials and manage" → 部分平仓 50% + 自动 BE（不是全平）
    1740: [
        { action: 'close', symbol: 'ETH_USDT', closePercentage: 50, keepPartialProtections: true },
        { action: 'update', symbol: 'ETH_USDT', stopLoss: 'breakeven', breakevenMode: 'protect' },
    ],
    // 1748: "Risky scalp" → 0.5R
    1748: [{ action: 'open', symbol: 'ETH_USDT', side: 'buy', riskMultiplier: 0.5 }],
    // 1765: "Use 0.3-0.5R on this trade" → 半 R 规则缩放到 0.3R
    1765: [{ action: 'update', symbol: 'SUI_USDT', riskResize: true, riskMultiplier: 0.3 }],
    // 1768: "Partials" → 50% + BE
    1768: [
        { action: 'close', symbol: 'SUI_USDT', closePercentage: 50, keepPartialProtections: true },
        { action: 'update', symbol: 'SUI_USDT', stopLoss: 'breakeven' },
    ],
    // 1770: "2R+ Partials and manage accordingly" → 50% + BE
    1770: [
        { action: 'close', symbol: 'ETH_USDT', closePercentage: 50, keepPartialProtections: true },
        { action: 'update', symbol: 'ETH_USDT', stopLoss: 'breakeven' },
    ],
    // 1794: 独立 "Risk 0.5R" → 不新开仓，缩放到前一条 ETH 空单
    1794: [{ action: 'update', symbol: 'ETH_USDT', riskResize: true, riskMultiplier: 0.5 }],
    // 1803: "got low hold will close if we get breakeven" → 回本平仓语义（浮亏走限价出场）
    1803: [{ action: 'update', symbol: 'BTC_USDT', stopLoss: 'breakeven', breakevenMode: 'exit_at_entry' }],
    // 1812: "Tp1 here / 1.3R+" → TP1 简写走 tpDistribution（不强制 100）
    1812: [{ action: 'close', symbol: 'BTC_USDT' }],
    // 1817: 独立 "0.5R" → 缩放到前一条 BTC 多单
    1817: [{ action: 'update', symbol: 'BTC_USDT', riskResize: true, riskMultiplier: 0.5 }],
    // 1855: "Use 0.5R on this" → 缩放到前一条 BTC 多单
    1855: [{ action: 'update', symbol: 'BTC_USDT', riskResize: true, riskMultiplier: 0.5 }],
    // 1860: "Runner left" → 平 80% + BE（历史是全平 100%）
    1860: [
        { action: 'close', symbol: 'BTC_USDT', closePercentage: 80, keepPartialProtections: true },
        { action: 'update', symbol: 'BTC_USDT', stopLoss: 'breakeven' },
    ],
    // 1870: "USE 0.5R ON THIS TRADE" → 缩放到前一条 BTC 空单，不新开仓
    1870: [{ action: 'update', symbol: 'BTC_USDT', riskResize: true, riskMultiplier: 0.5 }],
    // 1873: "Cutting this entry" 引用已成交仓位 → 平仓
    1873: [{ action: 'close', symbol: 'ETH_USDT' }],
    // 1877: reply "0.5R on this" → 缩放到被引用的 DOGE 空单
    1877: [{ action: 'update', symbol: 'DOGE_USDT', riskResize: true, riskMultiplier: 0.5 }],
    // 1892: "Scalp long" 与上一条同图 → 仍产出 open，但必须带近似重复拦截标记
    1892: [{ action: 'open', symbol: 'BTC_USDT', side: 'buy', nearDuplicateGuard: true }],
    // 2227: "Risky short" → 0.5R
    2227: [{ action: 'open', symbol: 'BTC_USDT', side: 'sell', riskMultiplier: 0.5 }],
    // 2239: "low risk" 不是开仓信号 → 暂存给下一条；2240 开仓 0.5R
    2239: null,
    2240: [{ action: 'open', symbol: 'ETH_USDT', side: 'buy', riskMultiplier: 0.5 }],
    2241: null,
    // 2242: 只有 $BTC + 图、无止损 → 不开仓
    2242: null,
    // 2258: "Can manage your position after 1R accordingly" → 1R 平 50% + BE 计划
    2258: [{ action: 'update', symbol: 'BTC_USDT', planRMultiple: 1, planClosePercentage: 50 }],
    // 2270: 前一条 ".5R" + 本条 "Shorted" → 0.5R
    2270: [{ action: 'open', symbol: 'BTC_USDT', side: 'sell', riskMultiplier: 0.5 }],
    // 2331: "runner only left like 10-15%" → 部分平仓
    2331: [
        { action: 'close', symbol: 'BTC_USDT' },
        { action: 'update', symbol: 'BTC_USDT', stopLoss: 'breakeven' },
    ],
    // 2332: "full tp soon / stops alr flat" 只是期望 → 不做任何处理
    2332: null,
    // 2341/2342 风险便签暂存（0.3 优先于 low risk），2343 开仓 0.3R
    2341: null,
    2342: null,
    2343: [{ action: 'open', symbol: 'ETH_USDT', side: 'sell', riskMultiplier: 0.3 }],
    // 2362: "Risky long" → 0.5R
    2362: [{ action: 'open', symbol: 'BTC_USDT', side: 'buy', riskMultiplier: 0.5 }],
    // 2365: 独立 "0.5R" → 缩放到前一条 BTC 多单
    2365: [{ action: 'update', symbol: 'BTC_USDT', riskResize: true, riskMultiplier: 0.5 }],
    // 2366: 与 2364 相近时间/价格/方向 → 近似重复拦截标记
    2366: [{ action: 'open', symbol: 'BTC_USDT', side: 'buy', nearDuplicateGuard: true }],
    // 2375: "0.3R" + 完整图表 → 开仓且强制 0.3R
    2375: [{ action: 'open', symbol: 'BTC_USDT', side: 'buy', riskMultiplier: 0.3 }],
};

describe('Raizexbt N-column manual-fix replay (30 annotated messages)', () => {
    let parser: RaizexbtParser;
    const results = new Map<number, ParsedStrategy[] | null>();
    const llmById = new Map<string, Record<string, any> | null>();

    beforeAll(async () => {
        jest.spyOn(aiParserService, 'isConfigured').mockReturnValue(true);
        jest.spyOn(aiParserService, 'buildPositions').mockResolvedValue('<positions>\n  <empty>No active positions</empty>\n</positions>');
        jest.spyOn(marketService, 'getCommonMarketPricesXml').mockResolvedValue('');
        jest.spyOn(replyContextResolver, 'resolve').mockImplementation(async (message: any) => {
            const found = fixture.find(item => item.id === String(message?.id));
            return found ? buildReplyContext(found) : { chain: [], origin: null, symbol: null };
        });
        jest.spyOn(aiParserService, 'analyzeRaw').mockImplementation(async (params: any) => {
            const originalId = String(params?.originalMessage?.id ?? '');
            const llm = llmById.get(originalId) ?? null;
            if (!llm) {
                throw new Error(`Unexpected LLM call for replay message ${originalId}`);
            }
            return {
                content: JSON.stringify(llm),
                usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
                raw: { id: `replay-${originalId}` },
                logId: 1,
            } as any;
        });

        parser = new RaizexbtParser();
        jest.spyOn(parser as any, 'downloadImageAsBase64').mockResolvedValue('ZmFrZS1pbWFnZQ==');

        for (const item of fixture) {
            llmById.set(item.id, item.llm);
        }

        // 按真实到达顺序串行喂给同一个 parser 实例（半 R 规则依赖顺序）。
        for (const item of fixture) {
            const message = {
                id: item.id,
                channel_id: 'raizexbt-replay',
                content: item.content,
                ts: item.ts,
                username: 'raizelxbt',
                attachments: item.hasImage
                    ? [{ url: `https://cdn.example.com/${item.id}.jpg`, proxy_url: `https://cdn.example.com/${item.id}.jpg`, is_image: true }]
                    : [],
            };
            results.set(item.seq, await parser.parse(message));
        }
    });

    afterAll(() => {
        jest.restoreAllMocks();
    });

    const assertedSeqs = Object.keys(EXPECTATIONS).map(Number);
    it('replays all annotated messages in order', () => {
        expect(fixture.length).toBeGreaterThanOrEqual(45);
    });

    it.each(assertedSeqs)('message #%i matches the expected fix', (seq) => {
        const expected = EXPECTATIONS[seq];
        const actual = results.get(seq) ?? null;
        if (expected === null) {
            expect(actual).toBeNull();
            return;
        }
        expect(actual).not.toBeNull();
        expect(actual!).toHaveLength(expected.length);
        expected.forEach((item, index) => {
            // TP 简写（1812）必须走 tpDistribution：不能出现显式 closePercentage / closePrice
            if (seq === 1812) {
                expect(actual![index]).not.toHaveProperty('closePercentage');
                expect(actual![index]).not.toHaveProperty('closePrice');
            }
            expect(actual![index]).toEqual(expect.objectContaining(item!));
        });
    });
});
