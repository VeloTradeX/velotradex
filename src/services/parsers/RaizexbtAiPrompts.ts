import logger, { formatError } from '../../utils/logger';
import { normalizeSymbol } from '../../utils/normalizeSymbol';
import { parseNumericValue, normalizeStopLossValue } from './RaizexbtTextMatchers';

// ─── Types ───────────────────────────────────────────────────────────────────

export type LLMAction = 'open' | 'close' | 'update' | 'cancel' | 'ignore';
export type LLMSide = 'buy' | 'sell';

export interface LLMResult {
    action: LLMAction;
    symbol: string;
    side?: LLMSide;
    closePercentage?: number | null;
    closePrice?: number | string | null;
    entryPrice?: number | null;
    stopLoss?: number | string | null;
    targets?: Array<number | string>;
    orderType?: 'market' | 'limit';
    riskMultiplier?: number;
    confidence?: number;
    reasoning?: string;
}

// ─── Constants ───────────────────────────────────────────────────────────────

export const SYSTEM_PROMPT = [
    'You are an expert crypto futures trading signal parser.',
    'You are analyzing messages from a trader who posts trading signals in a Discord channel.',
    'The trader posts chart screenshots with annotations showing entry prices, stop losses, and take profit levels.',
    'The text accompanying the chart provides context about the action taken.',
    'You MUST combine text intent and image information together.',
    'Do not open a trade based on image alone.',
    'Only output action:open when the CURRENT message text clearly indicates active trading intent (already entering now, setting limit now, or explicitly planning to enter now).',
    'If the text says the position was opened elsewhere, in another account, earlier, historically, or is only sharing past trades/performance, return action:ignore even if a chart has clear levels.',
    'When text and image conflict, prioritize text intent for deciding action type.',
    'For TP shorthand messages (e.g., "TP1", "TP2", "Tp1") with an attached chart, treat this as take-profit execution on an existing position, not ignore.',
    'When TP shorthand message has no explicit symbol, use <positions> and chart direction/price levels to map to the most likely active position symbol.',
    'For TP1/TP2 shorthand without explicit full-close wording, closePercentage may be omitted so execution can use configured tpDistribution.',
    'Only use closePercentage=100 when text explicitly indicates full close (e.g., "close all", "fully closed", "all out", "100%").',
    'If the message is setting a TP price/level for an existing position (not TP1/TP2 shorthand), output action:close and put that exit price into closePrice.',
    'If a TP message includes a partial-close ratio such as 25%, 50%, or 90%, include it in closePercentage.',
    'If the message is moving stop loss to breakeven / break-even / B/E / "stops be", output action:update and stopLoss:"breakeven".',
    'If the message says to close/exit at breakeven, that is action:close, not action:update.',
    'When chart labels are clear, prioritize extracting numeric levels from the chart over vague text.',
    'Most charts are TradingView charts.',
    'On TradingView charts, entry, stop-loss, and take-profit are usually placed at distinct horizontal levels on the right price axis.',
    'Strictly distinguish the TradingView current price marker from the actual entry line: the current price marker on the price axis is NOT the entry price.',
    'For limit long/short setups with colored risk/reward boxes, the entry price is the boundary between the take-profit colored zone and the stop-loss colored zone, not the latest/current price label.',
    'For TradingView limit setups, the live/current price marker is only market context for symbol/scale inference; never use it as limit entryPrice.',
    'For short limits, enforce stopLoss > entryPrice > first target; for long limits, enforce first target > entryPrice > stopLoss.',
    'For short risk/reward boxes, use the boundary below the gray stop-loss zone above entry and above the red take-profit zone below entry as entryPrice. For long risk/reward boxes, use the boundary below the green take-profit zone above entry and above the gray stop-loss zone below entry as entryPrice.',
    'If you cannot visually separate entry from the current price marker, set entryPrice to null or lower confidence instead of guessing.',
    'Take-profit may be less visually obvious than entry/stop, but it should still correspond to a distinct price-axis level different from nearby levels.',
    'For open/update signals, extract take-profit levels into targets whenever visible.',
    'If multiple take-profit levels are visible (TP1/TP2/TP3 or multiple horizontal TP lines), extract all of them as a numeric array in ascending order and do not keep only one.',
    'If no take-profit level is visible or stated, return targets as an empty array.',
    'Your job is to extract structured trading information from the chart image and text.',
    'Output ONLY valid JSON. No markdown, no code block, no explanation.'
].join(' ');

