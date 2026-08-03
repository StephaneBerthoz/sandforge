import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fc from 'fast-check';
import type { MetricSample } from '@sandforge/shared';
import type { ConfigStore } from '../../core/storage/ConfigStore.js';
import {
  TimeSeriesStore,
  APPROX_BYTES_PER_SAMPLE,
  PERSIST_KEY_PREFIX,
  PERSIST_PER_ORG_RATE_LIMIT_MS,
  type MonitorLogger,
  type MonitorTelemetry,
} from './TimeSeriesStore.js';
import { metricSampleArb, orderedSamplesForOneSeriesArb } from '../../test/arbitraries.js';

/**
 * Use a fixed past timestamp so query() default upper-bound (Date.now())
 * always covers the sample range regardless of when the test runs.
 */
const BASE_MS = new Date('2024-01-01T00:00:00Z').getTime();
const FAR_FUTURE_MS = new Date('2099-01-01T00:00:00Z').getTime();
const FIXED_NOW = () => FAR_FUTURE_MS;

/** In-memory ConfigStore stub matching the methods TimeSeriesStore uses. */
function createMockConfigStore(): {
  store: ConfigStore;
  data: Record<string, string>;
  setSpy: ReturnType<typeof vi.fn>;
  deleteSpy: ReturnType<typeof vi.fn>;
} {
  const data: Record<string, string> = {};
  const setSpy = vi.fn((key: string, value: unknown) => {
    data[key] = JSON.stringify(value);
  });
  const deleteSpy = vi.fn((key: string) => {
    if (!(key in data)) return false;
    delete data[key];
    return true;
  });
  const stub = {
    get: vi.fn(<T>(key: string): T | undefined => {
      const raw = data[key];
      if (raw === undefined) return undefined;
      try {
        return JSON.parse(raw) as T;
      } catch {
        return undefined;
      }
    }),
    set: setSpy,
    delete: deleteSpy,
    has: vi.fn((key: string) => key in data),
    getKeysByPrefix: vi.fn((prefix: string) =>
      Object.keys(data).filter((k) => k.startsWith(prefix)),
    ),
  };
  return { store: stub as unknown as ConfigStore, data, setSpy, deleteSpy };
}

function sample(overrides: Partial<MetricSample> = {}): MetricSample {
  return {
    ts: new Date(BASE_MS).toISOString(),
    seriesId: 's1',
    orgId: 'o1',
    value: 1,
    ...overrides,
  };
}

describe('TimeSeriesStore — unit', () => {
  it('record + query basic returns chronological samples', () => {
    const store = new TimeSeriesStore({ now: FIXED_NOW });
    store.record(sample({ ts: new Date(BASE_MS).toISOString(), value: 1 }));
    store.record(sample({ ts: new Date(BASE_MS + 60_000).toISOString(), value: 2 }));
    store.record(sample({ ts: new Date(BASE_MS + 120_000).toISOString(), value: 3 }));
    const result = store.query('o1', 's1');
    expect(result).toHaveLength(3);
    expect(result.map((s) => s.value)).toEqual([1, 2, 3]);
  });

  it('time-window query filters by ts range', () => {
    const store = new TimeSeriesStore({ now: FIXED_NOW });
    for (let i = 0; i < 10; i++) {
      store.record(sample({ ts: new Date(BASE_MS + i * 6 * 60_000).toISOString(), value: i }));
    }
    const fromMs = BASE_MS + 18 * 60_000;
    const toMs = BASE_MS + 36 * 60_000;
    const result = store.query('o1', 's1', fromMs, toMs);
    expect(result.map((s) => s.value)).toEqual([3, 4, 5, 6]);
  });

  it('per-series capacity caps at ceil(7d / intervalMs) — 30s probe', () => {
    const store = new TimeSeriesStore({ now: FIXED_NOW });
    const cap = Math.ceil((7 * 24 * 60 * 60 * 1000) / 30_000);
    for (let i = 0; i < cap + 100; i++) {
      store.record(sample({ ts: new Date(BASE_MS + i * 1000).toISOString(), value: i }), {
        intervalMs: 30_000,
      });
    }
    const result = store.query('o1', 's1');
    expect(result.length).toBe(cap);
  });

  it('LRU evicts oldest partition when over byte cap', () => {
    const store = new TimeSeriesStore({
      now: FIXED_NOW,
      maxBytes: APPROX_BYTES_PER_SAMPLE * 5,
    });
    store.record(sample({ orgId: 'old-org', seriesId: 's1' }));
    store.record(sample({ orgId: 'old-org', seriesId: 's2' }));
    for (let i = 0; i < 6; i++) {
      store.record(sample({ orgId: 'new-org', seriesId: `s${i}`, value: i }));
    }
    const stats = store.getStats();
    expect(stats.estimatedBytes).toBeLessThanOrEqual(APPROX_BYTES_PER_SAMPLE * 5);
    expect(stats.perOrgBytes['old-org']).toBeUndefined();
  });

  it('getStats accuracy across multiple orgs and series', () => {
    const store = new TimeSeriesStore({ now: FIXED_NOW });
    for (const orgId of ['o1', 'o2']) {
      for (const seriesId of ['s1', 's2', 's3']) {
        for (let i = 0; i < 17; i++) {
          store.record(
            sample({ orgId, seriesId, value: i, ts: new Date(BASE_MS + i * 1000).toISOString() }),
          );
        }
      }
    }
    const stats = store.getStats();
    expect(stats.totalSamples).toBe(2 * 3 * 17);
    expect(Object.keys(stats.perOrgBytes).sort()).toEqual(['o1', 'o2']);
    expect(stats.perSeries).toBe(6);
  });

  it('persistence opt-in disabled by default — flush is a no-op', async () => {
    const { store: cfg, setSpy } = createMockConfigStore();
    const store = new TimeSeriesStore({ configStore: cfg, now: FIXED_NOW });
    store.record(sample());
    await store.flush();
    expect(setSpy).not.toHaveBeenCalled();
  });

  it('persistence opt-in round-trip preserves samples', async () => {
    const { store: cfg } = createMockConfigStore();
    const writer = new TimeSeriesStore({ configStore: cfg, persist: true, now: FIXED_NOW });
    for (let i = 1; i <= 5; i++) {
      writer.record(sample({ ts: new Date(BASE_MS + i * 60_000).toISOString(), value: i }));
    }
    await writer.flush();
    writer.dispose();

    const reader = new TimeSeriesStore({ configStore: cfg, persist: true, now: FIXED_NOW });
    await reader.rehydrate();
    const result = reader.query('o1', 's1');
    expect(result).toHaveLength(5);
    expect(result.map((s) => s.value)).toEqual([1, 2, 3, 4, 5]);
    reader.dispose();
  });

  it('rehydrate corrupted entry — drops + breadcrumbs but does not throw (P-03.10)', async () => {
    const { store: cfg, data, deleteSpy } = createMockConfigStore();
    // Make get<string>(key) return a string that is itself invalid JSON, so
    // the rehydrate JSON.parse throws and the catch path fires.
    data[`${PERSIST_KEY_PREFIX}o1`] = JSON.stringify('not-a-valid-payload-{');
    const logger: MonitorLogger = { warn: vi.fn() };
    const telemetry: MonitorTelemetry = { addBreadcrumb: vi.fn() };
    const store = new TimeSeriesStore({
      configStore: cfg,
      persist: true,
      logger,
      telemetry,
      now: FIXED_NOW,
    });
    await expect(store.rehydrate()).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalled();
    expect(telemetry.addBreadcrumb).toHaveBeenCalledWith(
      expect.objectContaining({
        category: 'monitor',
        message: expect.stringContaining('corrupted'),
      }),
    );
    expect(deleteSpy).toHaveBeenCalledWith(`${PERSIST_KEY_PREFIX}o1`);
    expect(store.getStats().totalSamples).toBe(0);
    store.dispose();
  });

  it('per-org rate limit blocks early second flush', async () => {
    let now = 1_000_000_000;
    const { store: cfg, setSpy } = createMockConfigStore();
    const store = new TimeSeriesStore({
      configStore: cfg,
      persist: true,
      now: () => now,
    });
    store.record(sample());
    await store.flush();
    expect(setSpy).toHaveBeenCalledTimes(1);
    now += 10 * 60 * 1000;
    await store.flush();
    expect(setSpy).toHaveBeenCalledTimes(1);
    now += PERSIST_PER_ORG_RATE_LIMIT_MS;
    await store.flush();
    expect(setSpy).toHaveBeenCalledTimes(2);
    store.dispose();
  });
});

