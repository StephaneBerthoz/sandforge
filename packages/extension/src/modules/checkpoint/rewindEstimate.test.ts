import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RewindDiff, RewindDiffObject } from '@sandforge/shared';

import { MEMORY_ORG_USER, MemoryRemovalOrg } from '../../test/memoryRemovalOrg.js';
import { MemoryRestoreOrg } from '../../test/memoryRestoreOrg.js';
import { removeRunRecords } from '../forge/ForgeRunRemoval.js';
import type { LimitsTransport } from '../forge/ForgeRunGate.js';
import { restoreOverwrites, type BackupReader } from '../sync/SyncRunRestore.js';
import { undeleteRunDeletions } from '../sync/SyncRunUndelete.js';
import { compositeReader } from './compositeQueries.js';
import { readChanges } from './orgStreams.js';
import {
  bringBackCost,
  budgetGate,
  budgetRefusal,
  changeReadsCost,
  diffEstimate,
  readBudget,
  relationshipsOf,
  removalCost,
  restoreCost,
  rewindEstimate,
  rewindWritesCost,
  snapshotGroupReads,
  streamedReadsCost,
  takeEstimate,
  undeleteCost,
  undoEstimate,
  type EstimatedObject,
  type ObjectRelationships,
} from './rewindEstimate.js';

vi.mock('../../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

/*
 * What a checkpoint's acts cost before they run. Each brick a rewind and an
 * undo write through is run on the memory org, which counts a composite as
 * one request and every SOAP call apart, as the orgs were seen to: its
 * estimate is what the brick sent. The acts are then sums of the bricks,
 * worked through term by term, and the gate refuses past the day's requests
 * having read nothing but the org's limits.
 */

/** A fake id: the object's prefix and a counter, the length of a real one. */
const fakeId = (prefix: string, n: number): string => `${prefix}${String(n).padStart(12, '0')}AAA`;
const ids = (prefix: string, count: number): string[] =>
  Array.from({ length: count }, (_, n) => fakeId(prefix, n));

/** T0 on the org's clock, with its milliseconds. */
const T0 = Date.parse('2026-10-22T14:05:12.731Z');

/** Everything the memory org answered: its REST requests, a composite one, and its SOAP calls. */
function spent(org: MemoryRemovalOrg): number {
  return org.requests + org.soapCalls;
}

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function spoolDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sandforge-estimate-'));
  dirs.push(dir);
  return dir;
}

/** An object a diff found, holding nothing to do but what a test gives it. */
function found(objectApiName: string, extra: Partial<RewindDiffObject> = {}): RewindDiffObject {
  return {
    objectApiName,
    toDelete: { createdSince: 0, broughtBackSince: 0, comesBackWithParent: 0 },
    toGiveBack: { records: 0, fields: 0, clearedLookups: 0 },
    toBringBack: { inBin: 0, withParent: 0, deletedWhileTaken: 0 },
    cannotUndo: [],
    outside: [],
    touched: 0,
    unexplained: 0,
    lastChangedBy: {},
    notCompared: [],
    ...extra,
  };
}

/** A checkpoint's object of `records` records, its snapshot holding `fields`. */
function held(objectApiName: string, records: number, fields = ['Name']): EstimatedObject {
  return { objectApiName, records, fields: ['Id', 'SystemModstamp', ...fields] };
}

describe('takeEstimate', () => {
  it('counts a composite as one request — 25 describes, or five counts, bin reads or checks — and the snapshot a page a request, phase by phase', () => {
    const estimate = takeEstimate({
      described: 30,
      objects: [{ records: 4_500 }, { records: 0 }, { records: 2_000, otherGroups: [268, 500] }],
      pageRows: 2_000,
    });

    // The guard, the org, its edition, the permissions and the limits; the
    // two global describes, 2 calls of describes and the encryption right;
    // the user, the Automated Process user and T0; a call of counts, one of
    // the bin's first pages; 3 pages of the first object and 1 of the wide
    // one, whose page of 2,000 rows is read again by its ids, 268 then 500
    // a statement, and which org the snapshot is of; T1 and a call of checks.
    expect(estimate.requestsByPhase).toEqual({
      guard: 4,
      scope: 3 + 2,
      start: 3,
      counts: 1,
      bin: 1,
      snapshot: 3 + (1 + 8 + 4) + 1,
      stability: 1 + 1,
    });
    expect(estimate).toEqual({
      records: 6_500,
      apiRequests: 4 + 5 + 3 + 1 + 1 + 17 + 2,
      requestsByPhase: estimate.requestsByPhase,
      seconds: Math.ceil(2 * 2.5 + 3 * 0.35 + 4 + 12 * 0.5),
      bytes: 6_500 * 1_000 + (8 + 4_500 * 35) + 8 + (8 + 2_000 * 35),
    });
  });

  it('reads a wide object’s other column groups by the ids a statement of each holds, a full page and the last apart', () => {
    const snapshot = (records: number, otherGroups: number[]): number =>
      takeEstimate({ described: 1, objects: [{ records, otherGroups }], pageRows: 2_000 })
        .requestsByPhase?.snapshot ?? Number.NaN;

    // Two pages, 2,000 rows then 600: the full one read again in 8
    // statements of 268 ids and 4 of 500, the last in 3 and 2; and the org.
    expect(snapshot(2_600, [268, 500])).toBe(2 + (8 + 4) + (3 + 2) + 1);
    // Three records take one statement a group, not as many as a full page.
    expect(snapshot(3, [268])).toBe(1 + 1 + 1);
    // One statement reads an object whose fields fit it.
    expect(snapshot(4_001, [])).toBe(3 + 1);
  });

  it('counts every object it counts, those it then leaves out among them, and again alone each describe and count a composite did not answer', () => {
    const estimate = takeEstimate({
      described: 26,
      describedAlone: 2,
      counted: 6,
      countedAlone: 1,
      objects: Array.from({ length: 5 }, () => ({ records: 0 })),
      pageRows: 2_000,
    });

    expect(estimate.requestsByPhase).toEqual({
      guard: 4,
      scope: 3 + 2 + 2,
      start: 3,
      counts: 2 + 1,
      bin: 1,
      // Nothing to read: no page, and no snapshot to ask which org it is of.
      snapshot: 0,
      stability: 1 + 1,
    });
    expect(estimate.apiRequests).toBe(4 + 7 + 3 + 3 + 1 + 0 + 2);
  });

  it('tells, of a snapshot’s object, the ids a read by id of each column group after the first names, fewer through the recycle bin', () => {
    const narrow = ['Id', 'SystemModstamp', 'Name'];
    const wide = [
      'Id',
      'SystemModstamp',
      ...Array.from({ length: 900 }, (_, n) => `Customer_Field_${String(n).padStart(4, '0')}__c`),
    ];

    expect(snapshotGroupReads('Account', narrow, 'query')).toEqual([]);
    const query = snapshotGroupReads('Task', wide, 'query');
    const throughBin = snapshotGroupReads('Task', wide, 'scanAllLive');
    expect(query.length).toBeGreaterThan(1);
    expect(query.every((ids) => ids > 0 && ids <= 500)).toBe(true);
    expect(Math.min(...query)).toBeLessThan(500);
    expect(throughBin).toHaveLength(query.length);
    throughBin.forEach((ids, at) => expect(ids).toBeLessThanOrEqual(query[at]));
    expect(throughBin.some((ids, at) => ids < query[at])).toBe(true);
  });
});

