import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { lttb, samplesToPoints, type Point } from './lttb';
import type { MetricSample } from '@sandforge/shared';

function linearSeries(n: number): Point[] {
  return Array.from({ length: n }, (_, i) => ({ x: i, y: i }));
}

describe('lttb', () => {
  it('returns input unchanged when threshold >= data.length', () => {
    const data = linearSeries(10);
    expect(lttb(data, 10)).toEqual(data);
    expect(lttb(data, 50)).toEqual(data);
  });

  it('returns [first, last] when threshold < 3', () => {
    const data = linearSeries(100);
    expect(lttb(data, 0)).toEqual(data);
    expect(lttb(data, 1)).toEqual([data[0], data[99]]);
    expect(lttb(data, 2)).toEqual([data[0], data[99]]);
  });

  it('returns exactly threshold points for threshold=100 over 10000 input', () => {
    const data = linearSeries(10_000);
    const downsampled = lttb(data, 100);
    expect(downsampled).toHaveLength(100);
  });

  it('preserves first and last points (visual continuity)', () => {
    const data = linearSeries(1000);
    const downsampled = lttb(data, 50);
    expect(downsampled[0]).toEqual(data[0]);
    expect(downsampled[downsampled.length - 1]).toEqual(data[data.length - 1]);
  });

  it('constant-y series → all output points have the same y', () => {
    const data: Point[] = Array.from({ length: 200 }, (_, i) => ({ x: i, y: 42 }));
    const downsampled = lttb(data, 25);
    for (const p of downsampled) {
      expect(p.y).toBe(42);
    }
  });

  it('property: output length === T and output sorted by x', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 10, max: 500 }),
        fc.integer({ min: 3, max: 9 }),
        (n, t) => {
          const data = linearSeries(n);
          const out = lttb(data, t);
          if (out.length !== t) return false;
          for (let i = 1; i < out.length; i++) {
            if (out[i].x < out[i - 1].x) return false;
          }
          return true;
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe('samplesToPoints', () => {
  it('converts MetricSample[] to Point[] with ts → x and value → y', () => {
    const samples: MetricSample[] = [
      { ts: '2024-01-01T00:00:00Z', orgId: 'o1', seriesId: 's1', value: 10 },
      { ts: '2024-01-01T00:01:00Z', orgId: 'o1', seriesId: 's1', value: 20 },
    ];
    const points = samplesToPoints(samples);
    expect(points).toEqual([
      { x: new Date('2024-01-01T00:00:00Z').getTime(), y: 10 },
      { x: new Date('2024-01-01T00:01:00Z').getTime(), y: 20 },
    ]);
  });
});
