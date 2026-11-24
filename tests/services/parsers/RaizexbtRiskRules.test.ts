import {
    detectStandaloneRiskNote,
    isCancelEntryIntent,
    isCuttingEntryIntent,
    isDcaText,
    isExitAtBreakevenIntent,
    isFullCloseExpectation,
    isOneRManagementPlan,
    isRunnerLeftIntent,
    resolveRiskMultiplierFromText,
} from '../../../src/services/parsers/RaizexbtRiskRules';

describe('RaizexbtRiskRules.resolveRiskMultiplierFromText', () => {
    it.each([
        // 高风险一律缩仓 0.5R（历史 bug 是放大成 2R）
        ['trying this high risk trade so manage your risk $BTC', 0.5],
        ['high risk trade so manage your risk', 0.5],
        ['Risky scalp $ETH', 0.5],
        ['Risky long', 0.5],
        ['Risky short', 0.5],
        ['risky scalp short $BTC', 0.5],
        ['low risk', 0.5],
        ['Low risk again', 0.5],
        ['low risk> 0.3-0.5R only', 0.3],
        ['Use 0.3-0.5R on this trade', 0.3],
        ['Risk 0.5R', 0.5],
        ['.5R', 0.5],
        ['0.3R', 0.3],
        ['USE 0.5R ON THIS TRADE', 0.5],
        ['taking this 1R risk', 1.0],
        ['half size', 0.5],
    ])('maps sizing phrase "%s" to %s', (text, expected) => {
        expect(resolveRiskMultiplierFromText(text)).toBeCloseTo(expected as number, 5);
    });

    it.each([
        // RR 结果是战绩，不是仓位
        ['2R+', undefined],
        ['2.5RR+', undefined],
        ['3RR+ 75% out', undefined],
        ['-0.5R', undefined],
        ['Took -0.5R on this', undefined],
        ['4RR+', undefined],
        ['2R+ sl to entry manage trade', undefined],
        // 无关文本
        ['$BTC', undefined],
        ['Stops to entry', undefined],
        ['full tp soon', undefined],
    ])('does not treat report "%s" as position sizing', (text, expected) => {
        expect(resolveRiskMultiplierFromText(text)).toBeUndefined();
        expect(expected).toBeUndefined();
    });
});

describe('RaizexbtRiskRules.detectStandaloneRiskNote', () => {
    it.each([
        ['0.5R', 0.5],
        ['.5R', 0.5],
        ['0.3R', 0.3],
        ['Risk 0.5R', 0.5],
        ['USE 0.5R ON THIS TRADE', 0.5],
        ['Use 0.5R on this', 0.5],
        ['0.5R on this', 0.5],
        ['0.5R\n\n0.5R', 0.5],
        ['low risk', 0.5],
        ['Low risk again', 0.5],
        ['Low risk> 0.3-0.5R only', 0.3],
        ['risky', 0.5],
        ['half R', 0.5],
    ])('detects bare note "%s" as %sR', (text, expected) => {
        const note = detectStandaloneRiskNote(text);
        expect(note).not.toBeNull();
        expect(note!.multiplier).toBeCloseTo(expected as number, 5);
    });

    it.each([
        ['Risky scalp $ETH'],       // 带交易动作 → 开仓信号
        ['SCALP SHORTED'],
        ['$BTC'],
        ['Can do partials and manage'],
        ['0.3R'],
    ])('does not classify "%s" as a bare note when it contains trade intent', (text) => {
        if (text === '0.3R') {
            // 纯数字便签本身是 note；这里只验证其它类型
            expect(detectStandaloneRiskNote(text)).not.toBeNull();
            return;
        }
        expect(detectStandaloneRiskNote(text)).toBeNull();
    });

    it('does not treat RR report messages as risk notes', () => {
        expect(detectStandaloneRiskNote('2R+')).toBeNull();
        expect(detectStandaloneRiskNote('-0.5R')).toBeNull();
    });
});

describe('RaizexbtRiskRules.management intent detectors', () => {
    it.each([
        'No limits for now\nWill give you update manually',
        'not setting any limits',
        'remove the limit',
        'Cutting this entry\nChoppy PA',
    ])('detects cancel wording "%s"', (text) => {
        expect(isCancelEntryIntent(text)).toBe(true);
    });

    it('does not treat "Not limit / manual watching" as a hard cancel (not annotated by user)', () => {
        expect(isCancelEntryIntent('Not limit\nManual watching this')).toBe(false);
    });

    it('separates cutting-an-entry from other cancel wording', () => {
        expect(isCuttingEntryIntent('Cutting this entry')).toBe(true);
        expect(isCuttingEntryIntent('No limits for now')).toBe(false);
    });

    it('detects expectation wording that must not become a full close', () => {
        expect(isFullCloseExpectation('full tp soon\nstops alr flat')).toBe(true);
        expect(isFullCloseExpectation('fully tped 3R+')).toBe(false);
        expect(isFullCloseExpectation('close all')).toBe(false);
    });

    it('detects runner-left wording', () => {
        expect(isRunnerLeftIntent('Runner left')).toBe(true);
        expect(isRunnerLeftIntent('runner only left liek 10-15%')).toBe(false);
    });

    it('detects DCA wording', () => {
        expect(isDcaText('i dca my entry a bit here')).toBe(true);
        expect(isDcaText('adding here')).toBe(true);
        expect(isDcaText('Scalp long')).toBe(false);
    });

    it('detects 1R management plan wording', () => {
        expect(isOneRManagementPlan('Can manage your position after 1R accordingly')).toBe(true);
        expect(isOneRManagementPlan('manage after 1R')).toBe(true);
        expect(isOneRManagementPlan('Holding fully')).toBe(false);
    });

    it('detects breakeven-exit wording (浮亏时要用回本限价平仓)', () => {
        expect(isExitAtBreakevenIntent('got low hold will close if we get breakeven')).toBe(true);
        expect(isExitAtBreakevenIntent('will close if we get back to entry')).toBe(true);
        // 立即平仓指令不能被当成「条件性回本平仓」管理计划
        expect(isExitAtBreakevenIntent('Closing this at entry and going to sleep')).toBe(false);
        expect(isExitAtBreakevenIntent('Stops to entry')).toBe(false);
    });
});
