import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RateLimiter } from './RateLimiter';

describe('RateLimiter', () => {
  let limiter: RateLimiter;

  beforeEach(() => {
    vi.useFakeTimers();
    limiter = new RateLimiter(5, 10_000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('canProceed', () => {
    it('should allow requests when under the limit', () => {
      expect(limiter.canProceed()).toBe(true);
    });

    it('should block requests when at the limit', () => {
      for (let i = 0; i < 5; i++) {
        limiter.recordRequest();
      }
      expect(limiter.canProceed()).toBe(false);
    });
  });

  describe('recordRequest', () => {
    it('should decrement remaining requests', () => {
      limiter.recordRequest();
      expect(limiter.getRemainingRequests()).toBe(4);
    });

    it('should track multiple requests', () => {
      limiter.recordRequest();
      limiter.recordRequest();
      limiter.recordRequest();
      expect(limiter.getRemainingRequests()).toBe(2);
    });
  });

  describe('getRemainingRequests', () => {
    it('should return full capacity initially', () => {
      expect(limiter.getRemainingRequests()).toBe(5);
    });

    it('should never return negative values', () => {
      for (let i = 0; i < 10; i++) {
        limiter.recordRequest();
      }
      expect(limiter.getRemainingRequests()).toBe(0);
    });
  });

  describe('getUsagePercent', () => {
    it('should return 0 when no requests have been made', () => {
      expect(limiter.getUsagePercent()).toBe(0);
    });

    it('should return 100 when fully used', () => {
      for (let i = 0; i < 5; i++) {
        limiter.recordRequest();
      }
      expect(limiter.getUsagePercent()).toBe(100);
    });

    it('should return proportional value', () => {
      limiter.recordRequest();
      expect(limiter.getUsagePercent()).toBe(20);
    });
  });

  describe('sliding window behavior', () => {
    it('should expire old requests as they age out of the window', () => {
      // Record 5 requests at t=0
      for (let i = 0; i < 5; i++) {
        limiter.recordRequest();
      }
      expect(limiter.canProceed()).toBe(false);

      // Advance past the window — all 5 should expire
      vi.advanceTimersByTime(10_001);

      expect(limiter.canProceed()).toBe(true);
      expect(limiter.getRemainingRequests()).toBe(5);
    });

    it('should not expire requests before window elapses', () => {
      for (let i = 0; i < 5; i++) {
        limiter.recordRequest();
      }

      vi.advanceTimersByTime(9_999);

      expect(limiter.canProceed()).toBe(false);
    });

    it('should allow staggered requests to expire individually', () => {
      // Record 3 requests at t=0
      limiter.recordRequest();
      limiter.recordRequest();
      limiter.recordRequest();

      // Advance 5s and record 2 more
      vi.advanceTimersByTime(5_000);
      limiter.recordRequest();
      limiter.recordRequest();
      expect(limiter.canProceed()).toBe(false);

      // Advance 5001ms more — first 3 should expire (they are now >10s old)
      vi.advanceTimersByTime(5_001);
      expect(limiter.getRemainingRequests()).toBe(3);
      expect(limiter.canProceed()).toBe(true);
    });
  });

  describe('getTimeUntilReset', () => {
    it('should return 0 when no requests have been made', () => {
      expect(limiter.getTimeUntilReset()).toBe(0);
    });

    it('should return time until oldest request expires', () => {
      limiter.recordRequest();
      vi.advanceTimersByTime(3_000);
      // Oldest request was at t=0, so it expires at t=10000 => 7000ms remaining
      expect(limiter.getTimeUntilReset()).toBe(7_000);
    });
  });

  describe('getDelay', () => {
    it('should return 0 when requests are available', () => {
      expect(limiter.getDelay()).toBe(0);
    });

    it('should return time until next slot when at limit', () => {
      for (let i = 0; i < 5; i++) {
        limiter.recordRequest();
      }

      vi.advanceTimersByTime(3_000);

      expect(limiter.getDelay()).toBe(7_000);
    });
  });

  describe('waitForSlot', () => {
    it('should resolve immediately when under limit', async () => {
      await limiter.waitForSlot();
      expect(limiter.canProceed()).toBe(true);
    });

    it('should wait when at limit', async () => {
      for (let i = 0; i < 5; i++) {
        limiter.recordRequest();
      }

      const promise = limiter.waitForSlot();
      vi.advanceTimersByTime(10_001);
      await promise;

      expect(limiter.canProceed()).toBe(true);
    });
  });

  describe('reset', () => {
    it('should clear all tracked requests', () => {
      for (let i = 0; i < 5; i++) {
        limiter.recordRequest();
      }
      expect(limiter.canProceed()).toBe(false);

      limiter.reset();

      expect(limiter.canProceed()).toBe(true);
      expect(limiter.getRemainingRequests()).toBe(5);
    });
  });

  describe('updateLimits', () => {
    it('should change the max requests per window', () => {
      limiter.updateLimits(10);
      for (let i = 0; i < 7; i++) {
        limiter.recordRequest();
      }
      expect(limiter.canProceed()).toBe(true);
      expect(limiter.getRemainingRequests()).toBe(3);
    });

    it('should immediately block if new limit is lower than current count', () => {
      for (let i = 0; i < 3; i++) {
        limiter.recordRequest();
      }
      limiter.updateLimits(2);
      expect(limiter.canProceed()).toBe(false);
    });
  });

  describe('default configuration', () => {
    it('should default to 100 requests per 60s window', () => {
      const defaultLimiter = new RateLimiter();
      expect(defaultLimiter.getRemainingRequests()).toBe(100);
    });
  });
});
