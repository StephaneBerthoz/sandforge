import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type {
  BaseMessage,
  ForgeSweepListing,
  ForgeTargetAutomation,
  FrozenProjectConfig,
  FrozenRemovalResult,
} from '@sandforge/shared';

import { FrozenDatasetHandler } from './FrozenDatasetHandler.js';
import type { HandlerDeps, InboundRequest } from './HandlerTypes.js';
import { ProductionGuard } from '../../core/precheck/ProductionGuard.js';
import { ConfigStore } from '../../core/storage/ConfigStore.js';
import { AuditTrailStore } from '../../modules/audit/auditTrail.js';
import { removeRunRecords } from '../../modules/forge/ForgeRunRemoval.js';
import { SasReferenceIdMappingStore } from '../../modules/frozendataset/SasReferenceIdMappingStore.js';
import { InMemoryConfigStoreBackend } from '../../test/InMemoryConfigStoreBackend.js';
import { compositeOver } from '../../test/compositeOver.js';
import { inboundRequest } from '../../test/mockFactories.js';
import { addSyncedQuote, tiedTargetOrg, type TiedTargetOrg } from '../../test/tiedTargetOrg.js';

vi.mock('../../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../core/connection/ConnectionHelper.js', () => ({
  getJsforceConnection: vi.fn(),
}));
// The real removal, its options read back by the case that names the load's user.
vi.mock('../../modules/forge/ForgeRunRemoval.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../modules/forge/ForgeRunRemoval.js')>();
  return { ...actual, removeRunRecords: vi.fn(actual.removeRunRecords) };
});
vi.mock('../../core/common/sforceLimitParser.js', () => ({
  checkApiLimits: vi.fn(),
}));

import { getJsforceConnection } from '../../core/connection/ConnectionHelper.js';

const mockGetConn = vi.mocked(getJsforceConnection);

/** A fake record id: the object's prefix, then a counter. */
const id = (prefix: string, n: number): string => `${prefix}${String(n).padStart(12, '0')}AAA`;

const TARGET_ORG = 'org-dev';
const ORGANIZATION = '00DXX00000AbCdE2A1';

/** The load as the target dated it: from 10:00 to 10:05. */
const FIRST_WRITE = '2026-09-20T10:00:00.000Z';
const LAST_WRITE = '2026-09-20T10:05:00.000Z';
const DURING_LOAD = '2026-09-20T10:02:00.000+0000';
/** Ten seconds before the load's last write: when it wrote the records of these tests. */
const NEAR_ITS_END = '2026-09-20T10:04:50.000+0000';
/** A second after them: what a flow in the same save opens. */
const WITH_THEM = '2026-09-20T10:04:51.000+0000';
/** Half a minute after the load's last write: what an asynchronous path writes. */
const JUST_AFTER = '2026-09-20T10:05:30.000+0000';
const LONG_AFTER = '2026-09-20T12:00:00.000+0000';

/** The user the load wrote as, and the session to the target writes as. */
const USER = id('005', 1);

const APPOINTMENT = id('08p', 1);
const WORK_ORDER = id('0WO', 1);

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
 * The target after a load of a work order and its appointment: the feed items
 * the target's automation hung under each as the load wrote — half a minute
 * after the last write, as an asynchronous path does — a task a flow opened
 * on the work order, and one the load's user typed hours later. Answers the
 * removal's reads and the sweep's as jsforce shows them, and deletes a work
 * order's feed with it. A feed item keeps no `LastModifiedById`, and the org
 * refuses a read of it.
 */
