import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RetryStrategy } from './RetryStrategy';

describe('RetryStrategy', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('default configuration', () => {
    it('should use sensible defaults', () => {
      const strategy = new RetryStrategy();
      const config = strategy.getConfig();

      expect(config.maxRetries).toBe(3);
      expect(config.initialDelay).toBe(1000);
      expect(config.maxDelay).toBe(30_000);
      expect(config.backoffMultiplier).toBe(2);
      expect(config.jitter).toBe(true);
    });

    it('should accept partial config overrides', () => {
      const strategy = new RetryStrategy({ maxRetries: 5 });
      const config = strategy.getConfig();

      expect(config.maxRetries).toBe(5);
      expect(config.initialDelay).toBe(1000);
    });
  });

  describe('calculateDelay without jitter', () => {
    it('should return exponentially increasing delays', () => {
      const strategy = new RetryStrategy({
        initialDelay: 100,
        backoffMultiplier: 2,
        jitter: false,
        maxDelay: 10_000,
      });

      expect(strategy.calculateDelay(0)).toBe(100);
      expect(strategy.calculateDelay(1)).toBe(200);
      expect(strategy.calculateDelay(2)).toBe(400);
      expect(strategy.calculateDelay(3)).toBe(800);
    });

    it('should cap delay at maxDelay', () => {
      const strategy = new RetryStrategy({
        initialDelay: 1000,
        backoffMultiplier: 10,
        maxDelay: 5000,
        jitter: false,
      });

      expect(strategy.calculateDelay(0)).toBe(1000);
      expect(strategy.calculateDelay(1)).toBe(5000);
      expect(strategy.calculateDelay(5)).toBe(5000);
    });
  });

  describe('calculateDelay with jitter', () => {
    it('should return a value between 50% and 100% of the capped delay', () => {
      const strategy = new RetryStrategy({
        initialDelay: 100,
        backoffMultiplier: 2,
        jitter: true,
        maxDelay: 10_000,
      });

      vi.spyOn(Math, 'random').mockReturnValue(0.5);

      const delay = strategy.calculateDelay(0);
      expect(delay).toBeLessThanOrEqual(100);
      expect(delay).toBeGreaterThanOrEqual(50);

      vi.restoreAllMocks();
    });

    it('should always produce delay >= 50% of capped value (equal jitter)', () => {
      const strategy = new RetryStrategy({
        initialDelay: 200,
        backoffMultiplier: 2,
        jitter: true,
        maxDelay: 10_000,
      });

      // With random = 0, delay should be exactly 50% of capped
      vi.spyOn(Math, 'random').mockReturnValue(0);
      const minDelay = strategy.calculateDelay(0); // capped = 200, half = 100
      expect(minDelay).toBe(100);

      // With random = 1 (just under), delay should be close to 100% of capped
      vi.spyOn(Math, 'random').mockReturnValue(0.99999);
      const maxDelay = strategy.calculateDelay(0);
      expect(maxDelay).toBeGreaterThanOrEqual(100);
      expect(maxDelay).toBeLessThanOrEqual(200);

      vi.restoreAllMocks();
    });
  });

  describe('execute - success on first attempt', () => {
    it('should return success with 1 attempt', async () => {
      const strategy = new RetryStrategy({ jitter: false });
      const fn = vi.fn().mockResolvedValue('ok');

      const resultPromise = strategy.execute(fn);
      await vi.runAllTimersAsync();
      const result = await resultPromise;

      expect(result.success).toBe(true);
      expect(result.result).toBe('ok');
      expect(result.attempts).toBe(1);
      expect(result.totalDelay).toBe(0);
    });
  });

  describe('execute - success after retries', () => {
    it('should retry and eventually succeed', async () => {
      const strategy = new RetryStrategy({
        maxRetries: 3,
        initialDelay: 100,
        jitter: false,
      });

      const fn = vi
        .fn()
        .mockRejectedValueOnce(new Error('fail 1'))
        .mockRejectedValueOnce(new Error('fail 2'))
        .mockResolvedValue('recovered');

      const resultPromise = strategy.execute(fn);
      await vi.runAllTimersAsync();
      const result = await resultPromise;

      expect(result.success).toBe(true);
      expect(result.result).toBe('recovered');
      expect(result.attempts).toBe(3);
      expect(fn).toHaveBeenCalledTimes(3);
    });
  });

  describe('execute - exhausts all retries', () => {
    it('should return failure after max retries', async () => {
      const strategy = new RetryStrategy({
        maxRetries: 2,
        initialDelay: 100,
        jitter: false,
      });

      const fn = vi.fn().mockRejectedValue(new Error('persistent'));

      const resultPromise = strategy.execute(fn);
      await vi.runAllTimersAsync();
      const result = await resultPromise;

      expect(result.success).toBe(false);
      expect(result.error?.message).toBe('persistent');
      expect(result.attempts).toBe(3);
      expect(fn).toHaveBeenCalledTimes(3);
    });
  });

  describe('execute - non-Error thrown', () => {
    it('should wrap non-Error values in an Error', async () => {
      const strategy = new RetryStrategy({
        maxRetries: 0,
        jitter: false,
      });

      const fn = vi.fn().mockRejectedValue('string error');

      const resultPromise = strategy.execute(fn);
      await vi.runAllTimersAsync();
      const result = await resultPromise;

      expect(result.success).toBe(false);
      expect(result.error?.message).toBe('string error');
    });
  });

  describe('shouldRetry', () => {
    it('should return true when attempts remain', () => {
      const strategy = new RetryStrategy({ maxRetries: 3 });

      expect(strategy.shouldRetry(0)).toBe(true);
      expect(strategy.shouldRetry(1)).toBe(true);
      expect(strategy.shouldRetry(2)).toBe(true);
    });

    it('should return false when max retries reached', () => {
      const strategy = new RetryStrategy({ maxRetries: 3 });

      expect(strategy.shouldRetry(3)).toBe(false);
      expect(strategy.shouldRetry(4)).toBe(false);
    });
  });

  describe('getConfig immutability', () => {
    it('should return a copy that does not affect internal state', () => {
      const strategy = new RetryStrategy({ maxRetries: 5 });
      const config = strategy.getConfig();

      // Cast via unknown: Readonly<RetryConfig> has a boolean field, so it doesn't overlap Record<string, number>
      (config as unknown as Record<string, number>).maxRetries = 99;

      expect(strategy.getConfig().maxRetries).toBe(5);
    });
  });
});
