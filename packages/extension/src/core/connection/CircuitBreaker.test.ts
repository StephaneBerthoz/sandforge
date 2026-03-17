import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CircuitBreaker } from './CircuitBreaker';

describe('CircuitBreaker', () => {
  let breaker: CircuitBreaker;

  beforeEach(() => {
    vi.useFakeTimers();
    breaker = new CircuitBreaker({ failureThreshold: 3, resetTimeout: 10_000, halfOpenRequests: 1 });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('initial state', () => {
    it('should start in closed state', () => {
      expect(breaker.getState()).toBe('closed');
    });

    it('should allow execution when closed', () => {
      expect(breaker.canExecute()).toBe(true);
    });

    it('should have zero failure count', () => {
      expect(breaker.getFailureCount()).toBe(0);
    });
  });

  describe('default configuration', () => {
    it('should use default values when no config is provided', () => {
      const defaults = new CircuitBreaker();
      const config = defaults.getConfig();

      expect(config.failureThreshold).toBe(5);
      expect(config.resetTimeout).toBe(60_000);
      expect(config.halfOpenRequests).toBe(1);
    });

    it('should accept partial configuration overrides', () => {
      const config = breaker.getConfig();

      expect(config.failureThreshold).toBe(3);
      expect(config.resetTimeout).toBe(10_000);
      expect(config.halfOpenRequests).toBe(1);
    });
  });

  describe('failure tracking', () => {
    it('should increment failure count on each failure', () => {
      breaker.recordFailure();
      expect(breaker.getFailureCount()).toBe(1);

      breaker.recordFailure();
      expect(breaker.getFailureCount()).toBe(2);
    });

    it('should reset failure count on success', () => {
      breaker.recordFailure();
      breaker.recordFailure();
      breaker.recordSuccess();

      expect(breaker.getFailureCount()).toBe(0);
    });
  });

  describe('tripping', () => {
    it('should trip after reaching the failure threshold', () => {
      breaker.recordFailure();
      breaker.recordFailure();
      breaker.recordFailure();

      expect(breaker.getState()).toBe('open');
    });

    it('should not trip before reaching the threshold', () => {
      breaker.recordFailure();
      breaker.recordFailure();

      expect(breaker.getState()).toBe('closed');
    });

    it('should block execution when open', () => {
      breaker.recordFailure();
      breaker.recordFailure();
      breaker.recordFailure();

      expect(breaker.canExecute()).toBe(false);
    });
  });

  describe('half-open transition', () => {
    it('should transition to half_open after resetTimeout elapses', () => {
      breaker.recordFailure();
      breaker.recordFailure();
      breaker.recordFailure();
      expect(breaker.getState()).toBe('open');

      vi.advanceTimersByTime(10_000);

      expect(breaker.getState()).toBe('half_open');
    });

    it('should allow execution when half-open', () => {
      breaker.recordFailure();
      breaker.recordFailure();
      breaker.recordFailure();

      vi.advanceTimersByTime(10_000);

      expect(breaker.canExecute()).toBe(true);
    });

    it('should remain open before resetTimeout elapses', () => {
      breaker.recordFailure();
      breaker.recordFailure();
      breaker.recordFailure();

      vi.advanceTimersByTime(9_999);

      expect(breaker.getState()).toBe('open');
    });
  });

  describe('half-open recovery', () => {
    it('should close the circuit on success in half-open state', () => {
      breaker.recordFailure();
      breaker.recordFailure();
      breaker.recordFailure();

      vi.advanceTimersByTime(10_000);
      expect(breaker.getState()).toBe('half_open');

      breaker.recordSuccess();

      expect(breaker.getState()).toBe('closed');
      expect(breaker.getFailureCount()).toBe(0);
    });

    it('should re-trip on failure in half-open state', () => {
      breaker.recordFailure();
      breaker.recordFailure();
      breaker.recordFailure();

      vi.advanceTimersByTime(10_000);
      expect(breaker.getState()).toBe('half_open');

      breaker.recordFailure();

      expect(breaker.getState()).toBe('open');
    });
  });

  describe('half-open with multiple required successes', () => {
    it('should require multiple successes before closing', () => {
      const multi = new CircuitBreaker({
        failureThreshold: 2,
        resetTimeout: 5_000,
        halfOpenRequests: 3,
      });

      multi.recordFailure();
      multi.recordFailure();
      expect(multi.getState()).toBe('open');

      vi.advanceTimersByTime(5_000);
      expect(multi.getState()).toBe('half_open');

      multi.recordSuccess();
      expect(multi.getState()).toBe('half_open');

      multi.recordSuccess();
      expect(multi.getState()).toBe('half_open');

      multi.recordSuccess();
      expect(multi.getState()).toBe('closed');
    });
  });

  describe('half-open concurrency limiting', () => {
    it('should limit concurrent requests in half-open state via acquirePermit', () => {
      const multi = new CircuitBreaker({
        failureThreshold: 2,
        resetTimeout: 5_000,
        halfOpenRequests: 2,
      });

      multi.recordFailure();
      multi.recordFailure();
      expect(multi.getState()).toBe('open');

      vi.advanceTimersByTime(5_000);
      expect(multi.getState()).toBe('half_open');

      // First permit should succeed
      expect(multi.acquirePermit()).toBe(true);
      // Second permit should succeed (halfOpenRequests=2)
      expect(multi.acquirePermit()).toBe(true);
      // Third should be blocked
      expect(multi.acquirePermit()).toBe(false);
      expect(multi.canExecute()).toBe(false);
    });

    it('should release permits and allow new requests after success', () => {
      const multi = new CircuitBreaker({
        failureThreshold: 2,
        resetTimeout: 5_000,
        halfOpenRequests: 1,
      });

      multi.recordFailure();
      multi.recordFailure();
      vi.advanceTimersByTime(5_000);
      expect(multi.getState()).toBe('half_open');

      expect(multi.acquirePermit()).toBe(true);
      expect(multi.canExecute()).toBe(false); // in-flight = 1, limit = 1

      // Recording success decrements in-flight and closes circuit
      multi.recordSuccess();
      expect(multi.getState()).toBe('closed');
      expect(multi.canExecute()).toBe(true);
    });

    it('should reset halfOpenInFlight on manual reset', () => {
      breaker.recordFailure();
      breaker.recordFailure();
      breaker.recordFailure();
      vi.advanceTimersByTime(10_000);
      expect(breaker.getState()).toBe('half_open');

      breaker.acquirePermit();
      expect(breaker.canExecute()).toBe(false);

      breaker.reset();
      expect(breaker.canExecute()).toBe(true);
    });
  });

  describe('manual controls', () => {
    it('should allow manual trip', () => {
      breaker.trip();

      expect(breaker.getState()).toBe('open');
      expect(breaker.canExecute()).toBe(false);
    });

    it('should allow manual reset', () => {
      breaker.recordFailure();
      breaker.recordFailure();
      breaker.recordFailure();
      expect(breaker.getState()).toBe('open');

      breaker.reset();

      expect(breaker.getState()).toBe('closed');
      expect(breaker.getFailureCount()).toBe(0);
      expect(breaker.canExecute()).toBe(true);
    });
  });
});
