import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TimeoutManager, TimeoutError } from './TimeoutManager';

describe('TimeoutManager', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('withTimeout - success', () => {
    it('should return result when operation completes before timeout', async () => {
      const manager = new TimeoutManager(5000);

      const promise = manager.withTimeout('test-op', async () => {
        return 'done';
      });

      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result).toBe('done');
    });

    it('should pass AbortSignal to the operation', async () => {
      const manager = new TimeoutManager(5000);
      let receivedSignal: AbortSignal | undefined;

      const promise = manager.withTimeout('test-op', async (signal) => {
        receivedSignal = signal;
        return 'ok';
      });

      await vi.runAllTimersAsync();
      await promise;

      expect(receivedSignal).toBeDefined();
      expect(receivedSignal?.aborted).toBe(false);
    });
  });

  describe('withTimeout - timeout', () => {
    it('should throw TimeoutError when operation exceeds timeout', async () => {
      const manager = new TimeoutManager(100);
      let caughtError: unknown;

      const promise = manager.withTimeout('slow-op', async () => {
        await new Promise((r) => setTimeout(r, 10_000));
        return 'never';
      });

      // Attach a catch handler immediately to prevent unhandled rejection
      const handledPromise = promise.catch((err) => {
        caughtError = err;
      });

      await vi.advanceTimersByTimeAsync(150);
      await handledPromise;

      expect(caughtError).toBeInstanceOf(TimeoutError);
      expect((caughtError as TimeoutError).message).toBe(
        'Operation "slow-op" timed out after 100ms',
      );
    });

    it('should abort the signal when timeout fires', async () => {
      const manager = new TimeoutManager(100);
      let capturedSignal: AbortSignal | undefined;

      const promise = manager.withTimeout('abort-test', async (signal) => {
        capturedSignal = signal;
        await new Promise((r) => setTimeout(r, 10_000));
        return 'never';
      });

      const handledPromise = promise.catch(() => {
        // Expected timeout
      });

      await vi.advanceTimersByTimeAsync(150);
      await handledPromise;

      expect(capturedSignal?.aborted).toBe(true);
    });
  });

  describe('TimeoutError properties', () => {
    it('should carry operation name and timeoutMs', () => {
      const error = new TimeoutError('describe-global', 30_000);

      expect(error.name).toBe('TimeoutError');
      expect(error.operation).toBe('describe-global');
      expect(error.timeoutMs).toBe(30_000);
      expect(error.message).toBe('Operation "describe-global" timed out after 30000ms');
    });

    it('should be an instance of Error', () => {
      const error = new TimeoutError('test', 1000);
      expect(error).toBeInstanceOf(Error);
    });
  });

  describe('custom vs default timeout', () => {
    it('should use custom timeout when provided', async () => {
      const manager = new TimeoutManager(60_000);
      let caughtError: unknown;

      const promise = manager.withTimeout(
        'custom-timeout',
        async () => {
          await new Promise((r) => setTimeout(r, 10_000));
          return 'never';
        },
        200,
      );

      const handledPromise = promise.catch((err) => {
        caughtError = err;
      });

      await vi.advanceTimersByTimeAsync(250);
      await handledPromise;

      expect(caughtError).toBeInstanceOf(TimeoutError);
      expect((caughtError as TimeoutError).timeoutMs).toBe(200);
    });

    it('should fall back to default timeout when none provided', async () => {
      const manager = new TimeoutManager(150);
      let caughtError: unknown;

      const promise = manager.withTimeout('default-timeout', async () => {
        await new Promise((r) => setTimeout(r, 10_000));
        return 'never';
      });

      const handledPromise = promise.catch((err) => {
        caughtError = err;
      });

      await vi.advanceTimersByTimeAsync(200);
      await handledPromise;

      expect(caughtError).toBeInstanceOf(TimeoutError);
      expect((caughtError as TimeoutError).timeoutMs).toBe(150);
    });
  });

  describe('getDefaultTimeout', () => {
    it('should return the configured default', () => {
      const manager = new TimeoutManager(45_000);
      expect(manager.getDefaultTimeout()).toBe(45_000);
    });

    it('should default to 30000ms', () => {
      const manager = new TimeoutManager();
      expect(manager.getDefaultTimeout()).toBe(30_000);
    });
  });
});
