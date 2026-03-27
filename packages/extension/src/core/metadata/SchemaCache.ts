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

    const entrySize = this.estimateSize(value);

    // Evict LRU entries if count limit exceeded
    if (this.cache.size >= this.maxSize && !this.cache.has(key)) {
      this.evictLRU();
    }

    // Evict LRU entries until under memory limit
    while (
      this.cache.size > 0 &&
      this.currentBytes + entrySize > this.maxSizeBytes
    ) {
      this.evictLRU();
    }

    this.cache.set(key, {
      data: value,
      cachedAt: Date.now(),
      ttl: ttl ?? this.defaultTtl,
      accessCount: 1,
      lastAccessedAt: Date.now(),
    });
    this.sizeMap.set(key, entrySize);
    this.currentBytes += entrySize;
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
   * Estimate the byte size of a value using JSON serialization length.
   * This is a rough heuristic -- actual memory usage may differ.
   */
  private estimateSize(value: T): number {
    try {
      return JSON.stringify(value).length * 2; // Rough UTF-16 estimate
    } catch {
      return 1024; // Fallback for non-serializable values
    }
  }
}
