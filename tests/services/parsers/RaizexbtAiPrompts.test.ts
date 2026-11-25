import { parseResponseContent } from '../../../src/services/parsers/RaizexbtAiPrompts';

const usage = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 };

describe('RaizexbtAiPrompts.parseResponseContent — required confidence', () => {
    it('defaults a missing confidence to neutral 0.5 instead of dropping the signal', () => {
        // 线上事故 05:58 的原始返回：字段齐全，但模型漏了 confidence。
        const result = parseResponseContent(JSON.stringify({
            action: 'open',
            symbol: 'BTC_USDT',
            side: 'sell',
            entryPrice: 62133.4,
            stopLoss: 64564.5,
            targets: [55167.0],
            orderType: 'limit',
            riskMultiplier: 0.5,
            reasoning: 'complete setup with readable SL and TP',
        }), usage, 'test:');

        expect(result).not.toBeNull();
        expect(result!.action).toBe('open');
        expect(result!.confidence).toBe(0.5);
    });

    it('coerces a string confidence into a number', () => {
        const result = parseResponseContent(JSON.stringify({
            action: 'open', symbol: 'BTC_USDT', side: 'buy',
            entryPrice: 1, stopLoss: 1, targets: [2], confidence: '0.85',
        }), usage, 'test:');
        expect(result!.confidence).toBe(0.85);
    });

    it('keeps an explicit low confidence so the conversion gate can still drop it', () => {
        const result = parseResponseContent(JSON.stringify({
            action: 'open', symbol: 'BTC_USDT', side: 'buy',
            entryPrice: 1, stopLoss: 1, targets: [2], confidence: 0.2,
        }), usage, 'test:');
        expect(result!.confidence).toBe(0.2);
    });

    it('clamps out-of-range confidence into 0.0-1.0', () => {
        expect(parseResponseContent(JSON.stringify({
            action: 'open', symbol: 'BTC_USDT', side: 'buy',
            entryPrice: 1, stopLoss: 1, targets: [2], confidence: 1.7,
        }), usage, 'test:')!.confidence).toBe(1);
        expect(parseResponseContent(JSON.stringify({
            action: 'open', symbol: 'BTC_USDT', side: 'buy',
            entryPrice: 1, stopLoss: 1, targets: [2], confidence: -0.3,
        }), usage, 'test:')!.confidence).toBe(0);
    });
});
