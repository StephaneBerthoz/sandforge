import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildFrozenManifest } from '../../modules/frozendataset/index.js';
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
        'records. Nothing was written.',
    );
    expect(loads()).toEqual([
      expect.objectContaining({
        outcome: 'stopped',
        details: expect.objectContaining({ code: 'API_BUDGET_EXCEEDED' }),
      }),
    ]);
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
});
