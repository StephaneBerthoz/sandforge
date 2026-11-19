import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildFrozenManifest, LoadConfigError } from '../../modules/frozendataset/index.js';
import { ProductionGuard } from '../../core/precheck/ProductionGuard.js';
import { FrozenDatasetHandler } from './FrozenDatasetHandler.js';
import type { HandlerDeps, InboundRequest } from './HandlerTypes.js';
import type {
  BaseMessage,
  ForgeTargetAutomation,
  FrozenLoadApiRequests,
  FrozenProjectConfig,
  RunCheckpointEstimate,
  RunCheckpointTaken,
} from '@sandforge/shared';
import type {
  BeforeRunAsk,
  BeforeRunCheckpoints,
  BeforeRunOwn,
  BeforeRunTakeOptions,
} from '../../modules/checkpoint/beforeRunCheckpoint.js';
import { inboundRequest } from '../../test/mockFactories.js';
import { memoryPermissionOrg } from '../../test/memoryPermissionOrg.js';
import { ConfigStore } from '../../core/storage/ConfigStore.js';
import { InMemoryConfigStoreBackend } from '../../test/InMemoryConfigStoreBackend.js';
import { AuditTrailStore } from '../../modules/audit/auditTrail.js';
import { getJsforceConnection } from '../../core/connection/ConnectionHelper.js';

vi.mock('../../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../core/connection/ConnectionHelper.js', () => ({
  getJsforceConnection: vi.fn(),
}));

/** The loader's `load` and `planLoad`, which each case scripts; its entry guards are its own. */
const loaderLoad = vi.hoisted(() => vi.fn());
const loaderPlan = vi.hoisted(() => vi.fn());
vi.mock('../../modules/frozendataset/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../modules/frozendataset/index.js')>();
  return {
    ...actual,
    FrozenDatasetLoader: vi.fn().mockImplementation(function (
      loaderDeps: ConstructorParameters<typeof actual.FrozenDatasetLoader>[0],
    ) {
      const real = new actual.FrozenDatasetLoader(loaderDeps);
      return {
        gateLoad: (options: Parameters<typeof real.gateLoad>[0]) => real.gateLoad(options),
        load: loaderLoad,
        planLoad: loaderPlan,
      };
    }),
  };
});

/*
 * A Frozen Dataset load held to the daily API requests its target has left,
 * as a seed, a sync or a clone is, through the panel's handler: the target
 * answers `/limits` as an org does, and its permission sets as the mute's
 * lease reads and assigns them. A load read no limit of the requests, and
 * the lease of its mute was counted nowhere.
 */

const SET = '0PSxx0000000001AAA';
const MAX = 15_000;

