import {
  isRetryableError,
  withRetry,
  buildHttpErrorDetails,
} from '../../src/utils/retryUtils';

// ── helpers ─────────────────────────────────────────────────────────────────

function makeError(overrides: Record<string, unknown> = {}): any {
  const err = new Error('something went wrong');
  Object.assign(err, overrides);
  return err;
}

// ── isRetryableError ────────────────────────────────────────────────────────

describe('isRetryableError', () => {
  describe('retryable by code', () => {
    const codes = [
      'ENOTFOUND',
      'ECONNRESET',
      'ECONNREFUSED',
      'ETIMEDOUT',
      'EAI_AGAIN',
      'EPIPE',
      'EHOSTUNREACH',
    ];

    it.each(codes)('returns true for %s', (code) => {
      expect(isRetryableError(makeError({ code }))).toBe(true);
    });
  });

  describe('retryable by message substring', () => {
    const cases = [
      'socket hang up',
      'connect ETIMEDOUT',
      'connect ECONNREFUSED',
      'connect ECONNRESET',
      'not connected',
    ];

    it.each(cases)('returns true for message containing "%s"', (msg) => {
      expect(isRetryableError(makeError({ message: `prefix ${msg} suffix` }))).toBe(true);
    });
  });

  describe('retryable by HTTP status', () => {
    it('returns true for 429 (rate-limited)', () => {
      expect(isRetryableError(makeError({ status: 429 }))).toBe(true);
    });

    it('returns true for 5xx (server error)', () => {
      expect(isRetryableError(makeError({ status: 500 }))).toBe(true);
      expect(isRetryableError(makeError({ status: 503 }))).toBe(true);
      expect(isRetryableError(makeError({ status: 599 }))).toBe(true);
    });

    it('returns true for 429 via nested response.status', () => {
      const err = makeError({ response: { status: 429 } });
      expect(isRetryableError(err)).toBe(true);
    });

    it('returns true for 5xx via nested response.status', () => {
      const err = makeError({ response: { status: 502 } });
      expect(isRetryableError(err)).toBe(true);
    });
  });

  describe('not retryable', () => {
    it('returns false for 4xx non-429 (client error)', () => {
      expect(isRetryableError(makeError({ status: 400 }))).toBe(false);
      expect(isRetryableError(makeError({ status: 404 }))).toBe(false);
      expect(isRetryableError(makeError({ status: 422 }))).toBe(false);
    });

    it('returns false for 4xx via nested response.status', () => {
      const err = makeError({ response: { status: 400 } });
      expect(isRetryableError(err)).toBe(false);
    });

    it('returns false for AUTO_ORDER_NOT_FOUND label', () => {
      const err = makeError({ label: 'AUTO_ORDER_NOT_FOUND' });
      expect(isRetryableError(err)).toBe(false);
    });

    it('returns false for INVALID_PARAM_VALUE label', () => {
      const err = makeError({ label: 'INVALID_PARAM_VALUE' });
      expect(isRetryableError(err)).toBe(false);
    });

    it('returns false for label inside body object', () => {
      const err = makeError({ body: { label: 'AUTO_ORDER_NOT_FOUND' } });
      expect(isRetryableError(err)).toBe(false);
    });
  });

  describe('default behaviour (non-retryable)', () => {
    it('returns false for unknown errors (non-retryable by default)', () => {
      expect(isRetryableError(makeError({ message: 'some random error' }))).toBe(false);
    });

    it('handles non-Error values by stringifying (non-retryable)', () => {
      expect(isRetryableError('a plain string')).toBe(false);
      expect(isRetryableError(null)).toBe(false);
    });
  });
});

// ── withRetry ───────────────────────────────────────────────────────────────

