/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import fc from 'fast-check';
import type { MetricSample, AlertInstance } from '@sandforge/shared';

import { AnomalyEngine, type AnomalyDetectedEvent } from './AnomalyEngine.js';
import { MetricBus } from './MetricBus.js';
import { TimeSeriesStore } from './TimeSeriesStore.js';
import { AlertEngine, SYNTHETIC_ANOMALY_DEFINITION_ID } from './AlertEngine.js';
import { MIN_SAMPLES_FOR_BASELINE, MIN_BASELINE_SPAN_MS } from './anomaly-math.js';
import {
  metricSampleArb,
  orderedSamplesForOneSeriesArb,
} from '../../test/arbitraries.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

const ORG = 'org-1';
const SERIES = 'limits.api';

/** Build a MetricSample at a given epoch ms with a given value. */
function sampleAt(value: number, ts: number, orgId = ORG, seriesId = SERIES): MetricSample {
  return { ts: new Date(ts).toISOString(), orgId, seriesId, value };
}

/** Push N samples with `value` evenly spread across `[start, start + spanMs]`. */
function pushBaseline(
  store: TimeSeriesStore,
  count: number,
  spanMs: number,
  startMs: number,
  value: number | ((i: number) => number) = 50,
): MetricSample[] {
  const out: MetricSample[] = [];
  for (let i = 0; i < count; i++) {
    const ts = startMs + (count <= 1 ? 0 : (i * spanMs) / (count - 1));
    const v = typeof value === 'function' ? value(i) : value;
    const s = sampleAt(v, ts);
    store.record(s, { intervalMs: 30_000 });
    out.push(s);
  }
  return out;
}

/** Push a baseline of `count` samples with mean=50 stdDev≈5 (sin wave) over `spanMs`. */
function pushSinBaseline(
  store: TimeSeriesStore,
  count: number,
  spanMs: number,
  startMs: number,
): MetricSample[] {
  return pushBaseline(store, count, spanMs, startMs, (i) => 50 + Math.sin(i / 7) * 5);
}

