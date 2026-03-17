/** Configuration for the retry strategy */
export interface RetryConfig {
  maxRetries: number;
  initialDelay: number;
  maxDelay: number;
  backoffMultiplier: number;
  jitter: boolean;
}

/** Result of executing a function with retry logic */
export interface RetryResult<T> {
  success: boolean;
  result?: T;
  error?: Error;
  attempts: number;
  totalDelay: number;
}

/**
 * Implements exponential backoff retry with optional jitter.
 * Used to handle transient Salesforce API failures gracefully.
 */
export class RetryStrategy {
  private readonly config: RetryConfig;

  constructor(config?: Partial<RetryConfig>) {
    this.config = {
      maxRetries: config?.maxRetries ?? 3,
      initialDelay: config?.initialDelay ?? 1000,
      maxDelay: config?.maxDelay ?? 30_000,
      backoffMultiplier: config?.backoffMultiplier ?? 2,
      jitter: config?.jitter ?? true,
    };
  }

  /** Calculate the delay for a given attempt number (0-based) */
  calculateDelay(attempt: number): number {
    const baseDelay =
      this.config.initialDelay *
      Math.pow(this.config.backoffMultiplier, attempt);
    const capped = Math.min(baseDelay, this.config.maxDelay);
    if (!this.config.jitter) return capped;
    const half = capped / 2;
    return Math.floor(half + Math.random() * half);
  }

  /** Execute a function with automatic retry on failure */
  async execute<T>(fn: () => Promise<T>): Promise<RetryResult<T>> {
    let lastError: Error | undefined;
    let totalDelay = 0;

    for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      try {
        const result = await fn();
        return { success: true, result, attempts: attempt + 1, totalDelay };
      } catch (err) {
        lastError =
          err instanceof Error ? err : new Error(String(err));
        if (attempt < this.config.maxRetries) {
          const delay = this.calculateDelay(attempt);
          totalDelay += delay;
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }

    return {
      success: false,
      error: lastError,
      attempts: this.config.maxRetries + 1,
      totalDelay,
    };
  }

  /** Check if more retries are available for the given attempt count */
  shouldRetry(currentAttempt: number): boolean {
    return currentAttempt < this.config.maxRetries;
  }

  /** Get a read-only copy of the retry configuration */
  getConfig(): Readonly<RetryConfig> {
    return { ...this.config };
  }
}
