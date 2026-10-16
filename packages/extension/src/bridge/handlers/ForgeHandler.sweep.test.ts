import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  BaseMessage,
  ForgeExecutionResult,
  ForgeGraph,
  ForgeSweepListing,
  ForgeTargetAutomation,
  ForgeUndoResult,
} from '@sandforge/shared';
import { forgeRemovalPlanOf } from '@sandforge/shared';

import { ForgeHandler } from './ForgeHandler.js';
import type { HandlerDeps, InboundRequest } from './HandlerTypes.js';
import { BackgroundOperationRegistry } from '../../core/engine/BackgroundOperationRegistry.js';
import { ProductionGuard } from '../../core/precheck/ProductionGuard.js';
import { ConfigStore } from '../../core/storage/ConfigStore.js';
import { AuditTrailStore } from '../../modules/audit/auditTrail.js';
import { ForgeRemovalPlanStore } from '../../modules/forge/ForgeRemovalPlanStore.js';
import type { ForgeOrchestrator } from '../../modules/forge/ForgeOrchestrator.js';
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

const mockGetConn = vi.mocked(getJsforceConnection);

/** A fake record id: the object's prefix, then a counter. */
const id = (prefix: string, n: number): string => `${prefix}${String(n).padStart(12, '0')}AAA`;
const src = (prefix: string, n: number): string => `${prefix}${String(n).padStart(12, '0')}SRC`;

const FIRST_WRITE = '2026-09-20T10:00:00.000Z';
const LAST_WRITE = '2026-09-20T10:05:00.000Z';
const DURING_RUN = '2026-09-20T10:02:00.000+0000';
/** Past the run's last write, inside the sweep's window: an asynchronous path's moment. */
const AFTER_LAST_WRITE = '2026-09-20T10:05:20.000+0000';
const LONG_AFTER = '2026-09-20T12:00:00.000+0000';
const TARGET_ORG = 'tgt-org';
/** The user the run wrote as, and the session to the target writes as. */
const USER = id('005', 1);
const COLLEAGUE = id('005', 2);

const GRAPH: ForgeGraph = {
  nodes: [],
  edges: [],
  totalRecords: 3,
  estimatedSizeMB: 0,
  estimatedDurationSeconds: 1,
};

/** A run that created an account and a contact under it, and linked one account. */
function runEntry(overrides: Partial<ForgeExecutionResult> = {}): ForgeExecutionResult {
  return {
    forgeId: 'forge-1',
    status: 'success',
    graph: GRAPH,
    duration: 300_000,
    timestamp: LAST_WRITE,
    idRemapCount: 3,
    idRemapTable: {
      [src('001', 1)]: id('001', 1),
      [src('001', 2)]: id('001', 9),
      [src('003', 1)]: id('003', 1),
    },
    idRemapExisting: [src('001', 2)],
    idRemapCreated: [
      { objectApiName: 'Account', sourceIds: [src('001', 1)] },
      { objectApiName: 'Contact', sourceIds: [src('003', 1)] },
    ],
    writtenBetween: { first: FIRST_WRITE, last: LAST_WRITE },
    targetOrgId: TARGET_ORG,
    ...overrides,
  };
}

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
 * The target after the run: its account and contact, and what the target's
 * automation created as the run wrote — a task and an asset, hanging from
 * none of the run's records, as the client's assets hung from no case — with
 * a colleague's task and one the run's user typed hours later. Answers the
 * removal's reads and the sweep's, as jsforce shows them.
 */
