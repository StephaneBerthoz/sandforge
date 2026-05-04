import type { MetricSample } from '@sandforge/shared';
import type { ConfigStore } from '../../core/storage/ConfigStore.js';
import { RingBuffer } from './RingBuffer.js';

/** Minimal logger surface — accepts pino-style structured warn calls. */
export interface MonitorLogger {
  warn(meta: Record<string, unknown>, msg?: string): void;
}

/** Approximate footprint of a single MetricSample after V8 boxing + tags. */
export const APPROX_BYTES_PER_SAMPLE = 96;

/** Default rolling window — matches TrendStorage 7-day cap. */
export const DEFAULT_RETENTION_DAYS = 7;

/** Default LRU memory ceiling. Above this, oldest series get evicted. */
export const DEFAULT_MAX_BYTES = 50 * 1024 * 1024;

/** Disk-flush cadence when persistence is opted in. Matches TrendStorage. */
export const PERSIST_FLUSH_INTERVAL_MS = 5 * 60 * 1000;

/** 30 s default — matches the standard probe schedule from Plan 03-03. */
const DEFAULT_INTERVAL_MS = 30_000;
const RETENTION_MS = DEFAULT_RETENTION_DAYS * 24 * 60 * 60 * 1000;

/** Per-series capacity derivation from probe interval (P-03.1). */
function capacityForInterval(intervalMs: number): number {
  if (intervalMs <= 0 || !Number.isFinite(intervalMs)) {
    return Math.ceil(RETENTION_MS / DEFAULT_INTERVAL_MS);
  }
  return Math.ceil(RETENTION_MS / intervalMs);
}

/** Composite key for the LRU log. */
function partitionKey(orgId: string, seriesId: string): string {
  return `${orgId}${seriesId}`;
}

/** Stats snapshot for the 5-min watchpoint logger (P-03.1). */
export interface TimeSeriesStats {
  totalSamples: number;
  estimatedBytes: number;
  perOrgBytes: Record<string, number>;
  perSeries: number;
}

/** Constructor options. */
export interface TimeSeriesStoreOptions {
  configStore?: ConfigStore;
  logger?: MonitorLogger;
  /** Opt-in disk persistence — default false. Wired in task 03-02-05. */
  persist?: boolean;
  maxBytes?: number;
  /** Override Date.now for testability. */
  now?: () => number;
}

/**
 * Per-(orgId, seriesId) ring-buffered MetricSample store with LRU memory cap.
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
  // Persistence wiring lands in task 03-02-05.
  // @ts-expect-error reserved for plan-03-02-task-05 (rehydrate + flush)
  private readonly configStore?: ConfigStore;
  // @ts-expect-error reserved for plan-03-02-task-05
  private readonly persist: boolean;
  private readonly nowFn: () => number;

  constructor(opts: TimeSeriesStoreOptions = {}) {
    this.maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
    this.logger = opts.logger;
    this.configStore = opts.configStore;
    this.persist = opts.persist ?? false;
    this.nowFn = opts.now ?? (() => Date.now());
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
      this.removeLruEntries((key) => key.startsWith(`${orgId}`));
      return;
    }
    this.partitions.clear();
    this.lruOrder.length = 0;
    this.estimatedBytes = 0;
  }

  /** Persistence rehydrate — populated in task 03-02-05. */
  async rehydrate(): Promise<void> {
    return;
  }

  /** Persistence flush — populated in task 03-02-05. */
  async flush(): Promise<void> {
    return;
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
    const sep = oldestKey.indexOf('');
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
