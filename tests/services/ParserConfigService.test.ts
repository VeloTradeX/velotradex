// tests/services/ParserConfigService.test.ts
import ParserConfigService from '../../src/services/ParserConfigService';

describe('ParserConfigService', () => {
  const service = ParserConfigService;

  describe('validateConfig', () => {
    describe('entryMergeThresholdR', () => {
      it('accepts undefined (field not provided)', () => {
        expect(service.validateConfig({})).toBeNull();
      });

      it('accepts 0 (no merging)', () => {
        expect(service.validateConfig({ entryMergeThresholdR: 0 })).toBeNull();
      });

      it('accepts positive values', () => {
        expect(service.validateConfig({ entryMergeThresholdR: 0.5 })).toBeNull();
        expect(service.validateConfig({ entryMergeThresholdR: 1.0 })).toBeNull();
        expect(service.validateConfig({ entryMergeThresholdR: 2.0 })).toBeNull();
        expect(service.validateConfig({ entryMergeThresholdR: 10 })).toBeNull();
      });

      it('accepts numeric strings (from DB JSON)', () => {
        expect(service.validateConfig({ entryMergeThresholdR: '1.5' })).toBeNull();
        expect(service.validateConfig({ entryMergeThresholdR: '0' })).toBeNull();
      });

      it('rejects negative values', () => {
        expect(service.validateConfig({ entryMergeThresholdR: -0.5 })).toBe('entryMergeThresholdR must be a number >= 0.');
      });

      it('rejects NaN (non-numeric string)', () => {
        expect(service.validateConfig({ entryMergeThresholdR: 'abc' })).toBe('entryMergeThresholdR must be a number >= 0.');
      });

      it('rejects null', () => {
        // parseFloat(null) returns NaN
        expect(service.validateConfig({ entryMergeThresholdR: null })).toBe('entryMergeThresholdR must be a number >= 0.');
      });
    });

    describe('existing validations still work', () => {
      it('valid config passes', () => {
        expect(service.validateConfig({
          riskMode: 'ratio_based',
          riskValue: 1,
          priceTolerance: 0.005,
          entryPaddingR: 0,
          entryMergeThresholdR: 0.5,
        })).toBeNull();
      });

      it('invalid riskMode is rejected', () => {
        expect(service.validateConfig({ riskMode: 'invalid' })).toContain('Invalid riskMode');
      });
    });
  });
});