describe('the bricks, as they send their requests to the org', () => {
  it('counts the change reads as readChanges sends them: five pre-checks a call, five reads at a time followed to the end of the longest, five counts a call', async () => {
    let clock = T0 - 86_400_000;
    const org = new MemoryRemovalOrg({}, { now: () => clock });
    for (const id of ids('001', 4_500)) org.add('Account', { Id: id, Name: 'Before' });
    for (const id of ids('003', 30)) org.add('Contact', { Id: id, LastName: 'Before' });
    for (const id of ids('006', 5)) org.add('Opportunity', { Id: id, Name: 'Before' });
    clock = T0 + 60_000;
    for (const id of ids('001', 4_500)) org.edit('Account', id, { Name: 'Since' });
    for (const id of ids('003', 30)) org.trash('Contact', id);
    for (const id of ids('500', 10)) org.add('Case', { Id: id, Subject: 'Since' });
    const names = ['Account', 'Contact', 'Case', 'Lead', 'Opportunity', 'Task', 'Campaign'];
    const holding = new Set(['Account', 'Contact', 'Opportunity']);
    const before = spent(org);

    const changes = await readChanges(
      compositeReader(org),
      names.map((objectApiName) => ({
        objectApiName,
        readMode: objectApiName === 'Task' ? 'scanAllLive' : 'query',
        held: holding.has(objectApiName),
      })),
      new Date(T0).toISOString(),
      spoolDir(),
    );

    expect(changes.filter((change) => 'moved' in change && change.moved)).toHaveLength(3);
    const cost = changeReadsCost({
      objects: names.length,
      held: [...holding],
      moved: [
        { objectApiName: 'Account', live: 4_500, deleted: 0 },
        { objectApiName: 'Contact', live: 0, deleted: 30 },
        { objectApiName: 'Case', live: 10, deleted: 0 },
      ],
    });
    // 2 calls of pre-checks; the first five reads take as many calls as the
    // Account's three pages, the sixth one more; one call of four counts.
    expect(cost.apiRequests).toBe(2 + 3 + 1 + 1);
    expect(spent(org) - before).toBe(cost.apiRequests);
  });

  it('counts an undelete asked for no stamps as it sends it: three requests per 200 records, the undelete itself a SOAP call, and neither the clock nor the user', async () => {
    const org = new MemoryRemovalOrg({}, { now: () => T0 });
    const accounts = ids('001', 450);
    const contacts = ids('003', 30);
    for (const id of accounts) org.add('Account', { Id: id });
    for (const id of contacts) org.add('Contact', { Id: id });
    for (const id of [...accounts, ...contacts]) {
      org.trash(id.startsWith('001') ? 'Account' : 'Contact', id);
    }
    const before = spent(org);
    const soapBefore = org.soapCalls;

    const outcome = await undeleteRunDeletions({
      org,
      plan: [
        { objectApiName: 'Account', ids: accounts },
        { objectApiName: 'Contact', ids: contacts },
      ],
      undelete: (batch) => org.undelete(batch),
    });

    expect(outcome.objects.map((object) => object.undeleted)).toEqual([450, 30]);
    expect(undeleteCost([450, 30]).apiRequests).toBe(3 * (3 + 1));
    expect(spent(org) - before).toBe(undeleteCost([450, 30]).apiRequests);
    // Four undeletes: what a count of REST requests misses.
    expect(org.soapCalls - soapBefore).toBe(4);
  });

  it('counts a rewind’s bring back: per batch of 200 the undelete’s three, the children the bin holds of it read five relationships a call, and the stamps read back; and the describe of an object the read it acts on did not describe', () => {
    expect(
      bringBackCost([
        { records: 450, cascades: 6, described: true },
        { records: 30, cascades: 0, described: false },
        { records: 0, cascades: 3, described: false },
      ]).apiRequests,
    ).toBe(3 * (3 + 2 + 1) + (1 + 3 + 0 + 1));
  });

  it('counts a give-back as it sends it, a chunk of 2,000 a call: its clock and its user, the reads by id, the updates and the stamps read back', async () => {
    const org = new MemoryRestoreOrg({}, { now: () => T0 });
    const accounts = ids('001', 450);
    for (const id of accounts) org.add('Account', { Id: id, Name: 'Changed since' });
    const kept = accounts.map((id) => ({ Id: id, Name: 'At the checkpoint' }));
    const backups: BackupReader = {
      batches: async (_operationId, objectApiName, size) =>
        objectApiName !== 'Account'
          ? null
          : {
              async *[Symbol.asyncIterator]() {
                for (let at = 0; at < kept.length; at += size) yield kept.slice(at, at + size);
              },
            },
    };
    const before = spent(org);

    const outcome = await restoreOverwrites({
      org,
      plan: [{ objectApiName: 'Account', backup: 'snapshot-1', ids: accounts }],
      backups,
      changedAfter: new Date(T0 + 1_000).toISOString(),
      ownWriters: [MEMORY_ORG_USER],
      fields: { Account: ['Name'] },
      includeChanged: false,
      stampsFor: () => true,
    });

    expect(outcome.objects[0]).toMatchObject({ planned: 450, restored: 450 });
    expect(restoreCost(450, ['Id', 'SystemModstamp', 'Name']).apiRequests).toBe(2 + 3 + 3 + 3);
    expect(spent(org) - before).toBe(restoreCost(450, ['Name']).apiRequests);
  });

  it('counts a removal as it sends it: the global describe, its clock and its user; per object its describe, its reads by id, its dependents and its deletes', async () => {
    const children = {
      Account: [
        { childSObject: 'Contact', field: 'AccountId', cascadeDelete: true },
        { childSObject: 'Case', field: 'AccountId', restrictedDelete: true },
      ],
    };
    const run = async (pointing: boolean): Promise<number> => {
      let clock = T0 - 60_000;
      const org = new MemoryRemovalOrg(children, { now: () => clock });
      if (pointing) {
        // Records that stay, pointing through both relationships at an account
        // the removal leaves alone: each is read for every 200 accounts.
        org.add('Account', { Id: fakeId('001', 9_000) });
        org.add('Contact', { Id: fakeId('003', 9_000), AccountId: fakeId('001', 9_000) });
        org.add('Case', { Id: fakeId('500', 9_000), AccountId: fakeId('001', 9_000) });
      }
      clock = T0 + 1_000;
      const accounts = ids('001', 250);
      const contacts = ids('003', 450);
      for (const id of accounts) org.add('Account', { Id: id });
      contacts.forEach((id, n) => org.add('Contact', { Id: id, AccountId: accounts[n % 250] }));
      clock = T0 + 5_000;
      const before = spent(org);
      const outcome = await removeRunRecords(
        org,
        [
          { objectApiName: 'Contact', ids: contacts },
          { objectApiName: 'Account', ids: accounts },
        ],
        { runStartedAt: new Date(T0), runEndedAt: new Date(T0 + 2_000), includeChanged: false },
      );
      expect(outcome.objects.map((object) => object.deleted)).toEqual([450, 250]);
      return spent(org) - before;
    };
    const cost = removalCost([
      { records: 450, dependents: 0 },
      {
        records: 250,
        dependents: relationshipsOf({ childRelationships: children.Account }).dependents,
      },
    ]);

    // 3 for the call; the contacts: a describe, 3 reads, 3 deletes; the
    // accounts: a describe, 2 reads, each relationship asked once then read
    // twice, 2 deletes.
    expect(cost.apiRequests).toBe(3 + (1 + 3 + 3) + (1 + 2 + (2 + 2 * 2) + 2));
    expect(await run(true)).toBe(cost.apiRequests);
    // Nothing points through a relationship: it is not read per 200 records.
    expect(await run(false)).toBeLessThan(cost.apiRequests);
  });

  it('prices no Bulk call: the deletes past 10,000 records of an object are counted as the REST calls of 200 they stand for', () => {
    const cost = removalCost([{ records: 12_000, dependents: 0 }]);
    // 3 for the call; a describe, 60 reads by id, 60 deletes of 200.
    expect(cost.apiRequests).toBe(3 + 1 + 60 + 60);
  });

  it('gives back in chunks of 2,000, each a call with its clock and its user, and reads a wide object a quarter as many ids a statement', () => {
    const narrow = ['Id', 'SystemModstamp', 'Name'];
    // Two chunks of 2,000 (10 reads, 10 updates, 10 stamps each) and one of 1.
    expect(restoreCost(4_001, narrow).apiRequests).toBe(2 * (2 + 10 + 10 + 10) + (2 + 1 + 1 + 1));
    const wide = Array.from({ length: 120 }, (_, n) => `F${n}__c`);
    expect(restoreCost(200, wide).apiRequests).toBe(2 + 4 + 1 + 1);
  });

  it('streams reads five at a time, each five costing the pages of the longest', () => {
    expect(streamedReadsCost([3, 1, 1, 1, 1, 1]).apiRequests).toBe(3 + 1);
    expect(streamedReadsCost([1, 1, 1, 1, 1, 3]).apiRequests).toBe(1 + 3);
    expect(streamedReadsCost([2, 2, 2, 2, 2]).apiRequests).toBe(2);
  });

  it('reads an object’s relationships from its describe: those deleted along, and those restricting a delete', () => {
    expect(
      relationshipsOf({
        childRelationships: [
          { childSObject: 'Contact', field: 'AccountId', cascadeDelete: true },
          { childSObject: 'Case', field: 'AccountId', restrictedDelete: true },
          { childSObject: 'Note', field: 'ParentId', cascadeDelete: true },
          { childSObject: 'Task', field: 'WhatId' },
        ],
      }),
    ).toEqual({ dependents: 3, cascades: 2, cascadeChildren: ['Contact', 'Note'] });
    expect(relationshipsOf({ childRelationships: null })).toEqual({
      dependents: 0,
      cascades: 0,
      cascadeChildren: [],
    });
  });

  it('tells, given the checkpoint’s bounds, the relationships deleted along to objects outside it, and of them those a person works in', () => {
    const describe = {
      childRelationships: [
        { childSObject: 'Contact', field: 'AccountId', cascadeDelete: true },
        { childSObject: 'Opportunity', field: 'AccountId', cascadeDelete: true },
        { childSObject: 'AccountFeed', field: 'ParentId', cascadeDelete: true },
        { childSObject: 'Case', field: 'AccountId', restrictedDelete: true },
      ],
    };

    expect(
      relationshipsOf(describe, {
        inCheckpoint: new Set(['account', 'contact']),
        worked: new Set(['Account', 'Contact', 'Opportunity', 'Case']),
      }),
    ).toEqual({
      dependents: 4,
      cascades: 3,
      cascadeChildren: ['Contact', 'Opportunity', 'AccountFeed'],
      outside: { all: 2, worked: 1 },
    });
    // The org's objects not described: none known to be worked in.
    expect(relationshipsOf(describe, { inCheckpoint: new Set(['account']) }).outside).toEqual({
      all: 3,
      worked: 0,
    });
  });
});

