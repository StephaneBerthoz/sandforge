/**
 * Property-based tests for GovernorLimitPredictor.
 *
 * Uses a minimal fake `LimitsTracker` seeded with fast-check-generated
 * snapshot sequences. Fresh predictor per run (P-02.5).
 */
import * as fc from 'fast-check';
import { describe, it, expect } from 'vitest';
import type { LimitsSnapshot } from '@sandforge/shared';
import { GovernorLimitPredictor } from './GovernorLimitPredictor';
import type { LimitsTracker } from './LimitsTracker';
import {
  limitsSnapshotArb,
  orderedSnapshotsArb,
  monotoneNonDecreasingSnapshotsArb,
} from '../../test/arbitraries';

/**
 * Build a minimal LimitsTracker stand-in that returns the provided snapshots
 * for `getHistory`. Only `getHistory` is called inside `predict()`, so other
 * methods can be safely omitted behind an `unknown` cast.
 */
const fakeTracker = (snapshots: LimitsSnapshot[]): LimitsTracker =>
  ({
    getHistory: (_orgId: string) => snapshots,
  }) as unknown as LimitsTracker;

describe('GovernorLimitPredictor — property-based', () => {
  it('predictedPercent is always in [0, 100]', () => {
    fc.assert(
      fc.property(orderedSnapshotsArb, (snapshots) => {
        const predictor = new GovernorLimitPredictor(fakeTracker(snapshots));
        const predictions = predictor.predict('org-1');
        for (const p of predictions) {
          expect(p.predictedPercent).toBeGreaterThanOrEqual(0);
          expect(p.predictedPercent).toBeLessThanOrEqual(100);
        }
      }),
      { numRuns: 100 },
    );
  });

  it('confidence is always in [0, 1]', () => {
    fc.assert(
      fc.property(orderedSnapshotsArb, (snapshots) => {
        const predictor = new GovernorLimitPredictor(fakeTracker(snapshots));
        const predictions = predictor.predict('org-1');
        for (const p of predictions) {
          expect(p.confidence).toBeGreaterThanOrEqual(0);
          expect(p.confidence).toBeLessThanOrEqual(1);
        }
      }),
      { numRuns: 100 },
    );
  });

  it('monotone non-decreasing usage never yields a "decreasing" trend', () => {
    fc.assert(
      fc.property(monotoneNonDecreasingSnapshotsArb('ApiRequests'), (snapshots) => {
        const predictor = new GovernorLimitPredictor(fakeTracker(snapshots));
        const predictions = predictor.predict('org-1');
        // Only the named limit is present — a single prediction expected.
        const target = predictions.find((p) => p.limitName === 'ApiRequests');
        if (target) {
          expect(target.trend).not.toBe('decreasing');
        }
      }),
      { numRuns: 100 },
    );
  });

  it('empty-history guard: fewer than 2 snapshots → predict() returns []', () => {
    fc.assert(
      fc.property(fc.array(limitsSnapshotArb, { minLength: 0, maxLength: 1 }), (snapshots) => {
        const predictor = new GovernorLimitPredictor(fakeTracker(snapshots));
        expect(predictor.predict('org-1')).toEqual([]);
      }),
      { numRuns: 100 },
    );
  });
});
