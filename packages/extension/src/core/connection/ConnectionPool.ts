import type { PoolConfig, UUID } from '@sandforge/shared';

/** A pooled connection entry */
export interface PooledConnection {
  orgId: UUID;
  instanceUrl: string;
  accessToken: string;
  createdAt: number;
  lastUsedAt: number;
  active: boolean;
}

/** Latency metrics for a connection */
export interface LatencyMetrics {
  min: number;
  max: number;
  avg: number;
  p95: number;
  p99: number;
  sampleCount: number;
}

/**
 * Manages a pool of Salesforce API connections with keep-alive,
 * automatic cleanup of idle connections, per-org limits,
 * connection recycling, and latency tracking.
 */
export class ConnectionPool {
  private static readonly DEFAULT_MAX_PER_ORG = 5;
  private static readonly DEFAULT_RECYCLE_INTERVAL = 15 * 60 * 1000;

  private connections: Map<UUID, PooledConnection> = new Map();
  private config: PoolConfig;
  private cleanupTimer: ReturnType<typeof setInterval> | undefined;
  private recycleTimer: ReturnType<typeof setInterval> | undefined;
  private readonly maxPerOrg: number;
  private readonly recycleIntervalMs: number;
  private readonly latencySamples: Map<UUID, number[]> = new Map();

  constructor(
    config?: Partial<PoolConfig>,
    options?: { maxPerOrg?: number; recycleIntervalMs?: number }
  ) {
    this.config = {
      maxConnections: config?.maxConnections ?? 10,
      keepAliveInterval: config?.keepAliveInterval ?? 60_000,
      connectionTimeout: config?.connectionTimeout ?? 30_000,
      idleTimeout: config?.idleTimeout ?? 300_000,
    };
    this.maxPerOrg = options?.maxPerOrg ?? ConnectionPool.DEFAULT_MAX_PER_ORG;
    this.recycleIntervalMs = options?.recycleIntervalMs ?? ConnectionPool.DEFAULT_RECYCLE_INTERVAL;
  }

  /** Acquire or create a connection for an org */
  acquire(orgId: UUID, instanceUrl: string, accessToken: string): PooledConnection {
    const existing = this.connections.get(orgId);
    if (existing && existing.active) {
      existing.lastUsedAt = Date.now();
      existing.accessToken = accessToken;
      return existing;
    }

    if (this.connections.size >= this.config.maxConnections) {
      this.evictOldest();
    }

    const connection: PooledConnection = {
      orgId,
      instanceUrl,
      accessToken,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      active: true,
    };
    this.connections.set(orgId, connection);
    return connection;
  }

  /** Release a connection back to the pool */
  release(orgId: UUID): void {
    const conn = this.connections.get(orgId);
    if (conn) {
      conn.lastUsedAt = Date.now();
    }
  }

  /** Remove a connection and its latency samples from the pool */
  remove(orgId: UUID): boolean {
    this.latencySamples.delete(orgId);
    return this.connections.delete(orgId);
  }

  /** Get connection for an org */
  get(orgId: UUID): PooledConnection | undefined {
    return this.connections.get(orgId);
  }

  /** Get the current pool size */
  get size(): number {
    return this.connections.size;
  }

  /** Get pool configuration */
  getConfig(): Readonly<PoolConfig> {
    return { ...this.config };
  }

  /** Get the max connections per org */
  getMaxPerOrg(): number {
    return this.maxPerOrg;
  }

  /** Record a latency sample for an org. Ignores NaN, Infinity, and negative values. */
  recordLatency(orgId: UUID, latencyMs: number): void {
    if (!Number.isFinite(latencyMs) || latencyMs < 0) {
      return;
    }
    let samples = this.latencySamples.get(orgId);
    if (!samples) {
      samples = [];
      this.latencySamples.set(orgId, samples);
    }
    samples.push(latencyMs);
    // Keep at most 1000 samples
    if (samples.length > 1000) {
      samples.splice(0, samples.length - 1000);
    }
  }

  /** Get latency metrics for an org */
  getLatencyMetrics(orgId: UUID): LatencyMetrics | undefined {
    const samples = this.latencySamples.get(orgId);
    if (!samples || samples.length === 0) {
      return undefined;
    }

    const sorted = [...samples].sort((a, b) => a - b);
    const sum = sorted.reduce((a, b) => a + b, 0);
    const p95Index = Math.floor(sorted.length * 0.95);
    const p99Index = Math.floor(sorted.length * 0.99);

    return {
      min: sorted[0],
      max: sorted[sorted.length - 1],
      avg: Math.round(sum / sorted.length),
      p95: sorted[Math.min(p95Index, sorted.length - 1)],
      p99: sorted[Math.min(p99Index, sorted.length - 1)],
      sampleCount: sorted.length,
    };
  }

  /** Get latency metrics for all orgs */
  getAllLatencyMetrics(): Map<UUID, LatencyMetrics> {
    const result = new Map<UUID, LatencyMetrics>();
    for (const orgId of this.latencySamples.keys()) {
      const metrics = this.getLatencyMetrics(orgId);
      if (metrics) {
        result.set(orgId, metrics);
      }
    }
    return result;
  }

  /** Clean up idle connections */
  cleanupIdle(): number {
    const now = Date.now();
    let removed = 0;
    for (const [orgId, conn] of this.connections) {
      if (now - conn.lastUsedAt > this.config.idleTimeout) {
        this.connections.delete(orgId);
        removed++;
      }
    }
    return removed;
  }

  /** Recycle stale connections (created too long ago) */
  recycleStale(): number {
    const now = Date.now();
    let recycled = 0;
    for (const [orgId, conn] of this.connections) {
      if (now - conn.createdAt > this.recycleIntervalMs) {
        // Mark for refresh — consumers should re-acquire
        conn.active = false;
        this.connections.delete(orgId);
        recycled++;
      }
    }
    return recycled;
  }

  /** Start automatic cleanup interval */
  startCleanup(): void {
    this.stopCleanup();
    this.cleanupTimer = setInterval(() => this.cleanupIdle(), this.config.keepAliveInterval);
  }

  /** Stop automatic cleanup */
  stopCleanup(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }
  }

  /** Start automatic connection recycling */
  startRecycling(): void {
    this.stopRecycling();
    this.recycleTimer = setInterval(() => this.recycleStale(), this.recycleIntervalMs);
  }

  /** Stop automatic connection recycling */
  stopRecycling(): void {
    if (this.recycleTimer) {
      clearInterval(this.recycleTimer);
      this.recycleTimer = undefined;
    }
  }

  /** Evict the oldest connection to make room */
  private evictOldest(): void {
    let oldest: UUID | undefined;
    let oldestTime = Infinity;
    for (const [orgId, conn] of this.connections) {
      if (conn.lastUsedAt < oldestTime) {
        oldestTime = conn.lastUsedAt;
        oldest = orgId;
      }
    }
    if (oldest) {
      this.connections.delete(oldest);
    }
  }

  /** Dispose the pool and clean up all connections */
  dispose(): void {
    this.stopCleanup();
    this.stopRecycling();
    this.connections.clear();
    this.latencySamples.clear();
  }
}
