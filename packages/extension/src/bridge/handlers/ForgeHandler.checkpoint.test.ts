import path from 'node:path';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ForgeHandler } from './ForgeHandler.js';
import type { HandlerDeps } from './HandlerTypes.js';
import type {
  BaseMessage,
  ForgeConfig,
  ForgeExecutionResult,
  ForgeGraph,
  ForgeGraphNode,
  ForgeTargetAutomation,
  RunCheckpointEstimate,
  RunCheckpointTaken,
} from '@sandforge/shared';
import type { ForgeOrchestrator } from '../../modules/forge/ForgeOrchestrator.js';
import type {
  ExecuteOptions,
  ForgeWriteBoundary,
  ForgeWriteGateAnswer,
} from '../../modules/forge/ForgeExecutor.js';
import type { TargetAutomationReader } from '../../modules/forge/TargetAutomationReader.js';
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
import { muteOrgOf } from '../../modules/forge/AutomationMuteLease.js';
import { nodeRunJournal } from '../../modules/forge/ForgeRunJournal.js';

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

/*
 * A Forge run asked to take a checkpoint of what it writes before its first
 * write (Checkpoint first), from the panel: scoped at its write gate from the
 * rows it is about to write and what still runs as it writes them, its cost
 * put in the gate's question, taken once that is answered and before the
 * mute's lease, kept when the run wrote and deleted when it wrote nothing. A
 * retry or a resume is the same run, and takes none of its own.
 */

const ACCOUNT_ID = '001000000000123';
const SET = '0PSxx0000000001AAA';

function node(objectApiName: string, level: number): ForgeGraphNode {
  return {
    objectApiName,
    recordCount: 10,
    fieldCount: 5,
    status: 'idle',
    progress: 0,
    included: true,
    piiFields: [],
    anonymizeFields: [],
    errors: [],
    level,
    successCount: 0,
    failureCount: 0,
    createableFieldCount: 0,
    estimatedSizeMB: 0,
    estimatedApiCalls: 0,
    batchStrategy: 'auto',
  };
}

const GRAPH: ForgeGraph = {
  nodes: [node('Account', 0), node('Contact', 1)],
  edges: [
    {
      sourceObject: 'Account',
      targetObject: 'Contact',
      relationshipName: 'Contacts',
      type: 'lookup',
    },
  ],
  totalRecords: 20,
  estimatedSizeMB: 0.02,
  estimatedDurationSeconds: 0.1,
};

const CONFIG: ForgeConfig = {
  inputMode: 'record',
  recordId: ACCOUNT_ID,
  depth: 'direct',
  sourceOrgId: 'src-org',
  targetOrgId: 'tgt-org',
  anonymizePII: false,
  skipEmpty: false,
  batchSize: 'auto',
};

const RESULT: ForgeExecutionResult = {
  forgeId: 'forge-1',
  status: 'success',
  graph: GRAPH,
  duration: 10,
  timestamp: '2026-10-06T00:00:00.000Z',
  idRemapCount: 2,
  createdCount: 2,
};

/**
 * What the target runs on the contacts: a flow that creates a task as a
 * contact goes in, its bypass held by `Data_Load`, and a trigger, which no
 * bypass keeps quiet.
 */
const FIRES: ForgeTargetAutomation = {
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
      triggers: [{ name: 'ContactTrigger', events: ['beforeInsert'] }],
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
  requests: 3,
};

/** What the checkpoint of the account and its contact would hold and cost. */
const ESTIMATE: RunCheckpointEstimate = {
  state: 'planned',
  estimate: {
    records: 38,
    apiRequests: 68,
    apiRequestsLeft: 14_000,
    seconds: 44,
    bytes: 2_300_000,
  },
  objects: ['Account', 'Contact', 'Task'],
  added: [
    { objectApiName: 'Task', reason: "The target's flow 'Contact welcome' creates Task records." },
  ],
  notHeld: [],
  keepDays: 7,
};

