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
import { ProductionGuard } from '../../core/precheck/ProductionGuard.js';
import { ConfigStore } from '../../core/storage/ConfigStore.js';
import { AuditTrailStore } from '../../modules/audit/auditTrail.js';
import { BackupRecordStore, nodeBackupFiles } from '../../modules/dataops/BackupRecordStore.js';
import { nodeSyncRunCreations } from '../../modules/sync/SyncRunCreations.js';
import { InMemoryConfigStoreBackend } from '../../test/InMemoryConfigStoreBackend.js';
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
  const conn = {
    limitInfo: undefined,
    query: vi.fn(async (soql: string, options?: { scanAll?: boolean }) => {
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
    }),
    describe: vi.fn(async (object: string) => ({
      name: object,
      label: object,
      queryable: true,
      deletable: true,
      fields: [
        'Id',
        'Name',
        'CreatedById',
        'CreatedDate',
        'LastModifiedDate',
        'LastModifiedById',
      ].map((name) => ({ name, label: name, type: 'string', nameField: name === 'Name' })),
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

  it('refuses to list a sweep after a run nothing of which is kept', async () => {
    await handler.handle(buildMsg('sync:remove:sweep', { runId: 'run-unknown' }));

    expect(errors('sync:remove:sweep:error').map((e) => e.payload.code)).toEqual(['NOT_KEPT']);
  });
});
