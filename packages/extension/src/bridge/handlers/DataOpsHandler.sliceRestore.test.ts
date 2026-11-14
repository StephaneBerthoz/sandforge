import * as path from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { BaseMessage } from '@sandforge/shared';
import { DataOpsHandler } from './DataOpsHandler.js';
import type { HandlerDeps } from './HandlerTypes.js';
import { getJsforceConnection } from '../../core/connection/ConnectionHelper.js';
import { ProductionGuard } from '../../core/precheck/ProductionGuard.js';
import { BackgroundOperationRegistry } from '../../core/engine/BackgroundOperationRegistry.js';
import { ConfigStore } from '../../core/storage/ConfigStore.js';
import { InMemoryConfigStoreBackend } from '../../test/InMemoryConfigStoreBackend.js';
import { inboundRequest } from '../../test/mockFactories.js';
import { BackupRecordStore } from '../../modules/dataops/BackupRecordStore.js';
import { BackupSetStore } from '../../modules/dataops/slices/backupSet.js';
import { SlicedOrg, type SlicedRow } from '../../test/slicedOrg.js';

vi.mock('../../core/connection/ConnectionHelper.js', () => ({
  getJsforceConnection: vi.fn(),
}));

/*
 * A set of slices put back, listed, deleted and expired as one: a restore of
 * the set writes each slice back from its own snapshot, in their order, and
 * after a cancel carries on at the first slice not restored; a backup in
 * slices holds an object whole past what one snapshot holds; a slice is
 * deleted with its set alone; a backup held to a filter says so.
 */

const FIELDS = [
  'Id',
  'FirstName',
  'LastName',
  'Email',
  'Phone',
  'MailingStreet',
  'MailingCity',
  'MailingPostalCode',
  'Department',
  'CreatedDate',
];

function idOf(n: number): string {
  return `003${String(n).padStart(12, '0')}AAA`;
}

function contactsOf(count: number): SlicedRow[] {
  return Array.from({ length: count }, (_, i) => {
    const n = i + 1;
    return {
      Id: idOf(n),
      FirstName: `First${n}`,
      LastName: n % 2 === 0 ? `Even${n}` : `Odd${n}`,
      Email: `person${n}@example.com`,
      Phone: `+33 1 00 00 ${String(n % 100).padStart(2, '0')}`,
      MailingStreet: `${n} rue Example`,
      MailingCity: 'Example City',
      MailingPostalCode: '75000',
      Department: 'Unmasked',
      CreatedDate: '2020-01-01T00:00:00.000Z',
    } as SlicedRow;
  });
}

/** The fields a restore compares, as a row holds them. */
function valuesOf(row: SlicedRow | undefined): Record<string, unknown> {
  return Object.fromEntries(FIELDS.map((f) => [f, row?.[f]]));
}

function memoryBackups(files: Map<string, string>): BackupRecordStore {
  return new BackupRecordStore({
    storagePath: '/storage',
    readFile: async (p) => {
      const content = files.get(p);
      if (content === undefined) throw new Error('ENOENT');
      return content;
    },
    writeFile: async (p, content) => {
      files.set(p, content);
    },
    appendFile: async (p, content) => {
      files.set(p, (files.get(p) ?? '') + content);
    },
    exists: async (p) => files.has(p),
    readLines: async function* (p) {
      yield* (files.get(p) ?? '').split('\n');
    },
    mkdir: async () => undefined,
    rm: async (p) => {
      files.delete(p);
    },
    listFiles: async (dir) =>
      [...files.keys()]
        .filter((p) => path.dirname(p) === dir)
        .map((p) => ({ name: path.basename(p), modifiedMs: Date.now() })),
  });
}

type Posted = BaseMessage & { payload: Record<string, unknown> };