/** The checkpoint taken before the run. */
const TAKEN: RunCheckpointTaken = {
  state: 'taken',
  checkpointId: 'ck-before-forge-1',
  name: 'Before Forge run 2026-11-01 10:00 UTC',
  takenAt: '2026-11-01T10:00:00.000Z',
  expiresAt: '2026-11-08T10:00:00.000Z',
  objects: ['Account', 'Contact', 'Task'],
  records: 38,
  bytes: 2_300_000,
  requests: 68,
  added: ESTIMATE.added,
  notHeld: [],
};

/** What a run is about to write: the account and one of its contacts. */
const BOUNDARY: ForgeWriteBoundary = {
  objects: [
    { objectApiName: 'Account', rows: [{ Id: ACCOUNT_ID, Name: 'Acme' }] },
    { objectApiName: 'Contact', rows: [{ Id: '003000000000001', LastName: 'One' }] },
  ],
  dryRun: false,
};

describe('forge:execute, the checkpoint taken first', () => {
  let handler: ForgeHandler;
  let deps: HandlerDeps;
  let store: ConfigStore;
  let questions: RunConfirmation[];
  let answers: boolean[];
  /** What happened, in order: questions, takes, assignments, writes and their end. */
  let calls: string[];
  /** What the target's `/limits` answer. */
  let limits: unknown;
  let dir: string;
  /** What the run's gate answered the executor, once it let the rows through. */
  let gateAnswer: ForgeWriteGateAnswer | void;

  beforeEach(() => {
    mockGetConn.mockReset();
    questions = [];
    answers = [];
    calls = [];
    gateAnswer = undefined;
    limits = {
      DataStorageMB: { Max: 200, Remaining: 150 },
      DailyApiRequests: { Max: 15_000, Remaining: 14_000 },
    };
    dir = mkdtempSync(path.join(tmpdir(), 'forge-checkpoint-'));
    store = new ConfigStore(new InMemoryConfigStoreBackend());
    store.initialize();
    let n = 0;
    deps = {
      log: vi.fn(),
      broker: { postToWebview: vi.fn() } as unknown as HandlerDeps['broker'],
      stateSync: {} as HandlerDeps['stateSync'],
      orgManager: {
        getOrg: vi.fn((id: string) => ({
          orgType: 'Sandbox',
          alias: id === 'tgt-org' ? 'DEV' : 'UAT',
        })),
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
            return answers.shift() ?? true;
          },
        }),
      } as unknown as HandlerDeps['infraServices'],
      nextId: () => String(++n),
    };
    mockGetConn.mockImplementation(async () => {
      return {
        query: vi.fn().mockResolvedValue({ records: [], done: true, totalSize: 0 }),
        queryMore: vi.fn(),
        request: vi.fn(async ({ url }: { url: string }) => {
          if (url !== '/limits') throw new Error(`unexpected ${url}`);
          return limits;
        }),
      } as never;
    });
    handler = new ForgeHandler(deps);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /**
   * The checkpoints a run takes its checkpoint through: the scope answers
   * `scoped`, the take `took`, and the settle keeps one the run wrote after.
   */
  function checkpointsAnswering(
    over: {
      scoped?: RunCheckpointEstimate | Error;
      took?: BeforeRunTake;
      /** What the handler says of the org while the take reads it. */
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
   * An orchestrator whose run hands `boundary` to the gate, "writes", and
   * gives the lease the gate took back once its last write is through, as the
   * executor does, before it ends.
   */
  function orchestratorHanding(
    boundary: ForgeWriteBoundary = BOUNDARY,
    result: ForgeExecutionResult = RESULT,
  ) {
    const execute = vi.fn(
      async (
        _graph: ForgeGraph,
        _config: ForgeConfig,
        options?: Pick<ExecuteOptions, 'beforeWrite' | 'stream'>,
      ) => {
        gateAnswer = await options?.beforeWrite?.(boundary);
        if (!boundary.dryRun) calls.push('written');
        if (gateAnswer?.lease) {
          await gateAnswer.lease.giveBack();
          calls.push('lease given back');
        }
        return result;
      },
    );
    return {
      execute,
      on: vi.fn().mockReturnValue(vi.fn()),
      abort: vi.fn(),
      pause: vi.fn(),
      resume: vi.fn(),
      clearDiscoveryCache: vi.fn(),
    } as unknown as ForgeOrchestrator & { execute: typeof execute };
  }

  /** A target whose `Data_Load` set the run may assign, each write of it in `calls`. */
  function mutableTarget(setup: Parameters<typeof memoryPermissionOrg>[0] = {}) {
    return memoryPermissionOrg({
      sets: [{ id: SET, name: 'Data_Load' }],
      beforeWrite: (write) => {
        calls.push(`assignment ${write.kind}`);
      },
      ...setup,
    });
  }

  function setUp(
    orchestrator = orchestratorHanding(),
    org: ReturnType<typeof memoryPermissionOrg> = mutableTarget(),
  ) {
    handler.setForgeOrchestrator(orchestrator, {
      targetAutomation: {
        readForGraph: vi.fn(async () => FIRES),
      } as unknown as TargetAutomationReader,
      muteOrg: async () => muteOrgOf(org.connection),
      muteLeases: { dir, renewEveryMs: 0 },
    });
    return { orchestrator, org };
  }

  function execute(
    payload: Record<string, unknown> = {},
    config: ForgeConfig = CONFIG,
  ): Promise<boolean> {
    return handler.handle(
      inboundRequest({
        id: 'wv-execute',
        type: 'forge:execute',
        timestamp: Date.now(),
        payload: { graph: GRAPH, config, ...payload },
      } as BaseMessage),
    );
  }

  function posted(type: string): Array<BaseMessage & { payload: Record<string, unknown> }> {
    return vi
      .mocked(deps.broker.postToWebview)
      .mock.calls.map(([m]) => m as BaseMessage & { payload: Record<string, unknown> })
      .filter((m) => m.type === type);
  }

  const runs = () =>
    new AuditTrailStore(store).list().entries.filter((e) => e.action === 'forge_execute');

  /** The steps of the write path `calls` went through, as the order test of every module counts them. */
  function stepsOf(said: readonly string[]): WritePathStep[] {
    const steps: Record<string, WritePathStep> = {
      'question automation': 'question',
      'question write': 'question',
      checkpointTake: 'checkpointTake',
      'assignment insert': 'leaseAcquire',
      written: 'write',
      'assignment delete': 'leaseRelease',
    };
    return said.flatMap((call) => (steps[call] ? [steps[call]] : []));
  }

  it('asks with its cost at the write gate, takes it once answered, then takes the lease and writes', async () => {
    const port = checkpointsAnswering();
    setUp();

    await execute({ muteAutomation: true, checkpointFirst: { keepDays: 3 } });

    expect(calls).toEqual([
      'question automation',
      'checkpointScope',
      'question write',
      'checkpointTake',
      'assignment insert',
      'written',
      'assignment delete',
      'lease given back',
    ]);
    expect(
      writePathOrderDefects(['reads', 'leasePlan', 'stillRunning', ...stepsOf(calls), 'result']),
    ).toEqual([]);
    // The question says the checkpoint's cost and what it adds.
    expect(questions[1]).toMatchObject({ stage: 'write', checkpoint: ESTIMATE });
    const [ask, own] = port.take.mock.calls[0] ?? [];
    expect(ask).toMatchObject({
      module: 'forge',
      orgId: 'tgt-org',
      written: ['Account', 'Contact'],
      request: { keepDays: 3 },
    });
    expect(own).toEqual({ operationId: ask?.operationId });
    expect(port.take.mock.calls[0]?.[2]).toMatchObject({ planned: ESTIMATE });
    // Kept: the run wrote, and its result, its history and its audit entry name it.
    expect(port.settle).toHaveBeenCalledWith(TAKEN, true);
    expect(posted('forge:execute:response')[0]?.payload.result).toMatchObject({
      checkpoint: TAKEN,
    });
    expect(store.get<ForgeExecutionResult[]>('forge:history')?.[0]).toMatchObject({
      checkpoint: TAKEN,
    });
    expect(runs()[0]).toMatchObject({ outcome: 'success', checkpointId: TAKEN.checkpointId });
  });

  it('names what it took beside the run’s journal, which a window closed under the run reads back', async () => {
    checkpointsAnswering();
    const journal = nodeRunJournal(dir);
    let named: unknown;
    const orchestrator = orchestratorHanding();
    const handing = orchestrator.execute.getMockImplementation();
    orchestrator.execute.mockImplementation(async (graph, config, options) => {
      const result = await handing?.(graph, config, options);
      const [file] = readdirSync(path.join(dir, 'forge-runs')).filter((name) =>
        name.endsWith('.ndjson'),
      );
      const journalId = (file ?? '').replace(/\.ndjson$/, '');
      await vi.waitFor(async () => {
        named = (await journal.read(journalId))?.checkpoint;
        expect(named).toBeDefined();
      });
      return result as ForgeExecutionResult;
    });
    handler.setForgeOrchestrator(orchestrator, {
      targetAutomation: {
        readForGraph: vi.fn(async () => FIRES),
      } as unknown as TargetAutomationReader,
      muteOrg: async () => muteOrgOf(mutableTarget().connection),
      muteLeases: { dir, renewEveryMs: 0 },
      runJournal: journal,
    });

    await execute({ checkpointFirst: {} });

    expect(named).toEqual(TAKEN);
  });

  it('scopes it from what still runs: the creations of a flow the mute keeps quiet are not held', async () => {
    const port = checkpointsAnswering();
    setUp();

    await execute({ muteAutomation: true, checkpointFirst: {} });
    const muted = port.scope.mock.calls[0]?.[0].running.firing ?? [];
    expect(muted.map((entry) => entry.name)).toEqual(['ContactTrigger']);

    // A handler of its own: the same clone again within the minute is refused as sent twice.
    calls = [];
    port.scope.mockClear();
    handler = new ForgeHandler(deps);
    handler.setBeforeRunCheckpoints(port);
    setUp();
    await execute({ checkpointFirst: {} });
    const unmuted = port.scope.mock.calls[0]?.[0].running.firing ?? [];
    expect(unmuted.map((entry) => entry.name)).toEqual(['ContactTrigger', 'Contact welcome']);
    expect(unmuted.find((entry) => entry.kind === 'flow')?.flow?.creates).toEqual(['Task']);
  });

  it('counts the run as writing to its target but for the one mark the checkpoint names', async () => {
    const said: boolean[] = [];
    checkpointsAnswering({
      whileTaking: (own) => {
        said.push(handler.isWritingTo('tgt-org', own.operationId));
        said.push(handler.isWritingTo('tgt-org'));
        said.push(handler.isWritingTo('tgt-org', 'forge-execute-another'));
        said.push(handler.isWritingTo('src-org', own.operationId));
      },
    });
    setUp();

    await execute({ checkpointFirst: {} });

    expect(said).toEqual([false, true, true, false]);
  });

  it('refuses the run before its write question when the scope is refused: nothing taken, assigned or written', async () => {
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
    const { org } = setUp();

    await execute({ muteAutomation: true, checkpointFirst: {} });

    expect(questions.map((q) => q.stage)).toEqual(['automation']);
    expect(port.take).not.toHaveBeenCalled();
    expect(org.writes).toEqual([]);
    expect(calls).not.toContain('written');
    const [error] = posted('forge:execute:error');
    expect(error?.payload).toMatchObject({
      code: 'CHECKPOINT_REFUSED',
      gate: { code: 'CHECKPOINT_REFUSED', reason: 'RUN_WRITING' },
    });
    expect(String(error?.payload.message)).toContain(
      'The checkpoint before the run was refused: A SandForge run is writing to DEV',
    );
    expect(runs()[0]).toMatchObject({
      outcome: 'stopped',
      details: expect.objectContaining({ code: 'CHECKPOINT_REFUSED' }),
    });
  });

  it('refuses the run once answered when the take is refused: nothing assigned or written', async () => {
    checkpointsAnswering({
      took: {
        taken: false,
        refusal: { code: 'DISK', message: 'The disk has 1.0 MB free. No record was read.' },
      },
    });
    const { org } = setUp();

    await execute({ muteAutomation: true, checkpointFirst: {} });

    expect(questions.map((q) => q.stage)).toEqual(['automation', 'write']);
    expect(org.writes).toEqual([]);
    expect(calls).not.toContain('written');
    expect(posted('forge:execute:error')[0]?.payload).toMatchObject({
      code: 'CHECKPOINT_REFUSED',
      gate: { code: 'CHECKPOINT_REFUSED', reason: 'DISK' },
    });
  });

  it('stops the run when its Stop comes during the take: nothing assigned or written', async () => {
    checkpointsAnswering({ took: { taken: false, stopped: true } });
    const { org } = setUp();

    await execute({ muteAutomation: true, checkpointFirst: {} });

    expect(org.writes).toEqual([]);
    expect(calls).not.toContain('written');
    expect(posted('forge:execute:error')[0]?.payload).toMatchObject({ code: 'RUN_CANCELLED' });
  });

  it('takes no checkpoint for a run declined at its write question', async () => {
    const port = checkpointsAnswering();
    setUp();
    answers = [true, false];

    await execute({ muteAutomation: true, checkpointFirst: {} });

    expect(port.take).not.toHaveBeenCalled();
    expect(posted('forge:execute:error')[0]?.payload).toMatchObject({ code: 'WRITE_DECLINED' });
  });

  it('deletes the checkpoint again when the lease is refused after it: the run wrote nothing', async () => {
    const port = checkpointsAnswering();
    setUp(
      orchestratorHanding(),
      mutableTarget({ refuseAssigning: { [SET]: 'INSUFFICIENT_ACCESS_OR_READONLY' } }),
    );

    await execute({ muteAutomation: true, checkpointFirst: {} });

    expect(calls).not.toContain('written');
    expect(port.settle).toHaveBeenCalledWith(TAKEN, false);
    expect(posted('forge:execute:error')[0]?.payload).toMatchObject({
      code: 'MUTE_FAILED',
      checkpoint: { state: 'deleted', deleted: 'nothingWritten' },
    });
  });

  it('deletes the checkpoint of a run that created nothing, and keeps one whose upsert wrote over records', async () => {
    const port = checkpointsAnswering();
    setUp(orchestratorHanding(BOUNDARY, { ...RESULT, createdCount: 0, idRemapCount: 0 }));

    await execute({ checkpointFirst: {} });

    expect(port.settle).toHaveBeenLastCalledWith(TAKEN, false);
    expect(posted('forge:execute:response')[0]?.payload.result).toMatchObject({
      checkpoint: { state: 'deleted', deleted: 'nothingWritten' },
    });

    handler = new ForgeHandler(deps);
    handler.setBeforeRunCheckpoints(port);
    setUp(
      orchestratorHanding(BOUNDARY, {
        ...RESULT,
        forgeId: 'forge-2',
        createdCount: 0,
        idRemapCount: 2,
        linkedExistingCount: 2,
        updatedCount: 2,
      }),
    );
    await execute({ checkpointFirst: {} });
    expect(port.settle).toHaveBeenLastCalledWith(TAKEN, true);
  });

  describe("the target's daily API requests", () => {
    it('refuses rows whose requests, the checkpoint among them, pass what the target has left, naming its part', async () => {
      // The rows take 2 requests, the checkpoint 68: 70 against 50 left.
      limits = {
        DataStorageMB: { Max: 200, Remaining: 150 },
        DailyApiRequests: { Max: 15_000, Remaining: 50 },
      };
      const port = checkpointsAnswering();
      setUp();

      await execute({ checkpointFirst: {} });

      expect(port.take).not.toHaveBeenCalled();
      expect(questions.map((q) => q.stage)).toEqual(['automation']);
      expect(calls).not.toContain('written');
      const [error] = posted('forge:execute:error');
      expect(error?.payload).toMatchObject({
        code: 'API_BUDGET_EXCEEDED',
        gate: { code: 'API_BUDGET_EXCEEDED' },
      });
      expect(String(error?.payload.message)).toContain(
        'The run takes about 70 API requests (68 of them for the checkpoint taken first), and DEV has 50 of its 15000 daily requests left',
      );
    });

    it('lets the same rows through without the checkpoint, and refuses them past what is left', async () => {
      limits = {
        DataStorageMB: { Max: 200, Remaining: 150 },
        DailyApiRequests: { Max: 15_000, Remaining: 50 },
      };
      setUp();
      await execute();
      expect(posted('forge:execute:response')).toHaveLength(1);

      // Forge's gate held no budget: a clone into an org whose integrations
      // had spent the day's requests stopped part way through.
      limits = {
        DataStorageMB: { Max: 200, Remaining: 150 },
        DailyApiRequests: { Max: 15_000, Remaining: 1 },
      };
      // A handler of its own: the same clone again within the minute is refused as sent twice.
      calls = [];
      handler = new ForgeHandler(deps);
      setUp();
      await execute();
      expect(calls).not.toContain('written');
      expect(posted('forge:execute:error')[0]?.payload).toMatchObject({
        code: 'API_BUDGET_EXCEEDED',
      });
    });

    it("reads the day's requests on their own when the target will not say its storage", async () => {
      // A Standard User's `/limits` list the requests and not the storage.
      limits = { DailyApiRequests: { Max: 15_000, Remaining: 1 } };
      setUp();

      await execute();

      expect(calls).not.toContain('written');
      expect(posted('forge:execute:error')[0]?.payload).toMatchObject({
        code: 'API_BUDGET_EXCEEDED',
      });
    });

    it('says in the question the requests the run would leave the target short of, by part', async () => {
      limits = {
        DataStorageMB: { Max: 200, Remaining: 150 },
        DailyApiRequests: { Max: 15_000, Remaining: 1_000 },
      };
      checkpointsAnswering();
      setUp();

      await execute({ checkpointFirst: {} });

      expect(questions[1]?.stage === 'write' && questions[1].apiRequests).toEqual({
        estimate: 70,
        remaining: 1_000,
        max: 15_000,
        parts: { run: 2, checkpoint: 68 },
      });
    });
  });

  it('hands the executor the lease it took, which the executor gives back after its last write', async () => {
    checkpointsAnswering();
    const { org } = setUp();

    await execute({ muteAutomation: true, checkpointFirst: {} });

    expect(gateAnswer).toMatchObject({ lease: { assigned: 1 } });
    // Given back by the executor before the run ended, and once only.
    expect(calls.filter((call) => call === 'assignment delete')).toHaveLength(1);
    expect(calls.indexOf('assignment delete')).toBeLessThan(calls.indexOf('lease given back'));
    expect(org.assignments()).toEqual([]);
  });

  it('says what the checkpoint would hold of a simulation, and takes none', async () => {
    const port = checkpointsAnswering();
    setUp(orchestratorHanding({ ...BOUNDARY, dryRun: true }, { ...RESULT, dryRun: true }));

    await execute({ checkpointFirst: {} }, { ...CONFIG, dryRun: true });

    expect(questions).toEqual([]);
    expect(port.scope).toHaveBeenCalledTimes(1);
    expect(port.take).not.toHaveBeenCalled();
    expect(port.settle).not.toHaveBeenCalled();
    expect(posted('forge:execute:response')[0]?.payload.result).toMatchObject({
      checkpoint: ESTIMATE,
    });
  });

  it('takes none for a retry, which names the checkpoint the run it retries took', async () => {
    store.set('forge:history', [
      {
        ...RESULT,
        forgeId: 'forge-first',
        status: 'partial',
        targetOrgId: 'tgt-org',
        idRemapTable: { [ACCOUNT_ID]: '001000000000999' },
        checkpoint: TAKEN,
      },
    ]);
    const port = checkpointsAnswering();
    setUp();

    await execute({ checkpointFirst: {}, retryOf: 'forge-first' });

    expect(port.scope).not.toHaveBeenCalled();
    expect(port.take).not.toHaveBeenCalled();
    expect(port.settle).not.toHaveBeenCalled();
    expect(posted('forge:execute:response')[0]?.payload.result).toMatchObject({
      retryOf: 'forge-first',
      checkpoint: TAKEN,
    });
    expect(runs()[0]).toMatchObject({ checkpointId: TAKEN.checkpointId });
  });

  it('refuses a run asked for one when no checkpoints are set up, nothing written', async () => {
    setUp();

    await execute({ checkpointFirst: {} });

    expect(calls).not.toContain('written');
    expect(posted('forge:execute:error')[0]?.payload).toMatchObject({ code: 'CHECKPOINT_REFUSED' });
  });
});
