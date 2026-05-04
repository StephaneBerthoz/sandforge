/** Default maximum cache size in bytes (5 MB). */
const DEFAULT_MAX_SIZE_BYTES = 5 * 1024 * 1024;

/** Cached entry with metadata */
interface CacheEntry<T> {
  data: T;
  cachedAt: number;
  ttl: number;
  accessCount: number;
  lastAccessedAt: number;
}

/** Options for constructing a SchemaCache instance. */
export interface SchemaCacheOptions {
  /** Maximum number of entries. Defaults to 100. */
  maxSize?: number;
  /** Default TTL in milliseconds. Defaults to 300000 (5 minutes). */
  defaultTtl?: number;
  /** Maximum estimated memory usage in bytes. Defaults to 5 MB. */
  maxSizeBytes?: number;
}

/**
 * Generic cache with TTL-based expiration, LRU eviction, and optional memory limit.
 * Used primarily for caching Salesforce schema metadata.
 */
export class SchemaCache<T = unknown> {
  private cache: Map<string, CacheEntry<T>> = new Map();
  private sizeMap: Map<string, number> = new Map();
  private maxSize: number;
  private defaultTtl: number;
  private maxSizeBytes: number;
  private currentBytes = 0;

  constructor(options?: SchemaCacheOptions) {
    this.maxSize = options?.maxSize ?? 100;
    this.defaultTtl = options?.defaultTtl ?? 300_000; // 5 minutes
    this.maxSizeBytes = options?.maxSizeBytes ?? DEFAULT_MAX_SIZE_BYTES;
  }

  /** Get a value from cache (returns undefined if expired) */
  get(key: string): T | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;

    if (this.isExpired(entry)) {
      this.deleteEntry(key);
      return undefined;
    }

    entry.accessCount++;
    entry.lastAccessedAt = Date.now();
    return entry.data;
  }

  /** Set a value in cache with optional custom TTL */
  set(key: string, value: T, ttl?: number): void {
    // If updating an existing key, remove its old size first
    if (this.cache.has(key)) {
      this.removeSize(key);
    }

    // Skip JSON.stringify when byte-tracking is effectively disabled.
    // estimateSize on a 1-5 MB describe response blocks the event loop
    // for 50-200ms; with 50+ cache writes during BFS the freeze adds up
    // to several seconds of unresponsive UI ("window is not responding"
    // dialog). When the caller doesn't enforce a byte cap, we trust the
    // entry-count cap (`maxSize`) alone.
    const trackBytes = this.maxSizeBytes < Number.POSITIVE_INFINITY;
    const entrySize = trackBytes ? this.estimateSize(value) : 0;

    // Evict LRU entries if count limit exceeded
    if (this.cache.size >= this.maxSize && !this.cache.has(key)) {
      this.evictLRU();
    }

    // Evict LRU entries until under memory limit
    if (trackBytes) {
      while (this.cache.size > 0 && this.currentBytes + entrySize > this.maxSizeBytes) {
        this.evictLRU();
      }
    }

    this.cache.set(key, {
      data: value,
      cachedAt: Date.now(),
      ttl: ttl ?? this.defaultTtl,
      accessCount: 1,
      lastAccessedAt: Date.now(),
    });
    if (trackBytes) {
      this.sizeMap.set(key, entrySize);
      this.currentBytes += entrySize;
    }
  }

  /** Check if a key exists and is not expired */
  has(key: string): boolean {
    const entry = this.cache.get(key);
    if (!entry) return false;
    if (this.isExpired(entry)) {
      this.deleteEntry(key);
      return false;
    }
    return true;
  }

  /** Invalidate (delete) a specific key */
  invalidate(key: string): boolean {
    if (this.cache.has(key)) {
      this.deleteEntry(key);
      return true;
    }
    return false;
  }

  /** Invalidate all keys matching a prefix */
  invalidateByPrefix(prefix: string): number {
    let count = 0;
    for (const key of this.cache.keys()) {
      if (key.startsWith(prefix)) {
        this.deleteEntry(key);
        count++;
      }
    }
    return count;
  }

  /** Clear all cached entries */
  clear(): void {
    this.cache.clear();
    this.sizeMap.clear();
    this.currentBytes = 0;
  }

  /** Get current cache size (including expired entries) */
  get size(): number {
    return this.cache.size;
  }

  /** Get the number of non-expired entries */
  get activeSize(): number {
    let count = 0;
    for (const entry of this.cache.values()) {
      if (!this.isExpired(entry)) count++;
    }
    return count;
  }

  /** Estimated total bytes currently used by cached data. */
  get estimatedBytes(): number {
    return this.currentBytes;
  }

  /** Get all non-expired keys */
  keys(): string[] {
    const result: string[] = [];
    for (const [key, entry] of this.cache) {
      if (!this.isExpired(entry)) result.push(key);
    }
    return result;
  }

  /** Purge all expired entries */
  purgeExpired(): number {
    let count = 0;
    for (const [key, entry] of this.cache) {
      if (this.isExpired(entry)) {
        this.deleteEntry(key);
        count++;
      }
    }
    return count;
  }

  /** Check if an entry has expired */
  private isExpired(entry: CacheEntry<T>): boolean {
    return Date.now() - entry.cachedAt > entry.ttl;
  }

  /** Evict the least recently used entry */
  private evictLRU(): void {
    let lruKey: string | undefined;
    let lruTime = Infinity;

    for (const [key, entry] of this.cache) {
      if (entry.lastAccessedAt < lruTime) {
        lruTime = entry.lastAccessedAt;
        lruKey = key;
      }
    }

    if (lruKey) {
      this.deleteEntry(lruKey);
    }
  }

  /** Delete an entry and update the byte counter. */
  private deleteEntry(key: string): void {
    this.cache.delete(key);
    this.removeSize(key);
  }

  /** Remove size tracking for a key. */
  private removeSize(key: string): void {
    const bytes = this.sizeMap.get(key);
    if (bytes !== undefined) {
      this.currentBytes -= bytes;
      this.sizeMap.delete(key);
    }
  }

  /**
   * Estimate the byte size of a value using O(1) structural heuristics.
   *
   * Calling `JSON.stringify` on a 1-5 MB describe payload blocks the event
   * loop for 50-200ms; doing it on every BFS write produces seconds of
   * unresponsive UI. The describe-shaped fast path measures `fields` and
   * `childRelationships` array lengths instead — biased high (~250 B/field,
   * ~150 B/childRel) so the eviction kicks in before real heap pressure.
   * Non-describe values fall back to a constant 1 KB; arrays use a per-
   * element heuristic; primitives are cheap. Never throws.
   */
  private estimateSize(value: T): number {
    if (value == null) return 16;
    if (typeof value === 'string') return value.length * 2;
    if (typeof value === 'number' || typeof value === 'boolean') return 8;
    if (typeof value !== 'object') return 64;
    // Describe-shaped: count fields + child relationships (the dominant
    // memory contributors on Salesforce describe responses).
    const v = value as { fields?: unknown[]; childRelationships?: unknown[] };
    if (Array.isArray(v.fields) || Array.isArray(v.childRelationships)) {
      return (
        (Array.isArray(v.fields) ? v.fields.length * 250 : 0) +
        (Array.isArray(v.childRelationships) ? v.childRelationships.length * 150 : 0) +
        512
      );
    }
    if (Array.isArray(value)) {
      // Heuristic: 64 B per entry on average (assumes records or DTOs).
      return value.length * 64 + 64;
    }
    // Plain object — count keys, charge ~64 B per entry.
    return Object.keys(value).length * 64 + 128;
  }
}