describe('withRetry', () => {
  // Keep tests fast by overriding back-off timers
  const fastOptions = { baseDelayMs: 1, maxJitterMs: 0 };

  it('returns result on first successful call', async () => {
    const fn = jest.fn().mockResolvedValue('ok');
    const result = await withRetry(fn, fastOptions);
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries on a retryable error and succeeds', async () => {
    const fn = jest
      .fn()
      .mockRejectedValueOnce(makeError({ code: 'ECONNRESET' }))
      .mockResolvedValue('recovered');

    const result = await withRetry(fn, { ...fastOptions, maxRetries: 3 });
    expect(result).toBe('recovered');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('throws after exhausting maxRetries', async () => {
    const err = makeError({ code: 'ECONNRESET' });
    const fn = jest.fn().mockRejectedValue(err);

    await expect(
      withRetry(fn, { ...fastOptions, maxRetries: 2 }),
    ).rejects.toThrow('something went wrong');
    // 1 initial + 2 retries = 3 calls
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('does NOT retry non-retryable errors (4xx)', async () => {
    const err = makeError({ status: 400, message: 'Bad Request' });
    const fn = jest.fn().mockRejectedValue(err);

    await expect(withRetry(fn, fastOptions)).rejects.toThrow('Bad Request');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('throws immediately on stale-price errors (INVALID_PARAM_VALUE label)', async () => {
    const err = makeError({ label: 'INVALID_PARAM_VALUE', message: 'stale price' });
    const fn = jest.fn().mockRejectedValue(err);

    await expect(
      withRetry(fn, { ...fastOptions, maxRetries: 5 }),
    ).rejects.toThrow('stale price');
    // Should NOT retry — throw immediately
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('supports custom retryableCheck', async () => {
    const err = makeError({ code: 'ECONNRESET' });
    const fn = jest
      .fn()
      .mockRejectedValueOnce(err)
      .mockResolvedValue('ok');

    // Custom check that says ECONNRESET is NOT retryable
    const retryableCheck = jest.fn().mockReturnValue(false);

    await expect(
      withRetry(fn, { ...fastOptions, retryableCheck }),
    ).rejects.toThrow('something went wrong');
    expect(retryableCheck).toHaveBeenCalledWith(err);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('custom retryableCheck can allow retries for otherwise non-retryable errors', async () => {
    const err = makeError({ status: 400 });
    const fn = jest
      .fn()
      .mockRejectedValueOnce(err)
      .mockResolvedValue('forced');

    const retryableCheck = jest.fn().mockReturnValue(true);

    const result = await withRetry(fn, { ...fastOptions, retryableCheck });
    expect(result).toBe('forced');
    expect(fn).toHaveBeenCalledTimes(2);
  });
});

// ── buildHttpErrorDetails ───────────────────────────────────────────────────

describe('buildHttpErrorDetails', () => {
  it('extracts details from an axios-style error', () => {
    const err = makeError({
      message: 'Request failed with status code 400',
      response: { status: 400, data: { error: 'bad param' } },
      config: { method: 'post', url: '/api/v4/orders', data: '{"symbol":"BTC_USDT"}' },
    });

    const details = buildHttpErrorDetails(err);

    expect(details.message).toBe('Request failed with status code 400');
    expect(details.status).toBe(400);
    expect(details.method).toBe('POST');
    expect(details.path).toBe('/api/v4/orders');
    expect(details.requestBody).toEqual({ symbol: 'BTC_USDT' });
    expect(details.responseBody).toEqual({ error: 'bad param' });
  });

  it('extracts details from nested response.status', () => {
    const err = makeError({
      message: 'server error',
      response: { status: 503, data: { message: 'Service Unavailable' } },
    });

    const details = buildHttpErrorDetails(err);

    expect(details.status).toBe(503);
    expect(details.responseBody).toEqual({ message: 'Service Unavailable' });
  });

  it('returns minimal details for a plain Error object', () => {
    const err = new Error('oops');
    const details = buildHttpErrorDetails(err);

    expect(details.message).toBe('oops');
    expect(details.status).toBeUndefined();
    expect(details.responseBody).toBeUndefined();
    expect(details.method).toBeUndefined();
  });

  it('handles non-Error input', () => {
    const details = buildHttpErrorDetails('a string error');

    expect(details.message).toBe('a string error');
  });

  it('handles error with top-level status (Gate SDK style)', () => {
    const err = makeError({
      message: 'Bad Request',
      status: 400,
      label: 'INVALID_PARAM_VALUE',
    });

    const details = buildHttpErrorDetails(err);

    expect(details.status).toBe(400);
  });

  it('handles config.data that is already an object', () => {
    const err = makeError({
      config: { method: 'POST', data: { symbol: 'ETH_USDT' } },
    });

    const details = buildHttpErrorDetails(err);

    expect(details.requestBody).toEqual({ symbol: 'ETH_USDT' });
  });
});
