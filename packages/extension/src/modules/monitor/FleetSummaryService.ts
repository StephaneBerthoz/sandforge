/**
 * Phase 03 Plan 03-07 — FleetSummaryService.
 *
 * Backend half of the multi-org overview. Exposes {@link getSummary} as the
 * canonical entry point used by the (Phase 06) bridge handler:
 *
 *   1. {@link ConnectionPool} reuse — never `new jsforce.Connection()` per
 *      RESEARCH §3 P-03.5.
 *   2. {@link pLimit} caps concurrent org probes (default 3) — same upper
 *      bound as `sandforge.sync.maxConcurrentOps`.
 *   3. 60s per-org cache + per-org backoff (60 -> 120 -> 240 -> 480 -> 600 cap)
 *      on consecutive failures (P-03.5).
 *   4. Visibility-gated polling via {@link setVisibility} — pauses the
 *      internal 60s tick while `document.hidden` (audit M1).
 *
 * Note: this service exposes the cache/backoff machinery; the public
 * {@link getSummary} method is invoked by the bridge handler that the Phase 06
 * BP-01 wiring will plumb into `MonitorOpsHandler`. Internal `start()` and
 * `tickIfVisible()` are kept tight + composable so the same instance can be
 * re-used by the request path AND the timer-driven refresh.
 */

import pLimit from 'p-limit';

import type { OrgFleetSummary } from '@sandforge/shared';
import type { ConnectionPool } from '../../core/connection/ConnectionPool.js';
import type { HealthCheck } from './HealthCheck.js';
import type { AlertEngine } from './AlertEngine.js';

/** Logger surface used by FleetSummaryService — narrow on purpose. */
export interface FleetSummaryLogger {
  warn: (msg: string, meta?: Record<string, unknown>) => void;
  info?: (msg: string, meta?: Record<string, unknown>) => void;
}

/**
 * Telemetry surface — kept narrow so the service can run with a stub in tests.
 * Mirrors the breadcrumb pattern used by other Phase 03 services.
 */
export interface FleetSummaryTelemetry {
  addBreadcrumb?: (category: string, message: string, data?: Record<string, unknown>) => void;
}

/**
 * Optional org-name resolver. The {@link ConnectionPool.PooledConnection}
 * shape in this codebase intentionally does NOT carry organization metadata;
 * callers can plug in a registry-backed resolver here so summaries surface a
 * human-readable label. When omitted, the orgId is used as the display name.
 */
export type OrgNameResolver = (orgId: string) => string | undefined;

/**
 * Optional per-org connection bootstrap — returns the access token + instance
 * URL the {@link ConnectionPool} needs to (re)acquire a connection without
 * forcing FleetSummaryService to know about higher-level org auth state.
 *
 * Returning `undefined` means "skip this org for this round" (e.g., a session
 * that hasn't been authenticated yet); the service surfaces a stale summary in
 * that case instead of failing the whole fleet response.
 */
export type ConnectionBootstrap = (
  orgId: string,
) => Promise<{ instanceUrl: string; accessToken: string } | undefined>;

/**
 * Constructor dependencies. All knobs default to the values pinned by
 * RESEARCH §3 P-03.5; tests override the small ones (cache TTL, poll interval,
 * concurrency) for determinism.
 */
export interface FleetSummaryDeps {
  /** {@link ConnectionPool} — REUSED, never replaced (P-03.5). */
  pool: ConnectionPool;
  /** Health computation — produces the 0-100 healthScore. */
  healthCheck: HealthCheck;
  /** Source of the per-org alert tail used in `recentAlerts`. */
  alertEngine: AlertEngine;
  /** Optional logger — `warn` on per-org failures + backoff escalation. */
  logger?: FleetSummaryLogger;
  /** Optional telemetry breadcrumbs surface. */
  telemetry?: FleetSummaryTelemetry;
  /** Internal poll interval — default 60s (P-03.5). */
  pollIntervalMs?: number;
  /** Per-org cache TTL — default 60s (P-03.5). */
  cacheTtlMs?: number;
  /** Concurrent probe ceiling — default 3 (P-03.5). */
  maxConcurrent?: number;
  /** Maximum backoff cap — default 600s (P-03.5). */
  maxBackoffMs?: number;
  /** Optional human-readable name resolver. */
  resolveOrgName?: OrgNameResolver;
  /** Optional connection bootstrap (returns instanceUrl + accessToken). */
  bootstrapConnection?: ConnectionBootstrap;
  /** Injectable clock — for fake-timer determinism in tests. */
  now?: () => number;
}

