import { describe, it, expect, vi } from 'vitest';
import {
  DescribeCache,
  type DescribedField,
  DEFAULT_DESCRIBE_TTL_MS,
} from './DescribeCache.js';

function fields(name: string): DescribedField[] {
  return [{ name, type: 'string' }];
}

describe('DescribeCache', () => {
  it('miss → loader called and value cached', async () => {
    const cache = new DescribeCache();
    const loader = vi.fn().mockResolvedValue(fields('a'));
    const result = await cache.getOrFetch('o1', 'Account', loader);
    expect(loader).toHaveBeenCalledTimes(1);
    expect(result).toEqual(fields('a'));
    const stats = cache.getStats();
    expect(stats.misses).toBe(1);
    expect(stats.hits).toBe(0);
    expect(stats.entryCount).toBe(1);
    expect(stats.orgCount).toBe(1);
  });

  it('hit within TTL → loader NOT called twice', async () => {
    const cache = new DescribeCache();
    const loader = vi.fn().mockResolvedValue(fields('a'));
    await cache.getOrFetch('o1', 'Account', loader);
    await cache.getOrFetch('o1', 'Account', loader);
    expect(loader).toHaveBeenCalledTimes(1);
    const stats = cache.getStats();
    expect(stats.hits).toBe(1);
    expect(stats.misses).toBe(1);
    expect(stats.hitRate).toBeCloseTo(0.5);
  });

  it('TTL expiry → loader called again', async () => {
    let now = 1_000_000;
    const cache = new DescribeCache({ ttlMs: 1_000, now: () => now });
    const loader = vi.fn().mockResolvedValue(fields('a'));
    await cache.getOrFetch('o1', 'Account', loader);
    expect(loader).toHaveBeenCalledTimes(1);
    now += 1_500;
    await cache.getOrFetch('o1', 'Account', loader);
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it('invalidate single object drops only that entry', async () => {
    const cache = new DescribeCache();
    const accountLoader = vi.fn().mockResolvedValue(fields('account'));
    const contactLoader = vi.fn().mockResolvedValue(fields('contact'));
    await cache.getOrFetch('o1', 'Account', accountLoader);
    await cache.getOrFetch('o1', 'Contact', contactLoader);
    cache.invalidate('o1', 'Account');
    expect(cache.getStats().entryCount).toBe(1);
    // Account refetch — loader called again.
    await cache.getOrFetch('o1', 'Account', accountLoader);
    expect(accountLoader).toHaveBeenCalledTimes(2);
    // Contact still cached.
    await cache.getOrFetch('o1', 'Contact', contactLoader);
    expect(contactLoader).toHaveBeenCalledTimes(1);
  });

  it('invalidate whole org drops every entry for that org', async () => {
    const cache = new DescribeCache();
    const loader = vi.fn().mockResolvedValue(fields('a'));
    await cache.getOrFetch('o1', 'Account', loader);
    await cache.getOrFetch('o1', 'Contact', loader);
    await cache.getOrFetch('o2', 'Account', loader);
    cache.invalidate('o1');
    const stats = cache.getStats();
    expect(stats.orgCount).toBe(1);
    expect(stats.entryCount).toBe(1);
  });

  it('LRU eviction at maxOrgs cap drops oldest org', async () => {
    const cache = new DescribeCache({ maxOrgs: 2 });
    const loader = vi.fn().mockResolvedValue(fields('a'));
    await cache.getOrFetch('o1', 'Account', loader);
    await cache.getOrFetch('o2', 'Account', loader);
    await cache.getOrFetch('o3', 'Account', loader);
    const stats = cache.getStats();
    expect(stats.orgCount).toBe(2);
    // o1 was evicted — re-fetch is a miss.
    await cache.getOrFetch('o1', 'Account', loader);
    expect(loader).toHaveBeenCalledTimes(4);
  });

  it('LRU keeps recently used org alive when a new one arrives', async () => {
    const cache = new DescribeCache({ maxOrgs: 2 });
    const loader = vi.fn().mockResolvedValue(fields('a'));
    await cache.getOrFetch('o1', 'Account', loader);
    await cache.getOrFetch('o2', 'Account', loader);
    // Touch o1 — it becomes most-recent.
    await cache.getOrFetch('o1', 'Account', loader);
    // Now o3 arrives → o2 should be evicted (the LRU), not o1.
    await cache.getOrFetch('o3', 'Account', loader);
    // o1 still cached.
    await cache.getOrFetch('o1', 'Account', loader);
    // Loader call count: o1(1) + o2(1) + o3(1) — o1 second/third reads were hits.
    expect(loader).toHaveBeenCalledTimes(3);
  });

  it('getStats reports orgCount, entryCount, hits, misses, hitRate', async () => {
    const cache = new DescribeCache();
    const loader = vi.fn().mockResolvedValue(fields('a'));
    await cache.getOrFetch('o1', 'Account', loader);
    await cache.getOrFetch('o1', 'Account', loader);
    await cache.getOrFetch('o1', 'Contact', loader);
    const stats = cache.getStats();
    expect(stats.orgCount).toBe(1);
    expect(stats.entryCount).toBe(2);
    expect(stats.hits).toBe(1);
    expect(stats.misses).toBe(2);
    expect(stats.hitRate).toBeCloseTo(1 / 3);
  });

  it('clear() resets cache + counters', async () => {
    const cache = new DescribeCache();
    const loader = vi.fn().mockResolvedValue(fields('a'));
    await cache.getOrFetch('o1', 'Account', loader);
    await cache.getOrFetch('o1', 'Account', loader);
    cache.clear();
    const stats = cache.getStats();
    expect(stats.orgCount).toBe(0);
    expect(stats.entryCount).toBe(0);
    expect(stats.hits).toBe(0);
    expect(stats.misses).toBe(0);
  });

  it('uses 15-min default TTL when not overridden', () => {
    expect(DEFAULT_DESCRIBE_TTL_MS).toBe(15 * 60 * 1000);
  });
});