/** Push a baseline with controlled mean/stdDev using a deterministic linear oscillation. */
function pushControlledBaseline(
  store: TimeSeriesStore,
  count: number,
  spanMs: number,
  startMs: number,
  mean: number,
  stdDev: number,
): MetricSample[] {
  // Alternating +stdDev / -stdDev gives population std-dev exactly = stdDev for even n.
  return pushBaseline(store, count, spanMs, startMs, (i) =>
    mean + (i % 2 === 0 ? stdDev : -stdDev),
  );
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('AnomalyEngine', () => {
  // 24h baseline span — well over the 6h MIN_BASELINE_SPAN_MS gate.
  const SIX_HOURS = 6 * 60 * 60 * 1000;
  const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000;
  const NOW = new Date('2099-01-02T00:00:00Z').getTime();

  let bus: MetricBus;
  let store: TimeSeriesStore;
  let engine: AnomalyEngine;
  let nowFn: () => number;

  beforeEach(() => {
    bus = new MetricBus({ coalesceWindowMs: 0 });
    store = new TimeSeriesStore({ now: () => NOW });
    nowFn = vi.fn(() => NOW);
    engine = new AnomalyEngine({
      metricBus: bus,
      timeSeriesStore: store,
      now: nowFn,
    });
  });

  // ── Unit tests (10) ─────────────────────────────────────────────────────

  it('Test 1 — cold start: no warmup → null + telemetry breadcrumb logged', () => {
    const telemetry = { addBreadcrumb: vi.fn() };
    engine = new AnomalyEngine({
      metricBus: bus,
      timeSeriesStore: store,
      now: nowFn,
      telemetry,
    });
    // 5 samples in baseline — well below MIN_SAMPLES_FOR_BASELINE (30).
    pushBaseline(store, 5, SIX_HOURS, NOW - SIX_HOURS, 50);
    const probe = sampleAt(80, NOW);
    store.record(probe, { intervalMs: 30_000 });

    const result = engine.evaluate(probe);

    expect(result).toBeNull();
    expect(telemetry.addBreadcrumb).toHaveBeenCalledTimes(1);
    expect(telemetry.addBreadcrumb).toHaveBeenCalledWith(
      expect.stringContaining('anomaly-suppressed-warmup'),
      'monitor',
      'info',
    );
  });

  it('Test 2 — insufficient span: 30 samples in 1 hour → null', () => {
    pushBaseline(store, MIN_SAMPLES_FOR_BASELINE, 60 * 60 * 1000, NOW - 60 * 60 * 1000, 50);
    const probe = sampleAt(99, NOW);
    store.record(probe, { intervalMs: 30_000 });

    expect(engine.evaluate(probe)).toBeNull();
  });

  it('Test 3 — warmed up: 30 samples spanning 6h → can emit', () => {
    pushControlledBaseline(store, MIN_SAMPLES_FOR_BASELINE, MIN_BASELINE_SPAN_MS, NOW - SIX_HOURS, 50, 5);
    // 6σ outlier well above effectiveThreshold (3 * (1 + 1/sqrt(30)) ≈ 3.55).
    const probe = sampleAt(50 + 5 * 6, NOW);
    store.record(probe, { intervalMs: 30_000 });

    const result = engine.evaluate(probe);

    expect(result).not.toBeNull();
    expect(result?.orgId).toBe(ORG);
    expect(result?.seriesId).toBe(SERIES);
  });

  it('Test 4 — outlier above threshold → emit AnomalyDetectedEvent with full shape', () => {
    pushControlledBaseline(store, 100, TWENTY_FOUR_HOURS, NOW - TWENTY_FOUR_HOURS, 50, 5);
    const probe = sampleAt(80, NOW); // (80-50)/5 = 6σ
    store.record(probe, { intervalMs: 30_000 });

    const result = engine.evaluate(probe);

    expect(result).not.toBeNull();
    expect(result!.orgId).toBe(ORG);
    expect(result!.seriesId).toBe(SERIES);
    expect(result!.value).toBe(80);
    expect(result!.mean).toBeCloseTo(50, 0);
    expect(result!.stdDev).toBeCloseTo(5, 0);
    expect(result!.zScore).toBeGreaterThan(3);
    expect(result!.recentContext).toHaveLength(10);
    expect(result!.detectedAt).toBe(new Date(NOW).toISOString());
  });

  it('Test 5 — within threshold → null', () => {
    pushControlledBaseline(store, 100, TWENTY_FOUR_HOURS, NOW - TWENTY_FOUR_HOURS, 50, 5);
    const probe = sampleAt(53, NOW); // (53-50)/5 = 0.6σ
    store.record(probe, { intervalMs: 30_000 });

    expect(engine.evaluate(probe)).toBeNull();
  });

  it('Test 6 — constant series stdDev=0 → null', () => {
    pushBaseline(store, 100, TWENTY_FOUR_HOURS, NOW - TWENTY_FOUR_HOURS, 42);
    const probe = sampleAt(9999, NOW);
    store.record(probe, { intervalMs: 30_000 });

    expect(engine.evaluate(probe)).toBeNull();
  });

  it('Test 7 — sigma scale-up at low n: 3.5σ does NOT trigger but 4σ does', () => {
    // 35 samples → effectiveThreshold = 3 * (1 + 1/sqrt(35)) ≈ 3.507.
    pushControlledBaseline(store, 35, MIN_BASELINE_SPAN_MS, NOW - SIX_HOURS, 50, 5);
    // 3.4σ — value 50 + 3.4*5 = 67. Should NOT trigger.
    const subThreshold = sampleAt(67, NOW);
    store.record(subThreshold, { intervalMs: 30_000 });
    expect(engine.evaluate(subThreshold)).toBeNull();

    // Re-prime for the second probe (record() pushed subThreshold into the
    // baseline) — clear and re-baseline so test 7 stays self-contained.
    store.clear(ORG);
    pushControlledBaseline(store, 35, MIN_BASELINE_SPAN_MS, NOW - SIX_HOURS, 50, 5);
    // 4σ — value 50 + 4*5 = 70. Should trigger.
    const overThreshold = sampleAt(70, NOW);
    store.record(overThreshold, { intervalMs: 30_000 });
    expect(engine.evaluate(overThreshold)).not.toBeNull();
  });

  it('Test 8 — recentContext is exactly 10 samples', () => {
    pushControlledBaseline(store, 50, TWENTY_FOUR_HOURS, NOW - TWENTY_FOUR_HOURS, 50, 5);
    const probe = sampleAt(80, NOW);
    store.record(probe, { intervalMs: 30_000 });

    const result = engine.evaluate(probe);

    expect(result).not.toBeNull();
    expect(result!.recentContext).toHaveLength(10);
  });

  it('Test 9 — suppression-log throttling: 5 cold-start probes → only 1 breadcrumb', () => {
    const telemetry = { addBreadcrumb: vi.fn() };
    engine = new AnomalyEngine({
      metricBus: bus,
      timeSeriesStore: store,
      now: nowFn,
      telemetry,
    });
    for (let i = 0; i < 5; i++) {
      const probe = sampleAt(50, NOW + i * 1000);
      store.record(probe, { intervalMs: 30_000 });
      engine.evaluate(probe);
    }
    expect(telemetry.addBreadcrumb).toHaveBeenCalledTimes(1);
  });

  it('Test 10 — dispose unsubscribes from bus', () => {
    const evaluateSpy = vi.spyOn(engine, 'evaluate');
    engine.start();
    bus.emit('monitor:metric', sampleAt(50, NOW));
    expect(evaluateSpy).toHaveBeenCalledTimes(1);

    engine.dispose();
    bus.emit('monitor:metric', sampleAt(60, NOW + 1000));
    // Still only 1 — dispose unsubscribed the bus listener.
    expect(evaluateSpy).toHaveBeenCalledTimes(1);
  });

  // ── Property tests (3, 100 runs each) ───────────────────────────────────

  describe('property tests', () => {
    it('Property 1 — sub-warmup sequences NEVER emit anomalies', () => {
      fc.assert(
        fc.property(
          fc.array(metricSampleArb, { minLength: 0, maxLength: MIN_SAMPLES_FOR_BASELINE - 1 }),
          (samples) => {
            const localBus = new MetricBus({ coalesceWindowMs: 0 });
            const localStore = new TimeSeriesStore({ now: () => NOW });
            const localEngine = new AnomalyEngine({
              metricBus: localBus,
              timeSeriesStore: localStore,
              now: () => NOW,
            });
            const anomalies: AnomalyDetectedEvent[] = [];
            localBus.subscribe('monitor:anomaly:detected', (ev) =>
              anomalies.push(ev as AnomalyDetectedEvent),
            );
            // Force shared org/series so every sample feeds the same baseline.
            const normalized = samples.map((s) => ({ ...s, orgId: ORG, seriesId: SERIES }));
            for (const s of normalized) {
              localStore.record(s, { intervalMs: 30_000 });
              localEngine.evaluate(s);
            }
            expect(anomalies).toHaveLength(0);
            localEngine.dispose();
          },
        ),
        { numRuns: 100 },
      );
    });

    it('Property 2 — anomaly count is bounded by total sample count', () => {
      fc.assert(
        fc.property(orderedSamplesForOneSeriesArb, (samples) => {
          const localBus = new MetricBus({ coalesceWindowMs: 0 });
          const localStore = new TimeSeriesStore({ now: () => NOW });
          const localEngine = new AnomalyEngine({
            metricBus: localBus,
            timeSeriesStore: localStore,
            now: () => NOW,
          });
          let anomalyCount = 0;
          let nominalCount = 0;
          for (const s of samples) {
            localStore.record(s, { intervalMs: 30_000 });
            const ev = localEngine.evaluate(s);
            if (ev) anomalyCount++;
            else nominalCount++;
          }
          expect(anomalyCount + nominalCount).toBe(samples.length);
          expect(anomalyCount).toBeLessThanOrEqual(samples.length);
          localEngine.dispose();
        }),
        { numRuns: 100 },
      );
    });

    it('Property 3 — constant-value series NEVER emits anomalies regardless of length', () => {
      fc.assert(
        fc.property(
          fc.float({
            min: Math.fround(-1e6),
            max: Math.fround(1e6),
            noNaN: true,
            noDefaultInfinity: true,
          }),
          fc.integer({ min: 30, max: 200 }),
          (constantValue, count) => {
            const localBus = new MetricBus({ coalesceWindowMs: 0 });
            const localStore = new TimeSeriesStore({ now: () => NOW });
            const localEngine = new AnomalyEngine({
              metricBus: localBus,
              timeSeriesStore: localStore,
              now: () => NOW,
            });
            const anomalies: AnomalyDetectedEvent[] = [];
            localBus.subscribe('monitor:anomaly:detected', (ev) =>
              anomalies.push(ev as AnomalyDetectedEvent),
            );
            // Span 24h so warmup gate passes once n >= 30.
            const samples = pushBaseline(
              localStore,
              count,
              TWENTY_FOUR_HOURS,
              NOW - TWENTY_FOUR_HOURS,
              constantValue,
            );
            for (const s of samples) {
              localEngine.evaluate(s);
            }
            // Throwing a wildly different value at the end still must NOT fire
            // because stdDev of the baseline is 0.
            const probe = sampleAt(constantValue + 9999, NOW);
            localStore.record(probe, { intervalMs: 30_000 });
            localEngine.evaluate(probe);
            expect(anomalies).toHaveLength(0);
            localEngine.dispose();
          },
        ),
        { numRuns: 100 },
      );
    });
  });

  // ── Plan 03-05 vertical slice ──────────────────────────────────────────

  it('Plan 03-05 vertical slice: 100 monotone samples + 1 outlier emits exactly 1 anomaly + bridges to AlertEngine', () => {
    const localBus = new MetricBus({ coalesceWindowMs: 0 });
    const localStore = new TimeSeriesStore({ now: () => NOW });
    const alertInstances: AlertInstance[] = [];
    const alertEngine = new AlertEngine((alert) => alertInstances.push(alert));
    const anomalies: AnomalyDetectedEvent[] = [];

    localBus.subscribe('monitor:anomaly:detected', (payload) => {
      anomalies.push(payload as AnomalyDetectedEvent);
    });
    localBus.subscribe('monitor:anomaly:detected', (payload) => {
      const event: AnomalyDetectedEvent = {
        ...(payload as AnomalyDetectedEvent),
        detectedAt: new Date(NOW).toISOString(),
      };
      alertEngine.submitAnomalyInstance(event);
    });

    const localEngine = new AnomalyEngine({
      metricBus: localBus,
      timeSeriesStore: localStore,
      now: () => NOW,
    });
    localEngine.start();

    // 100 baseline samples spanning 24h, mean ≈ 50 with sin oscillation.
    const dayStart = NOW - TWENTY_FOUR_HOURS;
    for (let i = 0; i < 100; i++) {
      const s = sampleAt(50 + Math.sin(i / 7) * 5, dayStart + (i * TWENTY_FOUR_HOURS) / 100);
      localStore.record(s, { intervalMs: 30_000 });
      localBus.emit('monitor:metric', s);
    }

    // No anomalies during baseline — every sample is within 1σ.
    expect(anomalies).toHaveLength(0);

    // Inject the outlier at value=80 (~6σ from baseline).
    const outlier = sampleAt(80, NOW);
    localStore.record(outlier, { intervalMs: 30_000 });
    localBus.emit('monitor:metric', outlier);

    // Exactly 1 anomaly emitted.
    expect(anomalies).toHaveLength(1);
    expect(anomalies[0].zScore).toBeGreaterThan(3);
    expect(anomalies[0].recentContext).toHaveLength(10);
    expect(anomalies[0].mean).toBeCloseTo(50, 0);

    // AlertEngine bridge fired — exactly 1 synthetic AlertInstance.
    expect(alertInstances).toHaveLength(1);
    expect(alertInstances[0].badge).toBe('anomaly');
    expect(alertInstances[0].definitionId).toBe(SYNTHETIC_ANOMALY_DEFINITION_ID);
    expect(alertInstances[0].severity).toBe('critical'); // |z| >= 5
    expect(alertInstances[0].metadata).toMatchObject({
      mean: expect.any(Number),
      stdDev: expect.any(Number),
      zScore: expect.any(Number),
      recentContext: expect.any(Array),
    });

    localEngine.dispose();
  });
});
