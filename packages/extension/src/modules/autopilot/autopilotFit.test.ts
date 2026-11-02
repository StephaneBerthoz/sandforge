import * as fc from 'fast-check';
import { describe, it, expect, vi } from 'vitest';
import {
  BYTES_PER_MB,
  mutePlanOf,
  type ForgeTargetAutomation,
  type ForgeTargetFlow,
} from '@sandforge/shared';
import { describeOf, type LargeOrgRow } from '../../test/largeOrg';
import { fitOrg } from '../../test/fitOrg';
import { evenlyKept, type FitBudget } from '../forge/fitBudget.js';
import { countedStorageBytes } from '../forge/ForgeRunGate.js';
import type { FitRow, FitWalk, ObjectDescribeResult, SchemaScanResult } from './SchemaScanner.js';
import {
  FIT_WALKS,
  SOURCE_CHANGED,
  chooseFitRecords,
  fitLookupsOf,
  fitRoomOf,
  fitWritesOf,
  fittedScanOf,
  type FitRecordsChosen,
  type FitRecordsInput,
} from './autopilotFit.js';

const KB = 1024;

/** A budget of exactly `bytes`, with `runRequests` when given. */
function budgetOf(bytes: number, runRequests?: number): FitBudget {
  return {
    bytes,
    terms: { remainingMB: 500, maxMB: 500, share: 0.8, roundingMB: 0.5, limitedBy: 'storage' },
    ...(runRequests !== undefined ? { runRequests } : {}),
  };
}

/** The ids of `n` records of an object, from a key prefix. */
function idsOf(prefix: string, n: number): string[] {
  return Array.from({ length: n }, (_, i) => `${prefix}${String(i + 1).padStart(12, '0')}AAA`);
}

/** Every object of the fixture's describes, as a scan holds them. */
function describesOf(names: string[]): Map<string, ObjectDescribeResult> {
  const org = fitOrg({});
  return new Map(names.map((name) => [name, describeOf(org, name) as ObjectDescribeResult]));
}

/** A walk that reads what the kept rows name of the object read by id, and nothing deeper. */
const NO_WALK: FitRecordsInput['walk'] = async () => {
  throw new Error('A plan with no parent reads none.');
};

/**
 * Choose records from `rows`, of the objects written in `order`: each object
 * of `rows` is selected, the rest of `order` read by id.
 */
function choose(
  order: string[],
  rows: Record<string, LargeOrgRow[]>,
  over: Partial<FitRecordsInput> = {},
): Promise<FitRecordsChosen> {
  const selected = order.filter((name) => rows[name] !== undefined);
  return chooseFitRecords({
    order: selected,
    rows: new Map(Object.entries(rows).map(([name, kept]) => [name, kept as FitRow[]])),
    planned: new Map(Object.entries(rows).map(([name, kept]) => [name, kept.length])),
    lookups: fitLookupsOf(describesOf(order), selected, order),
    parents: new Map(),
    budget: budgetOf(BYTES_PER_MB),
    room: { perRecord: [], notCounted: [] },
    mode: { share: true },
    walk: NO_WALK,
    ...over,
  });
}

/** The ids `object` keeps. */
function keptOf(chosen: FitRecordsChosen, object: string): string[] {
  return (chosen.kept.get(object) ?? []).map((row) => row.Id);
}

/** What a fit reports of `object`. */
function reportOf(chosen: FitRecordsChosen, object: string) {
  const found = chosen.report.objects.find((o) => o.objectApiName === object);
  if (!found) throw new Error(`No ${object} in the report.`);
  return found;
}

const accounts = (n: number, extra: (i: number) => LargeOrgRow = () => ({ Id: '' })) =>
  idsOf('001', n).map((Id, i) => ({ ...extra(i), Id }));

