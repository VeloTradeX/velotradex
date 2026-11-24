import { convertToStrategies, resolveEffectiveRiskMultiplier } from '../../../src/services/parsers/RaizexbtStrategyConversion';
import { LLMResult } from '../../../src/services/parsers/RaizexbtAiPrompts';

function message(content: string) {
    return { id: 'test-msg', channel_id: 'test-channel', content, ts: new Date().toISOString(), username: 'raizelxbt' };
}

function result(overrides: Partial<LLMResult> = {}): LLMResult {
    return {
        action: 'open',
        symbol: 'BTC_USDT',
        side: 'buy',
        entryPrice: 63108.1,
        stopLoss: 62562.1,
        targets: [64612.6],
        orderType: 'limit',
        confidence: 0.75,
        reasoning: 'chart signal',
        ...overrides,
    };
}

describe('RaizexbtStrategyConversion — risk sizing', () => {
    it('maps "Risky long" to 0.5R even when the LLM returned 2.0', () => {
        const strategies = convertToStrategies(result({ riskMultiplier: 2.0 }), message('Risky long'), 'test:');
        expect(strategies).toHaveLength(1);
        expect(strategies![0].action).toBe('open');
        expect(strategies![0].riskMultiplier).toBe(0.5);
    });

    it('maps "Risky short" to 0.5R', () => {
        const strategies = convertToStrategies(
            result({ side: 'sell', entryPrice: 65388.2, stopLoss: 66090.5, targets: [63360.7] }),
            message('Risky short'),
            'test:',
        );
        expect(strategies![0].riskMultiplier).toBe(0.5);
    });

    it('takes the LOWER bound of "Use 0.3-0.5R on this trade"', () => {
        const strategies = convertToStrategies(
            result({ action: 'update', riskMultiplier: 0.4, side: 'buy' }),
            message('Use 0.3-0.5R on this trade'),
            'test:',
        );
        // 非 riskResize 的 update 不带仓位缩放能力，但风险值仍应可解析
        expect(resolveEffectiveRiskMultiplier(result({ riskMultiplier: 0.4 }), message('Use 0.3-0.5R on this trade')))
            .toBe(0.3);
        expect(strategies).not.toBeNull();
    });

    it('clamps any >1R LLM multiplier to 1R (the channel never sizes up)', () => {
        expect(resolveEffectiveRiskMultiplier(result({ riskMultiplier: 2 }), message('$BTC'))).toBe(1);
    });

    it('builds a riskResize update from a bare half-R note', () => {
        const strategies = convertToStrategies(
            result({ action: 'update', riskMultiplier: 0.5, riskResize: true }),
            message('0.5R'),
            'test:',
        );
        expect(strategies).toHaveLength(1);
        expect(strategies![0].action).toBe('update');
        expect(strategies![0].riskResize).toBe(true);
        expect(strategies![0].riskMultiplier).toBe(0.5);
    });

    it('forwards the 1R management plan to the executor', () => {
        const strategies = convertToStrategies(
            result({ action: 'update', planRMultiple: 1, planClosePercentage: 50 }),
            message('Can manage your position after 1R accordingly'),
            'test:',
        );
        expect(strategies![0].action).toBe('update');
        expect(strategies![0].planRMultiple).toBe(1);
        expect(strategies![0].planClosePercentage).toBe(50);
    });
});

describe('RaizexbtStrategyConversion — partial exits', () => {
    it('turns "Partials" into 50% close + auto breakeven and keeps protections', () => {
        const strategies = convertToStrategies(
            result({ action: 'close', side: 'buy', entryPrice: null, stopLoss: null, targets: [] }),
            message('Partials'),
            'test:',
        );
        expect(strategies).toHaveLength(2);
        expect(strategies![0].action).toBe('close');
        expect(strategies![0].closePercentage).toBe(50);
        expect(strategies![0].keepPartialProtections).toBe(true);
        expect(strategies![1].action).toBe('update');
        expect(strategies![1].stopLoss).toBe('breakeven');
        expect(strategies![1].breakevenMode).toBe('protect');
    });

    it('turns "Runner left" into 80% close + breakeven', () => {
        const strategies = convertToStrategies(
            result({ action: 'close', side: 'sell', entryPrice: null, stopLoss: null, targets: [] }),
            message('Runner left'),
            'test:',
        );
        expect(strategies![0].action).toBe('close');
        expect(strategies![0].closePercentage).toBe(80);
        expect(strategies![0].keepPartialProtections).toBe(true);
        expect(strategies![1].action).toBe('update');
        expect(strategies![1].stopLoss).toBe('breakeven');
    });

    it('does not append a duplicate breakeven when the close already says manage/partials', () => {
        const strategies = convertToStrategies(
            result({ action: 'close', side: 'buy', entryPrice: null, stopLoss: null, targets: [] }),
            message('Can do partials and manage'),
            'test:',
        );
        expect(strategies![0].closePercentage).toBe(50);
        expect(strategies!.filter(s => s.action === 'update' && s.stopLoss === 'breakeven')).toHaveLength(1);
    });

    it('keeps TP1 shorthand on the tpDistribution path (no hard 100% close)', () => {
        const strategies = convertToStrategies(
            result({ action: 'close', side: 'sell', entryPrice: null, stopLoss: null, targets: [], closePercentage: null }),
            message('Tp1 here\n\n1.3R+'),
            'test:',
        );
        expect(strategies).toHaveLength(1);
        expect(strategies![0].action).toBe('close');
        expect(strategies![0].closePercentage).toBeUndefined();
    });

    it('maps breakeven-exit wording to update/exit_at_entry instead of close', () => {
        const strategies = convertToStrategies(
            result({ action: 'update', stopLoss: 'breakeven', side: 'sell' }),
            message('got low hold will close if we get breakeven'),
            'test:',
        );
        expect(strategies![0].action).toBe('update');
        expect(strategies![0].stopLoss).toBe('breakeven');
        expect(strategies![0].breakevenMode).toBe('exit_at_entry');
    });

    it('keeps classic "Stops to entry" in protect mode', () => {
        const strategies = convertToStrategies(
            result({ action: 'open', stopLoss: 'breakeven' }),
            message('Stops to entry'),
            'test:',
        );
        expect(strategies![0].action).toBe('update');
        expect(strategies![0].breakevenMode).toBe('protect');
    });
});

describe('RaizexbtStrategyConversion — open guardrails', () => {
    it('drops an open signal without a readable stop loss', () => {
        const strategies = convertToStrategies(
            result({ stopLoss: null, entryPrice: null, targets: [], orderType: 'market' }),
            message('$BTC'),
            'test:',
        );
        expect(strategies).toBeNull();
    });

    it('keeps DCA opens without a stop loss and exempts them from the near-duplicate guard', () => {
        const strategies = convertToStrategies(
            result({ stopLoss: null, entryPrice: null, targets: [], orderType: 'market' }),
            message('i dca my entry a bit here'),
            'test:',
        );
        expect(strategies).toHaveLength(1);
        expect(strategies![0].isAddPosition).toBe(true);
        expect(strategies![0].allowAddPosition).toBe(true);
        expect(strategies![0].nearDuplicateGuard).toBeUndefined();
    });

    it('marks normal opens for the near-duplicate guard', () => {
        const strategies = convertToStrategies(result(), message('Scalp long'), 'test:');
        expect(strategies![0].nearDuplicateGuard).toBe(true);
    });
});
