import { describe, it, expect, vi } from 'vitest';
import { ORPHAN_FILL_THRESHOLD } from '@sandforge/shared';
import type { CleanupObjectScan } from '@sandforge/shared';

import {
  isOrphanLookup,
  isReliedOn,
  resolveRecommendation,
  scanCleanup,
  soqlLiteral,
} from './CleanupScanner.js';
import type { DescribedField } from './DataQualityScanner.js';

/** A lookup a person fills, that may be empty. */
function lookup(
  name: string,
  referenceTo: string[],
  extra: Partial<DescribedField> = {},
): DescribedField {
  return {
    name,
    label: name,
    type: 'reference',
    createable: true,
    updateable: true,
    nillable: true,
    filterable: true,
    aggregatable: true,
    referenceTo,
    ...extra,
  };
}

/** Contacts: an account nearly all fill, a manager few fill, an owner, and an email to group by. */
const contactDescribe = {
  name: 'Contact',
  label: 'Contact',
  queryable: true,
  deletable: true,
  fields: [
    { name: 'Id', label: 'Contact ID', type: 'id', filterable: true },
    lookup('AccountId', ['Account'], { label: 'Account ID' }),
    lookup('ReportsToId', ['Contact'], { label: 'Reports To ID' }),
    lookup('OwnerId', ['User'], { label: 'Owner ID', nillable: false }),
    {
      name: 'Email',
      label: 'Email',
      type: 'email',
      createable: true,
      updateable: true,
      groupable: true,
      filterable: true,
    },
    { name: 'LastModifiedDate', label: 'Last Modified Date', type: 'datetime', filterable: true },
  ],
};

/** 100 contacts: 95 under an account, 10 with a manager, 30 untouched for a year. */
function contactOrg() {
  const query = vi.fn(async (soql: string) => {
    if (soql === 'SELECT COUNT() FROM Contact') return { totalSize: 100, records: [] };
    if (soql.startsWith('SELECT COUNT(AccountId), COUNT(ReportsToId)')) {
      return { totalSize: 1, records: [{ expr0: 95, expr1: 10 }] };
    }
    if (soql.includes('GROUP BY Email')) {
      return { totalSize: 1, records: [{ k: 'shared@example.com', n: 3 }] };
    }
    if (soql.includes('LAST_N_DAYS:365')) return { totalSize: 30, records: [] };
    throw new Error(`unexpected query: ${soql}`);
  });
  return { describe: vi.fn(async () => contactDescribe), query };
}

