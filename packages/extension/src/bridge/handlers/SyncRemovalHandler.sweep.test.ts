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
      update: vi.fn(async () => []),
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
    recorder.note('Account', [ACCOUNT]);
    recorder.note('Contact', [CONTACT]);
    await recorder.end({ status: 'success' });
    handler = new SyncRemovalHandler(deps, { list: () => [] }, () => false);
    handler.setRunCreations(runs);
    read = vi.fn(async (_orgId: string, _objects: readonly string[]) => AUTOMATION);
    handler.setTargetAutomation({ read });
    org = targetOrg();
    vi.mocked(getJsforceConnection).mockResolvedValue(org.conn as never);
  });

  afterEach(() => {
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

  it('refuses to list a sweep after a run nothing of which is kept', async () => {
    await handler.handle(buildMsg('sync:remove:sweep', { runId: 'run-unknown' }));

    expect(errors('sync:remove:sweep:error').map((e) => e.payload.code)).toEqual(['NOT_KEPT']);
  });
});