/** Default tunables — exported so tests can refer back to them. */
export const DEFAULT_POLL_INTERVAL_MS = 60_000;
export const DEFAULT_CACHE_TTL_MS = 60_000;
export const DEFAULT_MAX_CONCURRENT = 3;
export const DEFAULT_MAX_BACKOFF_MS = 600_000;

/**
 * FleetSummaryService — see file-level doc.
 *
 * Hot paths to exercise in tests:
 *   - `getSummary([...])` returns one entry per orgId, in the same order.
 *   - Cache hit within TTL skips `pool.acquire`.
 *   - Backoff doubles on consecutive failures, caps at {@link DEFAULT_MAX_BACKOFF_MS}.
 *   - `setVisibility(true)` makes `tickIfVisible` a no-op while still allowing
 *     external `getSummary` calls (those are user-initiated and serve fresh data).
 */
export class FleetSummaryService {
  private readonly cache = new Map<string, { summary: OrgFleetSummary; cachedAt: number }>();
  private readonly failureStreaks = new Map<string, number>();
  private readonly nextPollAt = new Map<string, number>();
  private hidden = false;
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly limit: ReturnType<typeof pLimit>;
  private readonly pollIntervalMs: number;
  private readonly cacheTtlMs: number;
  private readonly maxBackoffMs: number;

  constructor(private readonly deps: FleetSummaryDeps) {
    this.limit = pLimit(deps.maxConcurrent ?? DEFAULT_MAX_CONCURRENT);
    this.pollIntervalMs = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.cacheTtlMs = deps.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    this.maxBackoffMs = deps.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
  }

  /**
   * Audit M1 mitigation — pause the internal poll while the panel isn't on
   * screen. External `getSummary` calls (user-initiated refresh) are still
   * served because the visibility gate guards only the timer-driven refresh.
   */
  setVisibility(hidden: boolean): void {
    this.hidden = hidden;
  }

