/**
 * Normalize a raw trading-pair symbol into canonical BASE_USDT format.
 *
 * - Uppercases, trims whitespace
 * - Replaces `/` with `_`
 * - Strips leading `$`
 * - Ensures `_USDT` suffix
 */
export function normalizeSymbol(symbol: string): string {
  let s = String(symbol).toUpperCase().replace('/', '_').trim();
  s = s.replace(/^\$/, '');
  if (s.endsWith('_USDT')) return s;
  if (s.endsWith('USDT')) {
    const base = s.slice(0, -4).replace(/_+$/, '');
    return `${base}_USDT`;
  }
  return `${s}_USDT`;
}

/**
 * Normalize a symbol that is already in exchange BASE_QUOTE form (e.g. `BTC_USDT`):
 * trim whitespace and uppercase only. Does not rewrite separators, strip `$`,
 * or append a quote suffix.
 */
export function normalizeSymbolCase(symbol: string): string {
  return symbol.trim().toUpperCase();
}

/**
 * Null-safe variant of normalizeSymbol for untrusted input (e.g. AI output).
 * Returns null when input is null/undefined/empty/whitespace-only.
 */
export function normalizeSymbolOrNull(input: unknown): string | null {
  if (!input) return null;
  if (!String(input).trim()) return null;
  return normalizeSymbol(String(input));
}
