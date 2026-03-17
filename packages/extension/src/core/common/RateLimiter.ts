/**
 * Simple sliding-window rate limiter.
 * Tracks the number of actions within a time window and rejects
 * actions that exceed the configured maximum.
 */
export class RateLimiter {
  private readonly maxActions: number;
  private readonly windowMs: number;
  private readonly nowFn: () => number;
  private timestamps: number[] = [];

  /**
   * @param maxActions - Maximum number of actions allowed per window (clamped to >= 1)
   * @param windowMs - Time window in milliseconds (clamped to >= 100)
   * @param nowFn - Function returning current time in ms (default: Date.now)
   */
  constructor(
    maxActions: number,
    windowMs: number,
    nowFn: () => number = Date.now
  ) {
    this.maxActions = Math.max(1, maxActions);
    this.windowMs = Math.max(100, windowMs);
    this.nowFn = nowFn;
  }

  /**
   * Try to consume one action from the rate limiter.
   * @returns true if the action is allowed, false if rate limited
   */
  tryAcquire(): boolean {
    const now = this.nowFn();
    this.pruneExpired(now);

    if (this.timestamps.length >= this.maxActions) {
      return false;
    }

    this.timestamps.push(now);
    return true;
  }

  /** Get the number of remaining allowed actions in the current window. */
  get remaining(): number {
    this.pruneExpired(this.nowFn());
    return Math.max(0, this.maxActions - this.timestamps.length);
  }

  /** Reset the rate limiter, clearing all tracked actions. */
  reset(): void {
    this.timestamps = [];
  }

  /** Remove timestamps older than the current window. */
  private pruneExpired(now: number): void {
    const cutoff = now - this.windowMs;
    // Timestamps are in chronological order, so find the first valid one
    let firstValid = 0;
    while (firstValid < this.timestamps.length && this.timestamps[firstValid] <= cutoff) {
      firstValid++;
    }
    if (firstValid > 0) {
      this.timestamps = this.timestamps.slice(firstValid);
    }
  }
}