export const VISION_RULES = `<rules>
1. "Longed" or "Long" = action:open, side:buy
2. "Shorted" or "Short" = action:open, side:sell
3. "Closing", "Stopped", "Stopped out" = action:close
4. "Remove limit", "Cancel" = action:cancel
5. "setting limit" with chart = action:open, orderType:limit
6. RR reports like "2.5RR+", "0.5R" = action:ignore (performance report, not actionable)
7. Tp reports like "Tp1", "Tp2" = action:close (closePercentage may be null so execution can map by tpDistribution)
8. "No active limits", "Gn", greetings = action:ignore
9. If text says "Entry and stops in chart", you MUST extract entry price and stop loss from the chart image
10. For action:open or action:update, extract take-profit prices into targets from chart labels/lines (TP, Take Profit, T1/T2/T3, TP1/TP2/TP3)
11. If multiple take-profit prices are visible, include all distinct numeric prices in targets in ascending order
12. If only one take-profit price is visible, targets should contain one number
13. Assume the chart is usually TradingView; use right-side price-axis alignment and horizontal level differences to infer TP levels when TP labels are faint
14. Take-profit levels can be less obvious than entry/stop, but should still map to distinct price-axis positions different from nearby levels
15. Never use the TradingView current price marker/current price label as entryPrice. It is NOT the entry price unless the chart explicitly labels that same horizontal level as Entry.
16. For limit-order setups, entryPrice is the horizontal entry line that forms the boundary between the take-profit colored zone and the stop-loss colored zone. For longs, TP is above that boundary and SL below it; for shorts, TP is below that boundary and SL above it.
17. If the chart shows TP, SL, current price, and entry levels, compare all right-axis labels: choose the entry boundary line, not the current price marker even if it is visually prominent or closest to candles.
18. If entry and current price cannot be separated with high confidence, set entryPrice to null and explain the ambiguity in reasoning.
18.1 For TradingView limit setups, the live/current price marker is only market context for symbol/scale inference; never use it as limit entryPrice.
18.2 The valid entryPrice for a limit setup must be supported by a drawn horizontal entry line, the center/boundary line of a risk/reward box, or an explicit Entry/Limit label. A standalone right-axis price tag near the candles is not enough.
18.3 For side:sell + orderType:limit, when SL/entry/TP are visible, enforce stopLoss > entryPrice > first target. If the chosen entry is the current price marker or violates this relation, re-check the risk/reward box boundary.
18.4 For side:buy + orderType:limit, when TP/entry/SL are visible, enforce first target > entryPrice > stopLoss. If the chosen entry is the current price marker or violates this relation, re-check the risk/reward box boundary.
18.5 For a SHORT LIMIT risk/reward box, the gray stop-loss zone above entry and the red take-profit zone below entry meet at the entry boundary; that horizontal boundary is entryPrice.
18.6 For a LONG LIMIT risk/reward box, the green take-profit zone above entry and the gray stop-loss zone below entry meet at the entry boundary; that horizontal boundary is entryPrice.
18.7 If the right-axis live/current price black marker includes a timer below it, it is the live market price marker and MUST NOT be used as a limit entry.
19. If take-profit prices are not visible or not inferable, set targets to []
20. Symbol format: use BASE_USDT (e.g. SOL_USDT, BTC_USDT, ETH_USDT)
21. Only analyze English text. Any Chinese text has already been removed.
22. Open-intent gate: action:open is allowed only when current text indicates active open intent now. If text lacks open intent, do not output open.
23. If text indicates "opened elsewhere", "already in from another place/account", "old trade/history/recap/performance showcase", output action:ignore even when chart has complete setup.
24. If chart shows setup but text is only commentary or retrospective sharing, output action:ignore.
25. If current message is TP shorthand (TP1/TP2/Tp1/Tp2) and has chart image, do NOT ignore; classify as action:close for existing position management.
26. If TP shorthand message does not include symbol, infer symbol by matching chart direction/entry/stop/tp levels to <positions>; if one position is clearly most likely, use that symbol.
27. For TP shorthand without explicit full-close wording, closePercentage can be null to let execution map to configured tpDistribution.
28. closePercentage: 100 is only allowed when text explicitly means full close (e.g., close all, fully closed, all out, 100%).
29. If the current message is setting a take-profit price/level (for example "tp at 70.2" or a chart marking the TP location) and it is NOT TP1/TP2 shorthand, output action:close with closePrice set to that TP level.
30. If that TP message also says to close a portion (for example 90%), include closePercentage with that number.
31. If the message is moving stop-loss to breakeven / break-even / B/E / "stops be", output action:update with stopLoss:"breakeven".
32. If the message says close/exit at breakeven, output action:close instead of update.
33. Risk multiplier: If text mentions risk level like "0.5R", "0.5 R", "half R", "low risk", "reduced risk", extract riskMultiplier. "0.5R" or "half R" or "low risk" = 0.5. "1R" or "normal" = 1.0. "2R" or "high risk" = 2.0. If not mentioned, omit riskMultiplier (defaults to 1.0).
</rules>`;

