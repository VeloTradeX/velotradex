/**
 * MansoorParser — 开仓信号解析器（文本优先 + 图片兜底视觉识别）。
 *
 * 行为约定（与 Mansoor 的交易风格对齐）：
 * - open-only：只解析开仓信号（BUY/SELL XAUUSD + SL + TP），开仓后持仓到止盈或止损。
 * - never responds to BE：不响应任何 BE（breakeven）或提前平仓/管理类消息，一律忽略。
 * - reply quote is historical context：消息以回复/引用形式出现（艾特/引用了此前开仓消息）
 *   视为仓位 pin（播报/状态更新），不产生新开仓，一律忽略。
 * - 文本优先：多数信号以文本发布，用纯正则确定性解析，无需 LLM。
 * - 图片兜底：Mansoor 偶尔（少数情况）以一张图表截图发布全新开仓策略，此时调用视觉
 *   大模型识别开仓位置与方向。对此类图片信号设有严格守卫：
 *     G1 该频道该 symbol 当前无持仓（OPEN/PARTIAL）；
 *     G2 视觉须产出 open + side + symbol + SL，缺 SL 一律丢弃；
 *     G3 策略 entry 贴近实时市价；
 *     G4 symbol 落在 Mansoor 白名单（XAU/GOLD、USDJPY、BTC、ETH）。
 *   其中 G3 的设置理由：该解析器基本只做贴近市价的即时成交单（市价风格），不会挂限价单，
 *   因此图片信号的 entry 必然贴近实时市价，据此设贴近市价校验，挡住回顾/解盘/晒单类图表。
 *
 * 实现：继承通用 AiParserBase（文本优先→图片兜底的模板流程 + 图片去重 + 编辑检测），
 * 本类只负责 Mansoor 特有的文本正则、前置拒绝和图片守卫校验。不继承 RaizexbtParser。
 */
import { IStrategyParser, ParsedStrategy, StrategyRiskConfig } from './types';
import logger, { formatError } from '../../utils/logger';
import { AiParserBase, VisionLLMResponse } from './AiParserBase';
import aiParserService from '../AIParserService';
import marketService from '../MarketService';
import { StrategyPosition } from '../../models';
import { escapeXML } from '../AIParserPromptBuilder';
import {
    MANSOOR_SYSTEM_PROMPT,
    MANSOOR_VISION_RULES,
    MANSOOR_OUTPUT_FORMAT,
    parseMansoorVisionResponse,
    MansoorVisionResult,
} from './MansoorAiPrompts';

// ─── 常量 ─────────────────────────────────────────────────────────────────

// 回复/引用标记：Discord 中文 locale "回复: [text](link)"，或引用块 "> quoted text"
const REPLY_PATTERN = /^(回复:|>\s)/m;

// 管理类/非开仓意图：BE、提前平仓、止盈/盈亏播报 → 一律忽略（绝不响应）
const MANAGE_INTENT_PATTERN =
    /\b(close|closing|closed|exit|exiting|stopped|stopped\s*out|be\s+set|breakeven|break[\s-]*even|b\/e|\d+\s*pips?\b|pips?\s*done|profit|paid|payed)\b/i;

// G3 价格贴近容差：相对实时市价的偏差比例。0.002 = 0.2%。
// 理由见类头注释：本解析器基本只做贴近市价的即时成交单、不会挂限价单，故设此贴近市价校验。
export const IMAGE_PRICE_TOLERANCE = 0.002;

// G4 symbol 白名单：把视觉识别到/推断的品种归一化到 Mansoor 支持的内部符号。
// key 统一转大写并去掉空格/下划线（如 XAU_USDT -> XAUUSDT），兼容视觉端各种写法。
const SYMBOL_ALIASES: Record<string, string> = {
    XAU: 'XAU_USDT',
    XAUUSD: 'XAU_USDT',
    XAUUSDT: 'XAU_USDT',
    GOLD: 'XAU_USDT',
    GOLDUSDT: 'XAU_USDT',
    USDJPY: 'USDJPY',
    USDJPYUSDT: 'USDJPY',
    BTC: 'BTC_USDT',
    BTCUSDT: 'BTC_USDT',
    ETH: 'ETH_USDT',
    ETHUSDT: 'ETH_USDT',
};

