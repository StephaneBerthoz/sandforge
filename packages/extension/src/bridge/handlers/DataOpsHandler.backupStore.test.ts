import * as path from 'node:path';

import { describe, it, expect, vi, beforeEach } from 'vitest';

import { DataOpsHandler } from './DataOpsHandler.js';
import type { HandlerDeps, InboundRequest } from './HandlerTypes.js';
import { BackupRecordStore } from '../../modules/dataops/BackupRecordStore.js';
import type { BaseMessage } from '@sandforge/shared';
import { getJsforceConnection } from '../../core/connection/ConnectionHelper.js';
import { ProductionGuard } from '../../core/precheck/ProductionGuard.js';
import { BackgroundOperationRegistry } from '../../core/engine/BackgroundOperationRegistry.js';
import { ConfigStore } from '../../core/storage/ConfigStore.js';
import { InMemoryConfigStoreBackend } from '../../test/InMemoryConfigStoreBackend.js';
import { inboundRequest } from '../../test/mockFactories.js';

vi.mock('../../core/connection/ConnectionHelper.js', () => ({
  getJsforceConnection: vi.fn(),
}));

/**
 * Backup record payloads must reach the file store, not globalState.
 *
 * The handler keeps writing the backup *meta* to ConfigStore — it is small and
 * it is what the history list reads — but the record sets themselves are what
 * made every unrelated `configStore.set()` re-serialize megabytes.
 */

/** The backup files, kept in memory, and the store over them that the handler writes through. */
function memoryFiles() {
  const files = new Map<string, string>();
  /** When each file was last written, in milliseconds since the epoch. */
  const modified = new Map<string, number>();
  /** Every page added to a file, in order, with the record count each held. */
  const appended: Array<{ file: string; records: number }> = [];
  const store = new BackupRecordStore({
    storagePath: '/storage',
    readFile: async (p) => {
      const content = files.get(p);
      if (content === undefined) throw new Error('ENOENT');
      return content;
    },
    writeFile: async (p, content) => {
      files.set(p, content);
      modified.set(p, Date.now());
    },
    appendFile: async (p, content) => {
      appended.push({ file: path.basename(p), records: content.trimEnd().split('\n').length });
      files.set(p, (files.get(p) ?? '') + content);
      modified.set(p, Date.now());
    },
    exists: async (p) => files.has(p),
    readLines: async function* (p) {
      yield* (files.get(p) ?? '').split('\n');
    },
    mkdir: async () => undefined,
    rm: async (p) => {
      files.delete(p);
      modified.delete(p);
    },
    listFiles: async (dir) =>
      [...files.keys()]
        .filter((p) => path.dirname(p) === dir)
        .map((p) => ({ name: path.basename(p), modifiedMs: modified.get(p) ?? Date.now() })),
  });
  /** Make a file of the backups directory last written `ms` ago. */
  const age = (name: string, ms: number): void => {
    modified.set(path.join('/storage', 'backups', name), Date.now() - ms);
  };
  /** The names of the files in the backups directory. */
  const names = (): string[] => [...files.keys()].map((p) => path.basename(p)).sort();
  /** The records of one object of a backup, as its file holds them, one per line. */
  const recordsIn = (operationId: string, objectApiName: string): Array<Record<string, unknown>> =>
    (files.get(path.join('/storage', 'backups', `${operationId}__${objectApiName}.ndjson`)) ?? '')
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  return { files, appended, store, recordsIn, age, names };
}

interface Harness {
  handler: DataOpsHandler;
  deps: HandlerDeps;
  config: ConfigStore;
  files: ReturnType<typeof memoryFiles>;
}

/**
 * A handler over an in-memory config store and backup files, and the org type
 * a backup reads its page size from: a Developer Edition reads 500 rows a page.
 *
 * @param cap - What `sandforge.backup.maxRecordsPerObject` says, when it says anything.
 */
function createHarness(
  options: { withStore?: boolean; cap?: unknown; orgType?: string; maxAgeDays?: unknown } = {},
): Harness {
  let idCounter = 0;
  const config = new ConfigStore(new InMemoryConfigStoreBackend());
  config.initialize();
  const deps = {
    log: vi.fn(),
    broker: { postToWebview: vi.fn() },
    stateSync: {},
    orgManager: { getOrg: vi.fn(() => ({ orgType: options.orgType ?? 'Developer Edition' })) },
    orgRegistry: {},
    configStore: config,
    secretVault: {},
    authProvider: {},
    sfdxBridge: {},
    services: {
      getSandforgeSetting: (key: string, fallback: unknown) =>
        key === 'backup.maxRecordsPerObject' && 'cap' in options
          ? options.cap
          : key === 'backup.maxAgeDays' && 'maxAgeDays' in options
            ? options.maxAgeDays
            : fallback,
    },
    // A restore refuses to write without a Production Guard, and the
    // extension always injects one.
    infraServices: {
      productionGuard: new ProductionGuard(),
      backgroundRegistry: new BackgroundOperationRegistry(),
    },
    nextId: () => String(++idCounter),
  } as unknown as HandlerDeps;

  const files = memoryFiles();
  const handler = new DataOpsHandler(deps);
  if (options.withStore !== false) handler.setBackupRecordStore(files.store);
  return { handler, deps, config, files };
}

