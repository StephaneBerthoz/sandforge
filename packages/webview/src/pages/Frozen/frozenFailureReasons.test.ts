import { describe, it, expect } from 'vitest';
import type { FrozenPerObjectLoadResult } from '@sandforge/shared';
import { failureReasons, purgeFailureReasons } from './frozenFailureReasons';

/** One object's results, with its failed records' errors. */
function failedOf(objectApiName: string, errors: string[][]): FrozenPerObjectLoadResult {
  return {
    objectApiName,
    fromFiles: errors.length,
    inserted: 0,
    reused: 0,
    skippedDuplicates: [],
    failed: errors.map((recordErrors, index) => ({
      objectApiName,
      referenceId: `${objectApiName}-${String(index + 1).padStart(6, '0')}`,
      errors: recordErrors,
    })),
  };
}

describe('failureReasons', () => {
  it('groups the failed records of each object by status code and message, the most frequent first', () => {
    const reasons = failureReasons([
      failedOf('Contact', [
        ['REQUIRED_FIELD_MISSING: Required fields are missing: [LastName]'],
        ['INVALID_EMAIL_ADDRESS: Email: invalid email address: a@b'],
        ['REQUIRED_FIELD_MISSING: Required fields are missing: [LastName]'],
      ]),
      failedOf('Account', [['REQUIRED_FIELD_MISSING: Required fields are missing: [LastName]']]),
    ]);

    expect(reasons).toEqual([
      {
        objectApiName: 'Contact',
        statusCode: 'REQUIRED_FIELD_MISSING',
        message: 'Required fields are missing: [LastName]',
        count: 2,
      },
      {
        objectApiName: 'Account',
        statusCode: 'REQUIRED_FIELD_MISSING',
        message: 'Required fields are missing: [LastName]',
        count: 1,
      },
      {
        objectApiName: 'Contact',
        statusCode: 'INVALID_EMAIL_ADDRESS',
        message: 'Email: invalid email address: a@b',
        count: 1,
      },
    ]);
  });

  it('counts a record refused for two reasons under both, and one refused twice for one reason once', () => {
    const reasons = failureReasons([
      failedOf('Case', [
        [
          'FIELD_CUSTOM_VALIDATION_EXCEPTION: Subject is required',
          'FIELD_CUSTOM_VALIDATION_EXCEPTION: Subject is required',
          'INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST: Status: bad value',
        ],
      ]),
    ]);

    expect(reasons.map((reason) => [reason.statusCode, reason.count])).toEqual([
      ['FIELD_CUSTOM_VALIDATION_EXCEPTION', 1],
      ['INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST', 1],
    ]);
  });

  it('keeps whole, under no status code, a message that names none', () => {
    // The load's own words for an object it did not send, and a batch the
    // Bulk API failed whole, carry no code.
    const reasons = failureReasons([
      failedOf('RevenueTransactionErrorLog', [
        ['Not createable in target org: the running user may not insert it'],
      ]),
      failedOf('Task', [['Bulk error'], []]),
    ]);

    expect(reasons).toEqual([
      {
        objectApiName: 'RevenueTransactionErrorLog',
        statusCode: '',
        message: 'Not createable in target org: the running user may not insert it',
        count: 1,
      },
      { objectApiName: 'Task', statusCode: '', message: 'Bulk error', count: 1 },
      { objectApiName: 'Task', statusCode: '', message: '', count: 1 },
    ]);
  });

  it('says nothing of a load where no record failed', () => {
    expect(failureReasons([{ ...failedOf('Account', []), inserted: 3, fromFiles: 3 }])).toEqual([]);
  });
});

describe('purgeFailureReasons', () => {
  it("groups what a reload's purge could not purge by object, status code and message, the most frequent first", () => {
    const reasons = purgeFailureReasons([
      {
        objectApiName: 'Order',
        recordId: '801000000000001AAA',
        errors: [
          'DELETE_FAILED: Your attempt to delete this record failed',
          'Status set to Draft for the purge, and left there: Activated could not be given back — INVALID_STATUS',
        ],
      },
      ...['500000000000001AAA', '500000000000002AAA'].map((recordId) => ({
        objectApiName: 'Case',
        recordId,
        errors: ['DELETE_FAILED: Your attempt to delete this record failed'],
      })),
    ]);

    expect(reasons).toEqual([
      {
        objectApiName: 'Case',
        statusCode: 'DELETE_FAILED',
        message: 'Your attempt to delete this record failed',
        count: 2,
      },
      {
        objectApiName: 'Order',
        statusCode: 'DELETE_FAILED',
        message: 'Your attempt to delete this record failed',
        count: 1,
      },
      {
        // The purge's own words, under no code: the order stays a draft.
        objectApiName: 'Order',
        statusCode: '',
        message:
          'Status set to Draft for the purge, and left there: Activated could not be given back — INVALID_STATUS',
        count: 1,
      },
    ]);
  });

  it('says nothing of a purge the target refused nothing of', () => {
    expect(purgeFailureReasons([])).toEqual([]);
  });
});
