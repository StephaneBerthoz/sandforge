import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAX_STATEMENT_URI_CHARS, uriLength } from '../../core/common/wideRead';
import {
  BackupRecordStore,
  nodeBackupFiles,
  type BackupRecord,
} from '../dataops/BackupRecordStore';
import {
  SNAPSHOT_STAMPS,
  restoreAllowList,
  type CheckpointField,
} from '../checkpoint/checkpointFields';
import {
  defaultCheckpointLocksDir,
  openCheckpointStore,
  type CheckpointFolder,
} from '../checkpoint/OrgCheckpointStore';
import { SnapshotIndex, writeSnapshotIndex } from '../checkpoint/snapshotIndex';
import { MEMORY_ORG_USER, orgError } from '../../test/memoryRemovalOrg';
import { MemoryRestoreOrg } from '../../test/memoryRestoreOrg';
import { restoreOverwrites, type BackupReader } from './SyncRunRestore';

/*
 * The restore as a checkpoint's rewind calls it: the fields that may be
 * written back named, the records held to the moment the rewind read the org
 * on the org's own clock, its own writers named, and what each update writes
 * over kept before it goes. A Sync run's removal names none of these
 * (`SyncRunRestore.test.ts`).
 */

/** A fake id: the object's prefix and a counter, the length of a real one. */
const fakeId = (prefix: string, n: number): string => `${prefix}${String(n).padStart(12, '0')}AAA`;

const A1 = fakeId('001', 1);
const A2 = fakeId('001', 2);
const A3 = fakeId('001', 3);
const A4 = fakeId('001', 4);
const SNAPSHOT = 'op-1792700000000';

/** Another user of the org: a tester, an integration. */
const COLLEAGUE = '005000000000002AAA';
/** The org's Automated Process user, whose flows answer the rewind's writes. */
const AUTOMATED_PROCESS = '005000000000003AAA';

/** When the checkpoint was taken, and when the rewind read the org (Tr), on the org's clock. */
const TAKEN = Date.parse('2026-10-22T13:00:00.000Z');
const TR = Date.parse('2026-10-22T14:00:00.000Z');

/** Past this many characters in its URI, a statement is refused, as a scratch org refused one. */
const URI_REFUSED = 15_400;

/** An org whose clock a test moves, and whose queries it watches. */
function orgAt(start: number): {
  org: MemoryRestoreOrg;
  at: (ms: number) => void;
  sent: string[];
  beforeRead: { hook: (statement: string, place: number) => void };
} {
  let clock = start;
  const org = new MemoryRestoreOrg({}, { now: () => clock });
  const sent: string[] = [];
  const beforeRead = { hook: (_statement: string, _place: number): void => undefined };
  const query = org.query.bind(org);
  vi.spyOn(org, 'query').mockImplementation(async (soql, options) => {
    sent.push(soql);
    if (uriLength(soql) > URI_REFUSED) throw orgError('ERROR_HTTP_414', 'URI Too Long');
    beforeRead.hook(soql, sent.length);
    return query(soql, options);
  });
  return { org, at: (ms) => (clock = ms), sent, beforeRead };
}

/** A backup store holding, per object of the snapshot, the rows given. */
function backups(held: Record<string, Array<Record<string, unknown>>>): BackupReader {
  return {
    batches: async (operationId, objectApiName, size) => {
      const records = operationId === SNAPSHOT ? held[objectApiName] : undefined;
      if (!records) return null;
      return {
        async *[Symbol.asyncIterator]() {
          for (let at = 0; at < records.length; at += size) yield records.slice(at, at + size);
        },
      };
    },
  };
}

/** Accounts as the checkpoint held them: named `At the checkpoint <n>`. */
function checkpointRows(ids: readonly string[]): Array<Record<string, unknown>> {
  return ids.map((id, at) => ({ Id: id, Name: `At the checkpoint ${at + 1}` }));
}

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** A checkpoint's folder, made by its store, as a take makes it. */
async function folderOf(): Promise<CheckpointFolder> {
  const dir = mkdtempSync(join(tmpdir(), 'sandforge-rewind-restore-'));
  made.push(dir);
  const opened = openCheckpointStore({
    root: join(dir, 'checkpoints'),
    locksDir: defaultCheckpointLocksDir(join(dir, 'home')),
  });
  if (!('store' in opened)) throw new Error(`refused: ${opened.refusal.reason}`);
  return opened.store.create('00Dxx0000001234EAA', 'ck-20261022-130000-a1b2');
}

/** A field the user may create and edit. */
function writable(name: string, type = 'string'): CheckpointField {
  return { name, type, createable: true, updateable: true, nillable: true, permissionable: true };
}