  /** Schedule the internal 60s tick. Idempotent. */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tickIfVisible();
    }, this.pollIntervalMs);
  }

  /**
   * Tear down the timer + clear caches. Safe to call multiple times. Note we
   * do NOT touch the {@link ConnectionPool} — that is owned by the composition
   * root and lives longer than the FleetSummaryService.
   */
  dispose(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.cache.clear();
    this.failureStreaks.clear();
    this.nextPollAt.clear();
  }

  /**
   * Fetch summaries for the given orgIds. Order is preserved. Cache hits skip
   * the pool acquisition entirely. Per-org backoff is honored — when active,
   * the cached summary is returned with `stale: true`.
   */
  async getSummary(orgIds: string[]): Promise<OrgFleetSummary[]> {
    const now = this.deps.now?.() ?? Date.now();
    const tasks = orgIds.map((orgId) =>
      this.limit(async () => this.getOne(orgId, now)),
    );
    return Promise.all(tasks);
  }

  /** Public for inspection in tests — number of cache entries currently held. */
  get cacheSize(): number {
    return this.cache.size;
  }

  /** Public for inspection — current consecutive-failure streak for an org. */
  getFailureStreak(orgId: string): number {
    return this.failureStreaks.get(orgId) ?? 0;
  }

  /** Public for inspection — next-poll timestamp for an org (0 if unset). */
  getNextPollAt(orgId: string): number {
    return this.nextPollAt.get(orgId) ?? 0;
  }

  /** Public for inspection — whether the visibility gate is active. */
  get isHidden(): boolean {
    return this.hidden;
  }

  // ─── Internals ───────────────────────────────────────────────────────────

  private async getOne(orgId: string, now: number): Promise<OrgFleetSummary> {
    const cached = this.cache.get(orgId);
    // Cache hit within TTL — straight pass-through (no pool call).
    if (cached && now - cached.cachedAt < this.cacheTtlMs) {
      return cached.summary;
    }
    // Backoff active — if we have a previous summary, surface it as stale;
    // otherwise return a synthetic stale entry so the UI still renders a card.
    const nextAt = this.nextPollAt.get(orgId) ?? 0;
    if (now < nextAt) {
      if (cached) {
        return { ...cached.summary, stale: true };
      }
      return this.synthesizeStale(orgId, now);
    }
    try {
      const summary = await this.fetchOne(orgId);
      this.cache.set(orgId, { summary, cachedAt: now });
      this.failureStreaks.set(orgId, 0);
      this.nextPollAt.set(orgId, now + this.pollIntervalMs);
      return summary;
    } catch (err) {
      const fails = (this.failureStreaks.get(orgId) ?? 0) + 1;
      this.failureStreaks.set(orgId, fails);
      // Backoff: 60s -> 120s -> 240s -> 480s -> capped at 600s (P-03.5).
      const backoffMs = Math.min(
        this.pollIntervalMs * Math.pow(2, fails - 1),
        this.maxBackoffMs,
      );
      this.nextPollAt.set(orgId, now + backoffMs);
      this.deps.logger?.warn(
        `[FleetSummary] ${orgId} probe failed (consecutive=${fails}); backing off ${backoffMs}ms`,
        { orgId, fails, backoffMs, error: err instanceof Error ? err.message : String(err) },
      );
      this.deps.telemetry?.addBreadcrumb?.('monitor.fleet', 'probe_failure', {
        orgId,
        fails,
        backoffMs,
      });
      if (cached) {
        return { ...cached.summary, stale: true };
      }
      return this.synthesizeStale(orgId, now);
    }
  }

  /**
   * Fetch one org's summary. Reuses the {@link ConnectionPool} per P-03.5 —
   * NEVER constructs a new jsforce instance directly. When a bootstrap
   * function is provided, we acquire a pooled connection eagerly so the
   * keep-alive/recycle bookkeeping stays current; otherwise we treat the org
   * as already pool-resident (the existing Monitor flows pre-warm
   * connections at activate-time).
   */
  private async fetchOne(orgId: string): Promise<OrgFleetSummary> {
    if (this.deps.bootstrapConnection) {
      const ctx = await this.deps.bootstrapConnection(orgId);
      if (ctx) {
        // Pool semantics: acquire returns the existing pooled connection when
        // present, otherwise creates one. Either way no `new Connection()`
        // happens here — that is the P-03.5 invariant.
        this.deps.pool.acquire(orgId, ctx.instanceUrl, ctx.accessToken);
      }
    } else {
      // Touch the pool so we surface a clear failure if the connection is
      // missing AND no bootstrap was wired. The acquire call needs the URL +
      // token; when neither is available we synthesize empty strings so the
      // pool's existing-conn fast path triggers.
      const existing = this.deps.pool.get(orgId);
      if (existing) {
        this.deps.pool.acquire(orgId, existing.instanceUrl, existing.accessToken);
      } else {
        // No bootstrap + no existing connection — fail this org so the
        // backoff kicks in. Surface as a warn so the user notices.
        throw new Error(
          `FleetSummaryService: no pooled connection for ${orgId} and no bootstrap configured`,
        );
      }
    }
    try {
      const health = await this.deps.healthCheck.computeHealth(orgId);
      const score = computeScoreFromStatus(health);
      const recent = collectRecentAlerts(this.deps.alertEngine, orgId, 3);
      return {
        orgId,
        name: this.deps.resolveOrgName?.(orgId) ?? orgId,
        healthScore: score,
        lastUpdated: new Date(this.deps.now?.() ?? Date.now()).toISOString(),
        alertCount: recent.length,
        recentAlerts: recent,
        stale: false,
      };
    } finally {
      // Release is sync + safe (just bumps lastUsedAt) — never throws.
      this.deps.pool.release(orgId);
    }
  }

  private async tickIfVisible(): Promise<void> {
    if (this.hidden) return;
    const now = this.deps.now?.() ?? Date.now();
    // Refresh only orgs whose cache or backoff window has elapsed. This keeps
    // the timer cheap and respects the per-org backoff exposed via
    // `nextPollAt`.
    const due: string[] = [];
    for (const orgId of this.cache.keys()) {
      const cached = this.cache.get(orgId);
      const nextAt = this.nextPollAt.get(orgId) ?? 0;
      if (now < nextAt) continue;
      if (cached && now - cached.cachedAt < this.cacheTtlMs) continue;
      due.push(orgId);
    }
    if (due.length === 0) return;
    // Re-fetch via getSummary so all the same gating + backoff applies. We
    // intentionally swallow errors — the per-org `getOne` already logs them.
    await this.getSummary(due).catch(() => undefined);
  }

  private synthesizeStale(orgId: string, now: number): OrgFleetSummary {
    return {
      orgId,
      name: this.deps.resolveOrgName?.(orgId) ?? orgId,
      healthScore: 0,
      lastUpdated: new Date(now).toISOString(),
      alertCount: 0,
      recentAlerts: [],
      stale: true,
    };
  }
}

