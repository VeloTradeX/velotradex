/**
 * Mansoor 专用「图片开仓信号」视觉提示词。
 *
 * 背景：Mansoor 偶尔以一张图表截图的形式发布开仓策略（相对纯文本是少数情况）。
 * 这类图片有可识别的指纹——解析器此时是空仓、且策略 entry 贴近实时市价。因此这里
 * 负责把图表标注的 entry/SL/TP 抽出来，并让模型对「是否全新开仓图」做判断。
 *
 * 与 Raizexbt/文本 LLM 的区别：Mansoor 只开仓、从不响应 BE/管理类，因此仅允许
 * action:open，不产出 close/update/cancel。
 */
import logger, { formatError } from '../../utils/logger';

export type VisionAction = 'open' | 'ignore';

export interface MansoorVisionResult {
    action: VisionAction;
    symbol?: string;
    side?: 'buy' | 'sell';
    entryPrice?: number;
    stopLoss?: number;
    takeProfits?: number[];
    confidence?: number;
    reasoning?: string;
}

export const MANSOOR_SYSTEM_PROMPT = [
    'You are an expert trading signal parser for a trader named Mansoor who posts open signals on a Discord channel.',
    'The trader occasionally posts a CHART SCREENSHOT alone (rare) as a brand-new entry signal, instead of typed text.',
    'This kind of image signal is a FRESH OPEN in a direction, with the entry, stop loss, and take-profit levels drawn on a TradingView chart.',
    'Your job is to read the chart image and return structured JSON for ONLY a fresh open signal.',
    'Only accept a chart as an entry signal when it clearly shows an active LONG or SHORT setup with an obvious entry level and a clear stop-loss level.',
    'If the image is a retrospective recap, a quote of a past trade, analysis, commentary, or lacks a clear stop-loss, return action:ignore.',
    'Output ONLY valid JSON. No markdown, no code block, no explanation.'
].join(' ');

export const MANSOOR_VISION_RULES = `<rules>
1. Only action:open is allowed. Never output close, update, or cancel. Mansoor never responds to breakeven or manage signals.
2. A clear entry screenshot: a LONG/SHORT setup drawn on the chart with a visible entry line and a visible stop-loss line. That is action:open.
3. side: "buy" for LONG setups, "sell" for SHORT setups.
4. entryPrice: read the horizontal entry line / the boundary between the take-profit zone and stop-loss zone. For a short, stopLoss > entryPrice > first target; for a long, first target > entryPrice > stopLoss.
5. Never use the TradingView bright "current price" marker or its price tag as entryPrice. The entry is a distinct drawn level. The live price marker is NOT the entry.
6. stopLoss is REQUIRED. If no unambiguous stop-loss level is visible, return action:ignore.
7. takeProfits: extract every distinct horizontal TP level visible on the chart into takeProfits as a numeric array, ascending. If none visible, use an empty array.
8. This trader opens at/near the current market price (immediate fill, no pending limit order). So the entry level you extract should lie very close to the chart's visible current price.
9. symbol: infer from the chart's price scale or any symbol label. map to BASE_USDT (XAU/GOLD/XAUUSD -> XAU_USDT, USDJPY -> USDJPY, BTC -> BTC_USDT, ETH -> ETH_USDT). Use the <market_prices> and <positions> as reference when the label is absent.
10. If you cannot read entry + side + stop-loss together with reasonable confidence, return action:ignore instead of guessing.
11. confidence: 0.0-1.0 on whether this is a genuine fresh open signal.
</rules>`;

export const MANSOOR_OUTPUT_FORMAT = `<output_format>
{
  "action": "open|ignore",
  "symbol": "XAU_USDT",
  "side": "buy|sell",
  "entryPrice": number_or_null,
  "stopLoss": number_or_null,
  "takeProfits": [number] or [],
  "confidence": 0.0-1.0,
  "reasoning": "brief explanation"
}
</output_format>`;

export function parseMansoorVisionResponse(content: string | null, logPrefix: string): MansoorVisionResult | null {
    if (!content) {
        logger.warn(`${logPrefix} Empty vision response from LLM`);
        return null;
    }

    try {
        let jsonStr = content.trim();
        if (jsonStr.startsWith('```')) {
            jsonStr = jsonStr.replace(/^```(?:json)?\s*/, '').replace(/```\s*$/, '');
        }

        const result = JSON.parse(jsonStr) as MansoorVisionResult;

        if (!result.action) {
            logger.warn(`${logPrefix} Vision response missing action`);
            return null;
        }
        if (result.action !== 'open' && result.action !== 'ignore') {
            logger.warn(`${logPrefix} Invalid vision action`, { action: result.action });
            return null;
        }

        // 注意：gold/FX（XAUUSD、USDJPY）不被通用 normalizeSymbol 支持（会把金价扩成
        // *_USDT），故不做通用归一化，symbol 原样保留，交由解析器侧白名单(mapping)映射。

        if (result.side) {
            const s = String(result.side).toLowerCase();
            if (s === 'buy' || s === 'long') result.side = 'buy';
            else if (s === 'sell' || s === 'short') result.side = 'sell';
        }

        if (Array.isArray(result.takeProfits)) {
            result.takeProfits = result.takeProfits
                .map(v => parseFloat(String(v)))
                .filter(v => !Number.isNaN(v))
                .sort((a, b) => a - b);
        }

        if (result.entryPrice != null) {
            const n = parseFloat(String(result.entryPrice));
            if (!Number.isNaN(n)) result.entryPrice = n;
        }
        if (result.stopLoss != null) {
            const n = parseFloat(String(result.stopLoss));
            if (!Number.isNaN(n)) result.stopLoss = n;
        }

        return result;
    } catch (e: any) {
        logger.error(`${logPrefix} Failed to parse Mansoor vision JSON`, formatError(e, { content }));
        return null;
    }
}