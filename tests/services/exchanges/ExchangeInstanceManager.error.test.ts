import { serializeError } from '../../../src/services/exchanges/ExchangeInstanceManager';

describe('serializeError', () => {
  it('preserves Error details for logging', () => {
    const err = Object.assign(new Error('boom'), {
      code: 'ENOENT',
      errno: -2,
      syscall: 'access',
      path: './bin/lighter-signer',
    });

    expect(serializeError(err)).toMatchObject({
      name: 'Error',
      message: 'boom',
      code: 'ENOENT',
      errno: -2,
      syscall: 'access',
      path: './bin/lighter-signer',
    });
  });

  it('serializes non-error values', () => {
    expect(serializeError('bad')).toEqual({ message: 'bad' });
    expect(serializeError({ foo: 1 })).toEqual({ foo: 1 });
  });
});