function targetOrg() {
  const rows = new Map<string, Row[]>([
    ['Account', [rec(id('001', 1), 'Cloned account', USER, DURING_RUN)]],
    [
      'Contact',
      [rec(id('003', 1), 'Cloned contact', USER, DURING_RUN, { AccountId: id('001', 1) })],
    ],
    [
      'Task',
      [
        rec(id('00T', 1), 'Welcome call', USER, DURING_RUN),
        rec(id('00T', 2), 'A colleague’s call', COLLEAGUE, DURING_RUN),
        rec(id('00T', 3), 'Typed later', USER, LONG_AFTER),
      ],
    ],
    ['Asset', [rec(id('02i', 1), 'Insured risk', USER, DURING_RUN)]],
  ]);
  const children = new Map([
    ['Account', [{ childSObject: 'Contact', field: 'AccountId', cascadeDelete: true }]],
    // A contact's activities go with it.
    ['Contact', [{ childSObject: 'Task', field: 'WhoId', cascadeDelete: true }]],
  ]);
  const deletes: Array<{ object: string; ids: string[] }> = [];
  const bin = new Map<string, Row>();
  const pick = (row: Row, columns: string): Record<string, unknown> =>
    Object.fromEntries(columns.split(', ').map((c) => [c, row[c]]));
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
      destroy: vi.fn(async (ids: string[]) => {
        deletes.push({ object, ids: [...ids] });
        return ids.map((recordId) => {
          const row = (rows.get(object) ?? []).find((r) => r.Id === recordId);
          if (!row) {
            return {
              id: recordId,
              success: false,
              errors: [{ statusCode: 'ENTITY_IS_DELETED', message: 'gone' }],
            };
          }
          rows.set(
            object,
            (rows.get(object) ?? []).filter((r) => r.Id !== recordId),
          );
          bin.set(recordId, { ...row, object });
          // The org takes the account's contacts along with it.
          if (object === 'Account') {
            for (const contact of rows.get('Contact') ?? []) {
              if (contact.AccountId === recordId) bin.set(contact.Id, { ...contact, object });
            }
            rows.set(
              'Contact',
              (rows.get('Contact') ?? []).filter((c) => c.AccountId !== recordId),
            );
          }
          return { id: recordId, success: true, errors: [] };
        });
      }),
      update: vi.fn(async () => []),
    }),
  };
  return { conn, rows, deletes };
}

