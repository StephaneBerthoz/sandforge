/** Default maximum cache size in bytes (5 MB). */
const DEFAULT_MAX_SIZE_BYTES = 5 * 1024 * 1024;

/**
 * Flat overhead charged per field descriptor: object shape plus the ~35
 * non-string props (flags, lengths, SOAP metadata) of a raw jsforce field
 * describe. Calibrated so a realistic Account describe estimates in the
 * hundreds of KB — see SchemaCache.estimateSize.
 */
const DESCRIBE_FIELD_OVERHEAD_BYTES = 250;

/** Flat overhead charged per child relationship descriptor. */
const DESCRIBE_CHILD_REL_OVERHEAD_BYTES = 100;

/** Flat overhead charged per picklist value entry ({value,label,active,…}). */
const PICKLIST_VALUE_OVERHEAD_BYTES = 64;

/** V8 string header slack charged per string on top of 2 B/char. */
const STRING_HEADER_BYTES = 16;

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

    // Skip size estimation when byte-tracking is effectively disabled.
    // estimateSize walks the payload structurally (no JSON.stringify — that
    // would block the event loop for 50-200ms on a 1-5 MB describe), so a
    // write stays sub-millisecond even during BFS storms. When the caller
    // doesn't enforce a byte cap, we trust the entry-count cap (`maxSize`)
    // alone and skip the walk entirely.
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
   * Estimate the byte size of a value using cheap structural heuristics.
   *
   * Calling `JSON.stringify` on a 1-5 MB describe payload blocks the event
   * loop for 50-200ms; doing it on every BFS write produces seconds of
   * unresponsive UI. The describe-shaped fast path instead WALKS the
   * `fields` / `childRelationships` arrays and charges real string content
   * (name, label, type, picklist values, help text…) at 2 B/char plus a
   * per-string header, with a flat per-entry overhead for the object shape
   * and its non-string flags. Summing `.length` allocates nothing, so the
   * walk stays sub-millisecond even on big describes.
   *
   * Calibration: the formatted ObjectDescribe DTO SandForge caches (5 props
   * per field) estimates at ~400 B/field — biased ~2x above its real heap,
   * so eviction kicks in before real heap pressure. A raw 40-prop jsforce
   * describe (label, picklistValues, inlineHelpText…) estimates at its true
   * content weight (~1-2 KB/field, ~150-400 KB for a realistic Account);
   * its extra real-heap slack (hidden classes, array over-allocation, up to
   * ~1-2 MB) is bounded by the count cap (`maxSize`), which is why the
   * Forge composition caps describes at 50 entries.
   *
   * Non-describe values fall back to a per-key heuristic; arrays use a per-
   * element heuristic; primitives are cheap. Never throws.
   */
  private estimateSize(value: T): number {
    if (value == null) return 16;
    if (typeof value === 'string') return value.length * 2;
    if (typeof value === 'number' || typeof value === 'boolean') return 8;
    if (typeof value !== 'object') return 64;
    // Describe-shaped: walk fields + child relationships (the dominant
    // memory contributors on Salesforce describe responses).
    const v = value as { fields?: unknown[]; childRelationships?: unknown[] };
    if (Array.isArray(v.fields) || Array.isArray(v.childRelationships)) {
      let bytes = 512; // describe envelope (name, label, urls, flags…)
      if (Array.isArray(v.fields)) {
        for (const field of v.fields) {
          bytes += this.estimateEntrySize(field, DESCRIBE_FIELD_OVERHEAD_BYTES);
        }
      }
      if (Array.isArray(v.childRelationships)) {
        for (const rel of v.childRelationships) {
          bytes += this.estimateEntrySize(rel, DESCRIBE_CHILD_REL_OVERHEAD_BYTES);
        }
      }
      return bytes;
    }
    if (Array.isArray(value)) {
      // Heuristic: 64 B per entry on average (assumes records or DTOs).
      return value.length * 64 + 64;
    }
    // Plain object — count keys, charge ~64 B per entry.
    return Object.keys(value).length * 64 + 128;
  }

  /**
   * Charge one field/childRelationship descriptor: a flat overhead for the
   * object shape + non-string props, plus the real string content
   * (2 B/char + header per string). One level of array nesting is walked
   * (referenceTo: string[], picklistValues: {value,label,…}[]) — describes
   * don't nest deeper.
   */
  private estimateEntrySize(entry: unknown, overheadBytes: number): number {
    if (entry == null || typeof entry !== 'object') return 16;
    let bytes = overheadBytes;
    for (const prop of Object.values(entry)) {
      if (typeof prop === 'string') {
        bytes += STRING_HEADER_BYTES + prop.length * 2;
      } else if (typeof prop === 'number' || typeof prop === 'boolean') {
        bytes += 8;
      } else if (Array.isArray(prop)) {
        bytes += 16; // array header
        for (const item of prop as unknown[]) {
          bytes +=
            typeof item === 'string'
              ? STRING_HEADER_BYTES + item.length * 2
              : this.estimateEntrySize(item, PICKLIST_VALUE_OVERHEAD_BYTES);
        }
      } else {
        // null or nested plain object — rare on describes; small constant.
        bytes += 16;
      }
    }
    return bytes;
  }
}
