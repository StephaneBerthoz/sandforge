import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { DataOpsHandler } from './DataOpsHandler.js';
import type { HandlerDeps } from './HandlerTypes.js';
import { getJsforceConnection } from '../../core/connection/ConnectionHelper.js';
import { ConfigStore } from '../../core/storage/ConfigStore.js';
import { BackupRecordStore, nodeBackupFiles } from '../../modules/dataops/BackupRecordStore.js';
import { InMemoryConfigStoreBackend } from '../../test/InMemoryConfigStoreBackend.js';
import { MemoryRemovalOrg, factCombinations, orgStamp } from '../../test/memoryRemovalOrg.js';

vi.mock('../../core/connection/ConnectionHelper.js', () => ({
  getJsforceConnection: vi.fn(),
}));

/*
 * The snapshot a checkpoint holds, read through the flow DataOps' Backup
 * runs, by a handler bound to the checkpoint's own folder. A rewind compares
 * every value the snapshot holds with the org's, deletes what it does not
 * hold as created since, and brings back what it holds and the org lost: the
 * snapshot reads the fields the checkpoint keeps, reads Tasks and Events with
 * the ones Salesforce archives, holds each row as one write left it, and
 * holds every row of its objects or is not kept at all.
 */

/** When the snapshot is read, on the org's clock. */
const READ_AT = Date.parse('2026-10-22T10:00:00.000Z');

/** The `n`-th account of the fake org. */
function accountId(n: number): string {
  return `001${String(n).padStart(12, '0')}AAA`;
}

/** The `n`-th task of the fake org. */
function taskId(n: number): string {
  return `00T${String(n).padStart(12, '0')}AAA`;
}

/** `count` custom fields, named as long as an org's usually are: too many for one query. */
function customFields(count: number): string[] {
  return Array.from({ length: count }, (_, i) => `Customer_Field_${String(i).padStart(4, '0')}__c`);
}

/** The fields a checkpoint keeps of a wide object: its stamps, then its values. */
const WIDE_FIELDS = ['Id', 'SystemModstamp', 'Name', ...customFields(400)];

interface Harness {
  handler: DataOpsHandler;
  config: ConfigStore;
  /** The checkpoint's folder the handler writes the snapshot's files under. */
  folder: string;
}

const folders: string[] = [];

afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
  vi.mocked(getJsforceConnection).mockReset();
});

/**
 * A handler bound to a folder of its own, over an in-memory config store, as
 * a checkpoint's take binds one; the settings a snapshot and the retention
 * read, as given.
 */
async function harness(
  settings: { cap?: number; maxCount?: number; maxAgeDays?: number } = {},
): Promise<Harness> {
  const folder = mkdtempSync(path.join(tmpdir(), 'sandforge-checkpoint-snapshot-'));
  folders.push(folder);
  const config = new ConfigStore(new InMemoryConfigStoreBackend());
  config.initialize();
  let id = 0;
  const deps = {
    log: vi.fn(),
    broker: { postToWebview: vi.fn() },
    stateSync: {},
    // A scratch org: pages of 2,000 rows.
    orgManager: { getOrg: () => ({ orgType: 'Scratch' }) },
    orgRegistry: {},
    configStore: config,
    secretVault: {},
    authProvider: {},
    sfdxBridge: {},
    services: {
      getSandforgeSetting: (key: string, fallback: unknown) =>
        key === 'backup.maxRecordsPerObject' && settings.cap !== undefined
          ? settings.cap
          : key === 'backup.maxCount' && settings.maxCount !== undefined
            ? settings.maxCount
            : key === 'backup.maxAgeDays' && settings.maxAgeDays !== undefined
              ? settings.maxAgeDays
              : fallback,
    },
    infraServices: {},
    nextId: () => `msg-${++id}`,
  } as unknown as HandlerDeps;
  const handler = new DataOpsHandler(deps);
  handler.setBackupRecordStore(new BackupRecordStore(nodeBackupFiles(folder)));
  await handler.swept();
  return { handler, config, folder };
}

/** A statement the connection was sent, and whether it read the recycle bin too. */
interface Sent {
  soql: string;
  scanAll: boolean;
}

