import { describe, expect, it } from 'vitest';

import { MAX_STATEMENT_URI_CHARS } from '../../../core/common/wideRead.js';
import { MOST_WIRE_CHARS, SampleSourceOrg } from '../../../test/sampleSourceOrg.js';
import {
  ROWS_PER_PAGE,
  SampleSourceReader,
  rootScanRequestsOf,
  runReadOf,
  type RootRead,
  type SampleReaderOptions,
} from './sampleReader.js';

/*
 * What drawing a sample reads of the source, against an org in memory that
 * refuses what the org refuses (`test/sampleSourceOrg.ts`): a column its
 * describe does not list, a statement past the URI, a third semi-join or one
 * beside an OR, an offset past 2 000, a `= null` too slow for a large table.
 * The columns each object answers are those of real describes of a scratch
 * org without person accounts or multiple currencies.
 */

/** A fake id: the object's prefix and a counter, the length of a real one. */
const fakeId = (prefix: string, n: number): string => `${prefix}${String(n).padStart(12, '0')}AAA`;

/**
 * Columns as a scratch org without person accounts or multiple currencies
 * describes them; the dates of the last change, the record type, the status
 * and the flags of a case as the describe of another one gave them.
 */
const DESCRIBED: Record<string, string[]> = {
  Account: [
    'Id',
    'Name',
    'ParentId',
    'OwnerId',
    'RecordTypeId',
    'Description',
    'BillingCountry',
    'CreatedDate',
    'LastModifiedDate',
    'SystemModstamp',
    'IsDeleted',
  ],
  Contact: [
    'Id',
    'AccountId',
    'ReportsToId',
    'OwnerId',
    'MailingCountry',
    'CreatedDate',
    'LastModifiedDate',
    'SystemModstamp',
    'IsDeleted',
  ],
  Case: [
    'Id',
    'AccountId',
    'ContactId',
    'ParentId',
    'Status',
    'IsEscalated',
    'CreatedDate',
    'LastModifiedDate',
    'SystemModstamp',
    'IsDeleted',
  ],
  Opportunity: ['Id', 'AccountId', 'CampaignId', 'Pricebook2Id', 'CreatedDate', 'IsDeleted'],
  Task: ['Id', 'WhatId', 'WhoId', 'CreatedDate', 'IsDeleted', 'IsArchived'],
  Pricebook2: ['Id', 'Name', 'IsStandard', 'IsDeleted'],
  PricebookEntry: ['Id', 'Pricebook2Id', 'Product2Id', 'UnitPrice', 'IsActive', 'IsDeleted'],
  Product2: ['Id', 'Name', 'IsActive', 'IsDeleted'],
  FeedItem: ['Id', 'ParentId', 'Type', 'IsDeleted'],
};

/** An org with the columns of {@link DESCRIBED}. */
function describedOrg(): SampleSourceOrg {
  const org = new SampleSourceOrg();
  for (const [object, columns] of Object.entries(DESCRIBED)) org.columns.set(object, columns);
  return org;
}

/** A reader of `org`, the describe its columns, the filters given. */
function readerOf(
  org: SampleSourceOrg,
  filters: Record<string, string> = {},
  describe: Pick<SampleReaderOptions, 'countsBy' | 'sorts'> = {},
): SampleSourceReader {
  return new SampleSourceReader(org.source(), {
    fieldsOf: (object) => org.columns.get(object),
    filterOf: (object) => filters[object],
    ...describe,
  });
}

/** A moment `seconds` after the first, as the org writes a record's dates. */
const madeAt = (seconds: number): string =>
  new Date(Date.UTC(2026, 10, 13, 9, 0, seconds)).toISOString().replace('Z', '+0000');

/** The same moment as a SOQL literal, to the second. */
const literalAt = (seconds: number): string =>
  new Date(Date.UTC(2026, 10, 13, 9, 0, seconds)).toISOString().replace(/\.\d{3}Z$/, 'Z');

/** `count` accounts, each with `contactsEach` contacts; the first contact of each reports to none. */
function accountsAndContacts(org: SampleSourceOrg, count: number, contactsEach = 0): void {
  let contact = 0;
  for (let n = 1; n <= count; n++) {
    org.add('Account', { Id: fakeId('001', n), Name: `A${n}`, ParentId: null, IsDeleted: false });
    for (let c = 0; c < contactsEach; c++) {
      contact++;
      org.add('Contact', {
        Id: fakeId('003', contact),
        AccountId: fakeId('001', n),
        ReportsToId: null,
        IsDeleted: false,
      });
    }
  }
}

/** Every id the draw hands on, per object, in the order handed. */
function collector(): {
  ids: Map<string, string[]>;
  onRoots: (object: string, ids: string[]) => void;
} {
  const ids = new Map<string, string[]>();
  return {
    ids,
    onRoots: (object, given) => ids.set(object, [...(ids.get(object) ?? []), ...given]),
  };
}

