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
import { BackgroundOperationRegistry } from '../../core/engine/BackgroundOperationRegistry.js';
import { ProductionGuard } from '../../core/precheck/ProductionGuard.js';
import { ConfigStore } from '../../core/storage/ConfigStore.js';
import { AuditTrailStore } from '../../modules/audit/auditTrail.js';
import {
  writePathOrderDefects,
  type WritePathStep,
} from '../../modules/checkpoint/beforeRunCheckpoint.js';
import { nodeSeedRunCreations } from '../../modules/seed/SeedRunCreations.js';
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

  describe('told what ties a record to the run', () => {
    const LOOSE = id('00T', 6);
    let tied: TiedTargetOrg;

    /**
     * The target after a seed of an account and a contact: the welcome call
     * the contact's flow opened under it, and a task the seed's user typed in
     * the seed's window, tied to nothing of it.
     */
    const tiedOrg = (): TiedTargetOrg => {
      const org = tiedTargetOrg(USER);
      org.shape('Account', {
        children: [{ childSObject: 'Contact', field: 'AccountId', cascadeDelete: true }],
      });
      org.shape('Contact', {
        references: { AccountId: ['Account'] },
        children: [{ childSObject: 'Task', field: 'WhoId' }],
      });
      org.shape('Task', { references: { WhoId: ['Contact'] } });
      const made = (recordId: string, name: string, at: string, more = {}) => ({
        ...rec(recordId, name, USER, at, more),
        SystemModstamp: at,
      });
      org.add('Account', made(ACCOUNT, 'Seeded Co', SEEDED));
      org.add('Contact', made(CONTACT, 'Seeded Person', SEEDED, { AccountId: ACCOUNT }));
      org.add(
        'Task',
        made(FLOW_TASK, 'Welcome call', JUST_AFTER, { WhoId: CONTACT }),
        made(LOOSE, 'Loose task', JUST_AFTER),
      );
      return org;
    };

    /** Keep a seed of this machine, as the panel's Seed keeps one. */
    const keep = async (runId: string, created: Array<[string, string[]]>, runUserId?: string) => {
      const runs = nodeSeedRunCreations(storage);
      await runs.record({
        runId,
        targetOrgId: TARGET_ORG,
        startedAt: STARTED,
        finishedAt: FINISHED,
        status: 'success',
        objectResults: created.map(([objectApiName, createdIds]) => ({
          objectApiName,
          createdIds,
        })),
        ...(runUserId ? { runUserId } : {}),
      });
      handler.setRunCreations(runs);
    };

    beforeEach(() => {
      tied = tiedOrg();
      vi.mocked(getJsforceConnection).mockResolvedValue(tied.conn as never);
    });

    it('takes the welcome call, and keeps what is tied to nothing unasked', async () => {
      await handler.handle(buildMsg('seed:remove', { runId: 'op-seed', sweep: true }));

      expect(errors()).toEqual([]);
      expect(tied.ids('Task')).toEqual([LOOSE]);
      expect(answer()?.sweep?.objects).toEqual([
        expect.objectContaining({ objectApiName: 'Task', found: 1, deleted: 1 }),
      ]);
    });

    it('takes what is tied to nothing when asked', async () => {
      await handler.handle(
        buildMsg('seed:remove', { runId: 'op-seed', sweep: true, sweepUntied: true }),
      );

      expect(errors()).toEqual([]);
      expect(tied.ids('Task')).toEqual([]);
    });

    it('keeps what is tied to nothing while another seed of this machine wrote in the window', async () => {
      await keep('op-other', [['Contact', [id('003', 7)]]]);
      tied.add('Contact', rec(id('003', 7), 'Their person', USER, SEEDED));

      await handler.handle(buildMsg('seed:remove:sweep', { runId: 'op-seed' }));
      const [response] = posted<BaseMessage & { payload: { listing: ForgeSweepListing } }>(
        'seed:remove:sweep:response',
      );
      expect(response.payload.listing.untied?.refusal).toMatch(/^Another run of this machine/);

      await handler.handle(
        buildMsg('seed:remove', { runId: 'op-seed', sweep: true, sweepUntied: true }),
      );
      expect(tied.ids('Task')).toEqual([LOOSE]);
      expect(tied.ids('Contact')).toEqual([id('003', 7)]);
    });

    it('lists none of the lines the platform copied under a quote the seed synced: its removal names them', async () => {
      const { created } = addSyncedQuote(tied, USER, SEEDED);
      await keep(
        'op-quote',
        created.map(({ objectApiName, ids: recordIds }) => [objectApiName, recordIds]),
      );

      await handler.handle(buildMsg('seed:remove:sweep', { runId: 'op-quote' }));

      const [response] = posted<BaseMessage & { payload: { listing: ForgeSweepListing } }>(
        'seed:remove:sweep:response',
      );
      expect(response.payload.listing.looked).toContain('QuoteLineItem');
      expect(response.payload.listing.found.map((found) => found.objectApiName)).not.toContain(
        'QuoteLineItem',
      );
    });

    it('keeps what it found made, and takes it once the record that told the tie is gone', async () => {
      // A colleague edits the contact after the seed: the removal keeps it,
      // and the call under it.
      Object.assign(tied.row('Contact', CONTACT) ?? {}, {
        LastModifiedDate: LONG_AFTER,
        SystemModstamp: LONG_AFTER,
        LastModifiedById: id('005', 2),
      });
      Object.assign(tied.row('Task', FLOW_TASK) ?? {}, {
        LastModifiedDate: LONG_AFTER,
        SystemModstamp: LONG_AFTER,
        LastModifiedById: id('005', 2),
      });
      await handler.handle(buildMsg('seed:remove', { runId: 'op-seed', sweep: true }));
      expect(tied.ids('Task')).toContain(FLOW_TASK);
      const kept = await nodeSeedRunCreations(storage).get('op-seed');
      expect(kept?.removal?.madeEarlier).toEqual([FLOW_TASK]);

      // Then the contact goes by hand, and the org empties the task's lookup.
      const contact = tied.row('Contact', CONTACT);
      tied.rows.set('Contact', []);
      if (contact) tied.bin.set('Contact', [contact]);
      Object.assign(tied.row('Task', FLOW_TASK) ?? {}, { WhoId: null });
      vi.mocked(deps.broker.postToWebview).mockClear();

      await handler.handle(buildMsg('seed:remove:sweep', { runId: 'op-seed' }));
      const [response] = posted<BaseMessage & { payload: { listing: ForgeSweepListing } }>(
        'seed:remove:sweep:response',
      );
      expect(
        response.payload.listing.found.find((found) => found.objectApiName === 'Task')?.classes,
      ).toMatchObject({ made: 1, untied: 1 });

      await handler.handle(
        buildMsg('seed:remove', { runId: 'op-seed', sweep: true, includeChanged: true }),
      );
      expect(tied.ids('Task')).toEqual([LOOSE]);
    });

    it('keeps what is tied to nothing while a run of another module wrote in the window', async () => {
      const during = Date.parse(FINISHED) - 1_000;
      handler.setOtherModuleRuns(async () => [
        { ids: [], idsUntold: true, from: during, to: during },
      ]);

      await handler.handle(buildMsg('seed:remove:sweep', { runId: 'op-seed' }));
      const [response] = posted<BaseMessage & { payload: { listing: ForgeSweepListing } }>(
        'seed:remove:sweep:response',
      );
      expect(response.payload.listing.untied?.refusal).toMatch(/^Another run of this machine/);

      await handler.handle(
        buildMsg('seed:remove', { runId: 'op-seed', sweep: true, sweepUntied: true }),
      );
      expect(tied.ids('Task')).toEqual([LOOSE]);
    });

    it('names its runs on an org for the sweep of another module’s run', async () => {
      const [run] = await handler.localRunsOn(TARGET_ORG);

      expect(run?.ids).toEqual([ACCOUNT, CONTACT]);
      expect(await handler.localRunsOn('another-org')).toEqual([]);
    });

    it('assigns nothing once a stop came while the sweep asked', async () => {
      const leases = mkdtempSync(join(tmpdir(), 'sandforge-seed-sweep-stop-'));
      try {
        handler.setMuteLeases({ dir: leases, renewEveryMs: 0 });
        handler.setTargetAutomation({ read: vi.fn(async () => ON_DELETE) });
        const { conn } = leasedConnection(tied, USER);
        vi.mocked(getJsforceConnection).mockResolvedValue(conn as never);
        const registry = new BackgroundOperationRegistry();
        handler.setRegistry(registry);
        const guard = deps.infraServices?.productionGuard as ProductionGuard;
        const confirmed = guard.confirmIfNeeded.bind(guard);
        vi.spyOn(guard, 'confirmIfNeeded').mockImplementation((asked, tier) => {
          for (const op of registry.getRunning()) registry.abort(op.operationId);
          return confirmed(asked, tier);
        });

        await handler.handle(
          buildMsg('seed:remove', { runId: 'op-seed', sweep: true, muteAutomation: true }),
        );

        expect(answer()?.status).toBe('cancelled');
        expect(tied.events as string[]).not.toContain('leaseAcquire');
        expect(tied.ids('Contact')).toEqual([CONTACT]);
      } finally {
        rmSync(leases, { recursive: true, force: true });
      }
    });

    it('asks the sweep’s question before the lease, and holds none while it waits', async () => {
      const leases = mkdtempSync(join(tmpdir(), 'sandforge-seed-sweep-leases-'));
      try {
        handler.setMuteLeases({ dir: leases, renewEveryMs: 0 });
        handler.setTargetAutomation({ read: vi.fn(async () => ON_DELETE) });
        const { conn, permissions } = leasedConnection(tied, USER);
        vi.mocked(getJsforceConnection).mockResolvedValue(conn as never);
        const guard = deps.infraServices?.productionGuard as ProductionGuard;
        const check = guard.check.bind(guard);
        const steps: string[] = tied.events;
        vi.spyOn(guard, 'check').mockImplementation((request) => {
          steps.push('question');
          return check(request);
        });
        let held: number | undefined;
        const confirmed = guard.confirmIfNeeded.bind(guard);
        vi.spyOn(guard, 'confirmIfNeeded').mockImplementation((asked, orgName) => {
          held = permissions.assignments().length;
          return confirmed(asked, orgName);
        });

        await handler.handle(
          buildMsg('seed:remove', { runId: 'op-seed', sweep: true, muteAutomation: true }),
        );

        expect(errors()).toEqual([]);
        expect(answer()?.mutedAutomation).toMatchObject({
          state: 'muted',
          assigned: ['Data_Load'],
        });
        expect(held).toBe(0);
        expect(steps.filter((step) => step === 'question')).toHaveLength(2);
        expect(steps.indexOf('leaseAcquire')).toBeGreaterThan(steps.lastIndexOf('question'));
        expect(writePathOrderDefects([...steps, 'result'] as WritePathStep[])).toEqual([]);
        expect(permissions.assignments()).toEqual([]);
      } finally {
        rmSync(leases, { recursive: true, force: true });
      }
    });

    it('takes the user the seed’s file keeps, reading none of its records to tell it', async () => {
      await keep(
        'op-user',
        [
          ['Account', [ACCOUNT]],
          ['Contact', [CONTACT]],
        ],
        USER,
      );

      await handler.handle(buildMsg('seed:remove:sweep', { runId: 'op-user' }));

      expect(errors('seed:remove:sweep:error')).toEqual([]);
      expect(tied.queries.some((soql) => soql.startsWith('SELECT CreatedById FROM'))).toBe(false);
      expect(tied.queries.some((soql) => soql.includes(`CreatedById = '${USER}'`))).toBe(true);
    });
  });

  it('leaves the task the flow opened to a removal asked without the sweep', async () => {
    await handler.handle(buildMsg('seed:remove', { runId: 'op-seed' }));

    expect(answer()?.sweep).toBeUndefined();
    expect(ids('Task')).toEqual([FLOW_TASK, TYPED_TASK]);
  });

  it('lists a run with the checkpoint it took first, kept in its file: what the list offers a rewind from', async () => {
    const taken = {
      state: 'taken' as const,
      checkpointId: 'ck-20261101-101500-a1b2',
      name: 'Before Seed run 2026-11-01 10:15 UTC',
      takenAt: '2026-11-01T10:15:04.000Z',
      expiresAt: null,
      objects: ['Account'],
      records: 12,
      bytes: 400_000,
      requests: 68,
      added: [],
      notHeld: [],
    };
    const runs = nodeSeedRunCreations(storage);
    const recorder = runs.recorder({ runId: 'op-ck', targetOrgId: TARGET_ORG });
    recorder.checkpoint?.(taken);
    recorder.note('Account', [id('001', 3)]);
    await recorder.end({ status: 'success', objectResults: [] });

    await handler.handle(buildMsg('seed:removal:list'));

    const [response] = posted<
      BaseMessage & { payload: { runs: Array<{ runId: string; checkpoint?: unknown }> } }
    >('seed:removal:list:response');
    const lines = new Map(response.payload.runs.map((run) => [run.runId, run]));
    expect(lines.get('op-ck')?.checkpoint).toEqual(taken);
    expect(lines.get('op-seed')).not.toHaveProperty('checkpoint');
  });
});
