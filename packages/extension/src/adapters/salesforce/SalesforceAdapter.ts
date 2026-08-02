import pLimit = require('p-limit');
import type { StorageAdapter } from '../storage/StorageAdapter.js';
import type { TelemetryAdapter } from '../telemetry/TelemetryAdapter.js';
import { DescribeCache } from './DescribeCache.js';

type LimitFunction = pLimit.Limit;

/** Options for SalesforceAdapter construction. */
export interface SalesforceAdapterOptions {
  /** Max concurrent jsforce calls (default 8 — below jsforce's default 10 for headroom). */
  concurrency?: number;
}

/**
 * SalesforceAdapter — gateway for jsforce IO. Currently exposes the per-org
 * `DescribeCache` (audit Perf #1 mitigation) and the concurrency gate handle
 * used for diagnostics.
 *
 * IMPORTANT: this class is purely additive in Plan 01-01 — no existing callers
 * are migrated here. Plan 01-03 (DI) performs the gradual per-module migration.
 */
export class SalesforceAdapter {
  // Fields kept for downstream plans (DI wiring).
  // @ts-expect-error reserved for downstream plans.
  private readonly storage: StorageAdapter;
  // @ts-expect-error reserved for downstream plans.
  private readonly telemetry: TelemetryAdapter;
  private readonly limiter: LimitFunction;
  /**
   * Per-org `Describe` cache (Phase 03 Plan 03-03 — audit Perf #1).
   *
   * Wraps `describeFields(orgId, object)` calls with a TTL+LRU cache so the
   * Forge executor (which calls describes twice per object) and the upcoming
   * Drift v2 permission diff path (Plan 03-04) share a single warm cache.
   *
   * Exposed as a public field so callers that already hold a jsforce
   * connection can route their describe through the cache:
   *
   * ```ts
   * await services.salesforce.describeCache.getOrFetch(
   *   orgId,
   *   'Account',
   *   () => conn.describe('Account'),
   * );
   * ```
   */
  public readonly describeCache: DescribeCache;

  constructor(
    storage: StorageAdapter,
    telemetry: TelemetryAdapter,
    opts?: SalesforceAdapterOptions,
  ) {
    this.storage = storage;
    this.telemetry = telemetry;
    this.limiter = pLimit(opts?.concurrency ?? 8);
    this.describeCache = new DescribeCache();
  }

  /** Current active + queued size of the concurrency gate. Useful for diagnostics/tests. */
  getActiveCount(): number {
    return this.limiter.activeCount;
  }
}
