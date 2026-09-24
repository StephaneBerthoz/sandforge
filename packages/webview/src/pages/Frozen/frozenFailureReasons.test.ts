import { describe, it, expect } from 'vitest';
import type { FrozenPerObjectLoadResult } from '@sandforge/shared';
import { failureReasons } from './frozenFailureReasons';

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
