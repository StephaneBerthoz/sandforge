import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import type { MetricSample } from '@sandforge/shared';

import {
  windowOf,
  rollingMean,
  rollingStdDev,
  zScore,
  effectiveThreshold,
  isWarmedUp,
  MIN_SAMPLES_FOR_BASELINE,
  MIN_BASELINE_SPAN_MS,
  DEFAULT_WINDOW_MS,
  DEFAULT_SIGMA_THRESHOLD,
} from './anomaly-math.js';
import {
  metricSampleArb,
  orderedSamplesForOneSeriesArb,
} from '../../test/arbitraries.js';

/** Build a synthetic MetricSample with deterministic ts. */
function sample(value: number, ts: string = new Date(0).toISOString()): MetricSample {
  return { ts, seriesId: 'test', orgId: 'org-1', value };
}

/** Build a chronological run of samples spanning `spanMs` total. */
function spanSamples(count: number, spanMs: number, value: number = 0): MetricSample[] {
  const out: MetricSample[] = [];
  if (count === 0) return out;
  const step = count <= 1 ? 0 : spanMs / (count - 1);
  for (let i = 0; i < count; i++) {
    out.push(sample(value, new Date(i * step).toISOString()));
  }
  return out;
}

describe('anomaly-math', () => {
  describe('exported constants', () => {
    it('matches the documented contract', () => {
      expect(MIN_SAMPLES_FOR_BASELINE).toBe(30);
      expect(MIN_BASELINE_SPAN_MS).toBe(6 * 60 * 60 * 1000);
      expect(DEFAULT_WINDOW_MS).toBe(24 * 60 * 60 * 1000);
      expect(DEFAULT_SIGMA_THRESHOLD).toBe(3);
    });
  });

  describe('rollingMean', () => {
    it('returns the value of a 1-sample series', () => {
      expect(rollingMean([sample(42)])).toBe(42);
    });

    it('returns 0 on empty array', () => {
      expect(rollingMean([])).toBe(0);
    });

    it('computes the arithmetic mean of [1,2,3,4,5]', () => {
      const samples = [1, 2, 3, 4, 5].map((v) => sample(v));
      expect(rollingMean(samples)).toBe(3);
    });
  });

  describe('rollingStdDev', () => {
    it('returns 0 for constant samples', () => {
      const samples = Array.from({ length: 10 }, () => sample(7));
      expect(rollingStdDev(samples)).toBe(0);
    });

    it('returns 0 for n < 2', () => {
      expect(rollingStdDev([])).toBe(0);
      expect(rollingStdDev([sample(5)])).toBe(0);
    });

    it('computes population std-dev of [1,2,3,4,5] = sqrt(2)', () => {
      const samples = [1, 2, 3, 4, 5].map((v) => sample(v));
      const sd = rollingStdDev(samples);
      expect(sd).toBeCloseTo(Math.sqrt(2), 6);
    });

    it('reuses an externally provided mean when given', () => {
      const samples = [1, 2, 3, 4, 5].map((v) => sample(v));
      // Wrong mean on purpose — verifies the param is consumed (no recompute).
      const sd = rollingStdDev(samples, 0);
      expect(sd).not.toBeCloseTo(Math.sqrt(2), 6);
    });
  });

  describe('zScore', () => {
    it('returns 0 when value equals mean', () => {
      expect(zScore(50, 50, 5)).toBe(0);
    });

    it('returns 0 when stdDev is 0 (no division by zero)', () => {
      expect(zScore(50, 0, 0)).toBe(0);
    });

    it('returns the right magnitude for known inputs', () => {
      expect(zScore(60, 50, 5)).toBe(2);
      expect(zScore(35, 50, 5)).toBe(-3);
    });
  });

  describe('effectiveThreshold', () => {
    it('returns baseSigma unchanged for n >= 100', () => {
      expect(effectiveThreshold(3, 100)).toBe(3);
      expect(effectiveThreshold(3, 200)).toBe(3);
    });

    it('scales up at low n by (1 + 1/sqrt(n))', () => {
      // n=9 → 3 * (1 + 1/3) = 4
      expect(effectiveThreshold(3, 9)).toBe(4);
    });

    it('clamps n to 1 to avoid divide-by-zero on degenerate inputs', () => {
      expect(effectiveThreshold(3, 0)).toBe(6); // 3 * (1 + 1/sqrt(1))
    });
  });

  describe('isWarmedUp', () => {
    it('returns false on empty', () => {
      expect(isWarmedUp([])).toBe(false);
    });

    it('returns false when sample count < MIN_SAMPLES_FOR_BASELINE', () => {
      const samples = spanSamples(MIN_SAMPLES_FOR_BASELINE - 1, MIN_BASELINE_SPAN_MS);
      expect(isWarmedUp(samples)).toBe(false);
    });

    it('returns false when span < MIN_BASELINE_SPAN_MS even at MIN_SAMPLES count', () => {
      // 30 samples spread over 5 hours → span < 6h
      const samples = spanSamples(MIN_SAMPLES_FOR_BASELINE, 5 * 60 * 60 * 1000);
      expect(isWarmedUp(samples)).toBe(false);
    });

    it('returns true at MIN_SAMPLES + MIN_SPAN', () => {
      const samples = spanSamples(MIN_SAMPLES_FOR_BASELINE, MIN_BASELINE_SPAN_MS);
      expect(isWarmedUp(samples)).toBe(true);
    });
  });

  describe('windowOf', () => {
    it('returns [] on empty input', () => {
      expect(windowOf([], Date.now())).toEqual([]);
    });

    it('keeps only samples within [now - window, now]', () => {
      const now = 100_000;
      const win = 10_000;
      const samples = [
        sample(1, new Date(80_000).toISOString()), // outside
        sample(2, new Date(91_000).toISOString()), // inside
        sample(3, new Date(99_000).toISOString()), // inside
      ];
      const result = windowOf(samples, now, win);
      expect(result.map((s) => s.value)).toEqual([2, 3]);
    });
  });

  // ── Property tests (3, 100 runs each) ─────────────────────
  describe('property tests', () => {
    it('rollingMean is bounded by min(values) <= mean <= max(values)', () => {
      fc.assert(
        fc.property(orderedSamplesForOneSeriesArb, (samples) => {
          const mean = rollingMean(samples);
          const values = samples.map((s) => s.value);
          const min = Math.min(...values);
          const max = Math.max(...values);
          // Tolerate float jitter at the bounds.
          expect(mean).toBeGreaterThanOrEqual(min - 1e-6);
          expect(mean).toBeLessThanOrEqual(max + 1e-6);
        }),
        { numRuns: 100 },
      );
    });

    it('rollingStdDev is non-negative for any sample sequence', () => {
      fc.assert(
        fc.property(orderedSamplesForOneSeriesArb, (samples) => {
          const sd = rollingStdDev(samples);
          expect(sd).toBeGreaterThanOrEqual(0);
        }),
        { numRuns: 100 },
      );
    });

    it('zScore is finite for any non-zero stdDev and finite value', () => {
      const finiteFloat = fc.float({
        min: Math.fround(-1e6),
        max: Math.fround(1e6),
        noNaN: true,
        noDefaultInfinity: true,
      });
      const positiveFloat = fc.float({
        min: Math.fround(1e-3),
        max: Math.fround(1e3),
        noNaN: true,
        noDefaultInfinity: true,
      });
      fc.assert(
        fc.property(finiteFloat, finiteFloat, positiveFloat, (value, mean, stdDev) => {
          const z = zScore(value, mean, stdDev);
          expect(Number.isFinite(z)).toBe(true);
        }),
        { numRuns: 100 },
      );
    });

    it('effectiveThreshold scales monotonically downward as n grows toward 100', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 1, max: 99 }),
          fc.integer({ min: 1, max: 99 }),
          (a, b) => {
            const small = Math.min(a, b);
            const big = Math.max(a, b);
            // Same n → same threshold (idempotent).
            // smaller n → wider (>=) threshold.
            expect(effectiveThreshold(3, small)).toBeGreaterThanOrEqual(
              effectiveThreshold(3, big),
            );
          },
        ),
        { numRuns: 100 },
      );
    });
  });

  describe('integration with arbitraries', () => {
    it('windowOf composes with metricSampleArb without throwing', () => {
      fc.assert(
        fc.property(fc.array(metricSampleArb, { minLength: 0, maxLength: 50 }), (samples) => {
          const now = Date.now();
          const result = windowOf(samples, now, 60_000);
          expect(Array.isArray(result)).toBe(true);
          expect(result.length).toBeLessThanOrEqual(samples.length);
        }),
        { numRuns: 50 },
      );
    });
  });
});
