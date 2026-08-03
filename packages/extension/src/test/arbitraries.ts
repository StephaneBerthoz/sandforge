/**
 * Shared fast-check arbitraries for property-based testing.
 *
 * Composed generators for the domain types used across the property-tested
 * modules (ErrorClassifier, DiffEngine, DeltaDetector, anomaly-math,
 * TimeSeriesStore).
 *
 * This file lives under `src/test/` so Vitest does NOT pick it up as a test
 * file (no `.test.ts` suffix). It is a pure test helper module.
 */
import * as fc from 'fast-check';
import type {
  SalesforceApiError,
  ErrorCategory,
  MetadataComponentType,
  MetricSample,
  FieldDelta,
  PermissionDelta,
  DriftEventPayload,
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
    fc.dictionary(fc.string({ minLength: 1, maxLength: 20 }), fc.string({ maxLength: 50 }), {
      maxKeys: 5,
    }),
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

// ─── Plan 03-04 — Drift v2 arbitraries ─────────────────────────────────────

/** ISO timestamp arbitrary used by the drift delta arbitraries. */
const isoTimestampArb: fc.Arbitrary<string> = fc
  .date({ min: new Date('2020-01-01'), max: new Date('2030-01-01') })
  .map((d) => d.toISOString());

/** A single FieldDelta. Plan 03-04 — drives DriftDetector property tests. */
export const fieldDeltaArb: fc.Arbitrary<FieldDelta> = fc.record({
  objectApiName: fc.string({ minLength: 1, maxLength: 60 }),
  fieldApiName: fc.string({ minLength: 1, maxLength: 60 }),
  changeKind: fc.constantFrom(
    'added',
    'removed',
    'type-changed',
    'length-changed',
    'picklist-changed',
    'required-changed',
  ),
  detectedAt: isoTimestampArb,
});

/** A single PermissionDelta. Plan 03-04. */
export const permissionDeltaArb: fc.Arbitrary<PermissionDelta> = fc.record({
  profileOrPermSetName: fc.string({ minLength: 1, maxLength: 60 }),
  fieldApiName: fc.string({ minLength: 1, maxLength: 60 }),
  changeKind: fc.constantFrom('granted', 'revoked', 'modified'),
  permission: fc.constantFrom('read', 'edit', 'create', 'delete', 'view-all', 'modify-all'),
  before: fc.boolean(),
  after: fc.boolean(),
  detectedAt: isoTimestampArb,
});

/** A full DriftEventPayload composed from the above. Plan 03-04. */
export const driftEventArb: fc.Arbitrary<DriftEventPayload> = fc
  .record({
    orgId: fc.string({ minLength: 1, maxLength: 20 }),
    snapshotPairId: fc.string({ minLength: 1, maxLength: 60 }),
    severity: fc.constantFrom('info' as const, 'breaking' as const, 'permission' as const),
    fieldDeltas: fc.array(fieldDeltaArb, { maxLength: 50 }),
    permDeltas: fc.array(permissionDeltaArb, { maxLength: 50 }),
  })
  .map(({ orgId, snapshotPairId, severity, fieldDeltas, permDeltas }) => {
    const deltas = [...fieldDeltas, ...permDeltas].slice(0, 500);
    return {
      orgId,
      snapshotPairId,
      summary: `${deltas.length} drift change(s) detected`,
      deltaCount: deltas.length,
      severity,
      deltas,
    };
  });

/**
 * Arbitrary CustomField describe-like record. Used by DriftDetector property
 * tests for `detectFieldDrift`. Generates an allowlistable-shaped record.
 */
export const fieldDescribeArb: fc.Arbitrary<{ name: string } & Record<string, unknown>> = fc.record(
  {
    name: fc.string({ minLength: 1, maxLength: 30 }),
    type: fc.constantFrom('Text', 'Email', 'Phone', 'Picklist', 'Number', 'Boolean'),
    length: fc.option(fc.integer({ min: 1, max: 32_000 }), { nil: undefined }),
    required: fc.boolean(),
    externalId: fc.boolean(),
    // Add some noise so canonicalization actually has work to do.
    lastModifiedDate: fc
      .date({ min: new Date('2020-01-01'), max: new Date('2030-01-01') })
      .map((d) => d.toISOString()),
  },
);

/** Arbitrary ObjectDescribe-like with `name` + `fields[]`. */
export const objectDescribeArb: fc.Arbitrary<{
  name: string;
  fields: Array<{ name: string } & Record<string, unknown>>;
}> = fc.record({
  name: fc.string({ minLength: 1, maxLength: 30 }),
  fields: fc.uniqueArray(fieldDescribeArb, {
    minLength: 0,
    maxLength: 12,
    selector: (f) => f.name,
  }),
});
