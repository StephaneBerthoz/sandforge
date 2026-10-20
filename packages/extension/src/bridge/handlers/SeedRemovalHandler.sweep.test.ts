import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  BaseMessage,
  ForgeSweepListing,
  ForgeTargetAutomation,
  SeedRemovalResult,
} from '@sandforge/shared';

import { SeedRemovalHandler } from './SeedRemovalHandler.js';
import type { HandlerDeps, InboundRequest } from './HandlerTypes.js';
import { ProductionGuard } from '../../core/precheck/ProductionGuard.js';
import { ConfigStore } from '../../core/storage/ConfigStore.js';
import { AuditTrailStore } from '../../modules/audit/auditTrail.js';
import { nodeSeedRunCreations } from '../../modules/seed/SeedRunCreations.js';
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

/** The seed as the target dated its inserts, and as this machine's clock saw it end. */
const SEEDED = '2026-09-20T10:02:00.000+0000';
const STARTED = '2026-09-20T10:01:50.000Z';
const FINISHED = '2026-09-20T10:02:05.000Z';
/** Half a minute after the seed's last insert: what a flow on the contact writes. */
const JUST_AFTER = '2026-09-20T10:02:30.000+0000';
const LONG_AFTER = '2026-09-20T12:00:00.000+0000';

/** The user the seed wrote as, and the session to the target writes as. */
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
 * The target after a seed of an account and a contact under it: the task a
 * flow opened on the contact as the seed wrote it — the trap's flow does it
 * for every contact — and a task the seed's user typed hours later. Answers
 * the removal's reads and the sweep's as jsforce shows them.
 */