/** What the target runs on the contacts: a flow that creates a task, its bypass held by `Data_Load`. */
const CONTACT_FLOW: ForgeTargetAutomation = {
  objectsRead: ['Account', 'Contact'],
  objects: [
    {
      objectApiName: 'Contact',
      flows: [
        {
          apiName: 'Contact_Welcome',
          label: 'Contact welcome',
          timing: 'afterSave',
          startsOn: 'create',
          condition: 'read',
          permissions: [{ name: 'Load_Data', bypass: true }],
          creates: ['Task'],
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
  conditionsNotRead: 0,
  conditionsBound: 25,
  requests: 4,
};

/**
 * The load's own requests, of two accounts and a contact: a REST call and a
 * describe for each object, a count of each for its verification, its
 * limits read three times and who it writes as twice, and the four the read
 * of the target's automation sent.
 */
const RUN = 2 + 2 + 2 + 5 + 4;
/** The lease of a mute that assigns one set: who, the three reads, the set assigned and taken back. */
const MUTE = 2 + 3 + 2;

const ESTIMATE: RunCheckpointEstimate = {
  state: 'planned',
  estimate: { records: 12, apiRequests: 8, apiRequestsLeft: 14_000, seconds: 4, bytes: 120_000 },
  objects: ['Account', 'Contact', 'Task'],
  added: [
    { objectApiName: 'Task', reason: "The target's flow 'Contact welcome' creates Task records." },
  ],
  notHeld: [],
  keepDays: 7,
};

const TAKEN: RunCheckpointTaken = {
  state: 'taken',
  checkpointId: 'ck-before-frozen-1',
  name: 'Before Frozen Dataset load 2026-11-01 10:00 UTC',
  takenAt: '2026-11-01T10:00:00.000Z',
  expiresAt: '2026-11-08T10:00:00.000Z',
  objects: ['Account', 'Contact', 'Task'],
  records: 12,
  bytes: 120_000,
  requests: 8,
  added: ESTIMATE.added,
  notHeld: [],
};

/** A report of a load that inserted its two accounts. */
function report(): Record<string, unknown> {
  return {
    status: 'completed',
    orgId: 'org-2',
    mode: { pilot: false, reload: false },
    startedAt: '2026-11-01T10:00:00.000Z',
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
    perObject: [
      {
        objectApiName: 'Account',
        fromFiles: 2,
        inserted: 2,
        reused: 0,
        skippedDuplicates: [],
        failed: [],
      },
    ],
    pass2: { resolved: 0, unresolved: [] },
    personContact: { restored: 0, sent: [], unresolved: [] },
    statuses: { restored: 0, refused: [] },
    purge: { deleted: {}, deactivated: {}, failures: [] },
    mappingPath: '',
    contractPath: path.join(os.tmpdir(), 'no-such-contract.json'),
  };
}

describe('frozen:load, the daily API requests its target has left', () => {
  let deps: HandlerDeps;
  let handler: FrozenDatasetHandler;
  let store: ConfigStore;
  let calls: string[];
  const dirs: string[] = [];

  function tempDir(prefix: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    dirs.push(dir);
    return dir;
  }

  /** A frozen dataset of two accounts and one contact, in a sas outside any repo. */
  function writeDataset(): FrozenProjectConfig {
    const sasDir = tempDir('sandforge-frozen-api-budget-');
    const datasetDir = path.join(sasDir, 'dataset');
    fs.mkdirSync(path.join(datasetDir, 'data'), { recursive: true });
    const manifest = buildFrozenManifest({
      version: '1.2.0',
      source: { orgId: '00D000000000002AAA', decisionDate: '2026-09-01' },
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
    fs.writeFileSync(path.join(datasetDir, 'data', 'Account.json'), data('Account', ['A1', 'A2']));
    fs.writeFileSync(path.join(datasetDir, 'data', 'Contact.json'), data('Contact', ['C1']));
    return {
      rootObject: 'Account',
      axes: [],
      edgeCases: [],
      budgetMaxRecords: 2500,
      sasDir,
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    loaderLoad.mockReset();
    loaderPlan.mockReset();
    calls = [];
    store = new ConfigStore(new InMemoryConfigStoreBackend());
    store.initialize();
    store.set('frozen:config', writeDataset(), 'frozen');
    let n = 0;
    deps = {
      log: vi.fn(),
      broker: { postToWebview: vi.fn() } as unknown as HandlerDeps['broker'],
      stateSync: {} as HandlerDeps['stateSync'],
      orgManager: {
        getOrg: vi.fn(() => ({ orgType: 'Sandbox', alias: 'DEV' })),
      } as unknown as HandlerDeps['orgManager'],
      orgRegistry: {} as HandlerDeps['orgRegistry'],
      configStore: store,
      secretVault: {} as HandlerDeps['secretVault'],
      authProvider: {} as HandlerDeps['authProvider'],
      sfdxBridge: {} as HandlerDeps['sfdxBridge'],
      infraServices: {
        productionGuard: new ProductionGuard(),
      } as unknown as NonNullable<HandlerDeps['infraServices']>,
      nextId: () => String(++n),
    };
    handler = new FrozenDatasetHandler(deps);
    handler.setTargetAutomation({ read: vi.fn(async () => CONTACT_FLOW) });
    handler.setMuteLeases({ dir: tempDir('frozen-leases-'), renewEveryMs: 0 });
    loaderLoad.mockImplementation(async () => {
      calls.push('written');
      return report();
    });
  });

  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  /**
   * The target, its `/limits` saying it has `remaining` of its daily
   * requests left; with none given, they list no daily requests, as an
   * org's do for a user it does not tell them.
   */
  function target(remaining?: number) {
    const org = memoryPermissionOrg({
      sets: [{ id: SET, name: 'Data_Load' }],
      beforeWrite: (write) => {
        calls.push(`assignment ${write.kind}`);
      },
    });
    const connection = {
      ...org.connection,
      request: async ({ url }: { url: string }) => {
        if (url !== '/limits') throw new Error(`not answered: ${url}`);
        return remaining === undefined
          ? { DataStorageMB: { Max: 5, Remaining: 5 } }
          : { DailyApiRequests: { Max: MAX, Remaining: remaining } };
      },
    };
    vi.mocked(getJsforceConnection).mockResolvedValue(connection as never);
    return org;
  }

  function checkpointsAnswering() {
    const port = {
      scope: vi.fn(async (_ask: BeforeRunAsk, _own: BeforeRunOwn) => {
        calls.push('checkpointScope');
        return ESTIMATE;
      }),
      take: vi.fn(
        async (_ask: BeforeRunAsk, _own: BeforeRunOwn, _options?: BeforeRunTakeOptions) => {
          calls.push('checkpointTake');
          return { taken: true as const, checkpoint: TAKEN };
        },
      ),
      settle: vi.fn(async (taken: RunCheckpointTaken, wrote: boolean) =>
        wrote ? taken : { state: 'deleted' as const, deleted: 'nothingWritten' as const },
      ),
    } satisfies BeforeRunCheckpoints;
    handler.setBeforeRunCheckpoints(port);
    return port;
  }

  function send(type: string, payload: Record<string, unknown>): Promise<boolean> {
    return handler.handle(
      inboundRequest({
        id: 'wv-load-1',
        type,
        timestamp: Date.now(),
        // What runs as it writes accepted, as the panel's box sends it: what
        // these judge stands after that question.
        payload: { targetOrgId: 'org-2', acceptAutomation: true, ...payload },
      } as BaseMessage) as InboundRequest,
    );
  }
  const load = (payload: Record<string, unknown> = {}) => send('frozen:load', payload);

  function posted(type: string): Array<BaseMessage & { payload: Record<string, unknown> }> {
    return vi
      .mocked(deps.broker.postToWebview)
      .mock.calls.map(([m]) => m as BaseMessage & { payload: Record<string, unknown> })
      .filter((m) => m.type === type);
  }

  const loads = () =>
    new AuditTrailStore(store).list().entries.filter((e) => e.action === 'frozen_load');

  it('refuses a load past what the target has left, before its checkpoint is taken, its lease and its first write', async () => {
    const port = checkpointsAnswering();
    const org = target(25);

    await load({ muteAutomation: true, checkpointFirst: {} });

    // Scoped, reading no record, for its requests to be counted; nothing taken.
    expect(calls).toEqual(['checkpointScope']);
    expect(port.take).not.toHaveBeenCalled();
    expect(org.writes).toEqual([]);
    expect(loaderLoad).not.toHaveBeenCalled();
    const [error] = posted('frozen:load:error');
    expect(error?.payload).toMatchObject({
      code: 'API_BUDGET_EXCEEDED',
      orgId: 'org-2',
      written: 0,
      apiRequests: {
        verdict: 'exceeds',
        estimate: RUN + 8 + MUTE,
        remaining: 25,
        max: MAX,
        parts: { run: RUN, checkpoint: 8, mute: MUTE },
        refused: { code: 'API_BUDGET_EXCEEDED' },
      },
    });
    expect(String(error?.payload.message)).toBe(
      `The run takes about ${RUN + 8 + MUTE} API requests (8 of them for the checkpoint taken ` +
        "first, 7 to assign and take back the permission sets that mute the target's " +
        'automation), and DEV has 25 of its 15000 daily requests left: it would stop part way ' +
        'through, its records refused with REQUEST_LIMIT_EXCEEDED. Run it once the org has ' +
        'requests to spare — the limit is counted over the last 24 hours — or write fewer ' +
        // The rows a lock refuses go again past what it counted, as a sync's refusal says.
        'records. Rows the target refuses for a record lock go again on their own, up to 3 ' +
        'times each: up to 3 more requests for every 200 of them, which no estimate made ' +
        'before the write can count. Nothing was written.',
    );
    expect(loads()).toEqual([
      expect.objectContaining({
        outcome: 'stopped',
        details: expect.objectContaining({ code: 'API_BUDGET_EXCEEDED' }),
      }),
    ]);
  });

  /** The target, its `/limits` saying it has `remainingMB` of its 5 MB of data storage left. */
  function targetWithStorage(remainingMB: number) {
    const org = memoryPermissionOrg({ sets: [{ id: SET, name: 'Data_Load' }] });
    vi.mocked(getJsforceConnection).mockResolvedValue({
      ...org.connection,
      request: async ({ url }: { url: string }) => {
        if (url !== '/limits') throw new Error(`not answered: ${url}`);
        return {
          DataStorageMB: { Max: 5, Remaining: remainingMB },
          DailyApiRequests: { Max: MAX, Remaining: MAX },
        };
      },
    } as never);
    return org;
  }

  it('refuses a load past the data storage the target has left before its first write, naming the pilot and a smaller dataset', async () => {
    // A load read no storage: into a Developer Edition, one ran until the
    // target answered STORAGE_LIMIT_EXCEEDED, its children refused under
    // parents that went in.
    const port = checkpointsAnswering();
    targetWithStorage(0);

    await load({ checkpointFirst: {} });

    expect(port.take).not.toHaveBeenCalled();
    expect(loaderLoad).not.toHaveBeenCalled();
    const [error] = posted('frozen:load:error');
    expect(error?.payload).toMatchObject({
      code: 'FROZEN_STORAGE_EXCEEDED',
      orgId: 'org-2',
      written: 0,
      // Its three records, and the task the contact flow opens under the contact.
      storage: {
        estimateMB: (4 * 2048) / (1024 * 1024),
        automationMB: 2048 / (1024 * 1024),
        remainingMB: 0,
        maxMB: 5,
      },
    });
    expect(String(error?.payload.message)).toBe(
      "The load was refused before it wrote anything: the dataset's records take about 0.01 MB " +
        "of data storage, about 0.01 MB of it for what the target's automation creates under " +
        'them, and DEV has 0 MB left of 5 MB. Load a pilot first, one root folder of it; or ' +
        'extract a smaller dataset, with a lower budget in the configuration, a new selection ' +
        'and a new extraction; or free data storage in DEV. Nothing was written.',
    );
    expect(loads()).toEqual([
      expect.objectContaining({
        outcome: 'stopped',
        details: expect.objectContaining({ code: 'FROZEN_STORAGE_EXCEEDED' }),
      }),
    ]);
  });

  it("counts with a load's records what the target's automation creates under them, its preview and its gate alike, as a clone and a seed count it", async () => {
    // Run for real, a load's dry run said "data storage: about 17.8 MB of the
    // 5 MB the target has left", its records alone, beside a flow that
    // creates a task under each contact it inserts.
    const datasetDir = path.join(
      String((store.get('frozen:config') as FrozenProjectConfig).sasDir),
      'dataset',
      'data',
    );
    const contacts = Array.from({ length: 300 }, (_, i) => `C${i + 1}`);
    fs.writeFileSync(
      path.join(datasetDir, 'Contact.json'),
      JSON.stringify({
        objectApiName: 'Contact',
        records: contacts.map((referenceId) => ({
          referenceId,
          fields: { LastName: referenceId },
        })),
      }),
    );
    loaderPlan.mockResolvedValue(PLAN);
    // 302 records take about 0.59 MB of the 1 MB left; the 300 tasks the flow
    // opens, 0.59 MB more.
    targetWithStorage(1);

    await send('frozen:load:preview', {});

    const plan = posted('frozen:load:preview:response')[0]?.payload.plan as
      { storage?: Record<string, unknown> } | undefined;
    const message =
      "The load was refused before it wrote anything: the dataset's records take about 1.18 MB " +
      "of data storage, about 0.59 MB of it for what the target's automation creates under " +
      'them, and DEV has 1 MB left of 5 MB. Load a pilot first, one root folder of it; or ' +
      'extract a smaller dataset, with a lower budget in the configuration, a new selection and ' +
      'a new extraction; or free data storage in DEV. Nothing was written.';
    expect(plan?.storage).toEqual({
      estimateMB: (602 * 2048) / (1024 * 1024),
      automationMB: (300 * 2048) / (1024 * 1024),
      remainingMB: 1,
      maxMB: 5,
      refusal: { code: 'FROZEN_STORAGE_EXCEEDED', message },
    });

    await load();

    expect(loaderLoad).not.toHaveBeenCalled();
    const [error] = posted('frozen:load:error');
    expect(error?.payload).toMatchObject({
      code: 'FROZEN_STORAGE_EXCEEDED',
      storage: { estimateMB: (602 * 2048) / (1024 * 1024), remainingMB: 1, maxMB: 5 },
    });
    expect(String(error?.payload.message)).toBe(message);

    // Muted, the flow creates nothing, and the records alone fit.
    vi.mocked(deps.broker.postToWebview).mockClear();
    await send('frozen:load:preview', { muteAutomation: true });

    const muted = posted('frozen:load:preview:response')[0]?.payload.plan as
      { storage?: Record<string, unknown> } | undefined;
    expect(muted?.storage).toEqual({
      estimateMB: (302 * 2048) / (1024 * 1024),
      remainingMB: 1,
      maxMB: 5,
    });
  });

  describe('counts only the records the load sends, its preview and its gate alike', () => {
    /**
     * The contact under its account, a relation of it to that account, which
     * the platform writes with the contact, and one to the other account.
     */
    function withRelations(): void {
      const datasetDir = path.join(
        String((store.get('frozen:config') as FrozenProjectConfig).sasDir),
        'dataset',
        'data',
      );
      fs.writeFileSync(
        path.join(datasetDir, 'Contact.json'),
        JSON.stringify({
          objectApiName: 'Contact',
          records: [{ referenceId: 'C1', fields: { LastName: 'C1', AccountId: 'A1' } }],
        }),
      );
      fs.writeFileSync(
        path.join(datasetDir, 'AccountContactRelation.json'),
        JSON.stringify({
          objectApiName: 'AccountContactRelation',
          records: [
            { referenceId: 'R1', fields: { AccountId: 'A1', ContactId: 'C1' } },
            { referenceId: 'R2', fields: { AccountId: 'A2', ContactId: 'C1' } },
          ],
        }),
      );
    }

    /** The target, no data storage left, and the objects its describe lists. */
    function targetListing(objects: string[]): void {
      const org = memoryPermissionOrg({ sets: [{ id: SET, name: 'Data_Load' }] });
      vi.mocked(getJsforceConnection).mockResolvedValue({
        ...org.connection,
        request: async ({ url }: { url: string }) => {
          if (url === '/sobjects') {
            return { sobjects: objects.map((name) => ({ name, createable: true })) };
          }
          if (url !== '/limits') throw new Error(`not answered: ${url}`);
          return {
            DataStorageMB: { Max: 5, Remaining: 0 },
            DailyApiRequests: { Max: MAX, Remaining: MAX },
          };
        },
      } as never);
    }

    /** What the preview and the load's gate each said of the storage. */
    async function storageSaid(): Promise<Array<Record<string, unknown> | undefined>> {
      loaderPlan.mockResolvedValue(PLAN);
      await send('frozen:load:preview', {});
      await load();
      expect(loaderLoad).not.toHaveBeenCalled();
      const preview = posted('frozen:load:preview:response')[0]?.payload.plan as
        { storage?: Record<string, unknown> } | undefined;
      const gate = posted('frozen:load:error')[0]?.payload['storage'] as
        Record<string, unknown> | undefined;
      return [preview?.storage, gate];
    }

    it('leaves out the relations of a target that has no AccountContactRelation, which none of them reaches', async () => {
      // Run for real, the estimate counted 3 450 relations the target did not
      // have: 17.8 MB for the 5 643 records a load would send.
      withRelations();
      targetListing(['Account', 'Contact']);

      const [preview, gate] = await storageSaid();

      // Two accounts, the contact, and the task the flow opens under it.
      for (const said of [preview, gate]) {
        expect(said).toMatchObject({ estimateMB: (4 * 2048) / (1024 * 1024) });
      }
    });

    it('leaves out the relation the platform writes with its contact, and counts the other', async () => {
      withRelations();
      targetListing(['Account', 'Contact', 'AccountContactRelation']);

      const [preview, gate] = await storageSaid();

      for (const said of [preview, gate]) {
        expect(said).toMatchObject({ estimateMB: (5 * 2048) / (1024 * 1024) });
      }
    });
  });

  it('holds a pilot to the data storage of its root folder, refused past it before its first write in a pilot’s words', async () => {
    // Let through whatever it took, a pilot whose root folder was larger than
    // what the target had left wrote until the target answered
    // STORAGE_LIMIT_EXCEEDED, its children refused under parents that went in.
    const port = checkpointsAnswering();
    targetWithStorage(0);

    await load({ pilot: true, checkpointFirst: {} });

    expect(port.take).not.toHaveBeenCalled();
    expect(loaderLoad).not.toHaveBeenCalled();
    const [error] = posted('frozen:load:error');
    expect(error?.payload).toMatchObject({
      code: 'FROZEN_STORAGE_EXCEEDED',
      orgId: 'org-2',
      written: 0,
      // Its root folder alone: the first account, no contact under it, so
      // no task the contact flow opens.
      storage: { estimateMB: 2048 / (1024 * 1024), remainingMB: 0, maxMB: 5, pilot: true },
    });
    expect(error?.payload.storage).not.toHaveProperty('automationMB');
    expect(String(error?.payload.message)).toBe(
      'The pilot was refused before it wrote anything: the records of its root folder take ' +
        'about 0.01 MB of data storage, and DEV has 0 MB left of 5 MB. Extract a smaller ' +
        'dataset, with a lower budget in the configuration, a new selection and a new ' +
        'extraction; or free data storage in DEV. Nothing was written.',
    );
  });

  it('lets through a pilot whose root folder fits what the target has left, though the whole dataset would not', async () => {
    // 600 contacts under the second account: the whole dataset and the tasks
    // the flow opens under them take about 2.35 MB of the 1 MB left; the
    // first account, the pilot's root folder, 0.01 MB.
    const datasetDir = path.join(
      String((store.get('frozen:config') as FrozenProjectConfig).sasDir),
      'dataset',
      'data',
    );
    fs.writeFileSync(
      path.join(datasetDir, 'Contact.json'),
      JSON.stringify({
        objectApiName: 'Contact',
        records: Array.from({ length: 600 }, (_, i) => ({
          referenceId: `C${i + 1}`,
          fields: { LastName: `C${i + 1}`, AccountId: 'A2' },
        })),
      }),
    );
    targetWithStorage(1);

    await load();

    expect(posted('frozen:load:error')[0]?.payload.code).toBe('FROZEN_STORAGE_EXCEEDED');
    expect(loaderLoad).not.toHaveBeenCalled();

    vi.mocked(deps.broker.postToWebview).mockClear();
    await load({ pilot: true });

    expect(posted('frozen:load:error')).toEqual([]);
    expect(loaderLoad).toHaveBeenCalledTimes(1);
  });

  it('loads a dataset that fits the storage the target has left', async () => {
    targetWithStorage(5);

    await load();

    expect(posted('frozen:load:error')).toEqual([]);
    expect(loaderLoad).toHaveBeenCalledTimes(1);
  });

  it('counts the lease of its mute: a load that fits without it is refused with it', async () => {
    target(RUN + 5);

    await load();

    expect(loaderLoad).toHaveBeenCalledTimes(1);
    expect(posted('frozen:load:error')).toEqual([]);
    const said = posted('frozen:load:response')[0]?.payload.report as
      { apiRequests?: FrozenLoadApiRequests } | undefined;
    expect(said?.apiRequests).toEqual({
      verdict: 'near',
      estimate: RUN,
      remaining: RUN + 5,
      max: MAX,
    });

    vi.mocked(deps.broker.postToWebview).mockClear();
    loaderLoad.mockClear();
    const org = target(RUN + 5);

    await load({ muteAutomation: true });

    expect(loaderLoad).not.toHaveBeenCalled();
    expect(org.writes).toEqual([]);
    expect(posted('frozen:load:error')[0]?.payload).toMatchObject({
      code: 'API_BUDGET_EXCEEDED',
      apiRequests: { estimate: RUN + MUTE, parts: { run: RUN, mute: MUTE } },
    });
  });

  it('goes on when the target would not say what it has left, and says so in the log', async () => {
    target();

    await load();

    expect(loaderLoad).toHaveBeenCalledTimes(1);
    const said = posted('frozen:load:response')[0]?.payload.report as
      { apiRequests?: FrozenLoadApiRequests } | undefined;
    expect(said?.apiRequests).toMatchObject({ verdict: 'unread', estimate: RUN });
    expect(vi.mocked(deps.log).mock.calls.map(([line]) => line)).toContainEqual(
      expect.stringContaining('the daily API requests the target has left could not be read'),
    );
  });

  it('says in its preview what a load would take and that it would be refused, nothing written', async () => {
    loaderPlan.mockResolvedValue({
      orgId: 'org-2',
      mode: { pilot: false, reload: false },
      plannedAt: '2026-11-01T10:00:00.000Z',
      perObject: [],
      excludedObjects: [],
      removals: [],
      placeholders: [],
      requiredDefaults: [],
      recordTypeIssues: 0,
      personContacts: 0,
      earlierLoads: 0,
    });
    const org = target(RUN - 1);

    await send('frozen:load:preview', {});

    const plan = posted('frozen:load:preview:response')[0]?.payload.plan as
      { apiRequests?: FrozenLoadApiRequests } | undefined;
    expect(plan?.apiRequests).toMatchObject({
      verdict: 'exceeds',
      estimate: RUN,
      remaining: RUN - 1,
      refused: { code: 'API_BUDGET_EXCEEDED' },
    });
    expect(loaderLoad).not.toHaveBeenCalled();
    expect(org.writes).toEqual([]);
  });

  /** A plan of the two accounts and the contact, as the loader reads it. */
  const PLAN = {
    orgId: 'org-2',
    mode: { pilot: false, reload: false },
    plannedAt: '2026-11-01T10:00:00.000Z',
    perObject: [],
    excludedObjects: [],
    removals: [],
    placeholders: [],
    requiredDefaults: [],
    recordTypeIssues: 0,
    personContacts: 0,
    earlierLoads: 0,
  };

  it('says in its preview the data storage a load would take and the refusal it would meet past it, in the load’s words', async () => {
    // Run on the trap org, a dry run of a dataset of 17.8 MB into the 5 MB a
    // Developer Edition has said nothing of the storage and ended 0; the load
    // itself was refused for it.
    loaderPlan.mockResolvedValue(PLAN);
    const org = targetWithStorage(0);

    await send('frozen:load:preview', {});

    const plan = posted('frozen:load:preview:response')[0]?.payload.plan as
      { storage?: Record<string, unknown> } | undefined;
    expect(plan?.storage).toEqual({
      estimateMB: (4 * 2048) / (1024 * 1024),
      automationMB: 2048 / (1024 * 1024),
      remainingMB: 0,
      maxMB: 5,
      refusal: {
        code: 'FROZEN_STORAGE_EXCEEDED',
        message:
          "The load was refused before it wrote anything: the dataset's records take about " +
          "0.01 MB of data storage, about 0.01 MB of it for what the target's automation " +
          'creates under them, and DEV has 0 MB left of 5 MB. Load a pilot first, one root ' +
          'folder of it; or extract a smaller dataset, with a lower budget in the configuration, ' +
          'a new selection and a new extraction; or free data storage in DEV. Nothing was ' +
          'written.',
      },
    });
    expect(loaderLoad).not.toHaveBeenCalled();
    expect(org.writes).toEqual([]);
  });

  it('says the storage of a load that fits, and of a pilot its root folder’s, as its gate measures it', async () => {
    loaderPlan.mockResolvedValue(PLAN);
    targetWithStorage(5);

    await send('frozen:load:preview', {});
    await send('frozen:load:preview', { pilot: true });

    const [whole, pilot] = posted('frozen:load:preview:response').map(
      (m) => (m.payload.plan as { storage?: Record<string, unknown> }).storage,
    );
    expect(whole).toEqual({
      estimateMB: (4 * 2048) / (1024 * 1024),
      automationMB: 2048 / (1024 * 1024),
      remainingMB: 5,
      maxMB: 5,
    });
    expect(pilot).toEqual({
      estimateMB: 2048 / (1024 * 1024),
      remainingMB: 5,
      maxMB: 5,
      pilot: true,
    });
  });

  it('says in the preview of a pilot the refusal its root folder would meet, as its run is refused', async () => {
    // Said of no pilot, a dry run ended 0 where the run was then refused.
    loaderPlan.mockResolvedValue({ ...PLAN, mode: { pilot: true, reload: false } });
    targetWithStorage(0);

    await send('frozen:load:preview', { pilot: true });
    await load({ pilot: true });

    const plan = posted('frozen:load:preview:response')[0]?.payload.plan as
      { storage?: Record<string, unknown> } | undefined;
    const [error] = posted('frozen:load:error');
    expect(plan?.storage).toEqual({
      estimateMB: 2048 / (1024 * 1024),
      remainingMB: 0,
      maxMB: 5,
      pilot: true,
      refusal: { code: 'FROZEN_STORAGE_EXCEEDED', message: String(error?.payload.message) },
    });
    expect(String(error?.payload.message)).toMatch(/^The pilot was refused before it wrote/);
    expect(loaderLoad).not.toHaveBeenCalled();
  });

  it('says the storage refusal beside the fields its configuration leaves empty, which leave no plan', async () => {
    loaderPlan.mockRejectedValue(
      new LoadConfigError('Declare them all', ['Account.Region__c: a value for required field']),
    );
    targetWithStorage(0);

    await send('frozen:load:preview', {});

    const [error] = posted('frozen:load:preview:error');
    expect(error?.payload).toMatchObject({ code: 'LOAD_CONFIG' });
    // With what its own refusal names beside its words, for the panel to say
    // it in its language: the org and the figures.
    expect(error?.payload.refusedBeside).toContainEqual({
      code: 'FROZEN_STORAGE_EXCEEDED',
      message: expect.stringMatching(/^The load was refused before it wrote anything/) as string,
      orgId: 'org-2',
      storage: {
        estimateMB: (4 * 2048) / (1024 * 1024),
        automationMB: 2048 / (1024 * 1024),
        remainingMB: 0,
        maxMB: 5,
      },
    });
  });

  it('names beside the fields the figures of each other refusal, as the refusal itself names them', async () => {
    loaderPlan.mockRejectedValue(
      new LoadConfigError('Declare them all', ['Account.Region__c: a value for required field']),
    );
    target(RUN - 1);

    await send('frozen:load:preview', {});

    const [error] = posted('frozen:load:preview:error');
    expect(error?.payload.refusedBeside).toContainEqual({
      code: 'API_BUDGET_EXCEEDED',
      message: expect.stringContaining('API requests') as string,
      orgId: 'org-2',
      apiRequests: expect.objectContaining({
        verdict: 'exceeds',
        estimate: RUN,
        remaining: RUN - 1,
        max: MAX,
      }) as unknown,
    });
  });

  it('reads the limits once for its storage and its API requests, as the load does', async () => {
    loaderPlan.mockResolvedValue(PLAN);
    let reads = 0;
    const org = memoryPermissionOrg({ sets: [{ id: SET, name: 'Data_Load' }] });
    vi.mocked(getJsforceConnection).mockResolvedValue({
      ...org.connection,
      request: async ({ url }: { url: string }) => {
        if (url !== '/limits') throw new Error(`not answered: ${url}`);
        reads++;
        return {
          DataStorageMB: { Max: 5, Remaining: 0 },
          DailyApiRequests: { Max: MAX, Remaining: MAX },
        };
      },
    } as never);

    await send('frozen:load:preview', {});

    const plan = posted('frozen:load:preview:response')[0]?.payload.plan as
      { storage?: { refusal?: unknown }; apiRequests?: { verdict: string } } | undefined;
    expect(plan?.storage?.refusal).toBeDefined();
    expect(plan?.apiRequests?.verdict).toBe('fits');
    expect(reads).toBe(1);
  });
});
