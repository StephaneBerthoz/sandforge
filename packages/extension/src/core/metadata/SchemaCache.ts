/** Cached entry with metadata */
interface CacheEntry<T> {
  data: T;
  cachedAt: number;
  ttl: number;
  accessCount: number;
  lastAccessedAt: number;
}

/**
 * Generic cache with TTL-based expiration and LRU eviction.
 * Used primarily for caching Salesforce schema metadata.
 */
export class SchemaCache<T = unknown> {
  private cache: Map<string, CacheEntry<T>> = new Map();
  private maxSize: number;
  private defaultTtl: number;

  constructor(options?: { maxSize?: number; defaultTtl?: number }) {
    this.maxSize = options?.maxSize ?? 100;
    this.defaultTtl = options?.defaultTtl ?? 300_000; // 5 minutes
  }

  /** Get a value from cache (returns undefined if expired) */
  get(key: string): T | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;

    if (this.isExpired(entry)) {
      this.cache.delete(key);
      return undefined;
    }

    entry.accessCount++;
    entry.lastAccessedAt = Date.now();
    return entry.data;
  }

  /** Set a value in cache with optional custom TTL */
  set(key: string, value: T, ttl?: number): void {
    if (this.cache.size >= this.maxSize && !this.cache.has(key)) {
      this.evictLRU();
    }

    this.cache.set(key, {
      data: value,
      cachedAt: Date.now(),
      ttl: ttl ?? this.defaultTtl,
      accessCount: 1,
      lastAccessedAt: Date.now(),
    });
  }

  /** Check if a key exists and is not expired */
  has(key: string): boolean {
    const entry = this.cache.get(key);
    if (!entry) return false;
    if (this.isExpired(entry)) {
      this.cache.delete(key);
      return false;
    }
    return true;
  }

  /** Invalidate (delete) a specific key */
  invalidate(key: string): boolean {
    return this.cache.delete(key);
  }

  /** Invalidate all keys matching a prefix */
  invalidateByPrefix(prefix: string): number {
    let count = 0;
    for (const key of this.cache.keys()) {
      if (key.startsWith(prefix)) {
        this.cache.delete(key);
        count++;
      }
    }
    return count;
  }

  /** Clear all cached entries */
  clear(): void {
    this.cache.clear();
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
        this.cache.delete(key);
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
      this.cache.delete(lruKey);
    }
  }
}
