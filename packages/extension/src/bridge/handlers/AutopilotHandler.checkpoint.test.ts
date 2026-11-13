import path from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AutopilotHandler } from './AutopilotHandler.js';
import type { HandlerDeps } from './HandlerTypes.js';
import type {
  BaseMessage,
  ForgeTargetAutomation,
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
import { ProductionGuard } from '../../core/precheck/ProductionGuard.js';
import type { RunConfirmation } from '../../core/precheck/ProductionGuard.js';
import { ConfigStore } from '../../core/storage/ConfigStore.js';
import { InMemoryConfigStoreBackend } from '../../test/InMemoryConfigStoreBackend.js';
import { AuditTrailStore } from '../../modules/audit/auditTrail.js';
import { inboundRequest } from '../../test/mockFactories.js';
import { memoryPermissionOrg } from '../../test/memoryPermissionOrg.js';
import { AutopilotExecutor } from '../../modules/autopilot/AutopilotExecutor.js';
import {
  AutopilotOrchestrator,
  type AutopilotOrchestratorDeps,
} from '../../modules/autopilot/AutopilotOrchestrator.js';
import { RecordIdRemapper } from '../../modules/autopilot/RecordIdRemapper.js';
import type { SmartAnonymizer } from '../../modules/autopilot/SmartAnonymizer.js';

vi.mock('../../core/connection/ConnectionHelper.js', () => ({
  getJsforceConnection: vi.fn(),
}));

import { getJsforceConnection } from '../../core/connection/ConnectionHelper.js';

const mockGetConn = vi.mocked(getJsforceConnection);

/*
 * An Autopilot run asked to take a checkpoint of what it writes before its
 * first write (Checkpoint first), from the panel: scoped before its gate from
 * the objects of its plan and what still runs as it writes them, its cost in
 * the gate's question, taken once that is answered and before the mute's
 * lease, kept when the run wrote and deleted when it wrote nothing. An
 * Autopilot run has no removal: the checkpoint is the one way back.
 */

const SET = '0PSxx0000000001AAA';

const PLAN = {
  waves: [{ order: 0, objects: ['Lead'], dependsOn: [] }],
  totalRecords: 30,
  estimatedDurationSec: 1,
  estimatedApiCalls: 2,
  complianceFramework: 'none',
  anonymizationSummary: { totalRules: 0, rulesByType: {} },
  cycleResolutions: [],
};

/**
 * What the target runs on the leads: a flow that creates a task as a lead
 * goes in, its bypass held by `Data_Load`.
 */
const LEAD_FLOW: ForgeTargetAutomation = {
  objectsRead: ['Lead'],
  objects: [
    {
      objectApiName: 'Lead',
      flows: [
        {
          apiName: 'Lead_Welcome',
          label: 'Lead welcome',
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
  estimate: { records: 120, apiRequests: 9, apiRequestsLeft: 14_000, seconds: 6, bytes: 400_000 },
  objects: ['Lead', 'Task'],
  added: [
    { objectApiName: 'Task', reason: "The target's flow 'Lead welcome' creates Task records." },
  ],
  notHeld: [],
  keepDays: 7,
};

const TAKEN: RunCheckpointTaken = {
  state: 'taken',
  checkpointId: 'ck-before-autopilot-1',
  name: 'Before Autopilot run 2026-11-01 10:00 UTC',
  takenAt: '2026-11-01T10:00:00.000Z',
  expiresAt: '2026-11-08T10:00:00.000Z',
  objects: ['Lead', 'Task'],
  records: 120,
  bytes: 400_000,
  requests: 9,
  added: ESTIMATE.added,
  notHeld: [],
};

describe('autopilot:execute, the checkpoint taken first', () => {
  let handler: AutopilotHandler;
  let deps: HandlerDeps;
  let store: ConfigStore;
  let calls: string[];
  let questions: RunConfirmation[];
  let dir: string;

  beforeEach(() => {
    mockGetConn.mockReset();
    calls = [];
    questions = [];
    dir = mkdtempSync(path.join(tmpdir(), 'autopilot-checkpoint-'));
    store = new ConfigStore(new InMemoryConfigStoreBackend());
    store.initialize();
    let n = 0;
    deps = {
      log: vi.fn(),
      broker: { postToWebview: vi.fn() } as unknown as HandlerDeps['broker'],
      stateSync: {} as HandlerDeps['stateSync'],
      orgManager: {
        getOrg: vi.fn(() => ({ orgType: 'Sandbox', alias: 'TGT' })),
      } as unknown as HandlerDeps['orgManager'],
      orgRegistry: {} as HandlerDeps['orgRegistry'],
      configStore: store,
      secretVault: {} as HandlerDeps['secretVault'],
      authProvider: {} as HandlerDeps['authProvider'],
      sfdxBridge: {} as HandlerDeps['sfdxBridge'],
      infraServices: {
        productionGuard: new ProductionGuard({
          requestRunConfirmation: async (question) => {
            calls.push(`question ${question.stage}`);
            questions.push(question);
            return true;
          },
        }),
      } as unknown as HandlerDeps['infraServices'],
      nextId: () => String(++n),
    };
    handler = new AutopilotHandler(deps);
    handler.setMuteLeases({ dir, renewEveryMs: 0 });
    handler.setTargetAutomation({ read: vi.fn(async () => LEAD_FLOW) });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** The target: its limits, and its permission sets, each write of an assignment in `calls`. */
  function target(setup: Parameters<typeof memoryPermissionOrg>[0] = {}) {
    const org = memoryPermissionOrg({
      sets: [{ id: SET, name: 'Data_Load' }],
      beforeWrite: (write) => {
        calls.push(`assignment ${write.kind}`);
      },
      ...setup,
    });
    mockGetConn.mockResolvedValue({
      ...org.connection,
      request: vi.fn(async () => ({
        DataStorageMB: { Max: 200, Remaining: 150 },
        DailyApiRequests: { Max: 15_000, Remaining: 14_000 },
      })),
    } as never);
    return org;
  }

  function checkpointsAnswering(
    over: {
      scoped?: RunCheckpointEstimate | Error;
      took?: BeforeRunTake;
      whileTaking?: (own: BeforeRunOwn) => void;
    } = {},
  ) {
    const port = {
      scope: vi.fn(async (_ask: BeforeRunAsk, _own: BeforeRunOwn) => {
        calls.push('checkpointScope');
        if (over.scoped instanceof Error) throw over.scoped;
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

  /**
   * Scan, plan and execute the plan of leads, the run writing `written` of
   * them — or, given an orchestrator, the run its executor makes.
   */
  async function run(
    payload: Record<string, unknown>,
    written = 30,
    orchestrator?: AutopilotOrchestrator,
  ) {
    const executePlan = vi.fn(async (...args: Parameters<AutopilotOrchestrator['executePlan']>) => {
      calls.push('written');
      if (orchestrator) return orchestrator.executePlan(...args);
      return {
        totalSuccess: written,
        totalFailure: 0,
        totalSkipped: 0,
        elapsedMs: 10,
        completedObjects: written > 0 ? ['Lead'] : [],
        failedObjects: [],
        skippedObjects: [],
      };
    });
    handler.setOrchestrator({
      scanSchemas: vi.fn().mockResolvedValue({
        objectDescribes: new Map(),
        recordCounts: new Map([['Lead', 30]]),
        parentIds: new Map(),
        personAccounts: new Map(),
        totalObjectsScanned: 1,
      }),
      buildGraph: vi.fn().mockReturnValue({ nodes: [], edges: [] }),
      buildCompliance: vi.fn().mockReturnValue({ profile: {}, rules: [] }),
      generatePlan: vi.fn().mockReturnValue(PLAN),
      executePlan,
      pause: vi.fn(),
      resume: vi.fn(),
      skip: vi.fn(),
    } as unknown as Parameters<AutopilotHandler['setOrchestrator']>[0]);
    const send = (id: string, type: string, body: Record<string, unknown>) =>
      handler.handle(
        inboundRequest({ id, type, timestamp: Date.now(), payload: body } as BaseMessage),
      );
    await send('scan-1', 'autopilot:scan-schema', {
      sourceOrgId: 'src',
      targetOrgId: 'tgt',
      selectedObjects: [],
      includeStandardObjects: false,
    });
    await send('plan-1', 'autopilot:generate-plan', { complianceFramework: 'none' });
    await send('exec-1', 'autopilot:execute', { grappeThreshold: 0, ...payload });
    return { executePlan };
  }

  function posted(type: string): Array<BaseMessage & { payload: Record<string, unknown> }> {
    return vi
      .mocked(deps.broker.postToWebview)
      .mock.calls.map(([m]) => m as BaseMessage & { payload: Record<string, unknown> })
      .filter((m) => m.type === type);
  }

  const runs = () =>
    new AuditTrailStore(store).list().entries.filter((e) => e.action === 'autopilot_execute');

  function stepsOf(said: readonly string[]): WritePathStep[] {
    const steps: Record<string, WritePathStep> = {
      'question write': 'question',
      checkpointTake: 'checkpointTake',
      'assignment insert': 'leaseAcquire',
      written: 'write',
      'assignment delete': 'leaseRelease',
    };
    return said.flatMap((call) => (steps[call] ? [steps[call]] : []));
  }

  it('asks with its cost, takes it once answered, then takes the lease and writes the plan', async () => {
    const port = checkpointsAnswering();
    target();

    await run({ muteAutomation: true, checkpointFirst: { keepDays: 3 } });

    expect(calls).toEqual([
      'checkpointScope',
      'question write',
      'checkpointTake',
      'assignment insert',
      'written',
      'assignment delete',
    ]);
    expect(
      writePathOrderDefects(['reads', 'leasePlan', 'stillRunning', ...stepsOf(calls), 'result']),
    ).toEqual([]);
    expect(questions[0]).toMatchObject({
      stage: 'write',
      module: 'autopilot',
      checkpoint: ESTIMATE,
    });
    const [ask, own] = port.take.mock.calls[0] ?? [];
    expect(ask).toMatchObject({
      module: 'autopilot',
      orgId: 'tgt',
      operationId: 'exec-1',
      written: ['Lead'],
      request: { keepDays: 3 },
    });
    expect(own).toEqual({ operationId: 'autopilot:exec-1' });
    // The flow the mute keeps quiet creates nothing the checkpoint holds.
    expect(port.scope.mock.calls[0]?.[0].running.firing).toEqual([]);
    expect(port.settle).toHaveBeenCalledWith(TAKEN, true);
    expect(posted('autopilot:completed')[0]?.payload).toMatchObject({ checkpoint: TAKEN });
    expect(runs()[0]).toMatchObject({ outcome: 'success', checkpointId: TAKEN.checkpointId });
  });

  it('counts the lease of its mute among the requests its gate holds the run to, nothing assigned when they do not fit', async () => {
    // Six left: the plan's own fit, the lease's seven — who the run writes
    // as, three reads, the set assigned and taken back — do not.
    const org = target();
    mockGetConn.mockResolvedValue({
      ...org.connection,
      request: vi.fn(async () => ({
        DataStorageMB: { Max: 200, Remaining: 150 },
        DailyApiRequests: { Max: 15_000, Remaining: 6 },
      })),
    } as never);

    const { executePlan } = await run({ muteAutomation: true });

    expect(executePlan).not.toHaveBeenCalled();
    expect(calls).not.toContain('assignment insert');
    const refused = posted('autopilot:error')[0]?.payload;
    expect(refused).toMatchObject({ code: 'API_BUDGET_EXCEEDED' });
    expect(String(refused?.['message'] ?? refused?.['error'] ?? '')).toContain(
      "7 of them to assign and take back the permission sets that mute the target's automation",
    );
  });

  it('holds the creations of a flow that still runs, the run not muted', async () => {
    const port = checkpointsAnswering();
    target();

    await run({ checkpointFirst: {} });

    const firing = port.scope.mock.calls[0]?.[0].running.firing ?? [];
    expect(firing.map((entry) => [entry.name, entry.flow?.creates])).toEqual([
      ['Lead welcome', ['Task']],
    ]);
  });

  it('counts the run as writing to its target but for the one mark the checkpoint names', async () => {
    const said: boolean[] = [];
    checkpointsAnswering({
      whileTaking: (own) => {
        said.push(handler.isWritingTo('tgt', own.operationId));
        said.push(handler.isWritingTo('tgt'));
        said.push(handler.isWritingTo('tgt', 'exec-1'));
        said.push(handler.isWritingTo('tgt', 'frozen:exec-1'));
      },
    });
    target();

    await run({ checkpointFirst: {} });

    expect(said).toEqual([false, true, true, true]);
  });

  it('refuses the run before its question when the scope is refused: nothing taken, assigned or written', async () => {
    const port = checkpointsAnswering({
      scoped: {
        ...ESTIMATE,
        refusal: { code: 'NOTHING_HELD', message: 'Lead: not proven. No record was read.' },
      },
    });
    const org = target();

    const { executePlan } = await run({ muteAutomation: true, checkpointFirst: {} });

    expect(questions).toEqual([]);
    expect(port.take).not.toHaveBeenCalled();
    expect(executePlan).not.toHaveBeenCalled();
    expect(org.writes).toEqual([]);
    expect(posted('autopilot:error')[0]?.payload).toMatchObject({ code: 'CHECKPOINT_REFUSED' });
    expect(runs()[0]).toMatchObject({
      outcome: 'stopped',
      details: expect.objectContaining({ code: 'CHECKPOINT_REFUSED' }),
    });
  });

  it('refuses the run when the checkpoint cannot be scoped at all', async () => {
    checkpointsAnswering({ scoped: new Error('the store cannot be opened') });
    target();

    const { executePlan } = await run({ checkpointFirst: {} });

    expect(executePlan).not.toHaveBeenCalled();
    const [error] = posted('autopilot:error');
    expect(error?.payload).toMatchObject({ code: 'CHECKPOINT_REFUSED' });
    expect(String(error?.payload.message)).toContain(
      'The checkpoint before the run could not be taken: the store cannot be opened',
    );
  });

  it('stops the run when its Stop comes during the take, under the code of a cancel', async () => {
    checkpointsAnswering({ took: { taken: false, stopped: true } });
    const org = target();

    const { executePlan } = await run({ muteAutomation: true, checkpointFirst: {} });

    expect(executePlan).not.toHaveBeenCalled();
    expect(org.writes).toEqual([]);
    expect(posted('autopilot:error')[0]?.payload).toMatchObject({ code: 'RUN_CANCELLED' });
  });

  it('deletes the checkpoint of a run that wrote nothing', async () => {
    const port = checkpointsAnswering();
    target();

    await run({ checkpointFirst: {} }, 0);

    expect(port.settle).toHaveBeenCalledWith(TAKEN, false);
    expect(posted('autopilot:completed')[0]?.payload).toMatchObject({
      checkpoint: { state: 'deleted', deleted: 'nothingWritten' },
    });
    expect(runs()[0]).not.toHaveProperty('checkpointId');
  });

  it('keeps the checkpoint of a run whose read threw after its first call went in, and says it partial', async () => {
    // Ten leads a call: the first ten went in, and the read of the next page
    // timed out. Counted nowhere, the run said it wrote no record and the
    // checkpoint, the one way back for the ten in the target, was deleted.
    const port = checkpointsAnswering();
    target();
    const leads = Array.from({ length: 30 }, (_, n) => ({ Id: `led${n}`, LastName: `L${n}` }));
    const inTarget: string[] = [];
    const orchestrator = new AutopilotOrchestrator({
      createExecutor: () =>
        new AutopilotExecutor({
          query: async (_objectApiName, afterId, limit) => {
            if (afterId !== undefined) {
              throw new Error('QUERY_TIMEOUT: Your query request was running for too long.');
            }
            return leads.slice(0, limit).map((row) => ({ ...row }));
          },
          insert: async (_objectApiName, records) =>
            records.map((record) => {
              inTarget.push(String(record['LastName']));
              return { id: `00QT${inTarget.length}`, success: true, errors: [] };
            }),
          anonymizer: {
            anonymize: (records: Record<string, unknown>[]) => records,
          } as unknown as SmartAnonymizer,
          remapper: new RecordIdRemapper(),
          batchSize: 10,
        }),
    } as unknown as AutopilotOrchestratorDeps);

    await run({ checkpointFirst: {} }, 0, orchestrator);

    expect(inTarget).toHaveLength(10);
    expect(port.settle).toHaveBeenCalledWith(TAKEN, true);
    expect(posted('autopilot:completed')[0]?.payload).toMatchObject({
      status: 'partial',
      totalSuccessCount: 10,
      checkpoint: TAKEN,
    });
    expect(runs()[0]).toMatchObject({
      outcome: 'partial',
      checkpointId: TAKEN.checkpointId,
      objects: [expect.objectContaining({ objectApiName: 'Lead', created: 10, failed: 0 })],
    });
  });

  it('deletes the checkpoint again when the lease is refused after it: nothing written', async () => {
    const port = checkpointsAnswering();
    target({ refuseAssigning: { [SET]: 'INSUFFICIENT_ACCESS_OR_READONLY' } });

    const { executePlan } = await run({ muteAutomation: true, checkpointFirst: {} });

    expect(executePlan).not.toHaveBeenCalled();
    expect(port.settle).toHaveBeenCalledWith(TAKEN, false);
    expect(posted('autopilot:error')[0]?.payload).toMatchObject({
      code: 'MUTE_FAILED',
      checkpoint: { state: 'deleted', deleted: 'nothingWritten' },
    });
  });

  it('takes none, and asks nothing of it, when the run asks for none', async () => {
    const port = checkpointsAnswering();
    target();

    await run({});

    expect(port.scope).not.toHaveBeenCalled();
    expect(port.take).not.toHaveBeenCalled();
    expect(posted('autopilot:completed')[0]?.payload).not.toHaveProperty('checkpoint');
  });
});
