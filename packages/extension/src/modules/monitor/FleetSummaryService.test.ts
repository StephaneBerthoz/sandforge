/**
 * Plan 03-07 — FleetSummaryService unit tests.
 *
 * Coverage matrix (≥ 7 unit tests + 1 vertical-slice integration test in
 * task 03-07-08):
 *
 *   1. Pool reuse — pool.acquire called exactly once per org, never replaced.
 *   2. p-limit(3) caps concurrency — at most 3 in-flight at once.
 *   3. Cache hit within TTL — second call within 60s skips pool.acquire.
 *   4. Cache miss after TTL — second call after 61s re-fetches.
 *   5. Backoff on consecutive failures — 60 -> 120 -> 240s windows; cap at 600s.
 *   6. Stale flag set when backoff active.
 *   7. setVisibility(true) pauses the internal tick (no pool calls during the
 *      window even after the timer fires).
 *   8. dispose clears the timer + caches.
 *   9. getSummary returns the OrgFleetSummary shape (Zod-side spot check).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { AlertInstance, OrgFleetSummary, OrgHealthStatus } from '@sandforge/shared';

import { FleetSummaryService } from './FleetSummaryService.js';

// ─── Test doubles ────────────────────────────────────────────────────────────

interface PoolDouble {
  acquire: ReturnType<typeof vi.fn>;
  release: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
}

interface HealthDouble {
  computeHealth: ReturnType<typeof vi.fn>;
}

interface AlertDouble {
  getActiveAlerts: ReturnType<typeof vi.fn>;
}

function buildPool(opts?: { existingFor?: string[] }): PoolDouble {
  const existing = new Set(opts?.existingFor ?? []);
  return {
    acquire: vi.fn(),
    release: vi.fn(),
    get: vi.fn((orgId: string) =>
      existing.has(orgId)
        ? { orgId, instanceUrl: 'https://x', accessToken: 't', active: true }
        : undefined,
    ),
  };
}

function buildHealth(score = 90): HealthDouble {
  const status: OrgHealthStatus = {
    orgId: 'org-x',
    overall: 'healthy',
    apiLimitsStatus: score >= 85 ? 'ok' : 'warning',
    storageStatus: 'ok',
    activeJobs: 0,
    recentErrors: 0,
    lastChecked: new Date().toISOString(),
  };
  return {
    computeHealth: vi.fn(async () => status),
  };
}

function buildAlertEngine(alerts: AlertInstance[] = []): AlertDouble {
  return {
    getActiveAlerts: vi.fn(() => alerts),
  };
}

function buildBootstrap(): ReturnType<typeof vi.fn> {
  return vi.fn(async () => ({ instanceUrl: 'https://x', accessToken: 't' }));
}

describe('FleetSummaryService', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-04T10:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ─── Test 1 — Pool reuse ──────────────────────────────────────────────────
  it('Test 1 — pool.acquire is called exactly once per org', async () => {
    const pool = buildPool();
    const svc = new FleetSummaryService({
      pool: pool as never,
      healthCheck: buildHealth() as never,
      alertEngine: buildAlertEngine() as never,
      bootstrapConnection: buildBootstrap(),
    });
    const summaries = await svc.getSummary(['o1', 'o2']);
    expect(summaries).toHaveLength(2);
    expect(pool.acquire).toHaveBeenCalledTimes(2);
    expect(pool.acquire).toHaveBeenNthCalledWith(1, 'o1', 'https://x', 't');
    expect(pool.acquire).toHaveBeenNthCalledWith(2, 'o2', 'https://x', 't');
    expect(pool.release).toHaveBeenCalledTimes(2);
    svc.dispose();
  });

  // ─── Test 2 — p-limit caps concurrency ───────────────────────────────────
  it('Test 2 — p-limit(3) caps concurrent probes at 3', async () => {
    let inFlight = 0;
    let peak = 0;
    const pool = buildPool();
    const health = {
      computeHealth: vi.fn(async () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise<void>((resolve) => setTimeout(resolve, 50));
        inFlight--;
        return {
          orgId: 'o',
          overall: 'healthy',
          apiLimitsStatus: 'ok',
          storageStatus: 'ok',
          activeJobs: 0,
          recentErrors: 0,
          lastChecked: new Date().toISOString(),
        } as OrgHealthStatus;
      }),
    };
    const svc = new FleetSummaryService({
      pool: pool as never,
      healthCheck: health as never,
      alertEngine: buildAlertEngine() as never,
      bootstrapConnection: buildBootstrap(),
      maxConcurrent: 3,
    });
    const all = svc.getSummary(['a', 'b', 'c', 'd', 'e']);
    // Drive the fake-time wait the slow probes do.
    await vi.advanceTimersByTimeAsync(300);
    await all;
    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThan(0);
    svc.dispose();
  });

  // ─── Test 3 — Cache hit within TTL ────────────────────────────────────────
  it('Test 3 — second getSummary within TTL hits cache (no pool.acquire)', async () => {
    const pool = buildPool();
    const health = buildHealth();
    const svc = new FleetSummaryService({
      pool: pool as never,
      healthCheck: health as never,
      alertEngine: buildAlertEngine() as never,
      bootstrapConnection: buildBootstrap(),
      cacheTtlMs: 60_000,
    });
    await svc.getSummary(['o1']);
    expect(pool.acquire).toHaveBeenCalledTimes(1);
    // Advance only 30s — within TTL.
    vi.advanceTimersByTime(30_000);
    await svc.getSummary(['o1']);
    expect(pool.acquire).toHaveBeenCalledTimes(1);
    svc.dispose();
  });

  // ─── Test 4 — Cache miss after TTL ────────────────────────────────────────
  it('Test 4 — second getSummary after TTL re-fetches', async () => {
    const pool = buildPool();
    const svc = new FleetSummaryService({
      pool: pool as never,
      healthCheck: buildHealth() as never,
      alertEngine: buildAlertEngine() as never,
      bootstrapConnection: buildBootstrap(),
      cacheTtlMs: 60_000,
    });
    await svc.getSummary(['o1']);
    expect(pool.acquire).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(61_000);
    await svc.getSummary(['o1']);
    expect(pool.acquire).toHaveBeenCalledTimes(2);
    svc.dispose();
  });

  // ─── Test 5 — Backoff doubles on consecutive failures ────────────────────
  it('Test 5 — backoff doubles on consecutive failures and caps at 600s', async () => {
    const pool = buildPool();
    const health = {
      computeHealth: vi.fn(async () => {
        throw new Error('SF API down');
      }),
    };
    const svc = new FleetSummaryService({
      pool: pool as never,
      healthCheck: health as never,
      alertEngine: buildAlertEngine() as never,
      bootstrapConnection: buildBootstrap(),
      pollIntervalMs: 60_000,
      cacheTtlMs: 60_000,
      maxBackoffMs: 600_000,
    });
    const t0 = Date.now();
    // Failure 1 — backoff = 60s, nextPollAt = t0 + 60s.
    await svc.getSummary(['o1']);
    expect(svc.getFailureStreak('o1')).toBe(1);
    expect(svc.getNextPollAt('o1')).toBe(t0 + 60_000);
    // Within backoff window — should NOT re-fetch (acquire/computeHealth idle).
    const acquireCallsAfterFail1 = pool.acquire.mock.calls.length;
    vi.advanceTimersByTime(30_000);
    await svc.getSummary(['o1']);
    expect(pool.acquire.mock.calls.length).toBe(acquireCallsAfterFail1);
    // Past the backoff — failure 2 — backoff = 120s.
    vi.advanceTimersByTime(40_000);
    await svc.getSummary(['o1']);
    expect(svc.getFailureStreak('o1')).toBe(2);
    const t2 = Date.now();
    expect(svc.getNextPollAt('o1')).toBe(t2 + 120_000);
    // Past the 120s window — failure 3 — backoff = 240s.
    vi.advanceTimersByTime(121_000);
    await svc.getSummary(['o1']);
    expect(svc.getFailureStreak('o1')).toBe(3);
    const t3 = Date.now();
    expect(svc.getNextPollAt('o1')).toBe(t3 + 240_000);
    // Hammer through enough failures that the backoff WOULD exceed 600s — then
    // assert it caps at maxBackoffMs.
    for (let i = 0; i < 10; i++) {
      vi.advanceTimersByTime(700_000); // past any cap
      await svc.getSummary(['o1']);
    }
    const fails = svc.getFailureStreak('o1');
    const t4 = Date.now();
    const expectedBackoff = Math.min(60_000 * Math.pow(2, fails - 1), 600_000);
    expect(expectedBackoff).toBe(600_000);
    expect(svc.getNextPollAt('o1')).toBe(t4 + 600_000);
    svc.dispose();
  });

  // ─── Test 6 — Stale flag set when backoff active ─────────────────────────
  it('Test 6 — summary.stale === true after a failure', async () => {
    const pool = buildPool();
    let shouldFail = false;
    const health = {
      computeHealth: vi.fn(async () => {
        if (shouldFail) throw new Error('boom');
        return {
          orgId: 'o1',
          overall: 'healthy',
          apiLimitsStatus: 'ok',
          storageStatus: 'ok',
          activeJobs: 0,
          recentErrors: 0,
          lastChecked: new Date().toISOString(),
        } as OrgHealthStatus;
      }),
    };
    const svc = new FleetSummaryService({
      pool: pool as never,
      healthCheck: health as never,
      alertEngine: buildAlertEngine() as never,
      bootstrapConnection: buildBootstrap(),
      cacheTtlMs: 60_000,
    });
    // Prime cache with a successful summary.
    const okSummaries = await svc.getSummary(['o1']);
    expect(okSummaries[0]?.stale).toBe(false);
    // Now flip to failure mode + advance past TTL so the next call re-fetches.
    shouldFail = true;
    vi.advanceTimersByTime(61_000);
    const stale1 = await svc.getSummary(['o1']);
    expect(stale1[0]?.stale).toBe(true);
    // Subsequent call within backoff window also stale (from cache).
    const stale2 = await svc.getSummary(['o1']);
    expect(stale2[0]?.stale).toBe(true);
    svc.dispose();
  });

  // ─── Test 7 — setVisibility(true) pauses internal tick ───────────────────
  it('Test 7 — setVisibility(true) suppresses timer-driven refresh', async () => {
    const pool = buildPool();
    const svc = new FleetSummaryService({
      pool: pool as never,
      healthCheck: buildHealth() as never,
      alertEngine: buildAlertEngine() as never,
      bootstrapConnection: buildBootstrap(),
      pollIntervalMs: 60_000,
      cacheTtlMs: 50_000, // cache expires before the tick fires
    });
    // Prime cache so the tick has something to consider refreshing.
    await svc.getSummary(['o1']);
    expect(pool.acquire).toHaveBeenCalledTimes(1);
    // Hide + start the timer.
    svc.setVisibility(true);
    svc.start();
    // Even after multiple poll intervals, NO new pool acquisitions while hidden.
    await vi.advanceTimersByTimeAsync(300_000);
    expect(pool.acquire).toHaveBeenCalledTimes(1);
    svc.dispose();
  });

  // ─── Test 8 — dispose clears timer + caches ──────────────────────────────
  it('Test 8 — dispose stops the timer + clears caches', async () => {
    const pool = buildPool();
    const svc = new FleetSummaryService({
      pool: pool as never,
      healthCheck: buildHealth() as never,
      alertEngine: buildAlertEngine() as never,
      bootstrapConnection: buildBootstrap(),
      cacheTtlMs: 60_000,
    });
    await svc.getSummary(['o1']);
    expect(svc.cacheSize).toBe(1);
    svc.start();
    svc.dispose();
    expect(svc.cacheSize).toBe(0);
    // After dispose, no further timer-driven calls happen.
    const acquireCalls = pool.acquire.mock.calls.length;
    await vi.advanceTimersByTimeAsync(300_000);
    expect(pool.acquire.mock.calls.length).toBe(acquireCalls);
  });

  // ─── Test 9 — Returns OrgFleetSummary shape ──────────────────────────────
  it('Test 9 — getSummary returns the OrgFleetSummary shape', async () => {
    const pool = buildPool();
    const alerts: AlertInstance[] = [
      {
        id: 'al-1',
        definitionId: 'def-1',
        severity: 'warning',
        status: 'active',
        message: 'limits.api: usage is 95% (threshold 90)',
        currentValue: 95,
        threshold: 90,
        orgId: 'o1',
        triggeredAt: '2026-05-04T09:55:00.000Z',
      },
    ];
    const svc = new FleetSummaryService({
      pool: pool as never,
      healthCheck: buildHealth() as never,
      alertEngine: buildAlertEngine(alerts) as never,
      bootstrapConnection: buildBootstrap(),
      resolveOrgName: (orgId) => `Sandbox ${orgId}`,
    });
    const result = await svc.getSummary(['o1']);
    const summary = result[0]!;
    // Spot check every field of the OrgFleetSummary contract.
    expect(summary.orgId).toBe('o1');
    expect(summary.name).toBe('Sandbox o1');
    expect(typeof summary.healthScore).toBe('number');
    expect(summary.healthScore).toBeGreaterThanOrEqual(0);
    expect(summary.healthScore).toBeLessThanOrEqual(100);
    expect(typeof summary.lastUpdated).toBe('string');
    expect(summary.alertCount).toBe(1);
    expect(summary.recentAlerts).toHaveLength(1);
    expect(summary.recentAlerts[0]).toMatchObject({
      id: 'al-1',
      severity: 'warning',
      metric: 'limits.api',
      triggeredAt: '2026-05-04T09:55:00.000Z',
    });
    expect(summary.stale).toBe(false);
    // Sanity: shape matches the inferred TypeScript type.
    const _typecheck: OrgFleetSummary = summary;
    expect(_typecheck).toBeDefined();
    svc.dispose();
  });
});
