import type { MetricSample } from '@sandforge/shared';
import type { ConfigStore } from '../../core/storage/ConfigStore.js';
import { RingBuffer } from './RingBuffer.js';

/** Minimal logger surface — accepts pino-style structured warn calls. */
export interface MonitorLogger {
  warn(meta: Record<string, unknown>, msg?: string): void;
}

/** Optional telemetry surface for corruption breadcrumbs. */
export interface MonitorTelemetry {
  addBreadcrumb(meta: { category: string; message: string; data?: Record<string, unknown> }): void;
}

/** Approximate footprint of a single MetricSample after V8 boxing + tags. */
export const APPROX_BYTES_PER_SAMPLE = 96;

/** Default rolling window — matches TrendStorage 7-day cap. */
export const DEFAULT_RETENTION_DAYS = 7;

/** Default LRU memory ceiling. Above this, oldest series get evicted. */
export const DEFAULT_MAX_BYTES = 50 * 1024 * 1024;

/** Disk-flush cadence when persistence is opted in. Matches TrendStorage. */
export const PERSIST_FLUSH_INTERVAL_MS = 5 * 60 * 1000;

/** Per-org disk-flush rate limit. Matches TrendStorage. */
export const PERSIST_PER_ORG_RATE_LIMIT_MS = 15 * 60 * 1000;

/** Per-org JSON cap before skipping the flush for that org. */
export const PERSIST_PER_ORG_BYTES_CAP = 500 * 1024;

/** ConfigStore category + key prefix used for the on-disk persistence layer. */
export const PERSIST_CATEGORY = 'monitor-ts';
export const PERSIST_KEY_PREFIX = 'series-';

/** 30 s default — matches the standard probe schedule from Plan 03-03. */
const DEFAULT_INTERVAL_MS = 30_000;
const RETENTION_MS = DEFAULT_RETENTION_DAYS * 24 * 60 * 60 * 1000;

/**
 * Composite key separator. ASCII 0x1f (US — "Unit Separator") is invalid
 * in any realistic Salesforce orgId or seriesId so collisions are
 * impossible.
 */
const KEY_SEP = '';

/** Per-series capacity derivation from probe interval (P-03.1). */
function capacityForInterval(intervalMs: number): number {
  if (intervalMs <= 0 || !Number.isFinite(intervalMs)) {
    return Math.ceil(RETENTION_MS / DEFAULT_INTERVAL_MS);
  }
  return Math.ceil(RETENTION_MS / intervalMs);
}

/** Composite key for the LRU log. */
function partitionKey(orgId: string, seriesId: string): string {
  return `${orgId}${KEY_SEP}${seriesId}`;
}

/** Stats snapshot for the 5-min watchpoint logger (P-03.1). */
export interface TimeSeriesStats {
  totalSamples: number;
  estimatedBytes: number;
  perOrgBytes: Record<string, number>;
  perSeries: number;
}

/** On-disk format per org — `Record<seriesId, MetricSample[]>`. */
type PersistedOrg = Record<string, MetricSample[]>;

/** Constructor options. */
export interface TimeSeriesStoreOptions {
  configStore?: ConfigStore;
  logger?: MonitorLogger;
  telemetry?: MonitorTelemetry;
  /** Opt-in disk persistence — default false. */
  persist?: boolean;
  maxBytes?: number;
  /** Override Date.now for testability. */
  now?: () => number;
}

/**
 * Per-(orgId, seriesId) ring-buffered MetricSample store with LRU memory cap
 * and opt-in disk persistence.
 *
 * Internal `Map` is fine on the extension side — RESEARCH §3 P-03.7 M5 only
 * forbids `Map` in WebView Zustand stores (React reactivity issue).
 *
 * Does NOT subscribe to MetricBus directly — Plan 03-03 wires
 * `metricBus.subscribe('monitor:metric', s => store.record(s))` in the
 * MonitorRegistry. Decoupled.
 */
export class TimeSeriesStore {
  private readonly partitions = new Map<string, Map<string, RingBuffer<MetricSample>>>();
  private readonly lruOrder: string[] = [];
  private estimatedBytes = 0;
  private readonly maxBytes: number;
  private readonly logger?: MonitorLogger;
  private readonly telemetry?: MonitorTelemetry;
  private readonly configStore?: ConfigStore;
  private readonly persist: boolean;
  private readonly nowFn: () => number;
  private flushTimer: ReturnType<typeof setInterval> | undefined;
  private readonly lastFlushPerOrg = new Map<string, number>();

