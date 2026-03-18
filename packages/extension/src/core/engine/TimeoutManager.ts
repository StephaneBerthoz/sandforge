/**
 * Error thrown when an operation exceeds its configured timeout.
 * Carries metadata about which operation timed out and the timeout duration.
 */
export class TimeoutError extends Error {
  /** Name of the operation that timed out */
  public readonly operation: string;
  /** Timeout duration in milliseconds */
  public readonly timeoutMs: number;

  constructor(operation: string, timeoutMs: number) {
    super(`Operation "${operation}" timed out after ${timeoutMs}ms`);
    this.name = 'TimeoutError';
    this.operation = operation;
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Wraps async operations with configurable timeouts using AbortController.
 * Provides a clean abort signal that the wrapped operation can observe
 * to cancel in-flight work when the timeout fires.
 */
export class TimeoutManager {
  private readonly defaultTimeoutMs: number;

  constructor(defaultTimeoutMs: number = 30_000) {
    this.defaultTimeoutMs = defaultTimeoutMs;
  }

  /**
   * Execute an async operation with a timeout.
   * The operation receives an AbortSignal it can observe for cancellation.
   * If the operation completes before the timeout, the result is returned.
   * If the timeout fires first, a TimeoutError is thrown and the signal is aborted.
   *
   * @param operation - Descriptive name for logging/error messages
   * @param fn - Async function to execute, receives AbortSignal
   * @param timeoutMs - Override timeout (uses default if not provided)
   */
  async withTimeout<T>(
    operation: string,
    fn: (signal: AbortSignal) => Promise<T>,
    timeoutMs?: number,
  ): Promise<T> {
    const timeout = timeoutMs ?? this.defaultTimeoutMs;
    const controller = new AbortController();

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        controller.abort();
        reject(new TimeoutError(operation, timeout));
      }, timeout);

      fn(controller.signal).then(
        (result) => {
          clearTimeout(timer);
          resolve(result);
        },
        (err) => {
          clearTimeout(timer);
          reject(err as Error);
        },
      );
    });
  }

  /** Get the configured default timeout in milliseconds */
  getDefaultTimeout(): number {
    return this.defaultTimeoutMs;
  }
}