/** What the target runs on the run's objects: a contact flow that creates an asset. */
const AUTOMATION = {
  objectsRead: ['Account', 'Contact'],
  objects: [
    {
      objectApiName: 'Contact',
      flows: [
        {
          apiName: 'Clone_Risk',
          label: 'Clone risk',
          timing: 'afterSave',
          startsOn: 'create',
          condition: 'read',
          permissions: [],
          creates: ['Asset'],
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

describe('a sweep asked with a removal', () => {
  let deps: HandlerDeps;
  let store: ConfigStore;
  let handler: ForgeHandler;
  let org: ReturnType<typeof targetOrg>;
  let reader: { read: ReturnType<typeof vi.fn> };
  let orgType: string;

  const posted = <T extends BaseMessage>(type: string): T[] =>
    vi
      .mocked(deps.broker.postToWebview)
      .mock.calls.map(([m]) => m as T)
      .filter((m) => m.type === type);
  const answer = (): ForgeUndoResult | undefined =>
    posted<BaseMessage & { payload: { result: ForgeUndoResult } }>('forge:undo:response').at(-1)
      ?.payload.result;
  const errors = () =>
    posted<BaseMessage & { payload: { code: string; message: string } }>('forge:undo:error');
  const history = (): ForgeExecutionResult[] =>
    store.get<ForgeExecutionResult[]>('forge:history') ?? [];
  const trail = () => new AuditTrailStore(store).list().entries;
  const ids = (object: string): string[] => (org.rows.get(object) ?? []).map((row) => row.Id);

  beforeEach(() => {
    vi.clearAllMocks();
    store = new ConfigStore(new InMemoryConfigStoreBackend());
    store.initialize();
    store.set('forge:history', [runEntry()], 'forge');
    orgType = 'Sandbox';
    let n = 0;
    deps = {
      log: vi.fn(),
      broker: { postToWebview: vi.fn() } as unknown as HandlerDeps['broker'],
      stateSync: {} as HandlerDeps['stateSync'],
      orgManager: {
        getOrg: vi.fn(() => ({ orgType, alias: 'DEV' })),
      } as unknown as HandlerDeps['orgManager'],
      orgRegistry: {} as HandlerDeps['orgRegistry'],
      configStore: store,
      secretVault: {} as HandlerDeps['secretVault'],
      authProvider: {} as HandlerDeps['authProvider'],
      sfdxBridge: {} as HandlerDeps['sfdxBridge'],
      infraServices: {
        productionGuard: new ProductionGuard({ requestRunConfirmation: async () => true }),
        backgroundRegistry: new BackgroundOperationRegistry(),
      } as unknown as HandlerDeps['infraServices'],
      nextId: () => String(++n),
    };
    handler = new ForgeHandler(deps);
    reader = { read: vi.fn(async () => AUTOMATION) };
    handler.setForgeOrchestrator({ on: vi.fn() } as unknown as ForgeOrchestrator, {
      targetAutomation: reader as never,
    });
    org = targetOrg();
    mockGetConn.mockResolvedValue(org.conn as never);
  });

  it('takes back, before the run’s records go, what the target’s automation created as its user', async () => {
    await handler.handle(buildMsg('forge:undo', { forgeId: 'forge-1', sweep: true }));

    expect(errors()).toEqual([]);
    // The sweep first, then the removal: never a record of the run's twice.
    expect(org.deletes.map((d) => d.object)).toEqual(['Task', 'Asset', 'Contact', 'Account']);
    expect(org.deletes.find((d) => d.object === 'Task')?.ids).toEqual([id('00T', 1)]);
    expect(ids('Task')).toEqual([id('00T', 2), id('00T', 3)]);
    expect(ids('Asset')).toEqual([]);
    // The account the run linked to stays.
    expect(org.deletes.flatMap((d) => d.ids)).not.toContain(id('001', 9));
    // The automation was read for the objects the run wrote.
    expect([...(reader.read.mock.calls[0]?.[1] ?? [])].sort()).toEqual(['Account', 'Contact']);

    const result = answer();
    expect(result?.status).toBe('success');
    expect(result?.sweep).toMatchObject({
      status: 'success',
      window: { from: '2026-09-20T09:59:59Z', to: '2026-09-20T10:06:00Z' },
      objects: [
        { objectApiName: 'Task', found: 1, deleted: 1 },
        { objectApiName: 'Asset', found: 1, deleted: 1 },
      ],
      handWork: [],
    });
    expect(history()[0].sweep).toEqual({
      sweptAt: expect.any(String),
      deleted: 2,
      keptChanged: 0,
      refused: 0,
    });
    const removals = trail().filter((entry) => entry.action === 'cleanup_delete');
    const sweep = removals.find((entry) => entry.operationId?.endsWith('-sweep'));
    const removal = removals.find((entry) => entry.operationId?.endsWith('-sweep') === false);
    expect(removal).toBeDefined();
    expect(sweep).toBeDefined();
    expect(removal?.details ?? {}).not.toHaveProperty('sweep');
    expect(sweep).toMatchObject({
      outcome: 'success',
      guard: 'allowed',
      operationId: expect.stringMatching(/-sweep$/),
      details: { sweep: true, forgeId: 'forge-1', found: 2, deleted: 2 },
      objects: [
        { objectApiName: 'Task', created: 0, updated: 0, deleted: 1, failed: 0 },
        { objectApiName: 'Asset', created: 0, updated: 0, deleted: 1, failed: 0 },
      ],
    });
    // Counts only: no record id, no name reaches the trail.
    expect(JSON.stringify(store.get('audit:trail'))).not.toContain(id('00T', 1));
    expect(JSON.stringify(store.get('audit:trail'))).not.toContain('Welcome call');
  });

  it('keeps no record of the run back for a task the automation opened under it after the run’s last write', async () => {
    // Opened by an asynchronous path twenty seconds after the run's last
    // write: out of the run's span, so a removal reads it as a record that
    // stays, and inside the sweep's window, so the sweep takes it.
    org.rows
      .get('Task')
      ?.push(rec(id('00T', 4), 'Follow-up call', USER, AFTER_LAST_WRITE, { WhoId: id('003', 1) }));

    await handler.handle(buildMsg('forge:undo', { forgeId: 'forge-1', sweep: true }));

    expect(errors()).toEqual([]);
    expect(ids('Contact')).toEqual([]);
    expect(ids('Account')).toEqual([]);
    expect(ids('Task')).toEqual([id('00T', 2), id('00T', 3)]);
    const result = answer();
    expect(result?.status).toBe('success');
    expect(result?.objects.map((o) => [o.objectApiName, o.deleted, o.keptDependents])).toEqual([
      ['Contact', 1, 0],
      ['Account', 1, 0],
    ]);
    expect(result?.sweep).toMatchObject({
      status: 'success',
      objects: [
        { objectApiName: 'Task', found: 2, deleted: 2 },
        { objectApiName: 'Asset', found: 1, deleted: 1 },
      ],
    });
  });

  it('removes none of the run’s records once a cancel stopped the sweep before them', async () => {
    // Cancel from Live Operations while the sweep reads: it stops before its
    // next call to the org, and the removal does not start.
    reader.read.mockImplementation(async () => {
      const registry = deps.infraServices?.backgroundRegistry;
      for (const op of registry?.getRunning() ?? []) registry?.abort(op.operationId);
      return AUTOMATION;
    });

    await handler.handle(buildMsg('forge:undo', { forgeId: 'forge-1', sweep: true }));

    expect(org.deletes).toEqual([]);
    expect(ids('Contact')).toEqual([id('003', 1)]);
    const result = answer();
    expect(result?.status).toBe('cancelled');
    expect(result?.sweep?.status).toBe('cancelled');
    expect(history()[0]).not.toHaveProperty('undo');
  });

  it('sweeps nothing unasked', async () => {
    await handler.handle(buildMsg('forge:undo', { forgeId: 'forge-1' }));

    expect(org.deletes.map((d) => d.object)).toEqual(['Contact', 'Account']);
    expect(ids('Task')).toHaveLength(3);
    expect(ids('Asset')).toEqual([id('02i', 1)]);
    expect(answer()).not.toHaveProperty('sweep');
    expect(history()[0]).not.toHaveProperty('sweep');
    expect(trail().filter((entry) => entry.action === 'cleanup_delete')).toHaveLength(1);
    expect(reader.read).not.toHaveBeenCalled();
  });

  it('runs alone when asked of a run whose records were all removed already', async () => {
    await handler.handle(buildMsg('forge:undo', { forgeId: 'forge-1' }));
    const removed = history()[0].undo;
    org.deletes.length = 0;

    await handler.handle(buildMsg('forge:undo', { forgeId: 'forge-1', sweep: true }));

    expect(errors()).toEqual([]);
    expect(org.deletes.map((d) => d.object)).toEqual(['Task', 'Asset']);
    const result = answer();
    expect(result?.objects).toEqual([]);
    expect(result?.sweep?.status).toBe('success');
    // The removal's mark is the first removal's still.
    expect(history()[0].undo).toEqual(removed);
    expect(history()[0].sweep?.deleted).toBe(2);
  });

  it('lets Production Guard refuse the sweep’s deletes, and records why', async () => {
    await handler.handle(buildMsg('forge:undo', { forgeId: 'forge-1' }));
    org.deletes.length = 0;
    // The org now reads as a production one: the guard refuses a delete there.
    orgType = 'Production';

    await handler.handle(buildMsg('forge:undo', { forgeId: 'forge-1', sweep: true }));

    expect(org.deletes).toEqual([]);
    expect(answer()?.sweep).toMatchObject({
      status: 'refused',
      refusal: expect.stringMatching(/^Operation blocked by Production Guard/),
    });
    expect(history()[0]).not.toHaveProperty('sweep');
    expect(trail()[0]).toMatchObject({
      action: 'cleanup_delete',
      outcome: 'stopped',
      guard: 'refused',
      details: { sweep: true },
    });
  });

  it('is refused for a run the history dropped, and removes nothing', async () => {
    const disk = new Map<string, string>();
    const plans = new ForgeRemovalPlanStore({
      storagePath: '/extension-storage',
      readFile: async (path) => {
        const content = disk.get(path);
        if (content === undefined) throw new Error(`ENOENT: ${path}`);
        return content;
      },
      writeFile: async (path, content) => {
        disk.set(path, content);
      },
      rename: async (from, to) => {
        disk.set(to, disk.get(from) ?? '');
        disk.delete(from);
      },
      mkdir: async () => undefined,
    });
    await plans.put(forgeRemovalPlanOf(runEntry())!);
    store.set('forge:history', [], 'forge');
    handler.setForgeOrchestrator({ on: vi.fn() } as unknown as ForgeOrchestrator, {
      targetAutomation: reader as never,
      removalPlans: plans,
    });

    await handler.handle(buildMsg('forge:undo', { forgeId: 'forge-1', sweep: true }));

    expect(errors().map((e) => e.payload.code)).toEqual(['SWEEP_UNAVAILABLE']);
    expect(org.deletes).toEqual([]);
  });

  it('lists, for the confirmation, what a sweep would take, and deletes nothing', async () => {
    await handler.handle(buildMsg('forge:undo-sweep:request', { forgeId: 'forge-1' }));

    const [response] = posted<
      BaseMessage & { payload: { forgeId: string; listing: ForgeSweepListing } }
    >('forge:undo-sweep:response');
    expect(response?.payload.forgeId).toBe('forge-1');
    expect(response?.payload.listing).toMatchObject({
      found: [
        { objectApiName: 'Task', count: 1, names: ['Welcome call'] },
        { objectApiName: 'Asset', count: 1, names: ['Insured risk'] },
      ],
      handWork: [],
    });
    expect(response?.payload.listing.refusal).toBeUndefined();
    expect(org.deletes).toEqual([]);
  });

  it('refuses to list a sweep for a run the history does not hold', async () => {
    await handler.handle(buildMsg('forge:undo-sweep:request', { forgeId: 'gone' }));

    expect(posted('forge:undo-sweep:response')).toEqual([]);
    expect(
      posted<BaseMessage & { payload: { code: string } }>('forge:undo-sweep:error')[0]?.payload
        .code,
    ).toBe('NOT_FOUND');
    expect(mockGetConn).not.toHaveBeenCalled();
  });
});