/** A checkpoint of three objects, and what a preview found of two of them. */
const CHECKPOINT = [held('Account', 300), held('Contact', 900), held('Lead', 0)];
const FOUND = [
  found('Account', {
    toGiveBack: { records: 10, fields: 14, clearedLookups: 0 },
    touched: 2,
    toDelete: { createdSince: 4, broughtBackSince: 0, comesBackWithParent: 0 },
    toBringBack: { inBin: 3, withParent: 0, deletedWhileTaken: 0 },
  }),
  found('Contact', {
    toDelete: { createdSince: 450, broughtBackSince: 0, comesBackWithParent: 0 },
    toBringBack: { inBin: 0, withParent: 5, deletedWhileTaken: 0 },
  }),
];
describe('diffEstimate', () => {
  it('counts a read of what changed since: its clock, the drift describes, the change reads, the values of what changed and of what comes back with a parent, and the describes of what it brings back', () => {
    const cost = diffEstimate({ objects: CHECKPOINT, diff: { objects: FOUND, unread: [] } });
    // 1 for the clock; 1 call of describes; 1 of pre-checks; the four reads
    // of what moved and was deleted in one call; 1 of counts; the 12 Account
    // values in 1 call, and the 5 contacts that come back with their account,
    // whose lookup names it, in another; the accounts and the contacts it
    // brings back described in 1 call; no user to name.
    expect(cost.apiRequests).toBe(1 + 1 + 1 + 1 + 1 + (1 + 1) + 1);
  });

  it('names the users who last changed what it found, two hundred a read, five reads a call', () => {
    const changedBy = (users: number): Record<string, number> =>
      Object.fromEntries(Array.from({ length: users }, (_, n) => [fakeId('005', n), 1]));
    const named = (users: number): number =>
      diffEstimate({
        objects: CHECKPOINT,
        diff: { objects: [found('Lead', { lastChangedBy: changedBy(users) })], unread: [] },
      }).apiRequests;

    expect(named(1) - named(0)).toBe(1);
    expect(named(1_000) - named(0)).toBe(1);
    expect(named(1_001) - named(0)).toBe(2);
  });

  it('describes the objects it deletes records of, once, and the org’s objects when one of them deletes along outside the checkpoint, reading what lies there per 200 of them', () => {
    const deleting = found('Contact', {
      toDelete: { createdSince: 2_500, broughtBackSince: 0, comesBackWithParent: 7 },
    });
    const cost = (relationships?: ReadonlyMap<string, ObjectRelationships>): number =>
      diffEstimate({
        objects: CHECKPOINT,
        diff: { objects: [deleting], unread: [] },
        ...(relationships ? { relationships } : {}),
      }).apiRequests;
    const inside = cost(
      new Map([['Contact', { dependents: 0, cascades: 0, outside: { all: 0, worked: 0 } }]]),
    );
    const outside = cost(
      new Map([['Contact', { dependents: 3, cascades: 3, outside: { all: 3, worked: 2 } }]]),
    );

    // The org's objects described, then 2 relationships read for each of the
    // 2,500 contacts created since in 13 batches: 10 then 3, a chunk of 2,000
    // at a time, 4 calls then 2. What comes back with a parent is not read.
    expect(outside - inside).toBe(1 + 4 + 2);
    // A relationship outside the checkpoint nobody works in is described for, never read.
    expect(
      cost(new Map([['Contact', { dependents: 1, cascades: 1, outside: { all: 1, worked: 0 } }]])) -
        inside,
    ).toBe(1);
    // A describe that came back whole with the drift answers for the relationships.
    const drifted = diffEstimate({
      objects: CHECKPOINT,
      diff: {
        objects: [{ ...deleting, schemaDrift: { removed: [], added: ['Rank__c'], changed: [] } }],
        unread: [],
      },
    }).apiRequests;
    expect(cost() - drifted).toBe(1);
  });

  it('reads again an object the last read could not, scans every id of an object some of whose records are gone for good, and counts what lies outside under each 200 deleted', () => {
    const cost = diffEstimate({
      objects: [held('Account', 4_500), held('Contact', 900), held('Lead', 0)],
      diff: {
        objects: [
          found('Account', {
            cannotUndo: [{ reason: 'goneForGood', count: 7 }],
            toBringBack: { inBin: 1, withParent: 0, deletedWhileTaken: 0 },
          }),
          found('Contact', {
            toDelete: { createdSince: 300, broughtBackSince: 0, comesBackWithParent: 0 },
            outside: [
              { objectApiName: 'Opportunity', count: 3, parents: 2 },
              { objectApiName: 'Case', count: 1, parents: 1 },
            ],
          }),
        ],
        unread: [
          { objectApiName: 'Lead', reason: 'The read ended before the org said it was done.' },
        ],
      },
    });
    // 1 for the clock; 1 of describes; 1 of pre-checks; six reads of what
    // moved, the Lead's among them, in 2 calls; 1 of counts; the account it
    // brings back described; the contacts, which it deletes records of,
    // described apart; the org's objects described, as the contacts' deletion
    // reaches outside the checkpoint; 2 relationships outside read for each
    // of 2 batches of contacts, 1 call; the 4,500 accounts' ids in 3 pages.
    expect(cost.apiRequests).toBe(1 + 1 + 1 + 2 + 1 + 1 + 1 + 1 + 1 + 3);
  });

  it('scans no ids of an object Salesforce undeletes only with its parent: what it names gone for good there was read in the bin', () => {
    const lines = (undeletable: boolean): number =>
      diffEstimate({
        objects: [{ ...held('OpportunityLineItem', 4_500), undeletable }],
        diff: {
          objects: [
            found('OpportunityLineItem', { cannotUndo: [{ reason: 'goneForGood', count: 7 }] }),
          ],
          unread: [],
        },
      }).apiRequests;

    // Undeletable alone: its 4,500 ids in 3 pages. Only with its parent: its
    // describe, as records of it were read coming back.
    expect(lines(true) - lines(false)).toBe(3 - 1);
  });
});

