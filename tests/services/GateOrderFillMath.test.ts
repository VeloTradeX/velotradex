import { computeGateFilledQty } from '../../src/services/exchanges/gateOrderFillMath';

describe('computeGateFilledQty', () => {
  it('treats a cancelled sell order (size=-49 / left=-49) as zero fill', () => {
    expect(computeGateFilledQty(-49, -49)).toBe(0);
  });

  it('treats a cancelled buy order (size=98 / left=98) as zero fill', () => {
    expect(computeGateFilledQty(98, 98)).toBe(0);
  });

  it('computes a partial fill on a sell order (size=-98 / left=-49)', () => {
    expect(computeGateFilledQty(-98, -49)).toBe(49);
  });

  it('computes a full fill on a sell order (size=-49 / left=0)', () => {
    expect(computeGateFilledQty(-49, 0)).toBe(49);
  });

  it('computes a partial fill on a buy order (size=98 / left=49)', () => {
    expect(computeGateFilledQty(98, 49)).toBe(49);
  });

  it('falls back to the full size when left is missing', () => {
    expect(computeGateFilledQty(98, undefined)).toBe(98);
    expect(computeGateFilledQty(98, null)).toBe(98);
  });

  it('never returns a negative quantity', () => {
    expect(computeGateFilledQty(49, 98)).toBe(0);
  });
});
