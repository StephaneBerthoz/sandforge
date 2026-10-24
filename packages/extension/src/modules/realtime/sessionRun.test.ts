import { describe, it, expect, vi } from 'vitest';
import * as path from 'node:path';
import type { Connection } from 'jsforce';
import type { SyncObjectConfig } from '@sandforge/shared';
import type { BulkApiExecutor } from '../../core/engine/BulkApiExecutor';
import type { BulkApiManager } from '../../core/engine/BulkApiManager';
import { BulkDataWriter, type WriterCalls } from '../sync/BulkDataWriter';
import {
  SYNC_RUNS_DIR,
  SyncRunCreations,
  type SyncRunCreationsDeps,
} from '../sync/SyncRunCreations';
import { overwriteBackupIdOf } from '../sync/syncOverwrites';
import type { OrgReader, TargetWrite } from './RealtimeApplier';
import { openSessionRun, sessionStatusOf } from './sessionRun';

/** A fake id: the object's prefix and a counter, the length of a real one. */
const fakeId = (prefix: string, n: number): string => `${prefix}${String(n).padStart(12, '0')}AAA`;

/** The lead the target holds under the key `K1`, the one it creates, and one it deletes. */
const HELD = fakeId('00Q', 1);
const MADE = fakeId('00Q', 2);
const GONE = fakeId('00Q', 3);

const SESSION = 'session-1';
const STORAGE = path.join(path.sep, 'storage');
const DIR = path.join(STORAGE, SYNC_RUNS_DIR);

