/**
 * Shared fast-check arbitraries for property-based testing.
 *
 * Composed generators for the domain types used across the property-tested
 * modules (ErrorClassifier, DiffEngine, DeltaDetector).
 *
 * This file lives under `src/test/` so Vitest does NOT pick it up as a test
 * file (no `.test.ts` suffix). It is a pure test helper module.
 */
import * as fc from 'fast-check';
import type { SalesforceApiError, MetadataComponentType } from '@sandforge/shared';
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