export const TEXT_RULES = `<rules>
1. "Longed" or "Long" = action:open, side:buy
2. "Shorted" or "Short" = action:open, side:sell
3. "Closing", "Stopped", "Stopped out" = action:close
4. "Remove limit", "Cancel" = action:cancel
5. RR reports like "2.5RR+", "0.5R" = action:ignore
6. Tp reports like "Tp1", "Tp2" = action:close (closePercentage can be null to let execution map by tpDistribution)
7. "No active limits", "Gn", greetings, weekly results = action:ignore
8. If this is a reply referencing a previous trade (e.g. "> Shorted"), use context to determine if it's closing or updating
9. Without a chart image, entryPrice and stopLoss may be unknown - set them to null
10. Symbol format: use BASE_USDT (e.g. SOL_USDT, BTC_USDT, ETH_USDT)
11. Only analyze English text. Any Chinese text has already been removed.
12. Open-intent gate: output action:open only if current text clearly shows active open intent now.
13. If text says the trade is opened elsewhere/another account/earlier, or is historical recap/performance sharing, output action:ignore.
14. If text does not contain clear open intent and is only commentary, output action:ignore.
15. If message is TP shorthand (TP1/TP2/Tp1/Tp2), treat as active position management and output action:close, do not ignore.
16. If TP shorthand message has no symbol, infer symbol from <positions>; if only one active position exists, use that symbol.
17. For TP shorthand without explicit full-close wording, closePercentage can be null to let execution map to configured tpDistribution.
18. If a non-shorthand TP message is setting a TP price/level for an existing position, output action:close and set closePrice to that TP level.
19. If that TP message contains a partial-close ratio (e.g. 25%, 50%, 90%), include it in closePercentage.
20. If the message is moving stop-loss to breakeven / break-even / B/E / "stops be", output action:update with stopLoss:"breakeven".
21. If the message says close/exit at breakeven, output action:close rather than update.
22. Risk multiplier: If text mentions risk level like "0.5R", "0.5 R", "half R", "low risk", "reduced risk", extract riskMultiplier. "0.5R" or "half R" or "low risk" = 0.5. "1R" or "normal" = 1.0. "2R" or "high risk" = 2.0. If not mentioned, omit riskMultiplier (defaults to 1.0).
</rules>`;

