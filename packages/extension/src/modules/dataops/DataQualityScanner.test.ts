import { describe, it, expect } from 'vitest';
import type { DataQualityObjectScan } from '@sandforge/shared';
import {
  DUPLICATE_GROUP_LIMIT,
  DUPLICATE_SAMPLE,
  FILL_COUNTS_PER_QUERY,
  SINGLE_FIELD_QUERIES,
  scanDataQuality,
} from './DataQualityScanner.js';
import type { QualityScanConnection } from './DataQualityScanner.js';

/** A describe field with the attributes a scan reads; a writable text field by default. */
function field(name: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name,
    label: `${name} label`,
    type: 'string',
    createable: true,
    updateable: true,
    nillable: true,
    defaultedOnCreate: false,
    aggregatable: true,
    groupable: true,
    filterable: true,
    ...overrides,
  };
}

/** The fields an org answers for most objects, whatever else they carry. */
const SYSTEM_FIELDS = [
  field('Id', {
    type: 'id',
    createable: false,
    updateable: false,
    nillable: false,
    groupable: false,
  }),
  field('LastModifiedDate', { type: 'datetime', createable: false, updateable: false }),
];

type Answer = { totalSize: number; records: unknown[] } | Error;

/**
 * An org that answers describes from a table and queries from a list of
 * (pattern, answer) pairs, first match wins, and records every query sent.
 */
function fakeOrg(
  describes: Record<string, unknown>,
  answers: Array<[RegExp, Answer]>,
): QualityScanConnection & { sent: string[] } {
  const sent: string[] = [];
  return {
    sent,
    describe: async (objectApiName) => {
      const described = describes[objectApiName];
      if (!described)
        throw new Error(`INVALID_TYPE: sObject type '${objectApiName}' is not supported.`);
      return described;
    },
    query: async (soql) => {
      sent.push(soql);
      const match = answers.find(([pattern]) => pattern.test(soql));
      if (!match) throw new Error(`No answer for: ${soql}`);
      if (match[1] instanceof Error) throw match[1];
      return match[1];
    },
  };
}

const count = (totalSize: number): Answer => ({ totalSize, records: [] });

/** The single aggregate row a fill query answers, `expr0`… in the order asked. */
const fillRow = (...values: number[]): Answer => ({
  totalSize: 1,
  records: [Object.fromEntries(values.map((v, i) => [`expr${i}`, v]))],
});

const scan = (
  conn: QualityScanConnection,
  objects: Array<{ objectApiName: string; duplicateKey?: string }>,
  staleDays = 365,
) =>
  scanDataQuality(
    conn,
    { orgId: 'org-1', objects, staleDays },
    () => new Date('2026-09-01T10:00:00Z'),
  );

const scanned = (result: Awaited<ReturnType<typeof scan>>, index = 0): DataQualityObjectScan => {
  const object = result.objects[index];
  if (object.status !== 'scanned') throw new Error(`object ${index} failed: ${object.message}`);
  return object;
};

const ACCOUNT = {
  name: 'Account',
  label: 'Account',
  queryable: true,
  fields: [
    ...SYSTEM_FIELDS,
    field('Name', { nillable: false, nameField: true }),
    field('Phone', { type: 'phone' }),
    field('Description', {
      type: 'textarea',
      aggregatable: false,
      groupable: false,
      filterable: false,
    }),
    field('Brand__c', { type: 'multipicklist', aggregatable: false, groupable: false }),
    field('IsPartner__c', { type: 'boolean', nillable: false, defaultedOnCreate: true }),
    field('Score__c', { type: 'double', createable: false, updateable: false }),
  ],
};