describe('scanCleanup', () => {
  it('lists the orphans of a lookup nearly every record fills, and not of one few fill', async () => {
    const result = await scanCleanup(contactOrg(), {
      orgId: 'org-1',
      objects: [{ objectApiName: 'Contact' }],
      staleDays: 365,
    });

    const contact = result.objects[0] as CleanupObjectScan;
    expect(contact.orphans).toEqual([
      {
        fieldApiName: 'AccountId',
        label: 'Account ID',
        referenceTo: 'Account',
        filled: 95,
        empty: 5,
      },
    ]);
    expect(contact.stale).toEqual({ days: 365, records: 30 });
    expect(contact.duplicates).toMatchObject({ keyField: 'Email', groupCount: 1, recordCount: 3 });
    expect(result.orphanThreshold).toBe(ORPHAN_FILL_THRESHOLD);
  });

  it('counts, and reads no record', async () => {
    const conn = contactOrg();

    await scanCleanup(conn, {
      orgId: 'org-1',
      objects: [{ objectApiName: 'Contact' }],
      staleDays: 365,
    });

    expect(conn.query.mock.calls.every(([soql]) => /COUNT\(/.test(soql))).toBe(true);
  });

  it('never takes a record without an owner or a record type for an orphan', () => {
    expect(isOrphanLookup(lookup('AccountId', ['Account']))).toBe(true);
    expect(isOrphanLookup(lookup('Manager__c', ['User']))).toBe(false);
    expect(isOrphanLookup(lookup('RecordTypeId', ['RecordType']))).toBe(false);
    // Required, or pointing at several objects: says nothing of a missing parent.
    expect(isOrphanLookup(lookup('ParentId', ['Account'], { nillable: false }))).toBe(false);
    expect(isOrphanLookup(lookup('WhatId', ['Account', 'Opportunity']))).toBe(false);
  });

  it('relies on a lookup from the threshold up', () => {
    expect(isReliedOn(90, 100)).toBe(true);
    expect(isReliedOn(89, 100)).toBe(false);
    expect(isReliedOn(0, 0)).toBe(false);
  });
});

describe('resolveRecommendation', () => {
  it('takes the stale records oldest first, up to the limit, and says there are more', async () => {
    const query = vi.fn(async (soql: string) =>
      soql.startsWith('SELECT COUNT()')
        ? { totalSize: 30, records: [] }
        : { totalSize: 2, records: [{ Id: '003000000000001AAA' }, { Id: '003000000000002AAA' }] },
    );

    const resolved = await resolveRecommendation(
      { describe: async () => contactDescribe, query },
      'Contact',
      { kind: 'stale', days: 365 },
      2,
    );

    expect(query.mock.calls[1][0]).toBe(
      'SELECT Id FROM Contact WHERE LastModifiedDate < LAST_N_DAYS:365 ORDER BY LastModifiedDate, Id LIMIT 2',
    );
    expect(resolved).toMatchObject({
      total: 30,
      ids: ['003000000000001AAA', '003000000000002AAA'],
      truncated: true,
    });
  });

  it('checks the lookup is still one the business relies on before naming its orphans', async () => {
    const query = vi.fn(async (soql: string) => {
      if (soql === 'SELECT COUNT() FROM Contact') return { totalSize: 100, records: [] };
      if (soql.includes('= null') && soql.startsWith('SELECT COUNT()')) {
        return { totalSize: 40, records: [] };
      }
      return { totalSize: 0, records: [] };
    });

    await expect(
      resolveRecommendation(
        { describe: async () => contactDescribe, query },
        'Contact',
        { kind: 'orphans', fieldApiName: 'AccountId' },
        100,
      ),
    ).rejects.toThrow(/fewer than 90%/);
  });

  it('refuses a field that cannot leave a record an orphan', async () => {
    await expect(
      resolveRecommendation(
        { describe: async () => contactDescribe, query: vi.fn() },
        'Contact',
        { kind: 'orphans', fieldApiName: 'OwnerId' },
        100,
      ),
    ).rejects.toThrow(/not a lookup/);
  });

  it('keeps the copy of each repeated value modified last, and names the others', async () => {
    const query = vi.fn(async (soql: string) => {
      if (soql.includes('GROUP BY Email')) {
        return {
          totalSize: 2,
          records: [
            { k: 'a@example.com', n: 3 },
            { k: 'b@example.com', n: 2 },
          ],
        };
      }
      return {
        totalSize: 5,
        records: [
          {
            Id: '003000000000001AAA',
            Email: 'a@example.com',
            LastModifiedDate: '2026-01-01T00:00:00.000+0000',
          },
          {
            Id: '003000000000002AAA',
            Email: 'A@example.com',
            LastModifiedDate: '2026-03-01T00:00:00.000+0000',
          },
          {
            Id: '003000000000003AAA',
            Email: 'a@example.com',
            LastModifiedDate: '2026-02-01T00:00:00.000+0000',
          },
          {
            Id: '003000000000004AAA',
            Email: 'b@example.com',
            LastModifiedDate: '2026-01-01T00:00:00.000+0000',
          },
          {
            Id: '003000000000005AAA',
            Email: 'b@example.com',
            LastModifiedDate: '2026-01-02T00:00:00.000+0000',
          },
        ],
      };
    });

    const resolved = await resolveRecommendation(
      { describe: async () => contactDescribe, query },
      'Contact',
      { kind: 'duplicates', keyField: 'Email' },
      100,
    );

    expect(query.mock.calls[1][0]).toContain("WHERE Email IN ('a@example.com', 'b@example.com')");
    // a@: the March copy is kept, whatever the case it was typed in; b@: the second of January.
    expect(resolved.ids.sort()).toEqual([
      '003000000000001AAA',
      '003000000000003AAA',
      '003000000000004AAA',
    ]);
    expect(resolved).toMatchObject({ total: 3, truncated: false });
  });

  it('writes each value of a key as SOQL writes its type, and refuses a date and time', () => {
    expect(soqlLiteral('email', "o'hara@example.com")).toBe("'o\\'hara@example.com'");
    expect(soqlLiteral('double', 4.5)).toBe('4.5');
    expect(soqlLiteral('boolean', true)).toBe('true');
    expect(soqlLiteral('date', '2026-01-02')).toBe('2026-01-02');
    expect(soqlLiteral('date', "2026-01-02' OR Id != '")).toBeUndefined();
    expect(soqlLiteral('datetime', '2026-01-02T00:00:00.000+0000')).toBeUndefined();
  });
});