describe('the records a fit keeps', () => {
  it('thins an object nothing holds to its share, spread over the whole order of the ids', async () => {
    // The first ten of a hundred would be the oldest accounts of the org.
    const rows = accounts(100);

    const chosen = await choose(['Account'], { Account: rows }, { budget: budgetOf(10 * 2 * KB) });

    expect(keptOf(chosen, 'Account')).toEqual(evenlyKept(100, 10).map((i) => rows[i].Id));
    expect(reportOf(chosen, 'Account')).toMatchObject({
      inSource: 100,
      kept: 10,
      cutSpread: 90,
      cutWithParent: [],
    });
    expect(chosen.report.share).toBe(0.1);
    expect(chosen.heldBy).toBe('storage');
  });

  it('cuts a contact of a cut account with it, and counts it by the lookup', async () => {
    const Account = accounts(4);
    const Contact = idsOf('003', 8).map((Id, i) => ({ Id, AccountId: Account[i % 4].Id }));

    const chosen = await choose(
      ['Account', 'Contact'],
      { Account, Contact },
      { budget: budgetOf(6 * 2 * KB) },
    );

    const kept = new Set(keptOf(chosen, 'Account'));
    expect(kept.size).toBe(2);
    expect(reportOf(chosen, 'Contact')).toMatchObject({
      kept: 4,
      cutSpread: 0,
      cutWithParent: [{ field: 'AccountId', parent: 'Account', count: 4 }],
    });
    for (const id of keptOf(chosen, 'Contact')) {
      expect(kept.has(String(Contact.find((c) => c.Id === id)?.AccountId))).toBe(true);
    }
  });

  it('keeps every contact of a kept account: a share of the accounts, not of the contacts', async () => {
    // Each object thinned on its own would keep a quarter of a quarter.
    const Account = accounts(4);
    const Contact = idsOf('003', 40).map((Id, i) => ({ Id, AccountId: Account[i % 4].Id }));

    const chosen = await choose(
      ['Account', 'Contact'],
      { Account, Contact },
      { budget: budgetOf(11 * 2 * KB) },
    );

    expect(keptOf(chosen, 'Account')).toHaveLength(1);
    expect(keptOf(chosen, 'Contact')).toHaveLength(10);
  });

  it('takes a contact with no account as a root of its own, thinned at the same share', async () => {
    const Account = accounts(10);
    const Contact = idsOf('003', 10).map((Id) => ({ Id, AccountId: null }));

    const chosen = await choose(
      ['Account', 'Contact'],
      { Account, Contact },
      { budget: budgetOf(10 * 2 * KB) },
    );

    expect(keptOf(chosen, 'Account')).toHaveLength(5);
    expect(keptOf(chosen, 'Contact')).toEqual(evenlyKept(10, 5).map((i) => Contact[i].Id));
    expect(reportOf(chosen, 'Contact')).toMatchObject({ cutSpread: 5, cutWithParent: [] });
  });

  it('in a cycle, holds the contact to its account and leaves the account key contact empty', async () => {
    // Account goes first in their cycle: the contact's lookup is written with
    // it, the account's is filled once the contact is in, or stays empty.
    const contacts = idsOf('003', 4);
    const Account = accounts(4, (i) => ({ Id: '', Primary_Contact__c: contacts[(i + 1) % 4] }));
    const Contact = contacts.map((Id, i) => ({ Id, AccountId: Account[i].Id }));

    const chosen = await choose(
      ['Account', 'Contact'],
      { Account, Contact },
      { budget: budgetOf(4 * 2 * KB) },
    );

    expect(keptOf(chosen, 'Account')).toHaveLength(2);
    expect(reportOf(chosen, 'Contact').cutWithParent).toEqual([
      { field: 'AccountId', parent: 'Account', count: 2 },
    ]);
    // Each kept account names the contact of the next, one of which is cut.
    expect(chosen.report.emptied).toEqual([
      { objectApiName: 'Account', field: 'Primary_Contact__c', count: 2, why: 'owed' },
    ]);
  });

  it('leaves a self-reference empty and names it, where cutting along it would run through a hierarchy', async () => {
    const ids = idsOf('001', 8);
    const Account = ids.map((Id, i) => ({ Id, ParentId: i === 0 ? null : ids[i - 1] }));

    const chosen = await choose(['Account'], { Account }, { budget: budgetOf(2 * 2 * KB) });

    expect(keptOf(chosen, 'Account')).toHaveLength(2);
    expect(reportOf(chosen, 'Account').cutWithParent).toEqual([]);
    expect(chosen.report.emptied).toEqual([
      { objectApiName: 'Account', field: 'ParentId', count: 2, why: 'selfReference' },
    ]);
  });

  it('holds a polymorphic lookup by the prefix of its id: only the record of a fitted object cuts', async () => {
    const Account = accounts(2);
    const cases = idsOf('500', 2);
    const Task = [
      { Id: '00T000000000001AAA', WhatId: Account[0].Id },
      { Id: '00T000000000002AAA', WhatId: Account[1].Id },
      // An opportunity the plan does not hold: no parent of the fit's.
      { Id: '00T000000000003AAA', WhatId: '006000000000001AAA' },
      { Id: '00T000000000004AAA', WhatId: '006000000000002AAA' },
      { Id: '00T000000000005AAA', WhatId: cases[0] },
    ];

    const chosen = await choose(
      ['Account', 'Case', 'Task'],
      { Account, Case: cases.map((Id) => ({ Id })), Task },
      { budget: budgetOf(5 * 2 * KB) },
    );

    expect(keptOf(chosen, 'Account')).toEqual([Account[1].Id]);
    expect(keptOf(chosen, 'Task')).toContain('00T000000000002AAA');
    expect(reportOf(chosen, 'Task').cutWithParent).toEqual(
      expect.arrayContaining([{ field: 'WhatId', parent: 'Account', count: 1 }]),
    );
    // The two on an opportunity are roots, thinned, and no lookup cut them.
    expect(reportOf(chosen, 'Task').cutSpread).toBe(1);
  });

  it('holds a record to a required lookup even at an object written after it', async () => {
    // A required lookup at what goes later can only come from a cycle of
    // required lookups: the row cannot go without its record, whatever order.
    const lookups = fitLookupsOf(
      describesOf(['Licence__c', 'Account']),
      ['Licence__c', 'Account'],
      ['Licence__c', 'Account'],
    );
    const Account = accounts(4);
    const Licence__c = idsOf('a03', 4).map((Id, i) => ({ Id, Account__c: Account[i].Id }));

    const chosen = await choose(
      ['Licence__c', 'Account'],
      { Licence__c, Account },
      { lookups, budget: budgetOf(4 * 2 * KB), mode: { caps: { Account: 2 } } },
    );

    expect(lookups.links).toContainEqual(
      expect.objectContaining({ field: 'Account__c', parent: 'Account', kind: 'holds' }),
    );
    const accountsKept = new Set(keptOf(chosen, 'Account'));
    expect(accountsKept.size).toBe(2);
    expect(keptOf(chosen, 'Licence__c')).toHaveLength(2);
    for (const id of keptOf(chosen, 'Licence__c')) {
      expect(accountsKept.has(String(Licence__c.find((row) => row.Id === id)?.Account__c))).toBe(
        true,
      );
    }
    expect(reportOf(chosen, 'Licence__c').cutWithParent).toEqual([
      { field: 'Account__c', parent: 'Account', count: 2 },
    ]);
  });

  it('sizes a person account at 4 KB and its contact at nothing', async () => {
    // Apart: together, 4 KB and nothing add up to what two records of 2 KB do,
    // and a count that forgot them both would come to the same.
    const Account = accounts(4, (i) => ({ Id: '', IsPersonAccount: i < 2 }));
    const Contact = idsOf('003', 4).map((Id, i) => ({ Id, IsPersonAccount: i < 2 }));

    const ofAccounts = await choose(['Account'], { Account });
    const ofContacts = await choose(['Contact'], { Contact });

    expect(ofAccounts.report.estimateMB * BYTES_PER_MB).toBe(2 * 4 * KB + 2 * 2 * KB);
    expect(ofContacts.report.estimateMB * BYTES_PER_MB).toBe(2 * 2 * KB);
  });

  it('holds a share to what its person accounts weigh, not to a count of records', async () => {
    // Positions 1, 2 and 3 of four are 8 KB with a person account among them,
    // past the 6 KB three records of 2 KB would take.
    const Account = accounts(4, (i) => ({ Id: '', IsPersonAccount: i < 2 }));

    const chosen = await choose(['Account'], { Account }, { budget: budgetOf(6 * KB) });

    expect(keptOf(chosen, 'Account')).toEqual([Account[1].Id, Account[3].Id]);
    expect(chosen.report.estimateMB * BYTES_PER_MB).toBe(6 * KB);
  });

  it('never cuts the standard price book: a custom price stands on it', async () => {
    const lookups = { links: [], outward: [], requiredOfParents: [] };
    const books = idsOf('01s', 5).map((Id, i) => ({ Id, IsStandard: i === 0 }));

    const chosen = await chooseFitRecords({
      order: ['Pricebook2'],
      rows: new Map([['Pricebook2', books as FitRow[]]]),
      planned: new Map([['Pricebook2', 5]]),
      lookups,
      parents: new Map(),
      budget: budgetOf(2 * 2 * KB),
      room: { perRecord: [], notCounted: [] },
      mode: { share: true },
      walk: NO_WALK,
    });

    expect(keptOf(chosen, 'Pricebook2')).toContain(books[0].Id);
    expect(keptOf(chosen, 'Pricebook2')).toHaveLength(2);
  });
});

