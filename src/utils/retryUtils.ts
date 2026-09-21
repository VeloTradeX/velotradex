import logger, { formatError } from './logger';

/**
 * Shared retry utilities for HTTP / exchange API calls.
 *
 * Extracted from GateIOExchange & TradFiRestClient to eliminate
 * duplicated retry loops across the codebase.
 */

// ── Constants ───────────────────────────────────────────────────────────────

/** Node.js / axios error.code values that are always retryable. */
const RETRYABLE_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
  'EHOSTUNREACH',
  'EADDRINFO',
  'ENETUNREACH',
]);

/** Sub-strings in error.message that are always retryable. */
const RETRYABLE_MESSAGES = [
  'socket hang up',
  'connect ETIMEDOUT',
  'connect ECONNREFUSED',
  'connect ECONNRESET',
  'not connected',
];

// ── Types ───────────────────────────────────────────────────────────────────

export interface RetryOptions {
  /** Maximum number of retries after the initial attempt (default 3). */
  maxRetries?: number;
  /** Base delay in ms for exponential back-off (default 1000). */
  baseDelayMs?: number;
  /** Extra delay ceiling in ms added as random jitter (default 500). */
  maxJitterMs?: number;
  /** Label used in log messages (e.g. the calling function name). */
  label?: string;
  /**
   * Optional override for retryable-check.
   * Return true to retry, false to re-throw immediately.
   * When omitted the built-in `isRetryableError` is used.
   */
  retryableCheck?: (error: unknown) => boolean;
}

// ── Public helpers ──────────────────────────────────────────────────────────

/**
 * Determines whether an error is transient and worth retrying.
 *
 * Decision order:
 *  1. Known error codes  (ECONNRESET, ETIMEDOUT …)
 *  2. Known error message substrings ("socket hang up" …)
 *  3. HTTP status 429 or 5xx  → retryable
 *  4. HTTP status 4xx         → NOT retryable
 *  5. Known label / identifier strings that are NOT retryable
 *  6. Default → retryable (conservative: prefer one extra attempt)
 */
export function isRetryableError(error: unknown): boolean {
  const e = normalizeError(error);

  // 1. Error code
  if (e.code && RETRYABLE_CODES.has(e.code)) return true;

  // 2. Message substrings
  if (e.message && RETRYABLE_MESSAGES.some((m) => e.message!.includes(m))) {
    return true;
  }

  // 3-4. HTTP status
  const status = extractStatus(e);
  if (status !== undefined) {
    if (status === 429) return true;              // rate-limited → retry
    if (status >= 500 && status < 600) return true; // server error → retry
    if (status >= 400 && status < 500) return false; // client error → no retry
  }

  // 5. Known non-retryable label patterns
  const label = extractLabel(e);
  if (label) {
    if (label.includes('AUTO_ORDER_NOT_FOUND')) return false;
    if (label.includes('INVALID_PARAM_VALUE')) return false;
  }

  // 6. Default — assume NON-retryable (safe for trading system)
  logger.debug(`[retryUtils] isRetryableError: unrecognized error, treating as non-retryable`, {
    label: extractLabel(e),
    message: e?.message || String(e),
  });
  return false;
}

/**
 * Runs `fn` with jittered exponential back-off.
 *
 * A "stale-price" error (INVALID_PARAM_VALUE label) always throws
 * immediately — callers are expected to refresh market data and
 * re-invoke manually.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const {
    maxRetries = 3,
    baseDelayMs = 1000,
    maxJitterMs = 500,
    label,
    retryableCheck = isRetryableError,
  } = options;

  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      // Stale-price → throw immediately, caller must refresh data
      if (isStalePriceError(error)) throw error;

      if (!retryableCheck(error)) throw error;

      if (attempt >= maxRetries) throw error;

      // Exponential back-off with jitter
      const delay =
        baseDelayMs * Math.pow(2, attempt) + Math.random() * maxJitterMs;

      logger.debug(
        `withRetry${label ? ` [${label}]` : ''}: attempt ${attempt + 1}/${maxRetries + 1} failed, retrying in ${Math.round(delay)}ms`,
        formatError(error, { attempt, delay }),
      );

      await sleep(delay);
    }
  }

  // Should be unreachable, but satisfies TypeScript
  throw lastError;
}

/**
 * Extracts structured HTTP details from an error object that may be
 * shaped like an axios error, a Gate SDK error, or a plain Error.
 */
export function buildHttpErrorDetails(error: unknown): Record<string, unknown> {
  const e = normalizeError(error);
  const status = extractStatus(e);

  const details: Record<string, unknown> = {};

  if (e.message) details.message = e.message;
  if (status !== undefined) details.status = status;

  // Axios-style: error.config.method / error.config.url
  const config = (error as any)?.config;
  if (config) {
    if (config.method) details.method = config.method.toUpperCase?.() ?? config.method;
    if (config.url) details.path = config.url;
    if (config.data) details.requestBody = tryParseJson(config.data);
  }

  // Nested response body
  const responseData = (error as any)?.response?.data ?? (error as any)?.data;
  if (responseData !== undefined) details.responseBody = responseData;

  return details;
}

// ── Private helpers ─────────────────────────────────────────────────────────

interface NormalizedError {
  message?: string;
  code?: string;
  label?: string;
  [key: string]: unknown;
}

function normalizeError(error: unknown): NormalizedError {
  if (error instanceof Error) {
    return error as unknown as NormalizedError;
  }
  if (typeof error === 'object' && error !== null) {
    return error as NormalizedError;
  }
  return { message: String(error) };
}

function extractStatus(e: NormalizedError): number | undefined {
  // error.status (Gate SDK / our own wrappers)
  if (typeof e.status === 'number') return e.status;
  // error.response.status (axios)
  const resp = (e as any).response;
  if (resp && typeof resp.status === 'number') return resp.status;
  return undefined;
}

function extractLabel(e: NormalizedError): string | undefined {
  if (typeof e.label === 'string') return e.label;
  // Some Gate SDK errors put label inside a body or detail
  const body = (e as any).body ?? (e as any).detail;
  if (body && typeof body.label === 'string') return body.label;
  return undefined;
}

function isStalePriceError(error: unknown): boolean {
  const e = normalizeError(error);
  const label = extractLabel(e);
  if (!label) return false;
  return label.includes('INVALID_PARAM_VALUE');
}

function tryParseJson(data: unknown): unknown {
  if (typeof data === 'string') {
    try {
      return JSON.parse(data);
    } catch {
      return data;
    }
  }
  return data;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