describe('the roots of a sample', () => {
  it('counts each object’s roots with its carriers held to null, its filter, and an activity’s deleted rows left out through queryAll', async () => {
    const org = describedOrg();
    accountsAndContacts(org, 3, 2);
    org.add('Contact', {
      Id: fakeId('003', 90),
      AccountId: null,
      ReportsToId: null,
      IsDeleted: false,
    });
    org.add('Task', { Id: fakeId('00T', 1), WhatId: null, WhoId: null, IsDeleted: false });
    org.add('Task', { Id: fakeId('00T', 2), WhatId: null, WhoId: null, IsDeleted: true });
    org.add('Task', {
      Id: fakeId('00T', 3),
      WhatId: null,
      WhoId: null,
      IsDeleted: false,
      IsArchived: true,
    });
    const reader = readerOf(org, { Account: "Name != 'A2'" });

    const counts = await reader.countRoots([
      { objectApiName: 'Account', carriers: [{ field: 'ParentId' }] },
      { objectApiName: 'Contact', carriers: [{ field: 'AccountId' }] },
      { objectApiName: 'Task', carriers: [] },
    ]);

    expect(counts).toEqual([
      { objectApiName: 'Account', rows: 2, exact: true },
      { objectApiName: 'Contact', rows: 1, exact: true },
      // The archived task with the live one; the deleted one left out.
      { objectApiName: 'Task', rows: 2, exact: true },
    ]);
    expect(org.sent).toEqual([
      { soql: "SELECT COUNT() FROM Account WHERE (Name != 'A2') AND ParentId = null", all: false },
      { soql: 'SELECT COUNT() FROM Contact WHERE AccountId = null', all: false },
      { soql: 'SELECT COUNT() FROM Task WHERE IsDeleted = false', all: true },
    ]);
  });

  it('reads every root id, a page at a time, and hands on each page’s roots as it comes', async () => {
    const org = describedOrg();
    org.pageSize = 3;
    accountsAndContacts(org, 7);
    org.add('Account', { Id: fakeId('001', 50), Name: 'Child', ParentId: fakeId('001', 1) });
    const reader = readerOf(org);
    const read: RootRead = { objectApiName: 'Account', carriers: [{ field: 'ParentId' }] };
    const pages: number[] = [];

    await reader.countRoots([read]);
    await reader.drawUniform([read], (_object, ids) => {
      pages.push(ids.length);
    });

    expect(pages).toEqual([3, 3, 1]);
    expect(org.sent.at(-1)?.soql).toBe('SELECT Id FROM Account WHERE ParentId = null');
  });

  it('keeps a task a root when its lookups name records of objects not drawn, and takes it out when one names a drawn one, without a semi-join', async () => {
    const org = describedOrg();
    const drawn = new Set(['001', '006']);
    const task = (n: number, WhatId: string | null, WhoId: string | null) =>
      org.add('Task', { Id: fakeId('00T', n), WhatId, WhoId, IsDeleted: false });
    task(1, null, null);
    task(2, fakeId('001', 1), null); // an account, drawn
    task(3, fakeId('a0B', 1), null); // a record of an object the run leaves out
    task(4, null, fakeId('003', 1)); // a contact, drawn
    task(5, fakeId('006', 1), fakeId('00Q', 1)); // an opportunity, drawn
    task(6, fakeId('a0B', 2), fakeId('00Q', 2)); // a lead, not drawn
    const reader = readerOf(org);
    const read: RootRead = {
      objectApiName: 'Task',
      carriers: [
        { field: 'WhatId', drawnPrefixes: drawn },
        { field: 'WhoId', drawnPrefixes: new Set(['003']) },
      ],
    };
    const { ids, onRoots } = collector();

    const [count] = await reader.countRoots([read]);
    await reader.drawUniform([read], onRoots);

    expect(ids.get('Task')).toEqual([fakeId('00T', 1), fakeId('00T', 3), fakeId('00T', 6)]);
    // Counted with every task: which of them are roots, only the read tells.
    expect(count).toEqual({ objectApiName: 'Task', rows: 6, exact: false });
    expect(org.sent.map((sent) => sent.soql).filter((soql) => /\(\s*SELECT/i.test(soql))).toEqual(
      [],
    );
  });

  it('reads an object whose null lookups run past the org’s time without them, its lookups tested here, count and ids alike', async () => {
    const org = describedOrg();
    accountsAndContacts(org, 2, 2);
    org.add('Contact', { Id: fakeId('003', 90), AccountId: null, ReportsToId: null });
    org.add('Contact', { Id: fakeId('003', 91), AccountId: null, ReportsToId: fakeId('003', 1) });
    org.slow.add('Contact');
    const reader = readerOf(org);
    const read: RootRead = {
      objectApiName: 'Contact',
      carriers: [{ field: 'AccountId' }, { field: 'ReportsToId' }],
    };
    const { ids, onRoots } = collector();

    const [count] = await reader.countRoots([read]);
    await reader.drawUniform([read], onRoots);

    expect(count).toEqual({ objectApiName: 'Contact', rows: 6, exact: false, timedOut: true });
    expect(ids.get('Contact')).toEqual([fakeId('003', 90)]);
    expect(org.sent.map((sent) => sent.soql)).toEqual([
      'SELECT COUNT() FROM Contact WHERE AccountId = null AND ReportsToId = null',
      'SELECT COUNT() FROM Contact',
      'SELECT Id, AccountId, ReportsToId FROM Contact',
    ]);
  });

  it('reads the roots whose ids run past the org’s time without their null lookups, though their count was answered', async () => {
    const org = describedOrg();
    accountsAndContacts(org, 2, 1);
    org.add('Contact', { Id: fakeId('003', 90), AccountId: null, ReportsToId: null });
    const reader = readerOf(org);
    const read: RootRead = { objectApiName: 'Contact', carriers: [{ field: 'AccountId' }] };
    const { ids, onRoots } = collector();

    await reader.countRoots([read]);
    org.slow.add('Contact');
    await reader.drawUniform([read], onRoots);

    expect(ids.get('Contact')).toEqual([fakeId('003', 90)]);
    expect(org.sent.slice(1).map((sent) => sent.soql)).toEqual([
      'SELECT Id FROM Contact WHERE AccountId = null',
      'SELECT Id, AccountId FROM Contact',
    ]);
  });

  it('reads the newest roots first by the date they were made, not by their ids, rows of one second by id, each page after the last date and id', async () => {
    const org = describedOrg();
    // Two loads: the accounts of the later one hold the smaller ids, five hundred a second.
    for (let n = 1; n <= 4_600; n++) {
      const second = n <= 2_300 ? 10 + Math.floor((n - 1) / 500) : Math.floor((n - 2_301) / 500);
      org.add('Account', { Id: fakeId('001', n), ParentId: null, CreatedDate: madeAt(second) });
    }
    const reader = readerOf(org);
    const read = { objectApiName: 'Account', carriers: [{ field: 'ParentId' }], take: 4_500 };
    const { ids, onRoots } = collector();

    const [count] = await reader.countRoots([read]);
    const before = reader.requests;
    const drawn = await reader.drawByDate([read], 'recent', onRoots);

    const given = ids.get('Account') ?? [];
    expect(drawn).toEqual([{ objectApiName: 'Account', by: 'created' }]);
    expect(given).toHaveLength(4_500);
    // The later load's last second first, its greatest id first; the earlier load after it.
    expect(given.slice(0, 2)).toEqual([fakeId('001', 2_300), fakeId('001', 2_299)]);
    expect(given.slice(2_299, 2_302)).toEqual([
      fakeId('001', 1),
      fakeId('001', 4_600),
      fakeId('001', 4_599),
    ]);
    expect(given.at(-1)).toBe(fakeId('001', 2_401));
    const select = 'SELECT Id, CreatedDate FROM Account WHERE ParentId = null';
    const order = 'ORDER BY CreatedDate DESC, Id DESC';
    expect(org.sent.slice(1).map((sent) => sent.soql)).toEqual([
      `${select} ${order} LIMIT 2000`,
      // The first page ended inside a second: its other rows come first.
      `${select} AND (CreatedDate < ${literalAt(10)} OR (CreatedDate = ${literalAt(10)} AND Id < '${fakeId('001', 301)}')) ${order} LIMIT 2000`,
      `${select} AND (CreatedDate < ${literalAt(1)} OR (CreatedDate = ${literalAt(1)} AND Id < '${fakeId('001', 2_901)}')) ${order} LIMIT 500`,
    ]);
    expect(reader.requests - before).toBe(rootScanRequestsOf(count, 'recent', 4_500));
  });

  it('reads the page after the last date and id with its OR beside a semi-join of the filter, which stays a term of the statement’s own AND, as a scratch org took it', async () => {
    const org = describedOrg();
    org.add('Account', { Id: fakeId('001', 1), Name: 'A1' });
    const second = (n: number): number => (n > 2_500 ? 8 : n > 1_000 ? 11 : n > 500 ? 10 : 7);
    for (let n = 1; n <= 3_000; n++) {
      org.add('Contact', {
        Id: fakeId('003', n),
        AccountId: fakeId('001', 1),
        CreatedDate: madeAt(second(n)),
      });
    }
    const filter = "AccountId IN (SELECT Id FROM Account WHERE Name != 'A2')";
    const reader = readerOf(org, { Contact: filter });
    const read = { objectApiName: 'Contact', carriers: [], take: 2_300 };
    const { ids, onRoots } = collector();

    const [count] = await reader.countRoots([read]);
    const before = reader.requests;
    await reader.drawByDate([read], 'recent', onRoots);

    const given = ids.get('Contact') ?? [];
    expect(given).toHaveLength(2_300);
    expect(given[0]).toBe(fakeId('003', 2_500));
    // Made a second before the last page's last second, under greater ids.
    expect(given.slice(1_999, 2_001)).toEqual([fakeId('003', 501), fakeId('003', 3_000)]);
    expect(given.at(-1)).toBe(fakeId('003', 2_701));
    // The semi-join written bare: never in parentheses beside the other terms.
    const select = `SELECT Id, CreatedDate FROM Contact WHERE ${filter}`;
    expect(org.sent.map((sent) => sent.soql)).toEqual([
      `SELECT COUNT() FROM Contact WHERE ${filter}`,
      `${select} ORDER BY CreatedDate DESC, Id DESC LIMIT 2000`,
      `${select} AND (CreatedDate < ${literalAt(10)} OR (CreatedDate = ${literalAt(10)} AND Id < '${fakeId('003', 501)}')) ORDER BY CreatedDate DESC, Id DESC LIMIT 300`,
    ]);
    expect(reader.requests - before).toBe(rootScanRequestsOf(count, 'recent', 2_300));
  });

  it('writes a filter that holds a semi-join and an OR of its own in parentheses, which the org then refuses in its words', async () => {
    const org = describedOrg();
    accountsAndContacts(org, 2, 1);
    const filter = 'AccountId IN (SELECT Id FROM Account) OR ReportsToId != null';
    const reader = readerOf(org, { Contact: filter });

    await expect(
      reader.countRoots([{ objectApiName: 'Contact', carriers: [] }]),
    ).rejects.toMatchObject({
      errorCode: 'MALFORMED_QUERY',
      message:
        'Semi join sub-selects are only allowed at the top level WHERE expressions and not in ' +
        'nested WHERE expressions.',
    });
    expect(org.sent.map((sent) => sent.soql)).toEqual([
      `SELECT COUNT() FROM Contact WHERE (${filter})`,
    ]);
  });

  it('reads the newest of an object with no creation date it orders by in the order of its ids, and says so', async () => {
    const org = describedOrg();
    org.columns.set('Region__c', ['Id', 'Parent__c', 'IsDeleted']);
    for (let n = 1; n <= 5; n++) {
      org.add('Region__c', { Id: fakeId('a0R', n), Parent__c: null });
      org.add('Account', { Id: fakeId('001', n), ParentId: null, CreatedDate: madeAt(n) });
    }
    const reader = readerOf(org, {}, { sorts: (object) => object !== 'Account' });
    const reads = [
      { objectApiName: 'Region__c', carriers: [{ field: 'Parent__c' }], take: 2 },
      { objectApiName: 'Account', carriers: [{ field: 'ParentId' }], take: 2 },
    ];
    const { ids, onRoots } = collector();

    await reader.countRoots(reads);
    const drawn = await reader.drawByDate(reads, 'recent', onRoots);

    expect(drawn).toEqual([
      { objectApiName: 'Region__c', by: 'id' },
      { objectApiName: 'Account', by: 'id' },
    ]);
    expect(ids.get('Region__c')).toEqual([fakeId('a0R', 5), fakeId('a0R', 4)]);
    expect(org.sent.slice(2).map((sent) => sent.soql)).toEqual([
      'SELECT Id FROM Region__c WHERE Parent__c = null ORDER BY Id DESC LIMIT 2',
      'SELECT Id FROM Account WHERE ParentId = null ORDER BY Id DESC LIMIT 2',
    ]);
  });

  it('reads no id of an object counted to hold no root', async () => {
    const org = describedOrg();
    accountsAndContacts(org, 2, 1);
    const reader = readerOf(org);
    const read: RootRead = { objectApiName: 'Contact', carriers: [{ field: 'AccountId' }] };

    const [count] = await reader.countRoots([read]);
    await reader.drawUniform([read], () => {
      throw new Error('no root to hand on');
    });
    await reader.drawByDate([{ ...read, take: 10 }], 'recent', () => {
      throw new Error('no root to hand on');
    });

    expect(count.rows).toBe(0);
    expect(org.sent).toHaveLength(1);
    expect(rootScanRequestsOf(count, 'uniform')).toBe(0);
  });

  it('reads the newest tasks through queryAll, every one made in the same second, a page at a time, until it has kept as many as it takes', async () => {
    const org = describedOrg();
    for (let n = 1; n <= 2_500; n++) {
      // Every other task names an account, drawn; all were made in one second.
      org.add('Task', {
        Id: fakeId('00T', n),
        WhatId: n % 2 === 0 ? fakeId('001', n) : null,
        CreatedDate: madeAt(0),
        IsDeleted: false,
      });
    }
    org.add('Task', { Id: fakeId('00T', 2_501), CreatedDate: madeAt(0), IsDeleted: true });
    const reader = readerOf(org);
    const read = {
      objectApiName: 'Task',
      carriers: [{ field: 'WhatId', drawnPrefixes: new Set(['001']) }],
      take: 1_100,
    };
    const { ids, onRoots } = collector();

    await reader.countRoots([read]);
    await reader.drawByDate([read], 'recent', onRoots);

    const given = ids.get('Task') ?? [];
    expect(given).toHaveLength(1_100);
    expect(given[0]).toBe(fakeId('00T', 2_499));
    expect(given.at(-1)).toBe(fakeId('00T', 301));
    const select = 'SELECT Id, WhatId, CreatedDate FROM Task WHERE IsDeleted = false';
    const order = 'ORDER BY CreatedDate DESC, Id DESC LIMIT 2000';
    expect(org.sent.slice(1)).toEqual([
      { soql: `${select} ${order}`, all: true },
      {
        soql: `${select} AND (CreatedDate < ${literalAt(0)} OR (CreatedDate = ${literalAt(0)} AND Id < '${fakeId('00T', 501)}')) ${order}`,
        all: true,
      },
    ]);
  });

  it('refuses to hold the roots to a lookup the describe does not list', async () => {
    const org = describedOrg();
    accountsAndContacts(org, 2);
    const reader = readerOf(org);

    await expect(
      reader.countRoots([{ objectApiName: 'Account', carriers: [{ field: 'Parent__c' }] }]),
    ).rejects.toThrow("Account.Parent__c is no field of the source's describe.");
    expect(org.sent).toEqual([]);
  });

  it('says where the reading stands as each object is counted and each is drawn', async () => {
    const org = describedOrg();
    accountsAndContacts(org, 3, 1);
    const said: Array<{ step: string; done?: number; total?: number; requests: number }> = [];
    const reader = new SampleSourceReader(org.source(), {
      fieldsOf: (object) => org.columns.get(object),
      onProgress: ({ step, done, total, requests }) => said.push({ step, done, total, requests }),
    });
    const reads: RootRead[] = [
      { objectApiName: 'Account', carriers: [{ field: 'ParentId' }] },
      { objectApiName: 'Contact', carriers: [{ field: 'AccountId' }] },
    ];

    await reader.countRoots(reads);
    await reader.drawUniform(reads, () => {});

    expect(said).toEqual([
      { step: 'counting', done: 1, total: 2, requests: 1 },
      { step: 'counting', done: 2, total: 2, requests: 2 },
      // The contacts counted no root: done before the accounts' page is back.
      { step: 'drawing', done: 1, total: 2, requests: 2 },
      { step: 'drawing', done: 2, total: 2, requests: 3 },
    ]);
  });
});

describe('the roots a draw chooses', () => {
  it('reads the oldest roots first by the date they were made, not by their ids, rows of one second by id, each page after the last date and id', async () => {
    const org = describedOrg();
    // Two loads: the accounts of the later one hold the smaller ids, five hundred a second.
    for (let n = 1; n <= 4_600; n++) {
      const second = n <= 2_300 ? 10 + Math.floor((n - 1) / 500) : Math.floor((n - 2_301) / 500);
      org.add('Account', { Id: fakeId('001', n), ParentId: null, CreatedDate: madeAt(second) });
    }
    const reader = readerOf(org);
    const read = { objectApiName: 'Account', carriers: [{ field: 'ParentId' }], take: 2_500 };
    const { ids, onRoots } = collector();

    const [count] = await reader.countRoots([read]);
    const before = reader.requests;
    const drawn = await reader.drawByDate([read], 'oldest', onRoots);

    const given = ids.get('Account') ?? [];
    expect(drawn).toEqual([{ objectApiName: 'Account', by: 'created' }]);
    expect(given).toHaveLength(2_500);
    // The earlier load first, though its ids are the greater, its smallest id first.
    expect(given.slice(0, 2)).toEqual([fakeId('001', 2_301), fakeId('001', 2_302)]);
    expect(given.slice(2_299, 2_301)).toEqual([fakeId('001', 4_600), fakeId('001', 1)]);
    expect(given.at(-1)).toBe(fakeId('001', 200));
    const select = 'SELECT Id, CreatedDate FROM Account WHERE ParentId = null';
    const order = 'ORDER BY CreatedDate ASC, Id ASC';
    expect(org.sent.slice(1).map((sent) => sent.soql)).toEqual([
      `${select} ${order} LIMIT 2000`,
      // The first page ended inside a second: its other rows come first.
      `${select} AND (CreatedDate > ${literalAt(3)} OR (CreatedDate = ${literalAt(3)} AND Id > '${fakeId('001', 4_300)}')) ${order} LIMIT 500`,
    ]);
    expect(reader.requests - before).toBe(rootScanRequestsOf(count, 'oldest', 2_500));
  });

  it('reads the oldest of an object with no creation date it orders by in the order of its ids, the smallest first, and says so', async () => {
    const org = describedOrg();
    org.columns.set('Region__c', ['Id', 'Parent__c', 'IsDeleted']);
    for (let n = 1; n <= 2_100; n++)
      org.add('Region__c', { Id: fakeId('a0R', n), Parent__c: null });
    const reader = readerOf(org);
    const read = { objectApiName: 'Region__c', carriers: [{ field: 'Parent__c' }], take: 2_050 };
    const { ids, onRoots } = collector();

    await reader.countRoots([read]);
    const drawn = await reader.drawByDate([read], 'oldest', onRoots);

    expect(drawn).toEqual([{ objectApiName: 'Region__c', by: 'id' }]);
    expect(ids.get('Region__c')?.slice(0, 2)).toEqual([fakeId('a0R', 1), fakeId('a0R', 2)]);
    expect(ids.get('Region__c')?.at(-1)).toBe(fakeId('a0R', 2_050));
    expect(org.sent.slice(1).map((sent) => sent.soql)).toEqual([
      'SELECT Id FROM Region__c WHERE Parent__c = null ORDER BY Id ASC LIMIT 2000',
      `SELECT Id FROM Region__c WHERE Parent__c = null AND Id > '${fakeId('a0R', 2_000)}' ORDER BY Id ASC LIMIT 50`,
    ]);
  });

  it('holds the roots to a window of the dates they were made in every read of them, and counts the roots of the source without it', async () => {
    const org = describedOrg();
    for (let n = 1; n <= 6; n++) {
      org.add('Account', { Id: fakeId('001', n), ParentId: null, CreatedDate: madeAt(n - 1) });
    }
    const reader = readerOf(org);
    const read: RootRead = {
      objectApiName: 'Account',
      carriers: [{ field: 'ParentId' }],
      window: { field: 'CreatedDate', from: literalAt(2), to: literalAt(4) },
    };
    const uniform = collector();
    const oldest = collector();

    const [count] = await reader.countRoots([read]);
    await reader.drawUniform([read], uniform.onRoots);
    await reader.drawByDate([{ ...read, take: 5 }], 'oldest', oldest.onRoots);

    expect(count).toEqual({
      objectApiName: 'Account',
      rows: 2,
      exact: true,
      inTheSource: { rows: 6, exact: true },
    });
    expect(uniform.ids.get('Account')).toEqual([fakeId('001', 3), fakeId('001', 4)]);
    expect(oldest.ids.get('Account')).toEqual([fakeId('001', 3), fakeId('001', 4)]);
    const window = `CreatedDate >= ${literalAt(2)} AND CreatedDate < ${literalAt(4)}`;
    expect(org.sent.map((sent) => sent.soql)).toEqual([
      `SELECT COUNT() FROM Account WHERE ParentId = null AND ${window}`,
      'SELECT COUNT() FROM Account WHERE ParentId = null',
      `SELECT Id FROM Account WHERE ParentId = null AND ${window}`,
      `SELECT Id, CreatedDate FROM Account WHERE ParentId = null AND ${window} ORDER BY CreatedDate ASC, Id ASC LIMIT 5`,
    ]);
  });

  it('holds a window of the last change to the stamp an index serves too, where the describe lists it', async () => {
    const org = describedOrg();
    org.columns.set('Region__c', ['Id', 'Parent__c', 'LastModifiedDate', 'IsDeleted']);
    for (let n = 1; n <= 4; n++) {
      const at = madeAt(n - 1);
      org.add('Account', {
        Id: fakeId('001', n),
        ParentId: null,
        LastModifiedDate: at,
        SystemModstamp: at,
      });
      org.add('Region__c', { Id: fakeId('a0R', n), Parent__c: null, LastModifiedDate: at });
    }
    const reader = readerOf(org);
    const window = { field: 'LastModifiedDate', from: literalAt(2) } as const;

    const counts = await reader.countRoots([
      { objectApiName: 'Account', carriers: [{ field: 'ParentId' }], window },
      { objectApiName: 'Region__c', carriers: [{ field: 'Parent__c' }], window },
    ]);

    expect(counts.map((count) => count.rows)).toEqual([2, 2]);
    expect(org.sent.map((sent) => sent.soql)).toEqual(
      expect.arrayContaining([
        `SELECT COUNT() FROM Account WHERE ParentId = null AND LastModifiedDate >= ${literalAt(2)} AND SystemModstamp >= ${literalAt(2)}`,
        `SELECT COUNT() FROM Region__c WHERE Parent__c = null AND LastModifiedDate >= ${literalAt(2)}`,
      ]),
    );
  });

  it('tests a window of the last change on the rows read once it runs past the org’s time, the count no longer exact, and asks the same count once', async () => {
    const org = describedOrg();
    org.columns.set('Lead', [
      'Id',
      'CreatedDate',
      'LastModifiedDate',
      'SystemModstamp',
      'IsDeleted',
    ]);
    for (let n = 1; n <= 6; n++) {
      const at = madeAt(n - 1);
      org.add('Lead', {
        Id: fakeId('00Q', n),
        CreatedDate: at,
        LastModifiedDate: at,
        SystemModstamp: at,
      });
    }
    // Stamped in the window by the platform, changed before it: no root of the draw.
    org.add('Lead', {
      Id: fakeId('00Q', 7),
      CreatedDate: madeAt(0),
      LastModifiedDate: madeAt(1),
      SystemModstamp: madeAt(5),
    });
    org.slowOnModified.add('Lead');
    const reader = readerOf(org);
    const read: RootRead = {
      objectApiName: 'Lead',
      carriers: [],
      window: { field: 'LastModifiedDate', from: literalAt(2) },
    };
    const uniform = collector();
    const recent = collector();

    const [count] = await reader.countRoots([read]);
    await reader.drawUniform([read], uniform.onRoots);
    await reader.drawByDate([{ ...read, take: 3 }], 'recent', recent.onRoots);

    expect(count).toEqual({
      objectApiName: 'Lead',
      rows: 7,
      exact: false,
      timedOut: true,
      inTheSource: { rows: 7, exact: false },
    });
    expect(uniform.ids.get('Lead')).toEqual([3, 4, 5, 6].map((n) => fakeId('00Q', n)));
    expect(recent.ids.get('Lead')).toEqual([6, 5, 4].map((n) => fakeId('00Q', n)));
    expect(org.sent.map((sent) => sent.soql)).toEqual([
      `SELECT COUNT() FROM Lead WHERE LastModifiedDate >= ${literalAt(2)} AND SystemModstamp >= ${literalAt(2)}`,
      'SELECT COUNT() FROM Lead',
      'SELECT Id, LastModifiedDate FROM Lead',
      'SELECT Id, LastModifiedDate, CreatedDate FROM Lead ORDER BY CreatedDate DESC, Id DESC LIMIT 2000',
    ]);
  });

  it('holds the roots to the condition of their own, a semi-join written as a term of the statement’s AND beside the OR of the next page, and counts the roots of the source without it', async () => {
    const org = describedOrg();
    for (let n = 1; n <= 2_100; n++) {
      org.add('Account', {
        Id: fakeId('001', n),
        ParentId: null,
        CreatedDate: madeAt(Math.floor(n / 700)),
      });
      // A case names every account but the last forty.
      if (n <= 2_060) org.add('Case', { Id: fakeId('500', n), AccountId: fakeId('001', n) });
    }
    const where = 'Id IN (SELECT AccountId FROM Case)';
    const reader = readerOf(org);
    const read = {
      objectApiName: 'Account',
      carriers: [{ field: 'ParentId' }],
      where,
      take: 2_050,
    };
    const { ids, onRoots } = collector();

    const [count] = await reader.countRoots([read]);
    await reader.drawByDate([read], 'oldest', onRoots);

    expect(count).toEqual({
      objectApiName: 'Account',
      rows: 2_060,
      exact: true,
      inTheSource: { rows: 2_100, exact: true },
    });
    expect(ids.get('Account')).toHaveLength(2_050);
    expect(ids.get('Account')?.at(-1)).toBe(fakeId('001', 2_050));
    const select = `SELECT Id, CreatedDate FROM Account WHERE ParentId = null AND ${where}`;
    const order = 'ORDER BY CreatedDate ASC, Id ASC';
    expect(org.sent.map((sent) => sent.soql)).toEqual([
      `SELECT COUNT() FROM Account WHERE ParentId = null AND ${where}`,
      'SELECT COUNT() FROM Account WHERE ParentId = null',
      `${select} ${order} LIMIT 2000`,
      `${select} AND (CreatedDate > ${literalAt(2)} OR (CreatedDate = ${literalAt(2)} AND Id > '${fakeId('001', 2_000)}')) ${order} LIMIT 50`,
    ]);
  });

  it('never holds the records a draw names, holds or copies whole to the window or the condition of its roots', async () => {
    const org = describedOrg();
    for (let n = 1; n <= 4; n++) {
      org.add('Account', {
        Id: fakeId('001', n),
        ParentId: n === 2 ? fakeId('001', 3) : null,
        BillingCountry: n <= 2 ? 'France' : 'Germany',
        CreatedDate: madeAt(n),
      });
      // Contacts made long before their account, in another country.
      org.add('Contact', {
        Id: fakeId('003', n),
        AccountId: fakeId('001', n),
        MailingCountry: 'Spain',
        CreatedDate: madeAt(0),
      });
      org.add('Case', {
        Id: fakeId('500', n),
        AccountId: fakeId('001', n),
        CreatedDate: madeAt(0),
      });
    }
    const where = "BillingCountry = 'France'";
    const window = { field: 'CreatedDate', from: literalAt(1) } as const;
    const reader = readerOf(org);
    const read: RootRead = {
      objectApiName: 'Account',
      carriers: [{ field: 'ParentId' }],
      window,
      where,
    };
    const { ids, onRoots } = collector();

    await reader.countRoots([read]);
    await reader.drawUniform([read], onRoots);
    const roots = org.sent.length;
    const [parents] = await reader.readParents([
      // The parent of the second account, abroad.
      { objectApiName: 'Account', ids: [fakeId('001', 3)], columns: ['BillingCountry'] },
    ]);
    const [children] = await reader.readChildren([
      {
        objectApiName: 'Contact',
        field: 'AccountId',
        parentIds: [fakeId('001', 1)],
        columns: ['MailingCountry'],
        cap: 100,
        sourceRows: 4,
      },
    ]);
    const whole: string[] = [];
    await reader.readWhole([{ objectApiName: 'Case', columns: [] }], (_object, rows) => {
      whole.push(...rows.map((row) => String(row['Id'])));
    });

    expect(ids.get('Account')).toEqual([fakeId('001', 1)]);
    // Every term of the draw in each read of the roots…
    for (const { soql } of org.sent.slice(0, roots)) {
      if (soql === 'SELECT COUNT() FROM Account WHERE ParentId = null') continue;
      expect(soql).toContain(`CreatedDate >= ${literalAt(1)}`);
      expect(soql).toContain(`(${where})`);
    }
    // …and in none of the reads after them.
    for (const { soql } of org.sent.slice(roots)) {
      expect(soql).not.toContain('BillingCountry =');
      expect(soql).not.toContain('CreatedDate >=');
    }
    expect(parents.rows.map((row) => row['BillingCountry'])).toEqual(['Germany']);
    expect(children.rows.map((row) => row['MailingCountry'])).toEqual(['Spain']);
    expect(whole).toHaveLength(4);
  });

  it('refuses a draw whose condition the org will not read, in the org’s words, nothing read past the counts', async () => {
    const org = describedOrg();
    accountsAndContacts(org, 3);
    const reader = readerOf(org, {
      Account: 'Id IN (SELECT AccountId FROM Contact) AND Id IN (SELECT AccountId FROM Case)',
    });

    const unknown = reader.countRoots([
      { objectApiName: 'Account', carriers: [{ field: 'ParentId' }], where: "Nope_Field__c = 'x'" },
    ]);
    await expect(unknown).rejects.toMatchObject({
      name: 'ForgeRunGateError',
      code: 'SAMPLE_DRAW_INVALID',
      sample: { requests: 1 },
    });
    await expect(unknown).rejects.toThrow(
      "The source refused to count the roots of Account in the draw: INVALID_FIELD: No such column 'Nope_Field__c' on entity 'Account'.",
    );
    await expect(unknown).rejects.toThrow(
      'Nothing was written, and the counts sent 1 request(s) of the source. The source reads the condition of its roots (--fit-where Account=…) as it is written',
    );
    // A third semi-join beside the filter's two.
    await expect(
      reader.countRoots([
        {
          objectApiName: 'Account',
          carriers: [{ field: 'ParentId' }],
          where: 'Id IN (SELECT AccountId FROM Opportunity)',
        },
      ]),
    ).rejects.toThrow(
      'The source refused to count the roots of Account in the draw: EXCEEDED_MAX_SEMIJOIN_SUBSELECTS: Maximum 2 semi join sub-selects are allowed.',
    );
    expect(org.sent).toHaveLength(2);
  });

  it('leaves a refusal of a count neither restricted nor stratified as the org gave it', async () => {
    const org = describedOrg();
    accountsAndContacts(org, 3);
    const reader = readerOf(org, { Account: "Nope_Field__c = 'x'" });

    await expect(
      reader.countRoots([{ objectApiName: 'Account', carriers: [{ field: 'ParentId' }] }]),
    ).rejects.toMatchObject({ errorCode: 'INVALID_FIELD' });
  });
});

describe('the strata of a draw', () => {
  /** Accounts of two record types and of none, all roots. */
  function typedAccounts(org: SampleSourceOrg): void {
    const types = [fakeId('012', 1), fakeId('012', 1), fakeId('012', 2), null, fakeId('012', 1)];
    types.forEach((RecordTypeId, index) => {
      org.add('Account', {
        Id: fakeId('001', index + 1),
        ParentId: null,
        RecordTypeId,
        CreatedDate: madeAt(index),
      });
    });
  }

  it('counts the roots by the values of the field, those of none as a value of their own', async () => {
    const org = describedOrg();
    typedAccounts(org);
    const reader = readerOf(org);

    const [count] = await reader.countRoots([
      { objectApiName: 'Account', carriers: [{ field: 'ParentId' }], stratifiedBy: 'RecordTypeId' },
    ]);

    expect(count).toEqual({
      objectApiName: 'Account',
      rows: 5,
      exact: true,
      strata: [
        { value: fakeId('012', 1), rows: 3 },
        { value: fakeId('012', 2), rows: 1 },
        { value: null, rows: 1 },
      ],
    });
    expect(org.sent.map((sent) => sent.soql)).toEqual([
      'SELECT RecordTypeId, COUNT(Id) n FROM Account WHERE ParentId = null GROUP BY RecordTypeId',
    ]);
  });

  it('refuses a stratum the org will not group by, in its words, and one the describe says it does not count by before a request', async () => {
    const org = describedOrg();
    typedAccounts(org);
    const read: RootRead = {
      objectApiName: 'Account',
      carriers: [{ field: 'ParentId' }],
      stratifiedBy: 'Description',
    };

    const grouped = readerOf(org).countRoots([read]);
    await expect(grouped).rejects.toMatchObject({
      code: 'SAMPLE_DRAW_INVALID',
      sample: { requests: 1 },
    });
    await expect(grouped).rejects.toThrow(
      "in the draw: MALFORMED_QUERY: field 'Description' can not be grouped in a query call.",
    );
    await expect(grouped).rejects.toThrow('Stratify Account by a field of few values');

    const sent = org.sent.length;
    const described = readerOf(org, {}, { countsBy: (_object, field) => field !== 'Description' });
    await expect(described.countRoots([read])).rejects.toMatchObject({
      code: 'SAMPLE_DRAW_INVALID',
      sample: { requests: 0 },
    });
    expect(org.sent).toHaveLength(sent);
  });

  it('refuses a stratum of more values than one answer counts, rather than draw from the first of them', async () => {
    const org = describedOrg();
    typedAccounts(org);
    org.pageSize = 2;
    const reader = readerOf(org);

    await expect(
      reader.countRoots([
        {
          objectApiName: 'Account',
          carriers: [{ field: 'ParentId' }],
          stratifiedBy: 'RecordTypeId',
        },
      ]),
    ).rejects.toThrow(
      'Account.RecordTypeId has too many values among the roots of the draw to stratify them: ' +
        'the source counts them in one answer of fewer than 2000, and this one had more after it.',
    );
  });

  it('reads every root of an object stratified with its value, and hands a page on value by value', async () => {
    const org = describedOrg();
    typedAccounts(org);
    const reader = readerOf(org);
    const read: RootRead = {
      objectApiName: 'Account',
      carriers: [{ field: 'ParentId' }],
      stratifiedBy: 'RecordTypeId',
    };
    const given: Array<{ ids: string[]; stratum: unknown }> = [];

    await reader.countRoots([read]);
    await reader.drawUniform([read], (_object, ids, ...stratum) => {
      given.push({ ids, stratum });
    });

    expect(given).toEqual([
      { ids: [1, 2, 5].map((n) => fakeId('001', n)), stratum: [fakeId('012', 1)] },
      { ids: [fakeId('001', 3)], stratum: [fakeId('012', 2)] },
      { ids: [fakeId('001', 4)], stratum: [null] },
    ]);
    expect(org.sent.at(-1)?.soql).toBe(
      'SELECT Id, RecordTypeId FROM Account WHERE ParentId = null',
    );
  });

  it('reads the roots of each value of a stratum by date, as many as each takes, its value escaped, none and a value taking none left out', async () => {
    const org = describedOrg();
    const statuses = ['New', 'New', 'New', "Won't fix", 'Working', null, null];
    statuses.forEach((Status, index) => {
      org.add('Case', {
        Id: fakeId('500', index + 1),
        AccountId: null,
        Status,
        CreatedDate: madeAt(index),
      });
    });
    const reader = readerOf(org);
    const read: RootRead = {
      objectApiName: 'Case',
      carriers: [{ field: 'AccountId' }],
      stratifiedBy: 'Status',
    };
    const take = [
      { value: 'New', take: 2 },
      { value: "Won't fix", take: 1 },
      { value: 'Working', take: 0 },
      { value: null, take: 1 },
    ];
    const given: Array<{ ids: string[]; stratum: unknown }> = [];

    const [count] = await reader.countRoots([read]);
    const before = reader.requests;
    await reader.drawByDate([{ ...read, take }], 'recent', (_object, ids, stratum) => {
      given.push({ ids, stratum });
    });

    expect(given).toEqual([
      { ids: [fakeId('500', 3), fakeId('500', 2)], stratum: 'New' },
      { ids: [fakeId('500', 4)], stratum: "Won't fix" },
      { ids: [fakeId('500', 7)], stratum: null },
    ]);
    const select = 'SELECT Id, CreatedDate FROM Case WHERE AccountId = null';
    const order = 'ORDER BY CreatedDate DESC, Id DESC';
    expect(org.sent.slice(1).map((sent) => sent.soql)).toEqual([
      `${select} AND Status = 'New' ${order} LIMIT 2`,
      `${select} AND Status = 'Won\\'t fix' ${order} LIMIT 1`,
      `${select} AND Status = null ${order} LIMIT 1`,
    ]);
    expect(reader.requests - before).toBe(rootScanRequestsOf(count, 'recent', take));
  });

  it('writes a checkbox of a stratum bare', async () => {
    const org = describedOrg();
    for (let n = 1; n <= 3; n++) {
      org.add('Case', {
        Id: fakeId('500', n),
        AccountId: null,
        IsEscalated: n === 2,
        CreatedDate: madeAt(n),
      });
    }
    const reader = readerOf(org);
    const read: RootRead = {
      objectApiName: 'Case',
      carriers: [{ field: 'AccountId' }],
      stratifiedBy: 'IsEscalated',
    };
    const given: Array<{ ids: string[]; stratum: unknown }> = [];

    const [count] = await reader.countRoots([read]);
    await reader.drawByDate(
      [{ ...read, take: [{ value: true, take: 1 }] }],
      'oldest',
      (_object, ids, stratum) => {
        given.push({ ids, stratum });
      },
    );

    expect(count.strata).toEqual([
      { value: false, rows: 2 },
      { value: true, rows: 1 },
    ]);
    expect(given).toEqual([{ ids: [fakeId('500', 2)], stratum: true }]);
    expect(org.sent.at(-1)?.soql).toBe(
      'SELECT Id, CreatedDate FROM Case WHERE AccountId = null AND IsEscalated = true ORDER BY CreatedDate ASC, Id ASC LIMIT 1',
    );
  });

  it('tests the roots of no value of a stratum on the rows read once its nulls run past the org’s time', async () => {
    const org = describedOrg();
    const statuses = ['New', null, 'New', null];
    statuses.forEach((Status, index) => {
      org.add('Case', {
        Id: fakeId('500', index + 1),
        AccountId: null,
        Status,
        CreatedDate: madeAt(index),
      });
    });
    org.add('Case', {
      Id: fakeId('500', 9),
      AccountId: fakeId('001', 1),
      Status: null,
      CreatedDate: madeAt(9),
    });
    org.slow.add('Case');
    const reader = readerOf(org);
    const read: RootRead = {
      objectApiName: 'Case',
      carriers: [{ field: 'AccountId' }],
      stratifiedBy: 'Status',
    };
    const given: Array<{ ids: string[]; stratum: unknown }> = [];

    const [count] = await reader.countRoots([read]);
    await reader.drawByDate(
      [
        {
          ...read,
          take: [
            { value: 'New', take: 2 },
            { value: null, take: 2 },
          ],
        },
      ],
      'recent',
      (_object, ids, stratum) => {
        given.push({ ids, stratum });
      },
    );

    expect(count).toMatchObject({ rows: 5, exact: false, timedOut: true });
    expect(given).toEqual([
      { ids: [fakeId('500', 3), fakeId('500', 1)], stratum: 'New' },
      { ids: [fakeId('500', 4), fakeId('500', 2)], stratum: null },
    ]);
    expect(org.sent.map((sent) => sent.soql)).toEqual([
      'SELECT Status, COUNT(Id) n FROM Case WHERE AccountId = null GROUP BY Status',
      'SELECT Status, COUNT(Id) n FROM Case GROUP BY Status',
      "SELECT Id, AccountId, CreatedDate FROM Case WHERE Status = 'New' ORDER BY CreatedDate DESC, Id DESC LIMIT 2000",
      'SELECT Id, AccountId, Status, CreatedDate FROM Case ORDER BY CreatedDate DESC, Id DESC LIMIT 2000',
    ]);
  });

  it('prices the reads by date of an object stratified value by value, one at least of each value it takes', () => {
    const count = {
      objectApiName: 'Case',
      rows: 4_700,
      exact: true,
      strata: [
        { value: 'New', rows: 4_500 },
        { value: null, rows: 200 },
      ],
    };

    expect(
      rootScanRequestsOf(count, 'recent', [
        { value: 'New', take: 2_100 },
        { value: null, take: 1 },
        { value: 'Closed', take: 0 },
      ]),
    ).toBe(3);
    expect(rootScanRequestsOf(count, 'oldest', [{ value: null, take: 500 }])).toBe(1);
    expect(rootScanRequestsOf(count, 'uniform', [{ value: 'New', take: 1 }])).toBe(3);
  });
});

describe('the records a sample names', () => {
  it('reads records by their ids with the columns their describe lists alone', async () => {
    const org = describedOrg();
    accountsAndContacts(org, 3);
    const reader = readerOf(org);

    const [answer] = await reader.readParents([
      {
        objectApiName: 'Account',
        ids: [fakeId('001', 1), fakeId('001', 3)],
        // An org without person accounts or multiple currencies has neither field.
        columns: ['ParentId', 'IsPersonAccount', 'CurrencyIsoCode', 'OwnerId'],
      },
    ]);

    expect(answer.columns).toEqual(['Id', 'ParentId', 'OwnerId']);
    expect(answer.rows.map((row) => row['Id'])).toEqual([fakeId('001', 1), fakeId('001', 3)]);
    expect(org.sent.map((sent) => sent.soql)).toEqual([
      `SELECT Id, ParentId, OwnerId FROM Account WHERE Id IN ('${fakeId('001', 1)}', '${fakeId('001', 3)}')`,
    ]);
  });

  it('cuts a read by ids into statements the URI holds, and reads a select too wide for one in column groups', async () => {
    const org = describedOrg();
    const lookups = Array.from(
      { length: 120 },
      (_, n) => `Regional_Distribution_Partner_${String(n).padStart(3, '0')}__c`,
    );
    const wide = Array.from(
      { length: 220 },
      (_, n) => `Quarterly_Forecast_Adjustment_${String(n).padStart(3, '0')}__c`,
    );
    org.columns.set('Account', [...DESCRIBED['Account'], ...lookups, ...wide]);
    for (let n = 1; n <= 600; n++) {
      org.add('Account', {
        Id: fakeId('001', n),
        Name: `A${n}`,
        [lookups[0]]: fakeId('a0D', n),
        [wide[219]]: n,
      });
    }
    const reader = readerOf(org);
    const ids = Array.from({ length: 600 }, (_, n) => fakeId('001', n + 1));

    const [narrow] = await reader.readParents([
      { objectApiName: 'Account', ids, columns: lookups },
    ]);
    const narrowStatements = org.sent.length;
    const [broad] = await reader.readParents([
      { objectApiName: 'Account', ids: ids.slice(0, 50), columns: [...lookups, ...wide] },
    ]);

    expect(narrow.rows).toHaveLength(600);
    expect(narrow.absent).toEqual([]);
    expect(broad.rows).toHaveLength(50);
    expect(broad.rows[49]?.[wide[219]]).toBe(50);
    expect(broad.rows[49]?.[lookups[0]]).toBe(fakeId('a0D', 50));
    for (const { soql } of org.sent) {
      // As it goes on the wire, each quote as %27: within the budget of a
      // statement, and so within what the org holds, the query's path added.
      const wire = encodeURIComponent(soql).replace(/'/g, '%27').length;
      expect(wire).toBeLessThanOrEqual(MAX_STATEMENT_URI_CHARS);
      expect(29 + wire).toBeLessThanOrEqual(MOST_WIRE_CHARS);
    }
    // Fewer than 500 ids a statement beside a hundred and twenty lookups.
    expect(narrowStatements).toBe(3);
  });

  it('says an id the source does not hold absent, and one outside its object’s filter outside it', async () => {
    const org = describedOrg();
    accountsAndContacts(org, 3);
    const reader = readerOf(org, { Account: "Name != 'A2'" });

    const [answer] = await reader.readParents([
      {
        objectApiName: 'Account',
        ids: [fakeId('001', 1), fakeId('001', 2), fakeId('001', 9), fakeId('001', 1)],
        columns: [],
      },
    ]);

    expect(answer.rows.map((row) => row['Id'])).toEqual([fakeId('001', 1)]);
    expect(answer.outsideFilter).toEqual([{ Id: fakeId('001', 2) }]);
    expect(answer.absent).toEqual([fakeId('001', 9)]);
    expect(org.sent.map((sent) => sent.soql)).toEqual([
      `SELECT Id FROM Account WHERE (Name != 'A2') AND Id IN ('${fakeId('001', 1)}', '${fakeId('001', 2)}', '${fakeId('001', 9)}')`,
      `SELECT Id FROM Account WHERE Id IN ('${fakeId('001', 2)}', '${fakeId('001', 9)}')`,
    ]);
  });

  it('reads the standard prices of products in the source’s standard book, the book read once', async () => {
    const org = describedOrg();
    org.add('Pricebook2', { Id: fakeId('01s', 1), Name: 'Standard', IsStandard: true });
    org.add('Pricebook2', { Id: fakeId('01s', 2), Name: 'Partners', IsStandard: false });
    for (let n = 1; n <= 3; n++) {
      org.add('PricebookEntry', {
        Id: fakeId('01u', n),
        Pricebook2Id: fakeId('01s', 1),
        Product2Id: fakeId('01t', n),
        IsActive: true,
      });
      org.add('PricebookEntry', {
        Id: fakeId('01u', 10 + n),
        Pricebook2Id: fakeId('01s', 2),
        Product2Id: fakeId('01t', n),
        IsActive: true,
      });
    }
    const reader = readerOf(org);

    const first = await reader.readStandardPrices(
      [fakeId('01t', 1), fakeId('01t', 3)],
      ['Pricebook2Id', 'CurrencyIsoCode', 'IsActive'],
    );
    const second = await reader.readStandardPrices([fakeId('01t', 2)], ['IsActive']);

    expect(first.map((row) => row['Id'])).toEqual([fakeId('01u', 1), fakeId('01u', 3)]);
    expect(second.map((row) => row['Id'])).toEqual([fakeId('01u', 2)]);
    expect(org.sent.filter((sent) => sent.soql.includes('FROM Pricebook2 '))).toHaveLength(1);
  });
});

describe('the records under a sample', () => {
  /**
   * Accounts 1 to 3 with 2, 5 and 120 contacts, each made the later the
   * smaller its id: loads apart, a scratch org's ids interleaved hours apart,
   * and its greatest ids were not its newest.
   */
  function hubOrg(): SampleSourceOrg {
    const org = describedOrg();
    let contact = 0;
    for (const [n, children] of [
      [1, 2],
      [2, 5],
      [3, 120],
    ] as const) {
      org.add('Account', { Id: fakeId('001', n), Name: `A${n}` });
      for (let c = 0; c < children; c++) {
        contact++;
        org.add('Contact', {
          Id: fakeId('003', contact),
          AccountId: fakeId('001', n),
          CreatedDate: madeAt(200 - contact),
        });
      }
    }
    return org;
  }
  const parents = [fakeId('001', 1), fakeId('001', 2), fakeId('001', 3)];

  it('reads a list’s children at once when their object holds no more than the cap times the list, the newest of each kept by the date they were made', async () => {
    const org = hubOrg();
    const reader = readerOf(org);

    const [answer] = await reader.readChildren([
      {
        objectApiName: 'Contact',
        field: 'AccountId',
        parentIds: parents,
        columns: ['ReportsToId'],
        cap: 100,
        sourceRows: 127,
      },
    ]);

    expect(answer.rows).toHaveLength(2 + 5 + 100);
    // The newest hundred of the third account: its first contacts, 8 to 107, not its greatest ids.
    const third = answer.rows.filter((row) => row['AccountId'] === fakeId('001', 3));
    expect(third[0]?.['Id']).toBe(fakeId('003', 8));
    expect(third.at(-1)?.['Id']).toBe(fakeId('003', 107));
    expect(answer.cut).toEqual([{ parentId: fakeId('001', 3), rows: 20 }]);
    expect(answer.newestBy).toBe('created');
    expect(org.sent.map((sent) => sent.soql)).toEqual([
      `SELECT Id, AccountId, ReportsToId, CreatedDate FROM Contact WHERE AccountId IN (${parents.map((id) => `'${id}'`).join(', ')})`,
    ]);
  });

  it('counts the children by parent past that, reads those under the cap at once and each hub’s newest alone, by the date they were made', async () => {
    const org = hubOrg();
    const reader = readerOf(org);

    const [answer] = await reader.readChildren([
      {
        objectApiName: 'Contact',
        field: 'AccountId',
        parentIds: parents,
        columns: [],
        cap: 4,
        sourceRows: 127,
      },
    ]);

    expect(answer.rows.map((row) => row['Id'])).toEqual(
      [1, 2, 3, 4, 5, 6, 8, 9, 10, 11].map((n) => fakeId('003', n)),
    );
    expect(answer.cut).toEqual([
      { parentId: fakeId('001', 2), rows: 1 },
      { parentId: fakeId('001', 3), rows: 116 },
    ]);
    const list = (ids: string[]) => ids.map((id) => `'${id}'`).join(', ');
    const hub = (n: number) =>
      `SELECT Id, AccountId, CreatedDate FROM Contact WHERE AccountId = '${fakeId('001', n)}' ` +
      'ORDER BY CreatedDate DESC, Id DESC LIMIT 4';
    expect(org.sent.map((sent) => sent.soql)).toEqual([
      `SELECT AccountId, COUNT(Id) n FROM Contact WHERE AccountId IN (${list(parents)}) GROUP BY AccountId`,
      `SELECT Id, AccountId, CreatedDate FROM Contact WHERE AccountId IN (${list(parents.slice(0, 1))})`,
      hub(2),
      hub(3),
    ]);
  });

  it('keeps the greatest ids of an object with no creation date the org orders by, and says so', async () => {
    const org = hubOrg();
    const reader = readerOf(
      org,
      {},
      { sorts: (object, field) => !(object === 'Contact' && field === 'CreatedDate') },
    );

    const [answer] = await reader.readChildren([
      {
        objectApiName: 'Contact',
        field: 'AccountId',
        parentIds: parents,
        columns: [],
        cap: 4,
        sourceRows: 127,
      },
    ]);

    expect(answer.newestBy).toBe('id');
    expect(answer.rows.map((row) => row['Id'])).toEqual(
      [2, 1, 7, 6, 5, 4, 127, 126, 125, 124].map((n) => fakeId('003', n)),
    );
    expect(org.sent.at(-1)?.soql).toBe(
      `SELECT Id, AccountId FROM Contact WHERE AccountId = '${fakeId('001', 3)}' ORDER BY Id DESC LIMIT 4`,
    );
  });

  it('reads a list’s children at once when the org will not count them by parent, and keeps the same newest of each', async () => {
    const org = hubOrg();
    // Not an org's answer yet: what it would say of a lookup it does not group by.
    org.refusals.push({
      pattern: /GROUP BY/,
      errorCode: 'INVALID_FIELD',
      message: "field 'AccountId' can not be grouped in a query call",
    });
    const reader = readerOf(org);

    const [answer] = await reader.readChildren([
      {
        objectApiName: 'Contact',
        field: 'AccountId',
        parentIds: parents,
        columns: [],
        cap: 4,
        sourceRows: 127,
      },
    ]);

    expect(answer.rows.map((row) => row['Id'])).toEqual(
      [1, 2, 3, 4, 5, 6, 8, 9, 10, 11].map((n) => fakeId('003', n)),
    );
    expect(answer.cut).toEqual([
      { parentId: fakeId('001', 2), rows: 1 },
      { parentId: fakeId('001', 3), rows: 116 },
    ]);
    expect(org.sent).toHaveLength(2);
    expect(reader.requests).toBe(org.requests);
  });

  it('reads a hub whole and keeps its newest when the org will not order it, and fails on any other refusal', async () => {
    const org = hubOrg();
    org.refusals.push({
      pattern: /ORDER BY CreatedDate DESC, Id DESC LIMIT/,
      errorCode: 'MALFORMED_QUERY',
      message: 'unexpected token: ORDER',
    });
    const reader = readerOf(org);
    const read = {
      objectApiName: 'Contact',
      field: 'AccountId',
      parentIds: parents,
      columns: [],
      cap: 4,
      sourceRows: 127,
    };

    const [answer] = await reader.readChildren([read]);
    org.refusals.splice(0, 1, {
      pattern: /ORDER BY CreatedDate DESC, Id DESC LIMIT/,
      errorCode: 'REQUEST_LIMIT_EXCEEDED',
      message: 'TotalRequests Limit exceeded.',
    });

    expect(answer.rows.map((row) => row['Id']).slice(6)).toEqual(
      [8, 9, 10, 11].map((n) => fakeId('003', n)),
    );
    expect(answer.cut).toEqual([
      { parentId: fakeId('001', 2), rows: 1 },
      { parentId: fakeId('001', 3), rows: 116 },
    ]);
    await expect(reader.readChildren([read])).rejects.toMatchObject({
      errorCode: 'REQUEST_LIMIT_EXCEEDED',
    });
  });

  it('reads the feed items under some records at once, the org refusing to count a feed item’s ids, and asks it once', async () => {
    const org = describedOrg();
    for (let n = 1; n <= 30; n++) {
      org.add('FeedItem', {
        Id: fakeId('0D5', n),
        ParentId: fakeId('500', n <= 25 ? 1 : 2),
        IsDeleted: false,
      });
    }
    const reader = readerOf(org);
    const read = (parentId: string) => ({
      objectApiName: 'FeedItem',
      field: 'ParentId',
      parentIds: [parentId],
      columns: ['Type'],
      cap: 20,
      sourceRows: 30,
    });

    const [first] = await reader.readChildren([read(fakeId('500', 1))]);
    const [second] = await reader.readChildren([read(fakeId('500', 2))]);

    expect(first.rows).toHaveLength(20);
    expect(first.cut).toEqual([{ parentId: fakeId('500', 1), rows: 5 }]);
    // The describe lists no creation date of a feed item: its greatest ids kept, and said.
    expect(first.newestBy).toBe('id');
    expect(first.rows[0]?.['Id']).toBe(fakeId('0D5', 25));
    expect(first.counts).toEqual(new Map([[fakeId('500', 1), 25]]));
    expect(second.rows).toHaveLength(5);
    expect(org.sent.map((sent) => sent.soql.split(' FROM ')[0])).toEqual([
      'SELECT ParentId, COUNT(Id) n',
      'SELECT Id, ParentId, Type',
      'SELECT Id, ParentId, Type',
    ]);
  });

  it('asks no count by parent of an object whose describe says its ids are not counted so', async () => {
    const org = describedOrg();
    for (let n = 1; n <= 30; n++) {
      org.add('FeedItem', { Id: fakeId('0D5', n), ParentId: fakeId('500', 1), IsDeleted: false });
    }
    const reader = readerOf(org, {}, { countsBy: (object) => object !== 'FeedItem' });

    const [answer] = await reader.readChildren([
      {
        objectApiName: 'FeedItem',
        field: 'ParentId',
        parentIds: [fakeId('500', 1)],
        columns: [],
        cap: 20,
        sourceRows: 30,
      },
    ]);

    expect(answer.rows).toHaveLength(20);
    expect(answer.counts).toEqual(new Map([[fakeId('500', 1), 30]]));
    expect(org.sent.map((sent) => sent.soql)).toEqual([
      `SELECT Id, ParentId FROM FeedItem WHERE ParentId IN ('${fakeId('500', 1)}')`,
    ]);
  });

  it('gives the count of every parent asked, none for one that holds none, past the cap too', async () => {
    const org = hubOrg();
    const reader = readerOf(org);
    const asked = [...parents, fakeId('001', 9)];

    const [grouped] = await reader.readChildren([
      {
        objectApiName: 'Contact',
        field: 'AccountId',
        parentIds: asked,
        columns: [],
        cap: 4,
        sourceRows: 127,
      },
    ]);
    const [atOnce] = await reader.readChildren([
      {
        objectApiName: 'Contact',
        field: 'AccountId',
        parentIds: asked,
        columns: [],
        cap: 100,
        sourceRows: 127,
      },
    ]);
    const [every] = await reader.readChildren([
      {
        objectApiName: 'Contact',
        field: 'AccountId',
        parentIds: asked,
        columns: [],
        cap: 'all',
        sourceRows: 127,
      },
    ]);

    const counts = new Map([
      [fakeId('001', 1), 2],
      [fakeId('001', 2), 5],
      [fakeId('001', 3), 120],
      [fakeId('001', 9), 0],
    ]);
    expect(grouped.counts).toEqual(counts);
    expect(atOnce.counts).toEqual(counts);
    expect(every.counts).toEqual(counts);
  });

  it('refuses to read children through a lookup the describe does not list', async () => {
    const reader = readerOf(hubOrg());

    await expect(
      reader.readChildren([
        {
          objectApiName: 'Contact',
          field: 'Account__c',
          parentIds: parents,
          columns: [],
          cap: 4,
          sourceRows: 127,
        },
      ]),
    ).rejects.toThrow("Contact.Account__c is no field of the source's describe.");
  });

  it('reads every child of a master-detail relation, whatever their number', async () => {
    const org = hubOrg();
    const reader = readerOf(org);

    const [answer] = await reader.readChildren([
      {
        objectApiName: 'Contact',
        field: 'AccountId',
        parentIds: parents,
        columns: [],
        cap: 'all',
        sourceRows: 127,
      },
    ]);

    expect(answer.rows).toHaveLength(127);
    expect(answer.cut).toEqual([]);
    expect(org.sent).toHaveLength(1);
  });

  it('reads the tasks under records of several objects in one list of mixed ids, through queryAll', async () => {
    const org = describedOrg();
    org.add('Task', { Id: fakeId('00T', 1), WhatId: fakeId('001', 1), IsDeleted: false });
    org.add('Task', { Id: fakeId('00T', 2), WhatId: fakeId('006', 1), IsDeleted: false });
    org.add('Task', {
      Id: fakeId('00T', 3),
      WhatId: fakeId('006', 1),
      IsDeleted: false,
      IsArchived: true,
    });
    org.add('Task', { Id: fakeId('00T', 4), WhatId: fakeId('500', 1), IsDeleted: true });
    const reader = readerOf(org);

    const [answer] = await reader.readChildren([
      {
        objectApiName: 'Task',
        field: 'WhatId',
        parentIds: [fakeId('001', 1), fakeId('006', 1), fakeId('500', 1)],
        columns: ['WhoId'],
        cap: 100,
        sourceRows: 4,
      },
    ]);

    expect(answer.rows.map((row) => row['Id']).sort()).toEqual([
      fakeId('00T', 1),
      fakeId('00T', 2),
      fakeId('00T', 3),
    ]);
    expect(org.sent).toEqual([
      {
        soql: `SELECT Id, WhatId, WhoId, CreatedDate FROM Task WHERE IsDeleted = false AND WhatId IN ('${fakeId('001', 1)}', '${fakeId('006', 1)}', '${fakeId('500', 1)}')`,
        all: true,
      },
    ]);
  });
});

describe('the records a sample copies whole', () => {
  it('reads every record of the object, a page at a time, under its filter', async () => {
    const org = describedOrg();
    org.pageSize = 2;
    for (let n = 1; n <= 5; n++) {
      org.add('Product2', { Id: fakeId('01t', n), Name: `P${n}`, IsActive: n !== 3 });
    }
    const reader = readerOf(org, { Product2: 'IsActive = true' });
    const pages: string[][] = [];

    await reader.readWhole([{ objectApiName: 'Product2', columns: ['Name'] }], (_object, rows) => {
      pages.push(rows.map((row) => String(row['Id'])));
    });

    expect(pages).toEqual([
      [fakeId('01t', 1), fakeId('01t', 2)],
      [fakeId('01t', 4), fakeId('01t', 5)],
    ]);
  });
});

describe('the requests a sample sends', () => {
  it('counts every request it sends, each next page and each refused one, as the org answers them', async () => {
    const org = describedOrg();
    org.pageSize = 2;
    accountsAndContacts(org, 9, 3);
    const reader = readerOf(org);
    const accounts: RootRead = { objectApiName: 'Account', carriers: [{ field: 'ParentId' }] };
    const contacts: RootRead = {
      objectApiName: 'Contact',
      carriers: [{ field: 'AccountId' }, { field: 'ReportsToId' }],
    };

    const counts = await reader.countRoots([accounts, contacts]);
    org.slow.add('Account');
    await reader.drawUniform([accounts, contacts], () => {});
    await reader.readParents([
      { objectApiName: 'Account', ids: [fakeId('001', 1), fakeId('001', 4)], columns: [] },
    ]);
    await reader.readChildren([
      {
        objectApiName: 'Contact',
        field: 'AccountId',
        parentIds: [fakeId('001', 1), fakeId('001', 2), fakeId('001', 3)],
        columns: [],
        cap: 2,
        sourceRows: 27,
      },
    ]);

    expect(counts.map((count) => count.rows)).toEqual([9, 0]);
    // A first scan of the accounts refused, then read again without its null.
    expect(org.sent.map((sent) => sent.soql)).toContain(
      'SELECT Id FROM Account WHERE ParentId = null',
    );
    expect(org.sent.map((sent) => sent.soql)).toContain('SELECT Id, ParentId FROM Account');
    expect(reader.requests).toBe(org.requests);
    expect(reader.requests).toBeGreaterThan(org.sent.length);
  });

  it('prices the read of every root id as it sends it', async () => {
    const org = describedOrg();
    accountsAndContacts(org, 4_100);
    const reader = readerOf(org);
    const read: RootRead = { objectApiName: 'Account', carriers: [{ field: 'ParentId' }] };

    const [count] = await reader.countRoots([read]);
    const before = reader.requests;
    await reader.drawUniform([read], () => {});

    expect(rootScanRequestsOf(count, 'uniform')).toBe(3);
    expect(reader.requests - before).toBe(3);
    expect(org.requests).toBe(reader.requests);
  });

  it('reads six objects at a time, never more', async () => {
    const org = describedOrg();
    const reads: RootRead[] = [];
    for (let n = 1; n <= 10; n++) {
      const object = `Region_${n}__c`;
      org.columns.set(object, ['Id', 'Parent__c', 'IsDeleted']);
      org.add(object, { Id: fakeId('a0R', n), Parent__c: null });
      reads.push({ objectApiName: object, carriers: [{ field: 'Parent__c' }] });
    }
    const reader = readerOf(org);

    await reader.countRoots(reads);
    await reader.drawUniform(reads, () => {});

    expect(org.mostInFlight).toBe(6);
  });
});

describe('how a run reads the records of its plan', () => {
  const narrow = ['Id', 'Name', 'ParentId', 'OwnerId', 'SystemModstamp'];

  it('reads by the plan’s ids when they cost fewer requests than the cursor, and by the cursor when they cost more', () => {
    const few = runReadOf({
      objectApiName: 'Account',
      columns: narrow,
      sourceRows: 500_000,
      planRows: 1_200,
    });
    const most = runReadOf({
      objectApiName: 'Account',
      columns: narrow,
      sourceRows: 3_000,
      planRows: 2_900,
    });

    expect(few).toEqual({ by: 'ids', requests: 3, byIds: 3, byCursor: 250 });
    expect(most).toEqual({ by: 'cursor', requests: 2, byIds: 6, byCursor: 2 });
  });

  it('prices a wide object’s other column groups on both reads', () => {
    const wide = [
      ...narrow,
      ...Array.from(
        { length: 220 },
        (_, n) => `Quarterly_Forecast_Adjustment_${String(n).padStart(3, '0')}__c`,
      ),
    ];

    const read = runReadOf({
      objectApiName: 'Account',
      columns: wide,
      sourceRows: 4_000,
      planRows: 900,
    });

    expect(read.byIds).toBeGreaterThan(Math.ceil(900 / 500) * 2 - 1);
    expect(read.byCursor).toBeGreaterThan(Math.ceil(4_000 / ROWS_PER_PAGE));
  });

  it('reads tasks and events by the cursor whatever the ids cost: an archived one read by its id is not known to come back', () => {
    const read = runReadOf({
      objectApiName: 'Task',
      columns: ['Id', 'Subject', 'WhatId'],
      sourceRows: 5_000_000,
      planRows: 300,
    });

    expect(read).toMatchObject({ by: 'cursor', byIds: 1, byCursor: 2_500, cursorAlone: true });
  });
});