describe('caps', () => {
  it('thins what the kept accounts hold at the same step, followers included', async () => {
    const Account = accounts(2);
    const Contact = idsOf('003', 20).map((Id, i) => ({ Id, AccountId: Account[i % 2].Id }));

    const chosen = await choose(
      ['Account', 'Contact'],
      { Account, Contact },
      { mode: { caps: { Contact: 5 } } },
    );

    expect(keptOf(chosen, 'Account')).toHaveLength(2);
    expect(keptOf(chosen, 'Contact')).toEqual(evenlyKept(20, 5).map((i) => Contact[i].Id));
    expect(reportOf(chosen, 'Contact')).toMatchObject({ kept: 5, cutSpread: 15 });
    expect(chosen.heldBy).toBe('caps');
    expect(chosen.report).not.toHaveProperty('share');
  });

  it('caps every object with one number, an object named keeping its own', async () => {
    const Account = accounts(10);
    const Contact = idsOf('003', 10).map((Id) => ({ Id }));

    const chosen = await choose(
      ['Account', 'Contact'],
      { Account, Contact },
      { mode: { all: 3, caps: { Contact: 7 } } },
    );

    expect(keptOf(chosen, 'Account')).toHaveLength(3);
    expect(keptOf(chosen, 'Contact')).toHaveLength(7);
  });

  it('refuses caps that leave the plan past what fits, and says what they take', async () => {
    const chosen = await choose(
      ['Account'],
      { Account: accounts(100) },
      { mode: { caps: { Account: 50 } }, budget: budgetOf(20 * 2 * KB) },
    );

    expect(chosen.cannotFit).toMatch(
      /^with these caps the plan takes 0\.1 MB, past the 0\.04 MB that fit: lower them, or fit by share$/,
    );
  });

  it('takes the share of what the caps leave, the caps first', async () => {
    const chosen = await choose(
      ['Account'],
      { Account: accounts(100) },
      { mode: { share: true, caps: { Account: 50 } }, budget: budgetOf(20 * 2 * KB) },
    );

    expect(keptOf(chosen, 'Account')).toHaveLength(20);
    expect(chosen.report.share).toBe(0.4);
  });

  it('refuses a cap on an object the plan does not select', async () => {
    const chosen = await choose(
      ['Account'],
      { Account: accounts(1) },
      { mode: { caps: { Contact: 1 } } },
    );

    expect(chosen.cannotFit).toBe('the plan selects no Contact: a cap holds an object it selects');
  });
});

