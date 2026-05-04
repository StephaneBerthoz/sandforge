/**
 * Shared fast-check arbitraries for property-based testing.
 *
 * Composed generators for the domain types used across the 4 property-tested
 * modules (ErrorClassifier, DiffEngine, GovernorLimitPredictor, DeltaDetector).
 *
 * This file lives under `src/test/` so Vitest does NOT pick it up as a test
 * file (no `.test.ts` suffix). It is a pure test helper module.
 */
import * as fc from 'fast-check';
import type {
  SalesforceApiError,
  ErrorCategory,
  MetadataComponentType,
  LimitsSnapshot,
  ApiLimit,
  MetricSample,
} from '@sandforge/shared';
import type { QueryRecord } from '../modules/sync/DeltaDetector';

/** Salesforce status codes spanning every ErrorClassifier category. */
export const salesforceStatusCodeArb = fc.constantFrom(
  'INVALID_SESSION_ID',
  'INSUFFICIENT_ACCESS',
  'FIELD_INTEGRITY_EXCEPTION',
  'REQUIRED_FIELD_MISSING',
  'REQUEST_LIMIT_EXCEEDED',
  'UNABLE_TO_LOCK_ROW',
  'DUPLICATE_VALUE',
  'INVALID_EMAIL_ADDRESS',
  'STORAGE_LIMIT_EXCEEDED',
  'APEX_ERROR',
  'UNKNOWN_EXCEPTION',
);

/** Arbitrary SalesforceApiError. Drives ErrorClassifier tests. */
export const salesforceApiErrorArb: fc.Arbitrary<SalesforceApiError> = fc.record({
  statusCode: salesforceStatusCodeArb,
  message: fc.string({ minLength: 1, maxLength: 200 }),
  fields: fc.option(fc.array(fc.string({ minLength: 1, maxLength: 40 }), { maxLength: 5 }), {
    nil: undefined,
  }),
});

/** Arbitrary MetadataComponentType. Drives DiffEngine tests. */
export const metadataComponentTypeArb: fc.Arbitrary<MetadataComponentType> = fc.constantFrom(
  'ApexClass',
  'ApexTrigger',
  'Flow',
  'ValidationRule',
  'CustomObject',
  'CustomField',
  'Layout',
  'PermissionSet',
);

/** Arbitrary `Map<string, string>` with bounded size for DiffEngine. */
export const componentMapArb: fc.Arbitrary<Map<string, string>> = fc
  .array(fc.tuple(fc.string({ minLength: 1, maxLength: 50 }), fc.string({ maxLength: 500 })), {
    minLength: 0,
    maxLength: 30,
  })
  .map((entries) => new Map(entries));

/** Arbitrary ApiLimit entry (single governor limit measurement). */
export const apiLimitArb: fc.Arbitrary<ApiLimit> = fc
  .record({
    name: fc.string({ minLength: 1, maxLength: 40 }),
    max: fc.integer({ min: 1, max: 1_000_000 }),
    remainingRatio: fc.float({
      min: 0,
      max: 1,
      noNaN: true,
      noDefaultInfinity: true,
    }),
  })
  .map(({ name, max, remainingRatio }) => {
    const remaining = Math.floor(max * remainingRatio);
    const used = max - remaining;
    return {
      name,
      max,
      remaining,
      usedPercent: max === 0 ? 0 : (used / max) * 100,
    };
  });

/** Arbitrary LimitsSnapshot for GovernorLimitPredictor. */
export const limitsSnapshotArb: fc.Arbitrary<LimitsSnapshot> = fc.record({
  orgId: fc.string({ minLength: 1, maxLength: 20 }),
  timestamp: fc
    .date({ min: new Date('2020-01-01'), max: new Date('2030-01-01') })
    .map((d) => d.toISOString()),
  limits: fc.array(apiLimitArb, { minLength: 0, maxLength: 10 }),
});

/** Chronologically ordered list of LimitsSnapshots (for prediction properties). */
export const orderedSnapshotsArb: fc.Arbitrary<LimitsSnapshot[]> = fc
  .array(limitsSnapshotArb, { minLength: 2, maxLength: 20 })
  .map((arr) =>
    [...arr].sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()),
  );

