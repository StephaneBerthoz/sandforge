import { describe, expect, it, vi } from 'vitest';
import type { ForgeRunObjectRecords } from '@sandforge/shared';
import {
  removeRunRecords,
  type RemovalOrg,
  type RemovalPreviewObject,
  type RunRemovalOptions,
} from './ForgeRunRemoval.js';
import { MEMORY_ORG_USER, MemoryRemovalOrg } from '../../test/memoryRemovalOrg.js';

vi.mock('../../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

/*
 * The removal asked for a preview alone: it reads the run's records as it
 * reads them before its first write, says per object what it would delete,
 * keep, leave and not find, and stops there. An environment's plan reads
 * every applied run this way, so a preview that wrote anything would write
 * on every plan.
 */

/** A fake id: the object's prefix and a counter, the length of a real one. */
const fakeId = (prefix: string, n: number): string => `${prefix}${String(n).padStart(12, '0')}AAA`;

/** Minutes before now, as the org dates a record. */
const minutesAgo = (minutes: number): string =>
  new Date(Date.now() - minutes * 60_000).toISOString();

const ACCOUNTS = Array.from({ length: 3 }, (_, n) => fakeId('001', n));
const CONTACTS = Array.from({ length: 5 }, (_, n) => fakeId('003', n));
/** Someone else working in the org. */
const COLLEAGUE = fakeId('005', 2);

/** What the run created, children first, the last written first. */
const PLAN: ForgeRunObjectRecords[] = [
  { objectApiName: 'Contact', ids: [...CONTACTS].reverse() },
  { objectApiName: 'Account', ids: [...ACCOUNTS].reverse() },
];

/** The run's span on the org's clock: it wrote ten minutes ago. */
const SPAN = {
  runStartedAt: new Date(Date.now() - 11 * 60_000),
  runEndedAt: new Date(Date.now() - 9 * 60_000),
};

/**
 * The target as the run left it ten minutes ago, since when a colleague
 * changed a contact, a contact went to the recycle bin, another was deleted
 * and its bin emptied, which a read still finds deleted (P11), and a third
 * was purged from the bin for good, which no read finds.
 */
function target(): MemoryRemovalOrg {
  const org = new MemoryRemovalOrg({
    Account: [{ childSObject: 'Contact', field: 'AccountId', cascadeDelete: false }],
  });
  const at = minutesAgo(10);
  for (const id of ACCOUNTS) org.add('Account', { Id: id }, at);
  CONTACTS.forEach((id, n) => org.add('Contact', { Id: id, AccountId: ACCOUNTS[n % 3] }, at));
  org.add('User', { Id: COLLEAGUE, Name: 'A colleague' }, minutesAgo(600));
  org.edit('Contact', CONTACTS[0], { Title: 'Changed since' }, COLLEAGUE);
  org.trash('Contact', CONTACTS[1]);
  org.trash('Contact', CONTACTS[2]);
  org.empty(CONTACTS[2]);
  org.trash('Contact', CONTACTS[3]);
  org.purge(CONTACTS[3]);
  return org;
}

/**
 * `org` with every write it could be asked for thrown: a delete, a delete
 * job, an update — the status a removal sets back to Draft and gives back.
 */
function readOnly(org: MemoryRemovalOrg) {
  const refused = (): never => {
    throw new Error('a preview wrote to the org');
  };
  const writes = {
    destroy: vi.fn(refused),
    bulkDestroy: vi.fn(refused),
    update: vi.fn(refused),
  };
  const session: RemovalOrg = {
    query: (soql) => org.query(soql),
    queryDeleted: (soql) => org.queryDeleted(soql),
    describe: (objectApiName) => org.describe(objectApiName),
    describeGlobal: () => org.describeGlobal(),
    serverTime: () => org.serverTime(),
    userId: () => org.userId(),
    ...writes,
  };
  return { session, writes };
}

/** The preview of each object, by its name. */
function byObject(objects: readonly RemovalPreviewObject[]): Record<string, RemovalPreviewObject> {
  return Object.fromEntries(objects.map((object) => [object.objectApiName, object]));
}

describe('a removal asked for a preview alone', () => {
  it('says per object what it would delete, keep, leave and not find, and calls no write of the org', async () => {
    const org = target();
    const { session, writes } = readOnly(org);
    const sweep = vi.fn(async () => true);
    const onUndeletable = vi.fn(async () => true);
    const options: RunRemovalOptions = {
      ...SPAN,
      includeChanged: false,
      previewOnly: true,
      sweep,
      onUndeletable,
    };

    const outcome = await removeRunRecords(session, PLAN, options);

    expect(writes.destroy).not.toHaveBeenCalled();
    expect(writes.bulkDestroy).not.toHaveBeenCalled();
    expect(writes.update).not.toHaveBeenCalled();
    expect(sweep).not.toHaveBeenCalled();
    expect(onUndeletable).not.toHaveBeenCalled();
    expect(org.deletes).toEqual([]);
    expect(org.all('Contact').map((row) => row.Id)).toEqual([CONTACTS[0], CONTACTS[4]]);
    expect(org.all('Account').map((row) => row.Id)).toEqual(ACCOUNTS);

    expect(outcome).toMatchObject({ objects: [], cancelled: false, gone: [], stamps: {} });
    expect(outcome.span).toBeUndefined();
    // Children before their parents, as the removal would take them.
    expect(outcome.preview?.objects.map((object) => object.objectApiName)).toEqual([
      'Contact',
      'Account',
    ]);
    const preview = byObject(outcome.preview?.objects ?? []);
    expect(preview.Contact).toMatchObject({
      planned: 5,
      toDelete: 1,
      // In the bin, and emptied from it: no read tells them apart.
      alreadyGone: 2,
      changedSince: 1,
      keptChanged: 1,
      changedBy: { [COLLEAGUE]: 1 },
      undeletable: 0,
      notVisible: 1,
      unread: 0,
    });
    expect(preview.Contact?.reasons).toEqual([expect.stringMatching(/^Not visible: 1 record/)]);
    expect(preview.Account).toMatchObject({ planned: 3, toDelete: 3, changedSince: 0 });
    expect(outcome.preview?.userNames).toEqual({ [COLLEAGUE]: 'A colleague' });

    // Every record handed over is left, for the removal that follows.
    const left: string[] = [];
    for await (const { ids } of outcome.left()) left.push(...ids);
    expect(left.sort()).toEqual([...CONTACTS, ...ACCOUNTS].sort());
  });

  it('counts what the removal then deletes, keeps and finds gone, record for record', async () => {
    const org = target();

    const previewed = await removeRunRecords(org, PLAN, {
      ...SPAN,
      includeChanged: false,
      previewOnly: true,
    });
    const removed = await removeRunRecords(org, PLAN, { ...SPAN, includeChanged: false });

    const preview = byObject(previewed.preview?.objects ?? []);
    for (const object of removed.objects) {
      const said = preview[object.objectApiName];
      expect(said?.toDelete, object.objectApiName).toBe(object.deleted);
      expect(said?.keptChanged, object.objectApiName).toBe(object.keptChanged);
      expect(said?.alreadyGone, object.objectApiName).toBe(object.alreadyGone);
      expect(said?.notVisible ?? 0, object.objectApiName).toBe(object.notVisible ?? 0);
    }
  });

  it('counts the records changed since to delete when they are included, and still names who changed them', async () => {
    const org = target();

    const outcome = await removeRunRecords(org, PLAN, {
      ...SPAN,
      includeChanged: true,
      previewOnly: true,
    });

    expect(byObject(outcome.preview?.objects ?? []).Contact).toMatchObject({
      toDelete: 2,
      changedSince: 1,
      keptChanged: 0,
      changedBy: { [COLLEAGUE]: 1 },
    });
    expect(org.deletes).toEqual([]);
  });

  it('names the objects the user may not delete without asking, and leaves their records', async () => {
    const org = target();
    org.undeletable.add('Account');
    const onUndeletable = vi.fn(async () => false);

    const outcome = await removeRunRecords(org, PLAN, {
      ...SPAN,
      includeChanged: false,
      previewOnly: true,
      onUndeletable,
    });

    expect(onUndeletable).not.toHaveBeenCalled();
    expect(outcome.undeletable).toEqual([{ objectApiName: 'Account', records: 3 }]);
    expect(outcome.stoppedForUndeletable).toBeUndefined();
    const account = byObject(outcome.preview?.objects ?? []).Account;
    expect(account).toMatchObject({ planned: 3, toDelete: 0, undeletable: 3 });
    expect(account?.reasons).toEqual([
      expect.stringContaining('may not delete Account records in this org'),
    ]);
  });

  it('counts the records of an object it cannot read as unread, with the org’s words', async () => {
    const org = target();
    org.refuseRead.set('Account', {
      errorCode: 'INSUFFICIENT_ACCESS',
      message: 'The user may not read Account.',
    });

    const outcome = await removeRunRecords(org, PLAN, {
      ...SPAN,
      includeChanged: false,
      previewOnly: true,
    });

    expect(byObject(outcome.preview?.objects ?? []).Account).toMatchObject({
      planned: 3,
      toDelete: 0,
      unread: 3,
      reasons: ['INSUFFICIENT_ACCESS: The user may not read Account.'],
    });
  });

  it('names its own user too when the records were changed by the user it runs as', async () => {
    const org = target();
    org.edit('Account', ACCOUNTS[1], { Name: 'Renamed' }, MEMORY_ORG_USER);

    const outcome = await removeRunRecords(org, PLAN, {
      ...SPAN,
      includeChanged: false,
      previewOnly: true,
    });

    expect(byObject(outcome.preview?.objects ?? []).Account).toMatchObject({
      keptChanged: 1,
      changedBy: { [MEMORY_ORG_USER]: 1 },
    });
    // The org holds no user record for it: it stays named by its Id.
    expect(outcome.preview?.userNames).toEqual({ [COLLEAGUE]: 'A colleague' });
  });

  it('stops before it reads anything once stopped, and says nothing of what it would do', async () => {
    const org = target();
    const stop = new AbortController();
    stop.abort();

    const outcome = await removeRunRecords(org, PLAN, {
      ...SPAN,
      includeChanged: false,
      previewOnly: true,
      signal: stop.signal,
    });

    expect(outcome.cancelled).toBe(true);
    expect(outcome.preview).toBeUndefined();
    expect(org.deletes).toEqual([]);
  });
});
