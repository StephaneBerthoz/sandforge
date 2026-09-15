import pLimit from 'p-limit';
import { DescribeCache } from './DescribeCache.js';

type LimitFunction = pLimit.Limit;

/** Options for SalesforceAdapter construction. */
export interface SalesforceAdapterOptions {
  /** Max concurrent jsforce calls (default 8 — below jsforce's default 10 for headroom). */
  concurrency?: number;
}

/**
 * SalesforceAdapter — a per-org `DescribeCache` and a concurrency gate.
 *
 * No production code reads it: Salesforce calls go through
 * `getJsforceConnection` in the module that makes them, the gate wraps no
 * call, and the Forge, AI tools and frozen-dataset describes each use their
 * own `SchemaCache`. It holds no storage or telemetry handle.
 */
export class SalesforceAdapter {
  private readonly limiter: LimitFunction;
  /**
   * Per-org `Describe` cache (TTL + LRU). A caller that already holds a
   * jsforce connection routes a describe through it with
   * `describeCache.getOrFetch(orgId, 'Account', () => conn.describe('Account'))`.
   */
  public readonly describeCache: DescribeCache;

  constructor(opts?: SalesforceAdapterOptions) {
    this.limiter = pLimit(opts?.concurrency ?? 8);
    this.describeCache = new DescribeCache();
  }

  /** Current active + queued size of the concurrency gate. Useful for diagnostics/tests. */
  getActiveCount(): number {
    return this.limiter.activeCount;
  }
}
