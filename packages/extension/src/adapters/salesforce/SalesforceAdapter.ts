import pLimit from 'p-limit';
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
 * `DescribeCache` (which removes the repeat describe round-trips) and the
 * concurrency gate handle used for diagnostics.
 *
 * IMPORTANT: this class is purely additive — callers are moved onto it module
 * by module rather than in one sweep, so nothing is migrated here.
 */
export class SalesforceAdapter {
  // Fields kept for the in-progress DI wiring.
  // @ts-expect-error reserved for the DI wiring.
  private readonly storage: StorageAdapter;
  // @ts-expect-error reserved for the DI wiring.
  private readonly telemetry: TelemetryAdapter;
  private readonly limiter: LimitFunction;
  /**
   * Per-org `Describe` cache.
   *
   * Wraps `describeFields(orgId, object)` calls with a TTL+LRU cache so the
   * Forge executor (which calls describes twice per object) and the
   * metadata-drift permission diff path share a single warm cache.
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
