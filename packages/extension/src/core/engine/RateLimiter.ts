/**
 * Sliding window rate limiter for Salesforce API calls.
 * Uses timestamp array instead of fixed window to prevent boundary bursts.
 */
export class RateLimiter {
  private timestamps: number[] = [];
  private maxRequestsPerWindow: number;
  private readonly windowMs: number;

  constructor(maxRequestsPerWindow: number = 100, windowMs: number = 60_000) {
    this.maxRequestsPerWindow = maxRequestsPerWindow;
    this.windowMs = windowMs;
  }

  private pruneExpired(): void {
    const cutoff = Date.now() - this.windowMs;
    while (this.timestamps.length > 0 && this.timestamps[0] <= cutoff) {
      this.timestamps.shift();
    }
  }

  /** Check if a request can proceed without exceeding the limit */
  canProceed(): boolean {
    this.pruneExpired();
    return this.timestamps.length < this.maxRequestsPerWindow;
  }

  /** Record that a request was made */
  recordRequest(): void {
    this.pruneExpired();
    this.timestamps.push(Date.now());
  }

  /** Get the number of remaining requests in the current window */
  getRemainingRequests(): number {
    this.pruneExpired();
    return Math.max(0, this.maxRequestsPerWindow - this.timestamps.length);
  }

  /** Get the current usage as a percentage (0-100) */
  getUsagePercent(): number {
    this.pruneExpired();
    if (this.maxRequestsPerWindow === 0) return 100;
    return (this.timestamps.length / this.maxRequestsPerWindow) * 100;
  }

  /** Get the time in milliseconds until the next slot opens */
  getTimeUntilReset(): number {
    this.pruneExpired();
    if (this.timestamps.length === 0) return 0;
    return Math.max(0, (this.timestamps[0] + this.windowMs) - Date.now());
  }

  /** Calculate the delay needed before the next request (0 if can proceed) */
  getDelay(): number {
    if (this.canProceed()) return 0;
    return this.getTimeUntilReset();
  }

  /** Wait until a request slot becomes available */
  async waitForSlot(): Promise<void> {
    const delay = this.getDelay();
    if (delay > 0) {
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  /** Reset the rate limiter to a fresh state */
  reset(): void {
    this.timestamps = [];
  }

  /** Update the maximum requests per window */
  updateLimits(maxRequests: number): void {
    this.maxRequestsPerWindow = maxRequests;
  }
}
