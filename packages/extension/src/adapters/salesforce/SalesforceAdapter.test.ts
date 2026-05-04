import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { StorageAdapter } from '../storage/StorageAdapter.js';
import type { TelemetryAdapter } from '../telemetry/TelemetryAdapter.js';
import { SalesforceAdapter } from './SalesforceAdapter.js';

function fakeStorage(): StorageAdapter {
  return {} as unknown as StorageAdapter;
}

function fakeTelemetry(): TelemetryAdapter & { addBreadcrumb: ReturnType<typeof vi.fn> } {
  const addBreadcrumb = vi.fn();
  return {
    addBreadcrumb,
    captureException: vi.fn(),
    getLogger: vi.fn(),
    setUser: vi.fn(),
    flush: vi.fn(),
    isEnabled: vi.fn(() => false),
  } as unknown as TelemetryAdapter & { addBreadcrumb: ReturnType<typeof vi.fn> };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('SalesforceAdapter', () => {
  let telemetry: ReturnType<typeof fakeTelemetry>;

  beforeEach(() => {
    telemetry = fakeTelemetry();
  });

  describe('withLimit concurrency', () => {
    it('respects the concurrency cap (8 by default, custom values honored)', async () => {
      const adapter = new SalesforceAdapter(fakeStorage(), telemetry, {
        concurrency: 3,
        retries: 0,
      });

      let inFlight = 0;
      let maxInFlight = 0;
      const tasks = Array.from({ length: 9 }, (_, i) =>
        adapter.withLimit(async () => {
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await sleep(20);
          inFlight -= 1;
          return i;
        }),
      );

      const results = await Promise.all(tasks);
      expect(results).toHaveLength(9);
      expect(maxInFlight).toBeLessThanOrEqual(3);
      expect(maxInFlight).toBeGreaterThan(1);
    });
  });

  describe('withLimit retries', () => {
    it('retries up to `retries` times on 500 errors and eventually throws', async () => {
      const adapter = new SalesforceAdapter(fakeStorage(), telemetry, {
        retries: 3,
        minTimeout: 1,
        maxTimeout: 5,
      });

      const fn = vi.fn(async () => {
        const err = Object.assign(new Error('server'), { statusCode: 500 });
        throw err;
      });

      await expect(adapter.withLimit(fn)).rejects.toThrow(/server/);
      // 1 initial + 3 retries = 4 attempts
      expect(fn).toHaveBeenCalledTimes(4);
    });

    it('does NOT retry on 400 errors (non-retriable)', async () => {
      const adapter = new SalesforceAdapter(fakeStorage(), telemetry, {
        retries: 5,
        minTimeout: 1,
        maxTimeout: 5,
      });

      const fn = vi.fn(async () => {
        const err = Object.assign(new Error('bad request'), { statusCode: 400 });
        throw err;
      });

      await expect(adapter.withLimit(fn)).rejects.toThrow(/bad request/);
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('honors Retry-After by sleeping at least that long before the next attempt', async () => {
      const adapter = new SalesforceAdapter(fakeStorage(), telemetry, {
        retries: 1,
        minTimeout: 1,
        maxTimeout: 5,
      });

      let attempt = 0;
      const attemptTimes: number[] = [];
      const fn = vi.fn(async () => {
        attemptTimes.push(Date.now());
        attempt += 1;
        if (attempt === 1) {
          const err = Object.assign(new Error('rate-limited'), {
            statusCode: 429,
            retryAfter: 0.2,
          });
          throw err;
        }
        return 'ok';
      });

      const start = Date.now();
      const result = await adapter.withLimit(fn, { category: 'query' });
      const elapsed = Date.now() - start;

      expect(result).toBe('ok');
      expect(elapsed).toBeGreaterThanOrEqual(180);
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it('emits a telemetry breadcrumb on every retry with the category tag', async () => {
      const adapter = new SalesforceAdapter(fakeStorage(), telemetry, {
        retries: 2,
        minTimeout: 1,
        maxTimeout: 5,
      });

      let attempt = 0;
      const fn = vi.fn(async () => {
        attempt += 1;
        if (attempt < 3) {
          const err = Object.assign(new Error('ratelimit'), { statusCode: 429 });
          throw err;
        }
        return 'done';
      });

      await adapter.withLimit(fn, { category: 'limits' });

      // Two breadcrumbs for the two failed attempts.
      expect(telemetry.addBreadcrumb).toHaveBeenCalledTimes(2);
      const firstCall = telemetry.addBreadcrumb.mock.calls[0];
      expect(firstCall[0]).toContain('salesforce-retry');
      expect(firstCall[0]).toContain('status=429');
      expect(firstCall[0]).toContain('category=limits');
      expect(firstCall[1]).toBe('salesforce');
      expect(firstCall[2]).toBe('warning');
    });
  });

  describe('withLimit AbortSignal', () => {
    it('throws immediately if the signal is already aborted', async () => {
      const adapter = new SalesforceAdapter(fakeStorage(), telemetry, { retries: 3 });
      const controller = new AbortController();
      controller.abort(new Error('user-cancelled'));

      const fn = vi.fn(async () => 'should-not-run');
      await expect(adapter.withLimit(fn, { signal: controller.signal })).rejects.toThrow(
        /user-cancelled|aborted/,
      );
      expect(fn).not.toHaveBeenCalled();
    });

    it('stops retrying when the signal aborts between attempts', async () => {
      const adapter = new SalesforceAdapter(fakeStorage(), telemetry, {
        retries: 5,
        minTimeout: 30,
        maxTimeout: 50,
      });
      const controller = new AbortController();

      let attempt = 0;
      const fn = vi.fn(async () => {
        attempt += 1;
        if (attempt === 1) {
          // Abort after the first failure — the retry delay is ~30ms, so this fires first.
          setTimeout(() => controller.abort(new Error('stop')), 5);
        }
        const err = Object.assign(new Error('ratelimit'), { statusCode: 429 });
        throw err;
      });

      await expect(adapter.withLimit(fn, { signal: controller.signal })).rejects.toThrow(
        /stop|aborted/,
      );
      expect(attempt).toBeLessThan(5);
    });
  });

  describe('checkLimits + shouldPauseNonEssential', () => {
    it('computes pct from Max - Remaining and caches the snapshot', async () => {
      const adapter = new SalesforceAdapter(fakeStorage(), telemetry);

      const conn = {
        limits: async () => ({
          DAILY_API_REQUESTS: { Max: 100_000, Remaining: 60_000 },
        }),
      };

      const snapshot = await adapter.checkLimits(conn);
      expect(snapshot.daily).toBe(100_000);
      expect(snapshot.pct).toBeCloseTo(0.4, 3);
    });

    it('shouldPauseNonEssential is true when pct >= 0.8 threshold', async () => {
      const adapter = new SalesforceAdapter(fakeStorage(), telemetry);

      const conn = {
        limits: async () => ({
          DAILY_API_REQUESTS: { Max: 100_000, Remaining: 10_000 }, // 90% used
        }),
      };

      await adapter.checkLimits(conn);
      expect(adapter.shouldPauseNonEssential()).toBe(true);
      expect(telemetry.addBreadcrumb).toHaveBeenCalledWith(
        expect.stringContaining('api-usage-high'),
        'salesforce',
        'warning',
      );
    });

    it('shouldPauseNonEssential is false when pct < threshold', async () => {
      const adapter = new SalesforceAdapter(fakeStorage(), telemetry);
      const conn = {
        limits: async () => ({ DAILY_API_REQUESTS: { Max: 100_000, Remaining: 70_000 } }),
      };
      await adapter.checkLimits(conn);
      expect(adapter.shouldPauseNonEssential()).toBe(false);
    });

    it('shouldPauseNonEssential returns false when no snapshot has been taken', () => {
      const adapter = new SalesforceAdapter(fakeStorage(), telemetry);
      expect(adapter.shouldPauseNonEssential()).toBe(false);
    });
  });
});
