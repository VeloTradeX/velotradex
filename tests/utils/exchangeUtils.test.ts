import { isTradFiExchange } from '../../src/utils/exchangeUtils';

describe('isTradFiExchange', () => {
  it('should return true for TradFiExchange by name', () => {
    const exchange = { name: 'gate_tradfi' };
    expect(isTradFiExchange(exchange)).toBe(true);
  });

  it('should return true for TradFiExchange by constructor name', () => {
    class TradFiExchange { name = 'gate_tradfi'; }
    const exchange = new TradFiExchange();
    expect(isTradFiExchange(exchange)).toBe(true);
  });

  it('should return false for GateIOExchange', () => {
    class GateIOExchange { name = 'gate'; }
    const exchange = new GateIOExchange();
    expect(isTradFiExchange(exchange)).toBe(false);
  });

  it('should return false for null/undefined', () => {
    expect(isTradFiExchange(null)).toBe(false);
    expect(isTradFiExchange(undefined)).toBe(false);
  });

  it('should return false for plain object', () => {
    expect(isTradFiExchange({ name: 'other' })).toBe(false);
  });
});
