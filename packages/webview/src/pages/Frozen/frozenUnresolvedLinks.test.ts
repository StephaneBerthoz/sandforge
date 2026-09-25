import { describe, it, expect } from 'vitest';
import type { FrozenLoadReportInfo } from '@sandforge/shared';
import { unresolvedCycleLookups, unresolvedLinks } from './frozenUnresolvedLinks';

type Pass2Link = FrozenLoadReportInfo['pass2']['unresolved'][number];
type PersonContactLink = FrozenLoadReportInfo['personContact']['unresolved'][number];

/** A report of these links only. */
function reportOf(
  pass2: Pass2Link[],
  personContact: PersonContactLink[] = [],
): Pick<FrozenLoadReportInfo, 'pass2' | 'personContact'> {
  return {
    pass2: { resolved: 0, unresolved: pass2 },
    personContact: { restored: 0, unresolved: personContact },
  };
}

/** A cycle lookup of one record that pass 2 did not fill. */
function cycleLink(
  objectApiName: string,
  referenceId: string,
  field: string,
  cause: Pass2Link['cause'],
  detail: string,
): Pass2Link {
  return { objectApiName, referenceId, field, cause, detail };
}

describe('unresolvedLinks', () => {
  it('groups the links by object, lookup and cause, with how many, object by object', () => {
    const links = unresolvedLinks(
      reportOf([
        cycleLink(
          'Case',
          'Case-000001',
          'ParentId',
          'target-not-loaded',
          'referenced record Case-000009 was not loaded (skipped, failed or excluded)',
        ),
        cycleLink(
          'Case',
          'Case-000002',
          'ParentId',
          'target-not-loaded',
          'referenced record Case-000008 was not loaded (skipped, failed or excluded)',
        ),
        cycleLink(
          'Account',
          'Account-000001',
          'ParentId',
          'record-not-loaded',
          'child record was not loaded (see perObject failures/skips)',
        ),
      ]),
    );

    // The record each one points at is the load's to name, not a reason of its own.
    expect(links).toEqual([
      {
        objectApiName: 'Account',
        field: 'ParentId',
        cause: 'record-not-loaded',
        message: '',
        count: 1,
      },
      {
        objectApiName: 'Case',
        field: 'ParentId',
        cause: 'target-not-loaded',
        message: '',
        count: 2,
      },
    ]);
  });

  it('counts a refused update of several lookups under each, apart for each thing the target said', () => {
    const links = unresolvedLinks(
      reportOf([
        cycleLink(
          'Account',
          'Account-000001',
          'ParentId,PrimaryContact__c',
          'update-refused',
          'FIELD_INTEGRITY_EXCEPTION: The parent account is merged',
        ),
        cycleLink(
          'Account',
          'Account-000002',
          'ParentId',
          'update-refused',
          'UNABLE_TO_LOCK_ROW: unable to obtain exclusive access to this record',
        ),
        cycleLink(
          'Account',
          'Account-000003',
          'ParentId',
          'update-refused',
          'UNABLE_TO_LOCK_ROW: unable to obtain exclusive access to this record',
        ),
      ]),
    );

    expect(links).toEqual([
      {
        objectApiName: 'Account',
        field: 'ParentId',
        cause: 'update-refused',
        message: 'UNABLE_TO_LOCK_ROW: unable to obtain exclusive access to this record',
        count: 2,
      },
      {
        objectApiName: 'Account',
        field: 'ParentId',
        cause: 'update-refused',
        message: 'FIELD_INTEGRITY_EXCEPTION: The parent account is merged',
        count: 1,
      },
      {
        objectApiName: 'Account',
        field: 'PrimaryContact__c',
        cause: 'update-refused',
        message: 'FIELD_INTEGRITY_EXCEPTION: The parent account is merged',
        count: 1,
      },
    ]);
  });

  it("lists a person account's link to its contact as the account's PersonContactId", () => {
    const links = unresolvedLinks(
      reportOf(
        [],
        [
          {
            accountReferenceId: 'Account-000001',
            contactReferenceId: 'Contact-000001',
            cause: 'target-not-loaded',
            detail: 'contact Contact-000001 was not loaded (skipped, failed or excluded)',
          },
          {
            accountReferenceId: 'Account-000002',
            contactReferenceId: 'Contact-000002',
            cause: 'update-refused',
            detail:
              'INVALID_FIELD_FOR_INSERT_UPDATE: Unable to create/update fields: PersonContactId',
          },
        ],
      ),
    );

    expect(links).toEqual([
      {
        objectApiName: 'Account',
        field: 'PersonContactId',
        cause: 'target-not-loaded',
        message: '',
        count: 1,
      },
      {
        objectApiName: 'Account',
        field: 'PersonContactId',
        cause: 'update-refused',
        message: 'INVALID_FIELD_FOR_INSERT_UPDATE: Unable to create/update fields: PersonContactId',
        count: 1,
      },
    ]);
  });

  it('is empty for a load that resolved every link', () => {
    expect(unresolvedLinks(reportOf([]))).toEqual([]);
  });
});

describe('unresolvedCycleLookups', () => {
  it('counts lookups, as pass 2 counts the ones it resolved, not records', () => {
    expect(
      unresolvedCycleLookups(
        reportOf([
          cycleLink(
            'Account',
            'Account-000001',
            'ParentId,PrimaryContact__c',
            'update-refused',
            'FIELD_INTEGRITY_EXCEPTION: The parent account is merged',
          ),
          cycleLink(
            'Case',
            'Case-000001',
            'ParentId',
            'record-not-loaded',
            'child record was not loaded (see perObject failures/skips)',
          ),
        ]),
      ),
    ).toBe(3);
  });
});