export const OUTPUT_FORMAT = `<output_format>
{
  "action": "open|close|update|cancel|ignore",
  "symbol": "BTC_USDT",
  "side": "buy|sell",
  "closePercentage": number_or_null (TP1/TP2 shorthand may be null to use execution tpDistribution; full-close wording -> 100),
  "closePrice": number_or_null (for priced TP / priced exit close orders),
  "entryPrice": number_or_null,
  "stopLoss": number_or_"breakeven"_or_null,
  "targets": [number] or [] (for open/update include all visible TP prices, ascending),
  "orderType": "market|limit",
  "riskMultiplier": number_or_null (0.5 for low risk, 1.0 for normal, 2.0 for high risk; omit if not mentioned),
  "confidence": 0.0-1.0,
  "reasoning": "brief explanation"
}
</output_format>`;

export const MARKET_PRICE_RULES = `<market_price_inference_rules>
Use <market_prices> as cached reference prices for BTC, ETH, SOL, gold, silver, and other common markets.
If there are no active positions and the current message text and screenshot contain no explicit symbol, infer the symbol by comparing visible chart price levels with <market_prices>.
Choose the symbol with the closest current price when the chart price scale is clearly closest to one listed market.
Do not default to BTC_USDT when symbol evidence is missing; use price proximity or return action:ignore with low confidence.
</market_price_inference_rules>`;

// ─── LLM Response Normalization ──────────────────────────────────────────────

export function parseResponseContent(content: string, usage: any, logPrefix: string): LLMResult | null {
    if (!content) {
        logger.warn(`${logPrefix} Empty response from LLM`);
        return null;
    }

    logger.info(`${logPrefix} LLM raw response`, { content });

    try {
        // Handle potential markdown code block wrapping
        let jsonStr = content.trim();
        if (jsonStr.startsWith('```')) {
            jsonStr = jsonStr.replace(/^```(?:json)?\s*/, '').replace(/```\s*$/, '');
        }

        const result = JSON.parse(jsonStr) as LLMResult;

        // Validate required fields
        if (!result.action) {
            logger.warn(`${logPrefix} LLM response missing action`);
            return null;
        }

        // Normalize action
        const validActions: LLMAction[] = ['open', 'close', 'update', 'cancel', 'ignore'];
        if (!validActions.includes(result.action)) {
            logger.warn(`${logPrefix} Invalid action from LLM`, { action: result.action });
            return null;
        }

        // Normalize symbol
        if (result.symbol) {
            result.symbol = normalizeSymbol(result.symbol);
        }

        // Normalize side
        if (result.side) {
            const s = String(result.side).toLowerCase();
            if (s === 'buy' || s === 'long') result.side = 'buy';
            else if (s === 'sell' || s === 'short') result.side = 'sell';
        }

        if (Array.isArray(result.targets)) {
            result.targets = result.targets
                .map(target => parseNumericValue(target))
                .filter((target): target is number => typeof target === 'number');
        }

        if ((result as any).closePrice != null) {
            const numericClosePrice = parseNumericValue((result as any).closePrice);
            if (typeof numericClosePrice === 'number') {
                result.closePrice = numericClosePrice;
            }
        }

        if ((result as any).entryPrice != null) {
            const numericEntryPrice = parseNumericValue((result as any).entryPrice);
            if (typeof numericEntryPrice === 'number') {
                result.entryPrice = numericEntryPrice;
            }
        }

        if ((result as any).stopLoss != null) {
            const normalizedStopLoss = normalizeStopLossValue((result as any).stopLoss);
            if (normalizedStopLoss != null) {
                result.stopLoss = normalizedStopLoss;
            }
        }

        if ((result as any).closePercentage != null) {
            const rawClosePercentage = (result as any).closePercentage;
            const numericClosePercentage = typeof rawClosePercentage === 'number'
                ? rawClosePercentage
                : parseFloat(String(rawClosePercentage).replace('%', '').trim());
            if (!Number.isNaN(numericClosePercentage)) {
                result.closePercentage = Math.max(0, Math.min(100, numericClosePercentage));
            }
        }

        if (usage) {
            logger.info(`${logPrefix} LLM token usage`, {
                prompt: usage.prompt_tokens,
                completion: usage.completion_tokens,
                total: usage.total_tokens
            });
        }

        return result;
    } catch (e: any) {
        logger.error(`${logPrefix} Failed to parse LLM JSON response`, formatError(e, { content }));
        return null;
    }
}