/** A disk in memory, keyed as the platform writes paths. */
function memoryDisk() {
  const files = new Map<string, string>();
  const deps: SyncRunCreationsDeps = {
    storagePath: STORAGE,
    readFile: async (filePath) => {
      const text = files.get(filePath);
      if (text === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return text;
    },
    writeFile: async (filePath, content) => {
      files.set(filePath, content);
    },
    appendFile: async (filePath, content) => {
      files.set(filePath, (files.get(filePath) ?? '') + content);
    },
    rename: async (from, to) => {
      files.set(to, files.get(from) ?? '');
      files.delete(from);
    },
    mkdir: async () => undefined,
    rm: async (filePath) => {
      files.delete(filePath);
    },
    listFiles: async (dirPath) =>
      [...files]
        .filter(([filePath]) => path.dirname(filePath) === dirPath)
        .map(([filePath, text]) => ({ name: path.basename(filePath), size: text.length })),
  };
  return { files, store: new SyncRunCreations(deps) };
}

/** The DataOps backup store's files, in memory: what each backup was given, per object. */
function memoryBackups() {
  const kept: Array<{ backup: string; objectApiName: string; records: unknown[] }> = [];
  return {
    kept,
    files: {
      begin: vi.fn(async () => undefined),
      append: vi.fn(async (backup: string, objectApiName: string, records: readonly unknown[]) => {
        kept.push({ backup, objectApiName, records: [...records] });
      }),
    },
  };
}

/** The target's leads, read as the session reads them: `SELECT … FROM Lead WHERE <key> IN (…)`. */
function target(rows: Array<Record<string, unknown>>): OrgReader {
  return {
    async query(soql) {
      if (soql === 'SELECT PermissionsViewEncryptedData FROM UserPermissionAccess') {
        return [{ PermissionsViewEncryptedData: true }];
      }
      const match = /^SELECT (.+) FROM Lead WHERE (\w+) IN \((.*)\)$/.exec(soql);
      if (!match) throw new Error(`not a statement the target reads: ${soql}`);
      const [, columns, key, list] = match;
      const wanted = list.split(', ').map((quoted) => quoted.slice(1, -1));
      return rows
        .filter((row) => wanted.includes(String(row[key])))
        .map((row) =>
          Object.fromEntries(columns.split(', ').map((column) => [column, row[column] ?? null])),
        );
    },
    async describe() {
      return {
        fields: [
          { name: 'Id', type: 'id', createable: false },
          { name: 'Ext__c', type: 'string', createable: true },
          { name: 'Title', type: 'string', createable: true },
        ],
      };
    },
  };
}

const LEAD: SyncObjectConfig = {
  objectApiName: 'Lead',
  operation: 'upsert',
  externalIdField: 'Ext__c',
  fieldMappings: [],
  transformRules: [],
  excludedFields: [],
  addOnFields: [],
  batchSize: 200,
  insertOrder: 0,
};

/**
 * Sync's writer over a target that takes every row: an upsert of `K1` finds
 * the lead it holds, any other key creates {@link MADE}.
 */
function writerOver(calls: WriterCalls): { write: TargetWrite; sent: string[] } {
  const sent: string[] = [];
  const sobject = {
    upsert: vi.fn(async (rows: Array<Record<string, unknown>>) => {
      sent.push(`upsert ${rows.map((row) => String(row.Ext__c)).join(',')}`);
      return rows.map((row) =>
        row.Ext__c === 'K1'
          ? { id: HELD, success: true, created: false }
          : { id: MADE, success: true, created: true },
      );
    }),
    destroy: vi.fn(async (ids: string[]) => {
      sent.push(`delete ${ids.join(',')}`);
      return ids.map((id) => ({ id, success: true }));
    }),
  };
  const writer = new BulkDataWriter({
    connection: { sobject: () => sobject } as unknown as Connection,
    bulkExecutor: { shouldUseBulkApi: () => false } as unknown as BulkApiExecutor,
    bulkManager: {} as unknown as BulkApiManager,
    retryConfig: { maxRetries: 0, initialDelay: 0, jitter: false },
    onProgress: vi.fn(),
    log: vi.fn(),
    calls,
  });
  const write: TargetWrite = async (config, records) => ({
    outcomes:
      config.operation === 'delete'
        ? await writer.delete(
            config.objectApiName,
            records.map((record) => String(record.Id)),
            200,
          )
        : await writer.upsert(config.objectApiName, config.externalIdField ?? 'Id', records, 200),
    notes: [],
  });
  return { write, sent };
}

function session(
  options: {
    rows?: Array<Record<string, unknown>>;
    withBackups?: boolean;
  } = {},
) {
  const disk = memoryDisk();
  const backups = memoryBackups();
  const meta = { set: vi.fn() };
  const run = openSessionRun({
    sessionId: SESSION,
    sourceOrgId: 'org-source',
    targetOrgId: 'org-target',
    store: disk.store,
    ...(options.withBackups === false ? {} : { backups: backups.files }),
    meta,
    target: target(options.rows ?? [{ Id: HELD, Ext__c: 'K1', Title: 'Before' }]),
    log: vi.fn(),
  });
  const writer = writerOver(run.calls);
  return { ...disk, backups, meta, run, write: run.write(writer.write), sent: writer.sent };
}

describe('openSessionRun — what a Real-Time session writes, kept as a Sync run', () => {
  it('keeps what a session creates, what it writes over with its values from before, and what it deletes, under its id', async () => {
    const { store, backups, run, write } = session();

    await write(LEAD, [{ Ext__c: 'K1', Title: 'After' }]);
    await write(LEAD, [{ Ext__c: 'K2', Title: 'New' }]);
    await write({ ...LEAD, operation: 'delete' }, [{ Id: GONE }]);
    expect(await run.end({ status: 'success' })).toBeUndefined();

    const kept = await store.get(SESSION);
    expect(kept).toMatchObject({
      runId: SESSION,
      realtime: true,
      configName: '',
      sourceOrgId: 'org-source',
      targetOrgId: 'org-target',
      end: { status: 'success' },
      created: [{ objectApiName: 'Lead', ids: [MADE] }],
      overwritten: [{ objectApiName: 'Lead', backup: overwriteBackupIdOf(SESSION), ids: [HELD] }],
      deleted: [{ objectApiName: 'Lead', ids: [GONE] }],
    });
    // Under no saved configuration: its removal marks none to be read whole.
    expect(kept?.configId).toBe(`realtime:${SESSION}`);
    // The value the lead held before the session, kept before the session wrote it.
    expect(backups.kept).toEqual([
      {
        backup: overwriteBackupIdOf(SESSION),
        objectApiName: 'Lead',
        records: [{ Id: HELD, Title: 'Before' }],
      },
    ]);
  });

  it('lists its backup whole on the Restore tab once it ends', async () => {
    const { meta, run, write } = session();

    await write(LEAD, [{ Ext__c: 'K1', Title: 'After' }]);
    await run.end({ status: 'success' });

    const [key, value] = meta.set.mock.calls.at(-1) ?? [];
    expect(key).toBe(`backup:${overwriteBackupIdOf(SESSION)}`);
    expect(value).toMatchObject({
      partial: false,
      totalRecords: 1,
      origin: 'sync',
      runId: SESSION,
    });
  });

  it('does not bring back from the recycle bin a record it created and deleted after', async () => {
    const { store, run, write } = session();

    await write(LEAD, [{ Ext__c: 'K2', Title: 'New' }]);
    await write({ ...LEAD, operation: 'delete' }, [{ Id: MADE }]);
    await run.end({ status: 'success' });

    const kept = await store.get(SESSION);
    expect(kept?.created).toEqual([{ objectApiName: 'Lead', ids: [MADE] }]);
    expect(kept?.deleted).toBeUndefined();
  });

  it('names no delete the target refused', async () => {
    const disk = memoryDisk();
    const run = openSessionRun({
      sessionId: SESSION,
      sourceOrgId: 'org-source',
      targetOrgId: 'org-target',
      store: disk.store,
      meta: { set: vi.fn() },
      target: target([]),
      log: vi.fn(),
    });
    const write = run.write(async () => ({
      outcomes: [
        { id: GONE, success: true, errors: [] },
        { success: false, errors: ['ENTITY_IS_DELETED: entity is deleted'] },
      ],
      notes: [],
    }));
    await write({ ...LEAD, operation: 'delete' }, [{ Id: GONE }, { Id: HELD }]);
    await run.end({ status: 'partial' });

    expect((await disk.store.get(SESSION))?.deleted).toEqual([
      { objectApiName: 'Lead', ids: [GONE] },
    ]);
  });

  it('writes one write at a time: a change decided on the Conflicts tab waits for the batch being written', async () => {
    const disk = memoryDisk();
    const run = openSessionRun({
      sessionId: SESSION,
      sourceOrgId: 'org-source',
      targetOrgId: 'org-target',
      store: disk.store,
      meta: { set: vi.fn() },
      target: target([]),
      log: vi.fn(),
    });
    const order: string[] = [];
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const write = run.write(async (_config, records) => {
      const name = String(records[0]?.Title);
      order.push(`start ${name}`);
      if (name === 'batch') await held;
      order.push(`end ${name}`);
      return { outcomes: [], notes: [] };
    });

    const batch = write(LEAD, [{ Ext__c: 'K1', Title: 'batch' }]);
    const decided = write(LEAD, [{ Ext__c: 'K1', Title: 'decided' }]);
    await Promise.resolve();
    expect(order).toEqual(['start batch']);
    release();
    await Promise.all([batch, decided]);

    expect(order).toEqual(['start batch', 'end batch', 'start decided', 'end decided']);
  });

  it('goes on writing after a write that threw', async () => {
    const disk = memoryDisk();
    const run = openSessionRun({
      sessionId: SESSION,
      sourceOrgId: 'org-source',
      targetOrgId: 'org-target',
      store: disk.store,
      meta: { set: vi.fn() },
      target: target([]),
      log: vi.fn(),
    });
    let calls = 0;
    const write = run.write(async () => {
      calls++;
      if (calls === 1) throw new Error('REQUEST_LIMIT_EXCEEDED');
      return { outcomes: [], notes: [] };
    });

    await expect(write(LEAD, [{ Ext__c: 'K1' }])).rejects.toThrow('REQUEST_LIMIT_EXCEEDED');
    await expect(write(LEAD, [{ Ext__c: 'K1' }])).resolves.toEqual({ outcomes: [], notes: [] });
  });

  it('writes its end once, a second end waiting on the first', async () => {
    const { files, run, write } = session();

    await write(LEAD, [{ Ext__c: 'K2', Title: 'New' }]);
    expect(run.ended).toBe(false);
    await Promise.all([run.end({ status: 'success' }), run.end({ status: 'failure' })]);

    expect(run.ended).toBe(true);
    const text = files.get(path.join(DIR, `${SESSION}.ndjson`)) ?? '';
    const ends = text.split('\n').filter((line) => line.startsWith('{"end"'));
    expect(ends).toHaveLength(1);
    expect(ends[0]).toContain('"status":"success"');
  });

  it('says a session stopped from Live Operations was cancelled', async () => {
    const { store, run, write } = session();

    await write(LEAD, [{ Ext__c: 'K2', Title: 'New' }]);
    await run.end({ status: 'success', cancelled: true });

    expect((await store.get(SESSION))?.end).toMatchObject({ status: 'success', cancelled: true });
  });

  it('leaves no file for a session that wrote nothing', async () => {
    const { files, run } = session();

    await run.end({ status: 'success' });

    expect(files.size).toBe(0);
  });

  it('keeps what it creates in a window with no backup store, and names nothing written over', async () => {
    const { store, run, write, sent } = session({ withBackups: false });

    await write(LEAD, [{ Ext__c: 'K1', Title: 'After' }]);
    await write(LEAD, [{ Ext__c: 'K2', Title: 'New' }]);
    await run.end({ status: 'success' });

    expect(sent).toEqual(['upsert K1', 'upsert K2']);
    const kept = await store.get(SESSION);
    expect(kept?.created).toEqual([{ objectApiName: 'Lead', ids: [MADE] }]);
    expect(kept?.overwritten).toBeUndefined();
  });

  it('says why what it wrote could not all be kept', async () => {
    // A disk that takes no line: the session goes on, and says it once it ends.
    const store = new SyncRunCreations({
      storagePath: STORAGE,
      readFile: async () => '',
      writeFile: async () => undefined,
      appendFile: async () => {
        throw new Error('ENOSPC: no space left on device');
      },
      rename: async () => undefined,
      mkdir: async () => undefined,
      rm: async () => undefined,
      listFiles: async () => [],
    });
    const run = openSessionRun({
      sessionId: SESSION,
      sourceOrgId: 'org-source',
      targetOrgId: 'org-target',
      store,
      meta: { set: vi.fn() },
      target: target([]),
      log: vi.fn(),
    });
    const { write } = writerOver(run.calls);

    await run.write(write)(LEAD, [{ Ext__c: 'K2', Title: 'New' }]);

    expect(await run.end({ status: 'success' })).toBe('ENOSPC: no space left on device');
  });
});

describe('sessionStatusOf', () => {
  it('reads a session with no change refused as a success, one with some written as partial, one with none as a failure', () => {
    expect(sessionStatusOf({ eventsApplied: 4, eventsFailed: 0 })).toBe('success');
    expect(sessionStatusOf({ eventsApplied: 0, eventsFailed: 0 })).toBe('success');
    expect(sessionStatusOf({ eventsApplied: 3, eventsFailed: 1 })).toBe('partial');
    expect(sessionStatusOf({ eventsApplied: 0, eventsFailed: 2 })).toBe('failure');
  });
});
