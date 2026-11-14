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

  it('says whether the connected user may delete the records, so the page offers what it can do', async () => {
    // Delete was offered on every object, and refused once clicked.
    const conn = contactOrg();
    const scan = (deletable: boolean) => {
      conn.describe.mockResolvedValue({ ...contactDescribe, deletable });
      return scanCleanup(conn, {
        orgId: 'org-1',
        objects: [{ objectApiName: 'Contact' }],
        staleDays: 365,
      });
    };

    expect(((await scan(true)).objects[0] as CleanupObjectScan).deletable).toBe(true);
    expect(((await scan(false)).objects[0] as CleanupObjectScan).deletable).toBe(false);
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
      'SELECT Id, LastModifiedDate FROM Contact WHERE LastModifiedDate < LAST_N_DAYS:365 ' +
        'ORDER BY LastModifiedDate, Id LIMIT 2',
    );
    expect(resolved).toMatchObject({
      total: 30,
      ids: ['003000000000001AAA', '003000000000002AAA'],
      truncated: true,
    });
  });

  it('carries an export on past the records the one before it took, stale ones oldest first, none twice and none left out', async () => {
    // "Run it again for the rest" exported the same oldest records again.
    const stale = [
      { Id: '003000000000005AAA', LastModifiedDate: '2020-01-01T08:00:00.000+0000' },
      { Id: '003000000000002AAA', LastModifiedDate: '2020-01-01T08:00:00.000+0000' },
      { Id: '003000000000004AAA', LastModifiedDate: '2020-03-01T08:00:00.000+0000' },
      { Id: '003000000000001AAA', LastModifiedDate: '2021-06-01T08:00:00.000+0000' },
      { Id: '003000000000003AAA', LastModifiedDate: '2021-06-01T08:00:00.000+0000' },
    ];
    /** The rows a keyset WHERE keeps, as the org reads it, in its ORDER BY. */
    const query = vi.fn(async (soql: string) => {
      if (soql.startsWith('SELECT COUNT()')) return { totalSize: stale.length, records: [] };
      const past = /LastModifiedDate > (\S+) OR \(LastModifiedDate = \S+ AND Id > '(\w+)'\)/.exec(
        soql,
      );
      const at = (iso: string) => Date.parse(iso.replace(/\+0000$/, 'Z'));
      const rows = stale
        .filter(
          (r) =>
            !past ||
            at(r.LastModifiedDate) > at(past[1]) ||
            (at(r.LastModifiedDate) === at(past[1]) && r.Id > past[2]),
        )
        .sort(
          (a, b) => at(a.LastModifiedDate) - at(b.LastModifiedDate) || a.Id.localeCompare(b.Id),
        );
      const limit = Number(/LIMIT (\d+)/.exec(soql)?.[1]);
      return { totalSize: rows.length, records: rows.slice(0, limit) };
    });
    const conn = { describe: async () => contactDescribe, query };

    const taken: string[] = [];
    let after: Parameters<typeof resolveRecommendation>[4];
    for (let page = 0; page < 3; page++) {
      const resolved = await resolveRecommendation(
        conn,
        'Contact',
        { kind: 'stale', days: 365 },
        2,
        after,
      );
      taken.push(...resolved.ids);
      after = resolved.next;
      if (page < 2) expect(resolved.next).toMatchObject({ skip: taken.length });
      else {
        expect(resolved.truncated).toBe(false);
        expect(resolved.next).toBeUndefined();
      }
    }

    expect(taken).toEqual([
      '003000000000002AAA',
      '003000000000005AAA',
      '003000000000004AAA',
      '003000000000001AAA',
      '003000000000003AAA',
    ]);
    // A date as SOQL takes one, to the second.
    expect(query.mock.calls.at(-1)?.[0]).toContain(
      "(LastModifiedDate > 2021-06-01T08:00:00Z OR (LastModifiedDate = 2021-06-01T08:00:00Z AND Id > '003000000000001AAA'))",
    );
  });

  it('carries an export of orphans on past the last Id the one before it took', async () => {
    const query = vi.fn(async (soql: string) => {
      if (soql === 'SELECT COUNT() FROM Contact') return { totalSize: 100, records: [] };
      if (soql.startsWith('SELECT COUNT()')) return { totalSize: 3, records: [] };
      return soql.includes("Id > '003000000000002AAA'")
        ? { totalSize: 1, records: [{ Id: '003000000000009AAA' }] }
        : { totalSize: 2, records: [{ Id: '003000000000001AAA' }, { Id: '003000000000002AAA' }] };
    });
    const conn = { describe: async () => contactDescribe, query };
    const orphans = { kind: 'orphans', fieldApiName: 'ReportsToId' } as const;
    // ReportsToId is filled by few in contactOrg; here 97 of 100 fill it.
    const first = await resolveRecommendation(conn, 'Contact', orphans, 2);
    const second = await resolveRecommendation(conn, 'Contact', orphans, 2, first.next);

    expect(first.next).toEqual({ skip: 2, id: '003000000000002AAA' });
    expect(query.mock.calls.at(-1)?.[0]).toBe(
      "SELECT Id FROM Contact WHERE ReportsToId = null AND Id > '003000000000002AAA' ORDER BY Id LIMIT 2",
    );
    expect(second).toMatchObject({ ids: ['003000000000009AAA'], truncated: false });
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
