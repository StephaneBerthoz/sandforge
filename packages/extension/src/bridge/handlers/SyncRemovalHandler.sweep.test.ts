import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  BaseMessage,
  ForgeSweepListing,
  ForgeTargetAutomation,
  SyncRemovalResult,
} from '@sandforge/shared';

import { SyncRemovalHandler } from './SyncRemovalHandler.js';
import type { HandlerDeps, InboundRequest } from './HandlerTypes.js';
import { BackgroundOperationRegistry } from '../../core/engine/BackgroundOperationRegistry.js';
import { ProductionGuard } from '../../core/precheck/ProductionGuard.js';
import { ConfigStore } from '../../core/storage/ConfigStore.js';
import { AuditTrailStore } from '../../modules/audit/auditTrail.js';
import {
  writePathOrderDefects,
  type WritePathStep,
} from '../../modules/checkpoint/beforeRunCheckpoint.js';
import { BackupRecordStore, nodeBackupFiles } from '../../modules/dataops/BackupRecordStore.js';
import { nodeSyncRunCreations } from '../../modules/sync/SyncRunCreations.js';
import { InMemoryConfigStoreBackend } from '../../test/InMemoryConfigStoreBackend.js';
import { compositeOver } from '../../test/compositeOver.js';
import { memoryPermissionOrg } from '../../test/memoryPermissionOrg.js';
import { addSyncedQuote, tiedTargetOrg, type TiedTargetOrg } from '../../test/tiedTargetOrg.js';
import { inboundRequest } from '../../test/mockFactories.js';

vi.mock('../../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../core/connection/ConnectionHelper.js', () => ({
  getJsforceConnection: vi.fn(),
}));
vi.mock('../../core/common/sforceLimitParser.js', () => ({
  checkApiLimits: vi.fn(),
}));

import { getJsforceConnection } from '../../core/connection/ConnectionHelper.js';

/** A fake record id: the object's prefix, then a counter. */
const id = (prefix: string, n: number): string => `${prefix}${String(n).padStart(12, '0')}AAA`;

const TARGET_ORG = 'org-dev';

/** The run as the target dated its inserts, and as this machine's clock saw it. */
const WRITTEN = '2026-09-20T10:02:00.000+0000';
const WRITTEN_AT = '2026-09-20T10:02:00.000Z';
const STARTED = '2026-09-20T10:01:50.000Z';
/** Half a minute after the run's last insert: what a flow on the contact writes. */
const JUST_AFTER = '2026-09-20T10:02:30.000+0000';
const LONG_AFTER = '2026-09-20T12:00:00.000+0000';

/** The user the run wrote as, and the session to the target writes as. */
const USER = id('005', 1);

const ACCOUNT = id('001', 1);
const CONTACT = id('003', 1);
const FLOW_TASK = id('00T', 1);
const TYPED_TASK = id('00T', 2);

type Row = Record<string, unknown> & { Id: string };

/** A record created by `by` at `created`, untouched since. */
const rec = (recordId: string, name: string, by: string, created: string, extra = {}): Row => ({
  Id: recordId,
  Name: name,
  CreatedById: by,
  CreatedDate: created,
  LastModifiedDate: created,
  LastModifiedById: by,
  ...extra,
});

/**
 * The target after a Sync of an account and a contact under it: the task a
 * flow opened on the contact as the run wrote it — the trap's flow does it for
 * every contact — and a task the run's user typed hours later. Answers the
 * removal's reads and the sweep's as jsforce shows them.
 */