/** A stamp no one writes, which field-level security cannot be set on. */
function stamp(name: string, type = 'datetime'): CheckpointField {
  return { name, type, createable: false, updateable: false, permissionable: false };
}

describe('restoreOverwrites, as a rewind gives a snapshot back', () => {
  it('reads and writes the fields that may be written back alone: a snapshot row’s attributes, stamps, a field deleted since and one hidden since reach neither the query nor the update', async () => {
    const { org, at, sent } = orgAt(TAKEN);
    org.add('Account', {
      Id: A1,
      Name: 'At the checkpoint',
      Phone: '+33 1 00 00 00 01',
      Score__c: 7,
    });
    // The snapshot, as the DataOps store bound to the checkpoint's folder
    // keeps it: the org's `attributes`, every stamp, the values.
    const kept = (await org.query('SELECT Id, SystemModstamp, CreatedDate FROM Account'))
      .records[0];
    const row: BackupRecord = {
      attributes: { type: 'Account', url: `/services/data/v66.0/sobjects/Account/${A1}` },
      Id: A1,
      SystemModstamp: kept.SystemModstamp,
      CreatedDate: kept.CreatedDate,
      CreatedById: MEMORY_ORG_USER,
      LastModifiedDate: kept.SystemModstamp,
      LastModifiedById: MEMORY_ORG_USER,
      Name: 'At the checkpoint',
      Phone: '+33 1 00 00 00 01',
      Region__c: 'North',
      Score__c: 7,
    };
    const folder = await folderOf();
    const store = new BackupRecordStore(nodeBackupFiles(folder.dir));
    await store.begin(SNAPSHOT, 'Account');
    await store.append(SNAPSHOT, 'Account', [row]);
    await writeSnapshotIndex(folder, SNAPSHOT, 'Account');
    const index = await SnapshotIndex.read(folder, SNAPSHOT, 'Account');
    // Since: Region__c deleted, Score__c hidden from the user by field-level
    // security, and the account changed before the rewind began.
    const { fields } = await restoreAllowList({
      objectApiName: 'Account',
      snapshotFields: [...SNAPSHOT_STAMPS, 'Name', 'Phone', 'Region__c', 'Score__c'],
      described: {
        name: 'Account',
        fields: [
          stamp('Id', 'id'),
          ...SNAPSHOT_STAMPS.slice(1).map((name) => stamp(name)),
          writable('Name'),
          writable('Phone', 'phone'),
          { name: 'Score__c', type: 'double', createable: false, updateable: false },
        ],
      },
      ignoredFields: [],
      viewsEncryptedData: true,
    });
    expect(fields).toEqual(['Name', 'Phone']);
    at(TAKEN + 30 * 60_000);
    org.edit('Account', A1, { Name: 'Changed since', Phone: null, Score__c: 9 }, COLLEAGUE);
    sent.length = 0;
    at(TR + 60_000);

    const outcome = await restoreOverwrites({
      org,
      plan: [{ objectApiName: 'Account', backup: SNAPSHOT, ids: [A1] }],
      backups: index.chunk([A1]),
      fields: { Account: fields },
      changedAfter: new Date(TR).toISOString(),
      includeChanged: false,
    });

    expect(outcome.objects[0]).toMatchObject({ planned: 1, restored: 1, refused: 0, notKept: 0 });
    expect(sent).toEqual([
      `SELECT Id, LastModifiedDate, Name, Phone FROM Account WHERE Id IN ('${A1}')`,
    ]);
    expect(org.updates.map(({ records }) => records)).toEqual([
      [{ Id: A1, Name: 'At the checkpoint', Phone: '+33 1 00 00 00 01' }],
    ]);
    expect(org.all('Account')[0]).toMatchObject({ Score__c: 9 });
  });

  it('counts not kept, and names why, the records whose kept values hold no field that may be written back, and asks the org nothing of them', async () => {
    const { org, sent } = orgAt(TR);
    org.add('Account', { Id: A1, Name: 'Changed since' });
    org.add('Account', { Id: A2, Name: 'Changed since' });

    const outcome = await restoreOverwrites({
      org,
      plan: [{ objectApiName: 'Account', backup: SNAPSHOT, ids: [A1, A2] }],
      backups: backups({
        Account: checkpointRows([A1, A2]).map((row) => ({
          ...row,
          attributes: { type: 'Account' },
          SystemModstamp: '2026-10-22T13:00:00.000+0000',
        })),
      }),
      // The allow-list names Contact's fields only: none of Account's may be written.
      fields: { Contact: ['LastName'] },
      changedAfter: new Date(TR).toISOString(),
      includeChanged: false,
    });

    expect(outcome.objects[0]).toMatchObject({ planned: 2, restored: 0, notKept: 2 });
    expect(outcome.objects[0].reasons).toEqual([
      '2 Account record(s) hold no value of a field that may be written back now: left as they are',
    ]);
    expect(sent).toEqual([]);
    expect(org.updates).toEqual([]);
    expect(outcome.wrote).toBe(false);
  });

  it('holds the records to the moment it read the org, by the org’s clock, and gives back what its own user and the org’s automation changed since, never what someone else did', async () => {
    const { org, at } = orgAt(TAKEN);
    for (const id of [A1, A2, A3, A4]) org.add('Account', { Id: id, Name: 'After' });
    at(TAKEN + 30 * 60_000);
    org.edit('Account', A1, { Name: 'A colleague’s, before the rewind' }, COLLEAGUE);
    at(TR + 5_000);
    org.edit('Account', A2, { Name: 'A colleague’s, during the rewind' }, COLLEAGUE);
    at(TR + 10_000);
    org.edit('Account', A3, { Name: 'The rewind’s own first pass' }, MEMORY_ORG_USER);
    at(TR + 20_000);
    org.edit('Account', A4, { Name: 'A flow answering it' }, AUTOMATED_PROCESS);
    at(TR + 60_000);

    const outcome = await restoreOverwrites({
      org,
      plan: [{ objectApiName: 'Account', backup: SNAPSHOT, ids: [A1, A2, A3, A4] }],
      backups: backups({ Account: checkpointRows([A1, A2, A3, A4]) }),
      fields: { Account: ['Name'] },
      changedAfter: new Date(TR).toISOString(),
      ownWriters: [MEMORY_ORG_USER.slice(0, 15), AUTOMATED_PROCESS],
      includeChanged: false,
    });

    expect(outcome.objects[0]).toMatchObject({ planned: 4, restored: 3, keptChanged: 1 });
    expect(outcome.left).toEqual([A2]);
    expect(org.all('Account').map((row) => row.Name)).toEqual([
      'At the checkpoint 1',
      'A colleague’s, during the rewind',
      'At the checkpoint 3',
      'At the checkpoint 4',
    ]);
  });

  it('leaves what its own user changed since as anyone’s when it is not told its own writers', async () => {
    const { org, at } = orgAt(TAKEN);
    org.add('Account', { Id: A1, Name: 'After' });
    at(TR + 10_000);
    org.edit('Account', A1, { Name: 'The rewind’s own first pass' }, MEMORY_ORG_USER);

    const outcome = await restoreOverwrites({
      org,
      plan: [{ objectApiName: 'Account', backup: SNAPSHOT, ids: [A1] }],
      backups: backups({ Account: checkpointRows([A1]) }),
      fields: { Account: ['Name'] },
      changedAfter: new Date(TR).toISOString(),
      includeChanged: false,
    });

    expect(outcome.objects[0]).toMatchObject({ restored: 0, keptChanged: 1 });
    expect(org.updates).toEqual([]);
  });

  it('takes the moment as the org’s own date, whatever this machine’s clock says, and asks the org for no clock of its own', async () => {
    // The org's clock an hour ahead of this machine's: a date of this
    // machine's, read on the org's, would move by that hour.
    const ahead = 3_600_000;
    let clock = Date.now() + ahead;
    const org = new MemoryRestoreOrg({}, { now: () => clock });
    org.add('Account', { Id: A1, Name: 'After' }, new Date(clock - 60 * 60_000).toISOString());
    const tr = clock;
    clock = tr + 30_000;
    org.edit('Account', A1, { Name: 'A colleague’s, during the rewind' }, COLLEAGUE);

    const outcome = await restoreOverwrites({
      org,
      plan: [{ objectApiName: 'Account', backup: SNAPSHOT, ids: [A1] }],
      backups: backups({ Account: checkpointRows([A1]) }),
      fields: { Account: ['Name'] },
      changedAfter: new Date(tr).toISOString(),
      ownWriters: [MEMORY_ORG_USER],
      includeChanged: false,
    });

    expect(outcome.objects[0]).toMatchObject({ restored: 0, keptChanged: 1 });
    expect(org.all('Account')[0].Name).toBe('A colleague’s, during the rewind');
    expect(org.soapCalls).toBe(0);
  });

  it('takes a change the org dates within the second the moment falls in for one made after it, and one dated the second before for one made before', async () => {
    // Read at :00.700; the org dates a write to its second, truncated.
    const tr = TR + 700;
    const { org, at } = orgAt(TAKEN);
    org.add('Account', { Id: A1, Name: 'After' });
    org.add('Account', { Id: A2, Name: 'After' });
    at(TR - 100);
    org.edit('Account', A1, { Name: 'A colleague’s, just before' }, COLLEAGUE);
    at(TR + 300);
    org.edit('Account', A2, { Name: 'A colleague’s, in the same second' }, COLLEAGUE);
    at(TR + 60_000);

    const outcome = await restoreOverwrites({
      org,
      plan: [{ objectApiName: 'Account', backup: SNAPSHOT, ids: [A1, A2] }],
      backups: backups({ Account: checkpointRows([A1, A2]) }),
      fields: { Account: ['Name'] },
      changedAfter: new Date(tr).toISOString(),
      includeChanged: false,
    });

    expect(org.all('Account').map((row) => row.LastModifiedDate)).toEqual([
      expect.any(String),
      '2026-10-22T14:00:00.000Z',
    ]);
    expect(outcome.objects[0]).toMatchObject({ restored: 1, keptChanged: 1 });
    expect(outcome.left).toEqual([A2]);
    expect(org.all('Account').map((row) => row.Name)).toEqual([
      'At the checkpoint 1',
      'A colleague’s, in the same second',
    ]);
  });

  it('gives back a record too wide for one statement, read in column groups that each fit', async () => {
    const custom = Array.from(
      { length: 900 },
      (_, i) => `Customer_Field_${String(i).padStart(4, '0')}__c`,
    );
    const { org, at, sent } = orgAt(TAKEN);
    org.add('Account', {
      Id: A1,
      Name: 'After',
      ...Object.fromEntries(custom.map((field) => [field, 'after'])),
    });
    at(TR + 60_000);

    const outcome = await restoreOverwrites({
      org,
      plan: [{ objectApiName: 'Account', backup: SNAPSHOT, ids: [A1] }],
      backups: backups({
        Account: [
          {
            Id: A1,
            Name: 'At the checkpoint',
            ...Object.fromEntries(custom.map((field) => [field, 'checkpoint'])),
          },
        ],
      }),
      fields: { Account: ['Name', ...custom] },
      changedAfter: new Date(TR).toISOString(),
      includeChanged: false,
    });

    expect(outcome.objects[0]).toMatchObject({ planned: 1, restored: 1, refused: 0 });
    expect(sent.length).toBeGreaterThan(1);
    for (const statement of sent) {
      expect(uriLength(statement)).toBeLessThanOrEqual(MAX_STATEMENT_URI_CHARS);
    }
    expect(Object.keys(org.updates[0].records[0])).toHaveLength(1 + 1 + custom.length);
    expect(org.all('Account')[0]['Customer_Field_0899__c']).toBe('checkpoint');
  });

  it('holds a wide record to one write: a colleague’s change saved between two of its column groups is left as they made it, not written over', async () => {
    const custom = Array.from(
      { length: 900 },
      (_, i) => `Customer_Field_${String(i).padStart(4, '0')}__c`,
    );
    const { org, at, beforeRead } = orgAt(TAKEN);
    org.add('Account', {
      Id: A1,
      Name: 'After',
      ...Object.fromEntries(custom.map((field) => [field, 'after'])),
    });
    at(TR + 60_000);
    // The first group read, the colleague saves the record before the next.
    beforeRead.hook = (_statement, place) => {
      if (place !== 2) return;
      at(TR + 61_000);
      org.edit('Account', A1, { Customer_Field_0899__c: 'the colleague’s' }, COLLEAGUE);
    };

    const outcome = await restoreOverwrites({
      org,
      plan: [{ objectApiName: 'Account', backup: SNAPSHOT, ids: [A1] }],
      backups: backups({
        Account: [
          {
            Id: A1,
            Name: 'At the checkpoint',
            ...Object.fromEntries(custom.map((field) => [field, 'checkpoint'])),
          },
        ],
      }),
      fields: { Account: ['Name', ...custom] },
      changedAfter: new Date(TR).toISOString(),
      includeChanged: false,
    });

    expect(outcome.objects[0]).toMatchObject({ restored: 0, keptChanged: 1 });
    expect(org.updates).toEqual([]);
    expect(org.all('Account')[0]).toMatchObject({
      Name: 'After',
      Customer_Field_0899__c: 'the colleague’s',
    });
  });
});

