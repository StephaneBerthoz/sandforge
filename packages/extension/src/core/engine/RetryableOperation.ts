import { RetryStrategy, type RetryConfig, type RetryResult } from './RetryStrategy.js';
import { ErrorClassifier, type ClassifiedError } from './ErrorClassifier.js';
import type { SalesforceApiError } from '@sandforge/shared';

/** Options for configuring a RetryableOperation */
export interface RetryableOperationOptions {
  /** Partial override for retry strategy configuration */
  retryConfig?: Partial<RetryConfig>;
  /** Callback invoked before each retry attempt */
  onRetry?: (attempt: number, error: ClassifiedError, delay: number) => void;
}

/** Result of a batch execution with per-record retry */
export interface BatchResult<T> {
  successes: T[];
  failures: { record: T; error: SalesforceApiError }[];
}

/**
 * Combines RetryStrategy and ErrorClassifier into a single utility
 * that intelligently retries transient Salesforce errors and
 * distinguishes record-level vs connection-level failures.
 */
export class RetryableOperation {
  private readonly strategy: RetryStrategy;
  private readonly classifier: ErrorClassifier;

  constructor(private readonly options: RetryableOperationOptions = {}) {
    this.strategy = new RetryStrategy({
      ...options.retryConfig,
      jitter: options.retryConfig?.jitter ?? true,
    });
    this.classifier = new ErrorClassifier();
  }

  /**
   * Execute an async operation with automatic retry for transient errors.
   * Non-retryable errors cause immediate failure without further attempts.
   */
  async execute<T>(fn: () => Promise<T>): Promise<RetryResult<T>> {
    const config = this.strategy.getConfig();
    let lastError: Error | undefined;
    let totalDelay = 0;

    for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
      try {
        const result = await fn();
        return { success: true, result, attempts: attempt + 1, totalDelay };
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        const sfError = toSalesforceApiError(err);
        const classified = this.classifier.classify(sfError);

        if (!classified.classification.retryable) {
          return {
            success: false,
            error: lastError,
            attempts: attempt + 1,
            totalDelay,
          };
        }

        if (attempt < config.maxRetries) {
          const delay = this.strategy.calculateDelay(attempt);
          this.options.onRetry?.(attempt, classified, delay);
          totalDelay += delay;
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }

    return {
      success: false,
      error: lastError,
      attempts: config.maxRetries + 1,
      totalDelay,
    };
  }

  /**
   * Execute a batch operation with smart retry: only failed records with
   * retryable errors are retried, not the entire batch.
   * Connection-level errors (thrown by fn) cause full-batch retry.
   */
  async executeBatch<T>(
    records: T[],
    fn: (batch: T[]) => Promise<BatchResult<T>>,
  ): Promise<BatchResult<T>> {
    let remaining = [...records];
    const allSuccesses: T[] = [];
    const allFailures: { record: T; error: SalesforceApiError }[] = [];
    let attempts = 0;
    const maxAttempts = this.options.retryConfig?.maxRetries ?? 3;

    while (remaining.length > 0 && attempts <= maxAttempts) {
      const result = await fn(remaining);
      allSuccesses.push(...result.successes);

      const retryable: T[] = [];
      for (const f of result.failures) {
        const classified = this.classifier.classify(f.error);
        if (classified.classification.retryable && attempts < maxAttempts) {
          retryable.push(f.record);
        } else {
          allFailures.push(f);
        }
      }

      remaining = retryable;
      if (remaining.length > 0) {
        const initialDelay = this.options.retryConfig?.initialDelay ?? 1000;
        const maxDelay = this.options.retryConfig?.maxDelay ?? 30_000;
        const delay = initialDelay * Math.pow(2, attempts);
        await new Promise((r) => setTimeout(r, Math.min(delay, maxDelay)));
        attempts++;
      }
    }

    return { successes: allSuccesses, failures: allFailures };
  }

  /** Get the underlying ErrorClassifier instance */
  getClassifier(): ErrorClassifier {
    return this.classifier;
  }

  /** Get the underlying RetryStrategy instance */
  getStrategy(): RetryStrategy {
    return this.strategy;
  }
}

/**
 * Convert an unknown thrown value into a SalesforceApiError shape.
 * Extracts statusCode from common SF error patterns.
 */
function toSalesforceApiError(err: unknown): SalesforceApiError {
  if (
    typeof err === 'object' &&
    err !== null &&
    'statusCode' in err &&
    'message' in err
  ) {
    return err as SalesforceApiError;
  }
  const message = err instanceof Error ? err.message : String(err);
  return { statusCode: 'UNKNOWN_ERROR', message };
}
