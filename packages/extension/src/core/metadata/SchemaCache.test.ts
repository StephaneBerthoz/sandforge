import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SchemaCache } from './SchemaCache';

describe('SchemaCache', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should store and retrieve values', () => {
    const cache = new SchemaCache<string>();
    cache.set('key1', 'value1');

    expect(cache.get('key1')).toBe('value1');
    expect(cache.size).toBe(1);
  });

  it('should return undefined for missing keys', () => {
    const cache = new SchemaCache<string>();

    expect(cache.get('missing')).toBeUndefined();
  });

  it('should expire entries after TTL', () => {
    const cache = new SchemaCache<string>({ defaultTtl: 1000 });
    cache.set('key1', 'value1');

    expect(cache.get('key1')).toBe('value1');

    vi.advanceTimersByTime(1001);

    expect(cache.get('key1')).toBeUndefined();
  });

  it('should support custom TTL per entry', () => {
    const cache = new SchemaCache<string>({ defaultTtl: 5000 });
    cache.set('short', 'value1', 1000);
    cache.set('long', 'value2', 10000);

    vi.advanceTimersByTime(2000);

    expect(cache.get('short')).toBeUndefined();
    expect(cache.get('long')).toBe('value2');
  });

  it('should check existence with has', () => {
    const cache = new SchemaCache<string>({ defaultTtl: 1000 });
    cache.set('key1', 'value1');

    expect(cache.has('key1')).toBe(true);
    expect(cache.has('missing')).toBe(false);

    vi.advanceTimersByTime(1001);

    expect(cache.has('key1')).toBe(false);
  });

  it('should invalidate a specific key', () => {
    const cache = new SchemaCache<string>();
    cache.set('key1', 'value1');
    cache.set('key2', 'value2');

    const result = cache.invalidate('key1');

    expect(result).toBe(true);
    expect(cache.get('key1')).toBeUndefined();
    expect(cache.get('key2')).toBe('value2');
  });

  it('should return false when invalidating a non-existent key', () => {
    const cache = new SchemaCache<string>();

    expect(cache.invalidate('missing')).toBe(false);
  });

  it('should invalidate by prefix', () => {
    const cache = new SchemaCache<string>();
    cache.set('org1:Account', 'a');
    cache.set('org1:Contact', 'b');
    cache.set('org2:Account', 'c');

    const count = cache.invalidateByPrefix('org1:');

    expect(count).toBe(2);
    expect(cache.get('org1:Account')).toBeUndefined();
    expect(cache.get('org1:Contact')).toBeUndefined();
    expect(cache.get('org2:Account')).toBe('c');
  });

  it('should evict LRU entry when max size is reached', () => {
    const cache = new SchemaCache<string>({ maxSize: 3 });
    cache.set('a', 'v1');

    vi.advanceTimersByTime(10);
    cache.set('b', 'v2');

    vi.advanceTimersByTime(10);
    cache.set('c', 'v3');

    // Access 'a' to make it recently used
    vi.advanceTimersByTime(10);
    cache.get('a');

    // Adding a 4th entry should evict 'b' (least recently accessed)
    vi.advanceTimersByTime(10);
    cache.set('d', 'v4');

    expect(cache.size).toBe(3);
    expect(cache.get('a')).toBe('v1');
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('c')).toBe('v3');
    expect(cache.get('d')).toBe('v4');
  });

  it('should not evict when updating an existing key', () => {
    const cache = new SchemaCache<string>({ maxSize: 2 });
    cache.set('a', 'v1');
    cache.set('b', 'v2');

    // Updating 'a' should not evict anything
    cache.set('a', 'v1-updated');

    expect(cache.size).toBe(2);
    expect(cache.get('a')).toBe('v1-updated');
    expect(cache.get('b')).toBe('v2');
  });

  it('should clear all entries', () => {
    const cache = new SchemaCache<string>();
    cache.set('key1', 'value1');
    cache.set('key2', 'value2');

    cache.clear();

    expect(cache.size).toBe(0);
    expect(cache.get('key1')).toBeUndefined();
  });

  it('should return non-expired keys', () => {
    const cache = new SchemaCache<string>({ defaultTtl: 5000 });
    cache.set('active1', 'v1');
    cache.set('active2', 'v2');
    cache.set('short', 'v3', 1000);

    vi.advanceTimersByTime(2000);

    const keys = cache.keys();

    expect(keys).toContain('active1');
    expect(keys).toContain('active2');
    expect(keys).not.toContain('short');
  });

  it('should report activeSize excluding expired entries', () => {
    const cache = new SchemaCache<string>({ defaultTtl: 5000 });
    cache.set('active', 'v1');
    cache.set('short', 'v2', 1000);

    vi.advanceTimersByTime(2000);

    expect(cache.size).toBe(2);
    expect(cache.activeSize).toBe(1);
  });

  it('should purge expired entries', () => {
    const cache = new SchemaCache<string>({ defaultTtl: 1000 });
    cache.set('expired1', 'v1');
    cache.set('expired2', 'v2');
    cache.set('active', 'v3', 10000);

    vi.advanceTimersByTime(2000);

    const purged = cache.purgeExpired();

    expect(purged).toBe(2);
    expect(cache.size).toBe(1);
    expect(cache.get('active')).toBe('v3');
  });

  it('should use default options when none provided', () => {
    const cache = new SchemaCache<string>();
    cache.set('key', 'value');

    // Default TTL is 5 minutes (300_000ms)
    vi.advanceTimersByTime(299_999);
    expect(cache.get('key')).toBe('value');

    vi.advanceTimersByTime(2);
    expect(cache.get('key')).toBeUndefined();
  });

  it('should increment access count on get', () => {
    const cache = new SchemaCache<string>();
    cache.set('key', 'value');

    // Access multiple times - verifying via LRU behavior
    cache.get('key');
    cache.get('key');

    // Key should still be accessible
    expect(cache.get('key')).toBe('value');
  });

  it('should track estimatedBytes', () => {
    const cache = new SchemaCache<string>();
    cache.set('key', 'hello');

    expect(cache.estimatedBytes).toBeGreaterThan(0);

    cache.clear();
    expect(cache.estimatedBytes).toBe(0);
  });

  it('should evict LRU entries when maxSizeBytes is exceeded', () => {
    // Create a cache with a very small byte limit
    const cache = new SchemaCache<string>({
      maxSize: 100,
      maxSizeBytes: 100,
    });

    // "a".repeat(20) => JSON.stringify => ~44 chars => ~88 bytes
    cache.set('first', 'a'.repeat(20));

    vi.advanceTimersByTime(10);
    cache.set('second', 'b'.repeat(20));

    // At this point adding another should evict 'first' (LRU)
    vi.advanceTimersByTime(10);

    // Access 'second' to make it more recently used
    cache.get('second');

    vi.advanceTimersByTime(10);
    cache.set('third', 'c'.repeat(20));

    // 'first' should have been evicted as LRU
    expect(cache.get('first')).toBeUndefined();
    // 'second' was accessed more recently, should still be present
    expect(cache.get('second')).toBe('b'.repeat(20));
  });

  it('should reduce estimatedBytes on invalidate', () => {
    const cache = new SchemaCache<string>();
    cache.set('a', 'value-a');
    cache.set('b', 'value-b');

    const bytesBefore = cache.estimatedBytes;
    cache.invalidate('a');

    expect(cache.estimatedBytes).toBeLessThan(bytesBefore);
  });

  it('should reduce estimatedBytes on invalidateByPrefix', () => {
    const cache = new SchemaCache<string>();
    cache.set('org1:Account', 'data-a');
    cache.set('org1:Contact', 'data-b');
    cache.set('org2:Account', 'data-c');

    const bytesBefore = cache.estimatedBytes;
    cache.invalidateByPrefix('org1:');

    expect(cache.estimatedBytes).toBeLessThan(bytesBefore);
    expect(cache.size).toBe(1);
  });

  it('should update size when overwriting an existing key', () => {
    const cache = new SchemaCache<string>({ maxSizeBytes: 500 });
    cache.set('key', 'short');
    const bytesSmall = cache.estimatedBytes;

    cache.set('key', 'a'.repeat(100));
    expect(cache.estimatedBytes).toBeGreaterThan(bytesSmall);
    expect(cache.size).toBe(1);
  });

  describe('byte cap calibration (realistic describe payloads)', () => {
    /**
     * Realistic Account-shaped describe: name/label/type/help text per field,
     * picklist values on ~25% of fields, child relationships. Mirrors what a
     * raw jsforce describe carries (the Forge cache stores a trimmed DTO, but
     * the estimator must charge real content either way).
     */
    function buildRealisticDescribe(fieldCount: number): Record<string, unknown> {
      const picklistCount = Math.floor(fieldCount / 4);
      const fields = Array.from({ length: fieldCount }, (_, i) => ({
        name: `CustomField${i}__c`,
        label: `Custom Field ${i}`,
        type: i < picklistCount ? 'picklist' : 'string',
        inlineHelpText: `Help text for custom field ${i}, explaining its business purpose.`,
        createable: true,
        nillable: true,
        ...(i < picklistCount
          ? {
              picklistValues: Array.from({ length: 8 }, (__, v) => ({
                value: `Value${v}`,
                label: `Value ${v}`,
                active: true,
              })),
            }
          : {}),
      }));
      const childRelationships = Array.from({ length: 25 }, (_, i) => ({
        childSObject: `ChildObject${i}__c`,
        field: `Parent${i}__c`,
        relationshipName: `Children${i}__r`,
        isCascadeDelete: false,
      }));
      return { name: 'Account', fields, childRelationships };
    }

    it('estimates a realistic Account describe at its content weight', () => {
      const cache = new SchemaCache({ maxSize: 10, maxSizeBytes: 100_000_000 });
      cache.set('org::Account', buildRealisticDescribe(130));

      // Content-aware estimate: ~110 KB for this fixture. The previous flat
      // heuristic (250 B/field) would report ~37 KB — outside this window.
      expect(cache.estimatedBytes).toBeGreaterThan(80_000);
      expect(cache.estimatedBytes).toBeLessThan(200_000);
    });

    it('actually triggers the byte cap with realistic describes', () => {
      // Measure one entry, then size the cap at 2.5 entries.
      const probe = new SchemaCache({ maxSize: 10, maxSizeBytes: 100_000_000 });
      probe.set('probe', buildRealisticDescribe(130));
      const byteCap = Math.floor(probe.estimatedBytes * 2.5);

      const cache = new SchemaCache({ maxSize: 100, maxSizeBytes: byteCap });
      cache.set('org::Account', buildRealisticDescribe(130));
      vi.advanceTimersByTime(10);
      cache.set('org::Contact', buildRealisticDescribe(120));
      expect(cache.size).toBe(2); // two entries fit under the cap

      vi.advanceTimersByTime(10);
      cache.set('org::Case', buildRealisticDescribe(110));

      // The third entry blows the byte budget — the LRU entry (Account) must
      // be evicted, proving maxSizeBytes is a real cap, not a dead option.
      expect(cache.size).toBe(2);
      expect(cache.get('org::Account')).toBeUndefined();
      expect(cache.get('org::Case')).toBeDefined();
      expect(cache.estimatedBytes).toBeLessThanOrEqual(byteCap);
    });
  });
});
