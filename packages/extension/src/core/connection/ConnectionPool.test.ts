import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { UUID } from '@sandforge/shared';
import { ConnectionPool } from './ConnectionPool';

describe('ConnectionPool', () => {
  let pool: ConnectionPool;

  beforeEach(() => {
    vi.useFakeTimers();
    pool = new ConnectionPool();
  });

  afterEach(() => {
    pool.dispose();
    vi.useRealTimers();
  });

  describe('defaults', () => {
    it('should use default configuration values', () => {
      const config = pool.getConfig();

      expect(config.maxConnections).toBe(10);
      expect(config.keepAliveInterval).toBe(60_000);
      expect(config.connectionTimeout).toBe(30_000);
      expect(config.idleTimeout).toBe(300_000);
    });

    it('should accept partial configuration overrides', () => {
      const custom = new ConnectionPool({ maxConnections: 5, idleTimeout: 120_000 });
      const config = custom.getConfig();

      expect(config.maxConnections).toBe(5);
      expect(config.idleTimeout).toBe(120_000);
      expect(config.keepAliveInterval).toBe(60_000);
      expect(config.connectionTimeout).toBe(30_000);

      custom.dispose();
    });

    it('should default maxPerOrg to 5', () => {
      expect(pool.getMaxPerOrg()).toBe(5);
    });

    it('should accept custom maxPerOrg', () => {
      const custom = new ConnectionPool({}, { maxPerOrg: 3 });
      expect(custom.getMaxPerOrg()).toBe(3);
      custom.dispose();
    });
  });

  describe('acquire', () => {
    it('should create a new connection', () => {
      const conn = pool.acquire('org-001' as UUID, 'https://test.sf.com', 'token-abc');

      expect(conn.orgId).toBe('org-001');
      expect(conn.instanceUrl).toBe('https://test.sf.com');
      expect(conn.accessToken).toBe('token-abc');
      expect(conn.active).toBe(true);
      expect(pool.size).toBe(1);
    });

    it('should reuse an existing active connection and update token', () => {
      pool.acquire('org-001' as UUID, 'https://test.sf.com', 'token-old');

      vi.advanceTimersByTime(1000);
      const reused = pool.acquire('org-001' as UUID, 'https://test.sf.com', 'token-new');

      expect(reused.accessToken).toBe('token-new');
      expect(pool.size).toBe(1);
    });

    it('should update lastUsedAt on reacquire', () => {
      const first = pool.acquire('org-001' as UUID, 'https://test.sf.com', 'token');
      const firstUsed = first.lastUsedAt;

      vi.advanceTimersByTime(5000);
      pool.acquire('org-001' as UUID, 'https://test.sf.com', 'token');

      expect(first.lastUsedAt).toBeGreaterThan(firstUsed);
    });
  });

  describe('release', () => {
    it('should update lastUsedAt on release', () => {
      const conn = pool.acquire('org-001' as UUID, 'https://test.sf.com', 'token');
      const originalUsed = conn.lastUsedAt;

      vi.advanceTimersByTime(5000);
      pool.release('org-001' as UUID);

      expect(conn.lastUsedAt).toBeGreaterThan(originalUsed);
    });

    it('should do nothing for non-existent connections', () => {
      expect(() => pool.release('unknown' as UUID)).not.toThrow();
    });
  });

  describe('remove', () => {
    it('should remove a connection from the pool', () => {
      pool.acquire('org-001' as UUID, 'https://test.sf.com', 'token');

      const removed = pool.remove('org-001' as UUID);

      expect(removed).toBe(true);
      expect(pool.size).toBe(0);
      expect(pool.get('org-001' as UUID)).toBeUndefined();
    });

    it('should return false for non-existent connection', () => {
      expect(pool.remove('unknown' as UUID)).toBe(false);
    });

    it('should clear latency samples when removing a connection', () => {
      pool.acquire('org-001' as UUID, 'https://test.sf.com', 'token');
      pool.recordLatency('org-001' as UUID, 120);
      pool.recordLatency('org-001' as UUID, 150);

      pool.remove('org-001' as UUID);

      const metrics = pool.getLatencyMetrics('org-001' as UUID);
      expect(metrics).toBeUndefined();
    });
  });

  describe('get', () => {
    it('should return the connection for an org', () => {
      pool.acquire('org-001' as UUID, 'https://test.sf.com', 'token');

      const conn = pool.get('org-001' as UUID);

      expect(conn).toBeDefined();
      expect(conn?.orgId).toBe('org-001');
    });

    it('should return undefined for unknown org', () => {
      expect(pool.get('unknown' as UUID)).toBeUndefined();
    });
  });

  describe('eviction', () => {
    it('should evict the oldest connection when pool is full', () => {
      const small = new ConnectionPool({ maxConnections: 2 });

      small.acquire('org-001' as UUID, 'https://a.sf.com', 'token-a');
      vi.advanceTimersByTime(1000);
      small.acquire('org-002' as UUID, 'https://b.sf.com', 'token-b');
      vi.advanceTimersByTime(1000);
      small.acquire('org-003' as UUID, 'https://c.sf.com', 'token-c');

      expect(small.size).toBe(2);
      expect(small.get('org-001' as UUID)).toBeUndefined();
      expect(small.get('org-002' as UUID)).toBeDefined();
      expect(small.get('org-003' as UUID)).toBeDefined();

      small.dispose();
    });
  });

  describe('idle cleanup', () => {
    it('should remove idle connections past the timeout', () => {
      pool.acquire('org-001' as UUID, 'https://a.sf.com', 'token-a');
      pool.acquire('org-002' as UUID, 'https://b.sf.com', 'token-b');

      vi.advanceTimersByTime(300_001);

      const removed = pool.cleanupIdle();

      expect(removed).toBe(2);
      expect(pool.size).toBe(0);
    });

    it('should keep recently used connections', () => {
      pool.acquire('org-001' as UUID, 'https://a.sf.com', 'token-a');

      vi.advanceTimersByTime(200_000);
      pool.acquire('org-002' as UUID, 'https://b.sf.com', 'token-b');

      vi.advanceTimersByTime(150_000);
      const removed = pool.cleanupIdle();

      expect(removed).toBe(1);
      expect(pool.get('org-001' as UUID)).toBeUndefined();
      expect(pool.get('org-002' as UUID)).toBeDefined();
    });

    it('should auto-clean when cleanup is started', () => {
      pool.acquire('org-001' as UUID, 'https://a.sf.com', 'token-a');
      pool.startCleanup();

      vi.advanceTimersByTime(300_001);
      vi.advanceTimersByTime(60_000);

      expect(pool.size).toBe(0);
    });

    it('should stop auto-cleanup', () => {
      pool.acquire('org-001' as UUID, 'https://a.sf.com', 'token-a');
      pool.startCleanup();
      pool.stopCleanup();

      vi.advanceTimersByTime(500_000);

      expect(pool.size).toBe(1);
    });
  });

  describe('connection recycling', () => {
    it('should recycle stale connections', () => {
      const custom = new ConnectionPool({}, { recycleIntervalMs: 60_000 });
      custom.acquire('org-001' as UUID, 'https://a.sf.com', 'token-a');

      vi.advanceTimersByTime(61_000);

      const recycled = custom.recycleStale();
      expect(recycled).toBe(1);
      expect(custom.size).toBe(0);

      custom.dispose();
    });

    it('should not recycle fresh connections', () => {
      const custom = new ConnectionPool({}, { recycleIntervalMs: 60_000 });
      custom.acquire('org-001' as UUID, 'https://a.sf.com', 'token-a');

      vi.advanceTimersByTime(30_000);

      const recycled = custom.recycleStale();
      expect(recycled).toBe(0);
      expect(custom.size).toBe(1);

      custom.dispose();
    });

    it('should auto-recycle when recycling is started', () => {
      const custom = new ConnectionPool({}, { recycleIntervalMs: 60_000 });
      custom.acquire('org-001' as UUID, 'https://a.sf.com', 'token-a');
      custom.startRecycling();

      vi.advanceTimersByTime(120_000);

      expect(custom.size).toBe(0);

      custom.dispose();
    });

    it('should stop auto-recycling', () => {
      const custom = new ConnectionPool({}, { recycleIntervalMs: 60_000 });
      custom.acquire('org-001' as UUID, 'https://a.sf.com', 'token-a');
      custom.startRecycling();
      custom.stopRecycling();

      vi.advanceTimersByTime(120_000);

      expect(custom.size).toBe(1);

      custom.dispose();
    });
  });

  describe('latency metrics', () => {
    it('should record and retrieve latency samples', () => {
      pool.recordLatency('org-001' as UUID, 100);
      pool.recordLatency('org-001' as UUID, 200);
      pool.recordLatency('org-001' as UUID, 150);

      const metrics = pool.getLatencyMetrics('org-001' as UUID);

      expect(metrics).toBeDefined();
      expect(metrics?.min).toBe(100);
      expect(metrics?.max).toBe(200);
      expect(metrics?.avg).toBe(150);
      expect(metrics?.sampleCount).toBe(3);
    });

    it('should compute percentiles correctly', () => {
      // Add 100 samples from 1 to 100
      for (let i = 1; i <= 100; i++) {
        pool.recordLatency('org-001' as UUID, i);
      }

      const metrics = pool.getLatencyMetrics('org-001' as UUID);

      expect(metrics?.min).toBe(1);
      expect(metrics?.max).toBe(100);
      expect(metrics?.p95).toBe(96);
      expect(metrics?.p99).toBe(100);
      expect(metrics?.sampleCount).toBe(100);
    });

    it('should return undefined for org with no samples', () => {
      expect(pool.getLatencyMetrics('unknown' as UUID)).toBeUndefined();
    });

    it('should cap samples at 1000', () => {
      for (let i = 0; i < 1100; i++) {
        pool.recordLatency('org-001' as UUID, i);
      }

      const metrics = pool.getLatencyMetrics('org-001' as UUID);
      expect(metrics?.sampleCount).toBe(1000);
    });

    it('should get metrics for all orgs', () => {
      pool.recordLatency('org-001' as UUID, 100);
      pool.recordLatency('org-002' as UUID, 200);

      const all = pool.getAllLatencyMetrics();
      expect(all.size).toBe(2);
      expect(all.get('org-001' as UUID)?.avg).toBe(100);
      expect(all.get('org-002' as UUID)?.avg).toBe(200);
    });

    it('should handle single sample', () => {
      pool.recordLatency('org-001' as UUID, 50);

      const metrics = pool.getLatencyMetrics('org-001' as UUID);
      expect(metrics?.min).toBe(50);
      expect(metrics?.max).toBe(50);
      expect(metrics?.avg).toBe(50);
      expect(metrics?.p95).toBe(50);
      expect(metrics?.p99).toBe(50);
    });

    it('should ignore NaN latency values', () => {
      pool.recordLatency('org-001' as UUID, NaN);

      expect(pool.getLatencyMetrics('org-001' as UUID)).toBeUndefined();
    });

    it('should ignore Infinity latency values', () => {
      pool.recordLatency('org-001' as UUID, Infinity);
      pool.recordLatency('org-001' as UUID, -Infinity);

      expect(pool.getLatencyMetrics('org-001' as UUID)).toBeUndefined();
    });

    it('should ignore negative latency values', () => {
      pool.recordLatency('org-001' as UUID, -100);

      expect(pool.getLatencyMetrics('org-001' as UUID)).toBeUndefined();
    });

    it('should accept zero latency', () => {
      pool.recordLatency('org-001' as UUID, 0);

      const metrics = pool.getLatencyMetrics('org-001' as UUID);
      expect(metrics?.min).toBe(0);
      expect(metrics?.sampleCount).toBe(1);
    });

    it('should only record valid values when mixed with invalid ones', () => {
      pool.recordLatency('org-001' as UUID, NaN);
      pool.recordLatency('org-001' as UUID, 100);
      pool.recordLatency('org-001' as UUID, -50);
      pool.recordLatency('org-001' as UUID, Infinity);
      pool.recordLatency('org-001' as UUID, 200);

      const metrics = pool.getLatencyMetrics('org-001' as UUID);
      expect(metrics?.sampleCount).toBe(2);
      expect(metrics?.min).toBe(100);
      expect(metrics?.max).toBe(200);
    });
  });

  describe('dispose', () => {
    it('should clear all connections and stop cleanup', () => {
      pool.acquire('org-001' as UUID, 'https://a.sf.com', 'token-a');
      pool.acquire('org-002' as UUID, 'https://b.sf.com', 'token-b');
      pool.startCleanup();
      pool.startRecycling();

      pool.dispose();

      expect(pool.size).toBe(0);
    });

    it('should clear latency samples', () => {
      pool.recordLatency('org-001' as UUID, 100);

      pool.dispose();

      expect(pool.getLatencyMetrics('org-001' as UUID)).toBeUndefined();
    });
  });
});