/**
 * Builds an `orderedSnapshotsArb`-shaped sequence where the named limit has a
 * monotonically non-decreasing `usedPercent` across snapshots. Used to verify
 * the monotone-trend classification property on GovernorLimitPredictor.
 */
export const monotoneNonDecreasingSnapshotsArb = (
  limitName: string,
): fc.Arbitrary<LimitsSnapshot[]> =>
  fc
    .array(
      fc.record({
        orgId: fc.string({ minLength: 1, maxLength: 10 }),
        timestampMs: fc.integer({ min: 0, max: 1_000_000 }),
        increment: fc.float({ min: 0, max: 20, noNaN: true, noDefaultInfinity: true }),
        max: fc.integer({ min: 1, max: 1_000_000 }),
      }),
      { minLength: 3, maxLength: 12 },
    )
    .map((entries) => {
      // Sort by timestampMs, then cumulate the increment so usedPercent is non-decreasing.
      const sorted = [...entries].sort((a, b) => a.timestampMs - b.timestampMs);
      let cumulative = 0;
      return sorted.map((e, i) => {
        cumulative = Math.min(100, cumulative + e.increment);
        const used = (cumulative / 100) * e.max;
        const remaining = Math.max(0, e.max - Math.floor(used));
        const snapshot: LimitsSnapshot = {
          orgId: e.orgId,
          timestamp: new Date(i * 60_000 + e.timestampMs).toISOString(),
          limits: [
            {
              name: limitName,
              max: e.max,
              remaining,
              usedPercent: cumulative,
            },
          ],
        };
        return snapshot;
      });
    });

/** Arbitrary QueryRecord for DeltaDetector. */
export const queryRecordArb: fc.Arbitrary<QueryRecord> = fc.record({
  Id: fc.string({ minLength: 15, maxLength: 18 }),
  LastModifiedDate: fc.option(
    fc
      .date({ min: new Date('2020-01-01'), max: new Date('2030-01-01') })
      .map((d) => d.toISOString()),
    { nil: undefined },
  ),
  IsDeleted: fc.option(fc.boolean(), { nil: undefined }),
});

/** Valid error category (for ErrorClassifier byCategory invariant). */
export const errorCategoryArb: fc.Arbitrary<ErrorCategory> = fc.constantFrom(
  'auth',
  'permission',
  'schema',
  'data',
  'validation',
  'limit',
  'network',
  'trigger',
  'reference',
  'unknown',
);

/** A single MetricSample (Phase 03 — drives TimeSeriesStore property tests). */
export const metricSampleArb: fc.Arbitrary<MetricSample> = fc.record({
  ts: fc
    .date({ min: new Date('2020-01-01'), max: new Date('2030-01-01') })
    .map((d) => d.toISOString()),
  seriesId: fc.string({ minLength: 1, maxLength: 60 }),
  orgId: fc.string({ minLength: 1, maxLength: 20 }),
  value: fc.float({ min: -1e6, max: 1e6, noNaN: true, noDefaultInfinity: true }),
  unit: fc.option(fc.constantFrom('count', 'percent', 'bytes', 'ms'), { nil: undefined }),
  tags: fc.option(
    fc.dictionary(
      fc.string({ minLength: 1, maxLength: 20 }),
      fc.string({ maxLength: 50 }),
      { maxKeys: 5 },
    ),
    { nil: undefined },
  ),
});

/**
 * Chronologically ordered samples for a single (orgId, seriesId) — drives
 * TimeSeriesStore range queries. Forces all samples to share the same
 * orgId/seriesId so the property tests target a single ring buffer.
 */
export const orderedSamplesForOneSeriesArb: fc.Arbitrary<MetricSample[]> = fc
  .array(metricSampleArb, { minLength: 1, maxLength: 200 })
  .map((arr) => {
    const orgId = arr[0].orgId;
    const seriesId = arr[0].seriesId;
    return [...arr]
      .map((s) => ({ ...s, orgId, seriesId }))
      .sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());
  });