describe('what bounds the share', () => {
  it('fits a plan that fits as it is: nothing cut, no parent walked', async () => {
    const walk = vi.fn(NO_WALK);

    const chosen = await choose(
      ['Account', 'Territory__c'],
      { Account: accounts(3) },
      { walk, parents: new Map([['Territory__c', { ids: ['a01000000000001AAA'] }]]) },
    );

    expect(chosen.heldBy).toBe('whole');
    expect(chosen.report.share).toBe(1);
    expect(walk).not.toHaveBeenCalled();
  });

  it('leaves room for what still runs of the automation, under each record', async () => {
    const room = {
      perRecord: [
        {
          objectApiName: 'Account',
          act: 'insert' as const,
          bytes: 2 * KB,
          creates: [{ objectApiName: 'Task', by: 'Welcome' }],
        },
      ],
      notCounted: [],
    };

    const chosen = await choose(
      ['Account'],
      { Account: accounts(100) },
      { room, budget: budgetOf(20 * 2 * KB) },
    );

    expect(keptOf(chosen, 'Account')).toHaveLength(10);
    expect(chosen.report.budget.automationMB * BYTES_PER_MB).toBe(10 * 2 * KB);
    expect(chosen.report.budget.budgetMB * BYTES_PER_MB).toBe(10 * 2 * KB);
  });

  it('counts what fires on an update only for the records the run writes a second time', async () => {
    const ids = idsOf('001', 10);
    // Two accounts name a parent: those alone are written again.
    const Account = ids.map((Id, i) => ({ Id, ParentId: i < 2 ? ids[9] : null }));
    const room = {
      perRecord: [
        {
          objectApiName: 'Account',
          act: 'update' as const,
          bytes: 10 * KB,
          creates: [{ objectApiName: 'Task', by: 'On update' }],
        },
      ],
      notCounted: [],
    };

    const chosen = await choose(['Account'], { Account }, { room, budget: budgetOf(BYTES_PER_MB) });

    expect(chosen.report.budget.automationMB * BYTES_PER_MB).toBe(2 * 10 * KB);
  });

  it('stops at the requests that leave a tenth of the day, and says they held it', async () => {
    // A write call takes 200 records: 3 calls are 600.
    const chosen = await choose(
      ['Account'],
      { Account: accounts(5_000) },
      { budget: budgetOf(100 * BYTES_PER_MB, 3) },
    );

    expect(keptOf(chosen, 'Account')).toHaveLength(600);
    expect(chosen.heldBy).toBe('apiRequests');
    expect(chosen.report.budget.limitedBy).toBe('apiRequests');
  });

  it('stops at the records the run may write', async () => {
    const chosen = await choose(
      ['Account'],
      { Account: accounts(100) },
      { maxRecords: 30, budget: budgetOf(BYTES_PER_MB) },
    );

    expect(keptOf(chosen, 'Account')).toHaveLength(30);
    expect(chosen.heldBy).toBe('maxTotal');
  });

  it('says what the least it can be cut to takes when even that is too much', async () => {
    const Account = accounts(2);
    const Contact = idsOf('003', 100).map((Id) => ({ Id, AccountId: Account[1].Id }));

    const chosen = await choose(
      ['Account', 'Contact'],
      { Account, Contact },
      { budget: budgetOf(10 * KB) },
    );

    expect(chosen.cannotFit).toContain('the least it can be cut to');
    expect(chosen.cannotFit).toContain('101 records');
  });
});