describe('rewindEstimate', () => {
  /** Accounts take their contacts along; contacts take nothing. */
  const DESCRIBED = new Map<string, ObjectRelationships>([
    ['Account', { dependents: 2, cascades: 1, cascadeChildren: ['Contact'] }],
    ['Contact', { dependents: 0, cascades: 0, cascadeChildren: [] }],
  ]);
  const input = {
    objects: CHECKPOINT,
    diff: { objects: FOUND, unread: [] },
    automationRequests: 7,
    relationships: DESCRIBED,
  };

  it('counts the guard and the day’s limits, the fresh diff, the automation, the user it writes as, pass 1 and the read after it, each brick as it sends', () => {
    const estimate = rewindEstimate(input);

    // As the first diffEstimate case counts it.
    const diff = 8;
    const passOne =
      // The org's objects, described for those it does not query among the
      // children that come back: the fresh diff did not describe them.
      1 +
      // Bring back the 3 accounts: the undelete's 3 for their batch, the
      // children it holds through Account's 1 cascade, the stamps read back.
      3 +
      1 +
      1 +
      // Give back 13 accounts: a chunk, of clock, user, a read, an update and
      // a stamps read; the contacts the rewind deletes may hang from some,
      // which are then kept first, read by id, and given back after the
      // deletes in calls of their own: a read, and the clock, user, a read,
      // an update and a stamps read more.
      5 +
      (1 + 5) +
      // Give back the 5 contacts that came back with their account: a chunk.
      5 +
      // Delete 4 accounts (2 relationships) and 450 contacts.
      (3 + (1 + 1 + 2 + 1) + (1 + 3 + 0 + 3));
    // The org read again once pass 1 went through: the clock, the describes,
    // the pre-checks, the four reads of what moved and was deleted, the
    // counts, and the values of the 15 accounts and 5 contacts given back or
    // brought back — what was deleted is in the bin, and nothing is left to do.
    const after = 1 + 1 + 1 + 1 + 1 + (1 + 1);
    expect(estimate.apiRequests).toBe(4 + diff + 7 + 1 + passOne + after);
    // The preview's three numbers: 454 to delete, 10 to give back, 8 to bring back.
    expect(estimate.records).toBe(454 + 10 + 8);
    // The journal: the values of the 18 records given back, the ids of the 462 deleted or brought back.
    expect(estimate.bytes).toBe(18 * 500 + 462 * 40);
  });

  it('reads no fresh diff when the command line rewinds from the preview it just read, and describes what it brings records back to, and what comes back with them, as it brings them back', () => {
    // The accounts it brings back, and the contacts that come back with them.
    expect(rewindEstimate({ ...input, reusesPreview: true }).apiRequests).toBe(
      rewindEstimate(input).apiRequests - diffEstimate(input).apiRequests + 1 + 1,
    );
  });

  it('reads, as it names each batch it brings back, what the bin holds under the records that come back with it, through their own cascades', () => {
    const under = (withParent: number): number =>
      rewindWritesCost({
        objects: [held('Account', 10), held('Opportunity', 900)],
        diff: {
          objects: [
            found('Account', { toBringBack: { inBin: 1, withParent: 0, deletedWhileTaken: 0 } }),
            found('Opportunity', {
              toBringBack: { inBin: 0, withParent, deletedWhileTaken: 0 },
            }),
          ],
          unread: [],
        },
        automationRequests: 0,
        relationships: new Map([
          ['Account', { dependents: 1, cascades: 1, cascadeChildren: ['Opportunity'] }],
          [
            'Opportunity',
            { dependents: 2, cascades: 2, cascadeChildren: ['OpportunityLineItem', 'Line__c'] },
          ],
        ]),
      }).apiRequests;
    // 450 opportunities back with their account: under them, 2 cascades read
    // in one call, for the account's one batch and for each 200 of them;
    // given back, a chunk of clock, user, 3 reads, 3 updates, 3 stamps reads;
    // and their values read again by id once the pass went through.
    expect(under(450) - under(0)).toBe((1 + 3) * 1 + (2 + 3 + 3 + 3) + 3);
  });

  it('counts the records that come back with their parent as read back and given back, never sent to the recycle bin alone', () => {
    const alone = rewindEstimate({
      ...input,
      diff: {
        objects: [
          found('Contact', { toBringBack: { inBin: 5, withParent: 0, deletedWhileTaken: 0 } }),
        ],
        unread: [],
      },
    });
    const withParent = rewindEstimate({
      ...input,
      diff: {
        objects: [
          found('Contact', { toBringBack: { inBin: 0, withParent: 5, deletedWhileTaken: 0 } }),
        ],
        unread: [],
      },
    });
    // No undelete of their own: the 3 of their batch and the stamps read
    // back. But the fresh diff reads them by id, as their lookup names a
    // parent brought back; the read after pass 1 reads either by id.
    expect(alone.apiRequests - withParent.apiRequests).toBe(3 + 1 - 1);
    expect(withParent.records).toBe(5);
  });

  it('deletes in pass 2 what comes back with its parent, reading the org after each pass, and names who last changed what it then finds to delete', () => {
    const comesBack = {
      ...input,
      diff: {
        objects: [
          found('Contact', {
            toDelete: { createdSince: 0, broughtBackSince: 0, comesBackWithParent: 3 },
          }),
        ],
        unread: [],
      },
    };
    const later = rewindEstimate(comesBack);
    const diff = diffEstimate(comesBack).apiRequests;
    // After pass 1: the clock, the describes, the pre-checks, the reads of
    // what moved, the counts, the contacts described as records to delete,
    // and who last changed them; after pass 2, the verify finds them in the bin.
    const afterOne = 1 + 1 + 1 + 1 + 1 + 1 + 1;
    const verify = 1 + 1 + 1 + 1 + 1;
    // The guard and the limits, the fresh diff, the automation, the user,
    // nothing in pass 1; pass 2's removal of the 3.
    expect(later.apiRequests).toBe(4 + diff + 7 + 1 + afterOne + (3 + 1 + 1 + 0 + 1) + verify);
  });

  it('gives an order its status back alone, in calls of its own, before its other fields', () => {
    const orders = (objectApiName: string): number =>
      rewindEstimate({
        objects: [held(objectApiName, 450, ['Status', 'Description'])],
        diff: {
          objects: [
            found(objectApiName, { toGiveBack: { records: 450, fields: 2, clearedLookups: 0 } }),
          ],
          unread: [],
        },
        automationRequests: 0,
      }).apiRequests;

    // Per chunk of 450: the clock and the user, 3 reads, 3 updates, 3 stamps reads.
    expect(orders('Order') - orders('Contract')).toBe(2 + 3 + 3 + 3);
  });

  it('counts the records of an object it gives back as waiting for the deletes of records that may hang from them, and as given back before those of records they may hang from too: the most it sends', () => {
    // Records of B may hang from A's, read after B's children first; A's may
    // hang from C's. None of their describes was read.
    const objects: EstimatedObject[] = [
      { ...held('B', 300), readOrder: 0, cascadeParents: ['A__c'] },
      { ...held('A', 900), readOrder: 1, cascadeParents: ['C__c'] },
      { ...held('C', 10), readOrder: 2, cascadeParents: [] },
    ];
    const relationships = new Map<string, ObjectRelationships>(
      ['A', 'B', 'C'].map((name) => [name, { dependents: 0, cascades: 0 }]),
    );
    const toGiveBack = { records: 450, fields: 1, clearedLookups: 0 };
    const created = (count: number): Partial<RewindDiffObject> => ({
      toDelete: { createdSince: count, broughtBackSince: 0, comesBackWithParent: 0 },
    });
    const cost = (objectsFound: RewindDiffObject[]): number =>
      rewindWritesCost({
        objects,
        diff: { objects: objectsFound, unread: [] },
        automationRequests: 0,
        relationships,
      }).apiRequests;

    const alone = cost([found('A', { toGiveBack })]);
    const waiting = cost([found('B', created(5)), found('A', { toGiveBack })]);
    const twice = cost([
      found('B', created(5)),
      found('A', { toGiveBack }),
      found('C', created(1)),
    ]);

    // A call of its own over part of them: its clock and user, and a part-full
    // read, update and stamps read.
    const split = 2 + 1 + 1 + 1;
    // Waiting for B's deletes, A's 450 are kept first, 3 reads, and given back
    // apart; B's 5 are deleted: the removal's global describe, clock and user,
    // B's describe, read and delete. Read again after, B moved in the same call.
    expect(waiting - alone).toBe(3 + split + (3 + 1 + 1 + 1));
    // Before C's deletes as well, A's 450 are given back once more apart: the
    // clock, the user, 3 reads, 3 updates, 3 stamps reads. C's 1 is deleted,
    // and read again after in a call more.
    expect(twice - waiting).toBe(2 + 3 + 3 + 3 + split + (1 + 1 + 1) + 1);
    // Known to hang from nothing, B's records hold none of A's in place.
    expect(
      rewindWritesCost({
        objects: [{ ...objects[0], cascadeParents: [] }, objects[1], objects[2]],
        diff: { objects: [found('B', created(5)), found('A', { toGiveBack })], unread: [] },
        automationRequests: 0,
        relationships,
      }).apiRequests,
    ).toBe(waiting - 3 - split);
  });

  it('counts the deletes of records Salesforce undeletes only with their parent alone: the rest go with their parent, never sent', () => {
    const objects: EstimatedObject[] = [
      {
        ...held('OpportunityLineItem', 0),
        undeletable: false,
        readOrder: 0,
        cascadeParents: ['OpportunityId'],
      },
      { ...held('Opportunity', 0), readOrder: 1, cascadeParents: [] },
    ];
    const cost = (undoCannot: number): number =>
      rewindWritesCost({
        objects,
        diff: {
          objects: [
            found('OpportunityLineItem', {
              toDelete: { createdSince: 450, broughtBackSince: 0, comesBackWithParent: 0 },
            }),
            found('Opportunity', {
              toDelete: { createdSince: 300, broughtBackSince: 0, comesBackWithParent: 0 },
            }),
          ],
          unread: [],
          undoCannot:
            undoCannot > 0 ? [{ objectApiName: 'OpportunityLineItem', count: undoCannot }] : [],
        },
        automationRequests: 0,
        relationships: new Map([
          ['OpportunityLineItem', { dependents: 0, cascades: 0, cascadeChildren: [] }],
          ['Opportunity', { dependents: 1, cascades: 1, cascadeChildren: ['OpportunityLineItem'] }],
        ]),
      }).apiRequests;

    // Deleted on their own, the 450 products: their describe, 3 reads and 3 deletes.
    expect(cost(450) - cost(0)).toBe(1 + 3 + 3);
  });

  it('counts the deletes of every record Salesforce undeletes only with its parent that Undo couldn’t bring back, whatever the reason: those under a parent that stays and those deleted before one the rewind deletes next', () => {
    const objects: EstimatedObject[] = [
      {
        ...held('OpportunityLineItem', 0),
        undeletable: false,
        readOrder: 0,
        cascadeParents: ['OpportunityId'],
      },
      { ...held('Opportunity', 0), readOrder: 1, cascadeParents: [] },
    ];
    const cost = (undoCannot: RewindDiff['undoCannot']): number =>
      rewindWritesCost({
        objects,
        diff: {
          objects: [
            found('OpportunityLineItem', {
              toDelete: { createdSince: 450, broughtBackSince: 0, comesBackWithParent: 0 },
            }),
            found('Opportunity', {
              toDelete: { createdSince: 300, broughtBackSince: 0, comesBackWithParent: 0 },
            }),
          ],
          unread: [],
          undoCannot,
        },
        automationRequests: 0,
        relationships: new Map([
          ['OpportunityLineItem', { dependents: 0, cascades: 0, cascadeChildren: [] }],
          ['Opportunity', { dependents: 1, cascades: 1, cascadeChildren: ['OpportunityLineItem'] }],
        ]),
      }).apiRequests;

    // 250 under an opportunity that stays and 200 before one deleted next: all 450 sent.
    expect(
      cost([
        { objectApiName: 'OpportunityLineItem', count: 250 },
        { objectApiName: 'OpportunityLineItem', count: 200, reason: 'deletedBeforeParent' },
      ]),
    ).toBe(cost([{ objectApiName: 'OpportunityLineItem', count: 450 }]));
  });

  it('counts no delete of the records, of any object, that go with a parent the rewind deletes too: never sent, they come back with it', () => {
    const objects: EstimatedObject[] = [
      { ...held('Contact', 0), readOrder: 0, cascadeParents: ['AccountId'] },
      { ...held('Account', 0), readOrder: 1, cascadeParents: [] },
    ];
    const cost = (along: number): number =>
      rewindWritesCost({
        objects,
        diff: {
          objects: [
            found('Contact', {
              toDelete: { createdSince: 450, broughtBackSince: 0, comesBackWithParent: 0 },
            }),
            found('Account', {
              toDelete: { createdSince: 300, broughtBackSince: 0, comesBackWithParent: 0 },
            }),
          ],
          unread: [],
          undoCannot: [],
          ...(along > 0 ? { withParentDeleted: [{ objectApiName: 'Contact', count: along }] } : {}),
        },
        automationRequests: 0,
        relationships: new Map([
          ['Contact', { dependents: 0, cascades: 0, cascadeChildren: [] }],
          ['Account', { dependents: 1, cascades: 1, cascadeChildren: ['Contact'] }],
        ]),
      }).apiRequests;

    // Sent on their own, the 450 contacts: their describe, 3 reads and 3 deletes.
    expect(cost(0) - cost(450)).toBe(1 + 3 + 3);
    // 50 of them sent: a read and a delete for one batch, the describe kept.
    expect(cost(400) - cost(450)).toBe(1 + 1 + 1);
  });

  it('asks again, for each page of 2,000 records a rewind hands its removal, whether anything points through each relationship', () => {
    const cost = (records: number): number =>
      removalCost([{ records, dependents: 2 }], 2_000).apiRequests -
      removalCost([{ records, dependents: 0 }], 2_000).apiRequests;
    // 2,500 records: a page of 2,000 and one of 500, each of more than a batch.
    expect(cost(2_500)).toBe(2 * 2 + 2 * 13);
    // A plan held in memory is one page.
    expect(
      removalCost([{ records: 2_500, dependents: 2 }]).apiRequests -
        removalCost([{ records: 2_500, dependents: 0 }]).apiRequests,
    ).toBe(2 + 2 * 13);
  });

  it('counts an object whose describe was not read at the most relationships a removal was seen to read for one, and as one whose records any other may hang from', () => {
    const described = rewindEstimate(input).apiRequests;
    const undescribed = rewindEstimate({ ...input, relationships: undefined }).apiRequests;
    expect(undescribed - described).toBe(
      // The accounts' 23 cascades read five a call for their batch, not 1;
      // and the contacts' 23 read under the 5 that come back with them, for
      // that batch and for their own, where they hold none.
      4 +
        2 * 5 +
        // The accounts may hang from contacts the rewind deletes: given back
        // before as well, apart, 5 and a split.
        (5 + 5) +
        // The contacts may wait for the accounts' deletes, and hang from them:
        // kept first and given back apart, then before as well.
        (1 + 5) +
        (5 + 5) +
        // Accounts: 23 dependents for 2 in one batch; contacts: 23 dependents
        // for none, asked once for their page and read for each of 3 batches.
        21 +
        (23 + 23 * 3),
    );
  });

  it('reads the org and writes nothing when nothing differs: the guard, the limits and the fresh diff', () => {
    const nothing = rewindEstimate({ ...input, diff: { objects: [], unread: [] } });
    expect(nothing).toEqual({
      records: 0,
      apiRequests:
        4 + diffEstimate({ objects: CHECKPOINT, diff: { objects: [], unread: [] } }).apiRequests,
      seconds: expect.any(Number) as number,
      bytes: 0,
    });
  });

  it('lands under the figures planned for a Developer Edition org: a take of about 250 requests, a preview of about 100, a rewind of at most about 500, about 100 fewer from the command line', () => {
    // 300 objects, 40 holding 2,500 records; 10 moved since: 60 records to
    // give back, 12 to bring back, 140 to delete.
    const objects = Array.from({ length: 300 }, (_, n) =>
      held(`Object${n}__c`, n < 40 ? (n === 0 ? 82 : 62) : 0, ['Name', 'Status__c', 'Amount__c']),
    );
    const moved = Array.from({ length: 10 }, (_, n) =>
      found(`Object${n}__c`, {
        toGiveBack: { records: 6, fields: 9, clearedLookups: 0 },
        ...(n < 3 ? { toBringBack: { inBin: 4, withParent: 0, deletedWhileTaken: 0 } } : {}),
        ...(n >= 5
          ? { toDelete: { createdSince: 28, broughtBackSince: 0, comesBackWithParent: 0 } }
          : {}),
      }),
    );
    const relationships = new Map(
      objects.map((object) => [object.objectApiName, { dependents: 5, cascades: 2 }]),
    );
    const diff = { objects: moved, unread: [] };

    const take = takeEstimate({
      described: 300,
      objects: objects.map((object) => ({ records: object.records })),
      pageRows: 500,
    });
    const preview = diffEstimate({ objects, diff }).apiRequests;
    const rewind = rewindEstimate({ objects, diff, automationRequests: 20, relationships });
    const fromCli = rewindEstimate({
      objects,
      diff,
      automationRequests: 20,
      relationships,
      reusesPreview: true,
    });
    // Known to hang from nothing, no object's records wait for another's deletes.
    const placed = rewindEstimate({
      objects: objects.map((object, readOrder) => ({ ...object, readOrder, cascadeParents: [] })),
      diff,
      automationRequests: 20,
      relationships,
    });

    expect(take.apiRequests).toBeGreaterThan(200);
    expect(take.apiRequests).toBeLessThan(300);
    expect(preview).toBeGreaterThan(80);
    expect(preview).toBeLessThan(120);
    expect(rewind.apiRequests).toBeGreaterThan(300);
    expect(rewind.apiRequests).toBeLessThan(550);
    expect(placed.apiRequests).toBeLessThan(rewind.apiRequests);
    // From the command line: no fresh diff, and the 3 objects it brings
    // records back to described as it brings them back.
    expect(fromCli.apiRequests).toBe(rewind.apiRequests - preview + 3);
    expect(rewind.records).toBe(60 + 12 + 140);
  });
});

