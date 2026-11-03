import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type {
  BaseMessage,
  ForgeTargetAutomation,
  FrozenLoadReportInfo,
  FrozenProjectConfig,
  FrozenReloadSweepListing,
} from '@sandforge/shared';

import { FrozenDatasetHandler, type FrozenRemovalQuestion } from './FrozenDatasetHandler.js';
import type { HandlerDeps, InboundRequest } from './HandlerTypes.js';
import { ProductionGuard } from '../../core/precheck/ProductionGuard.js';
import { ConfigStore } from '../../core/storage/ConfigStore.js';
import { AuditTrailStore } from '../../modules/audit/auditTrail.js';
import {
  buildFrozenManifest,
  SasReferenceIdMappingStore,
  type FrozenLoadOptions,
  type FrozenDatasetLoaderDeps,
} from '../../modules/frozendataset/index.js';
import { InMemoryConfigStoreBackend } from '../../test/InMemoryConfigStoreBackend.js';
import { inboundRequest } from '../../test/mockFactories.js';
import { memoryPermissionOrg } from '../../test/memoryPermissionOrg.js';
import { tiedTargetOrg, type TiedTargetOrg } from '../../test/tiedTargetOrg.js';

vi.mock('../../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../core/connection/ConnectionHelper.js', () => ({
  getJsforceConnection: vi.fn(),
}));
vi.mock('../../core/common/sforceLimitParser.js', () => ({
  checkApiLimits: vi.fn(),
}));

/**
 * The loader's load, scripted: its purge is what is tested, as the loader
 * runs it — the sweep's first part, the deletes of what the load before
 * created, children first, then the sweep's last part — on the fake org. The
 * order the loader keeps is tested beside the loader; here, what the handler
 * hands it, asks first, and says after.
 */
const loaderLoad = vi.hoisted(() => vi.fn());
vi.mock('../../modules/frozendataset/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../modules/frozendataset/index.js')>();
  return {
    ...actual,
    FrozenDatasetLoader: vi.fn().mockImplementation(function (deps: FrozenDatasetLoaderDeps) {
      return {
        gateLoad: async () => 'allowed',
        load: (options: FrozenLoadOptions) => loaderLoad(options, deps),
      };
    }),
  };
});

import { getJsforceConnection } from '../../core/connection/ConnectionHelper.js';

/** A fake record id: the object's prefix, then a counter. */
const id = (prefix: string, n: number): string => `${prefix}${String(n).padStart(12, '0')}AAA`;

const TARGET_ORG = 'org-dev';
const ORGANIZATION = id('00D', 9);
const USER = id('005', 1);
const ACCOUNT = id('001', 1);
const CONTACT = id('003', 1);
/** The task the target's flow opened on the contact as the load wrote it. */
const TASK = id('00T', 1);

/** The load the reload replaces, as the target dated it. */
const FIRST_WRITE = '2026-10-01T10:00:00.000Z';
const LAST_WRITE = '2026-10-01T10:05:00.000Z';
const NEAR_ITS_END = '2026-10-01T10:04:50.000+0000';
/** A second after the contact: what a flow in the same save opens. */
const WITH_IT = '2026-10-01T10:04:51.000+0000';

/** What the target runs as a task is deleted: a flow whose bypass `Data_Load` holds. */
function onTheTask(_orgId: string, objects: readonly string[]): Promise<ForgeTargetAutomation> {
  return Promise.resolve({
    objectsRead: [...objects],
    objects: objects.includes('Task')
      ? [
          {
            objectApiName: 'Task',
            flows: [
              {
                apiName: 'Task_Gone',
                label: 'Task gone',
                timing: 'beforeSave',
                startsOn: 'delete',
                condition: 'read',
                permissions: [{ name: 'Load_Data', bypass: true }],
              },
            ],
            triggers: [],
          },
        ]
      : [],
    bypassGrants: [
      {
        permission: 'Load_Data',
        permissionSets: [{ name: 'Data_Load', label: 'Data load', grants: 1 }],
      },
    ],
    unread: [],
  } as unknown as ForgeTargetAutomation);
}

/** The objects the permission org answers for: the mute's reads of the permission sets. */
const PERMISSION_OBJECTS =
  /\bFROM\s+(UserPermissionAccess|PermissionSetAssignment|SetupEntityAccess|ObjectPermissions|CustomPermission|PermissionSet)\b/i;

