import { describe, it, expect, beforeEach } from 'vitest';
import { restoreOverwrites, sameValue, type BackupReader } from './SyncRunRestore';
import { MemoryRestoreOrg } from '../../test/memoryRestoreOrg';

/** A fake id: the object's prefix and a counter, the length of a real one. */
const fakeId = (prefix: string, n: number): string => `${prefix}${String(n).padStart(12, '0')}AAA`;

const A1 = fakeId('001', 1);
const A2 = fakeId('001', 2);
const A3 = fakeId('001', 3);
const BACKUP = 'sync-before-run-1';

/** Minutes before now. */
const minutesAgo = (minutes: number): string =>
  new Date(Date.now() - minutes * 60_000).toISOString();

/** A backup store holding, per object of one backup, the records given. */
function backups(held: Record<string, Array<Record<string, unknown>>>): BackupReader {
  return {
    batches: async (operationId, objectApiName, size) => {
      const records = operationId === BACKUP ? held[objectApiName] : undefined;
      if (!records) return null;
      return {
        async *[Symbol.asyncIterator]() {
          for (let at = 0; at < records.length; at += size) yield records.slice(at, at + size);
        },
      };
    },
  };
}

/** The target once a run ten minutes ago wrote over three accounts. */
function target(): MemoryRestoreOrg {
  const org = new MemoryRestoreOrg();
  const at = minutesAgo(10);
  org.add('Account', { Id: A1, Name: 'After 1', Description: 'run', Phone: null }, at);
  org.add('Account', { Id: A2, Name: 'After 2', Description: 'run', Phone: null }, at);
  org.add('Account', { Id: A3, Name: 'After 3', Description: 'run', Phone: null }, at);
  return org;
}

/** What the run kept of them before it wrote: their names and descriptions, A1's phone. */
const BEFORE = {
  Account: [
    { Id: A1, Name: 'Before 1', Description: 'before', Phone: '+33 1 00 00 00 01' },
    { Id: A2, Name: 'Before 2', Description: null },
    { Id: A3, Name: 'Before 3', Description: 'before' },
  ],
};

const PLAN = [{ objectApiName: 'Account', backup: BACKUP, ids: [A1, A2, A3] }];