describe('undoEstimate', () => {
  const RELATIONSHIPS = new Map<string, ObjectRelationships>([
    ['Account', { dependents: 2, cascades: 1 }],
    ['Contact', { dependents: 0, cascades: 0 }],
  ]);

  it('counts the guard and the limits, the automation, the removal of what the rewind brought back, the bring back of what it deleted, the give-back and one verify by id of what it gave back', () => {
    const estimate = undoEstimate({
      objects: CHECKPOINT,
      rewound: [
        { objectApiName: 'Account', deleted: 4, broughtBack: 3, givenBack: 13 },
        { objectApiName: 'Contact', deleted: 450, broughtBack: 0, givenBack: 5 },
      ],
      automationRequests: 7,
      relationships: RELATIONSHIPS,
    });

    expect(estimate.apiRequests).toBe(
      4 +
        7 +
        // Back to the bin: the 3 accounts.
        (3 + (1 + 1 + 2 + 1)) +
        // Back from the bin: 4 accounts and 450 contacts, 4 batches of a bin
        // read, a live read and the undelete, no stamps said back.
        4 * 3 +
        // Values back, a chunk of accounts, a chunk of contacts: each its
        // clock, a read, an update, and the records read again.
        (1 + 1 + 1 + 1) +
        (1 + 1 + 1 + 1),
    );
    expect(estimate.records).toBe(20 + 455);
    expect(estimate.bytes).toBe(0);
  });

  it('sends nothing but the guard and the limits for a rewind that wrote nothing', () => {
    expect(
      undoEstimate({ objects: CHECKPOINT, rewound: [], automationRequests: 7 }).apiRequests,
    ).toBe(4);
  });
});