function targetOrg() {
  const rows = new Map<string, Row[]>([
    ['Account', [rec(ACCOUNT, 'Synced Co', USER, WRITTEN)]],
    ['Contact', [rec(CONTACT, 'Synced Person', USER, WRITTEN, { AccountId: ACCOUNT })]],
    [
      'Task',
      [
        rec(FLOW_TASK, 'Follow up', USER, JUST_AFTER, { WhoId: CONTACT }),
        rec(TYPED_TASK, 'Typed later', USER, LONG_AFTER),
      ],
    ],
  ]);
  const children = new Map([
    ['Account', [{ childSObject: 'Contact', field: 'AccountId', cascadeDelete: false }]],
    ['Contact', [{ childSObject: 'Task', field: 'WhoId', cascadeDelete: false }]],
  ]);
  /** The lookups a tie is read from, per object, to the objects each names. */
  const lookups = new Map<string, Record<string, string[]>>([
    ['Contact', { AccountId: ['Account'] }],
    ['Task', { WhoId: ['Contact'], WhatId: ['Account'] }],
  ]);
  const bin = new Map<string, Row>();
  const pick = (row: Row, columns: string): Record<string, unknown> =>
    Object.fromEntries(columns.split(', ').map((c) => [c, row[c]]));
  const drop = (object: string, recordId: string): void => {
    const row = (rows.get(object) ?? []).find((r) => r.Id === recordId);
    if (!row) return;
    rows.set(
      object,
      (rows.get(object) ?? []).filter((r) => r.Id !== recordId),
    );
    bin.set(recordId, { ...row, object });
  };
  const query = vi.fn(async (soql: string, options?: { scanAll?: boolean }) => {
    const answer = (records: unknown[]) => ({ totalSize: records.length, done: true, records });
    const deleted = /^SELECT Id FROM \w+ WHERE Id IN \((.*)\) AND IsDeleted = true$/.exec(soql);
    if (deleted) {
      const wanted = deleted[1].split(', ').map((q) => q.slice(1, -1));
      return answer(
        wanted.filter((x) => options?.scanAll === true && bin.has(x)).map((Id) => ({ Id })),
      );
    }
    const created =
      /^SELECT (.+) FROM (\w+) WHERE CreatedById = '(\w+)' AND CreatedDate >= (\S+) AND CreatedDate <= (\S+?)(?: AND Id > '(\w+)')?(?: ORDER BY Id LIMIT \d+)?$/.exec(
        soql,
      );
    if (created) {
      const [, columns, object, user, from, to, after] = created;
      const found = (rows.get(object) ?? []).filter((row) => {
        const at = Date.parse(String(row.CreatedDate));
        return (
          row.CreatedById === user &&
          at >= Date.parse(from) &&
          at <= Date.parse(to) &&
          (!after || row.Id > after)
        );
      });
      if (columns === 'COUNT()') return { totalSize: found.length, done: true, records: [] };
      return answer(found.map((row) => pick(row, columns)));
    }
    const match = /^SELECT (.+) FROM (\w+) WHERE (\w+) IN \((.*)\)(?: LIMIT \d+)?$/.exec(soql);
    if (!match) throw new Error(`unexpected query: ${soql}`);
    const [, columns, object, field, list] = match;
    const wanted = new Set(list.split(', ').map((q) => q.slice(1, -1)));
    const held = [
      ...(rows.get(object) ?? []),
      ...(options?.scanAll ? [...bin.values()].filter((row) => row.object === object) : []),
    ];
    return answer(
      held.filter((row) => wanted.has(String(row[field]))).map((row) => pick(row, columns)),
    );
  });
  const conn = {
    limitInfo: undefined,
    // The sweep's counts go five to a composite, each answered as a query.
    ...compositeOver(query),
    query,
    describe: vi.fn(async (object: string) => ({
      name: object,
      label: object,
      queryable: true,
      deletable: true,
      fields: [
        ...['Id', 'Name', 'CreatedById', 'CreatedDate', 'LastModifiedDate', 'LastModifiedById'].map(
          (name) => ({ name, label: name, type: 'string', nameField: name === 'Name' }),
        ),
        ...Object.entries(lookups.get(object) ?? {}).map(([name, referenceTo]) => ({
          name,
          label: name,
          type: 'reference',
          referenceTo,
        })),
      ],
      childRelationships: children.get(object) ?? [],
    })),
    describeGlobal: vi.fn(async () => ({
      sobjects: [...rows.keys()].map((name) => ({
        name,
        label: name,
        queryable: true,
        createable: true,
        layoutable: true,
      })),
    })),
    soap: {
      getServerTimestamp: vi.fn(async () => ({ timestamp: new Date().toISOString() })),
      getUserInfo: vi.fn(async () => ({ userId: USER })),
    },
    sobject: (object: string) => ({
      destroy: vi.fn(async (ids: string[]) =>
        ids.map((recordId) => {
          if (!(rows.get(object) ?? []).some((r) => r.Id === recordId)) {
            return {
              id: recordId,
              success: false,
              errors: [{ statusCode: 'ENTITY_IS_DELETED', message: 'gone' }],
            };
          }
          drop(object, recordId);
          return { id: recordId, success: true, errors: [] };
        }),
      ),
      // Stamped now, as written by the session's user.
      update: vi.fn(async (records: Array<Record<string, unknown>>) =>
        records.map((record) => {
          const row = (rows.get(object) ?? []).find((r) => r.Id === record.Id);
          if (row) {
            Object.assign(row, record, {
              LastModifiedDate: new Date().toISOString(),
              LastModifiedById: USER,
            });
          }
          return { id: record.Id, success: row !== undefined, errors: [] };
        }),
      ),
    }),
  };
  return { conn, rows };
}

/** What the target runs on the run's objects: a contact flow that opens a task, as the trap's. */
const AUTOMATION = {
  objectsRead: ['Account', 'Contact'],
  objects: [
    {
      objectApiName: 'Contact',
      flows: [
        {
          apiName: 'Follow_Up',
          label: 'Follow up',
          timing: 'afterSave',
          startsOn: 'create',
          condition: 'read',
          permissions: [],
          creates: ['Task'],
        },
      ],
      triggers: [],
    },
  ],
  unread: [],
} as unknown as ForgeTargetAutomation;

/** What a deleted record fires, which `Data_Load` keeps quiet. */
const ON_DELETE = {
  objectsRead: ['Account', 'Contact', 'Case'],
  objects: [
    {
      objectApiName: 'Contact',
      flows: [
        {
          apiName: 'Contact_Gone',
          label: 'Contact gone',
          timing: 'afterSave',
          startsOn: 'delete',
          condition: 'read',
          permissions: [{ name: 'Load_Data', bypass: true }],
        },
      ],
      triggers: [],
    },
  ],
  bypassGrants: [
    {
      permission: 'Load_Data',
      permissionSets: [{ name: 'Data_Load', label: 'Data load', grants: 1 }],
    },
  ],
  unread: [],
} as unknown as ForgeTargetAutomation;

/** The objects the permission org answers for: the mute's reads of the permission sets. */
const PERMISSION_OBJECTS =
  /\bFROM\s+(Organization|UserPermissionAccess|PermissionSetAssignment|SetupEntityAccess|ObjectPermissions|CustomPermission|PermissionSet)\b/i;

/**
 * The tied org with permission sets to assign: a lease's reads and writes go
 * to `permissions`, the rest to `tied`, as one connection answers both, each
 * of the lease's writes put down among the org's events.
 */
