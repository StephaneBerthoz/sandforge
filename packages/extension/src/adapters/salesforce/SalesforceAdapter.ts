import pLimit = require('p-limit');
import pRetry = require('p-retry');
import type { StorageAdapter } from '../storage/StorageAdapter.js';
import type { TelemetryAdapter } from '../telemetry/TelemetryAdapter.js';

type LimitFunction = pLimit.Limit;

/** HTTP-style error shape that may surface from jsforce. */
export interface SalesforceLikeError {
  name?: string;
  message?: string;
  statusCode?: number;
  status?: number;
  retryAfter?: number;
  errorCode?: string;
}

/** Options for SalesforceAdapter construction. */
export interface SalesforceAdapterOptions {
  /** Max concurrent jsforce calls (default 8 — below jsforce's default 10 for headroom). */
  concurrency?: number;
  /** Max retries on retriable errors (default 4). */
  retries?: number;
  /** Min backoff delay in ms (default 2000). */
  minTimeout?: number;
  /** Max backoff delay in ms (default 60_000). */
  maxTimeout?: number;
  /** Exponential backoff factor (default 2). */
  factor?: number;
  /** Usage percentage above which `shouldPauseNonEssential` returns true (default 0.8). */
  pauseThreshold?: number;
}

/** Context passed to `withLimit`. */
export interface WithLimitContext {
  /** Propagate cancellation — when aborted, in-flight retry is skipped. */
  signal?: AbortSignal;
  /** Logical category for observability (e.g. `'query'`, `'limits'`, `'bulk'`). */
  category?: string;
}

/** Snapshot returned by `checkLimits`. */
export interface SalesforceLimitsSnapshot {
  /** Daily API quota (total). */
  daily: number;
  /** Daily usage percentage in [0..1]. */
  pct: number;
}

/** Retriable status codes — 408 (timeout), 409 (conflict), 429 (throttle), any 5xx. */
const RETRIABLE_STATUS_CODES = new Set([408, 409, 429]);

/**
 * SalesforceAdapter — single gateway for all jsforce IO with a concurrency gate
 * (p-limit) and retry strategy (p-retry + Retry-After honoring + exponential
 * backoff with jitter). Emits telemetry breadcrumbs on retries, 429s, and
 * when daily API usage crosses the pause threshold.
 *
 * IMPORTANT: this class is purely additive in Plan 01-01 — no existing callers
 * are migrated here. Plan 01-03 (DI) performs the gradual per-module migration.
 */
export class SalesforceAdapter {
  // Fields kept for downstream plans (DI wiring).
  // @ts-expect-error reserved for downstream plans.
  private readonly storage: StorageAdapter;
  private readonly telemetry: TelemetryAdapter;
  private readonly limiter: LimitFunction;
  private readonly retries: number;
  private readonly minTimeout: number;
  private readonly maxTimeout: number;
  private readonly factor: number;
  private readonly pauseThreshold: number;
  private lastSnapshot: SalesforceLimitsSnapshot | null = null;

  constructor(storage: StorageAdapter, telemetry: TelemetryAdapter, opts?: SalesforceAdapterOptions) {
    this.storage = storage;
    this.telemetry = telemetry;
    this.limiter = pLimit(opts?.concurrency ?? 8);
    this.retries = opts?.retries ?? 4;
    this.minTimeout = opts?.minTimeout ?? 2000;
    this.maxTimeout = opts?.maxTimeout ?? 60_000;
    this.factor = opts?.factor ?? 2;
    this.pauseThreshold = opts?.pauseThreshold ?? 0.8;
  }

  /** Current active + queued size of the concurrency gate. Useful for diagnostics/tests. */
  getActiveCount(): number {
    return this.limiter.activeCount;
  }

  /**
   * Run `fn` through the shared concurrency gate with automatic retry on
   * retriable errors (408/409/429 and 5xx). Honors `Retry-After` when present.
   */
  async withLimit<T>(fn: () => Promise<T>, ctx: WithLimitContext = {}): Promise<T> {
    return this.limiter(() => this.runWithRetry(fn, ctx));
  }

  /**
   * Fetch jsforce `/limits` and return the `DAILY_API_REQUESTS` snapshot.
   * Cached locally so `shouldPauseNonEssential` is a cheap sync read.
   */
  async checkLimits(conn: { limits: () => Promise<Record<string, { Max?: number; Remaining?: number }>> }): Promise<SalesforceLimitsSnapshot> {
    const limits = await conn.limits();
    const daily = limits['DAILY_API_REQUESTS'];
    const max = daily?.Max ?? 0;
    const remaining = daily?.Remaining ?? 0;
    const used = Math.max(0, max - remaining);
    const pct = max > 0 ? used / max : 0;
    const snapshot: SalesforceLimitsSnapshot = { daily: max, pct };
    this.lastSnapshot = snapshot;

    if (pct >= this.pauseThreshold) {
      this.telemetry.addBreadcrumb(`api-usage-high pct=${pct.toFixed(3)}`, 'salesforce', 'warning');
    }
    return snapshot;
  }

  /**
   * Read the last cached `checkLimits` snapshot and return whether non-essential
   * probes should pause. Returns false when no snapshot has been taken yet.
   */
  shouldPauseNonEssential(): boolean {
    if (!this.lastSnapshot) {
      return false;
    }
    return this.lastSnapshot.pct >= this.pauseThreshold;
  }

  // ── internals ──────────────────────────────────────────────

  private async runWithRetry<T>(fn: () => Promise<T>, ctx: WithLimitContext): Promise<T> {
    const { signal, category } = ctx;
    if (signal?.aborted) {
      throw signal.reason ?? new Error('aborted');
    }

    let attempt = 0;
    return pRetry(
      async () => {
        attempt += 1;
        if (signal?.aborted) {
          throw new pRetry.AbortError(toError(signal.reason ?? new Error('aborted')));
        }

        try {
          return await fn();
        } catch (err: unknown) {
          const sfErr = err as SalesforceLikeError;
          const status = sfErr.statusCode ?? sfErr.status ?? 0;
          if (!isRetriable(status)) {
            throw new pRetry.AbortError(toError(err));
          }

          this.telemetry.addBreadcrumb(
            `salesforce-retry attempt=${attempt} status=${status}${category ? ` category=${category}` : ''}`,
            'salesforce',
            status === 429 ? 'warning' : 'info'
          );

          if (sfErr.retryAfter !== undefined) {
            await sleep(sfErr.retryAfter * 1000, signal);
          }
          throw toError(err);
        }
      },
      {
        retries: this.retries,
        minTimeout: this.minTimeout,
        maxTimeout: this.maxTimeout,
        factor: this.factor,
        randomize: true,
        onFailedAttempt: () => {
          if (signal?.aborted) {
            throw new pRetry.AbortError(toError(signal.reason ?? new Error('aborted')));
          }
        },
      }
    );
  }
}

function isRetriable(status: number): boolean {
  return RETRIABLE_STATUS_CODES.has(status) || status >= 500;
}

function toError(err: unknown): Error {
  if (err instanceof Error) {
    return err;
  }
  return new Error(typeof err === 'string' ? err : JSON.stringify(err));
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error('aborted'));
      return;
    }
    const handle = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(handle);
        reject(signal.reason ?? new Error('aborted'));
      },
      { once: true }
    );
  });
}
