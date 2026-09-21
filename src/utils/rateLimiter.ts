/**
 * Simple in-memory rate limiter.
 * Tracks request counts per key within a sliding time window.
 */
export class RateLimiter {
  private hits = new Map<string, number[]>();

  constructor(
    private maxHits: number,
    private windowMs: number,
  ) {}

  /**
   * Returns true if the key has exceeded the rate limit.
   */
  isLimited(key: string): boolean {
    const now = Date.now();
    const cutoff = now - this.windowMs;
    let timestamps = this.hits.get(key) || [];
    timestamps = timestamps.filter(t => t > cutoff);

    if (timestamps.length >= this.maxHits) {
      this.hits.set(key, timestamps);
      return true;
    }

    timestamps.push(now);
    this.hits.set(key, timestamps);
    return false;
  }
}