describe('scanDataQuality — fill counts', () => {
  it('counts every field people fill in with one aggregate query, and reads no record', async () => {
    const org = fakeOrg({ Account: ACCOUNT }, [
      [/^SELECT COUNT\(\) FROM Account$/, count(16)],
      [/^SELECT COUNT\(Name\), COUNT\(Phone\) FROM Account$/, fillRow(16, 15)],
      [/WHERE Brand__c != null$/, count(9)],
      [/GROUP BY/, { totalSize: 0, records: [] }],
      [/LAST_N_DAYS/, count(0)],
    ]);

    const account = scanned(await scan(org, [{ objectApiName: 'Account' }]));

    expect(account.totalRecords).toBe(16);
    expect(account.fields).toEqual([
      { fieldApiName: 'Brand__c', label: 'Brand__c label', filled: 9, required: false },
      { fieldApiName: 'Phone', label: 'Phone label', filled: 15, required: false },
      { fieldApiName: 'Name', label: 'Name label', filled: 16, required: true },
    ]);
    // Every query is answered with a count or aggregate rows, never records.
    expect(org.sent.every((soql) => /COUNT\(/.test(soql))).toBe(true);
  });

  it('leaves out what nobody fills in: the Id, system stamps, formulas and checkboxes', async () => {
    const org = fakeOrg({ Account: ACCOUNT }, [
      [/^SELECT COUNT\(\) FROM Account$/, count(16)],
      [/^SELECT COUNT\(Name\)/, fillRow(16, 15)],
      [/WHERE Brand__c != null$/, count(9)],
      [/GROUP BY/, { totalSize: 0, records: [] }],
      [/LAST_N_DAYS/, count(0)],
    ]);

    const account = scanned(await scan(org, [{ objectApiName: 'Account' }]));
    const named = [...account.fields, ...account.unmeasured].map((f) => f.fieldApiName);

    for (const skipped of ['Id', 'LastModifiedDate', 'Score__c', 'IsPartner__c']) {
      expect(named).not.toContain(skipped);
    }
  });

  it('names a field the org can neither count nor filter instead of leaving it out', async () => {
    const org = fakeOrg({ Account: ACCOUNT }, [
      [/^SELECT COUNT\(\) FROM Account$/, count(16)],
      [/^SELECT COUNT\(Name\)/, fillRow(16, 15)],
      [/WHERE Brand__c != null$/, count(9)],
      [/GROUP BY/, { totalSize: 0, records: [] }],
      [/LAST_N_DAYS/, count(0)],
    ]);

    const account = scanned(await scan(org, [{ objectApiName: 'Account' }]));

    expect(account.unmeasured).toEqual([
      { fieldApiName: 'Description', label: 'Description label', reason: 'not-countable' },
    ]);
  });

  it('splits the counts into queries of at most 100, the most one query may alias', async () => {
    const many = Array.from({ length: 150 }, (_, i) => field(`F${String(i).padStart(3, '0')}__c`));
    const described = {
      name: 'Wide__c',
      label: 'Wide',
      queryable: true,
      fields: [...SYSTEM_FIELDS, ...many],
    };
    const org = fakeOrg({ Wide__c: described }, [
      [/^SELECT COUNT\(\) FROM Wide__c$/, count(4)],
      [/^SELECT COUNT\(F000__c\)/, fillRow(...Array.from({ length: 100 }, () => 4))],
      [/^SELECT COUNT\(F100__c\)/, fillRow(...Array.from({ length: 50 }, () => 1))],
      [/LAST_N_DAYS/, count(0)],
    ]);

    const wide = scanned(await scan(org, [{ objectApiName: 'Wide__c' }]));

    const fillQueries = org.sent.filter((soql) => /^SELECT COUNT\(F/.test(soql));
    expect(fillQueries.map((soql) => soql.match(/COUNT\(/g)?.length)).toEqual([
      FILL_COUNTS_PER_QUERY,
      50,
    ]);
    expect(wide.fields).toHaveLength(150);
    expect(wide.fields.find((f) => f.fieldApiName === 'F120__c')?.filled).toBe(1);
    expect(wide.fields.find((f) => f.fieldApiName === 'F020__c')?.filled).toBe(4);
  });

  it('counts a filter-only field with a query of its own, up to the budget, and names the rest', async () => {
    const picklists = Array.from({ length: SINGLE_FIELD_QUERIES + 5 }, (_, i) =>
      field(`Pick${String(i).padStart(2, '0')}__c`, { type: 'multipicklist', aggregatable: false }),
    );
    const described = {
      name: 'Survey__c',
      label: 'Survey',
      queryable: true,
      fields: [...SYSTEM_FIELDS, ...picklists],
    };
    const org = fakeOrg({ Survey__c: described }, [
      [/^SELECT COUNT\(\) FROM Survey__c$/, count(10)],
      [/WHERE Pick\d+__c != null$/, count(3)],
      [/LAST_N_DAYS/, count(0)],
    ]);

    const survey = scanned(await scan(org, [{ objectApiName: 'Survey__c' }]));

    expect(org.sent.filter((soql) => /WHERE Pick/.test(soql))).toHaveLength(SINGLE_FIELD_QUERIES);
    expect(survey.fields).toHaveLength(SINGLE_FIELD_QUERIES);
    expect(survey.unmeasured.map((f) => f.reason)).toEqual(Array(5).fill('query-budget'));
  });

  it('names the fields of a count the org refused, with what it said, and keeps the rest', async () => {
    const org = fakeOrg({ Account: ACCOUNT }, [
      [/^SELECT COUNT\(\) FROM Account$/, count(16)],
      [
        /^SELECT COUNT\(Name\)/,
        new Error('QUERY_TIMEOUT: Your query request was running for too long.'),
      ],
      [/WHERE Brand__c != null$/, count(9)],
      [/GROUP BY/, { totalSize: 0, records: [] }],
      [/LAST_N_DAYS/, count(2)],
    ]);

    const account = scanned(await scan(org, [{ objectApiName: 'Account' }]));

    expect(account.fields.map((f) => f.fieldApiName)).toEqual(['Brand__c']);
    expect(
      account.unmeasured.filter((f) => f.reason === 'refused').map((f) => f.fieldApiName),
    ).toEqual(['Name', 'Phone']);
    expect(account.errors).toEqual([
      { check: 'fill', message: 'QUERY_TIMEOUT: Your query request was running for too long.' },
    ]);
    expect(account.stale).toEqual({ days: 365, records: 2 });
  });

  it('marks a field the platform requires although the describe calls it nillable', async () => {
    const described = {
      name: 'OpportunityLineItem',
      label: 'Opportunity Product',
      queryable: true,
      fields: [
        ...SYSTEM_FIELDS,
        field('PricebookEntryId', { type: 'reference' }),
        field('Description'),
      ],
    };
    const org = fakeOrg({ OpportunityLineItem: described }, [
      [/^SELECT COUNT\(\) FROM OpportunityLineItem$/, count(5)],
      [/^SELECT COUNT\(PricebookEntryId\)/, fillRow(4, 1)],
      [/LAST_N_DAYS/, count(0)],
    ]);

    const lines = scanned(await scan(org, [{ objectApiName: 'OpportunityLineItem' }]));

    expect(lines.fields.find((f) => f.fieldApiName === 'PricebookEntryId')).toMatchObject({
      filled: 4,
      required: true,
    });
    expect(lines.fields.find((f) => f.fieldApiName === 'Description')?.required).toBe(false);
  });
});

describe('scanDataQuality — duplicates', () => {
  const CONTACT = {
    name: 'Contact',
    label: 'Contact',
    queryable: true,
    fields: [
      ...SYSTEM_FIELDS,
      // Composed by the org from the first and last names: unwritable, and still the record's name.
      field('Name', { createable: false, updateable: false, nameField: true }),
      field('Email', { type: 'email' }),
      field('AccountId', { type: 'reference' }),
    ],
  };
  const answersFor = (duplicateAnswer: Answer): Array<[RegExp, Answer]> => [
    [/^SELECT COUNT\(\) FROM Contact$/, count(18)],
    [/^SELECT COUNT\(Email\)/, fillRow(17, 18)],
    [/GROUP BY/, duplicateAnswer],
    [/LAST_N_DAYS/, count(0)],
  ];

  it('groups by Email when the request names no key, most repeated first', async () => {
    const org = fakeOrg(
      { Contact: CONTACT },
      answersFor({
        totalSize: 2,
        records: [
          { k: 'shared@example.com', n: 3 },
          { k: 'twice@example.com', n: 2 },
        ],
      }),
    );

    const contact = scanned(await scan(org, [{ objectApiName: 'Contact' }]));

    expect(org.sent).toContain(
      'SELECT Email k, COUNT(Id) n FROM Contact WHERE Email != null GROUP BY Email ' +
        `HAVING COUNT(Id) > 1 ORDER BY COUNT(Id) DESC LIMIT ${DUPLICATE_GROUP_LIMIT}`,
    );
    expect(contact.duplicates).toEqual({
      keyField: 'Email',
      keyLabel: 'Email label',
      groups: [
        { value: 'shared@example.com', count: 3 },
        { value: 'twice@example.com', count: 2 },
      ],
      groupCount: 2,
      recordCount: 5,
      truncated: false,
    });
  });

  it("falls back to the record's name when the object has no Email", async () => {
    const org = fakeOrg({ Account: ACCOUNT }, [
      [/^SELECT COUNT\(\) FROM Account$/, count(16)],
      [/^SELECT COUNT\(Name\)/, fillRow(16, 15)],
      [/WHERE Brand__c != null$/, count(9)],
      [/GROUP BY Name/, { totalSize: 1, records: [{ k: 'Acme', n: 2 }] }],
      [/LAST_N_DAYS/, count(0)],
    ]);

    const account = scanned(await scan(org, [{ objectApiName: 'Account' }]));

    expect(account.duplicates?.keyField).toBe('Name');
    expect(account.duplicates?.groups).toEqual([{ value: 'Acme', count: 2 }]);
  });

  it('groups by the key the request names, and offers every field the org can group by', async () => {
    const org = fakeOrg(
      { Contact: CONTACT },
      answersFor({ totalSize: 1, records: [{ k: '001000000000001AAA', n: 2 }] }),
    );

    const contact = scanned(
      await scan(org, [{ objectApiName: 'Contact', duplicateKey: 'AccountId' }]),
    );

    expect(org.sent.find((soql) => /GROUP BY/.test(soql))).toMatch(
      /^SELECT AccountId k, .* GROUP BY AccountId /,
    );
    expect(contact.duplicates?.keyField).toBe('AccountId');
    // The record's name is offered although nobody writes it; the audit stamp is not.
    expect(contact.keyFields.map((f) => f.fieldApiName)).toEqual(['AccountId', 'Email', 'Name']);
  });

  it('says so when the key it was asked for cannot be grouped by, and still runs the other checks', async () => {
    const org = fakeOrg({ Account: ACCOUNT }, [
      [/^SELECT COUNT\(\) FROM Account$/, count(16)],
      [/^SELECT COUNT\(Name\)/, fillRow(16, 15)],
      [/WHERE Brand__c != null$/, count(9)],
      [/LAST_N_DAYS/, count(4)],
    ]);

    const account = scanned(
      await scan(org, [{ objectApiName: 'Account', duplicateKey: 'Description' }]),
    );

    expect(org.sent.some((soql) => /GROUP BY/.test(soql))).toBe(false);
    expect(account.duplicates).toBeNull();
    expect(account.errors).toEqual([
      {
        check: 'duplicates',
        message: 'Account has no field Description the org can group records by.',
      },
    ]);
    expect(account.stale?.records).toBe(4);
  });

  it('says the search stopped when it reached its limit, and hands back only the most repeated', async () => {
    const records = Array.from({ length: DUPLICATE_GROUP_LIMIT }, (_, i) => ({
      k: `v${i}`,
      n: i < 3 ? 5 : 2,
    }));
    const org = fakeOrg(
      { Contact: CONTACT },
      answersFor({ totalSize: DUPLICATE_GROUP_LIMIT, records }),
    );

    const contact = scanned(await scan(org, [{ objectApiName: 'Contact' }]));

    expect(contact.duplicates?.truncated).toBe(true);
    expect(contact.duplicates?.groupCount).toBe(DUPLICATE_GROUP_LIMIT);
    expect(contact.duplicates?.recordCount).toBe(3 * 5 + (DUPLICATE_GROUP_LIMIT - 3) * 2);
    expect(contact.duplicates?.groups).toHaveLength(DUPLICATE_SAMPLE);
    expect(contact.duplicates?.groups[0]).toEqual({ value: 'v0', count: 5 });
  });

  it('reports a search the org refused and keeps the fill counts', async () => {
    const org = fakeOrg(
      { Contact: CONTACT },
      answersFor(new Error("MALFORMED_QUERY: field 'Email' can not be grouped in a query call")),
    );

    const contact = scanned(await scan(org, [{ objectApiName: 'Contact' }]));

    expect(contact.duplicates).toBeNull();
    expect(contact.errors).toEqual([
      {
        check: 'duplicates',
        message: "MALFORMED_QUERY: field 'Email' can not be grouped in a query call",
      },
    ]);
    expect(contact.fields.map((f) => f.filled)).toEqual([17, 18]);
  });
});

describe('scanDataQuality — stale records', () => {
  it('counts the records not modified within the threshold', async () => {
    const org = fakeOrg({ Account: ACCOUNT }, [
      [/^SELECT COUNT\(\) FROM Account$/, count(16)],
      [/^SELECT COUNT\(Name\)/, fillRow(16, 15)],
      [/WHERE Brand__c != null$/, count(9)],
      [/GROUP BY/, { totalSize: 0, records: [] }],
      [/LAST_N_DAYS:14$/, count(1)],
    ]);

    const account = scanned(await scan(org, [{ objectApiName: 'Account' }], 14));

    expect(org.sent).toContain(
      'SELECT COUNT() FROM Account WHERE LastModifiedDate < LAST_N_DAYS:14',
    );
    expect(account.stale).toEqual({ days: 14, records: 1 });
  });

  it('has no staleness for an object without a LastModifiedDate to filter on', async () => {
    const described = {
      name: 'Log__c',
      label: 'Log',
      queryable: true,
      fields: [field('Id', { createable: false, updateable: false }), field('Message__c')],
    };
    const org = fakeOrg({ Log__c: described }, [
      [/^SELECT COUNT\(\) FROM Log__c$/, count(3)],
      [/^SELECT COUNT\(Message__c\)/, fillRow(3)],
    ]);

    const log = scanned(await scan(org, [{ objectApiName: 'Log__c' }]));

    expect(log.stale).toBeNull();
    expect(org.sent.some((soql) => /LAST_N_DAYS/.test(soql))).toBe(false);
  });

  it('refuses a threshold that is not a whole number of days, since it is written into the query', async () => {
    const org = fakeOrg({ Account: ACCOUNT }, []);

    await expect(scan(org, [{ objectApiName: 'Account' }], 1.5)).rejects.toThrow(
      /whole number of days/,
    );
    expect(org.sent).toEqual([]);
  });
});

describe('scanDataQuality — objects', () => {
  it('asks nothing more of an object with no records than its describe and its count', async () => {
    const org = fakeOrg({ Account: ACCOUNT }, [[/^SELECT COUNT\(\) FROM Account$/, count(0)]]);

    const account = scanned(await scan(org, [{ objectApiName: 'Account' }]));

    expect(org.sent).toEqual(['SELECT COUNT() FROM Account']);
    expect(account.fields.every((f) => f.filled === 0)).toBe(true);
    expect(account.duplicates).toMatchObject({ keyField: 'Name', groupCount: 0, truncated: false });
    expect(account.stale).toEqual({ days: 365, records: 0 });
  });

  it('fails an object the org will not describe, and still scans the next one', async () => {
    const org = fakeOrg({ Account: ACCOUNT }, [[/^SELECT COUNT\(\) FROM Account$/, count(0)]]);

    const result = await scan(org, [{ objectApiName: 'Missing__c' }, { objectApiName: 'Account' }]);

    expect(result.objects[0]).toEqual({
      status: 'failed',
      objectApiName: 'Missing__c',
      message: "INVALID_TYPE: sObject type 'Missing__c' is not supported.",
    });
    expect(result.objects[1].status).toBe('scanned');
  });

  it('fails an object the org describes as not queryable, without querying it', async () => {
    const org = fakeOrg({ Secret__c: { ...ACCOUNT, name: 'Secret__c', queryable: false } }, []);

    const result = await scan(org, [{ objectApiName: 'Secret__c' }]);

    expect(result.objects[0]).toMatchObject({
      status: 'failed',
      message: 'Secret__c cannot be queried.',
    });
    expect(org.sent).toEqual([]);
  });

  it('carries the bounds it worked within, the threshold and the time it ran', async () => {
    const org = fakeOrg({ Account: ACCOUNT }, [[/^SELECT COUNT\(\) FROM Account$/, count(0)]]);

    const result = await scan(org, [{ objectApiName: 'Account' }], 30);

    expect(result).toMatchObject({
      orgId: 'org-1',
      staleDays: 30,
      scannedAt: '2026-09-01T10:00:00.000Z',
      bounds: {
        duplicateGroupLimit: DUPLICATE_GROUP_LIMIT,
        duplicateSample: DUPLICATE_SAMPLE,
        singleFieldQueries: SINGLE_FIELD_QUERIES,
      },
    });
  });
});