/** `count` contacts, as the org would hand them over. */
function contactsOf(count: number): Array<Record<string, unknown>> {
  return Array.from({ length: count }, (_, i) => ({
    Id: `003-${i + 1}`,
    Name: `Contact ${i + 1}`,
  }));
}

/** A Contact the restore may write: its Id is the key, its Name a field anyone may write. */
const contactDescribe = {
  name: 'Contact',
  label: 'Contact',
  createable: true,
  updateable: true,
  deletable: true,
  queryable: true,
  fields: [
    {
      name: 'Id',
      label: 'Id',
      type: 'id',
      createable: false,
      updateable: false,
      permissionable: false,
    },
    {
      name: 'Name',
      label: 'Name',
      type: 'string',
      createable: true,
      updateable: true,
      permissionable: true,
    },
  ],
  recordTypeInfos: [],
  childRelationships: [],
};

/**
 * An org holding `rows` of Contact, read as Salesforce reads them: one
 * statement, its pages as large as `Sforce-Query-Options: batchSize` asks,
 * each but the last naming the next by `nextRecordsUrl`.
 */
function pagedOrg(
  rows: Array<Record<string, unknown>>,
  quirks: { failPage?: number; onPage?: (page: number) => void } = {},
) {
  let pagesServed = 0;
  const pageOf = (offset: number, options?: { headers?: Record<string, string> }) => {
    pagesServed += 1;
    quirks.onPage?.(pagesServed);
    if (pagesServed === quirks.failPage) {
      throw new Error('QUERY_TIMEOUT: Your query request was running for too long.');
    }
    const asked = /batchSize=(\d+)/.exec(options?.headers?.['Sforce-Query-Options'] ?? '');
    const size = asked ? Number(asked[1]) : 2000;
    const records = rows.slice(offset, offset + size).map((r) => ({ ...r }));
    const next = offset + size;
    return next < rows.length
      ? {
          records,
          done: false,
          totalSize: rows.length,
          nextRecordsUrl: `/services/data/v66.0/query/01gXX0000000001-${next}`,
        }
      : { records, done: true, totalSize: rows.length };
  };
  const query = vi.fn(async (soql: string, options?: { headers?: Record<string, string> }) => {
    if (soql === 'SELECT Id FROM Organization') return { records: [], done: true, totalSize: 0 };
    return pageOf(0, options);
  });
  const queryMore = vi.fn(async (url: string, options?: { headers?: Record<string, string> }) =>
    pageOf(Number(/-(\d+)$/.exec(url)?.[1] ?? 0), options),
  );
  const conn = {
    query,
    queryMore,
    describe: vi.fn().mockResolvedValue(contactDescribe),
    sobject: vi.fn(() => ({ upsert: vi.fn(), update: vi.fn() })),
  };
  vi.mocked(getJsforceConnection).mockResolvedValue(conn as never);
  return { query, queryMore };
}

function backupMsg(id: string, objects: string[] = ['Contact']): InboundRequest {
  return inboundRequest({
    id,
    type: 'backup:execute',
    timestamp: Date.now(),
    payload: { orgId: 'org-1', objects },
  } as BaseMessage);
}

function rollbackMsg(operationId: string): InboundRequest {
  return inboundRequest({
    id: `rb-${operationId}`,
    type: 'dataops:rollback',
    timestamp: Date.now(),
    payload: { orgId: 'org-1', operationId },
  } as BaseMessage);
}

/** The messages a handler posted of one type. */
function postedOf(
  deps: HandlerDeps,
  type: string,
): Array<BaseMessage & { payload: Record<string, unknown> }> {
  return (deps.broker.postToWebview as ReturnType<typeof vi.fn>).mock.calls
    .map((c) => c[0] as BaseMessage & { payload: Record<string, unknown> })
    .filter((m) => m.type === type);
}