describe('parents read by id', () => {
  const territories = idsOf('a01', 4);
  const regions = idsOf('a02', 4);
  const Account = accounts(4, (i) => ({ Id: '', Territory__c: territories[i] }));

  /** The walk of a plan in which a territory reaches its one region. */
  function walkOver(found: { territories: number; regions: number }): FitWalk {
    return {
      added: ['Territory__c', 'Region__c'],
      parentIds: new Map([
        ['Territory__c', territories.slice(0, found.territories)],
        ['Region__c', regions.slice(0, found.regions)],
      ]),
      personAccounts: new Map(),
      leftEmpty: [],
      namingSelected: [],
    };
  }
  const parents = new Map([
    ['Territory__c', { ids: territories }],
    ['Region__c', { ids: regions }],
  ]);
  const order = ['Region__c', 'Territory__c', 'Account'];

  it('counts the first level from the rows kept, and what lies deeper at the rate it fell', async () => {
    // Twelve records of the plan at full: half is 3 + 3 parents' worth.
    const walk = vi.fn(async () => walkOver({ territories: 2, regions: 2 }));

    const chosen = await choose(
      order,
      { Account },
      { parents, walk, budget: budgetOf(6 * 2 * KB) },
    );

    expect(keptOf(chosen, 'Account')).toHaveLength(2);
    expect(walk).toHaveBeenCalledOnce();
    expect(chosen.report.parents).toEqual([
      { objectApiName: 'Territory__c', records: 2 },
      { objectApiName: 'Region__c', records: 2 },
    ]);
    expect(chosen.report.records).toBe(6);
  });

  it('walks again from a lower share when the parents weigh more than estimated', async () => {
    // The first walk finds every region under two territories: over by a third.
    const walk = vi
      .fn<FitRecordsInput['walk']>()
      .mockResolvedValueOnce(walkOver({ territories: 2, regions: 4 }))
      .mockResolvedValueOnce(walkOver({ territories: 1, regions: 2 }));

    const chosen = await choose(
      order,
      { Account },
      { parents, walk, budget: budgetOf(6 * 2 * KB) },
    );

    expect(walk).toHaveBeenCalledTimes(2);
    expect(keptOf(chosen, 'Account')).toHaveLength(1);
    expect(chosen.cannotFit).toBeUndefined();
  });

  it(`gives up after ${FIT_WALKS} walks, and points at the caps`, async () => {
    // Each territory estimated with one region: the walk finds two hundred
    // under any of them, whatever the share comes down to.
    const everyTerritory = idsOf('a01', 400);
    const everyRegion = idsOf('a02', 400);
    const Account = idsOf('001', 400).map((Id, i) => ({ Id, Territory__c: everyTerritory[i] }));
    const walk = vi.fn<FitRecordsInput['walk']>(async (kept) => ({
      added: ['Territory__c', 'Region__c'],
      parentIds: new Map([
        ['Territory__c', (kept.get('Account') ?? []).map((row) => String(row['Territory__c']))],
        ['Region__c', everyRegion.slice(0, 200)],
      ]),
      personAccounts: new Map(),
      leftEmpty: [],
      namingSelected: [],
    }));

    const chosen = await choose(
      order,
      { Account },
      {
        walk,
        parents: new Map([
          ['Territory__c', { ids: everyTerritory }],
          ['Region__c', { ids: everyRegion }],
        ]),
        budget: budgetOf(150 * 2 * KB),
      },
    );

    expect(walk).toHaveBeenCalledTimes(FIT_WALKS);
    expect(chosen.cannotFit).toBe(`could not fit in ${FIT_WALKS} rounds: fit by caps`);
  });

  it('brings back a selected record a parent cannot be written without, and what holds it', async () => {
    // A licence read by id is a master-detail of an account: cut, the licence
    // would be refused, and the contact naming it with it.
    const Account = accounts(4);
    const licence = 'a03000000000001AAA';
    const Contact: LargeOrgRow[] = [
      { Id: '003000000000001AAA', AccountId: Account[3].Id, Licence__c: licence },
      { Id: '003000000000002AAA', AccountId: Account[0].Id },
    ];
    const walk = vi.fn(async () => ({
      added: ['Licence__c'],
      parentIds: new Map([['Licence__c', [licence]]]),
      personAccounts: new Map(),
      leftEmpty: [],
      namingSelected: [
        {
          objectApiName: 'Licence__c',
          field: 'Account__c',
          required: true,
          target: 'Account',
          id: Account[0].Id,
        },
      ],
    }));

    const chosen = await choose(
      ['Account', 'Licence__c', 'Contact'],
      { Account, Contact },
      {
        walk,
        parents: new Map([['Licence__c', { ids: [licence] }]]),
        budget: budgetOf(6 * 2 * KB),
      },
    );

    expect(walk).toHaveBeenCalledTimes(2);
    expect(keptOf(chosen, 'Account')).toContain(Account[0].Id);
    // The account brought back comes with the contact that follows it.
    expect(keptOf(chosen, 'Contact')).toContain(Contact[1].Id);
  });

  it('names a lookup of a record read by id left empty when its record was cut', async () => {
    const Account = accounts(2);
    const territory = 'a01000000000001AAA';
    const walk = vi.fn(async () => ({
      added: ['Territory__c'],
      parentIds: new Map([['Territory__c', [territory]]]),
      personAccounts: new Map(),
      leftEmpty: [],
      namingSelected: [
        {
          objectApiName: 'Territory__c',
          field: 'Manager__c',
          required: false,
          target: 'Account',
          id: Account[0].Id,
        },
      ],
    }));

    const chosen = await choose(
      ['Account', 'Territory__c'],
      { Account: Account.map((row) => ({ ...row, Territory__c: territory })) },
      {
        walk,
        parents: new Map([['Territory__c', { ids: [territory] }]]),
        budget: budgetOf(2 * 2 * KB),
      },
    );

    expect(keptOf(chosen, 'Account')).toEqual([Account[1].Id]);
    expect(chosen.report.emptied).toEqual([
      { objectApiName: 'Territory__c', field: 'Manager__c', count: 1, why: 'onParent' },
    ]);
  });
});

