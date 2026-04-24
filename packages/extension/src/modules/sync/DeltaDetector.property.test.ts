/**
 * Property-based tests for DeltaDetector.
 *
 * Injects a deterministic mock `query` function built from the generated
 * record list. Uses `fc.asyncProperty` because `detect()` is async.
 */
import * as fc from 'fast-check';
import { describe, it, expect } from 'vitest';
import type { SyncObjectConfig } from '@sandforge/shared';
import { DeltaDetector, type QueryRecord } from './DeltaDetector';
import { queryRecordArb } from '../../test/arbitraries';

/** Minimal SyncObjectConfig — DeltaDetector only reads objectApiName + optional where/orderBy. */
const cfg: SyncObjectConfig = {
  objectApiName: 'Account',
  operation: 'insert',
  fieldMappings: [],
  transformRules: [],
  excludedFields: [],
  addOnFields: [],
  batchSize: 200,
  insertOrder: 0,
};

/** Build a DeltaDetector whose query() returns the generated record list verbatim. */
const makeDetector = (records: QueryRecord[]): DeltaDetector =>
  new DeltaDetector({
    query: async () => records,
  });

describe('DeltaDetector — property-based', () => {
  it('totals invariant: new + modified + deleted + unchanged === input length', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(queryRecordArb, { minLength: 0, maxLength: 40 }),
        fc
          .date({ min: new Date('2020-01-01'), max: new Date('2030-01-01') })
          .map((d) => d.toISOString()),
        async (records, lastSync) => {
          const detector = makeDetector(records);
          const result = await detector.detect(cfg, 'orgA', lastSync);
          const total =
            result.newRecords +
            result.modifiedRecords +
            result.deletedRecords +
            result.unchangedRecords;
          expect(total).toBe(records.length);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('no lastSync baseline: every record counted as new (matches source behavior)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(queryRecordArb, { minLength: 0, maxLength: 30 }),
        async (records) => {
          const detector = makeDetector(records);
          const result = await detector.detect(cfg, 'orgA', undefined);
          expect(result.newRecords).toBe(records.length);
          expect(result.modifiedRecords).toBe(0);
          expect(result.deletedRecords).toBe(0);
          expect(result.unchangedRecords).toBe(0);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('IsDeleted records are always counted as deleted (when lastSync is set)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(queryRecordArb, { minLength: 1, maxLength: 25 }),
        fc
          .date({ min: new Date('2020-01-01'), max: new Date('2030-01-01') })
          .map((d) => d.toISOString()),
        async (records, lastSync) => {
          // Count input records whose IsDeleted is explicitly true.
          const expectedDeleted = records.filter((r) => r.IsDeleted === true).length;
          const detector = makeDetector(records);
          const result = await detector.detect(cfg, 'orgA', lastSync);
          expect(result.deletedRecords).toBe(expectedDeleted);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('re-run idempotency: two identical calls yield equal results', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(queryRecordArb, { minLength: 0, maxLength: 30 }),
        fc.option(
          fc
            .date({ min: new Date('2020-01-01'), max: new Date('2030-01-01') })
            .map((d) => d.toISOString()),
          { nil: undefined },
        ),
        async (records, lastSync) => {
          const detector = makeDetector(records);
          const first = await detector.detect(cfg, 'orgA', lastSync);
          const second = await detector.detect(cfg, 'orgA', lastSync);
          expect(first).toEqual(second);
        },
      ),
      { numRuns: 100 },
    );
  });
});