function targetOrg() {
  const rows = new Map<string, Row[]>([
    ['WorkOrder', [rec(WORK_ORDER, 'Repair', USER, NEAR_ITS_END)]],
    [
      'ServiceAppointment',
      [rec(APPOINTMENT, 'Visit', USER, NEAR_ITS_END, { ParentRecordId: WORK_ORDER })],
    ],
    [
      'FeedItem',
      [
        rec(id('0D5', 1), 'Created', USER, JUST_AFTER, { ParentId: APPOINTMENT }),
        rec(id('0D5', 2), 'Created', USER, JUST_AFTER, { ParentId: WORK_ORDER }),
      ],
    ],
    [
      'Task',
      [
        rec(id('00T', 1), 'Call the customer', USER, WITH_THEM, { WhatId: WORK_ORDER }),
        rec(id('00T', 2), 'Typed later', USER, LONG_AFTER),
      ],
    ],
  ]);
  const children = new Map([
    [
      'WorkOrder',
      [
        { childSObject: 'ServiceAppointment', field: 'ParentRecordId', cascadeDelete: true },
        { childSObject: 'FeedItem', field: 'ParentId', cascadeDelete: true },
      ],
    ],
    ['ServiceAppointment', [{ childSObject: 'FeedItem', field: 'ParentId', cascadeDelete: true }]],
  ]);
  /** The lookups a tie is read from, per object, to the objects each names. */
  const lookups = new Map<string, Record<string, string[]>>([
    ['ServiceAppointment', { ParentRecordId: ['WorkOrder'] }],
    ['FeedItem', { ParentId: ['WorkOrder', 'ServiceAppointment'] }],
    ['Task', { WhatId: ['WorkOrder'] }],
  ]);
  /** The columns an object lacks: the org refuses a read of one. */
  const lacks = new Map([['FeedItem', ['LastModifiedById']]]);
  const refuseMissing = (object: string, columns: string): void => {
    const missing = (lacks.get(object) ?? []).find((c) => columns.split(', ').includes(c));
    if (missing) {
      throw Object.assign(
        new Error(`INVALID_FIELD: No such column '${missing}' on entity '${object}'.`),
        { errorCode: 'INVALID_FIELD' },
      );
    }
  };
  const deletes: Array<{ object: string; ids: string[] }> = [];
  const bin = new Map<string, Row>();
  const pick = (row: Row, columns: string): Record<string, unknown> =>
    Object.fromEntries(columns.split(', ').map((c) => [c, row[c]]));
  /** What a delete does to other records: a roll-up restamping its parent. */
  const hooks: { onDrop?: (object: string, row: Row) => void } = {};
  const drop = (object: string, recordId: string): void => {
    const row = (rows.get(object) ?? []).find((r) => r.Id === recordId);
    if (!row) return;
    rows.set(
      object,
      (rows.get(object) ?? []).filter((r) => r.Id !== recordId),
    );
    bin.set(recordId, { ...row, object });
    hooks.onDrop?.(object, row);
    for (const child of children.get(object) ?? []) {
      for (const under of rows.get(child.childSObject) ?? []) {
        if (under[child.field] === recordId) drop(child.childSObject, under.Id);
      }
    }
  };
  const query = vi.fn(async (soql: string, options?: { scanAll?: boolean }) => {
    const answer = (records: unknown[]) => ({ totalSize: records.length, done: true, records });
    if (soql === 'SELECT Id FROM Organization') return answer([{ Id: ORGANIZATION }]);
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
      refuseMissing(object, columns);
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
    refuseMissing(object, columns);
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
        ...['Id', 'Name', 'CreatedById', 'CreatedDate', 'LastModifiedDate', 'LastModifiedById']
          .filter((name) => !(lacks.get(object) ?? []).includes(name))
          .map((name) => ({ name, label: name, type: 'string', nameField: name === 'Name' })),
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
      destroy: vi.fn(async (ids: string[]) => {
        deletes.push({ object, ids: [...ids] });
        return ids.map((recordId) => {
          if (!(rows.get(object) ?? []).some((r) => r.Id === recordId)) {
            return {
              id: recordId,
              success: false,
              errors: [{ statusCode: 'ENTITY_IS_DELETED', message: 'gone' }],
            };
          }
          drop(object, recordId);
          return { id: recordId, success: true, errors: [] };
        });
      }),
      update: vi.fn(async () => []),
    }),
  };
  return { conn, rows, deletes, hooks };
}

