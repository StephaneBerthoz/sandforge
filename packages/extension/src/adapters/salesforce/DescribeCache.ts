/**
 * Phase 03 Plan 03-03 — DescribeCache (audit Perf #1).
 *
 * `ForgeExecutor.deps.describeFields(targetOrgId, ...)` was being called twice
 * per object on the target org without caching, and Plan 03-04 (Drift v2)
 * will issue describes for permission deltas. The cache lives at the adapter
 * layer so both paths benefit transparently.
 *
 * Strategy:
 *  - Per-org map of `objectApiName → { fields, cachedAt }`.
 *  - TTL gate: cache hit only if `now - cachedAt < ttlMs`.
 *  - LRU eviction at the org level when `maxOrgs` cap is exceeded.
 *  - Hit/miss counters surface via {@link DescribeCache.getStats}.
 *  - Pure-data — no jsforce coupling. Caller supplies the `loader`.
 */

/** Minimal description of a Salesforce field — extend in Phase 06. */
export interface DescribedField {
  name: string;
  type: string;
  length?: number;
  picklistValues?: unknown[];
  required?: boolean;
  externalId?: boolean;
}

/** Construction-time options. */
export interface DescribeCacheOptions {
  /** Time-to-live in ms (default 15 min). */
  ttlMs?: number;
  /** Max distinct orgs cached before LRU eviction (default 10). */
  maxOrgs?: number;
  /** Override Date.now for testability. */
  now?: () => number;
}

/** A single cached entry — list of fields plus the timestamp it was loaded. */
interface CacheEntry {
  fields: DescribedField[];
  cachedAt: number;
}

/** Snapshot for diagnostics + tests. */
export interface DescribeCacheStats {
  orgCount: number;
  entryCount: number;
  hits: number;
  misses: number;
  hitRate: number;
}

/** Default cache TTL — 15 minutes. */
export const DEFAULT_DESCRIBE_TTL_MS = 15 * 60 * 1000;

/** Default per-process org cap — covers a fleet of 10 connected orgs. */
export const DEFAULT_DESCRIBE_MAX_ORGS = 10;

export class DescribeCache {
  /** `Map<orgId, Map<objectApiName, CacheEntry>>`. */
  private readonly cache = new Map<string, Map<string, CacheEntry>>();
  /** LRU order of orgIds (front = oldest, back = most recently used). */
  private readonly lruOrder: string[] = [];
  private hits = 0;
  private misses = 0;
  private readonly ttlMs: number;
  private readonly maxOrgs: number;
  private readonly nowFn: () => number;

  constructor(opts: DescribeCacheOptions = {}) {
    this.ttlMs = opts.ttlMs ?? DEFAULT_DESCRIBE_TTL_MS;
    this.maxOrgs = opts.maxOrgs ?? DEFAULT_DESCRIBE_MAX_ORGS;
    this.nowFn = opts.now ?? (() => Date.now());
  }

  /**
   * Return the cached fields for `(orgId, objectApiName)`. On miss OR TTL
   * expiry, invokes `loader()`, stores the result, and returns it.
   */
  async getOrFetch(
    orgId: string,
    objectApiName: string,
    loader: () => Promise<DescribedField[]>,
  ): Promise<DescribedField[]> {
    const orgMap = this.cache.get(orgId);
    const entry = orgMap?.get(objectApiName);
    const now = this.nowFn();
    if (entry && now - entry.cachedAt < this.ttlMs) {
      this.hits++;
      this.touchLru(orgId);
      return entry.fields;
    }
    this.misses++;
    const fields = await loader();
    this.store(orgId, objectApiName, fields, now);
    return fields;
  }

  /**
   * Drop one object's entry, or every entry for an org when `objectApiName`
   * is omitted. Useful for post-deploy cache busting (Phase 06).
   */
  invalidate(orgId: string, objectApiName?: string): void {
    if (objectApiName === undefined) {
      this.cache.delete(orgId);
      this.removeLru(orgId);
      return;
    }
    const orgMap = this.cache.get(orgId);
    if (!orgMap) return;
    orgMap.delete(objectApiName);
    if (orgMap.size === 0) {
      this.cache.delete(orgId);
      this.removeLru(orgId);
    }
  }

  /** Snapshot — orgs, entries, hit/miss counters, hit ratio. */
  getStats(): DescribeCacheStats {
    let entryCount = 0;
    for (const orgMap of this.cache.values()) {
      entryCount += orgMap.size;
    }
    const total = this.hits + this.misses;
    return {
      orgCount: this.cache.size,
      entryCount,
      hits: this.hits,
      misses: this.misses,
      hitRate: total === 0 ? 0 : this.hits / total,
    };
  }

  /** Clear every cached entry AND reset hit/miss counters. */
  clear(): void {
    this.cache.clear();
    this.lruOrder.length = 0;
    this.hits = 0;
    this.misses = 0;
  }

  // ─── internals ───────────────────────────────────────────────

  private store(orgId: string, objectApiName: string, fields: DescribedField[], now: number): void {
    let orgMap = this.cache.get(orgId);
    if (!orgMap) {
      orgMap = new Map();
      this.cache.set(orgId, orgMap);
    }
    orgMap.set(objectApiName, { fields, cachedAt: now });
    this.touchLru(orgId);
    this.evictIfNeeded();
  }

  private touchLru(orgId: string): void {
    const idx = this.lruOrder.indexOf(orgId);
    if (idx !== -1) {
      this.lruOrder.splice(idx, 1);
    }
    this.lruOrder.push(orgId);
  }

  private removeLru(orgId: string): void {
    const idx = this.lruOrder.indexOf(orgId);
    if (idx !== -1) {
      this.lruOrder.splice(idx, 1);
    }
  }

  private evictIfNeeded(): void {
    while (this.cache.size > this.maxOrgs && this.lruOrder.length > 0) {
      const oldest = this.lruOrder.shift();
      if (oldest !== undefined) {
        this.cache.delete(oldest);
      }
    }
  }
}