describe('restoreOverwrites, keeping what it writes over', () => {
  it('keeps, before each update is sent, what its records hold of the fields it writes, read just before, and nothing of a record it does not write', async () => {
    const { org, at } = orgAt(TAKEN);
    org.add('Account', { Id: A1, Name: 'After 1', Phone: '+33 1 00 00 00 09' });
    org.add('Account', { Id: A2, Name: 'At the checkpoint 2', Phone: null });
    org.add('Account', { Id: A3, Name: 'After 3', Phone: null });
    at(TR + 60_000);
    const kept: Array<{ object: string; records: unknown[]; updatesSent: number }> = [];

    const outcome = await restoreOverwrites({
      org,
      plan: [{ objectApiName: 'Account', backup: SNAPSHOT, ids: [A1, A2, A3] }],
      backups: backups({
        Account: [
          { Id: A1, Name: 'At the checkpoint 1', Phone: null },
          { Id: A2, Name: 'At the checkpoint 2', Phone: null },
          { Id: A3, Name: 'At the checkpoint 3', Phone: null },
        ],
      }),
      fields: { Account: ['Name', 'Phone'] },
      changedAfter: new Date(TR).toISOString(),
      includeChanged: false,
      keep: async (object, records) => {
        kept.push({ object, records: [...records], updatesSent: org.updates.length });
      },
    });

    expect(outcome.objects[0]).toMatchObject({ restored: 3, refused: 0 });
    expect(kept).toEqual([
      {
        object: 'Account',
        records: [
          { Id: A1, Name: 'After 1', Phone: '+33 1 00 00 00 09' },
          { Id: A3, Name: 'After 3' },
        ],
        updatesSent: 0,
      },
    ]);
    expect(org.updates.map(({ records }) => records)).toEqual([
      [
        { Id: A1, Name: 'At the checkpoint 1', Phone: null },
        { Id: A3, Name: 'At the checkpoint 3' },
      ],
    ]);
  });

  it('sends no update whose values could not be kept, counts its records refused with why, and tries the next', async () => {
    const ids = Array.from({ length: 250 }, (_, n) => fakeId('001', n + 1));
    const { org, at } = orgAt(TAKEN);
    for (const id of ids) org.add('Account', { Id: id, Name: 'After' });
    at(TR + 60_000);
    let calls = 0;

    const outcome = await restoreOverwrites({
      org,
      plan: [{ objectApiName: 'Account', backup: SNAPSHOT, ids }],
      backups: backups({ Account: checkpointRows(ids) }),
      fields: { Account: ['Name'] },
      changedAfter: new Date(TR).toISOString(),
      includeChanged: false,
      keep: async () => {
        calls += 1;
        if (calls === 1) throw new Error('ENOSPC: no space left on device');
      },
    });

    expect(calls).toBe(2);
    expect(outcome.objects[0]).toMatchObject({ planned: 250, restored: 50, refused: 200 });
    expect(outcome.objects[0].reasons).toEqual([
      'What these 200 Account record(s) hold now could not be kept before they were written ' +
        '(ENOSPC: no space left on device), so none of them was written: nothing is written ' +
        'over that cannot be put back.',
    ]);
    expect(outcome.left).toEqual(ids.slice(0, 200));
    expect(org.updates).toHaveLength(1);
    expect(org.updates[0].records.map((record) => record.Id)).toEqual(ids.slice(200));
    expect(org.all('Account').filter((row) => row.Name === 'After')).toHaveLength(200);
    expect(outcome.wrote).toBe(true);
  });

  it('keeps a record once when it is sent again without a field the org no longer takes', async () => {
    const { org, at } = orgAt(TAKEN);
    org.add('Account', { Id: A1, Name: 'After', Industry: 'Energy' });
    org.refuseValue.set('Industry', {
      value: 'Retired',
      statusCode: 'INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST',
      message: 'bad value for restricted picklist field: Retired',
    });
    at(TR + 60_000);
    const kept: unknown[][] = [];

    const outcome = await restoreOverwrites({
      org,
      plan: [{ objectApiName: 'Account', backup: SNAPSHOT, ids: [A1] }],
      backups: backups({ Account: [{ Id: A1, Name: 'At the checkpoint', Industry: 'Retired' }] }),
      fields: { Account: ['Name', 'Industry'] },
      changedAfter: new Date(TR).toISOString(),
      includeChanged: false,
      keep: async (_object, records) => {
        kept.push([...records]);
      },
    });

    expect(outcome.objects[0]).toMatchObject({ restoredWithout: 1, refused: 0 });
    expect(org.updates).toHaveLength(2);
    expect(kept).toEqual([[{ Id: A1, Name: 'After', Industry: 'Energy' }]]);
  });
});