describe('a fitted plan is what the plan held, or less', () => {
  it('refuses a source that grew since the plan', async () => {
    const chosen = await choose(
      ['Account'],
      { Account: accounts(5) },
      { planned: new Map([['Account', 4]]) },
    );

    expect(chosen.cannotFit).toBe(SOURCE_CHANGED);
  });

  it('refuses a walk that reached a parent the plan did not hold', async () => {
    const territory = 'a01000000000001AAA';
    const walk = vi.fn(async () => ({
      added: ['Territory__c'],
      parentIds: new Map([['Territory__c', ['a01000000000999AAA']]]),
      personAccounts: new Map(),
      leftEmpty: [],
      namingSelected: [],
    }));

    const chosen = await choose(
      ['Account', 'Territory__c'],
      { Account: accounts(4, () => ({ Id: '', Territory__c: territory })) },
      {
        walk,
        parents: new Map([['Territory__c', { ids: [territory] }]]),
        budget: budgetOf(3 * 2 * KB),
      },
    );

    expect(chosen.cannotFit).toBe(SOURCE_CHANGED);
  });

  it('reads the selected objects by the ids kept, and says each object of the plan as kept', async () => {
    const chosen = await choose(
      ['Account'],
      { Account: accounts(10) },
      {
        budget: budgetOf(2 * 2 * KB),
      },
    );
    const scan: SchemaScanResult = {
      objectDescribes: describesOf(['Account', 'Region__c']),
      autoDiscoveredObjects: ['Region__c'],
      missingInTarget: [],
      recordCounts: new Map([
        ['Account', 10],
        ['Region__c', 1],
      ]),
      totalObjectsScanned: 2,
      parentIds: new Map([['Region__c', ['a02000000000001AAA']]]),
      personAccounts: new Map([['Account', 3]]),
      scope: {
        maxDepth: 5,
        maxObjects: 50,
        selected: ['Account'],
        parents: [{ objectApiName: 'Region__c', records: 1 }],
        leftEmpty: [],
        standardNeeded: [],
        cutShort: [{ objectApiName: 'Account', copied: 10, total: 90 }],
      },
    };

    const fitted = fittedScanOf(scan, chosen, { ...chosen.report, requestsRead: 1 });

    expect(fitted.parentIds.get('Account')).toEqual(keptOf(chosen, 'Account'));
    expect(fitted.recordCounts).toEqual(new Map([['Account', 2]]));
    expect(fitted.personAccounts).toEqual(new Map([['Account', 0]]));
    expect([...fitted.objectDescribes.keys()]).toEqual(['Account']);
    expect(fitted.scope.parents).toEqual([]);
    expect(fitted.scope).not.toHaveProperty('cutShort');
    expect(fitted.scope.fitted?.requestsRead).toBe(1);
  });
});