function targetOrg() {
  const rows = new Map<string, Row[]>([
    ['Account', [rec(ACCOUNT, 'Seeded Co', USER, SEEDED)]],
    ['Contact', [rec(CONTACT, 'Seeded Person', USER, SEEDED, { AccountId: ACCOUNT })]],
    [
      'Task',
      [
        rec(FLOW_TASK, 'Welcome call', USER, JUST_AFTER, { WhoId: CONTACT }),
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

/** What the target runs on the seed's objects: a contact flow that opens a task, as the trap's. */
const AUTOMATION = {
  objectsRead: ['Account', 'Contact'],
  objects: [
    {
      objectApiName: 'Contact',
      flows: [
        {
          apiName: 'Welcome_Call',
          label: 'Welcome call',
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

describe('a sweep asked with the removal of a Seed run', () => {
  let storage: string;
  let deps: HandlerDeps;
  let store: ConfigStore;
  let handler: SeedRemovalHandler;
  let org: ReturnType<typeof targetOrg>;

  const posted = <T extends BaseMessage>(type: string): T[] =>
    vi
      .mocked(deps.broker.postToWebview)
      .mock.calls.map(([m]) => m as T)
      .filter((m) => m.type === type);
  const answer = (): SeedRemovalResult | undefined =>
    posted<BaseMessage & { payload: { result: SeedRemovalResult } }>('seed:remove:response')[0]
      ?.payload.result;
  const errors = (type = 'seed:remove:error') =>
    posted<BaseMessage & { payload: { code: string; message: string } }>(type);
  const ids = (object: string): string[] => (org.rows.get(object) ?? []).map((row) => row.Id);

  beforeEach(async () => {
    vi.clearAllMocks();
    storage = mkdtempSync(join(tmpdir(), 'sandforge-seed-sweep-'));
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
    const runs = nodeSeedRunCreations(storage);
    await runs.record({
      runId: 'op-seed',
      targetOrgId: TARGET_ORG,
      startedAt: STARTED,
      finishedAt: FINISHED,
      status: 'success',
      objectResults: [
        { objectApiName: 'Account', createdIds: [ACCOUNT] },
        { objectApiName: 'Contact', createdIds: [CONTACT] },
      ],
    });
    handler = new SeedRemovalHandler(deps);
    handler.setRunCreations(runs);
    handler.setTargetAutomation({ read: vi.fn(async () => AUTOMATION) });
    org = targetOrg();
    vi.mocked(getJsforceConnection).mockResolvedValue(org.conn as never);
  });

  afterEach(() => {
    rmSync(storage, { recursive: true, force: true });
  });

  it('lists the task the flow opened during the seed, in the window its records were dated, read only', async () => {
    await handler.handle(buildMsg('seed:remove:sweep', { runId: 'op-seed' }));

    expect(errors('seed:remove:sweep:error')).toEqual([]);
    const [response] = posted<BaseMessage & { payload: { listing: ForgeSweepListing } }>(
      'seed:remove:sweep:response',
    );
    const listing = response.payload.listing;
    expect(listing.refusal).toBeUndefined();
    expect(listing.window).toEqual({ from: '2026-09-20T10:01:59Z', to: '2026-09-20T10:03:00Z' });
    expect(listing.found).toEqual([
      expect.objectContaining({ objectApiName: 'Task', count: 1, names: ['Welcome call'] }),
    ]);
    expect(ids('Task')).toEqual([FLOW_TASK, TYPED_TASK]);
  });

  it('sweeps the task before the seed’s records go, and the typed one stays', async () => {
    await handler.handle(buildMsg('seed:remove', { runId: 'op-seed', sweep: true }));

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
    // The sweep is recorded beside the removal.
    const trail = new AuditTrailStore(store).list().entries;
    expect(trail.map((entry) => entry.operationId).sort()).toEqual([
      'req-seed:remove',
      'req-seed:remove-sweep',
    ]);
  });

  it("reads the target's automation through its own reader, with none handed to it, on the first sweep listed", async () => {
    // The reader was Forge's, handed over once Forge's composition had
    // loaded: listed before, the sweep said the automation was not read.
    const VERSION = '301000000000001AAA';
    const asked: string[] = [];
    const page = (records: unknown[]) => ({ totalSize: records.length, done: true, records });
    const regular = org.conn.query;
    const conn = {
      ...org.conn,
      version: '66.0',
      query: vi.fn(async (soql: string, options?: { scanAll?: boolean }) => {
        if (
          /FROM (FlowDefinitionView|DuplicateRule|UserSetupEntityAccess|CustomPermission)/.test(
            soql,
          )
        ) {
          asked.push(soql);
          if (!/FROM FlowDefinitionView/.test(soql) || /ProcessType/.test(soql)) return page([]);
          return page([
            {
              ApiName: 'Welcome_Call',
              Label: 'Welcome call',
              TriggerType: 'RecordAfterSave',
              RecordTriggerType: 'Create',
              TriggerObjectOrEvent: { QualifiedApiName: 'Contact' },
              ActiveVersionId: VERSION,
            },
          ]);
        }
        return regular(soql, options);
      }),
      tooling: {
        query: vi.fn(async (soql: string) => {
          asked.push(soql);
          return page([]);
        }),
        queryMore: vi.fn(async () => page([])),
      },
      // The flow version, retrieved by id in a Tooling composite: it opens a task.
      request: vi.fn(async ({ body }: { body: string }) => {
        const { compositeRequest } = JSON.parse(body) as {
          compositeRequest: Array<{ url: string; referenceId: string }>;
        };
        return {
          compositeResponse: compositeRequest.map((sub) => ({
            referenceId: sub.referenceId,
            httpStatusCode: 200,
            body: sub.url.endsWith(`/Flow/${VERSION}`)
              ? { Id: VERSION, Metadata: { recordCreates: [{ name: 'Task', object: 'Task' }] } }
              : { totalSize: 0, done: true, records: [] },
          })),
        };
      }),
    };
    vi.mocked(getJsforceConnection).mockResolvedValue(conn as never);
    const own = new SeedRemovalHandler(deps);
    own.setRunCreations(nodeSeedRunCreations(storage));

    await own.handle(buildMsg('seed:remove:sweep', { runId: 'op-seed' }));

    expect(errors('seed:remove:sweep:error')).toEqual([]);
    const [response] = posted<BaseMessage & { payload: { listing: ForgeSweepListing } }>(
      'seed:remove:sweep:response',
    );
    expect(asked.some((soql) => /FROM FlowDefinitionView/.test(soql))).toBe(true);
    expect(response.payload.listing.automationGaps?.error).toBeUndefined();
    expect(response.payload.listing.found).toEqual([
      expect.objectContaining({ objectApiName: 'Task', count: 1, names: ['Welcome call'] }),
    ]);
  });

  it('leaves the task the flow opened to a removal asked without the sweep', async () => {
    await handler.handle(buildMsg('seed:remove', { runId: 'op-seed' }));

    expect(answer()?.sweep).toBeUndefined();
    expect(ids('Task')).toEqual([FLOW_TASK, TYPED_TASK]);
  });
});