/**
 * The fake org as the connection a snapshot reads through: every statement
 * recorded, and `before` called with it before the org answers — what a test
 * writes to the org from, between two reads.
 */
function connectTo(org: MemoryRemovalOrg, before: (soql: string) => void = () => undefined) {
  const sent: Sent[] = [];
  const queryMore = vi.fn((nextRecordsUrl: string) => org.queryMore(nextRecordsUrl));
  vi.mocked(getJsforceConnection).mockResolvedValue({
    query: async (soql: string, options?: { scanAll?: boolean }) => {
      sent.push({ soql, scanAll: options?.scanAll === true });
      before(soql);
      return org.query(soql, options);
    },
    queryMore,
    describe: (objectApiName: string) => org.describe(objectApiName),
  } as never);
  return { sent, queryMore };
}

/** The rows the snapshot's file holds of one object, one to a line; none when there is no file. */
function rowsIn(
  folder: string,
  operationId: string,
  objectApiName: string,
): Array<Record<string, unknown>> {
  const file = path.join(folder, 'backups', `${operationId}__${objectApiName}.ndjson`);
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  return text
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** The files of the snapshot's folder: none once a snapshot that is not kept is discarded. */
function snapshotFiles(folder: string): string[] {
  try {
    return readdirSync(path.join(folder, 'backups'));
  } catch {
    return [];
  }
}

/** The values a row holds in its custom fields, each once. */
function customValues(row: Record<string, unknown> | undefined): unknown[] {
  return [
    ...new Set(
      Object.entries(row ?? {})
        .filter(([field]) => field.endsWith('__c'))
        .map(([, value]) => value),
    ),
  ];
}

/** A wide row of `objectApiName`, each custom field `value`. */
function wideRow(id: string, value: string): Record<string, unknown> & { Id: string } {
  return {
    Id: id,
    Name: `Record ${id.slice(-6)}`,
    ...Object.fromEntries(customFields(400).map((field) => [field, value])),
  };
}

describe('DataOpsHandler — the snapshot a checkpoint holds', () => {
  it("reads the fields it is given and no other, and records the snapshot as a checkpoint's", async () => {
    const h = await harness();
    const org = new MemoryRemovalOrg({}, { now: () => READ_AT });
    org.add('Account', { Id: accountId(1), Name: 'Northwind', Description: 'not kept' });
    const { sent } = connectTo(org);

    const taken = await h.handler.backupForPipeline({
      operationId: 'ck-snap-1',
      orgId: 'org-1',
      objects: ['Account'],
      fields: new Map([['Account', ['Id', 'SystemModstamp', 'Name']]]),
      origin: 'checkpoint',
      failWhenTruncated: true,
    });

    expect(sent[0]).toEqual({
      soql: 'SELECT Id, SystemModstamp, Name FROM Account',
      scanAll: false,
    });
    expect(rowsIn(h.folder, 'ck-snap-1', 'Account')).toEqual([
      { Id: accountId(1), SystemModstamp: orgStamp(READ_AT), Name: 'Northwind' },
    ]);
    expect(taken.objects).toEqual([
      { objectApiName: 'Account', recordCount: 1, orgCount: 1, truncated: false },
    ]);
    expect(h.config.get('backup:ck-snap-1')).toMatchObject({
      origin: 'checkpoint',
      totalRecords: 1,
      partial: false,
    });
  });

  it('hands the connection it reads through to the take before its first read, so every request of the snapshot can be counted', async () => {
    const h = await harness();
    const org = new MemoryRemovalOrg({}, { now: () => READ_AT });
    org.add('Account', { Id: accountId(1), Name: 'Northwind' });
    const { sent } = connectTo(org);
    const handed: Array<{ connection: unknown; readBefore: number }> = [];

    await h.handler.backupForPipeline({
      operationId: 'ck-snap-conn',
      orgId: 'org-1',
      objects: ['Account'],
      fields: new Map([['Account', ['Id', 'SystemModstamp', 'Name']]]),
      origin: 'checkpoint',
      failWhenTruncated: true,
      onConnection: (connection) => handed.push({ connection, readBefore: sent.length }),
    });

    const opened: unknown = await vi.mocked(getJsforceConnection).mock.results[0]?.value;
    expect(handed).toHaveLength(1);
    expect(handed[0].connection).toBe(opened);
    expect(handed[0].readBefore).toBe(0);
    expect(sent.length).toBeGreaterThan(0);
  });

  it('refuses, before reading anything, a field that is not a field name', async () => {
    const h = await harness();

    await expect(
      h.handler.backupForPipeline({
        operationId: 'ck-snap-2',
        orgId: 'org-1',
        objects: ['Account'],
        fields: new Map([['Account', ['Id', 'Name FROM User WHERE Id != null']]]),
        origin: 'checkpoint',
      }),
    ).rejects.toThrow('Invalid Salesforce API name');
    expect(getJsforceConnection).not.toHaveBeenCalled();
  });

  it('reads Tasks through the recycle bin, the archived ones with the rest, and never a deleted one', async () => {
    const h = await harness();
    const org = new MemoryRemovalOrg({}, { now: () => READ_AT });
    org.add('Task', { Id: taskId(1), Subject: 'Call back' });
    org.add('Task', { Id: taskId(2), Subject: 'Closed last year' });
    org.archive('Task', taskId(2));
    org.add('Task', { Id: taskId(3), Subject: 'Deleted' });
    org.trash('Task', taskId(3));
    org.add('Account', { Id: accountId(1), Name: 'Northwind' });
    const { sent } = connectTo(org);

    await h.handler.backupForPipeline({
      operationId: 'ck-snap-3',
      orgId: 'org-1',
      objects: ['Task', 'Account'],
      fields: new Map([
        ['Task', ['Id', 'SystemModstamp', 'Subject']],
        ['Account', ['Id', 'SystemModstamp', 'Name']],
      ]),
      scanAll: ['Task'],
      origin: 'checkpoint',
      failWhenTruncated: true,
    });

    expect(rowsIn(h.folder, 'ck-snap-3', 'Task').map((row) => row.Id)).toEqual([
      taskId(1),
      taskId(2),
    ]);
    expect(sent.slice(0, 2)).toEqual([
      {
        soql: 'SELECT Id, SystemModstamp, Subject FROM Task WHERE (IsDeleted = false)',
        scanAll: true,
      },
      { soql: 'SELECT Id, SystemModstamp, Name FROM Account', scanAll: false },
    ]);
  });

  it('holds each row of a wide object as one write left it: a record written between two groups is read again, one deleted is dropped', async () => {
    const h = await harness();
    let clock = READ_AT;
    const org = new MemoryRemovalOrg({}, { now: () => clock });
    for (const n of [1, 2, 3]) org.add('Account', wideRow(accountId(n), 'v1'));
    let planted = false;
    const { sent } = connectTo(org, (soql) => {
      // Between the first group and the others: someone saves an account,
      // and deletes another.
      if (planted || !soql.includes('Id IN (')) return;
      planted = true;
      clock += 3_000;
      org.edit('Account', accountId(2), wideRow(accountId(2), 'v2'));
      org.trash('Account', accountId(3));
    });

    const taken = await h.handler.backupForPipeline({
      operationId: 'ck-snap-4',
      orgId: 'org-1',
      objects: ['Account'],
      fields: new Map([['Account', WIDE_FIELDS]]),
      origin: 'checkpoint',
      failWhenTruncated: true,
    });

    const rows = rowsIn(h.folder, 'ck-snap-4', 'Account');
    expect(rows.map((row) => row.Id)).toEqual([accountId(1), accountId(2)]);
    expect(customValues(rows[1])).toEqual(['v2']);
    expect(rows[1].SystemModstamp).toBe(orgStamp(clock));
    expect(customValues(rows[0])).toEqual(['v1']);
    expect(Object.keys(rows[0]).sort()).toEqual([...WIDE_FIELDS].sort());
    expect(taken.objects[0]).toMatchObject({ recordCount: 2, truncated: false });
    // Every group names the stamp it is compared by.
    const groups = sent.filter((s) => s.soql.includes('Id IN ('));
    expect(groups.length).toBeGreaterThan(1);
    for (const { soql } of groups) expect(soql).toMatch(/^SELECT Id, SystemModstamp, /);
  });

  it.each(factCombinations(['deleteStamps']))(
    'drops a Task deleted between two groups, though its read goes through the recycle bin (a delete stamps it: $deleteStamps)',
    async (facts) => {
      const h = await harness();
      let clock = READ_AT;
      const org = new MemoryRemovalOrg({}, { now: () => clock, facts });
      for (const n of [1, 2]) org.add('Task', wideRow(taskId(n), 'v1'));
      let planted = false;
      const { sent } = connectTo(org, (soql) => {
        if (planted || !soql.includes('Id IN (')) return;
        planted = true;
        clock += 3_000;
        org.trash('Task', taskId(2));
      });

      await h.handler.backupForPipeline({
        operationId: 'ck-snap-5',
        orgId: 'org-1',
        objects: ['Task'],
        fields: new Map([['Task', WIDE_FIELDS]]),
        scanAll: ['Task'],
        origin: 'checkpoint',
        failWhenTruncated: true,
      });

      expect(rowsIn(h.folder, 'ck-snap-5', 'Task').map((row) => row.Id)).toEqual([taskId(1)]);
      for (const { soql, scanAll } of sent.filter((s) => s.soql.includes('Id IN ('))) {
        expect(scanAll).toBe(true);
        expect(soql).toMatch(/ WHERE IsDeleted = false AND Id IN \(/);
      }
    },
  );

  it('fails, keeping nothing, on an object past the cap, before it reads a second page', async () => {
    const h = await harness({ cap: 100 });
    const org = new MemoryRemovalOrg({}, { now: () => READ_AT, pageSize: 50 });
    for (let n = 1; n <= 150; n++) org.add('Account', { Id: accountId(n), Name: `A${n}` });
    const { queryMore } = connectTo(org);

    await expect(
      h.handler.backupForPipeline({
        operationId: 'ck-snap-6',
        orgId: 'org-1',
        objects: ['Account'],
        fields: new Map([['Account', ['Id', 'SystemModstamp', 'Name']]]),
        origin: 'checkpoint',
        failWhenTruncated: true,
      }),
    ).rejects.toThrow(
      'Account holds 150 records, past the 100 a snapshot reads of one object: no snapshot was kept',
    );
    expect(queryMore).not.toHaveBeenCalled();
    expect(h.config.get('backup:ck-snap-6')).toBeUndefined();
    expect(snapshotFiles(h.folder)).toEqual([]);
  });

  it('keeps the rows up to the cap, said partial, for a snapshot that does not ask for every row', async () => {
    const h = await harness({ cap: 100 });
    const org = new MemoryRemovalOrg({}, { now: () => READ_AT, pageSize: 50 });
    for (let n = 1; n <= 150; n++) org.add('Account', { Id: accountId(n), Name: `A${n}` });
    connectTo(org);

    const taken = await h.handler.backupForPipeline({
      operationId: 'ck-snap-7',
      orgId: 'org-1',
      objects: ['Account'],
      fields: new Map([['Account', ['Id', 'SystemModstamp', 'Name']]]),
      origin: 'checkpoint',
    });

    expect(taken.partial).toBe(true);
    expect(rowsIn(h.folder, 'ck-snap-7', 'Account')).toHaveLength(100);
  });

  it('fails, keeping nothing, when the cap is reached on an org that did not say how many records the object holds', async () => {
    const h = await harness({ cap: 100 });
    const page = (from: number) =>
      Array.from({ length: 60 }, (_, i) => ({ Id: accountId(from + i), Name: 'A' }));
    vi.mocked(getJsforceConnection).mockResolvedValue({
      query: vi.fn(async () => ({ records: page(1), done: false, nextRecordsUrl: '/next-1' })),
      queryMore: vi.fn(async () => ({ records: page(61), done: false, nextRecordsUrl: '/next-2' })),
    } as never);

    await expect(
      h.handler.backupForPipeline({
        operationId: 'ck-snap-8',
        orgId: 'org-1',
        objects: ['Account'],
        fields: new Map([['Account', ['Id', 'Name']]]),
        origin: 'checkpoint',
        failWhenTruncated: true,
      }),
    ).rejects.toThrow('Account holds more records, past the 100 a snapshot reads of one object');
    expect(h.config.get('backup:ck-snap-8')).toBeUndefined();
    expect(snapshotFiles(h.folder)).toEqual([]);
  });

  it('fails, keeping nothing, when the org stops answering before it says the read is done', async () => {
    const h = await harness();
    vi.mocked(getJsforceConnection).mockResolvedValue({
      // A page that is not the last, and names no next one.
      query: vi.fn(async () => ({
        records: [{ Id: accountId(1), Name: 'A' }],
        done: false,
        totalSize: 2_500,
      })),
      queryMore: vi.fn(),
    } as never);

    await expect(
      h.handler.backupForPipeline({
        operationId: 'ck-snap-9',
        orgId: 'org-1',
        objects: ['Account'],
        fields: new Map([['Account', ['Id', 'Name']]]),
        origin: 'checkpoint',
        failWhenTruncated: true,
      }),
    ).rejects.toThrow(
      'The org stopped answering the read of Account after 1 record(s), before it said the read was done',
    );
    expect(h.config.get('backup:ck-snap-9')).toBeUndefined();
    expect(snapshotFiles(h.folder)).toEqual([]);
  });

  it('keeps nothing of a snapshot the org failed part-way, not even the objects read whole before', async () => {
    const h = await harness();
    const org = new MemoryRemovalOrg({}, { now: () => READ_AT });
    org.add('Contact', { Id: '003000000000001AAA', LastName: 'Lovelace' });
    org.refuseRead.set('Account', { errorCode: 'INVALID_TYPE', message: 'sObject type refused' });
    connectTo(org);

    await expect(
      h.handler.backupForPipeline({
        operationId: 'ck-snap-10',
        orgId: 'org-1',
        objects: ['Contact', 'Account'],
        fields: new Map([
          ['Contact', ['Id', 'SystemModstamp', 'LastName']],
          ['Account', ['Id', 'SystemModstamp', 'Name']],
        ]),
        origin: 'checkpoint',
        failWhenTruncated: true,
      }),
    ).rejects.toThrow('sObject type refused');
    expect(h.config.get('backup:ck-snap-10')).toBeUndefined();
    expect(snapshotFiles(h.folder)).toEqual([]);
  });

  it("is never taken by the retention of backups by age: a kept checkpoint's snapshot outlives it", async () => {
    const h = await harness({ maxAgeDays: 30 });
    const now = Date.parse('2026-12-01T00:00:00.000Z');
    const longAgo = '2026-10-01T00:00:00.000Z';
    h.config.set('backupRetention:since', '2026-01-01T00:00:00.000Z');
    const meta = (operationId: string, checkpoint: boolean) => ({
      operationId,
      orgId: 'org-1',
      objects: [{ objectApiName: 'Account', recordCount: 1 }],
      timestamp: longAgo,
      totalRecords: 1,
      ...(checkpoint ? { origin: 'checkpoint' } : {}),
    });
    h.config.set('backup:ck-kept', meta('ck-kept', true), 'backups');
    h.config.set('backup:dataops-old', meta('dataops-old', false), 'backups');

    await h.handler.sweepBackupFiles(now);

    expect(h.config.get('backup:ck-kept')).toBeDefined();
    expect(h.config.get('backup:dataops-old')).toBeUndefined();
  });

  it("is never pruned by the count of an org's backups", async () => {
    const h = await harness({ maxCount: 1, maxAgeDays: 0 });
    h.config.set(
      'backup:ck-older',
      {
        operationId: 'ck-older',
        orgId: 'org-1',
        objects: [{ objectApiName: 'Account', recordCount: 1 }],
        timestamp: '2026-10-01T00:00:00.000Z',
        totalRecords: 1,
        origin: 'checkpoint',
      },
      'backups',
    );
    const org = new MemoryRemovalOrg({}, { now: () => READ_AT });
    org.add('Account', { Id: accountId(1), Name: 'Northwind' });
    connectTo(org);

    // A DataOps backup of the same org, the one the count keeps.
    await h.handler.backupForPipeline({
      operationId: 'dataops-new',
      orgId: 'org-1',
      objects: ['Account'],
      fields: new Map([['Account', ['Id', 'Name']]]),
    });

    expect(h.config.get('backup:dataops-new')).toBeDefined();
    expect(h.config.get('backup:ck-older')).toBeDefined();
  });
});

/*
 * A DataOps backup, the panel's or a pipeline's, of an object too wide for
 * one query: read in column groups as a checkpoint's snapshot is, and held
 * to one write by the record's stamp when the object has one. Merged as the
 * groups were read, a record saved between two of them was kept with the
 * values of two saves, which a restore wrote back as one, and a record
 * deleted between them was kept with the first group's columns alone.
 */
describe('DataOpsHandler — a backup of a wide object', () => {
  /** The fields of `names` as the org's describe lists them. */
  const described = (names: readonly string[]) =>
    names.map((name) => ({ name, type: name === 'Id' ? 'id' : 'string' }));

  it('holds each row as one write left it: a record saved between two groups is read again, one deleted is left out', async () => {
    const h = await harness();
    let clock = READ_AT;
    const org = new MemoryRemovalOrg({}, { now: () => clock });
    org.changeSchema('Account', described(WIDE_FIELDS));
    for (const n of [1, 2, 3]) org.add('Account', wideRow(accountId(n), 'v1'));
    let planted = false;
    const { sent } = connectTo(org, (soql) => {
      if (planted || !soql.includes('Id IN (')) return;
      planted = true;
      clock += 3_000;
      org.edit('Account', accountId(2), wideRow(accountId(2), 'v2'));
      org.trash('Account', accountId(3));
    });

    const taken = await h.handler.backupForPipeline({
      operationId: 'dataops-wide-1',
      orgId: 'org-1',
      objects: ['Account'],
    });

    const rows = rowsIn(h.folder, 'dataops-wide-1', 'Account');
    expect(rows.map((row) => row.Id)).toEqual([accountId(1), accountId(2)]);
    expect(customValues(rows[1])).toEqual(['v2']);
    expect(rows[1].SystemModstamp).toBe(orgStamp(clock));
    expect(customValues(rows[0])).toEqual(['v1']);
    expect(Object.keys(rows[0]).sort()).toEqual([...WIDE_FIELDS].sort());
    expect(taken.objects[0]).toMatchObject({ recordCount: 2, truncated: false });
    const groups = sent.filter((s) => s.soql.includes('Id IN ('));
    expect(groups.length).toBeGreaterThan(1);
    for (const { soql } of groups) expect(soql).toMatch(/^SELECT Id, SystemModstamp, /);
  });

  it('merges the groups as they were read for an object without a stamp, never naming one it does not have', async () => {
    const h = await harness();
    const fields = WIDE_FIELDS.filter((field) => field !== 'SystemModstamp');
    const org = new MemoryRemovalOrg({}, { now: () => READ_AT });
    org.changeSchema('Account', described(fields));
    org.missingFields.set('Account', new Set(['SystemModstamp']));
    for (const n of [1, 2]) org.add('Account', wideRow(accountId(n), 'v1'));
    const { sent } = connectTo(org);

    const taken = await h.handler.backupForPipeline({
      operationId: 'dataops-wide-2',
      orgId: 'org-1',
      objects: ['Account'],
    });

    const rows = rowsIn(h.folder, 'dataops-wide-2', 'Account');
    expect(rows.map((row) => row.Id)).toEqual([accountId(1), accountId(2)]);
    expect(Object.keys(rows[0]).sort()).toEqual([...fields].sort());
    expect(taken.partial).toBe(false);
    expect(sent.filter((s) => s.soql.includes('Id IN (')).length).toBeGreaterThan(0);
    for (const { soql } of sent) expect(soql).not.toContain('SystemModstamp');
  });
});