describe('TimeSeriesStore — properties', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it('property: capacity invariant — query length always ≤ ceil(7d / intervalMs)', () => {
    const cap = Math.ceil((7 * 24 * 60 * 60 * 1000) / 30_000);
    fc.assert(
      fc.property(orderedSamplesForOneSeriesArb, (samples) => {
        const store = new TimeSeriesStore({ now: FIXED_NOW });
        for (const s of samples) {
          store.record(s, { intervalMs: 30_000 });
        }
        const result = store.query(samples[0].orgId, samples[0].seriesId);
        return result.length <= cap;
      }),
      { numRuns: 100 },
    );
  });

  it('property: order invariant — query returns non-decreasing ts', () => {
    fc.assert(
      fc.property(orderedSamplesForOneSeriesArb, (samples) => {
        const store = new TimeSeriesStore({ now: FIXED_NOW });
        for (const s of samples) store.record(s);
        const result = store.query(samples[0].orgId, samples[0].seriesId);
        for (let i = 1; i < result.length; i++) {
          if (new Date(result[i].ts).getTime() < new Date(result[i - 1].ts).getTime()) {
            return false;
          }
        }
        return true;
      }),
      { numRuns: 100 },
    );
  });

  it('property: bytes-cap invariant — estimatedBytes ≤ maxBytes', () => {
    fc.assert(
      fc.property(fc.array(metricSampleArb, { minLength: 1, maxLength: 500 }), (samples) => {
        const maxBytes = APPROX_BYTES_PER_SAMPLE * 50;
        const store = new TimeSeriesStore({ maxBytes, now: FIXED_NOW });
        for (const s of samples) store.record(s);
        return store.getStats().estimatedBytes <= maxBytes;
      }),
      { numRuns: 100 },
    );
  });
});

describe('TimeSeriesStore — Plan 03-02 vertical slice', () => {
  it('50K samples + LRU + query + getStats invariants all hold', () => {
    const store = new TimeSeriesStore({ maxBytes: 1_000_000, now: FIXED_NOW });
    const start = BASE_MS;
    for (let i = 0; i < 50_000; i++) {
      store.record(
        {
          ts: new Date(start + i * 30_000).toISOString(),
          orgId: `org-${i % 5}`,
          seriesId: `series-${i % 20}`,
          value: i,
        },
        { intervalMs: 30_000 },
      );
    }
    const stats = store.getStats();
    expect(stats.totalSamples).toBeGreaterThan(0);
    expect(stats.estimatedBytes).toBeLessThanOrEqual(1_000_000);

    const cap = Math.ceil((7 * 24 * 60 * 60 * 1000) / 30_000);
    for (const orgId of Object.keys(stats.perOrgBytes)) {
      for (let s = 0; s < 20; s++) {
        const samples = store.query(orgId, `series-${s}`);
        expect(samples.length).toBeLessThanOrEqual(cap);
      }
    }
  });
});