/** The report of a reload whose purge took the account and the contact. */
function reloadReport(): Record<string, unknown> {
  return {
    status: 'completed',
    orgId: TARGET_ORG,
    mode: { pilot: false, reload: true },
    startedAt: '2026-10-02T09:00:00.000Z',
    durationMs: 10,
    alignment: {
      objectResults: [],
      excludedObjects: [],
      removals: [],
      adjustments: [],
      recordTypeIssues: [],
    },
    placeholders: [],
    requiredDefaults: [],
    perObject: [],
    pass2: { resolved: 0, unresolved: [] },
    personContact: { restored: 0, sent: [], unresolved: [] },
    statuses: { restored: 0, refused: [] },
    purge: { deleted: { Contact: 1, Account: 1 }, deactivated: {}, failures: [] },
    mappingPath: '',
    contractPath: path.join(os.tmpdir(), 'no-such-contract.json'),
  };
}

function buildMsg(type: string, payload?: unknown): InboundRequest {
  return inboundRequest({
    id: `req-${type}`,
    type,
    timestamp: Date.now(),
    ...(payload !== undefined ? { payload } : {}),
  } as BaseMessage);
}

describe('a reload asked to sweep what the automation made for the loads it replaces', () => {
  let sasDir: string;
  let deps: HandlerDeps;
  let store: ConfigStore;
  let handler: FrozenDatasetHandler;
  let tied: TiedTargetOrg;
  let read: ReturnType<typeof vi.fn<typeof onTheTask>>;

  const posted = <T extends BaseMessage>(type: string): T[] =>
    vi
      .mocked(deps.broker.postToWebview)
      .mock.calls.map(([m]) => m as T)
      .filter((m) => m.type === type);
  const report = (): FrozenLoadReportInfo | undefined =>
    posted<BaseMessage & { payload: { report: FrozenLoadReportInfo } }>('frozen:load:response')[0]
      ?.payload.report;
  const errors = (type = 'frozen:load:error') =>
    posted<BaseMessage & { payload: { code: string; message: string } }>(type);
  const reload = (payload: Record<string, unknown> = {}) =>
    handler.handle(buildMsg('frozen:load', { targetOrgId: TARGET_ORG, reload: true, ...payload }));

  /**
   * The target after the load: its account, its contact, and the task the
   * target's flow opened on the contact as the load's user, which the load's
   * mapping does not hold.
   */
  function targetOrg(): TiedTargetOrg {
    const org = tiedTargetOrg(USER);
    org.shape('Organization', { fields: ['Id'] });
    org.add('Organization', { Id: ORGANIZATION });
    org.shape('Account', {
      children: [{ childSObject: 'Contact', field: 'AccountId', cascadeDelete: true }],
    });
    org.shape('Contact', {
      references: { AccountId: ['Account'] },
      children: [{ childSObject: 'Task', field: 'WhoId' }],
    });
    org.shape('Task', { references: { WhoId: ['Contact'] } });
    const made = (recordId: string, name: string, at: string, more = {}) => ({
      Id: recordId,
      Name: name,
      CreatedById: USER,
      CreatedDate: at,
      LastModifiedDate: at,
      LastModifiedById: USER,
      SystemModstamp: at,
      ...more,
    });
    org.add('Account', made(ACCOUNT, 'Loaded account', NEAR_ITS_END));
    org.add('Contact', made(CONTACT, 'Loaded contact', NEAR_ITS_END, { AccountId: ACCOUNT }));
    org.add('Task', made(TASK, 'Follow up', WITH_IT, { WhoId: CONTACT }));
    return org;
  }

  /** The dataset loaded again: an account and a contact. */
  function writeDataset(): void {
    const datasetDir = path.join(sasDir, 'dataset');
    fs.mkdirSync(path.join(datasetDir, 'data'), { recursive: true });
    const manifest = buildFrozenManifest({
      version: '1.2.0',
      source: { orgId: id('00D', 2), decisionDate: '2026-09-01' },
      saltFingerprint: 'abcdef012345',
      rulesVersion: '1.0.0',
      volumetry: { budgetMax: 100, measured: {}, measuredAt: '2026-09-01T00:00:00.000Z' },
      nonReidentification: {
        passed: true,
        checks: [],
        author: 'qa',
        checkedAt: '2026-09-01T00:00:00.000Z',
      },
      author: 'qa',
    });
    fs.writeFileSync(path.join(datasetDir, 'manifest.json'), JSON.stringify(manifest));
    const data = (objectApiName: string, ids: string[]) =>
      JSON.stringify({
        objectApiName,
        records: ids.map((referenceId) => ({ referenceId, fields: { Name: referenceId } })),
      });
    fs.writeFileSync(path.join(datasetDir, 'data', 'Account.json'), data('Account', ['A1']));
    fs.writeFileSync(path.join(datasetDir, 'data', 'Contact.json'), data('Contact', ['C1']));
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    sasDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sandforge-frozen-reload-sweep-'));
    writeDataset();
    const config: FrozenProjectConfig = {
      rootObject: 'Account',
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
    read = vi.fn(onTheTask);
    handler.setTargetAutomation({ read });
    tied = targetOrg();
    vi.mocked(getJsforceConnection).mockResolvedValue(tied.conn as never);
    await new SasReferenceIdMappingStore(sasDir, {
      orgId: TARGET_ORG,
      organizationId: ORGANIZATION,
      now: () => new Date(LAST_WRITE),
    }).persist(
      new Map([
        ['Account-000001', ACCOUNT],
        ['Contact-000001', CONTACT],
      ]),
      {
        created: [
          { objectApiName: 'Account', referenceIds: ['Account-000001'] },
          { objectApiName: 'Contact', referenceIds: ['Contact-000001'] },
        ],
        startedAt: new Date(FIRST_WRITE),
        writtenBetween: { first: FIRST_WRITE, last: LAST_WRITE },
        runUserId: USER,
      },
    );
    // The purge as the loader runs it: the sweep's first part, the load
    // before's records, children first, then the sweep's last part.
    loaderLoad.mockImplementation(async (options: FrozenLoadOptions) => {
      await options.purgeSweep?.first();
      for (const object of ['Contact', 'Account']) {
        const ids = tied.ids(object);
        if (ids.length > 0) await tied.conn.sobject(object).destroy(ids);
      }
      if (!options.signal?.aborted) await options.purgeSweep?.afterPurge();
      return reloadReport();
    });
  });

  afterEach(() => {
    fs.rmSync(sasDir, { recursive: true, force: true });
  });

  it('leaves the task the flow opened without the sweep, as the purge alone did on a real org', async () => {
    await reload();

    expect(errors()).toEqual([]);
    expect(tied.ids('Contact')).toEqual([]);
    expect(tied.ids('Task')).toEqual([TASK]);
    expect(report()).not.toHaveProperty('sweeps');
    expect(loaderLoad.mock.calls[0]?.[0]).not.toHaveProperty('purgeSweep');
  });

  it('takes the task before the load’s records go, and says so in the report, per load replaced', async () => {
    await reload({ sweep: true });

    expect(errors()).toEqual([]);
    expect(tied.ids('Task')).toEqual([]);
    const objects = tied.deletes.map((call) => call.object);
    expect(objects.indexOf('Task')).toBeLessThan(objects.indexOf('Contact'));
    expect(report()?.sweeps).toEqual([
      {
        loadedAt: LAST_WRITE,
        result: expect.objectContaining({
          status: 'success',
          objects: [expect.objectContaining({ objectApiName: 'Task', deleted: 1 })],
        }),
      },
    ]);
    expect(
      posted<BaseMessage & { payload: unknown }>('operation:completed').at(-1)?.payload,
    ).toMatchObject({
      result: { status: 'completed' },
    });
  });

  it('records the sweep in the audit trail beside the load, dated by the load it swept', async () => {
    await reload({ sweep: true });

    const entries = new AuditTrailStore(store).list().entries;
    expect(entries.find((entry) => entry.action === 'frozen_load')).toBeDefined();
    expect(
      entries.find((entry) => entry.action === 'cleanup_delete' && entry.module === 'frozen'),
    ).toMatchObject({
      outcome: 'success',
      details: expect.objectContaining({ loadedAt: LAST_WRITE }),
    });
  });

  it('ends partial, never a success, when Production Guard refused the sweep, and takes nothing of it', async () => {
    const guard = new ProductionGuard();
    const check = guard.check.bind(guard);
    vi.spyOn(guard, 'check').mockImplementation((request) =>
      request.objectName === 'Task'
        ? { ...check(request), allowed: false, blockedReason: 'no deletes of tasks here' }
        : check(request),
    );
    deps.infraServices = { productionGuard: guard } as unknown as HandlerDeps['infraServices'];
    handler = new FrozenDatasetHandler(deps);
    handler.setTargetAutomation({ read });

    await reload({ sweep: true });

    expect(tied.ids('Task')).toEqual([TASK]);
    // Said completed, the Load tab drew a green badge above a refused sweep.
    expect(report()?.status).toBe('partial');
    expect(report()?.sweeps?.[0]?.result).toMatchObject({
      status: 'refused',
      refusal: expect.stringContaining('no deletes of tasks here'),
    });
    expect(
      posted<BaseMessage & { payload: unknown }>('operation:completed').at(-1)?.payload,
    ).toMatchObject({
      result: { status: 'partial' },
    });
    expect(store.get<{ status: string }>('frozen:lastRun')?.status).toBe('partial');
  });

  it('stays completed when its sweep took all it was asked to and kept what came late', async () => {
    // Made five minutes after the contact: late, listed and kept unasked.
    const LATE = '2026-10-01T10:10:00.000+0000';
    Object.assign(tied.row('Task', TASK)!, {
      CreatedDate: LATE,
      LastModifiedDate: LATE,
      SystemModstamp: LATE,
    });

    await reload({ sweep: true });

    expect(report()?.sweeps?.[0]?.result.status).toBe('success');
    expect(report()?.status).toBe('completed');
  });

  it('mutes what fires as the sweep deletes, read with the rest, or the flow on the task runs', async () => {
    const leases = fs.mkdtempSync(path.join(os.tmpdir(), 'sandforge-frozen-reload-leases-'));
    try {
      handler.setMuteLeases({ dir: leases, renewEveryMs: 0 });
      const permissions = memoryPermissionOrg({
        userId: USER,
        organizationId: ORGANIZATION,
        sets: [{ id: '0PS000000000001AAA', name: 'Data_Load' }],
      });
      vi.mocked(getJsforceConnection).mockResolvedValue({
        ...tied.conn,
        identity: permissions.connection.identity,
        query: (soql: string, options?: { scanAll?: boolean }) =>
          soql.startsWith('SELECT Id, IsSandbox')
            ? Promise.resolve({ records: [{ Id: ORGANIZATION, IsSandbox: true }] })
            : PERMISSION_OBJECTS.test(soql)
              ? permissions.connection.query(soql)
              : tied.conn.query(soql, options),
        sobject: (name: string) =>
          name === 'PermissionSetAssignment'
            ? permissions.connection.sobject(name)
            : tied.conn.sobject(name),
      } as never);

      await reload({ sweep: true, muteAutomation: true });

      expect(errors()).toEqual([]);
      expect(read.mock.calls.at(-1)?.[1]).toEqual(expect.arrayContaining(['Task']));
      expect(report()?.mutedAutomation).toMatchObject({
        state: 'muted',
        assigned: ['Data_Load'],
        released: true,
        silenced: [expect.objectContaining({ objectApiName: 'Task' })],
      });
      expect(permissions.assignments()).toEqual([]);
    } finally {
      fs.rmSync(leases, { recursive: true, force: true });
    }
  });

  describe('on the command line, which asks before the first delete', () => {
    it('asks of what fires on what the sweep takes, once it has read it, and writes nothing when stopped', async () => {
      let asked: FrozenRemovalQuestion | undefined;
      handler.setRemovalAsker(async (question) => {
        asked = question;
        return { message: 'not accepted', code: 'AUTOMATION_NOT_ACCEPTED' };
      });

      await reload({ sweep: true });

      expect(asked?.steps.delete).toEqual(['Task']);
      expect(asked?.read).toMatchObject({
        objects: [expect.objectContaining({ objectApiName: 'Task' })],
      });
      expect(errors()[0]?.payload).toMatchObject({ code: 'AUTOMATION_NOT_ACCEPTED' });
      expect(loaderLoad).not.toHaveBeenCalled();
      expect(tied.deletes).toEqual([]);
      expect(
        new AuditTrailStore(store).list().entries.find((entry) => entry.action === 'frozen_load'),
      ).toMatchObject({ outcome: 'stopped', details: { code: 'AUTOMATION_NOT_ACCEPTED' } });
    });

    it('asks nothing of a reload with no sweep: the command line asked of its purge before it sent it', async () => {
      const asker = vi.fn(async () => undefined);
      handler.setRemovalAsker(asker);

      await reload();

      expect(asker).not.toHaveBeenCalled();
      expect(loaderLoad).toHaveBeenCalledTimes(1);
    });
  });

  it('lists what the sweep would take for each load it replaces, and deletes nothing', async () => {
    await handler.handle(
      buildMsg('frozen:remove:sweep', {
        targetOrgId: TARGET_ORG,
        loadedAt: LAST_WRITE,
        reload: true,
      }),
    );

    const answer = posted<BaseMessage & { payload: { loads: FrozenReloadSweepListing[] } }>(
      'frozen:remove:sweep:response',
    )[0]?.payload;
    expect(answer?.loads).toEqual([
      {
        loadedAt: LAST_WRITE,
        listing: expect.objectContaining({
          found: [expect.objectContaining({ objectApiName: 'Task' })],
        }),
      },
    ]);
    expect(tied.deletes).toEqual([]);
  });

  it('lists nothing to take of a target refreshed since, rather than another load recorded since', async () => {
    // The command line reads this list before a reload with a sweep, and
    // stopped on its error: a refreshed target, which leaves the sweep
    // nothing, could not be reloaded.
    tied.rows.set('Organization', [{ Id: id('00D', 8) }]);

    await handler.handle(
      buildMsg('frozen:remove:sweep', {
        targetOrgId: TARGET_ORG,
        loadedAt: LAST_WRITE,
        reload: true,
      }),
    );

    expect(errors('frozen:remove:sweep:error')).toEqual([]);
    expect(
      posted<BaseMessage & { payload: { loads: FrozenReloadSweepListing[] } }>(
        'frozen:remove:sweep:response',
      )[0]?.payload.loads,
    ).toEqual([]);
  });

  it('refuses a list of a load another one replaced since it was shown', async () => {
    await handler.handle(
      buildMsg('frozen:remove:sweep', {
        targetOrgId: TARGET_ORG,
        loadedAt: '2026-09-01T00:00:00.000Z',
        reload: true,
      }),
    );

    expect(errors('frozen:remove:sweep:error').map((e) => e.payload.code)).toEqual([
      'LOAD_CHANGED',
    ]);
  });

  it('reads what fires on what the sweep takes with the purge’s deletes', async () => {
    await handler.handle(
      buildMsg('frozen:remove:automation', {
        targetOrgId: TARGET_ORG,
        loadedAt: LAST_WRITE,
        reload: true,
        sweptObjects: ['Task'],
      }),
    );

    const answer = posted<BaseMessage & { payload: { steps: { delete?: string[] } } }>(
      'frozen:remove:automation:response',
    )[0]?.payload;
    expect(answer?.steps.delete).toEqual(['Contact', 'Account', 'Task']);
    expect(read).toHaveBeenCalledWith(TARGET_ORG, ['Contact', 'Account', 'Task']);
  });

  describe('what its sweep leaves, kept the load’s for the next sweep', () => {
    /** The records the reload inserts, as the target dated them the next day. */
    const NEW_ACCOUNT = id('001', 2);
    const NEW_CONTACT = id('003', 2);
    const RELOAD_FIRST = '2026-10-02T09:00:00.000Z';
    const RELOAD_LAST = '2026-10-02T09:05:00.000Z';
    const RELOADED_AT = '2026-10-02T09:04:50.000+0000';

    /** The recorded loads, as the next reload reads them. */
    const recordedLoads = () =>
      new SasReferenceIdMappingStore(sasDir, {
        orgId: TARGET_ORG,
        organizationId: ORGANIZATION,
      }).recordedLoads();

    /** Production Guard refusing every delete of a task, the rest let through. */
    function refusingTasks(): void {
      const guard = new ProductionGuard();
      const check = guard.check.bind(guard);
      vi.spyOn(guard, 'check').mockImplementation((request) =>
        request.objectName === 'Task'
          ? { ...check(request), allowed: false, blockedReason: 'no deletes of tasks here' }
          : check(request),
      );
      deps.infraServices = { productionGuard: guard } as unknown as HandlerDeps['infraServices'];
      handler = new FrozenDatasetHandler(deps);
      handler.setTargetAutomation({ read });
    }

    /** Production Guard as it stands by default, letting deletes on a sandbox through. */
    function lettingThrough(): void {
      deps.infraServices = {
        productionGuard: new ProductionGuard(),
      } as unknown as HandlerDeps['infraServices'];
      handler = new FrozenDatasetHandler(deps);
      handler.setTargetAutomation({ read });
    }

    beforeEach(() => {
      // The purge as the loader runs it, then the mapping kept as the loader
      // keeps it: the records it inserted, and the loads before it without
      // what it purged — those whose sweep it is told still owe one kept.
      loaderLoad.mockImplementation(
        async (options: FrozenLoadOptions, loaderDeps: FrozenDatasetLoaderDeps) => {
          await options.purgeSweep?.first();
          const purged: string[] = [];
          for (const object of ['Contact', 'Account']) {
            const ids = tied.ids(object);
            purged.push(...ids);
            if (ids.length > 0) await tied.conn.sobject(object).destroy(ids);
          }
          if (!options.signal?.aborted) await options.purgeSweep?.afterPurge();
          const made = (recordId: string, name: string, more = {}) => ({
            Id: recordId,
            Name: name,
            CreatedById: USER,
            CreatedDate: RELOADED_AT,
            LastModifiedDate: RELOADED_AT,
            LastModifiedById: USER,
            SystemModstamp: RELOADED_AT,
            ...more,
          });
          tied.add('Account', made(NEW_ACCOUNT, 'Reloaded account'));
          tied.add('Contact', made(NEW_CONTACT, 'Reloaded contact', { AccountId: NEW_ACCOUNT }));
          const stillToSweep = options.purgeSweep?.stillToSweep?.() ?? [];
          await loaderDeps.mappingStore.persist(
            new Map([
              ['Account-000001', NEW_ACCOUNT],
              ['Contact-000001', NEW_CONTACT],
            ]),
            {
              created: [
                { objectApiName: 'Account', referenceIds: ['Account-000001'] },
                { objectApiName: 'Contact', referenceIds: ['Contact-000001'] },
              ],
              startedAt: new Date(RELOAD_FIRST),
              writtenBetween: { first: RELOAD_FIRST, last: RELOAD_LAST },
              earlier: {
                settled: purged,
                ...(stillToSweep.length > 0 ? { stillToSweep } : {}),
              },
              runUserId: USER,
            },
          );
          return reloadReport();
        },
      );
    });

    it('lets the load it replaced go once its sweep took all it found', async () => {
      await reload({ sweep: true });

      expect(tied.ids('Task')).toEqual([]);
      expect((await recordedLoads()).map((load) => load.endedAt)).not.toContain(LAST_WRITE);
    });

    it('keeps the load a refused sweep left its task of, and the next reload’s sweep takes it', async () => {
      refusingTasks();
      await reload({ sweep: true });

      expect(tied.ids('Task')).toEqual([TASK]);
      expect(tied.ids('Contact')).toEqual([NEW_CONTACT]);
      const replaced = (await recordedLoads()).find((load) => load.endedAt === LAST_WRITE);
      expect(replaced).toMatchObject({ created: [], madeEarlier: [TASK] });

      vi.mocked(deps.broker.postToWebview).mockClear();
      lettingThrough();
      await reload({ sweep: true });

      expect(errors()).toEqual([]);
      expect(tied.ids('Task')).toEqual([]);
      expect(report()?.sweeps).toEqual(
        expect.arrayContaining([
          {
            loadedAt: LAST_WRITE,
            result: expect.objectContaining({
              status: 'success',
              objects: [expect.objectContaining({ objectApiName: 'Task', deleted: 1 })],
            }),
          },
        ]),
      );
      expect((await recordedLoads()).map((load) => load.endedAt)).not.toContain(LAST_WRITE);
    });

    it('keeps the task the flow made late, which a reload asked to take what came late then takes', async () => {
      // Five minutes after the contact: what a scheduled path opens.
      const LATE = '2026-10-01T10:10:00.000+0000';
      Object.assign(tied.row('Task', TASK)!, {
        CreatedDate: LATE,
        LastModifiedDate: LATE,
        SystemModstamp: LATE,
      });

      await reload({ sweep: true });

      expect(tied.ids('Task')).toEqual([TASK]);
      expect(report()?.sweeps?.[0]?.result.left).toEqual([
        expect.objectContaining({ class: 'late', option: '--sweep-late' }),
      ]);
      const replaced = (await recordedLoads()).find((load) => load.endedAt === LAST_WRITE);
      expect(replaced).toMatchObject({ created: [], lateEarlier: [TASK] });

      vi.mocked(deps.broker.postToWebview).mockClear();
      await reload({ sweep: true });
      expect(tied.ids('Task')).toEqual([TASK]);

      vi.mocked(deps.broker.postToWebview).mockClear();
      await reload({ sweep: true, sweepLate: true });

      expect(errors()).toEqual([]);
      expect(tied.ids('Task')).toEqual([]);
      expect((await recordedLoads()).map((load) => load.endedAt)).not.toContain(LAST_WRITE);
    });
  });
});