describe('restoreOverwrites', () => {
  let org: MemoryRestoreOrg;

  beforeEach(() => {
    org = target();
  });

  it('gives each record the values it held before the run, writing only the fields that differ', async () => {
    const outcome = await restoreOverwrites({
      org,
      plan: PLAN,
      backups: backups(BEFORE),
      lastWriteAt: minutesAgo(10),
      includeChanged: false,
    });

    expect(outcome.objects).toEqual([
      {
        objectApiName: 'Account',
        planned: 3,
        restored: 3,
        keptChanged: 0,
        alreadyGone: 0,
        refused: 0,
        notKept: 0,
        reasons: [],
      },
    ]);
    expect(outcome.left).toEqual([]);
    expect(outcome.wrote).toBe(true);
    const byId = new Map(org.all('Account').map((row) => [row.Id, row]));
    expect(byId.get(A1)).toMatchObject({
      Name: 'Before 1',
      Description: 'before',
      Phone: '+33 1 00 00 00 01',
    });
    expect(byId.get(A2)).toMatchObject({ Name: 'Before 2', Description: null });
    expect(byId.get(A3)).toMatchObject({ Name: 'Before 3', Description: 'before' });
    // A field the run did not write is not sent: A2 and A3 kept no phone.
    expect(org.updates[0].records.find((record) => record.Id === A3)).toEqual({
      Id: A3,
      Name: 'Before 3',
      Description: 'before',
    });
  });

  it('leaves a record changed since the run as it is, unless the changed ones are included', async () => {
    org.touch('Account', A2, new Date(Date.now() + 60_000).toISOString());

    const left = await restoreOverwrites({
      org,
      plan: PLAN,
      backups: backups(BEFORE),
      lastWriteAt: minutesAgo(10),
      includeChanged: false,
    });
    expect(left.objects[0]).toMatchObject({ restored: 2, keptChanged: 1 });
    expect(left.left).toEqual([A2]);
    expect(org.all('Account').find((row) => row.Id === A2)).toMatchObject({ Name: 'After 2' });

    const included = await restoreOverwrites({
      org,
      plan: [{ objectApiName: 'Account', backup: BACKUP, ids: [A2] }],
      backups: backups(BEFORE),
      lastWriteAt: minutesAgo(10),
      includeChanged: true,
    });
    expect(included.objects[0]).toMatchObject({ restored: 1, keptChanged: 0 });
    expect(org.all('Account').find((row) => row.Id === A2)).toMatchObject({ Name: 'Before 2' });
  });

  it('writes nothing to a record that holds its values from before already', async () => {
    const outcome = await restoreOverwrites({
      org,
      plan: [{ objectApiName: 'Account', backup: BACKUP, ids: [A1] }],
      backups: backups({ Account: [{ Id: A1, Name: 'After 1', Description: 'run' }] }),
      lastWriteAt: minutesAgo(10),
      includeChanged: false,
    });

    expect(outcome.objects[0]).toMatchObject({ planned: 1, restored: 1 });
    expect(org.updates).toEqual([]);
    expect(outcome.wrote).toBe(false);
  });

  it('counts apart a record gone from the target, one whose values are no longer kept, and one the target refuses', async () => {
    org.refuseUpdate.set(A3, {
      statusCode: 'FIELD_CUSTOM_VALIDATION_EXCEPTION',
      message: 'Name is locked',
    });
    await org.destroy('Account', [A1]);

    const outcome = await restoreOverwrites({
      org,
      plan: PLAN,
      backups: backups({ Account: BEFORE.Account.filter((record) => record.Id !== A2) }),
      lastWriteAt: minutesAgo(10),
      includeChanged: false,
    });

    expect(outcome.objects[0]).toMatchObject({
      planned: 3,
      restored: 0,
      alreadyGone: 1,
      notKept: 1,
      refused: 1,
      reasons: ['FIELD_CUSTOM_VALIDATION_EXCEPTION: Name is locked'],
    });
    // Only the refused one can be offered again: the others never can be.
    expect(outcome.left).toEqual([A3]);
  });

  it('counts every record not kept when the backup is gone, and asks the org nothing of them', async () => {
    const outcome = await restoreOverwrites({
      org,
      plan: PLAN,
      backups: backups({}),
      lastWriteAt: minutesAgo(10),
      includeChanged: false,
    });

    expect(outcome.objects[0]).toMatchObject({ planned: 3, notKept: 3, restored: 0 });
    expect(outcome.left).toEqual([]);
    expect(org.updates).toEqual([]);
  });

  it('stops before its next call to the org, the rest offered again', async () => {
    const stop = new AbortController();
    stop.abort();

    const outcome = await restoreOverwrites({
      org,
      plan: PLAN,
      backups: backups(BEFORE),
      lastWriteAt: minutesAgo(10),
      includeChanged: false,
      signal: stop.signal,
    });

    expect(outcome.cancelled).toBe(true);
    expect(outcome.objects[0]).toMatchObject({ planned: 3, notReached: 3 });
    expect(outcome.left).toEqual([A1, A2, A3]);
    expect(org.updates).toEqual([]);
  });

  it('takes a record for changed since when the run says nothing of when it last wrote', async () => {
    const outcome = await restoreOverwrites({
      org,
      plan: PLAN,
      backups: backups(BEFORE),
      includeChanged: false,
    });

    expect(outcome.objects[0]).toMatchObject({ keptChanged: 3, restored: 0 });
  });
});

describe('sameValue', () => {
  it('reads nothing and an empty text alike, a number whatever its form, a date whatever its zone', () => {
    expect(sameValue(null, '')).toBe(true);
    expect(sameValue(undefined, null)).toBe(true);
    expect(sameValue('a', null)).toBe(false);
    expect(sameValue(3, '3.0')).toBe(true);
    expect(sameValue('2026-10-22T08:00:00.000+0000', '2026-10-22T08:00:00Z')).toBe(true);
    expect(sameValue('2026-10-22T08:00:00.000+0000', '2026-10-22T08:00:01Z')).toBe(false);
    expect(sameValue('Before', 'before')).toBe(false);
    expect(sameValue(true, true)).toBe(true);
    expect(sameValue(true, false)).toBe(false);
  });
});