describe('DataOpsHandler backup record storage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('writes record payloads to the file store, not to ConfigStore', async () => {
    const { handler, config, files } = createHarness();
    pagedOrg(contactsOf(1));

    await handler.handle(backupMsg('req-1'));

    expect(files.recordsIn('req-1', 'Contact')).toEqual(contactsOf(1));
    // Meta still lands in ConfigStore; the per-object record key must not.
    expect(config.get('backup:req-1')).toBeDefined();
    expect(config.get('backup:req-1:Contact')).toBeUndefined();
  });

  it('falls back to ConfigStore when no store is injected', async () => {
    // Keeps the handler usable in tests and in any composition that skips the
    // late-injection step, rather than silently dropping the records.
    const { handler, config } = createHarness({ withStore: false });
    pagedOrg(contactsOf(3));

    await handler.handle(backupMsg('req-1'));

    expect(config.get('backup:req-1:Contact')).toEqual(contactsOf(3));
  });

  describe('every page of an object, up to the cap', () => {
    it('reads past the tier’s page, a page at a time, and writes each page before asking for the next', async () => {
      // Live: 1 220 contacts on a Developer Edition, 500 backed up, and a
      // masking run then masked all 1 220.
      const { handler, deps, config, files } = createHarness();
      const { query, queryMore } = pagedOrg(contactsOf(1_234));

      await handler.handle(backupMsg('bk-all'));

      // One statement, no LIMIT, its pages the tier's 500 rows.
      const [soql, options] = query.mock.calls[0];
      expect(soql).toBe('SELECT Id, Name FROM Contact');
      expect(options?.headers).toEqual({ 'Sforce-Query-Options': 'batchSize=500' });
      expect(queryMore).toHaveBeenCalledTimes(2);
      // Written as they came: each page went to disk before the next was asked
      // for, so no more than a page of the object was ever held.
      expect(files.appended).toEqual([
        { file: 'bk-all__Contact.ndjson', records: 500 },
        { file: 'bk-all__Contact.ndjson', records: 500 },
        { file: 'bk-all__Contact.ndjson', records: 234 },
      ]);
      expect(files.recordsIn('bk-all', 'Contact')).toEqual(contactsOf(1_234));
      expect(config.get('backup:bk-all')).toMatchObject({
        totalRecords: 1_234,
        partial: false,
        cap: 50_000,
        objects: [
          { objectApiName: 'Contact', recordCount: 1_234, orgCount: 1_234, truncated: false },
        ],
      });
      expect(postedOf(deps, 'dataops:backup:response')[0]?.payload).toMatchObject({
        totalRecords: 1_234,
        objects: [{ objectApiName: 'Contact', recordCount: 1_234, orgCount: 1_234 }],
      });
      expect(postedOf(deps, 'dataops:backup:response')[0]?.payload).not.toHaveProperty('partial');
    });

    it('reads two thousand rows a page on a sandbox', async () => {
      const { handler, files } = createHarness({ orgType: 'Sandbox' });
      const { query } = pagedOrg(contactsOf(4_500));

      await handler.handle(backupMsg('bk-sandbox'));

      expect(query.mock.calls[0][1]?.headers).toEqual({
        'Sforce-Query-Options': 'batchSize=2000',
      });
      expect(files.appended.map((a) => a.records)).toEqual([2_000, 2_000, 500]);
    });

    it('stops at the cap the setting sets, and says so with the rows the org holds, in the answer, the list and the coverage check', async () => {
      const { handler, deps, config, files } = createHarness({ cap: 700 });
      const { queryMore } = pagedOrg(contactsOf(1_234));

      await handler.handle(backupMsg('bk-cap'));

      // 500, then the 200 left of the cap from the second page; no third page.
      expect(queryMore).toHaveBeenCalledTimes(1);
      expect(files.recordsIn('bk-cap', 'Contact')).toEqual(contactsOf(700));
      const held = {
        objectApiName: 'Contact',
        recordCount: 700,
        orgCount: 1_234,
        truncated: true,
        stoppedAt: 'cap',
      };
      expect(config.get('backup:bk-cap')).toMatchObject({
        partial: true,
        cap: 700,
        objects: [held],
      });
      expect(postedOf(deps, 'dataops:backup:response')[0]?.payload).toMatchObject({
        partial: true,
        objects: [held],
      });
      expect(deps.log).toHaveBeenCalledWith(
        '[WARN] backup of Contact stopped at the cap of 700 record(s): the object holds 1234.',
      );

      await handler.handle(
        inboundRequest({
          id: 'list-1',
          type: 'backup:list',
          timestamp: Date.now(),
          payload: { orgId: 'org-1' },
        } as BaseMessage),
      );
      expect(postedOf(deps, 'backup:list:result')[0]?.payload).toMatchObject({
        backups: [{ status: 'completed', partial: true, objectResults: [held] }],
      });

      vi.mocked(getJsforceConnection).mockResolvedValue({
        query: vi.fn(async () => ({ records: [], done: true, totalSize: 1_234 })),
      } as never);
      await handler.handle(
        inboundRequest({
          id: 'coverage-1',
          type: 'dataops:anonymize:coverage',
          timestamp: Date.now(),
          payload: { orgId: 'org-1', templateId: 'tpl-gdpr-standard' },
        } as BaseMessage),
      );
      const coverage = postedOf(deps, 'dataops:anonymize:coverage:response')[0]?.payload;
      expect(coverage?.objects).toContainEqual({
        objectApiName: 'Contact',
        count: 1_234,
        backedUp: 700,
        truncated: true,
        stoppedAt: 'cap',
      });
    });

    it('reads every row of an object the cap holds exactly, and calls it whole', async () => {
      const { handler, config } = createHarness({ cap: 1_000 });
      pagedOrg(contactsOf(1_000));

      await handler.handle(backupMsg('bk-exact'));

      expect(config.get('backup:bk-exact')).toMatchObject({
        partial: false,
        objects: [{ recordCount: 1_000, truncated: false }],
      });
    });

    it('holds the cap within the bounds the manifest gives it', async () => {
      const read = async (cap: unknown): Promise<unknown> => {
        const { handler, config } = createHarness({ cap });
        pagedOrg(contactsOf(150));
        await handler.handle(backupMsg(`bk-${String(cap)}`));
        return (config.get(`backup:bk-${String(cap)}`) as { cap?: unknown } | undefined)?.cap;
      };

      expect(await read(5)).toBe(100);
      expect(await read(5_000_000)).toBe(1_000_000);
      expect(await read(1_500.7)).toBe(1_500);
      expect(await read('all of them')).toBe(50_000);
    });
  });

  describe('a backup that does not finish', () => {
    it('keeps what a read failing part-way wrote, listed as failed and partial, and says so', async () => {
      const { handler, deps, config, files } = createHarness();
      pagedOrg(contactsOf(1_234), { failPage: 3 });

      await handler.handle(backupMsg('bk-fail', ['Contact']));

      const meta = config.get('backup:bk-fail');
      expect(meta).toMatchObject({
        status: 'failed',
        partial: true,
        totalRecords: 1_000,
        objects: [
          {
            objectApiName: 'Contact',
            recordCount: 1_000,
            orgCount: 1_234,
            truncated: true,
            stoppedAt: 'failure',
          },
        ],
      });
      expect(files.recordsIn('bk-fail', 'Contact')).toHaveLength(1_000);
      // The page hears the failure, and what was kept of it.
      const [error] = postedOf(deps, 'dataops:error');
      expect(String(error?.payload.message)).toBe(
        'QUERY_TIMEOUT: Your query request was running for too long. — the backup keeps the ' +
          '1000 record(s) read before it stopped, listed as partial: Contact 1000 of 1234 ' +
          '(the read failed).',
      );
      expect(postedOf(deps, 'dataops:backup:response')).toHaveLength(0);

      await handler.handle(
        inboundRequest({
          id: 'list-2',
          type: 'backup:list',
          timestamp: Date.now(),
          payload: { orgId: 'org-1' },
        } as BaseMessage),
      );
      expect(postedOf(deps, 'backup:list:result')[0]?.payload).toMatchObject({
        backups: [{ status: 'failed', partial: true }],
      });
    });

    it('keeps the objects read whole before the one it failed on', async () => {
      const { handler, config } = createHarness();
      // Contact reads in one page; the first page of the next object fails.
      pagedOrg(contactsOf(300), { failPage: 2 });

      await handler.handle(backupMsg('bk-second', ['Contact', 'Lead']));

      expect(config.get('backup:bk-second')).toMatchObject({
        status: 'failed',
        totalRecords: 300,
        objects: [
          { objectApiName: 'Contact', recordCount: 300, truncated: false },
          { objectApiName: 'Lead', recordCount: 0, truncated: true, stoppedAt: 'failure' },
        ],
      });
    });

    it('lists every object it never reached, holding none of it, and says the backup is partial', async () => {
      const { handler, deps, config } = createHarness();
      // Contact reads in one page; the first page of Lead fails; Account is never read.
      pagedOrg(contactsOf(300), { failPage: 2 });

      await handler.handle(backupMsg('bk-short', ['Contact', 'Lead', 'Account']));

      // Account was in no list: the Backup and Restore tabs, and a restore's
      // warning, named nothing of what the backup never read.
      expect(config.get('backup:bk-short')).toMatchObject({
        status: 'failed',
        partial: true,
        totalRecords: 300,
        objects: [
          { objectApiName: 'Contact', recordCount: 300, truncated: false },
          { objectApiName: 'Lead', recordCount: 0, truncated: true, stoppedAt: 'failure' },
          { objectApiName: 'Account', recordCount: 0, truncated: true, stoppedAt: 'not_reached' },
        ],
      });
      const [error] = postedOf(deps, 'dataops:error');
      expect(String(error?.payload.message)).toContain(
        'listed as partial: Lead 0 (the read failed), Account none (the backup stopped before it).',
      );

      await handler.handle(
        inboundRequest({
          id: 'list-short',
          type: 'backup:list',
          timestamp: Date.now(),
          payload: { orgId: 'org-1' },
        } as BaseMessage),
      );
      expect(postedOf(deps, 'backup:list:result')[0]?.payload).toMatchObject({
        backups: [
          {
            status: 'failed',
            partial: true,
            objectResults: [
              { objectApiName: 'Contact' },
              { objectApiName: 'Lead', stoppedAt: 'failure' },
              { objectApiName: 'Account', recordCount: 0, stoppedAt: 'not_reached' },
            ],
          },
        ],
      });
    });

    it('keeps nothing when the read fails before a row is written', async () => {
      const { handler, config, files } = createHarness();
      pagedOrg(contactsOf(10), { failPage: 1 });

      await handler.handle(backupMsg('bk-none'));

      expect(config.get('backup:bk-none')).toBeUndefined();
      expect(files.files.size).toBe(0);
    });

    it('removes what the pages before wrote when a cancel comes between two pages', async () => {
      const { handler, deps, config, files } = createHarness();
      pagedOrg(contactsOf(1_234), {
        onPage: (page) => {
          if (page === 2) deps.infraServices?.backgroundRegistry?.abort('bk-cancel');
        },
      });

      await handler.handle(backupMsg('bk-cancel'));

      expect(files.appended).toHaveLength(2);
      expect(files.files.size).toBe(0);
      expect(config.get('backup:bk-cancel')).toBeUndefined();
      expect(String(postedOf(deps, 'dataops:error')[0]?.payload.message)).toContain(
        'Backup was cancelled before it finished. Nothing was saved',
      );
    });

    it('keeps nothing when the disk does not take a page whole', async () => {
      const { handler, deps, config, files } = createHarness();
      pagedOrg(contactsOf(1_234));
      let pages = 0;
      const append = files.store.append.bind(files.store);
      vi.spyOn(files.store, 'append').mockImplementation(async (...args) => {
        pages += 1;
        if (pages === 2) throw new Error('ENOSPC: no space left on device');
        await append(...args);
      });

      await handler.handle(backupMsg('bk-disk'));

      expect(config.get('backup:bk-disk')).toBeUndefined();
      expect(files.files.size).toBe(0);
      expect(String(postedOf(deps, 'dataops:error')[0]?.payload.message)).toBe(
        'The backup could not be written to disk: ENOSPC: no space left on device',
      );
    });
  });

  describe('the files of a backup that never saved its metadata', () => {
    const DAY = 24 * 60 * 60_000;

    /** A backup's metadata, as `takeBackup` writes it, for a backup holding Contact. */
    function listed(config: ConfigStore, operationId: string): void {
      config.set(
        `backup:${operationId}`,
        {
          operationId,
          orgId: 'org-1',
          objects: [{ objectApiName: 'Contact', recordCount: 1, truncated: false }],
          totalRecords: 1,
          timestamp: new Date(Date.now() - 60 * 60_000).toISOString(),
        },
        'backups',
      );
    }

    it('removes those no window has written to for a day, and keeps every backup listed', async () => {
      // A window that crashed in the middle of a backup left its pages: no
      // listing showed them, no restore read them, and no retention removed them.
      const { handler, deps, config, files } = createHarness();
      await files.store.begin('wv-crashed', 'Contact');
      await files.store.append('wv-crashed', 'Contact', contactsOf(500));
      await files.store.begin('wv-listed', 'Contact');
      await files.store.begin('wv-elsewhere', 'Contact');
      listed(config, 'wv-listed');
      files.age('wv-crashed__Contact.ndjson', 2 * DAY);
      files.age('wv-listed__Contact.ndjson', 30 * DAY);
      // Another window's backup, with a page an hour ago: its metadata comes when it ends.
      files.age('wv-elsewhere__Contact.ndjson', DAY / 24);

      await handler.sweepBackupFiles();

      expect(files.names()).toEqual(['wv-elsewhere__Contact.ndjson', 'wv-listed__Contact.ndjson']);
      expect(deps.log).toHaveBeenCalledWith(
        '[INFO] Removed 1 backup file(s) whose backup never saved its metadata: ' +
          'wv-crashed__Contact.ndjson',
      );
    });

    it('keeps the files of a backup this window is taking, however old they look', async () => {
      const { handler, config, files } = createHarness();
      const { queryMore } = pagedOrg(contactsOf(1_234));
      const nextPage = queryMore.getMockImplementation();
      let swept = false;
      // Between the first page and the second: the backup has a file and no metadata.
      queryMore.mockImplementation(async (url, options) => {
        if (!swept) {
          swept = true;
          await handler.sweepBackupFiles(Date.now() + 30 * DAY);
        }
        return nextPage!(url, options);
      });

      await handler.handle(backupMsg('bk-live'));

      expect(swept).toBe(true);
      expect(files.recordsIn('bk-live', 'Contact')).toEqual(contactsOf(1_234));
      expect(config.get('backup:bk-live')).toMatchObject({ totalRecords: 1_234 });
    });

    it('sweeps after a backup’s retention', async () => {
      const { handler, files } = createHarness();
      await files.store.begin('wv-crashed', 'Contact');
      files.age('wv-crashed__Contact.ndjson', 2 * DAY);
      pagedOrg(contactsOf(3));

      await handler.handle(backupMsg('bk-next'));

      await vi.waitFor(() => expect(files.names()).toEqual(['bk-next__Contact.ndjson']));
    });

    it('sweeps as the store is given, when the extension starts', async () => {
      const { handler, files } = createHarness({ withStore: false });
      await files.store.begin('wv-crashed', 'Contact');
      files.age('wv-crashed__Contact.ndjson', 2 * DAY);

      handler.setBackupRecordStore(files.store);

      await vi.waitFor(() => expect(files.names()).toEqual([]));
    });
  });

  describe('deleting backups', () => {
    const DAY = 24 * 60 * 60_000;

    /** A backup of Contact, its metadata and its file, taken `ago` ms before now. */
    async function keep(
      harness: Harness,
      operationId: string,
      orgId = 'org-1',
      ago = 60 * 60_000,
    ): Promise<void> {
      harness.config.set(
        `backup:${operationId}`,
        {
          operationId,
          orgId,
          objects: [{ objectApiName: 'Contact', recordCount: 2, truncated: false }],
          totalRecords: 2,
          timestamp: new Date(Date.now() - ago).toISOString(),
        },
        'backups',
      );
      await harness.files.store.begin(operationId, 'Contact');
      await harness.files.store.append(operationId, 'Contact', contactsOf(2));
    }

    const deleteMsg = (payload: Record<string, unknown>): InboundRequest =>
      inboundRequest({
        id: 'del-1',
        type: 'backup:delete',
        timestamp: Date.now(),
        payload,
      } as BaseMessage);

    it('deletes the backup named, its metadata and its records, and keeps the others', async () => {
      // A backup kept the records' values in clear, and nothing in the panel
      // deleted one: it stayed until ten newer ones of the org pushed it out.
      const harness = createHarness();
      await keep(harness, 'bk-old');
      await keep(harness, 'bk-new');

      await harness.handler.handle(deleteMsg({ orgId: 'org-1', operationIds: ['bk-old'] }));

      expect(harness.config.get('backup:bk-old')).toBeUndefined();
      expect(harness.config.get('backup:bk-new')).toBeDefined();
      expect(harness.files.names()).toEqual(['bk-new__Contact.ndjson']);
      expect(postedOf(harness.deps, 'backup:delete:result')).toEqual([
        expect.objectContaining({
          correlationId: 'del-1',
          payload: { orgId: 'org-1', deleted: ['bk-old'] },
        }),
      ]);
    });

    it('deletes every backup of the org when none is named, and none of another org', async () => {
      const harness = createHarness();
      await keep(harness, 'bk-1');
      await keep(harness, 'bk-2');
      await keep(harness, 'bk-other', 'org-2');

      await harness.handler.handle(deleteMsg({ orgId: 'org-1' }));

      expect(harness.files.names()).toEqual(['bk-other__Contact.ndjson']);
      expect(postedOf(harness.deps, 'backup:delete:result')[0].payload).toEqual({
        orgId: 'org-1',
        deleted: ['bk-1', 'bk-2'],
      });
      await harness.handler.handle(
        inboundRequest({
          id: 'list-1',
          type: 'backup:list',
          timestamp: Date.now(),
          payload: { orgId: 'org-1' },
        } as BaseMessage),
      );
      expect(postedOf(harness.deps, 'backup:list:result')[0].payload).toEqual({ backups: [] });
    });

    it('refuses while a backup of the org is running, which writes the files it would delete', async () => {
      const harness = createHarness();
      await keep(harness, 'bk-kept');
      pagedOrg(contactsOf(1_234), {
        onPage: (page) => {
          if (page === 2) void harness.handler.handle(deleteMsg({ orgId: 'org-1' }));
        },
      });

      await harness.handler.handle(backupMsg('bk-running'));

      expect(postedOf(harness.deps, 'dataops:error')).toEqual([
        expect.objectContaining({
          correlationId: 'del-1',
          payload: expect.objectContaining({ code: 'BACKUP_BUSY' }),
        }),
      ]);
      expect(harness.config.get('backup:bk-kept')).toBeDefined();
      expect(harness.files.recordsIn('bk-running', 'Contact')).toHaveLength(1_234);
    });

    it(`removes, as SandForge starts, the backups taken more than sandforge.backup.maxAgeDays ago`, async () => {
      const harness = createHarness({ withStore: false });
      // The retention has been in force on this machine for a year.
      harness.config.set('backupRetention:since', new Date(Date.now() - 500 * DAY).toISOString());
      await keep(harness, 'bk-ancient', 'org-1', 31 * DAY);
      await keep(harness, 'bk-recent', 'org-1', 29 * DAY);
      await keep(harness, 'bk-gone-org', 'org-9', 400 * DAY);

      harness.handler.setBackupRecordStore(harness.files.store);

      await vi.waitFor(() => expect(harness.files.names()).toEqual(['bk-recent__Contact.ndjson']));
      expect(harness.config.get('backup:bk-ancient')).toBeUndefined();
      expect(harness.config.get('backup:bk-gone-org')).toBeUndefined();
      expect(harness.config.get('backup:bk-recent')).toBeDefined();
    });

    it('keeps, on the first start with the retention, the backups taken before it, however old, and takes only later ones once they age', async () => {
      const harness = createHarness({ withStore: false });
      await keep(harness, 'bk-before-upgrade', 'org-1', 400 * DAY);

      harness.handler.setBackupRecordStore(harness.files.store);
      await harness.handler.sweepBackupFiles();

      // Kept, and the retention now dates itself from this first start.
      expect(harness.config.get('backup:bk-before-upgrade')).toBeDefined();
      expect(harness.files.names()).toEqual(['bk-before-upgrade__Contact.ndjson']);
      const since = Date.parse(harness.config.get<string>('backupRetention:since') ?? '');
      expect(Date.now() - since).toBeLessThan(60_000);

      // A backup taken after it, once past its age, goes.
      harness.config.set('backupRetention:since', new Date(Date.now() - 60 * DAY).toISOString());
      await keep(harness, 'bk-after-upgrade', 'org-1', 31 * DAY);
      await harness.handler.sweepBackupFiles();
      expect(harness.config.get('backup:bk-after-upgrade')).toBeUndefined();
      expect(harness.config.get('backup:bk-before-upgrade')).toBeDefined();
    });

    it('keeps every backup, however old, when sandforge.backup.maxAgeDays is 0', async () => {
      const harness = createHarness({ maxAgeDays: 0 });
      await keep(harness, 'bk-ancient', 'org-1', 400 * DAY);

      await harness.handler.sweepBackupFiles();

      expect(harness.config.get('backup:bk-ancient')).toBeDefined();
      expect(harness.files.names()).toEqual(['bk-ancient__Contact.ndjson']);
    });

    it('goes by the age the setting gives', async () => {
      const harness = createHarness({ maxAgeDays: 7 });
      harness.config.set('backupRetention:since', new Date(Date.now() - 60 * DAY).toISOString());
      await keep(harness, 'bk-week-old', 'org-1', 8 * DAY);
      await keep(harness, 'bk-fresh', 'org-1', DAY);

      await harness.handler.sweepBackupFiles();

      expect(harness.files.names()).toEqual(['bk-fresh__Contact.ndjson']);
    });
  });

  describe('a restore', () => {
    /** A connection a restore writes through: the recycle bin, and the upsert. */
    function restoringOrg(deletedIds: string[] = []) {
      const order: string[] = [];
      const upsert = vi.fn(async (batch: Array<Record<string, unknown>>) => {
        order.push(`upsert ${batch.length}`);
        return batch.map((r) => ({ success: true, id: r.Id }));
      });
      const query = vi.fn(async (soql: string) => {
        if (soql.includes('IsDeleted = true')) {
          const asked = /Id IN \(([^)]*)\)/.exec(soql)?.[1] ?? '';
          order.push(`bin ${asked.split(',').length}`);
          return {
            records: deletedIds.filter((id) => asked.includes(`'${id}'`)).map((Id) => ({ Id })),
            done: true,
          };
        }
        return { records: [], done: true };
      });
      const undelete = vi.fn(async (ids: string[]) => {
        order.push(`undelete ${ids.length}`);
        return ids.map((id) => ({ id, success: true }));
      });
      vi.mocked(getJsforceConnection).mockResolvedValue({
        query,
        describe: vi.fn().mockResolvedValue(contactDescribe),
        sobject: vi.fn(() => ({ upsert })),
        soap: { undelete },
      } as never);
      return { order, upsert };
    }

    /** A backup's metadata, as `takeBackup` writes it. */
    function keepMeta(
      config: ConfigStore,
      operationId: string,
      objects: Array<Record<string, unknown>>,
      extra: Record<string, unknown> = {},
    ): void {
      config.set(
        `backup:${operationId}`,
        {
          operationId,
          orgId: 'org-1',
          objects,
          totalRecords: objects.reduce((sum, o) => sum + Number(o.recordCount), 0),
          timestamp: new Date(Date.now() - 60 * 60_000).toISOString(),
          ...extra,
        },
        'backups',
      );
    }

    it('restores a backup kept one record to a line, two hundred at a time, after the recycle bin', async () => {
      const { handler, deps, config, files } = createHarness();
      await files.store.begin('bk-lines', 'Contact');
      await files.store.append('bk-lines', 'Contact', contactsOf(450));
      keepMeta(config, 'bk-lines', [
        { objectApiName: 'Contact', recordCount: 450, orgCount: 450, truncated: false },
      ]);
      const { order, upsert } = restoringOrg(['003-7']);

      await handler.handle(rollbackMsg('bk-lines'));

      // Every deleted record is brought back before any is written over.
      expect(order).toEqual([
        'bin 200',
        'bin 200',
        'bin 50',
        'undelete 1',
        'upsert 200',
        'upsert 200',
        'upsert 50',
      ]);
      expect(upsert.mock.calls.flatMap(([batch]) => batch)).toEqual(contactsOf(450));
      expect(postedOf(deps, 'dataops:rollback:response')[0]?.payload).toMatchObject({
        status: 'success',
        message: 'Rollback completed: 450 records restored',
        totalRestored: 450,
      });
      expect(postedOf(deps, 'notification')).toHaveLength(0);
    });

    it('restores a backup file written as one array, as backups were before', async () => {
      const { handler, deps, config, files } = createHarness();
      files.files.set(
        path.join('/storage', 'backups', 'bk-array__Contact.json'),
        JSON.stringify(contactsOf(3)),
      );
      keepMeta(config, 'bk-array', [{ objectApiName: 'Contact', recordCount: 3 }]);
      const { upsert } = restoringOrg();

      await handler.handle(rollbackMsg('bk-array'));

      expect(upsert.mock.calls.flatMap(([batch]) => batch)).toEqual(contactsOf(3));
      expect(postedOf(deps, 'dataops:rollback:response')[0]?.payload).toMatchObject({
        status: 'success',
        totalRestored: 3,
      });
    });

    it('still reads backups written before the file store existed', async () => {
      const { handler, deps, config } = createHarness();
      keepMeta(config, 'bk-old', [{ objectApiName: 'Contact', recordCount: 2 }]);
      config.set('backup:bk-old:Contact', contactsOf(2), 'backups');
      const { upsert } = restoringOrg();

      await handler.handle(rollbackMsg('bk-old'));

      expect(upsert.mock.calls.flatMap(([batch]) => batch)).toEqual(contactsOf(2));
      // No "nothing to restore" bail-out — the legacy records were found.
      expect(deps.log).not.toHaveBeenCalledWith(expect.stringContaining('No backup records'));
    });

    it('says a backup stopped at the cap restored only part of the object, and left the rest as it is', async () => {
      const { handler, deps, config, files } = createHarness();
      await files.store.begin('bk-part', 'Contact');
      await files.store.append('bk-part', 'Contact', contactsOf(700));
      keepMeta(
        config,
        'bk-part',
        [
          {
            objectApiName: 'Contact',
            recordCount: 700,
            orgCount: 1_234,
            truncated: true,
            stoppedAt: 'cap',
          },
        ],
        { partial: true, cap: 700 },
      );
      restoringOrg();

      await handler.handle(rollbackMsg('bk-part'));

      const message =
        "Rollback completed: 700 records restored. The backup held only part of the org's " +
        'records, and the rest were left as they are: Contact 700 of 1234 (stopped at the cap).';
      expect(postedOf(deps, 'dataops:rollback:response')[0]?.payload).toMatchObject({
        status: 'success',
        partial: true,
        message,
      });
      // The page reads the notification channel, not the response.
      expect(postedOf(deps, 'notification')[0]?.payload).toMatchObject({
        level: 'warning',
        message,
      });
    });

    it('restores a backup whose read failed part-way, the rows it kept, and says the rest were left as they are', async () => {
      // The Restore tab offers it now, as the command line always could.
      const { handler, deps, config, files } = createHarness();
      await files.store.begin('bk-failed', 'Contact');
      await files.store.append('bk-failed', 'Contact', contactsOf(450));
      keepMeta(
        config,
        'bk-failed',
        [
          {
            objectApiName: 'Contact',
            recordCount: 450,
            orgCount: 1_234,
            truncated: true,
            stoppedAt: 'failure',
          },
        ],
        { status: 'failed', partial: true },
      );
      const { upsert } = restoringOrg();

      await handler.handle(rollbackMsg('bk-failed'));

      expect(upsert.mock.calls.flatMap(([batch]) => batch)).toEqual(contactsOf(450));
      const message =
        "Rollback completed: 450 records restored. The backup held only part of the org's " +
        'records, and the rest were left as they are: Contact 450 of 1234 (the read failed).';
      expect(postedOf(deps, 'dataops:rollback:response')[0]?.payload).toMatchObject({
        status: 'success',
        partial: true,
        message,
      });
      expect(postedOf(deps, 'notification')[0]?.payload).toMatchObject({
        level: 'warning',
        message,
      });
    });

    it('names in its warning each object the backup never reached, which a restore leaves as it is', async () => {
      const { handler, deps, config, files } = createHarness();
      await files.store.begin('bk-short', 'Contact');
      await files.store.append('bk-short', 'Contact', contactsOf(300));
      keepMeta(
        config,
        'bk-short',
        [
          { objectApiName: 'Contact', recordCount: 300, orgCount: 300, truncated: false },
          { objectApiName: 'Account', recordCount: 0, truncated: true, stoppedAt: 'not_reached' },
        ],
        { status: 'failed', partial: true },
      );
      restoringOrg();

      await handler.handle(rollbackMsg('bk-short'));

      const message =
        "Rollback completed: 300 records restored. The backup held only part of the org's " +
        'records, and the rest were left as they are: Account none (the backup stopped before it).';
      expect(postedOf(deps, 'dataops:rollback:response')[0]?.payload).toMatchObject({
        partial: true,
        message,
      });
      expect(postedOf(deps, 'notification')[0]?.payload).toMatchObject({ message });
    });

    it('says so when an object’s records are no longer on disk', async () => {
      const { handler, deps, config } = createHarness();
      keepMeta(config, 'bk-gone', [
        { objectApiName: 'Contact', recordCount: 450, orgCount: 450, truncated: false },
      ]);
      restoringOrg();

      await handler.handle(rollbackMsg('bk-gone'));

      expect(String(postedOf(deps, 'dataops:rollback:response')[0]?.payload.message)).toContain(
        'Contact 0 of the 450 it listed (not found on disk)',
      );
    });
  });
});
