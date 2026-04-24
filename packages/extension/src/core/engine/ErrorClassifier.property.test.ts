/**
 * Property-based tests for ErrorClassifier.
 *
 * Each property is wrapped in `fc.assert(fc.property(...), { numRuns: 100 })`.
 * A fresh `ErrorClassifier` is constructed inside every property body to avoid
 * shared-state bleed across runs (P-02.5 mitigation).
 */
import * as fc from 'fast-check';
import { describe, it, expect } from 'vitest';
import { ErrorClassifier } from './ErrorClassifier';
import { salesforceApiErrorArb } from '../../test/arbitraries';

describe('ErrorClassifier — property-based', () => {
  it('classification is deterministic for a given statusCode', () => {
    fc.assert(
      fc.property(salesforceApiErrorArb, (err) => {
        const classifier = new ErrorClassifier();
        const first = classifier.classify(err);
        const second = classifier.classify(err);
        // Same input → identical classification + suggestedAction.
        expect(first.classification).toEqual(second.classification);
        expect(first.suggestedAction).toBe(second.suggestedAction);
      }),
      { numRuns: 100 },
    );
  });

  it('batch classification matches per-element classification', () => {
    fc.assert(
      fc.property(
        fc.array(salesforceApiErrorArb, { minLength: 0, maxLength: 25 }),
        (errors) => {
          const classifier = new ErrorClassifier();
          const { classified } = classifier.classifyBatch(errors);
          expect(classified).toHaveLength(errors.length);
          for (let i = 0; i < errors.length; i++) {
            const individual = classifier.classify(errors[i]);
            expect(classified[i].classification).toEqual(individual.classification);
            expect(classified[i].suggestedAction).toBe(individual.suggestedAction);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it('summary totals never lie (totalErrors + retryable/non-retryable + byCategory)', () => {
    fc.assert(
      fc.property(
        fc.array(salesforceApiErrorArb, { minLength: 0, maxLength: 50 }),
        (errors) => {
          const classifier = new ErrorClassifier();
          const { summary } = classifier.classifyBatch(errors);

          // totalErrors matches the input length.
          expect(summary.totalErrors).toBe(errors.length);

          // retryable + non-retryable partitions the set exactly.
          expect(summary.retryableCount + summary.nonRetryableCount).toBe(
            errors.length,
          );

          // byCategory covers every error exactly once.
          const byCategorySum = Object.values(summary.byCategory).reduce(
            (a, b) => a + b,
            0,
          );
          expect(byCategorySum).toBe(errors.length);

          // byErrorCode total also matches.
          const byCodeSum = Object.values(summary.byErrorCode).reduce(
            (a, b) => a + b,
            0,
          );
          expect(byCodeSum).toBe(errors.length);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('byErrorCode maps every input statusCode to its occurrence count', () => {
    fc.assert(
      fc.property(
        fc.array(salesforceApiErrorArb, { minLength: 0, maxLength: 30 }),
        (errors) => {
          const classifier = new ErrorClassifier();
          const { summary } = classifier.classifyBatch(errors);

          const expectedCounts: Record<string, number> = {};
          for (const err of errors) {
            expectedCounts[err.statusCode] =
              (expectedCounts[err.statusCode] ?? 0) + 1;
          }

          // Every expected entry must be present with the exact count.
          for (const [code, count] of Object.entries(expectedCounts)) {
            expect(summary.byErrorCode[code]).toBe(count);
          }
          // And byErrorCode must not contain phantom keys.
          expect(Object.keys(summary.byErrorCode).sort()).toEqual(
            Object.keys(expectedCounts).sort(),
          );
        },
      ),
      { numRuns: 100 },
    );
  });
});