describe('DataOpsHandler — a set of slices restored, listed, deleted and expired as one', () => {
  let config: ConfigStore;
  let files: Map<string, string>;
  let registry: BackgroundOperationRegistry;
  let settings: Record<string, unknown>;
  let deps: HandlerDeps;
  let handler: DataOpsHandler;

  beforeEach(() => {
    vi.clearAllMocks();
    config = new ConfigStore(new InMemoryConfigStoreBackend());
    config.initialize();
    files = new Map();
    registry = new BackgroundOperationRegistry();
    settings = { 'backup.maxRecordsPerObject': 1000 };
    let ids = 0;
    deps = {
      log: vi.fn(),
      broker: { postToWebview: vi.fn() },
      stateSync: {},
      orgManager: { getOrg: vi.fn(() => ({ alias: 'ORG', orgType: 'Sandbox' })) },
      orgRegistry: {},
      configStore: config,
      secretVault: {},
      authProvider: {},
      sfdxBridge: {},
      services: {
        getSandforgeSetting: (key: string, fallback: unknown) => settings[key] ?? fallback,
      },
      infraServices: {
        productionGuard: new ProductionGuard({ requestConfirmation: vi.fn(async () => false) }),
        backgroundRegistry: registry,
      },
      nextId: () => String(++ids),
    } as unknown as HandlerDeps;
    handler = new DataOpsHandler(deps);
    handler.setBackupRecordStore(memoryBackups(files));
    handler.setDuplicatesSettle(0);
    handler.setOnCommandLine(true);
    handler.setTargetAutomation({
      read: async () => ({
        objectsRead: ['Contact'],
        objects: [],
        unread: [],
        conditionsNotRead: 0,
        conditionsBound: 0,
        requests: 0,
      }),
    });
  });

  function orgOf(rows: SlicedRow[], options: ConstructorParameters<typeof SlicedOrg>[1] = {}) {
    const org = new SlicedOrg(rows, { fields: FIELDS, ...options });
    vi.mocked(getJsforceConnection).mockResolvedValue(org.connection as never);
    return org;
  }

  async function send(type: string, payload: Record<string, unknown>, id: string): Promise<void> {
    await handler.handle(
      inboundRequest({ id, type, timestamp: Date.now(), payload } as BaseMessage),
    );
  }

  function last(type: string): Posted | undefined {
    return (deps.broker.postToWebview as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => c[0] as Posted)
      .filter((m) => m.type === type)
      .at(-1);
  }

  /** Mask 2,500 contacts in slices of 1,000, as set `run-1`; the rows as they were before. */
  async function maskedInSlices(): Promise<{ org: SlicedOrg; before: SlicedRow[] }> {
    const rows = contactsOf(2500);
    const before = rows.map((row) => ({ ...row }));
    const org = orgOf(rows);
    await send(
      'dataops:anonymize',
      {
        orgId: 'org-1',
        templateId: 'tpl-gdpr-standard',
        objects: ['Contact'],
        snapshot: true,
        slices: true,
      },
      'run-1',
    );
    expect(last('dataops:anonymize:response')?.payload).toMatchObject({ status: 'success' });
    return { org, before };
  }

  it('restores a whole set from its slices, each from its own snapshot, every value as it was (T9)', async () => {
    const { org, before } = await maskedInSlices();
    expect(org.row(idOf(1))?.Email).not.toBe('person1@example.com');

    await send('dataops:rollback', { orgId: 'org-1', operationId: 'run-1' }, 'restore-1');

    const answer = last('dataops:rollback:response')?.payload as {
      status: string;
      totalRestored: number;
      slices: Array<{ index: number; restored: number }>;
    };
    expect(answer.status).toBe('success');
    expect(answer.totalRestored).toBe(2500);
    expect(answer.slices.map((s) => [s.index, s.restored])).toEqual([
      [1, 1000],
      [2, 1000],
      [3, 500],
    ]);
    for (const row of before) expect(valuesOf(org.row(row.Id))).toEqual(valuesOf(row));
    const set = new BackupSetStore(config).get('run-1');
    expect(set?.objects[0].slices.every((s) => s.state === 'restored' && s.restoredAt)).toBe(true);
  });

  it('carries a restore cancelled after its first slice on at the second, never reading the first again (T9)', async () => {
    const { org, before } = await maskedInSlices();
    org.journal.length = 0;
    let stopped = false;
    const slice2 = idOf(1001);
    vi.mocked(getJsforceConnection).mockResolvedValue({
      ...org.connection,
      query: async (soql: string, options?: unknown) => {
        if (!stopped && soql.includes('IsDeleted = true') && soql.includes(slice2)) {
          stopped = true;
          registry.abort('restore-1');
        }
        return (org.connection.query as (s: string, o?: unknown) => Promise<unknown>)(
          soql,
          options,
        );
      },
    } as never);

    await send('dataops:rollback', { orgId: 'org-1', operationId: 'run-1' }, 'restore-1');

    expect(last('dataops:rollback:response')?.payload).toMatchObject({ cancelled: true });
    expect(org.row(idOf(1))?.Email).toBe('person1@example.com');
    expect(org.row(idOf(1500))?.Email).not.toBe('person1500@example.com');

    vi.mocked(getJsforceConnection).mockResolvedValue(org.connection as never);
    org.journal.length = 0;
    await send('dataops:rollback', { orgId: 'org-1', operationId: 'run-1' }, 'restore-2');

    expect(last('dataops:rollback:response')?.payload).toMatchObject({
      status: 'success',
      slices: [
        expect.objectContaining({ index: 1, skipped: true }),
        expect.objectContaining({ index: 2, restored: 1000 }),
        expect.objectContaining({ index: 3, restored: 500 }),
      ],
    });
    const firstSlice = new Set(before.slice(0, 1000).map((r) => r.Id));
    const read = org.journal.flatMap((c) =>
      [...(c.soql ?? '').matchAll(/'(003\w+)'/g)].map((m) => m[1]),
    );
    expect(read.some((id) => firstSlice.has(id))).toBe(false);
    for (const row of before) expect(valuesOf(org.row(row.Id))).toEqual(valuesOf(row));
  });

  it('restores the slices asked for, and refuses one the set does not hold or a set restored already', async () => {
    const { org } = await maskedInSlices();

    await send(
      'dataops:rollback',
      { orgId: 'org-1', operationId: 'run-1', slices: [2] },
      'restore-2',
    );
    expect(org.row(idOf(1500))?.Email).toBe('person1500@example.com');
    expect(org.row(idOf(1))?.Email).not.toBe('person1@example.com');

    await send(
      'dataops:rollback',
      { orgId: 'org-1', operationId: 'run-1', slices: [9] },
      'restore-9',
    );
    expect(last('dataops:error')?.payload).toMatchObject({ code: 'SLICE_NOT_FOUND' });

    await send('dataops:rollback', { orgId: 'org-1', operationId: 'run-1' }, 'restore-all');
    await send('dataops:rollback', { orgId: 'org-1', operationId: 'run-1' }, 'restore-again');
    expect(last('dataops:error')?.payload).toMatchObject({ code: 'NOTHING_TO_RESTORE' });
    expect(String(last('dataops:error')?.payload.message)).toContain('--rewrite-all');
  });

  it('refuses to restore a masking set still open, naming the abandon first', async () => {
    orgOf(contactsOf(2500));
    await send(
      'dataops:anonymize',
      {
        orgId: 'org-1',
        templateId: 'tpl-gdpr-standard',
        objects: ['Contact'],
        snapshot: true,
        slices: true,
        maxRequests: 12,
      },
      'run-1',
    );

    await send('dataops:rollback', { orgId: 'org-1', operationId: 'run-1' }, 'restore-1');

    expect(last('dataops:error')?.payload).toMatchObject({ code: 'SLICE_RUN_OPEN' });
    expect(String(last('dataops:error')?.payload.message)).toContain(
      'Give it up first (--abandon)',
    );
  });

  it('backs up an object past one snapshot in slices, lists the set as one entry, and restores it with nothing to write', async () => {
    const org = orgOf(contactsOf(2500));

    await send('backup:execute', { orgId: 'org-1', objects: ['Contact'], slices: true }, 'bk-1');

    expect(last('dataops:backup:response')?.payload).toMatchObject({
      status: 'completed',
      totalRecords: 2500,
      slices: { setId: 'bk-1', state: 'done', slicesLeft: false },
    });
    await send('backup:list', { orgId: 'org-1' }, 'list-1');
    const list = last('backup:list:result')?.payload as {
      backups: unknown[];
      sets: Array<{ setId: string; kind: string; slices: unknown[]; totalRecords: number }>;
    };
    expect(list.backups).toEqual([]);
    expect(list.sets).toEqual([
      expect.objectContaining({ setId: 'bk-1', kind: 'backup', totalRecords: 2500 }),
    ]);
    expect(list.sets[0].slices).toHaveLength(3);

    org.journal.length = 0;
    await send('dataops:rollback', { orgId: 'org-1', operationId: 'bk-1' }, 'restore-1');
    expect(last('dataops:rollback:response')?.payload).toMatchObject({
      totalRestored: 0,
      totalUnchanged: 2500,
    });
    expect(org.journal.some((c) => c.kind === 'upsert')).toBe(false);
  });

  it('refuses to delete a slice alone, and deletes a set whole: its slices, their files, its manifest', async () => {
    orgOf(contactsOf(2500));
    await send('backup:execute', { orgId: 'org-1', objects: ['Contact'], slices: true }, 'bk-1');

    await send('backup:delete', { orgId: 'org-1', operationIds: ['bk-1-s0002'] }, 'del-1');
    expect(last('dataops:error')?.payload).toMatchObject({ code: 'SLICE_DELETE_ALONE' });
    expect(config.get('backup:bk-1-s0002')).toBeDefined();

    await send('backup:delete', { orgId: 'org-1', operationIds: ['bk-1'] }, 'del-2');
    expect(last('backup:delete:result')?.payload).toEqual({ orgId: 'org-1', deleted: ['bk-1'] });
    expect(config.getKeysByPrefix('backup:bk-1')).toEqual([]);
    expect(new BackupSetStore(config).get('bk-1')).toBeUndefined();
    expect([...files.keys()].filter((f) => f.includes('bk-1'))).toEqual([]);
  });

  it('expires a set whole by when it last moved, an open one among them', async () => {
    settings['backup.maxAgeDays'] = 1;
    orgOf(contactsOf(2500));
    await handler.swept();
    // The retention takes what was taken since it first ran here.
    config.set('backupRetention:since', '2026-11-01T00:00:00.000Z');
    await send('backup:execute', { orgId: 'org-1', objects: ['Contact'], slices: true }, 'bk-1');
    const sets = new BackupSetStore(config);
    const set = sets.get('bk-1');
    if (!set) throw new Error('no set');
    sets.save({ ...set, state: 'open', lastActivityAt: '2026-11-10T00:00:00.000Z' });

    await handler.sweepBackupFiles(Date.parse('2026-11-14T00:00:00.000Z'));

    expect(sets.get('bk-1')).toBeUndefined();
    expect(config.getKeysByPrefix('backup:bk-1')).toEqual([]);
    expect(deps.log).toHaveBeenCalledWith(
      '[INFO] Removed set of slices bk-1: last moved more than 1 day(s) ago, its run left open and now over',
    );
  });

  it('backs up each object under its filter, keeps the filter, and a masking coverage does not count it (T14)', async () => {
    const org = orgOf(contactsOf(10));

    await send(
      'backup:execute',
      { orgId: 'org-1', objects: ['Contact'], wheres: { contact: "LastName LIKE 'Even%'" } },
      'bk-1',
    );

    expect(org.journal.find((c) => c.kind === 'query')?.soql).toContain(
      "FROM Contact WHERE (LastName LIKE 'Even%')",
    );
    expect(config.get('backup:bk-1')).toMatchObject({
      totalRecords: 5,
      objects: [{ objectApiName: 'Contact', where: "LastName LIKE 'Even%'" }],
    });
    await send(
      'dataops:anonymize:coverage',
      { orgId: 'org-1', templateId: 'tpl-gdpr-standard', objects: ['Contact'] },
      'cov-1',
    );
    expect(
      (last('dataops:anonymize:coverage:response')?.payload.objects as unknown[])[0],
    ).toMatchObject({
      backedUp: 0,
      filtered: true,
    });
    await send(
      'dataops:anonymize:coverage',
      {
        orgId: 'org-1',
        templateId: 'tpl-gdpr-standard',
        objects: ['Contact'],
        where: "LastName LIKE 'Even%'",
      },
      'cov-2',
    );
    expect(
      (last('dataops:anonymize:coverage:response')?.payload.objects as unknown[])[0],
    ).toMatchObject({
      count: 5,
      backedUp: 5,
    });
  });

  it('refuses a filter on an object the backup does not read, and one that does more than filter (T14)', async () => {
    const org = orgOf(contactsOf(3));

    await send(
      'backup:execute',
      { orgId: 'org-1', objects: ['Contact'], wheres: { Lead: "Status = 'Open'" } },
      'bk-1',
    );
    expect(last('dataops:error')?.payload).toMatchObject({ code: 'INVALID_PAYLOAD' });
    await send(
      'backup:execute',
      { orgId: 'org-1', objects: ['Contact'], wheres: { Contact: 'Name = null LIMIT 1' } },
      'bk-2',
    );
    expect(last('dataops:error')?.payload).toMatchObject({ code: 'INVALID_PAYLOAD' });
    expect(org.journal).toEqual([]);
  });
});
