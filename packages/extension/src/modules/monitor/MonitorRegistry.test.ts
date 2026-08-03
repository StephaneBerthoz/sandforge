import { describe, it, expect, vi, afterEach } from 'vitest';
import type { MetricSample } from '@sandforge/shared';

import { MetricBus } from './MetricBus.js';
import { TimeSeriesStore } from './TimeSeriesStore.js';
import { MonitorRegistry } from './MonitorRegistry.js';
import type { MonitorProbe } from './MonitorProbe.js';

/** Build a sample with deterministic defaults. */
function sample(overrides: Partial<MetricSample> = {}): MetricSample {
  return {
    ts: '2099-05-02T10:00:00.000Z',
    seriesId: 'test.value',
    orgId: 'org-1',
    value: 1,
    ...overrides,
  };
}

/** Build a fresh logger spy. */
function buildLogger(): { warn: ReturnType<typeof vi.fn> } {
  return { warn: vi.fn() };
}

/** Build a fresh telemetry spy. */
function buildTelemetry(): { addBreadcrumb: ReturnType<typeof vi.fn> } {
  return { addBreadcrumb: vi.fn() };
}

/** A FAR_FUTURE store clock so query() always covers samples. */
const STORE_NOW = () => new Date('2199-01-01T00:00:00Z').getTime();

