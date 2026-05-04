import type { MetricSample } from '@sandforge/shared';

/** Generic 2D point used by the LTTB downsampler. */
export interface Point {
  x: number;
  y: number;
}

/**
 * Largest-Triangle-Three-Buckets — Sveinn Steinarsson 2013 thesis algorithm.
 *
 * O(n) time-series downsampler that preserves visual fidelity of peaks /
 * troughs at small bucket counts. Used by ReportExporter sparklines so PDF
 * output stays under a few KB even when the underlying series has thousands
 * of samples.
 *
 * @param data Input points sorted by x (caller invariant).
 * @param threshold Target output length. If `data.length <= threshold` the
 *   input is returned unchanged.
 */
export function lttb(data: readonly Point[], threshold: number): Point[] {
  if (threshold >= data.length || threshold === 0) return [...data];
  if (threshold < 3) return [data[0], data[data.length - 1]];

  const sampled: Point[] = [];
  const bucketSize = (data.length - 2) / (threshold - 2);
  let a = 0;
  sampled.push(data[a]);

  for (let i = 0; i < threshold - 2; i++) {
    const avgRangeStart = Math.floor((i + 1) * bucketSize) + 1;
    const avgRangeEnd = Math.min(Math.floor((i + 2) * bucketSize) + 1, data.length);
    let avgX = 0;
    let avgY = 0;
    const avgRangeLen = avgRangeEnd - avgRangeStart;
    for (let j = avgRangeStart; j < avgRangeEnd; j++) {
      avgX += data[j].x;
      avgY += data[j].y;
    }
    avgX /= avgRangeLen;
    avgY /= avgRangeLen;

    const rangeOffs = Math.floor(i * bucketSize) + 1;
    const rangeTo = Math.floor((i + 1) * bucketSize) + 1;
    const pointAX = data[a].x;
    const pointAY = data[a].y;
    let maxArea = -1;
    let maxAreaPoint = data[rangeOffs];
    let nextA = rangeOffs;
    for (let j = rangeOffs; j < rangeTo; j++) {
      const area =
        Math.abs(
          (pointAX - avgX) * (data[j].y - pointAY) -
            (pointAX - data[j].x) * (avgY - pointAY),
        ) * 0.5;
      if (area > maxArea) {
        maxArea = area;
        maxAreaPoint = data[j];
        nextA = j;
      }
    }
    sampled.push(maxAreaPoint);
    a = nextA;
  }

  sampled.push(data[data.length - 1]);
  return sampled;
}

/** Convert MetricSample[] to LTTB Point[] (ts → x, value → y). */
export function samplesToPoints(samples: readonly MetricSample[]): Point[] {
  return samples.map((s) => ({ x: new Date(s.ts).getTime(), y: s.value }));
}
