import type { MetricSample } from '@sandforge/shared';

/**
 * Phase 03 Plan 03-05 — pure rolling-window math for AnomalyEngine.
 *
 * No class, no I/O, no logger. Every export is a pure function. The math is
 * deliberately textbook (two-pass mean + std-dev) so it stays under 60 LOC and
 * keeps the test surface minimal — see RESEARCH §1 (no `simple-statistics`,
 * no `mathjs`, no `d3-array`).
 */

/** Constants exported for tests + AnomalyEngine. */
export const MIN_SAMPLES_FOR_BASELINE = 30;
export const MIN_BASELINE_SPAN_MS = 6 * 60 * 60 * 1000; // 6h
export const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000; // 24h
export const DEFAULT_SIGMA_THRESHOLD = 3;

/** Filter samples to those within `[now - windowMs, now]`. */
export function windowOf(
  samples: MetricSample[],
  now: number,
  windowMs = DEFAULT_WINDOW_MS,
): MetricSample[] {
  const cutoff = now - windowMs;
  return samples.filter((s) => new Date(s.ts).getTime() >= cutoff);
}

/** Mean of sample values; NaN-safe (returns 0 on empty). */
export function rollingMean(samples: MetricSample[]): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (const s of samples) sum += s.value;
  return sum / samples.length;
}

/** Population std-dev (two-pass). Returns 0 for n < 2. */
export function rollingStdDev(samples: MetricSample[], mean?: number): number {
  if (samples.length < 2) return 0;
  const m = mean ?? rollingMean(samples);
  let acc = 0;
  for (const s of samples) acc += (s.value - m) ** 2;
  return Math.sqrt(acc / samples.length);
}

/** zScore. Returns 0 if `stdDev` is 0 (degenerate / constant series). */
export function zScore(value: number, mean: number, stdDev: number): number {
  if (stdDev === 0) return 0;
  return (value - mean) / stdDev;
}

/**
 * Small-sample threshold widening: scale the base sigma by `(1 + 1/sqrt(n))`
 * for `n < 100` (P-03.3 — false positives at startup).
 */
export function effectiveThreshold(baseSigma: number, n: number): number {
  if (n >= 100) return baseSigma;
  return baseSigma * (1 + 1 / Math.sqrt(Math.max(n, 1)));
}

/** Returns true iff `samples` meet warmup criteria (P-03.3). */
export function isWarmedUp(samples: MetricSample[]): boolean {
  if (samples.length < MIN_SAMPLES_FOR_BASELINE) return false;
  const oldest = new Date(samples[0].ts).getTime();
  const newest = new Date(samples[samples.length - 1].ts).getTime();
  return newest - oldest >= MIN_BASELINE_SPAN_MS;
}