describe('MonitorRegistry', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('Test 1 — single-tick fires registered probe and sample is emitted via metricBus', async () => {
    vi.useFakeTimers();
    const bus = new MetricBus();
    const store = new TimeSeriesStore({ now: STORE_NOW });
    const registry = new MonitorRegistry({ metricBus: bus, timeSeriesStore: store });
    const handler = vi.fn();
    bus.subscribe('monitor:metric', handler);

    const probe: MonitorProbe = {
      id: 'p1',
      intervalMs: 5_000,
      priority: 'normal',
      run: vi.fn(async (orgId: string) => [sample({ orgId, seriesId: 'p1.value' })]),
    };
    registry.register(probe);
    registry.startOrg('org-1');

    // First tick (after 1s — tickFloor) fires the probe (initial nextRunAt = now).
    await vi.advanceTimersByTimeAsync(1_500);
    expect(probe.run).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledTimes(1);

    registry.dispose();
  });

  it('Test 2 — per-probe in-flight gate blocks duplicate dispatch (P-03.6)', async () => {
    vi.useFakeTimers();
    const bus = new MetricBus();
    const store = new TimeSeriesStore({ now: STORE_NOW });
    // Disable hard-timeout (very large) so it never short-circuits the long-running run.
    const registry = new MonitorRegistry({
      metricBus: bus,
      timeSeriesStore: store,
      hardTimeoutMs: 5 * 60 * 1000,
    });

    let resolveRun!: (samples: MetricSample[]) => void;
    const probe: MonitorProbe = {
      id: 'slow',
      intervalMs: 5_000,
      priority: 'normal',
      run: vi.fn(
        () =>
          new Promise<MetricSample[]>((res) => {
            resolveRun = res;
          }),
      ),
    };
    registry.register(probe);
    registry.startOrg('org-1');

    // Advance 50 s — many ticks would fire if the gate did not hold.
    await vi.advanceTimersByTimeAsync(50_000);
    expect(probe.run).toHaveBeenCalledTimes(1);

    // Resolve the long-running run; advance another tick to allow re-dispatch.
    resolveRun([sample({ seriesId: 'slow.value' })]);
    await vi.advanceTimersByTimeAsync(7_000);
    expect(probe.run).toHaveBeenCalledTimes(2);

    registry.dispose();
  });

  it('Test 3 — drift accounting: nextRunAt = lastFinishedAt + intervalMs (P-03.6)', async () => {
    vi.useFakeTimers();
    const bus = new MetricBus();
    const store = new TimeSeriesStore({ now: STORE_NOW });
    const startOfTest = Date.now();
    const registry = new MonitorRegistry({
      metricBus: bus,
      timeSeriesStore: store,
      now: () => Date.now(),
      hardTimeoutMs: 5 * 60 * 1000,
    });

    let resolveFirst!: (samples: MetricSample[]) => void;
    let calls = 0;
    const probe: MonitorProbe = {
      id: 'drift',
      intervalMs: 10_000, // tickRate = floor(10_000 / 4) = 2_500 ms
      priority: 'normal',
      run: vi.fn(async () => {
        calls++;
        if (calls === 1) {
          // Hold the first run.
          return new Promise<MetricSample[]>((res) => {
            resolveFirst = res;
          });
        }
        return [sample({ seriesId: 'drift.value' })];
      }),
    };
    registry.register(probe);
    registry.startOrg('org-1');

    // First tick fires at t = 2_500 ms (tick rate for 10 s interval).
    await vi.advanceTimersByTimeAsync(3_000);
    expect(probe.run).toHaveBeenCalledTimes(1);

    // At t≈3 s now, advance another 2 s → t≈5 s. Resolve first run.
    await vi.advanceTimersByTimeAsync(2_000);
    const finishTimeApprox = Date.now() - startOfTest;
    resolveFirst([sample({ seriesId: 'drift.value' })]);
    // Microtask tick to flush the finally block.
    await vi.advanceTimersByTimeAsync(0);

    // nextRunAt = finishedAt + 10 s. Below threshold, NO new dispatch.
    await vi.advanceTimersByTimeAsync(8_000);
    expect(probe.run).toHaveBeenCalledTimes(1);
    // Cross threshold: another tick fires the probe.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(probe.run).toHaveBeenCalledTimes(2);

    // Sanity: finish was around 5 s after test start.
    expect(finishTimeApprox).toBeGreaterThanOrEqual(4_500);
    expect(finishTimeApprox).toBeLessThanOrEqual(5_500);

    registry.dispose();
  });

  it('Test 4 — hard timeout: hung probe is killed + logged + breadcrumbed (P-03.6)', async () => {
    vi.useFakeTimers();
    const bus = new MetricBus();
    const store = new TimeSeriesStore({ now: STORE_NOW });
    const logger = buildLogger();
    const telemetry = buildTelemetry();
    const registry = new MonitorRegistry({
      metricBus: bus,
      timeSeriesStore: store,
      logger,
      telemetry,
      hardTimeoutMs: 5_000, // smaller for fast tests
    });

    const probe: MonitorProbe = {
      id: 'hung',
      intervalMs: 5_000,
      priority: 'normal',
      run: vi.fn(() => new Promise<MetricSample[]>(() => undefined)), // never resolves
    };
    registry.register(probe);
    registry.startOrg('org-1');

    await vi.advanceTimersByTimeAsync(1_500); // first tick → dispatch
    await vi.advanceTimersByTimeAsync(6_000); // beyond hard timeout

    expect(logger.warn).toHaveBeenCalled();
    const lastWarn = logger.warn.mock.calls.at(-1)![0] as string;
    expect(lastWarn).toMatch(/probe.*hung.*failed/i);
    expect(telemetry.addBreadcrumb).toHaveBeenCalledWith(
      expect.objectContaining({ category: 'monitor', message: 'probe-failed' }),
    );

    // After timeout, inFlight cleared.
    expect(registry.getStats().inFlightCount).toBe(0);

    registry.dispose();
  });

  it('Test 5 — visibility low-priority gating (audit M1, P-03.7)', async () => {
    vi.useFakeTimers();
    const bus = new MetricBus();
    const store = new TimeSeriesStore({ now: STORE_NOW });
    const registry = new MonitorRegistry({ metricBus: bus, timeSeriesStore: store });

    const critical: MonitorProbe = {
      id: 'crit',
      intervalMs: 5_000,
      priority: 'critical',
      run: vi.fn(async () => [sample({ seriesId: 'crit.value' })]),
    };
    const low: MonitorProbe = {
      id: 'low',
      intervalMs: 5_000,
      priority: 'low',
      run: vi.fn(async () => [sample({ seriesId: 'low.value' })]),
    };
    registry.register(critical);
    registry.register(low);
    registry.startOrg('org-1');

    // Hide.
    registry.setVisibility(true);
    // Hidden tick rate is 30 s — advance 31 s, only critical should run.
    await vi.advanceTimersByTimeAsync(31_000);
    expect(critical.run).toHaveBeenCalledTimes(1);
    expect(low.run).toHaveBeenCalledTimes(0);

    // Unhide; advance 2 s (back to 1.25-s tick); low fires.
    registry.setVisibility(false);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(low.run).toHaveBeenCalledTimes(1);

    registry.dispose();
  });

  it('Test 6 — MetricBus → TimeSeriesStore subscription wires samples into the store', async () => {
    vi.useFakeTimers();
    const bus = new MetricBus();
    const store = new TimeSeriesStore({ now: STORE_NOW });
    const registry = new MonitorRegistry({ metricBus: bus, timeSeriesStore: store });

    const probe: MonitorProbe = {
      id: 'wired',
      intervalMs: 5_000,
      priority: 'normal',
      run: vi.fn(async () => [sample({ orgId: 'org-A', seriesId: 'wired.value', value: 7 })]),
    };
    registry.register(probe);
    registry.startOrg('org-A');

    await vi.advanceTimersByTimeAsync(1_500);
    const recorded = store.query('org-A', 'wired.value');
    expect(recorded).toHaveLength(1);
    expect(recorded[0].value).toBe(7);

    registry.dispose();
  });

  it('Test 7 — dispose clears tick timer + inFlight + does not run new ticks', async () => {
    vi.useFakeTimers();
    const bus = new MetricBus();
    const store = new TimeSeriesStore({ now: STORE_NOW });
    const registry = new MonitorRegistry({ metricBus: bus, timeSeriesStore: store });

    const probe: MonitorProbe = {
      id: 'p',
      intervalMs: 5_000,
      priority: 'normal',
      run: vi.fn(async () => [sample({ seriesId: 'p.value' })]),
    };
    registry.register(probe);
    registry.startOrg('org-1');
    await vi.advanceTimersByTimeAsync(1_500);
    expect(probe.run).toHaveBeenCalledTimes(1);

    registry.dispose();
    const callsBefore = (probe.run as ReturnType<typeof vi.fn>).mock.calls.length;
    await vi.advanceTimersByTimeAsync(20_000);
    expect((probe.run as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callsBefore);
    expect(registry.getStats().inFlightCount).toBe(0);
    expect(registry.getStats().probeCount).toBe(0);
  });

  it('Test 8 — getStats accuracy', async () => {
    vi.useFakeTimers();
    const bus = new MetricBus();
    const store = new TimeSeriesStore({ now: STORE_NOW });
    const registry = new MonitorRegistry({ metricBus: bus, timeSeriesStore: store });

    let resolveSlow!: (samples: MetricSample[]) => void;
    const slow: MonitorProbe = {
      id: 'slow',
      intervalMs: 5_000,
      priority: 'normal',
      run: vi.fn(
        () =>
          new Promise<MetricSample[]>((res) => {
            resolveSlow = res;
          }),
      ),
    };
    const fast1: MonitorProbe = {
      id: 'fast1',
      intervalMs: 5_000,
      priority: 'normal',
      run: vi.fn(async () => [sample({ seriesId: 'fast1.value' })]),
    };
    const fast2: MonitorProbe = {
      id: 'fast2',
      intervalMs: 5_000,
      priority: 'normal',
      run: vi.fn(async () => [sample({ seriesId: 'fast2.value' })]),
    };
    registry.register(slow);
    registry.register(fast1);
    registry.register(fast2);
    registry.startOrg('o1');
    registry.startOrg('o2');

    await vi.advanceTimersByTimeAsync(1_500);
    const stats = registry.getStats();
    expect(stats.probeCount).toBe(3);
    expect(stats.activeOrgCount).toBe(2);
    // 2 orgs × 1 slow probe = 2 in-flight slow runs (fast probes finished
    // synchronously). Fast probes resolved in microtask, so inFlight = 2.
    expect(stats.inFlightCount).toBe(2);

    resolveSlow([sample({ seriesId: 'slow.value' })]);
    registry.dispose();
  });

  it('Test 9 — Plan 03-03 vertical slice: 5s probe survives 60s tick storm without overlap or drift', async () => {
    vi.useFakeTimers();
    const bus = new MetricBus();
    const store = new TimeSeriesStore({ now: STORE_NOW });
    const registry = new MonitorRegistry({ metricBus: bus, timeSeriesStore: store });

    let invocations = 0;
    let activeRuns = 0;
    let maxConcurrent = 0;
    const slowProbe: MonitorProbe = {
      id: 'test.slow',
      intervalMs: 5_000,
      priority: 'normal',
      async run(orgId) {
        invocations++;
        activeRuns++;
        maxConcurrent = Math.max(maxConcurrent, activeRuns);
        await new Promise<void>((r) => setTimeout(r, 5_000));
        activeRuns--;
        return [
          {
            ts: new Date(2099, 0, 1, 0, 0, invocations).toISOString(),
            orgId,
            seriesId: 'test.slow.value',
            value: invocations,
          },
        ];
      },
    };
    registry.register(slowProbe);
    registry.startOrg('org-1');

    // Advance 60 s in 100 ms increments.
    for (let t = 0; t < 600; t++) {
      await vi.advanceTimersByTimeAsync(100);
    }

    expect(maxConcurrent).toBe(1); // P-03.6 in-flight gate held.
    // Each cycle takes 5 s run + 5 s wait = 10 s → ~6 in 60 s. Allow [4, 8] band.
    expect(invocations).toBeGreaterThanOrEqual(4);
    expect(invocations).toBeLessThanOrEqual(8);
    const stored = store.query('org-1', 'test.slow.value');
    expect(stored.length).toBe(invocations);

    registry.dispose();
  });
});