  constructor(opts: TimeSeriesStoreOptions = {}) {
    this.maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
    this.logger = opts.logger;
    this.telemetry = opts.telemetry;
    this.configStore = opts.configStore;
    this.persist = opts.persist ?? false;
    this.nowFn = opts.now ?? (() => Date.now());

    if (this.persist && this.configStore) {
      this.flushTimer = setInterval(() => {
        void this.flush();
      }, PERSIST_FLUSH_INTERVAL_MS);
    }
  }

  /** Append a sample. Allocates the ring buffer on first use per series. */
  record(sample: MetricSample, options?: { intervalMs?: number }): void {
    const orgPartitions = this.getOrCreateOrg(sample.orgId);
    let buf = orgPartitions.get(sample.seriesId);
    if (!buf) {
      const capacity = capacityForInterval(options?.intervalMs ?? DEFAULT_INTERVAL_MS);
      buf = new RingBuffer<MetricSample>(capacity);
      orgPartitions.set(sample.seriesId, buf);
    }

    const evicted = buf.push(sample);
    if (evicted) {
      this.estimatedBytes = Math.max(0, this.estimatedBytes - APPROX_BYTES_PER_SAMPLE);
    }
    this.estimatedBytes += APPROX_BYTES_PER_SAMPLE;
    this.touchLru(sample.orgId, sample.seriesId);

    while (this.estimatedBytes > this.maxBytes && this.lruOrder.length > 0) {
      this.evictOldest();
    }
  }

  /** Range query [fromMs, toMs]. Defaults: oldest in series → now. */
  query(orgId: string, seriesId: string, fromMs?: number, toMs?: number): MetricSample[] {
    const buf = this.partitions.get(orgId)?.get(seriesId);
    if (!buf) return [];
    this.touchLru(orgId, seriesId);
    const upper = toMs ?? this.nowFn();
    const lower = fromMs ?? 0;
    return buf.range((s) => {
      const t = new Date(s.ts).getTime();
      return t >= lower && t <= upper;
    });
  }

  /** Snapshot for the watchpoint logger (P-03.1) and tests. */
  getStats(): TimeSeriesStats {
    const perOrgBytes: Record<string, number> = {};
    let perSeries = 0;
    let totalSamples = 0;
    for (const [orgId, seriesMap] of this.partitions) {
      let orgBytes = 0;
      for (const buf of seriesMap.values()) {
        const bytes = buf.length * APPROX_BYTES_PER_SAMPLE;
        orgBytes += bytes;
        totalSamples += buf.length;
        perSeries++;
      }
      perOrgBytes[orgId] = orgBytes;
    }
    return { totalSamples, estimatedBytes: this.estimatedBytes, perOrgBytes, perSeries };
  }

  /** Clear one org or everything. */
  clear(orgId?: string): void {
    if (orgId) {
      const series = this.partitions.get(orgId);
      if (series) {
        for (const buf of series.values()) {
          this.estimatedBytes = Math.max(
            0,
            this.estimatedBytes - buf.length * APPROX_BYTES_PER_SAMPLE,
          );
        }
        this.partitions.delete(orgId);
      }
      this.removeLruEntries((key) => key.startsWith(`${orgId}${KEY_SEP}`));
      this.lastFlushPerOrg.delete(orgId);
      return;
    }
    this.partitions.clear();
    this.lruOrder.length = 0;
    this.lastFlushPerOrg.clear();
    this.estimatedBytes = 0;
  }