describe('the room a run keeps for the automation', () => {
  const flow = (over: Partial<ForgeTargetFlow>): ForgeTargetFlow => ({
    apiName: 'Task_On_Account',
    label: 'Task on account',
    timing: 'afterSave',
    startsOn: 'create',
    condition: 'read',
    permissions: [],
    creates: ['Task'],
    ...over,
  });
  const automationOf = (flows: ForgeTargetFlow[]): ForgeTargetAutomation => ({
    objectsRead: ['Account'],
    objects: [{ objectApiName: 'Account', flows, triggers: [] }],
    unread: [],
    conditionsNotRead: 0,
    conditionsBound: 25,
    requests: 4,
    bypassGrants: [
      {
        permission: 'Bypass',
        permissionSets: [{ name: 'PS_Bypass', label: 'Bypass', grants: 1 }],
      },
    ],
  });
  const writes = fitWritesOf(
    ['Account'],
    fitLookupsOf(describesOf(['Account']), ['Account'], ['Account']),
  );

  it('counts what fires on the inserts of the plan, and what the mute keeps quiet not at all', () => {
    const read = automationOf([
      flow({ permissions: [{ name: 'Bypass', bypass: true, held: false }] }),
    ]);

    expect(fitRoomOf(read, undefined, writes).perRecord).toEqual([
      expect.objectContaining({ objectApiName: 'Account', act: 'insert', bytes: 2 * KB }),
    ]);
    expect(fitRoomOf(read, mutePlanOf(read), writes).perRecord).toEqual([]);
  });

  it('counts a flow on update for an object the run writes twice, and no other', () => {
    const onUpdate = automationOf([flow({ startsOn: 'update' })]);

    expect(fitRoomOf(onUpdate, undefined, writes).perRecord).toEqual([
      expect.objectContaining({ act: 'update' }),
    ]);
    const noSecondWrite = fitWritesOf(['Account'], { links: [] });
    expect(fitRoomOf(onUpdate, undefined, noSecondWrite).perRecord).toEqual([]);
  });

  it('keeps no room, and says why, for an automation it could not read', () => {
    expect(fitRoomOf({ unread: 'INSUFFICIENT_ACCESS' }, undefined, writes)).toEqual({
      perRecord: [],
      notCounted: [],
      unread: 'INSUFFICIENT_ACCESS',
    });
  });
});

describe('fitLookupsOf', () => {
  const describes = describesOf(['Account', 'Contact', 'Territory__c', 'Licence__c']);
  const lookups = fitLookupsOf(
    describes,
    ['Account', 'Contact'],
    ['Territory__c', 'Account', 'Licence__c', 'Contact'],
  );
  const link = (objectApiName: string, field: string) =>
    lookups.links.find((l) => l.objectApiName === objectApiName && l.field === field)?.kind;

  it('reads a lookup by what is written first', () => {
    expect(link('Contact', 'AccountId')).toBe('holds');
    expect(link('Account', 'Primary_Contact__c')).toBe('owed');
    expect(link('Account', 'ParentId')).toBe('selfReference');
    expect(link('Contact', 'ReportsToId')).toBe('selfReference');
  });

  it('never holds a record to a parent read by id, which follows it', () => {
    expect(lookups.outward).toContainEqual({
      objectApiName: 'Account',
      field: 'Territory__c',
      parent: 'Territory__c',
      required: false,
    });
    expect(lookups.links.map((l) => l.parent)).not.toContain('Territory__c');
  });

  it('names the required lookups of what is read by id at a selected object', () => {
    expect(lookups.requiredOfParents).toEqual([
      expect.objectContaining({
        objectApiName: 'Licence__c',
        field: 'Account__c',
        parent: 'Account',
        kind: 'holds',
      }),
    ]);
  });
});