/**
 * Derive a 0-100 health score from an {@link OrgHealthStatus}. Mirrors the
 * formula used by `MonitorOrchestrator.getHealthScore()` so the time-series
 * + fleet views agree on what "85%" means.
 */
function computeScoreFromStatus(status: {
  apiLimitsStatus: 'ok' | 'warning' | 'critical';
  storageStatus: 'ok' | 'warning' | 'critical';
  activeJobs: number;
  recentErrors: number;
}): number {
  let score = 100;
  switch (status.apiLimitsStatus) {
    case 'warning':
      score -= 15;
      break;
    case 'critical':
      score -= 35;
      break;
  }
  switch (status.storageStatus) {
    case 'warning':
      score -= 10;
      break;
    case 'critical':
      score -= 25;
      break;
  }
  score -= Math.min(status.activeJobs * 2, 15);
  score -= Math.min(status.recentErrors * 3, 25);
  return Math.max(0, Math.min(100, score));
}

/**
 * Pull the most recent N alerts for an org out of the {@link AlertEngine}'s
 * active set. The engine doesn't expose a per-org tail today; we filter the
 * active alerts in-memory + sort by triggeredAt desc + slice to N.
 *
 * Severity is normalized to the OrgFleetSummary union — anything outside
 * `info | warning | critical` falls back to `warning`.
 */
function collectRecentAlerts(
  alertEngine: AlertEngine,
  orgId: string,
  limit: number,
): OrgFleetSummary['recentAlerts'] {
  const active = alertEngine.getActiveAlerts();
  const orgAlerts = active.filter((a) => a.orgId === orgId);
  orgAlerts.sort((a, b) => (a.triggeredAt < b.triggeredAt ? 1 : -1));
  return orgAlerts.slice(0, limit).map((a) => ({
    id: a.id,
    severity: normalizeSeverity(a.severity),
    metric: deriveMetricLabel(a),
    triggeredAt: a.triggeredAt,
  }));
}

function normalizeSeverity(
  severity: string,
): 'info' | 'warning' | 'critical' {
  if (severity === 'info' || severity === 'warning' || severity === 'critical') {
    return severity;
  }
  return 'warning';
}

function deriveMetricLabel(alert: { message?: string; definitionId?: string }): string {
  // The message format is "<name>: <metric> is ..." — pick the leading slug.
  if (alert.message) {
    const colon = alert.message.indexOf(':');
    if (colon > 0) return alert.message.slice(0, colon).trim();
  }
  return alert.definitionId ?? 'unknown';
}
