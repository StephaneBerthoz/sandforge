/** Interface for cache instances that can be registered with the CacheManager. */
export interface ManagedCache {
  /** Clear all entries from this cache. */
  clear(): void;
  /** Purge expired entries (optional). Returns number of entries purged. */
  purgeExpired?(): number;
  /** Current number of entries in the cache. */
  readonly size: number;
}

/** Diagnostic stats for a registered cache. */
export interface CacheStats {
  /** Name the cache was registered with. */
  name: string;
  /** Current number of entries. */
  size: number;
}

/** Purge interval in milliseconds (60 seconds). */
const PURGE_INTERVAL_MS = 60_000;

/**
 * Centralized cache manager that tracks all cache instances in the extension.
 *
 * Provides `invalidateAll()` for org-switch scenarios and periodic
 * purging of expired entries across all registered caches.
 *
 * Use `CacheManager.getInstance()` to access the singleton.
 */
export class CacheManager {
  private static instance: CacheManager | undefined;

  private readonly caches = new Map<string, ManagedCache>();
  private purgeTimer: ReturnType<typeof setInterval> | undefined;

  /** Private constructor -- use getInstance(). */
  private constructor() {
    this.purgeTimer = setInterval(() => {
      this.purgeAllExpired();
    }, PURGE_INTERVAL_MS);
  }

  /** Get the singleton CacheManager instance. */
  static getInstance(): CacheManager {
    if (!CacheManager.instance) {
      CacheManager.instance = new CacheManager();
    }
    return CacheManager.instance;
  }

  /**
   * Reset the singleton instance (for testing purposes only).
   * Calls dispose() on the current instance before clearing.
   */
  static resetInstance(): void {
    if (CacheManager.instance) {
      CacheManager.instance.dispose();
      CacheManager.instance = undefined;
    }
  }

  /**
   * Register a cache instance under a unique name.
   *
   * @param name - Unique identifier for this cache (e.g. 'schema', 'limits').
   * @param cache - The cache instance to register.
   */
  register(name: string, cache: ManagedCache): void {
    this.caches.set(name, cache);
  }

  /**
   * Unregister a cache instance by name.
   *
   * @param name - The name the cache was registered with.
   * @returns `true` if the cache was found and removed.
   */
  unregister(name: string): boolean {
    return this.caches.delete(name);
  }

  /**
   * Invalidate (clear) all registered caches.
   *
   * Called during org-switch to ensure stale data from the previous
   * org does not leak into the new org context.
   */
  invalidateAll(): void {
    for (const cache of this.caches.values()) {
      cache.clear();
    }
  }

  /**
   * Purge expired entries from all registered caches that support it.
   *
   * @returns Total number of expired entries purged across all caches.
   */
  purgeAllExpired(): number {
    let total = 0;
    for (const cache of this.caches.values()) {
      if (cache.purgeExpired) {
        total += cache.purgeExpired();
      }
    }
    return total;
  }

  /**
   * Get diagnostic stats for all registered caches.
   *
   * @returns Array of cache names and their current sizes.
   */
  getStats(): CacheStats[] {
    const stats: CacheStats[] = [];
    for (const [name, cache] of this.caches) {
      stats.push({ name, size: cache.size });
    }
    return stats;
  }

  /**
   * Dispose the CacheManager: clear the purge interval and all caches.
   *
   * After disposal, the singleton must be re-obtained via `getInstance()`.
   */
  dispose(): void {
    if (this.purgeTimer !== undefined) {
      clearInterval(this.purgeTimer);
      this.purgeTimer = undefined;
    }
    this.invalidateAll();
    this.caches.clear();
  }
}
