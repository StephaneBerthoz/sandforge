import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CacheManager } from './CacheManager';
import type { ManagedCache } from './CacheManager';

function createMockCache(opts?: { purgeExpired?: () => number }): ManagedCache {
  let size = 5;
  return {
    clear: vi.fn(() => {
      size = 0;
    }),
    purgeExpired: opts?.purgeExpired,
    get size() {
      return size;
    },
  };
}

describe('CacheManager', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    CacheManager.resetInstance();
  });

  afterEach(() => {
    CacheManager.resetInstance();
    vi.useRealTimers();
  });

  it('should be a singleton', () => {
    const a = CacheManager.getInstance();
    const b = CacheManager.getInstance();
    expect(a).toBe(b);
  });

  it('should register and track caches', () => {
    const manager = CacheManager.getInstance();
    const cache1 = createMockCache();
    const cache2 = createMockCache();

    manager.register('schema', cache1);
    manager.register('limits', cache2);

    const stats = manager.getStats();
    expect(stats).toHaveLength(2);
    expect(stats.map((s) => s.name)).toContain('schema');
    expect(stats.map((s) => s.name)).toContain('limits');
  });

  it('should invalidateAll by calling clear() on every registered cache', () => {
    const manager = CacheManager.getInstance();
    const cache1 = createMockCache();
    const cache2 = createMockCache();

    manager.register('a', cache1);
    manager.register('b', cache2);

    manager.invalidateAll();

    expect(cache1.clear).toHaveBeenCalledOnce();
    expect(cache2.clear).toHaveBeenCalledOnce();
  });

  it('should purgeAllExpired across caches that support it', () => {
    const manager = CacheManager.getInstance();
    const purge1 = vi.fn(() => 3);
    const purge2 = vi.fn(() => 7);

    manager.register('with-purge', createMockCache({ purgeExpired: purge1 }));
    manager.register('also-purge', createMockCache({ purgeExpired: purge2 }));
    manager.register('no-purge', createMockCache());

    const total = manager.purgeAllExpired();

    expect(total).toBe(10);
    expect(purge1).toHaveBeenCalledOnce();
    expect(purge2).toHaveBeenCalledOnce();
  });

  it('should getStats with names and sizes', () => {
    const manager = CacheManager.getInstance();
    manager.register('schema', createMockCache());
    manager.register('limits', createMockCache());

    const stats = manager.getStats();

    expect(stats).toEqual([
      { name: 'schema', size: 5 },
      { name: 'limits', size: 5 },
    ]);
  });

  it('should unregister a cache', () => {
    const manager = CacheManager.getInstance();
    manager.register('temp', createMockCache());

    expect(manager.unregister('temp')).toBe(true);
    expect(manager.getStats()).toHaveLength(0);
    expect(manager.unregister('temp')).toBe(false);
  });

  it('should dispose by clearing interval and all caches', () => {
    const manager = CacheManager.getInstance();
    const cache = createMockCache();
    manager.register('test', cache);

    manager.dispose();

    expect(cache.clear).toHaveBeenCalled();
    expect(manager.getStats()).toHaveLength(0);
  });

  it('should auto-purge expired entries every 60 seconds', () => {
    const manager = CacheManager.getInstance();
    const purge = vi.fn(() => 2);
    manager.register('auto', createMockCache({ purgeExpired: purge }));

    expect(purge).not.toHaveBeenCalled();

    vi.advanceTimersByTime(60_000);
    expect(purge).toHaveBeenCalledOnce();

    vi.advanceTimersByTime(60_000);
    expect(purge).toHaveBeenCalledTimes(2);
  });

  it('should resetInstance and create fresh singleton', () => {
    const a = CacheManager.getInstance();
    a.register('test', createMockCache());

    CacheManager.resetInstance();

    const b = CacheManager.getInstance();
    expect(b).not.toBe(a);
    expect(b.getStats()).toHaveLength(0);
  });
});