/** What the target runs on the load's objects: a work-order flow that opens a task. */
const AUTOMATION = {
  objectsRead: ['WorkOrder', 'ServiceAppointment'],
  objects: [
    {
      objectApiName: 'WorkOrder',
      flows: [
        {
          apiName: 'Open_Call',
          label: 'Open call',
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

describe('a sweep asked with the removal of a Frozen load', () => {
  let sasDir: string;
  let deps: HandlerDeps;
  let store: ConfigStore;
  let handler: FrozenDatasetHandler;
  let org: ReturnType<typeof targetOrg>;

  const posted = <T extends BaseMessage>(type: string): T[] =>
    vi
      .mocked(deps.broker.postToWebview)
      .mock.calls.map(([m]) => m as T)
      .filter((m) => m.type === type);
  const answer = (): FrozenRemovalResult | undefined =>
    posted<BaseMessage & { payload: { result: FrozenRemovalResult } }>('frozen:remove:response')[0]
      ?.payload.result;
  const errors = (type = 'frozen:remove:error') =>
    posted<BaseMessage & { payload: { code: string; message: string } }>(type);
  const ids = (object: string): string[] => (org.rows.get(object) ?? []).map((row) => row.Id);
  const remove = (payload: Record<string, unknown> = {}) =>
    handler.handle(
      buildMsg('frozen:remove', { targetOrgId: TARGET_ORG, loadedAt: LAST_WRITE, ...payload }),
    );

  beforeEach(async () => {
    vi.clearAllMocks();
    sasDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sandforge-frozen-sweep-'));
    const config: FrozenProjectConfig = {
      rootObject: 'WorkOrder',
      axes: [],
      edgeCases: [],
      sasDir,
    };
    store = new ConfigStore(new InMemoryConfigStoreBackend());
    store.initialize();
    store.set('frozen:config', config, 'frozen');
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
    handler = new FrozenDatasetHandler(deps);
    handler.setTargetAutomation({ read: vi.fn(async () => AUTOMATION) });
    org = targetOrg();
    mockGetConn.mockResolvedValue(org.conn as never);
    await new SasReferenceIdMappingStore(sasDir, {
      orgId: TARGET_ORG,
      organizationId: ORGANIZATION,
      now: () => new Date(LAST_WRITE),
    }).persist(
      new Map([
        ['WorkOrder-000001', WORK_ORDER],
        ['ServiceAppointment-000001', APPOINTMENT],
      ]),
      {
        created: [
          { objectApiName: 'WorkOrder', referenceIds: ['WorkOrder-000001'] },
          { objectApiName: 'ServiceAppointment', referenceIds: ['ServiceAppointment-000001'] },
        ],
        startedAt: new Date(FIRST_WRITE),
        writtenBetween: { first: FIRST_WRITE, last: LAST_WRITE },
      },
    );
  });

  afterEach(() => {
    fs.rmSync(sasDir, { recursive: true, force: true });
  });

  it('keeps the load’s records for what the automation hung under them, without the sweep', async () => {
    // Run for real: "8 kept for records that stay (FeedItem)" for the
    // appointments, and seven work orders kept the same way.
    await remove();

    expect(answer()?.objects.find((o) => o.objectApiName === 'ServiceAppointment')).toMatchObject({
      keptDependents: 1,
      heldBy: ['FeedItem'],
    });
    expect(ids('ServiceAppointment')).toEqual([APPOINTMENT]);
  });

  it('takes what the automation made for the load around its records, which then go', async () => {
    await remove({ sweep: true });

    expect(errors()).toEqual([]);
    const result = answer();
    expect(result?.status).toBe('success');
    expect(result?.sweep).toMatchObject({ status: 'success' });
    // The task first; the feed items hang from the load's records, and go
    // with them, holding none of them back.
    expect(org.deletes[0]).toEqual({ object: 'Task', ids: [id('00T', 1)] });
    expect(result?.sweep?.objects.map((o) => [o.objectApiName, o.deleted, o.alreadyGone])).toEqual(
      expect.arrayContaining([
        ['FeedItem', 0, 2],
        ['Task', 1, 0],
      ]),
    );
    expect(ids('WorkOrder')).toEqual([]);
    expect(ids('ServiceAppointment')).toEqual([]);
    expect(ids('FeedItem')).toEqual([]);
    // What the load's user typed hours later is no side effect of the load.
    expect(ids('Task')).toEqual([id('00T', 2)]);
    const sweep = new AuditTrailStore(store)
      .list()
      .entries.find((entry) => entry.details?.sweep === true);
    expect(sweep).toMatchObject({ module: 'frozen', action: 'cleanup_delete' });
    expect(sweep?.details).toMatchObject({ deleted: 1, loadedAt: LAST_WRITE });
    expect(sweep?.details).not.toHaveProperty('forgeId');
  });

  it('removes the load’s work order though deleting the task the automation opened on it restamped it, a roll-up counting tasks', async () => {
    // The task deleted, the org recalculates the work order's roll-up and
    // dates the work order then, as modified by the session's user. Read
    // after the sweep, the work order was a change since the load.
    org.hooks.onDrop = (object, row) => {
      if (object !== 'Task') return;
      const workOrder = org.rows.get('WorkOrder')?.find((w) => w.Id === row.WhatId);
      if (workOrder) {
        Object.assign(workOrder, {
          LastModifiedDate: new Date().toISOString(),
          LastModifiedById: USER,
        });
      }
    };

    await remove({ sweep: true });

    expect(errors()).toEqual([]);
    const result = answer();
    expect(result?.status).toBe('success');
    expect(result?.objects.find((o) => o.objectApiName === 'WorkOrder')).toMatchObject({
      deleted: 1,
      keptChanged: 0,
    });
    expect(ids('WorkOrder')).toEqual([]);
  });

  describe('the user the load kept, and what a sweep found made for it', () => {
    /** The load's mapping again, kept by a load that says who it wrote as. */
    const loadedAs = (runUserId: string) =>
      new SasReferenceIdMappingStore(sasDir, {
        orgId: TARGET_ORG,
        organizationId: ORGANIZATION,
        now: () => new Date(LAST_WRITE),
      }).persist(
        new Map([
          ['WorkOrder-000001', WORK_ORDER],
          ['ServiceAppointment-000001', APPOINTMENT],
        ]),
        {
          created: [
            { objectApiName: 'WorkOrder', referenceIds: ['WorkOrder-000001'] },
            { objectApiName: 'ServiceAppointment', referenceIds: ['ServiceAppointment-000001'] },
          ],
          startedAt: new Date(FIRST_WRITE),
          writtenBetween: { first: FIRST_WRITE, last: LAST_WRITE },
          runUserId,
        },
      );
    const mapping = () =>
      new SasReferenceIdMappingStore(sasDir, { orgId: TARGET_ORG, organizationId: ORGANIZATION });
    const listing = async (): Promise<ForgeSweepListing | undefined> => {
      await handler.handle(
        buildMsg('frozen:remove:sweep', { targetOrgId: TARGET_ORG, loadedAt: LAST_WRITE }),
      );
      return posted<BaseMessage & { payload: { listing: ForgeSweepListing } }>(
        'frozen:remove:sweep:response',
      ).at(-1)?.payload.listing;
    };

    it('tells the sweep the user the load wrote as, whom its records no longer tell', async () => {
      // Gone from the org and from its recycle bin, the load's records say
      // nothing of who created them: asked of them, the sweep had no user,
      // and looked for nothing.
      org.rows.set('WorkOrder', []);
      org.rows.set('ServiceAppointment', []);
      const notTold = await listing();
      expect(notTold?.refusal).toBeDefined();

      await loadedAs(USER);
      const told = await listing();

      expect(told?.refusal).toBeUndefined();
      expect(told?.found.map((found) => found.objectApiName)).toContain('Task');
    });

    it('tells the removal the user the load wrote as', async () => {
      await loadedAs(USER);

      await remove();

      expect(vi.mocked(removeRunRecords).mock.calls.at(-1)?.[2]).toMatchObject({ runUserId: USER });
    });

    it('asks a load that names no user nothing it does not hold', async () => {
      await remove();

      expect(vi.mocked(removeRunRecords).mock.calls.at(-1)?.[2]).not.toHaveProperty('runUserId');
    });

    it('keeps what the sweep found made for the load', async () => {
      await remove({ sweep: true });

      const [load] = await mapping().recordedLoads();
      expect(load?.madeEarlier).toEqual(
        expect.arrayContaining([id('00T', 1), id('0D5', 1), id('0D5', 2)]),
      );
    });

    it('takes as made for the load what a sweep found so, once nothing ties it any more', async () => {
      // Left by a removal that stopped: the lookup that tied it to the load's
      // work order was cleared with the work order.
      const orphan = rec(id('00T', 3), 'Made for the load', USER, WITH_THEM);
      org.rows.get('Task')?.push(orphan);
      const untiedBefore = await listing();
      const classesOf = (found?: ForgeSweepListing) =>
        found?.found.find((entry) => entry.objectApiName === 'Task')?.classes;
      const madeBefore = classesOf(untiedBefore)?.made ?? 0;

      await mapping().recordMade(LAST_WRITE, [orphan.Id]);
      const told = await listing();

      expect(classesOf(told)?.made).toBe(madeBefore + 1);
    });
  });

  it('lists what a sweep would take, and deletes nothing', async () => {
    await handler.handle(
      buildMsg('frozen:remove:sweep', { targetOrgId: TARGET_ORG, loadedAt: LAST_WRITE }),
    );

    expect(errors('frozen:remove:sweep:error')).toEqual([]);
    const [response] = posted<BaseMessage & { payload: { listing: ForgeSweepListing } }>(
      'frozen:remove:sweep:response',
    );
    expect(response.payload.listing.found.map((f) => [f.objectApiName, f.count])).toEqual(
      expect.arrayContaining([
        ['FeedItem', 2],
        ['Task', 1],
      ]),
    );
    expect(org.deletes).toEqual([]);
  });

  it("reads the target's automation through its own reader, with none handed to it", async () => {
    // The reader was Forge's, handed over once Forge's composition had
    // loaded: listed before, the sweep said the automation was not read, and
    // the task the work-order flow opened was not among what it would take.
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
              ApiName: 'Open_Call',
              Label: 'Open call',
              TriggerType: 'RecordAfterSave',
              RecordTriggerType: 'Create',
              TriggerObjectOrEvent: { QualifiedApiName: 'WorkOrder' },
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
      // The flow version, retrieved by id in a Tooling composite: it opens a
      // task. The sweep's counts, five to a data composite, are answered as
      // queries.
      request: vi.fn(async ({ body }: { body: string }) => {
        const { compositeRequest } = JSON.parse(body) as {
          compositeRequest: Array<{ url: string; referenceId: string }>;
        };
        return {
          compositeResponse: await Promise.all(
            compositeRequest.map(async (sub) => {
              const counted = /\/query\?q=(.*)$/.exec(sub.url);
              return {
                referenceId: sub.referenceId,
                httpStatusCode: 200,
                body: counted
                  ? await conn.query(decodeURIComponent(counted[1]))
                  : sub.url.endsWith(`/Flow/${VERSION}`)
                    ? {
                        Id: VERSION,
                        Metadata: { recordCreates: [{ name: 'Task', object: 'Task' }] },
                      }
                    : { totalSize: 0, done: true, records: [] },
              };
            }),
          ),
        };
      }),
    };
    mockGetConn.mockResolvedValue(conn as never);
    const own = new FrozenDatasetHandler(deps);

    await own.handle(
      buildMsg('frozen:remove:sweep', { targetOrgId: TARGET_ORG, loadedAt: LAST_WRITE }),
    );

    expect(errors('frozen:remove:sweep:error')).toEqual([]);
    const [response] = posted<BaseMessage & { payload: { listing: ForgeSweepListing } }>(
      'frozen:remove:sweep:response',
    );
    expect(asked.some((soql) => /FROM FlowDefinitionView/.test(soql))).toBe(true);
    expect(response.payload.listing.automationGaps?.error).toBeUndefined();
    expect(response.payload.listing.found.map((f) => [f.objectApiName, f.count])).toEqual(
      expect.arrayContaining([['Task', 1]]),
    );
  });

  describe('of a load killed part way, which the target never dated', () => {
    /** A process that is not running: the window whose load was killed. */
    const GONE = 2_147_483_646;
    /** When the killed load wrote its last batch, by this machine's clock. */
    const KILLED_AT = '2026-09-20T10:02:05.000Z';
    /** Half a minute after the load's records were created. */
    const SOON_AFTER = '2026-09-20T10:02:30.000+0000';

    beforeEach(() => {
      // No mapping: the load was killed before it wrote one, and left its
      // journal, which names what it created batch by batch.
      for (const name of fs.readdirSync(sasDir)) {
        if (name.startsWith('referenceid-mapping.')) fs.rmSync(path.join(sasDir, name));
      }
      const lines = [
        { journal: { startedAt: FIRST_WRITE, pid: GONE } },
        {
          at: '2026-09-20T10:02:01.000Z',
          object: 'WorkOrder',
          created: [['WorkOrder-000001', WORK_ORDER]],
        },
        {
          at: KILLED_AT,
          object: 'ServiceAppointment',
          created: [['ServiceAppointment-000001', APPOINTMENT]],
        },
      ];
      fs.writeFileSync(
        path.join(
          sasDir,
          `referenceid-mapping.${TARGET_ORG}.load-${Date.parse(FIRST_WRITE)}.ndjson`,
        ),
        `${lines.map((line) => JSON.stringify(line)).join('\n')}\n{"at":"2026-09`,
      );
      // The two records as the target dated them, and what the automation
      // hung under them half a minute after: within the window their dates make.
      for (const row of [
        ...(org.rows.get('WorkOrder') ?? []),
        ...(org.rows.get('ServiceAppointment') ?? []),
      ]) {
        Object.assign(row, { CreatedDate: DURING_LOAD, LastModifiedDate: DURING_LOAD });
      }
      for (const row of org.rows.get('FeedItem') ?? []) {
        Object.assign(row, { CreatedDate: SOON_AFTER, LastModifiedDate: SOON_AFTER });
      }
      Object.assign(org.rows.get('Task')?.[0] ?? {}, {
        CreatedDate: DURING_LOAD,
        LastModifiedDate: DURING_LOAD,
      });
    });

    it('lists what the automation created while it wrote, dated by the records it created', async () => {
      // Run for real on the trap: "The target did not date this run's
      // writes", the flow having opened a task on each contact the load wrote.
      await handler.handle(
        buildMsg('frozen:remove:sweep', { targetOrgId: TARGET_ORG, loadedAt: KILLED_AT }),
      );

      expect(errors('frozen:remove:sweep:error')).toEqual([]);
      const [response] = posted<BaseMessage & { payload: { listing: ForgeSweepListing } }>(
        'frozen:remove:sweep:response',
      );
      expect(response.payload.listing.refusal).toBeUndefined();
      expect(response.payload.listing.found.map((f) => [f.objectApiName, f.count])).toEqual(
        expect.arrayContaining([
          ['FeedItem', 2],
          ['Task', 1],
        ]),
      );
      expect(org.deletes).toEqual([]);
    });

    it('sweeps it first, and the load’s records then go', async () => {
      await remove({ loadedAt: KILLED_AT, sweep: true });

      expect(errors()).toEqual([]);
      expect(answer()?.sweep).toMatchObject({ status: 'success' });
      expect(
        answer()?.sweep?.objects.map((o) => [o.objectApiName, o.deleted + o.alreadyGone]),
      ).toEqual(
        expect.arrayContaining([
          ['FeedItem', 2],
          ['Task', 1],
        ]),
      );
      expect(answer()?.status).toBe('success');
      expect(ids('WorkOrder')).toEqual([]);
      expect(ids('ServiceAppointment')).toEqual([]);
      // What the load's user typed hours later is no side effect of the load.
      expect(ids('Task')).toEqual([id('00T', 2)]);
    });
  });

  describe('told what ties a record to the load', () => {
    const ASSET = id('02i', 1);
    const LOOSE = id('00T', 6);
    let tied: TiedTargetOrg;

    /**
     * The target after the load: its work order names the asset the flow made
     * (`WorkOrder.AssetId`, which refuses the asset's delete while the work
     * order stands); a task the load's user typed in its window, tied to
     * nothing of it.
     */
    const tiedOrg = (): TiedTargetOrg => {
      const org = tiedTargetOrg(USER);
      org.shape('Organization', { fields: ['Id'] });
      org.add('Organization', { Id: ORGANIZATION });
      org.shape('WorkOrder', { references: { AssetId: ['Asset'] } });
      org.shape('ServiceAppointment', {
        references: { ParentRecordId: ['WorkOrder'] },
      });
      org.shape('Asset', {
        children: [{ childSObject: 'WorkOrder', field: 'AssetId', restrictedDelete: true }],
      });
      org.shape('Task', { references: { WhatId: ['WorkOrder'] } });
      const made = (recordId: string, name: string, at: string, more = {}) => ({
        ...rec(recordId, name, USER, at, more),
        SystemModstamp: at,
      });
      org.add('WorkOrder', made(WORK_ORDER, 'Repair', NEAR_ITS_END, { AssetId: ASSET }));
      org.add(
        'ServiceAppointment',
        made(APPOINTMENT, 'Visit', NEAR_ITS_END, { ParentRecordId: WORK_ORDER }),
      );
      org.add('Asset', made(ASSET, 'Insured risk', WITH_THEM));
      org.add('Task', made(LOOSE, 'Loose task', WITH_THEM));
      return org;
    };

    beforeEach(() => {
      tied = tiedOrg();
      mockGetConn.mockResolvedValue(tied.conn as never);
    });

    it('deletes the asset the work order names once it is gone, and keeps what is tied to nothing unasked', async () => {
      await remove({ sweep: true });

      expect(errors()).toEqual([]);
      const objects = tied.deletes.map((call) => call.object);
      expect(objects.indexOf('Asset')).toBeGreaterThan(objects.indexOf('WorkOrder'));
      expect(tied.ids('Asset')).toEqual([]);
      expect(tied.ids('Task')).toEqual([LOOSE]);
      expect(answer()?.status).toBe('success');
      expect(answer()?.sweep?.objects).toEqual([
        expect.objectContaining({ objectApiName: 'Asset', deleted: 1, afterRemoval: 1 }),
      ]);
      expect(tied.composites.length).toBeGreaterThan(0);
    });

    it('takes what is tied to nothing when asked', async () => {
      await remove({ sweep: true, sweepUntied: true });

      expect(errors()).toEqual([]);
      expect(tied.ids('Task')).toEqual([]);
    });

    it('keeps what is tied to nothing, asked or not, while a run of another module wrote in the window', async () => {
      const during = Date.parse(LAST_WRITE) - 1_000;
      handler.setOtherModuleRuns(async () => [
        { ids: [], idsUntold: true, from: during, to: during },
      ]);

      await remove({ sweep: true, sweepUntied: true });

      expect(tied.ids('Task')).toEqual([LOOSE]);
    });

    it('lists none of the lines the platform copied under a quote the load synced: its removal names them', async () => {
      const { created } = addSyncedQuote(tied, USER, NEAR_ITS_END);
      const keyed = created.flatMap(({ objectApiName, ids: recordIds }) =>
        recordIds.map((recordId) => ({ objectApiName, key: `${objectApiName}-1`, recordId })),
      );
      await new SasReferenceIdMappingStore(sasDir, {
        orgId: TARGET_ORG,
        organizationId: ORGANIZATION,
        now: () => new Date(LAST_WRITE),
      }).persist(new Map(keyed.map(({ key, recordId }) => [key, recordId])), {
        created: keyed.map(({ objectApiName, key }) => ({ objectApiName, referenceIds: [key] })),
        startedAt: new Date(FIRST_WRITE),
        writtenBetween: { first: FIRST_WRITE, last: LAST_WRITE },
      });

      await handler.handle(
        buildMsg('frozen:remove:sweep', { targetOrgId: TARGET_ORG, loadedAt: LAST_WRITE }),
      );

      const [response] = posted<BaseMessage & { payload: { listing: ForgeSweepListing } }>(
        'frozen:remove:sweep:response',
      );
      expect(response?.payload.listing.looked).toContain('QuoteLineItem');
      expect(response?.payload.listing.found.map((found) => found.objectApiName)).not.toContain(
        'QuoteLineItem',
      );
    });

    it('keeps what is tied to nothing while another load of this sas wrote in the window', async () => {
      tied.add('Task', rec(id('00T', 7), 'Their task', USER, '2026-09-20T10:03:30.000+0000'));
      await new SasReferenceIdMappingStore(sasDir, {
        orgId: TARGET_ORG,
        organizationId: ORGANIZATION,
        now: () => new Date('2026-09-20T10:04:00.000Z'),
      }).persist(new Map([['Their-000001', id('00T', 7)]]), {
        created: [{ objectApiName: 'Task', referenceIds: ['Their-000001'] }],
        startedAt: new Date('2026-09-20T10:03:00.000Z'),
        earlier: { settled: [] },
        writtenBetween: {
          first: '2026-09-20T10:03:00.000Z',
          last: '2026-09-20T10:04:00.000Z',
        },
      });
      // The load to remove is the last one recorded, whichever a removal takes next.
      await handler.handle(
        buildMsg('frozen:remove:sweep', {
          targetOrgId: TARGET_ORG,
          loadedAt: '2026-09-20T10:04:00.000Z',
        }),
      );
      expect(errors('frozen:remove:sweep:error')).toEqual([]);
      const [response] = posted<BaseMessage & { payload: { listing: ForgeSweepListing } }>(
        'frozen:remove:sweep:response',
      );
      expect(response?.payload.listing.untied?.refusal ?? '').toMatch(
        /Another run of this machine wrote to the target/,
      );
    });
  });

  it('refuses to list a sweep for a load other than the one shown', async () => {
    await handler.handle(
      buildMsg('frozen:remove:sweep', {
        targetOrgId: TARGET_ORG,
        loadedAt: '2026-09-19T08:00:00.000Z',
      }),
    );

    expect(errors('frozen:remove:sweep:error')[0]?.payload.code).toBe('LOAD_CHANGED');
  });
});