/** A plan of accounts, their contacts and their cases, every child under a parent. */
const planArb = fc
  .record({
    accounts: fc.integer({ min: 1, max: 30 }),
    contacts: fc.array(fc.nat(29), { maxLength: 40 }),
    cases: fc.array(fc.record({ contact: fc.nat(39), account: fc.nat(29) }), { maxLength: 40 }),
    kb: fc.integer({ min: 2, max: 240 }),
  })
  .map(({ accounts: n, contacts, cases, kb }) => {
    const Account: LargeOrgRow[] = idsOf('001', n).map((Id) => ({ Id }));
    const Contact: LargeOrgRow[] = idsOf('003', contacts.length).map((Id, i) => ({
      Id,
      AccountId: Account[contacts[i] % n].Id,
    }));
    const Case: LargeOrgRow[] = idsOf('500', cases.length).map((Id, i) => ({
      Id,
      AccountId: Account[cases[i].account % n].Id,
      ...(Contact.length > 0 ? { ContactId: Contact[cases[i].contact % Contact.length].Id } : {}),
    }));
    return { rows: { Account, Contact, Case }, bytes: kb * KB };
  });
const ORDER = ['Account', 'Contact', 'Case'];

describe('whatever the records and the budget', () => {
  const lookups = fitLookupsOf(describesOf(ORDER), ORDER, ORDER);
  const holds = lookups.links.filter((link) => link.kind === 'holds');

  it('keeps no record whose holding lookup names a record cut, nor one the source does not hold', async () => {
    await fc.assert(
      fc.asyncProperty(planArb, async ({ rows, bytes }) => {
        const chosen = await choose(ORDER, rows, { budget: budgetOf(bytes) });
        if (chosen.cannotFit !== undefined) return;
        for (const link of holds) {
          const kept = new Set(keptOf(chosen, link.parent));
          for (const row of chosen.kept.get(link.objectApiName) ?? []) {
            const value = row[link.field];
            if (typeof value === 'string') expect(kept.has(value)).toBe(true);
          }
        }
        for (const name of ORDER) {
          const source = new Set(rows[name as keyof typeof rows].map((row) => row.Id));
          for (const id of keptOf(chosen, name)) expect(source.has(id)).toBe(true);
        }
      }),
      { numRuns: 200 },
    );
  });

  it('never takes more than the budget, the same rows keeping the same records', async () => {
    await fc.assert(
      fc.asyncProperty(planArb, async ({ rows, bytes }) => {
        const chosen = await choose(ORDER, rows, { budget: budgetOf(bytes) });
        if (chosen.cannotFit !== undefined) return;
        expect(chosen.report.estimateMB * BYTES_PER_MB).toBeLessThanOrEqual(bytes);
        const total = ORDER.reduce(
          (sum, name) => sum + countedStorageBytes(name, { rows: keptOf(chosen, name).length }),
          0,
        );
        expect(total).toBe(chosen.report.estimateMB * BYTES_PER_MB);
        const again = await choose(ORDER, rows, { budget: budgetOf(bytes) });
        expect(ORDER.map((name) => keptOf(again, name))).toEqual(
          ORDER.map((name) => keptOf(chosen, name)),
        );
      }),
      { numRuns: 100 },
    );
  });

  it('stops one root short of what no longer fits', async () => {
    // Every child under a parent, the accounts are the only roots: a cap of
    // n accounts keeps what a share of n out of all of them keeps, and caps
    // alone refuse what is past the budget.
    await fc.assert(
      fc.asyncProperty(planArb, async ({ rows, bytes }) => {
        const held = {
          Account: rows.Account,
          Contact: rows.Contact,
          Case: rows.Case.filter((row) => row['ContactId'] !== undefined),
        };
        const chosen = await choose(ORDER, held, { budget: budgetOf(bytes) });
        if (chosen.cannotFit !== undefined || chosen.heldBy === 'whole') return;
        const k = keptOf(chosen, 'Account').length;
        if (k === rows.Account.length) return;
        const next = await choose(ORDER, held, {
          budget: budgetOf(bytes),
          mode: { caps: { Account: k + 1 } },
        });
        expect(next.cannotFit).toContain('with these caps the plan takes');
      }),
      { numRuns: 200 },
    );
  });
});