function leasedConnection(tied: TiedTargetOrg, user: string) {
  const permissions = memoryPermissionOrg({
    userId: user,
    sets: [{ id: '0PS000000000001AAA', name: 'Data_Load' }],
    beforeWrite: (write) => {
      (tied.events as string[]).push(write.kind === 'insert' ? 'leaseAcquire' : 'leaseRelease');
    },
  });
  const conn = {
    ...tied.conn,
    identity: permissions.connection.identity,
    query: (soql: string, options?: { scanAll?: boolean }) =>
      PERMISSION_OBJECTS.test(soql)
        ? permissions.connection.query(soql)
        : tied.conn.query(soql, options),
    sobject: (name: string) =>
      name === 'PermissionSetAssignment'
        ? permissions.connection.sobject(name)
        : tied.conn.sobject(name),
  };
  return { conn, permissions };
}

function buildMsg(type: string, payload?: unknown): InboundRequest {
  return inboundRequest({
    id: `req-${type}`,
    type,
    timestamp: Date.now(),
    ...(payload !== undefined ? { payload } : {}),
  } as BaseMessage);
}

describe('a sweep asked with the removal of a Sync run', () => {
  let storage: string;
  let deps: HandlerDeps;
  let store: ConfigStore;
  let handler: SyncRemovalHandler;
  let org: ReturnType<typeof targetOrg>;
  let read: ReturnType<
    typeof vi.fn<(orgId: string, objects: readonly string[]) => Promise<ForgeTargetAutomation>>
  >;

  const posted = <T extends BaseMessage>(type: string): T[] =>
    vi
      .mocked(deps.broker.postToWebview)
      .mock.calls.map(([m]) => m as T)
      .filter((m) => m.type === type);
  const answer = (): SyncRemovalResult | undefined =>
    posted<BaseMessage & { payload: { result: SyncRemovalResult } }>('sync:remove:response')[0]
      ?.payload.result;
  const errors = (type = 'sync:remove:error') =>
    posted<BaseMessage & { payload: { code: string; message: string } }>(type);
  const ids = (object: string): string[] => (org.rows.get(object) ?? []).map((row) => row.Id);

  beforeEach(async () => {
    vi.clearAllMocks();
    // This machine's clock held still: the org's clock answers with it, and a
    // runner under load would otherwise read the org a second behind, the
    // half of a slow round trip, and move the window.
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() });
    storage = mkdtempSync(join(tmpdir(), 'sandforge-sync-sweep-'));
    store = new ConfigStore(new InMemoryConfigStoreBackend());
    store.initialize();
    let n = 0;
    deps = {
      log: vi.fn(),
      broker: { postToWebview: vi.fn() } as unknown as HandlerDeps['broker'],
      stateSync: {} as HandlerDeps['stateSync'],
      orgManager: {
        getOrg: vi.fn().mockReturnValue({ orgType: 'Sandbox', alias: 'DEV' }),
      } as unknown as HandlerDeps['orgManager'],
      orgRegistry: {} as HandlerDeps['orgRegistry'],
      configStore: store,
      secretVault: {} as HandlerDeps['secretVault'],
      authProvider: {} as HandlerDeps['authProvider'],
      sfdxBridge: {} as HandlerDeps['sfdxBridge'],
      infraServices: {
        productionGuard: new ProductionGuard(),
      } as unknown as HandlerDeps['infraServices'],
      nextId: () => String(++n),
    };
    const runs = nodeSyncRunCreations(storage);
    const recorder = runs.recorder({
      runId: 'run-sync',
      configId: 'cfg-1',
      configName: 'Contacts',
      sourceOrgId: 'org-source',
      targetOrgId: TARGET_ORG,
      startedAt: STARTED,
    });
    // Dated by this machine's clock as the target dated them: the two clocks
    // agree, as the org's clock the sweep reads says.
    recorder.note('Account', [ACCOUNT], WRITTEN_AT);
    recorder.note('Contact', [CONTACT], WRITTEN_AT);
    await recorder.end({ status: 'success' });
    handler = new SyncRemovalHandler(deps, { list: () => [] }, () => false);
    handler.setRunCreations(runs);
    read = vi.fn(async (_orgId: string, _objects: readonly string[]) => AUTOMATION);
    handler.setTargetAutomation({ read });
    org = targetOrg();
    vi.mocked(getJsforceConnection).mockResolvedValue(org.conn as never);
  });

  afterEach(() => {
    vi.useRealTimers();
    rmSync(storage, { recursive: true, force: true });
  });

  it('lists the task the flow opened during the run, in the window its records were dated, read only', async () => {
    await handler.handle(buildMsg('sync:remove:sweep', { runId: 'run-sync' }));

    expect(errors('sync:remove:sweep:error')).toEqual([]);
    const [response] = posted<BaseMessage & { payload: { listing: ForgeSweepListing } }>(
      'sync:remove:sweep:response',
    );
    const listing = response.payload.listing;
    expect(listing.refusal).toBeUndefined();
    expect(listing.window).toEqual({ from: '2026-09-20T10:01:59Z', to: '2026-09-20T10:03:00Z' });
    expect(listing.found).toEqual([
      expect.objectContaining({ objectApiName: 'Task', count: 1, names: ['Follow up'] }),
    ]);
    expect(read).toHaveBeenCalledWith(TARGET_ORG, ['Account', 'Contact']);
    expect(ids('Task')).toEqual([FLOW_TASK, TYPED_TASK]);
  });

  it('sweeps the task before the run’s records go, and the typed one stays', async () => {
    await handler.handle(buildMsg('sync:remove', { runId: 'run-sync', sweep: true }));

    expect(errors()).toEqual([]);
    expect(answer()).toMatchObject({
      status: 'success',
      sweep: {
        status: 'success',
        objects: [expect.objectContaining({ objectApiName: 'Task', deleted: 1 })],
      },
      objects: [
        { objectApiName: 'Contact', planned: 1, deleted: 1 },
        { objectApiName: 'Account', planned: 1, deleted: 1 },
      ],
    });
    expect(ids('Task')).toEqual([TYPED_TASK]);
    expect(ids('Contact')).toEqual([]);
    expect(ids('Account')).toEqual([]);
    // The sweep is recorded beside the removal, from Sync.
    const trail = new AuditTrailStore(store).list().entries;
    expect(trail.map((entry) => [entry.operationId, entry.module]).sort()).toEqual([
      ['req-sync:remove', 'sync'],
      ['req-sync:remove-sweep', 'sync'],
    ]);
  });

  it('leaves the task the flow opened to a removal asked without the sweep', async () => {
    await handler.handle(buildMsg('sync:remove', { runId: 'run-sync' }));

    expect(answer()?.sweep).toBeUndefined();
    expect(ids('Task')).toEqual([FLOW_TASK, TYPED_TASK]);
  });

  it('looks from the run’s first write, an update before its first creation, read on the org’s clock', async () => {
    // A run that updated the account, then inserted its contact: the task a
    // flow opened on the account's update came before the contact was
    // created, and a window begun at the creation left it behind.
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      // This machine's clock stands five minutes behind the org's.
      const behind = 5 * 60_000;
      vi.setSystemTime(new Date(Date.parse('2026-09-20T10:00:10.000Z') - behind));
      const runs = nodeSyncRunCreations(storage);
      const recorder = runs.recorder({
        runId: 'run-update-first',
        configId: 'cfg-1',
        configName: 'Accounts then contacts',
        sourceOrgId: 'org-source',
        targetOrgId: TARGET_ORG,
      });
      recorder.writing?.('Account', 1);
      vi.setSystemTime(new Date(Date.parse(WRITTEN) - behind));
      recorder.sending?.('Contact', 1);
      recorder.answered?.('Contact', [CONTACT]);
      await recorder.end({ status: 'success' });
      org.rows.get('Task')?.push(
        rec(id('00T', 3), 'Account updated', USER, '2026-09-20T10:00:30.000+0000', {
          WhatId: ACCOUNT,
        }),
      );
      vi.setSystemTime(new Date('2026-10-01T08:00:00.000Z'));
      org.conn.soap.getServerTimestamp.mockImplementation(async () => ({
        timestamp: new Date(Date.now() + behind).toISOString(),
      }));

      await handler.handle(buildMsg('sync:remove:sweep', { runId: 'run-update-first' }));
    } finally {
      vi.useRealTimers();
    }

    expect(errors('sync:remove:sweep:error')).toEqual([]);
    const [response] = posted<BaseMessage & { payload: { listing: ForgeSweepListing } }>(
      'sync:remove:sweep:response',
    );
    expect(response.payload.listing.window).toEqual({
      from: '2026-09-20T10:00:09Z',
      to: '2026-09-20T10:03:00Z',
    });
    expect(response.payload.listing.found).toEqual([
      expect.objectContaining({ objectApiName: 'Task', count: 2 }),
    ]);
  });

  it('looks to the run’s last write, an update after its last creation, read on the org’s clock', async () => {
    // A run that inserted its contact, then updated the account three
    // minutes later: the task a flow opened on the update came more than a
    // minute after the last record the run created, and a window ended there
    // left it behind.
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      // This machine's clock stands five minutes behind the org's.
      const behind = 5 * 60_000;
      vi.setSystemTime(new Date(Date.parse(WRITTEN) - behind));
      const runs = nodeSyncRunCreations(storage);
      const recorder = runs.recorder({
        runId: 'run-update-last',
        configId: 'cfg-1',
        configName: 'Contacts then accounts',
        sourceOrgId: 'org-source',
        targetOrgId: TARGET_ORG,
      });
      recorder.sending?.('Contact', 1);
      recorder.answered?.('Contact', [CONTACT]);
      vi.setSystemTime(new Date(Date.parse('2026-09-20T10:05:00.000Z') - behind));
      recorder.writing?.('Account', 1);
      await recorder.end({ status: 'success' });
      org.rows.get('Task')?.push(
        rec(id('00T', 4), 'Account updated', USER, '2026-09-20T10:05:30.000+0000', {
          WhatId: ACCOUNT,
        }),
      );
      vi.setSystemTime(new Date('2026-10-01T08:00:00.000Z'));
      org.conn.soap.getServerTimestamp.mockImplementation(async () => ({
        timestamp: new Date(Date.now() + behind).toISOString(),
      }));

      await handler.handle(buildMsg('sync:remove:sweep', { runId: 'run-update-last' }));
    } finally {
      vi.useRealTimers();
    }

    expect(errors('sync:remove:sweep:error')).toEqual([]);
    const [response] = posted<BaseMessage & { payload: { listing: ForgeSweepListing } }>(
      'sync:remove:sweep:response',
    );
    expect(response.payload.listing.window).toEqual({
      from: '2026-09-20T10:01:59Z',
      to: '2026-09-20T10:06:00Z',
    });
    expect(response.payload.listing.found).toEqual([
      expect.objectContaining({ objectApiName: 'Task', count: 2 }),
    ]);
  });

  describe('a run that created nothing and only wrote over an account', () => {
    /**
     * The run's two lines, by this machine's clock, which agrees with the org's
     * here but for the few milliseconds the read of the org's clock takes: half
     * a second from a whole second, so that drift never moves the window's edges.
     */
    const WROTE_AT = '2026-09-20T11:00:00.500Z';
    const ANSWERED_AT = '2026-09-20T11:00:04.500Z';
    const BACKUP = 'sync-before-run-over-only';
    /** What a flow on the account's update opened, as the run's user, twenty seconds in. */
    const UPDATE_TASK = id('00T', 5);

    beforeEach(async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      try {
        const backups = new BackupRecordStore(nodeBackupFiles(storage));
        await backups.begin(BACKUP, 'Account');
        await backups.append(BACKUP, 'Account', [{ Id: ACCOUNT, Name: 'Before' }]);
        handler.setBackupRecordStore(backups);
        const runs = nodeSyncRunCreations(storage);
        handler.setRunCreations(runs);
        vi.setSystemTime(new Date(WROTE_AT));
        const recorder = runs.recorder({
          runId: 'run-over-only',
          configId: 'cfg-1',
          configName: 'Accounts',
          sourceOrgId: 'org-source',
          targetOrgId: TARGET_ORG,
        });
        recorder.overwriting?.('Account', BACKUP, [ACCOUNT]);
        vi.setSystemTime(new Date(ANSWERED_AT));
        recorder.overwrote?.('Account', []);
        await recorder.end({ status: 'success' });
      } finally {
        vi.useRealTimers();
      }
      // The account as the run left it, written by its user; the task the
      // update flow opened.
      Object.assign(org.rows.get('Account')?.[0] ?? {}, {
        Name: 'After',
        LastModifiedDate: '2026-09-20T11:00:01.000+0000',
        LastModifiedById: USER,
      });
      org.rows.get('Task')?.push(
        rec(UPDATE_TASK, 'Account updated', USER, '2026-09-20T11:00:20.000+0000', {
          WhatId: ACCOUNT,
        }),
      );
    });

    it('lists, in the window its writes were dated, the task the update flow opened, its user read from the account', async () => {
      await handler.handle(buildMsg('sync:remove:sweep', { runId: 'run-over-only' }));

      expect(errors('sync:remove:sweep:error')).toEqual([]);
      const [response] = posted<BaseMessage & { payload: { listing: ForgeSweepListing } }>(
        'sync:remove:sweep:response',
      );
      expect(response.payload.listing.refusal).toBeUndefined();
      expect(response.payload.listing.window).toEqual({
        from: '2026-09-20T10:59:59Z',
        to: '2026-09-20T11:01:05Z',
      });
      expect(response.payload.listing.found).toEqual([
        expect.objectContaining({ objectApiName: 'Task', count: 1, names: ['Account updated'] }),
      ]);
      // What the target runs on the object it wrote over is read: its update flows.
      expect(read).toHaveBeenCalledWith(TARGET_ORG, ['Account']);
    });

    it('sweeps that task as its removal gives the account its values back, its user read before', async () => {
      await handler.handle(buildMsg('sync:remove', { runId: 'run-over-only', sweep: true }));

      expect(errors()).toEqual([]);
      expect(answer()).toMatchObject({
        status: 'success',
        restored: [{ objectApiName: 'Account', planned: 1, restored: 1 }],
        sweep: {
          status: 'success',
          objects: [expect.objectContaining({ objectApiName: 'Task', deleted: 1 })],
        },
      });
      expect(org.rows.get('Account')?.[0]).toMatchObject({ Id: ACCOUNT, Name: 'Before' });
      expect(ids('Task')).toEqual([FLOW_TASK, TYPED_TASK]);
    });

    it('sweeps nothing when the account no longer says, in the window, who wrote it', async () => {
      // A colleague edited the account since: who the run's user was cannot be told.
      Object.assign(org.rows.get('Account')?.[0] ?? {}, {
        LastModifiedDate: LONG_AFTER,
        LastModifiedById: id('005', 2),
      });

      await handler.handle(buildMsg('sync:remove:sweep', { runId: 'run-over-only' }));

      const [response] = posted<BaseMessage & { payload: { listing: ForgeSweepListing } }>(
        'sync:remove:sweep:response',
      );
      expect(response.payload.listing.refusal).toMatch(
        /^The run created nothing, and none of the records it wrote over still says/,
      );
      expect(response.payload.listing.found).toEqual([]);
    });
  });

  describe('told what ties a record to the run', () => {
    const CASE = id('500', 1);
    const ASSET = id('02i', 1);
    const LOOSE = id('00T', 6);
    const COLLEAGUE = id('005', 2);
    /** `seconds` after the run's inserts, as the org writes a date. */
    const after = (seconds: number): string =>
      new Date(Date.parse(WRITTEN_AT) + seconds * 1000).toISOString().replace('Z', '+0000');
    let tied: TiedTargetOrg;

    /**
     * The target after a Sync of an account, its contact and a case: what the
     * case's flow made — an asset the case names (`Case.AssetId`, which
     * refuses the asset's delete while the case stands) — and a task the
     * run's user typed in the run's window, tied to nothing of it.
     */
    const tiedOrg = (): TiedTargetOrg => {
      const org = tiedTargetOrg(USER);
      org.shape('Account', {
        children: [
          { childSObject: 'Contact', field: 'AccountId', cascadeDelete: true },
          { childSObject: 'Case', field: 'AccountId', cascadeDelete: true },
        ],
      });
      org.shape('Contact', { references: { AccountId: ['Account'] } });
      org.shape('Case', { references: { AccountId: ['Account'], AssetId: ['Asset'] } });
      org.shape('Asset', {
        children: [{ childSObject: 'Case', field: 'AssetId', restrictedDelete: true }],
      });
      org.shape('Task', { references: { WhoId: ['Contact'], WhatId: ['Account', 'Case'] } });
      const made = (recordId: string, name: string, by: string, at: string, more = {}) => ({
        ...rec(recordId, name, by, at, more),
        SystemModstamp: at,
      });
      org.add('Account', made(ACCOUNT, 'Synced Co', USER, WRITTEN));
      org.add('Contact', made(CONTACT, 'Synced Person', USER, WRITTEN, { AccountId: ACCOUNT }));
      org.add(
        'Case',
        made(CASE, 'Synced case', USER, WRITTEN, { AccountId: ACCOUNT, AssetId: ASSET }),
      );
      org.add('Asset', made(ASSET, 'Insured risk', USER, after(1)));
      org.add('Task', made(LOOSE, 'Loose task', USER, after(20)));
      return org;
    };

    /** Keep a run of this machine, as the panel's Sync keeps one. */
    const keep = async (
      runId: string,
      created: Array<[string, string[]]>,
      more: { runUserId?: string; at?: string } = {},
    ): Promise<void> => {
      const runs = nodeSyncRunCreations(storage);
      const recorder = runs.recorder({
        runId,
        configId: 'cfg-1',
        configName: 'Cases',
        sourceOrgId: 'org-source',
        targetOrgId: TARGET_ORG,
        startedAt: STARTED,
        ...(more.runUserId ? { runUserId: more.runUserId } : {}),
      });
      for (const [object, recordIds] of created) {
        recorder.note(object, recordIds, more.at ?? WRITTEN_AT);
      }
      await recorder.end({ status: 'success' });
      handler.setRunCreations(runs);
    };

    beforeEach(async () => {
      // A folder of runs of its own: the run of the other tests wrote the
      // same account and contact in the same window, and would be another
      // run of this machine for this one's sweep.
      rmSync(storage, { recursive: true, force: true });
      storage = mkdtempSync(join(tmpdir(), 'sandforge-sync-sweep-tied-'));
      await keep('run-cases', [
        ['Account', [ACCOUNT]],
        ['Contact', [CONTACT]],
        ['Case', [CASE]],
      ]);
      tied = tiedOrg();
      vi.mocked(getJsforceConnection).mockResolvedValue(tied.conn as never);
    });

    it('deletes the asset the case names once the case is gone, and keeps what is tied to nothing unasked', async () => {
      await handler.handle(buildMsg('sync:remove', { runId: 'run-cases', sweep: true }));

      expect(errors()).toEqual([]);
      const objects = tied.deletes.map((call) => call.object);
      expect(objects.indexOf('Asset')).toBeGreaterThan(objects.indexOf('Case'));
      expect(tied.ids('Asset')).toEqual([]);
      expect(tied.ids('Task')).toEqual([LOOSE]);
      const result = answer();
      expect(result?.status).toBe('success');
      expect(result?.sweep?.objects).toEqual([
        expect.objectContaining({ objectApiName: 'Asset', deleted: 1, afterRemoval: 1 }),
      ]);
      // Counted five to a composite.
      expect(tied.composites.length).toBeGreaterThan(0);
    });

    it('ends partial when the org refused what the sweep was to take, the run’s records gone: no success on the page', async () => {
      vi.mocked(getJsforceConnection).mockResolvedValue({
        ...tied.conn,
        sobject: (object: string) => {
          const records = tied.conn.sobject(object);
          if (object !== 'Asset') return records;
          return {
            ...records,
            destroy: async (ids: string[]) =>
              ids.map((recordId) => ({
                id: recordId,
                success: false,
                errors: [
                  {
                    statusCode: 'FIELD_CUSTOM_VALIDATION_EXCEPTION',
                    message: 'An asset cannot be deleted without the bypass.',
                  },
                ],
              })),
          };
        },
      } as never);

      await handler.handle(buildMsg('sync:remove', { runId: 'run-cases', sweep: true }));

      expect(tied.ids('Case')).toEqual([]);
      expect(tied.ids('Asset')).toEqual([ASSET]);
      expect(answer()).toMatchObject({ status: 'partial', sweep: { status: 'failure' } });
    });

    it('takes what is tied to nothing when asked, and not while another run of this machine wrote in the window', async () => {
      await handler.handle(
        buildMsg('sync:remove', { runId: 'run-cases', sweep: true, sweepUntied: true }),
      );
      expect(tied.ids('Task')).toEqual([]);

      // Another Sync of this machine into the same target, half a minute in.
      tied = tiedOrg();
      vi.mocked(getJsforceConnection).mockResolvedValue(tied.conn as never);
      tied.add('Contact', rec(id('003', 7), 'Their person', USER, after(30)));
      await keep('run-other', [['Contact', [id('003', 7)]]], {
        at: new Date(Date.parse(WRITTEN_AT) + 30_000).toISOString(),
      });
      vi.mocked(deps.broker.postToWebview).mockClear();

      await handler.handle(buildMsg('sync:remove:sweep', { runId: 'run-cases' }));
      const [response] = posted<BaseMessage & { payload: { listing: ForgeSweepListing } }>(
        'sync:remove:sweep:response',
      );
      expect(response.payload.listing.untied?.refusal).toMatch(/^Another run of this machine/);

      await handler.handle(
        buildMsg('sync:remove', { runId: 'run-cases', sweep: true, sweepUntied: true }),
      );
      expect(tied.ids('Task')).toEqual([LOOSE]);
      expect(tied.ids('Contact')).toContain(id('003', 7));
    });

    it('lists none of the lines the platform copied under a quote the run synced: its removal names them', async () => {
      const { created } = addSyncedQuote(tied, USER, WRITTEN);
      await keep(
        'run-quote',
        created.map(({ objectApiName, ids: recordIds }) => [objectApiName, recordIds]),
      );

      await handler.handle(buildMsg('sync:remove:sweep', { runId: 'run-quote' }));

      const [response] = posted<BaseMessage & { payload: { listing: ForgeSweepListing } }>(
        'sync:remove:sweep:response',
      );
      expect(response.payload.listing.looked).toContain('QuoteLineItem');
      expect(response.payload.listing.found.map((found) => found.objectApiName)).not.toContain(
        'QuoteLineItem',
      );
    });

    it('keeps what it found made, and takes it once the record that told the tie is gone', async () => {
      // A colleague edits the case after the run: the removal keeps it, and
      // the asset it names waits for it, refused.
      Object.assign(tied.row('Case', CASE) ?? {}, {
        LastModifiedDate: LONG_AFTER,
        SystemModstamp: LONG_AFTER,
        LastModifiedById: COLLEAGUE,
      });
      await handler.handle(buildMsg('sync:remove', { runId: 'run-cases', sweep: true }));
      expect(tied.ids('Asset')).toEqual([ASSET]);
      expect(answer()?.sweep?.objects).toEqual([
        expect.objectContaining({ objectApiName: 'Asset', deleted: 0, refused: 1 }),
      ]);
      const kept = await nodeSyncRunCreations(storage).get('run-cases');
      expect(kept?.removal?.madeEarlier).toEqual([ASSET]);

      // Then the case goes by hand: nothing of the run names the asset now.
      const caseRow = tied.row('Case', CASE);
      tied.rows.set('Case', []);
      if (caseRow) tied.bin.set('Case', [caseRow]);
      vi.mocked(deps.broker.postToWebview).mockClear();

      await handler.handle(buildMsg('sync:remove:sweep', { runId: 'run-cases' }));
      const [response] = posted<BaseMessage & { payload: { listing: ForgeSweepListing } }>(
        'sync:remove:sweep:response',
      );
      expect(
        response.payload.listing.found.find((found) => found.objectApiName === 'Asset')?.classes,
      ).toMatchObject({ made: 1, untied: 0 });

      await handler.handle(buildMsg('sync:remove', { runId: 'run-cases', sweep: true }));
      expect(tied.ids('Asset')).toEqual([]);
      const again = await nodeSyncRunCreations(storage).get('run-cases');
      expect(again?.removal?.madeEarlier).toEqual([ASSET]);
    });

    it('keeps what is tied to nothing while a run of another module wrote in the window', async () => {
      const told: Array<[string, unknown]> = [];
      const during = Date.parse(WRITTEN_AT) + 30_000;
      handler.setOtherModuleRuns(async (orgId, written) => {
        told.push([orgId, written]);
        return [{ ids: [id('003', 7)], from: during, to: during }];
      });
      tied.add('Contact', rec(id('003', 7), 'Their person', USER, after(30)));

      await handler.handle(buildMsg('sync:remove:sweep', { runId: 'run-cases' }));
      const [response] = posted<BaseMessage & { payload: { listing: ForgeSweepListing } }>(
        'sync:remove:sweep:response',
      );
      expect(told[0]?.[0]).toBe(TARGET_ORG);
      expect(response.payload.listing.untied?.refusal).toMatch(/^Another run of this machine/);

      await handler.handle(
        buildMsg('sync:remove', { runId: 'run-cases', sweep: true, sweepUntied: true }),
      );
      expect(tied.ids('Task')).toEqual([LOOSE]);
      expect(tied.ids('Contact')).toContain(id('003', 7));
    });

    it('names its runs on an org for the sweep of another module’s run', async () => {
      const [run] = await handler.localRunsOn(TARGET_ORG);

      expect(run?.ids).toEqual([ACCOUNT, CONTACT, CASE]);
      expect(await handler.localRunsOn('another-org')).toEqual([]);
    });

    describe('asked to mute the target’s automation', () => {
      let leases: string;
      let permissions: ReturnType<typeof memoryPermissionOrg>;
      const BACK = id('003', 8);
      /** The org's events, with the questions, the lease and the undeletes among them. */
      const steps = (): string[] => tied.events;

      beforeEach(() => {
        leases = mkdtempSync(join(tmpdir(), 'sandforge-sync-sweep-leases-'));
        handler.setMuteLeases({ dir: leases, renewEveryMs: 0 });
        read.mockImplementation(async () => ON_DELETE);
        const guard = deps.infraServices?.productionGuard as ProductionGuard;
        const check = guard.check.bind(guard);
        vi.spyOn(guard, 'check').mockImplementation((request) => {
          steps().push('question');
          return check(request);
        });
        const leased = leasedConnection(tied, USER);
        permissions = leased.permissions;
        vi.mocked(getJsforceConnection).mockResolvedValue({
          ...leased.conn,
          soap: {
            ...tied.conn.soap,
            undelete: async (recordIds: string[]) => {
              steps().push('undelete');
              return recordIds.map((recordId) => ({ id: recordId, success: true, errors: [] }));
            },
          },
        } as never);
      });

      afterEach(() => {
        rmSync(leases, { recursive: true, force: true });
      });

      it('asks the sweep’s question before the lease, and writes everything under it, its undeletes first', async () => {
        // The run also deleted a contact the source had deleted: its removal
        // brings it back before the sweep's first delete, as ever.
        const runs = nodeSyncRunCreations(storage);
        const recorder = runs.recorder({
          runId: 'run-back',
          configId: 'cfg-1',
          configName: 'Cases',
          sourceOrgId: 'org-source',
          targetOrgId: TARGET_ORG,
          startedAt: STARTED,
        });
        recorder.note('Account', [ACCOUNT], WRITTEN_AT);
        recorder.note('Contact', [CONTACT], WRITTEN_AT);
        recorder.note('Case', [CASE], WRITTEN_AT);
        recorder.deleted?.('Contact', [BACK]);
        await recorder.end({ status: 'success' });
        handler.setRunCreations(runs);
        await nodeSyncRunCreations(storage).forget('run-cases');
        tied.bin.set('Contact', [rec(BACK, 'Deleted by the run', COLLEAGUE, WRITTEN)]);

        await handler.handle(
          buildMsg('sync:remove', { runId: 'run-back', sweep: true, muteAutomation: true }),
        );

        expect(errors()).toEqual([]);
        const made = steps();
        const undeleted = made.indexOf('undelete');
        const leaseAt = made.indexOf('leaseAcquire');
        // The two questions, the removal's and the sweep's, before the lease.
        expect(made.filter((step) => step === 'question')).toHaveLength(2);
        expect(leaseAt).toBeGreaterThan(made.lastIndexOf('question'));
        // The undelete under the lease, before the sweep's and the removal's deletes.
        expect(undeleted).toBeGreaterThan(leaseAt);
        expect(undeleted).toBeLessThan(made.indexOf('write'));
        const path = [...made.map((step) => (step === 'undelete' ? 'write' : step)), 'result'];
        expect(writePathOrderDefects(path as WritePathStep[])).toEqual([]);
        expect(permissions.assignments()).toEqual([]);
      });

      it('plans the mute on the asset the sweep deletes, read once it has read, or the org refuses it', async () => {
        // What the org runs: a Flow on the asset alone, as the real reader
        // says only what it is asked of.
        read.mockImplementation(
          async (_orgId, objects) =>
            ({
              ...ON_DELETE,
              objectsRead: [...objects],
              objects: objects.includes('Asset')
                ? [{ ...ON_DELETE.objects[0], objectApiName: 'Asset' }]
                : [],
            }) as ForgeTargetAutomation,
        );
        const leased = await vi.mocked(getJsforceConnection).getMockImplementation()?.(
          '' as never,
          undefined as never,
          undefined as never,
        );
        const conn = (leased ?? {}) as typeof tied.conn;
        vi.mocked(getJsforceConnection).mockResolvedValue({
          ...conn,
          sobject: (object: string) => {
            const records = conn.sobject(object);
            if (object !== 'Asset') return records;
            return {
              ...records,
              destroy: async (ids: string[]) =>
                permissions.assignments().length > 0
                  ? records.destroy(ids)
                  : ids.map((recordId) => ({
                      id: recordId,
                      success: false,
                      errors: [
                        {
                          statusCode: 'FIELD_CUSTOM_VALIDATION_EXCEPTION',
                          message: 'An asset cannot be deleted without the bypass.',
                        },
                      ],
                    })),
            };
          },
        } as never);

        await handler.handle(
          buildMsg('sync:remove', { runId: 'run-cases', sweep: true, muteAutomation: true }),
        );

        expect(errors()).toEqual([]);
        expect(tied.ids('Asset')).toEqual([]);
        expect(answer()?.sweep?.status).toBe('success');
        expect(answer()?.mutedAutomation).toMatchObject({
          state: 'muted',
          assigned: ['Data_Load'],
          silenced: [expect.objectContaining({ objectApiName: 'Asset' })],
        });
        expect(read.mock.calls.at(-1)?.[1]).toContain('Asset');
        expect(permissions.assignments()).toEqual([]);
      });

      it('assigns nothing once a stop came while the sweep asked', async () => {
        const registry = new BackgroundOperationRegistry();
        handler.setRegistry(registry);
        const guard = deps.infraServices?.productionGuard as ProductionGuard;
        const confirmed = guard.confirmIfNeeded.bind(guard);
        vi.spyOn(guard, 'confirmIfNeeded').mockImplementation((asked, tier) => {
          for (const op of registry.getRunning()) registry.abort(op.operationId);
          return confirmed(asked, tier);
        });

        await handler.handle(
          buildMsg('sync:remove', { runId: 'run-cases', sweep: true, muteAutomation: true }),
        );

        expect(answer()?.status).toBe('cancelled');
        expect(steps()).not.toContain('leaseAcquire');
        expect(tied.ids('Case')).toEqual([CASE]);
      });

      it('holds no lease while Production Guard waits on the sweep’s question', async () => {
        const guard = deps.infraServices?.productionGuard as ProductionGuard;
        let held: number | undefined;
        const confirmed = guard.confirmIfNeeded.bind(guard);
        vi.spyOn(guard, 'confirmIfNeeded').mockImplementation((check, orgName) => {
          held = permissions.assignments().length;
          return confirmed(check, orgName);
        });

        await handler.handle(
          buildMsg('sync:remove', { runId: 'run-cases', sweep: true, muteAutomation: true }),
        );

        expect(answer()?.mutedAutomation).toMatchObject({
          state: 'muted',
          assigned: ['Data_Load'],
        });
        expect(held).toBe(0);
        expect(tied.ids('Asset')).toEqual([]);
      });
    });

    it('takes the user the run’s file keeps, reading none of its records to tell it, nor a colleague’s', async () => {
      await keep(
        'run-cases-user',
        [
          ['Account', [ACCOUNT]],
          ['Contact', [CONTACT]],
          ['Case', [CASE]],
        ],
        { runUserId: USER },
      );
      tied.add('Task', rec(id('00T', 8), 'A colleague’s', COLLEAGUE, after(5), { WhatId: CASE }));

      await handler.handle(buildMsg('sync:remove:sweep', { runId: 'run-cases-user' }));

      const [response] = posted<BaseMessage & { payload: { listing: ForgeSweepListing } }>(
        'sync:remove:sweep:response',
      );
      expect(response.payload.listing.refusal).toBeUndefined();
      expect(tied.queries.some((soql) => soql.startsWith('SELECT CreatedById FROM'))).toBe(false);
      expect(tied.queries.some((soql) => soql.includes(`CreatedById = '${USER}'`))).toBe(true);
    });
  });

  it('refuses to list a sweep after a run nothing of which is kept', async () => {
    await handler.handle(buildMsg('sync:remove:sweep', { runId: 'run-unknown' }));

    expect(errors('sync:remove:sweep:error').map((e) => e.payload.code)).toEqual(['NOT_KEPT']);
  });
});