// ─── Parser ────────────────────────────────────────────────────────────────

export class MansoorParser extends AiParserBase implements IStrategyParser {
    name = 'MansoorParser';

    protected get logPrefix(): string {
        return 'MansoorParser:';
    }

    protected get systemPrompt(): string {
        return MANSOOR_SYSTEM_PROMPT;
    }

    // ─── 入口过滤：带回复的消息不进解析进程 ────────────────────────────────

    /**
     * 只要消息「带回复」，就整条跳过不进入解析进程。
     * 判定覆盖三层：
     * - 原始 Discord 消息的结构化回复字段（message_reference / type=19 等）；
     * - bot 规范化后的 reply 字段（reply_to / is_reply 等）；
     * - 文本内容（中文 locale 的 "回复: [..](..)" 前缀、或 "> " 引用块）。
     */
    protected isReplyMessage(message: any): boolean {
        const content = String(message?.content || '');
        if (REPLY_PATTERN.test(content)) return true;

        // Discord message type 19 = REPLY（新版回复按钮）。
        if (message?.type === 19) return true;

        // 结构化引用/回复字段只要存在（非 null/undefined）即视为回复。
        const replyFieldKeys = [
            'message_reference', 'referenced_message',
            'reply_to', 'replied_to', 'reply_to_message', 'replied_message',
            'messageReference', 'referencedMessage', 'replyTo',
            'is_reply', 'isReply', 'isAReply', 'isReplied',
        ];
        for (const key of replyFieldKeys) {
            const value = message?.[key];
            if (value !== undefined && value !== null && value !== false) return true;
        }

        return false;
    }

    public async parse(message: any, isDryRun: boolean = false): Promise<ParsedStrategy[] | null> {
        // 带回复的消息视为仓位 pin（历史播报/状态更新），绝不产生新开仓：
        // 在进入解析流程前就先过滤，避免文本/图片被当新信号处理。
        if (this.isReplyMessage(message)) {
            logger.info(`${this.logPrefix} Reply message detected, skipping before parse`, { id: message?.id });
            return null;
        }
        return super.parse(message, isDryRun);
    }

    public getRiskConfig(): StrategyRiskConfig {
        return {
            riskMode: 'fixed',
            riskValue: 10,
            defaultLeverage: '20',
            priceTolerance: 0.01, // 0.01R
            entryOrderMode: 'taker',
            tpDistribution: [0.5, 0.3, 0.2],
            tpOrderType: 'limit',
            tpOrderMode: 'maker',
            autoCloseOppositePosition: true,
            positionSizingMode: 'risk_based'
        };
    }

    // ─── AiParserBase hooks ────────────────────────────────────────────────

    protected rejectReason(content: string): string | null {
        // 回复/引用识别：开仓信号一定是独立新消息，不会以回复形式出现；
        // 图片信号也必须是非回复的全新开仓图。
        if (REPLY_PATTERN.test(content)) {
            return 'Reply/pin detected, ignoring';
        }
        // 管理类/非开仓意图：BE、提前平仓、止盈/盈亏播报 → 一律忽略。
        if (MANAGE_INTENT_PATTERN.test(content)) {
            return 'Non-open intent detected, ignoring';
        }
        return null;
    }

    protected async tryParseText(message: any, isDryRun: boolean): Promise<ParsedStrategy[] | null> {
        const content = message?.content || '';
        const currentText = this.stripReplyQuotes(content);

        const textSide = this.extractTextSide(currentText);
        const textSymbol = this.extractTextSymbol(currentText);
        const textStop = this.extractTextStopLoss(currentText);
        const textTargets = this.extractTextTargets(currentText);
        const textEntry = this.extractTextEntryPrice(currentText);

        // 只开仓：必须有 side + symbol + SL（Mansoor 的开仓格式必然带 SL；
        // 没有 SL 的侧向声明如 "I AM SELLING HERE" 视为播报，不构成开仓）。
        if (!textSide || !textSymbol || textStop == null) {
            logger.debug(`${this.logPrefix} Not a full open signal, ignoring`, {
                id: message?.id,
                side: textSide,
                symbol: textSymbol,
                stopLoss: textStop,
            });
            return null;
        }

        const result: ParsedStrategy = {
            action: 'open',
            symbol: textSymbol,
            side: textSide,
            orderType: 'market',
            ...(textEntry != null ? { entryPrice: textEntry } : {}),
            stopLoss: textStop,
            ...(textTargets.length > 0 ? { targets: textTargets.map(String) } : {}),
            sourceType: 'text',
            raw: message,
        };
        return [result];
    }