  /**
   * Rehydrate from disk. P-03.10: corrupted entries are dropped + breadcrumbed
   * but never throw — Monitor must keep running.
   */
  async rehydrate(): Promise<void> {
    if (!this.persist || !this.configStore) return;
    const keys = this.configStore.getKeysByPrefix(PERSIST_KEY_PREFIX);
    for (const key of keys) {
      const orgId = key.slice(PERSIST_KEY_PREFIX.length);
      const raw = this.configStore.get<string>(key);
      if (typeof raw !== 'string') continue;
      try {
        const parsed = JSON.parse(raw) as PersistedOrg;
        if (!parsed || typeof parsed !== 'object') {
          throw new Error('payload is not a JSON object');
        }
        const orgMap = this.getOrCreateOrg(orgId);
        for (const [seriesId, samples] of Object.entries(parsed)) {
          if (!Array.isArray(samples)) continue;
          const capacity = capacityForInterval(DEFAULT_INTERVAL_MS);
          const buf = orgMap.get(seriesId) ?? new RingBuffer<MetricSample>(capacity);
          for (const s of samples) {
            buf.push(s);
            this.estimatedBytes += APPROX_BYTES_PER_SAMPLE;
          }
          orgMap.set(seriesId, buf);
          this.touchLru(orgId, seriesId);
        }
      } catch (err: unknown) {
        this.logger?.warn(
          { orgId, key, err: err instanceof Error ? err.message : String(err) },
          'TimeSeriesStore rehydrate corrupted — dropping entry',
        );
        this.telemetry?.addBreadcrumb({
          category: 'monitor',
          message: 'TimeSeriesStore rehydrate corrupted',
          data: { orgId, key },
        });
        this.configStore.delete(key);
      }
    }
  }

  /**
   * Flush in-memory state to disk. No-op when persistence is off or the
   * 15-min per-org rate limit has not elapsed. Per-org JSON over the cap
   * is skipped + logged but does NOT throw.
   */
  async flush(): Promise<void> {
    if (!this.persist || !this.configStore) return;
    const now = this.nowFn();
    for (const [orgId, seriesMap] of this.partitions) {
      const last = this.lastFlushPerOrg.get(orgId) ?? 0;
      if (now - last < PERSIST_PER_ORG_RATE_LIMIT_MS) continue;
      const payload: PersistedOrg = {};
      for (const [seriesId, buf] of seriesMap) {
        payload[seriesId] = buf.toArray();
      }
      try {
        const json = JSON.stringify(payload);
        if (json.length > PERSIST_PER_ORG_BYTES_CAP) {
          this.logger?.warn(
            { orgId, bytes: json.length, cap: PERSIST_PER_ORG_BYTES_CAP },
            'TimeSeriesStore flush skipped — over per-org cap',
          );
          continue;
        }
        this.configStore.set(`${PERSIST_KEY_PREFIX}${orgId}`, json, PERSIST_CATEGORY);
        this.lastFlushPerOrg.set(orgId, now);
      } catch (err: unknown) {
        this.logger?.warn(
          { orgId, err: err instanceof Error ? err.message : String(err) },
          'TimeSeriesStore flush failed',
        );
      }
    }
  }

  /** Stop the flush timer and release in-memory state. */
  dispose(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = undefined;
    }
    this.clear();
  }

  private getOrCreateOrg(orgId: string): Map<string, RingBuffer<MetricSample>> {
    let series = this.partitions.get(orgId);
    if (!series) {
      series = new Map();
      this.partitions.set(orgId, series);
    }
    return series;
  }

  private touchLru(orgId: string, seriesId: string): void {
    const key = partitionKey(orgId, seriesId);
    const idx = this.lruOrder.indexOf(key);
    if (idx !== -1) {
      this.lruOrder.splice(idx, 1);
    }
    this.lruOrder.push(key);
  }

  private evictOldest(): void {
    const oldestKey = this.lruOrder.shift();
    if (!oldestKey) return;
    const sep = oldestKey.indexOf(KEY_SEP);
    if (sep === -1) return;
    const orgId = oldestKey.slice(0, sep);
    const seriesId = oldestKey.slice(sep + 1);
    const series = this.partitions.get(orgId);
    const buf = series?.get(seriesId);
    if (buf) {
      const freed = buf.length * APPROX_BYTES_PER_SAMPLE;
      this.estimatedBytes = Math.max(0, this.estimatedBytes - freed);
      series!.delete(seriesId);
      if (series!.size === 0) {
        this.partitions.delete(orgId);
      }
      this.logger?.warn(
        { orgId, seriesId, freedBytes: freed, estimatedBytes: this.estimatedBytes },
        'TimeSeriesStore LRU eviction',
      );
    }
  }

  private removeLruEntries(predicate: (key: string) => boolean): void {
    for (let i = this.lruOrder.length - 1; i >= 0; i--) {
      if (predicate(this.lruOrder[i])) {
        this.lruOrder.splice(i, 1);
      }
    }
  }
}
