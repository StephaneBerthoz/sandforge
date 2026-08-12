import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RetryableOperation } from './RetryableOperation';
import type { BatchResult } from './RetryableOperation';
import type { SalesforceApiError } from '@sandforge/shared';

function createSfError(
  statusCode: string,
  message: string = `Error: ${statusCode}`,
): SalesforceApiError {
  return { statusCode, message };
}

/**
 * A thrown error shaped exactly like jsforce's HttpApiError: the code lands on
 * `errorCode` and on `name`, and `statusCode` is never defined. Building the
 * error this way is the point of the test — every pre-existing case
 * constructed `{ statusCode }` by hand, which is a shape the Salesforce client
 * never actually throws, so the suite stayed green while no real error was
 * ever retried.
 */
function createJsforceError(errorCode: string, message = `Error: ${errorCode}`): Error {
  const err = new Error(message) as Error & { errorCode: string; data?: { fields?: string[] } };
  err.name = errorCode;
  err.errorCode = errorCode;
  return err;
}

describe('RetryableOperation', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('execute — errors as the Salesforce client actually throws them', () => {
    it('should retry UNABLE_TO_LOCK_ROW thrown with errorCode and no statusCode', async () => {
      const op = new RetryableOperation({ retryConfig: { jitter: false, maxRetries: 2 } });
      const fn = vi
        .fn()
        .mockRejectedValueOnce(createJsforceError('UNABLE_TO_LOCK_ROW'))
        .mockResolvedValue('ok');

      const promise = op.execute(fn);
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(fn).toHaveBeenCalledTimes(2);
      expect(result.success).toBe(true);
    });

    it('should retry REQUEST_LIMIT_EXCEEDED thrown with errorCode and no statusCode', async () => {
      const op = new RetryableOperation({ retryConfig: { jitter: false, maxRetries: 2 } });
      const fn = vi
        .fn()
        .mockRejectedValueOnce(createJsforceError('REQUEST_LIMIT_EXCEEDED'))
        .mockResolvedValue('ok');

      const promise = op.execute(fn);
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(fn).toHaveBeenCalledTimes(2);
      expect(result.success).toBe(true);
    });

    it('should still fail fast on a non-retryable errorCode', async () => {
      const op = new RetryableOperation({ retryConfig: { jitter: false, maxRetries: 3 } });
      const fn = vi.fn().mockRejectedValue(createJsforceError('INVALID_FIELD'));

      const promise = op.execute(fn);
      await vi.runAllTimersAsync();
      const result = await promise;

      // The widened normalization must not turn every failure into a retry.
      expect(fn).toHaveBeenCalledTimes(1);
      expect(result.success).toBe(false);
    });
  });

  describe('execute', () => {
    it('should succeed on first attempt without retrying', async () => {
      const op = new RetryableOperation({ retryConfig: { jitter: false } });
      const fn = vi.fn().mockResolvedValue('ok');

      const promise = op.execute(fn);
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result.success).toBe(true);
      expect(result.result).toBe('ok');
      expect(result.attempts).toBe(1);
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('should retry on retryable error and succeed on 2nd attempt', async () => {
      const op = new RetryableOperation({
        retryConfig: { maxRetries: 3, initialDelay: 100, jitter: false },
      });
      const sfErr = createSfError('UNABLE_TO_LOCK_ROW');
      const fn = vi.fn().mockRejectedValueOnce(sfErr).mockResolvedValue('recovered');

      const promise = op.execute(fn);
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result.success).toBe(true);
      expect(result.result).toBe('recovered');
      expect(result.attempts).toBe(2);
    });

    it('should fail immediately on non-retryable error', async () => {
      const op = new RetryableOperation({
        retryConfig: { maxRetries: 3, initialDelay: 100, jitter: false },
      });
      const sfErr = createSfError('INVALID_FIELD', 'Field does not exist');
      const fn = vi.fn().mockRejectedValue(sfErr);

      const promise = op.execute(fn);
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result.success).toBe(false);
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('should invoke onRetry callback with correct args', async () => {
      const onRetry = vi.fn();
      const op = new RetryableOperation({
        retryConfig: { maxRetries: 2, initialDelay: 100, jitter: false },
        onRetry,
      });
      const sfErr = createSfError('UNABLE_TO_LOCK_ROW');
      const fn = vi.fn().mockRejectedValueOnce(sfErr).mockResolvedValue('ok');

      const promise = op.execute(fn);
      await vi.runAllTimersAsync();
      await promise;

      expect(onRetry).toHaveBeenCalledTimes(1);
      expect(onRetry).toHaveBeenCalledWith(
        0,
        expect.objectContaining({
          classification: expect.objectContaining({ retryable: true }),
        }),
        expect.any(Number),
      );
    });

    it('should exhaust all retries for persistent retryable errors', async () => {
      const op = new RetryableOperation({
        retryConfig: { maxRetries: 2, initialDelay: 100, jitter: false },
      });
      const sfErr = createSfError('SERVER_UNAVAILABLE');
      const fn = vi.fn().mockRejectedValue(sfErr);

      const promise = op.execute(fn);
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result.success).toBe(false);
      expect(result.attempts).toBe(3);
      expect(fn).toHaveBeenCalledTimes(3);
    });
  });

  describe('executeBatch', () => {
    it('should retry only failed records with retryable errors', async () => {
      const op = new RetryableOperation({
        retryConfig: { maxRetries: 2, initialDelay: 100, jitter: false },
      });

      const records = [
        { id: '1', name: 'A' },
        { id: '2', name: 'B' },
        { id: '3', name: 'C' },
      ];

      const fn = vi
        .fn<(rs: typeof records) => Promise<BatchResult<(typeof records)[0]>>>()
        .mockImplementationOnce(async (batch) => ({
          successes: [batch[0]],
          failures: [
            { record: batch[1], error: createSfError('UNABLE_TO_LOCK_ROW') },
            { record: batch[2], error: createSfError('INVALID_FIELD') },
          ],
        }))
        .mockImplementationOnce(async (batch) => ({
          successes: batch.map((r) => r),
          failures: [],
        }));

      const promise = op.executeBatch(records, fn);
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result.successes).toHaveLength(2);
      expect(result.failures).toHaveLength(1);
      expect(result.failures[0].error.statusCode).toBe('INVALID_FIELD');
      expect(fn).toHaveBeenCalledTimes(2);
      expect(fn.mock.calls[1][0]).toHaveLength(1);
    });

    it('should respect maxRetries limit for batch operations', async () => {
      const op = new RetryableOperation({
        retryConfig: { maxRetries: 1, initialDelay: 50, jitter: false },
      });

      const records = [{ id: '1' }];
      const fn = vi.fn().mockResolvedValue({
        successes: [],
        failures: [{ record: records[0], error: createSfError('UNABLE_TO_LOCK_ROW') }],
      });

      const promise = op.executeBatch(records, fn);
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result.successes).toHaveLength(0);
      expect(result.failures).toHaveLength(1);
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it('should succeed immediately when all records pass on first try', async () => {
      const op = new RetryableOperation();
      const records = [{ id: '1' }, { id: '2' }];
      const fn = vi.fn().mockResolvedValue({
        successes: records,
        failures: [],
      });

      const promise = op.executeBatch(records, fn);
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result.successes).toHaveLength(2);
      expect(result.failures).toHaveLength(0);
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('should handle empty records array', async () => {
      const op = new RetryableOperation();
      const fn = vi.fn();

      const result = await op.executeBatch([], fn);

      expect(result.successes).toHaveLength(0);
      expect(result.failures).toHaveLength(0);
      expect(fn).not.toHaveBeenCalled();
    });
  });

  describe('getClassifier and getStrategy', () => {
    it('should expose underlying classifier and strategy', () => {
      const op = new RetryableOperation({ retryConfig: { maxRetries: 5 } });

      expect(op.getClassifier()).toBeDefined();
      expect(op.getStrategy()).toBeDefined();
      expect(op.getStrategy().getConfig().maxRetries).toBe(5);
    });
  });
});