    protected async buildVisionUserContent(
        message: any, text: string, imageBase64: string, ts: any
    ): Promise<any[]> {
        const source = message?.channel_id || 'unknown';
        const positionsXml = await aiParserService.buildPositions(source);
        const marketPricesXml = await marketService.getCommonMarketPricesXml();
        const escapedText = escapeXML(text || '(no text, image only)');

        const userText = [
            positionsXml || '',
            marketPricesXml || '',
            `<current_message ts="${ts || ''}">\n  <text>${escapedText}</text>\n  <image>attached (see image below)</image>\n</current_message>`,
            MANSOOR_VISION_RULES,
            MANSOOR_OUTPUT_FORMAT,
        ].filter(Boolean).join('\n\n');

        return [
            { type: 'text', text: userText },
            { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${imageBase64}` } },
        ];
    }

    protected async validateAndConvertVision(
        res: VisionLLMResponse, message: any
    ): Promise<ParsedStrategy[] | null> {
        const vision = parseMansoorVisionResponse(res.content, this.logPrefix);
        if (!vision) {
            logger.warn(`${this.logPrefix} Vision result unparseable, ignoring`, { id: message?.id });
            return null;
        }

        // G2: 只接受全新开仓，且必须有 side + symbol + SL。
        if (vision.action !== 'open') {
            logger.info(`${this.logPrefix} Vision action is not open, ignoring`, { id: message?.id, action: vision.action });
            return null;
        }
        const side = vision.side;
        if (!side) {
            logger.warn(`${this.logPrefix} Vision open missing side, ignoring`, { id: message?.id });
            return null;
        }
        const symbol = this.mapVisionSymbol(vision.symbol);
        if (!symbol) {
            logger.warn(`${this.logPrefix} Vision symbol not in Mansoor whitelist, ignoring`, { id: message?.id, symbol: vision.symbol });
            return null;
        }
        const stopLoss = vision.stopLoss;
        if (stopLoss == null || Number.isNaN(stopLoss)) {
            logger.info(`${this.logPrefix} Vision open missing SL, ignoring`, { id: message?.id });
            return null;
        }
        const entry = vision.entryPrice;
        if (entry == null || Number.isNaN(entry)) {
            logger.info(`${this.logPrefix} Vision open missing entry price, ignoring`, { id: message?.id });
            return null;
        }

        // G1: 该频道该 symbol 当前无持仓（按品种判断）。
        if (await this.hasOpenPosition(message?.channel_id, symbol)) {
            logger.info(`${this.logPrefix} Active ${symbol} position exists, ignoring image signal`, { id: message?.id });
            return null;
        }

        // G3: 策略 entry 贴近实时市价（相对偏差 ≤ 0.2%）。现价取不到 → 保守拒绝。
        const currentPrice = await marketService.getCurrentPrice(symbol);
        if (!(currentPrice > 0)) {
            logger.warn(`${this.logPrefix} Current price unavailable, conservatively rejecting image signal`, { id: message?.id, symbol });
            return null;
        }
        const deviation = Math.abs(entry - currentPrice) / currentPrice;
        if (deviation > IMAGE_PRICE_TOLERANCE) {
            logger.info(`${this.logPrefix} Image entry too far from market (${(deviation * 100).toFixed(2)}%), ignoring`, {
                id: message?.id, symbol, entry, currentPrice,
            });
            return null;
        }

        const strategy: ParsedStrategy = {
            action: 'open',
            symbol,
            side,
            orderType: 'market',
            entryPrice: String(entry),
            stopLoss: String(stopLoss),
            ...(vision.takeProfits && vision.takeProfits.length > 0
                ? { targets: vision.takeProfits.map(String) }
                : {}),
            sourceType: 'image',
            raw: message,
        };
        logger.info(`${this.logPrefix} Image open signal accepted`, { id: message?.id, symbol, side, entry, stopLoss, currentPrice });
        return [strategy];
    }

    // ─── Guards & helpers ──────────────────────────────────────────────────

    private async hasOpenPosition(channelId: string | undefined, symbol: string): Promise<boolean> {
        try {
            const found = await StrategyPosition.findOne({
                where: { source: channelId || 'unknown', symbol, status: ['OPEN', 'PARTIAL'] as any },
            });
            return !!found;
        } catch (error: any) {
            logger.warn(`${this.logPrefix} Failed to check positions`, formatError(error));
            return false; // 查询失败不回退为拒绝，避免漏单（G1 在 G3 之后，仍有基类流程兜底）
        }
    }

    private mapVisionSymbol(symbolRaw: string | undefined): string | null {
        if (!symbolRaw) return null;
        const key = String(symbolRaw).toUpperCase().replace(/_/g, '');
        return SYMBOL_ALIASES[key] || null;
    }

    // ─── Text Extraction Helpers ───────────────────────────────────────────

    private stripReplyQuotes(content: string): string {
        // Remove Discord reply quotes: "回复: [text](link)" or "> quoted text"
        return content
            .replace(/^回复:\s*\[.*?\]\([^)]+\)\s*/m, '')
            .replace(/^>\s*.*$/m, '')
            .trim();
    }

    private extractTextSide(content: string): 'buy' | 'sell' | undefined {
        const upper = content.toUpperCase();
        if (/\bSELL\b/.test(upper)) return 'sell';
        if (/\bBUY\b/.test(upper)) return 'buy';
        if (/\bI AM SELLING\b/i.test(content)) return 'sell';
        if (/\bI AM BUYING\b/i.test(content)) return 'buy';
        return undefined;
    }

    private extractTextSymbol(content: string): string | undefined {
        const upper = content.toUpperCase();
        if (/\bXAUUSD\b/.test(upper) || /\bGOLD\b/.test(upper) || /\bXAU\b/.test(upper)) {
            return 'XAU_USDT';
        }
        // USDJPY 为非 USD 报价外汇对，内部符号沿用交易所原名（与 cfdSymbol.fromTradFiSymbol 一致），
        // 不要加 _USDT（加会与符号转换链冲突，导致 ticker/下单 SYMBOL_NOT_EXISTS）。
        if (/\bUSDJPY\b/.test(upper)) return 'USDJPY';
        if (/\bBTC\b/.test(upper)) return 'BTC_USDT';
        if (/\bETH\b/.test(upper)) return 'ETH_USDT';
        return undefined;
    }

    private extractTextEntryPrice(content: string): string | undefined {
        const match = content.match(/(?:PRICE|ENTRY)\s*[:\-=]\s*(\d+(?:\.\d+)?)/i);
        if (match) return String(parseFloat(match[1]));
        return undefined;
    }

    private extractTextStopLoss(content: string): string | undefined {
        const match = content.match(/(?:SL|stop\s*loss)\s*[:\-=]\s*(\d+(?:\.\d+)?)/i);
        if (match) return String(parseFloat(match[1]));
        const mySl = content.match(/MY\s+SL\s*[:\-=]\s*(\d+(?:\.\d+)?)/i);
        if (mySl) return String(parseFloat(mySl[1]));
        return undefined;
    }

    private extractTextTargets(content: string): number[] {
        const targets: number[] = [];
        const seen = new Set<number>();

        // Multiple TPs: "TP1: 4675.00\nTP2: 4665.00\n..."
        const multiTp = content.matchAll(/\bTP\s*(\d+)\s*[:\-=]\s*(\d+(?:\.\d+)?)/gi);
        for (const m of multiTp) {
            const val = parseFloat(m[2]);
            if (!seen.has(val)) { seen.add(val); targets.push(val); }
        }

        // Long term TP: "Long term TP: 4601.00"
        const longTerm = content.matchAll(/long\s*term\s*TP\s*[:\-=]\s*(\d+(?:\.\d+)?)/gi);
        for (const m of longTerm) {
            const val = parseFloat(m[1]);
            if (!seen.has(val)) { seen.add(val); targets.push(val); }
        }

        // Single TP: "TP : 4600.90" — only if no numbered TPs found
        if (targets.length === 0) {
            const singleTp = content.match(/\bTP\s*[:\-=]\s*(\d+(?:\.\d+)?)/i);
            if (singleTp) targets.push(parseFloat(singleTp[1]));
        }

        return targets;
    }
}