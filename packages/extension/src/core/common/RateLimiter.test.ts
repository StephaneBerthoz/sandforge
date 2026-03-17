import { describe, it, expect } from 'vitest';
import { RateLimiter } from './RateLimiter';

describe('RateLimiter', () => {
  describe('tryAcquire', () => {
    it('should allow actions within the limit', () => {
      const limiter = new RateLimiter(3, 1000);

      expect(limiter.tryAcquire()).toBe(true);
      expect(limiter.tryAcquire()).toBe(true);
      expect(limiter.tryAcquire()).toBe(true);
    });

    it('should reject actions exceeding the limit', () => {
      const limiter = new RateLimiter(2, 1000);

      expect(limiter.tryAcquire()).toBe(true);
      expect(limiter.tryAcquire()).toBe(true);
      expect(limiter.tryAcquire()).toBe(false);
    });

    it('should allow actions after the window expires', () => {
      let now = 1000;
      const limiter = new RateLimiter(2, 500, () => now);

      expect(limiter.tryAcquire()).toBe(true);
      expect(limiter.tryAcquire()).toBe(true);
      expect(limiter.tryAcquire()).toBe(false);

      now = 1600; // 600ms later, window is 500ms
      expect(limiter.tryAcquire()).toBe(true);
    });

    it('should prune old timestamps correctly', () => {
      let now = 0;
      const limiter = new RateLimiter(2, 1000, () => now);

      now = 100;
      limiter.tryAcquire();
      now = 300;
      limiter.tryAcquire();

      // Both used, should be at limit
      expect(limiter.tryAcquire()).toBe(false);

      // Move past first timestamp (100) but not second (300)
      // cutoff = 1150 - 1000 = 150, so 100 is pruned, 300 is not
      now = 1150;
      expect(limiter.tryAcquire()).toBe(true);
      // Second original timestamp (300) still valid, plus the one just added
      expect(limiter.tryAcquire()).toBe(false);

      // Move past second timestamp (300)
      // cutoff = 1350 - 1000 = 350, so 300 is pruned
      now = 1350;
      expect(limiter.tryAcquire()).toBe(true);
    });
  });

  describe('remaining', () => {
    it('should return full capacity initially', () => {
      const limiter = new RateLimiter(5, 1000);
      expect(limiter.remaining).toBe(5);
    });

    it('should decrease as actions are consumed', () => {
      const limiter = new RateLimiter(3, 1000);
      limiter.tryAcquire();
      expect(limiter.remaining).toBe(2);
      limiter.tryAcquire();
      expect(limiter.remaining).toBe(1);
      limiter.tryAcquire();
      expect(limiter.remaining).toBe(0);
    });
  });

  describe('reset', () => {
    it('should restore full capacity', () => {
      const limiter = new RateLimiter(2, 1000);
      limiter.tryAcquire();
      limiter.tryAcquire();
      expect(limiter.remaining).toBe(0);

      limiter.reset();
      expect(limiter.remaining).toBe(2);
    });
  });

  describe('constructor clamping', () => {
    it('should clamp maxActions to minimum 1', () => {
      const limiter = new RateLimiter(0, 1000);
      expect(limiter.tryAcquire()).toBe(true);
      expect(limiter.tryAcquire()).toBe(false);
    });

    it('should clamp windowMs to minimum 100', () => {
      let now = 0;
      const limiter = new RateLimiter(1, 10, () => now);
      limiter.tryAcquire();
      // Window should be 100ms minimum, not 10ms
      now = 50;
      expect(limiter.tryAcquire()).toBe(false);
      now = 110;
      expect(limiter.tryAcquire()).toBe(true);
    });
  });
});