/** An org's limits, every request it is sent recorded. */
function limitsOrg(limits: unknown): LimitsTransport & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    request: async (request) => {
      asked.push(`${request.method} ${request.url}`);
      if (limits instanceof Error) throw limits;
      return limits;
    },
  };
}

describe('the budget gate', () => {
  const cost = { records: 472, apiRequests: 64, seconds: 36, bytes: 27_480 };

  it('refuses a rewind that would take more requests than the org has left today, having read nothing of it but its limits', async () => {
    const org = limitsOrg({ DailyApiRequests: { Max: 15_000, Remaining: 50 } });

    const gate = await budgetGate(org, 'rewind', 'DEV-SB', cost);

    expect(org.asked).toEqual(['GET /limits']);
    expect(gate).toEqual({
      estimate: { ...cost, apiRequestsLeft: 50 },
      refusal: {
        code: 'API_BUDGET',
        message:
          'This rewind takes about 64 API requests; DEV-SB has 50 of its 15000 left today. ' +
          'Rewind once the org has requests to spare — the limit is counted over the last 24 ' +
          'hours. No record was read or written.',
      },
    });
  });

  it('lets an act through that fits what the org has left, to the last request', async () => {
    const org = limitsOrg({ DailyApiRequests: { Max: 15_000, Remaining: 64 } });
    expect(await budgetGate(org, 'undo', 'DEV-SB', cost)).toEqual({
      estimate: { ...cost, apiRequestsLeft: 64 },
    });
  });

  it('says each act in its own words', () => {
    const budget = { max: 15_000, remaining: 10 };
    expect(budgetRefusal('take', 20, budget, 'DEV-SB')?.message).toBe(
      'This checkpoint takes about 20 API requests; DEV-SB has 10 of its 15000 left today. ' +
        'Take it once the org has requests to spare — the limit is counted over the last 24 ' +
        'hours — or pick fewer objects. No record was read.',
    );
    expect(budgetRefusal('undo', 20, budget, 'DEV-SB')?.message).toBe(
      'This undo takes about 20 API requests; DEV-SB has 10 of its 15000 left today. Undo the ' +
        'rewind once the org has requests to spare — the limit is counted over the last 24 ' +
        'hours — while the recycle bin still holds what it brings back. No record was read or ' +
        'written.',
    );
    expect(budgetRefusal('rewind', 10, budget, 'DEV-SB')).toBeUndefined();
  });

  it('runs no act on an org that will not say what it has left, and says which org', async () => {
    const refused = limitsOrg(new Error('INSUFFICIENT_ACCESS: no access to the limits'));
    await expect(budgetGate(refused, 'rewind', 'DEV-SB', cost)).rejects.toThrow(
      'DEV-SB did not say how many API requests it has left today: INSUFFICIENT_ACCESS: no access to the limits',
    );
    await expect(readBudget(limitsOrg({ DataStorageMB: {} }), 'DEV-SB')).rejects.toThrow(
      /^DEV-SB did not say how many API requests it has left today/,
    );
  });
});
