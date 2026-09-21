import logger from '../../utils/logger';
import { buildHttpErrorDetails } from '../../utils/retryUtils';
import { MarketInfo } from './IExchange';

export function safeJson(value: any, maxLen: number = 2000): string {
    if (value === undefined) return 'undefined';
    if (value === null) return 'null';
    let text: string;
    if (typeof value === 'string') {
        text = value;
    } else {
        try {
            text = JSON.stringify(value);
        } catch {
            text = String(value);
        }
    }
    return text.length > maxLen ? `${text.slice(0, maxLen)}...(truncated)` : text;
}

export function logHttpError(prefix: string, error: any, extra?: Record<string, any>) {
    const details = buildHttpErrorDetails(error);
    const extraText = extra ? ` | extra=${safeJson(extra)}` : '';
    logger.error(
        `${prefix}: ${details.message ?? 'unknown error'} | status=${details.status ?? 'n/a'} | method=${details.method ?? 'n/a'} | path=${details.path ?? 'n/a'} | requestBody=${safeJson(details.requestBody)} | responseBody=${safeJson(details.responseBody)}${extraText}`
    );
}

export function formatPriceWithMarket(market: MarketInfo, price: string | number): string {
    const p = typeof price === 'string' ? parseFloat(price) : price;

    // Use tickSize if available for precise rounding
    if (market.tickSize) {
        const tick = parseFloat(market.tickSize);
        if (tick > 0) {
            const precision = market.pricePrecision;
            const scale = Math.pow(10, precision);

            // Convert to integers to avoid floating point math issues
            const pScaled = Math.round(p * scale);
            const tickScaled = Math.round(tick * scale);

            if (tickScaled > 0) {
                const roundedScaled = Math.round(pScaled / tickScaled) * tickScaled;
                const result = roundedScaled / scale;
                return result.toFixed(precision);
            }
        }
    }

    return p.toFixed(market.pricePrecision);
}

export function computeProtectionTargetAmount(positionSize: string, side: 'buy' | 'sell', amount?: string): string | null {
    const posSizeRaw = parseFloat(positionSize);
    const posSize = Math.abs(posSizeRaw);
    const isLongPos = posSizeRaw > 0;
    const intendedLong = side === 'buy';
    if (isLongPos !== intendedLong) {
        return null;
    }

    let target = posSize;
    if (amount && Number.isFinite(parseFloat(amount)) && parseFloat(amount) > 0) {
        target = Math.min(posSize, Math.abs(parseFloat(amount)));
    }

    if (!Number.isFinite(target) || target <= 0) {
        return null;
    }

    return target.toString();
}
