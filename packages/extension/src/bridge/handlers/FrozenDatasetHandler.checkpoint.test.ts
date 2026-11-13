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
  FrozenProjectConfig,
  RunCheckpointEstimate,
  RunCheckpointTaken,
} from '@sandforge/shared';
import {
  writePathOrderDefects,
  type BeforeRunAsk,
  type BeforeRunCheckpoints,
  type BeforeRunOwn,
  type BeforeRunTake,
  type BeforeRunTakeOptions,
  type WritePathStep,
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

/** The loader's `load` and `planLoad`, which each case scripts. */
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
 * A Frozen Dataset load asked to take a checkpoint of what it writes before
 * its first write (Checkpoint first), from the panel: its cost said by the
 * load's preview — Frozen asks no question of its own before it writes —
 * scoped from the objects of the dataset and what still runs as they go in,
 * taken before the mute's lease and the first write, kept once the load
 * wrote and deleted when it wrote nothing.
 */

const SET = '0PSxx0000000001AAA';

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

/** A report of a load that inserted `inserted` accounts. */
function report(inserted: number): Record<string, unknown> {
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
        inserted,
        reused: 2 - inserted,
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

describe('frozen:load, the checkpoint taken first', () => {
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
    const sasDir = tempDir('sandforge-frozen-checkpoint-');
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
      return report(2);
    });
  });

  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  function target(setup: Parameters<typeof memoryPermissionOrg>[0] = {}) {
    const org = memoryPermissionOrg({
      sets: [{ id: SET, name: 'Data_Load' }],
      beforeWrite: (write) => {
        calls.push(`assignment ${write.kind}`);
      },
      ...setup,
    });
    vi.mocked(getJsforceConnection).mockResolvedValue(org.connection as never);
    return org;
  }

  function checkpointsAnswering(
    over: {
      scoped?: RunCheckpointEstimate;
      took?: BeforeRunTake;
      whileTaking?: (own: BeforeRunOwn) => void;
    } = {},
  ) {
    const port = {
      scope: vi.fn(async (_ask: BeforeRunAsk, _own: BeforeRunOwn) => {
        calls.push('checkpointScope');
        return over.scoped ?? ESTIMATE;
      }),
      take: vi.fn(
        async (_ask: BeforeRunAsk, own: BeforeRunOwn, _options?: BeforeRunTakeOptions) => {
          calls.push('checkpointTake');
          over.whileTaking?.(own);
          return over.took ?? { taken: true as const, checkpoint: TAKEN };
        },
      ),
      settle: vi.fn(async (taken: RunCheckpointTaken, wrote: boolean) =>
        wrote ? taken : { state: 'deleted' as const, deleted: 'nothingWritten' as const },
      ),
    } satisfies BeforeRunCheckpoints;
    handler.setBeforeRunCheckpoints(port);
    return port;
  }

  function load(payload: Record<string, unknown>, id = 'wv-load-1'): Promise<boolean> {
    return handler.handle(
      inboundRequest({
        id,
        type: 'frozen:load',
        timestamp: Date.now(),
        // What runs as it writes accepted, as the panel's box sends it: what
        // these judge stands after that question.
        payload: { targetOrgId: 'org-2', acceptAutomation: true, ...payload },
      } as BaseMessage) as InboundRequest,
    );
  }

  function posted(type: string): Array<BaseMessage & { payload: Record<string, unknown> }> {
    return vi
      .mocked(deps.broker.postToWebview)
      .mock.calls.map(([m]) => m as BaseMessage & { payload: Record<string, unknown> })
      .filter((m) => m.type === type);
  }

  const loads = () =>
    new AuditTrailStore(store).list().entries.filter((e) => e.action === 'frozen_load');

  function stepsOf(said: readonly string[]): WritePathStep[] {
    const steps: Record<string, WritePathStep> = {
      checkpointTake: 'checkpointTake',
      'assignment insert': 'leaseAcquire',
      written: 'write',
      'assignment delete': 'leaseRelease',
    };
    return said.flatMap((call) => (steps[call] ? [steps[call]] : []));
  }

  it('takes it before the lease and the first write, and keeps it once the load wrote', async () => {
    const port = checkpointsAnswering();
    target();

    await load({ muteAutomation: true, checkpointFirst: { keepDays: 3 } });

    expect(calls).toEqual([
      'checkpointScope',
      'checkpointTake',
      'assignment insert',
      'written',
      'assignment delete',
    ]);
    expect(
      writePathOrderDefects(['reads', 'leasePlan', 'stillRunning', ...stepsOf(calls), 'result']),
    ).toEqual([]);
    const [ask, own] = port.take.mock.calls[0] ?? [];
    expect(ask).toMatchObject({
      module: 'frozen',
      orgId: 'org-2',
      operationId: 'wv-load-1',
      written: ['Account', 'Contact'],
      request: { keepDays: 3 },
    });
    expect(own).toEqual({ operationId: 'frozen:wv-load-1' });
    expect(port.take.mock.calls[0]?.[2]).toMatchObject({ planned: ESTIMATE });
    // The flow the mute keeps quiet creates nothing the checkpoint holds.
    expect(port.scope.mock.calls[0]?.[0].running.firing).toEqual([]);
    expect(port.settle).toHaveBeenCalledWith(TAKEN, true);
    expect(posted('frozen:load:response')[0]?.payload).toMatchObject({
      report: { checkpoint: TAKEN },
    });
    expect(loads()[0]).toMatchObject({ checkpointId: TAKEN.checkpointId });
  });

  it('counts the load as writing to its target but for the one mark the checkpoint names', async () => {
    const said: boolean[] = [];
    checkpointsAnswering({
      whileTaking: (own) => {
        said.push(handler.isWritingTo('org-2', own.operationId));
        said.push(handler.isWritingTo('org-2'));
        said.push(handler.isWritingTo('org-2', 'wv-load-1'));
        said.push(handler.isWritingTo('org-2', 'autopilot:wv-load-1'));
        said.push(handler.isWritingTo('org-3', own.operationId));
      },
    });
    target();

    await load({ checkpointFirst: {} });

    expect(said).toEqual([false, true, true, true, false]);
    // Its mark is gone once it ended.
    expect(handler.isWritingTo('org-2')).toBe(false);
  });

  it('holds the creations of a flow that still runs, the load not muted', async () => {
    const port = checkpointsAnswering();
    target();

    await load({ checkpointFirst: {} });

    const firing = port.scope.mock.calls[0]?.[0].running.firing ?? [];
    expect(firing.map((entry) => [entry.name, entry.flow?.creates])).toEqual([
      ['Contact welcome', ['Task']],
    ]);
  });

  it('refuses the load when the scope is refused: nothing taken, assigned or loaded', async () => {
    const port = checkpointsAnswering({
      scoped: {
        ...ESTIMATE,
        refusal: {
          code: 'RUN_WRITING',
          message:
            'A SandForge run is writing to DEV: start this run once it has ended. No record was read.',
        },
      },
    });
    const org = target();

    await load({ muteAutomation: true, checkpointFirst: {} });

    expect(port.take).not.toHaveBeenCalled();
    expect(loaderLoad).not.toHaveBeenCalled();
    expect(org.writes).toEqual([]);
    const [error] = posted('frozen:load:error');
    expect(error?.payload).toMatchObject({ code: 'CHECKPOINT_REFUSED' });
    expect(String(error?.payload.message)).toContain('The checkpoint before the run was refused');
    expect(loads()[0]).toMatchObject({
      outcome: 'stopped',
      details: expect.objectContaining({ code: 'CHECKPOINT_REFUSED' }),
    });
  });

  it('stops the load when its Cancel comes during the take, nothing assigned or loaded', async () => {
    checkpointsAnswering({ took: { taken: false, stopped: true } });
    const org = target();

    await load({ muteAutomation: true, checkpointFirst: {} });

    expect(loaderLoad).not.toHaveBeenCalled();
    expect(org.writes).toEqual([]);
    expect(posted('frozen:load:error')[0]?.payload).toMatchObject({ code: 'LOAD_CANCELLED' });
    expect(posted('operation:completed').map((m) => m.payload.result)).toEqual([{ aborted: true }]);
  });

  it('deletes the checkpoint of a load that wrote nothing', async () => {
    loaderLoad.mockImplementation(async () => {
      calls.push('written');
      return report(0);
    });
    const port = checkpointsAnswering();
    target();

    await load({ checkpointFirst: {} });

    expect(port.settle).toHaveBeenCalledWith(TAKEN, false);
    expect(posted('frozen:load:response')[0]?.payload).toMatchObject({
      report: { checkpoint: { state: 'deleted', deleted: 'nothingWritten' } },
    });
  });

  it('deletes the checkpoint again when the lease is refused after it: nothing loaded', async () => {
    const port = checkpointsAnswering();
    target({ refuseAssigning: { [SET]: 'INSUFFICIENT_ACCESS_OR_READONLY' } });

    await load({ muteAutomation: true, checkpointFirst: {} });

    expect(loaderLoad).not.toHaveBeenCalled();
    expect(port.settle).toHaveBeenCalledWith(TAKEN, false);
    expect(posted('frozen:load:error')[0]?.payload).toMatchObject({
      checkpoint: { state: 'deleted', deleted: 'nothingWritten' },
    });
  });

  it('keeps the checkpoint of a load that threw once the loader had it, saying nothing of what it wrote', async () => {
    loaderLoad.mockRejectedValue(new Error('socket hang up'));
    const port = checkpointsAnswering();
    target();

    await load({ checkpointFirst: {} });

    expect(port.settle).toHaveBeenCalledWith(TAKEN, true);
    expect(posted('frozen:load:error')[0]?.payload).toMatchObject({ checkpoint: TAKEN });
  });

  it("says in the load's preview what the checkpoint would hold and cost, and takes none", async () => {
    loaderPlan.mockResolvedValue({ orgId: 'org-2', perObject: [] });
    const port = checkpointsAnswering();
    const org = target();

    await handler.handle(
      inboundRequest({
        id: 'wv-preview-1',
        type: 'frozen:load:preview',
        timestamp: Date.now(),
        payload: { targetOrgId: 'org-2', muteAutomation: true, checkpointFirst: {} },
      } as BaseMessage) as InboundRequest,
    );

    expect(port.scope).toHaveBeenCalledTimes(1);
    expect(port.scope.mock.calls[0]?.[0]).toMatchObject({
      module: 'frozen',
      written: ['Account', 'Contact'],
    });
    // Planned with the mute, nothing assigned: the quiet flow adds nothing.
    expect(port.scope.mock.calls[0]?.[0].running.firing).toEqual([]);
    expect(org.writes).toEqual([]);
    expect(port.take).not.toHaveBeenCalled();
    // Its requests counted with the load's, as the load's gate counts them;
    // the target here does not say what it has left.
    expect(posted('frozen:load:preview:response')[0]?.payload).toEqual({
      plan: {
        orgId: 'org-2',
        perObject: [],
        checkpoint: ESTIMATE,
        apiRequests: expect.objectContaining({
          verdict: 'unread',
          parts: expect.objectContaining({ checkpoint: 8, mute: 7 }),
        }),
      },
    });
  });

  it('says nothing of a checkpoint in a preview that asks for none', async () => {
    loaderPlan.mockResolvedValue({ orgId: 'org-2', perObject: [] });
    const port = checkpointsAnswering();
    target();

    await handler.handle(
      inboundRequest({
        id: 'wv-preview-2',
        type: 'frozen:load:preview',
        timestamp: Date.now(),
        payload: { targetOrgId: 'org-2' },
      } as BaseMessage) as InboundRequest,
    );

    expect(port.scope).not.toHaveBeenCalled();
    // What runs as the load writes is said beside it; no checkpoint is.
    const plan = posted('frozen:load:preview:response')[0]?.payload.plan;
    expect(plan).toMatchObject({ orgId: 'org-2', perObject: [] });
    expect(plan).not.toHaveProperty('checkpoint');
  });
});
