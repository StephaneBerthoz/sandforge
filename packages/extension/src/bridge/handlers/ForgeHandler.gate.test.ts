import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ForgeHandler } from './ForgeHandler.js';
import type { HandlerDeps } from './HandlerTypes.js';
import type {
  BaseMessage,
  ForgeConfig,
  ForgeExecutionResult,
  ForgeGraph,
  ForgeGraphNode,
  ForgeTargetAutomation,
} from '@sandforge/shared';
import { ForgeOrchestrator } from '../../modules/forge/ForgeOrchestrator.js';
import type { ForgeOrchestratorDeps } from '../../modules/forge/ForgeOrchestrator.js';
import { ForgeExecutor } from '../../modules/forge/ForgeExecutor.js';
import type {
  ExecuteOptions,
  FieldInfo,
  ForgeExecutorDeps,
  ForgeWriteBoundary,
} from '../../modules/forge/ForgeExecutor.js';
import type { TargetAutomationReader } from '../../modules/forge/TargetAutomationReader.js';
import { ProductionGuard } from '../../core/precheck/ProductionGuard.js';
import type { RunConfirmation } from '../../core/precheck/ProductionGuard.js';
import { ConfigStore } from '../../core/storage/ConfigStore.js';
import { InMemoryConfigStoreBackend } from '../../test/InMemoryConfigStoreBackend.js';
import { AuditTrailStore } from '../../modules/audit/auditTrail.js';
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

/*
 * The gate a Forge run passes between Execute and its first write: a
 * production target refused, what the target runs as the run inserts put to
 * the user before anything is read, and the rows it is about to write — how
 * many, and the data storage they take — once they are read and before the
 * first goes. A clone whose dry run said 37 records wrote 34 216 into a
 * sandbox, and another fired the target's flows on every record it created:
 * nothing stopped either.
 */

const ACCOUNT_ID = '001000000000123';
const MB = 1024 * 1024;

function node(objectApiName: string, level: number, over: Partial<ForgeGraphNode> = {}) {
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
    ...over,
  } satisfies ForgeGraphNode;
}

/** An account and its contacts, as discovery answers them. */
function graphOf(contact: Partial<ForgeGraphNode> = {}): ForgeGraph {
  return {
    nodes: [node('Account', 0), node('Contact', 1, contact)],
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
}

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
  graph: graphOf(),
  duration: 10,
  timestamp: '2026-10-06T00:00:00.000Z',
  idRemapCount: 1,
  createdCount: 1,
};

/** What the target runs on the contacts: a flow after a contact is created, and a trigger. */
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
        },
      ],
      triggers: [{ name: 'ContactTrigger', events: ['beforeInsert', 'afterUpdate'] }],
    },
  ],
  unread: [],
  conditionsNotRead: 0,
  conditionsBound: 25,
  requests: 3,
};

/** A target that runs nothing on the run's objects, all of it read. */
const QUIET: ForgeTargetAutomation = { ...FIRES, objects: [] };

/** A reader of the target's automation answering `automation`. */
function readerOf(automation: ForgeTargetAutomation | Error) {
  return {
    readForGraph: vi.fn(async () => {
      if (automation instanceof Error) throw automation;
      return automation;
    }),
  } as unknown as TargetAutomationReader & { readForGraph: ReturnType<typeof vi.fn> };
}

/** `n` contacts of the account, as the run reads them. */
const contacts = (n: number): Record<string, unknown>[] =>
  Array.from({ length: n }, (_, i) => ({
    Id: `003${String(i + 1).padStart(12, '0')}`,
    LastName: `Contact ${i + 1}`,
    AccountId: ACCOUNT_ID,
  }));

/** What a run is about to write: the account and `n` of its contacts. */
const boundaryOf = (n: number): ForgeWriteBoundary => ({
  objects: [
    { objectApiName: 'Account', rows: [{ Id: ACCOUNT_ID, Name: 'Acme' }] },
    { objectApiName: 'Contact', rows: contacts(n) },
  ],
  dryRun: false,
});

describe('forge:execute, the gate before the first write', () => {
  let handler: ForgeHandler;
  let deps: HandlerDeps;
  let store: ConfigStore;
  /** The questions put to the user, in order, and the answers they get. */
  let questions: RunConfirmation[];
  let answers: boolean[];
  /** What happened, in order: questions asked, connections opened. */
  let calls: string[];
  /** What the target's `/limits` answer; an error refuses the request. */
  let limits: unknown;
  let settings: Record<string, unknown>;

  function guardAnswering(): ProductionGuard {
    return new ProductionGuard({
      requestRunConfirmation: async (question) => {
        calls.push(`asked ${question.stage}`);
        questions.push(question);
        return answers.shift() ?? true;
      },
    });
  }

  beforeEach(() => {
    mockGetConn.mockReset();
    questions = [];
    answers = [];
    calls = [];
    settings = {};
    limits = { DataStorageMB: { Max: 200, Remaining: 150 } };
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
      services: {
        getSandforgeSetting: <T>(key: string, fallback: T): T =>
          (key in settings ? settings[key] : fallback) as T,
      } as unknown as HandlerDeps['services'],
      infraServices: {
        productionGuard: guardAnswering(),
      } as unknown as HandlerDeps['infraServices'],
      nextId: () => String(++n),
    };
    // Both orgs answer: no record type, and the target's limits.
    mockGetConn.mockImplementation(async (orgId: string) => {
      calls.push(`connection ${orgId}`);
      return {
        query: vi.fn().mockResolvedValue({ records: [], done: true, totalSize: 0 }),
        queryMore: vi.fn(),
        request: vi.fn(async ({ url }: { url: string }) => {
          if (url !== '/limits') throw new Error(`unexpected ${url}`);
          if (limits instanceof Error) throw limits;
          return limits;
        }),
      } as never;
    });
    handler = new ForgeHandler(deps);
  });

  /** An orchestrator whose run hands `boundary` to the gate before it "writes". */
  function orchestratorHanding(boundary?: ForgeWriteBoundary) {
    const execute = vi.fn(
      async (
        _graph: ForgeGraph,
        _config: ForgeConfig,
        options?: Pick<ExecuteOptions, 'beforeWrite'>,
      ) => {
        if (boundary) await options?.beforeWrite?.(boundary);
        calls.push('written');
        return RESULT;
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

  function execute(graph: ForgeGraph = graphOf(), id = 'wv-execute'): Promise<boolean> {
    return handler.handle(
      inboundRequest({
        id,
        type: 'forge:execute',
        timestamp: Date.now(),
        payload: { graph, config: CONFIG },
      } as BaseMessage),
    );
  }

  /** Review's read of the target's automation, for `graph` as Review sends it. */
  function reviewReads(graph: ForgeGraph): Promise<boolean> {
    return handler.handle(
      inboundRequest({
        id: 'wv-automation',
        type: 'forge:automation:request',
        timestamp: Date.now(),
        payload: { targetOrgId: 'tgt-org', graph },
      } as BaseMessage),
    );
  }

  /** The messages of `type` the page was sent. */
  function posted(type: string): Array<BaseMessage & { payload: Record<string, unknown> }> {
    return vi
      .mocked(deps.broker.postToWebview)
      .mock.calls.map(([m]) => m as BaseMessage & { payload: Record<string, unknown> })
      .filter((m) => m.type === type);
  }

  /** The audit trail's entries for runs of the clone. */
  const runs = () =>
    new AuditTrailStore(store).list().entries.filter((e) => e.action === 'forge_execute');

  /**
   * A stop at the gate is a stop, not a failure: no `operation:failed`, the
   * operation ended as aborted when one had started, and the error the page
   * reads carries the gate's code.
   */
  function expectStoppedAtTheGate(code: string): void {
    expect(posted('operation:failed')).toEqual([]);
    const errors = posted('forge:execute:error');
    expect(errors).toHaveLength(1);
    expect(errors[0].correlationId).toBe('wv-execute');
    expect(errors[0].payload).toMatchObject({ code, gate: { code } });
    expect(String(errors[0].payload.message)).not.toMatch(/\n\s+at /);
    for (const started of posted('operation:started')) {
      expect(posted('operation:completed')).toContainEqual(
        expect.objectContaining({
          payload: expect.objectContaining({
            operationId: started.payload.operationId,
            result: { aborted: true },
          }),
        }),
      );
    }
  }

  describe('a simulation', () => {
    /** Review's Simulate: the same request, its config asking for a simulation. */
    function simulate(): Promise<boolean> {
      return handler.handle(
        inboundRequest({
          id: 'wv-execute',
          type: 'forge:execute',
          timestamp: Date.now(),
          payload: { graph: graphOf(), config: { ...CONFIG, dryRun: true } },
        } as BaseMessage),
      );
    }

    it('puts no question to the user, whatever the target runs, and hands the run a simulation', async () => {
      const reader = readerOf(FIRES);
      const orchestrator = orchestratorHanding({ ...boundaryOf(5000), dryRun: true });
      handler.setForgeOrchestrator(orchestrator, { targetAutomation: reader });

      await simulate();

      expect(questions).toEqual([]);
      expect(reader.readForGraph).not.toHaveBeenCalled();
      expect(orchestrator.execute).toHaveBeenCalledTimes(1);
      expect(orchestrator.execute.mock.calls[0][1]).toMatchObject({ dryRun: true });
      expect(posted('forge:execute:response')).toHaveLength(1);
    });

    it('keeps it out of the audit trail and the history: it wrote nothing', async () => {
      const orchestrator = orchestratorHanding();
      orchestrator.execute.mockResolvedValue({
        ...RESULT,
        createdCount: 0,
        idRemapCount: 0,
        dryRun: true,
        wouldInsertCount: 3,
      });
      handler.setForgeOrchestrator(orchestrator, { targetAutomation: readerOf(QUIET) });

      await simulate();

      expect(runs()).toEqual([]);
      expect(store.get('forge:history') ?? []).toEqual([]);
      expect(posted('forge:execute:response')[0]?.payload).toMatchObject({
        result: { dryRun: true, wouldInsertCount: 3 },
      });
    });

    it('refuses a production target, as a real run is refused', async () => {
      vi.mocked(deps.orgManager.getOrg).mockImplementation(
        (id: string) =>
          (id === 'tgt-org'
            ? { orgType: 'Production', alias: 'PROD' }
            : { orgType: 'Sandbox', alias: 'UAT' }) as unknown as ReturnType<
            HandlerDeps['orgManager']['getOrg']
          >,
      );
      const orchestrator = orchestratorHanding();
      handler.setForgeOrchestrator(orchestrator, { targetAutomation: readerOf(QUIET) });

      await simulate();

      expect(orchestrator.execute).not.toHaveBeenCalled();
      expect(posted('forge:execute:error').map((e) => e.payload.code)).toEqual([
        'PRODUCTION_TARGET',
      ]);
    });
  });

  it('counts in the audit trail, per object, the records a call may have written', async () => {
    const orchestrator = orchestratorHanding();
    orchestrator.execute.mockResolvedValue({
      ...RESULT,
      status: 'partial',
      idRemapByObject: [{ objectApiName: 'Account', created: 1, linked: 0 }],
      errors: [
        {
          objectApiName: 'Contact',
          stage: 'insert',
          failedCount: 2,
          attemptedCount: 2,
          samples: [],
        },
      ],
      mayHaveBeenWritten: [
        { objectApiName: 'Contact', sourceIds: contacts(2).map((c) => String(c['Id'])) },
      ],
    });
    handler.setForgeOrchestrator(orchestrator, { targetAutomation: readerOf(QUIET) });

    await execute();

    expect(runs()[0]?.objects).toContainEqual(
      expect.objectContaining({ objectApiName: 'Contact', failed: 2, mayHaveBeenWritten: 2 }),
    );
  });

  describe('the org it writes to', () => {
    /** The target as the registry keeps it: its type, and its edition when known. */
    function targetIs(orgType: string, edition?: string): void {
      vi.mocked(deps.orgManager.getOrg).mockImplementation(
        (id: string) =>
          (id === 'tgt-org'
            ? {
                orgType,
                alias: 'DEV',
                ...(edition === undefined
                  ? {}
                  : { metadata: { apiVersion: '66.0', edition, features: [] } }),
              }
            : { orgType: 'Sandbox', alias: 'UAT' }) as unknown as ReturnType<
            HandlerDeps['orgManager']['getOrg']
          >,
      );
    }

    it('writes to a Developer Edition org, which says IsSandbox false and is registered as production', async () => {
      // A Trailhead playground is one, and the only org many who try
      // SandForge have to clone into.
      targetIs('Production', 'Developer Edition');
      const check = vi.spyOn(deps.infraServices!.productionGuard, 'check');
      const orchestrator = orchestratorHanding();
      handler.setForgeOrchestrator(orchestrator, { targetAutomation: readerOf(QUIET) });

      await execute();

      expect(orchestrator.execute).toHaveBeenCalledTimes(1);
      // Judged as the development org it is: no production confirmation.
      expect(check.mock.calls.map(([request]) => request.orgTier)).toEqual(['development']);
      expect(posted('forge:execute:error')).toEqual([]);
    });

    it('writes to a scratch org', async () => {
      targetIs('Scratch');
      const orchestrator = orchestratorHanding();
      handler.setForgeOrchestrator(orchestrator, { targetAutomation: readerOf(QUIET) });

      await execute();

      expect(orchestrator.execute).toHaveBeenCalledTimes(1);
    });

    it.each([
      ['an Enterprise Edition production org', 'Enterprise Edition'],
      ['a production org whose edition was never read', ''],
      ['a production org kept with no edition at all', undefined],
    ])('refuses %s before reading anything', async (_label, edition) => {
      targetIs('Production', edition);
      const reader = readerOf(QUIET);
      const orchestrator = orchestratorHanding();
      handler.setForgeOrchestrator(orchestrator, { targetAutomation: reader });

      await execute();

      expect(orchestrator.execute).not.toHaveBeenCalled();
      expect(reader.readForGraph).not.toHaveBeenCalled();
      expect(mockGetConn).not.toHaveBeenCalled();
      expect(posted('forge:execute:error').map((e) => e.payload.code)).toEqual([
        'PRODUCTION_TARGET',
      ]);
    });

    it('refuses an org the registry does not know', async () => {
      vi.mocked(deps.orgManager.getOrg).mockReturnValue(undefined);
      const orchestrator = orchestratorHanding();
      handler.setForgeOrchestrator(orchestrator, { targetAutomation: readerOf(QUIET) });

      await execute();

      expect(orchestrator.execute).not.toHaveBeenCalled();
      expect(posted('forge:execute:error').map((e) => e.payload.code)).toEqual([
        'PRODUCTION_TARGET',
      ]);
    });
  });

  describe('what the target runs as the run inserts', () => {
    it("asks about what fires on insert before anything is read, from Review's read of the same graph", async () => {
      const reader = readerOf(FIRES);
      const orchestrator = orchestratorHanding();
      handler.setForgeOrchestrator(orchestrator, { targetAutomation: reader });
      await reviewReads(graphOf());

      await execute();

      expect(reader.readForGraph).toHaveBeenCalledTimes(1);
      expect(questions).toEqual([
        {
          stage: 'automation',
          org: 'DEV',
          orgTier: 'development',
          // In the order the platform runs them: the trigger, then the flow
          // after the save.
          fired: [
            { objectApiName: 'Contact', kind: 'trigger', name: 'ContactTrigger' },
            { objectApiName: 'Contact', kind: 'flow', name: 'Contact welcome' },
          ],
          unread: [],
          bypass: ['Load_Data'],
        },
      ]);
      // Asked before either org was read.
      expect(calls[0]).toBe('asked automation');
      expect(calls).toContain('written');
      expect(runs()).toEqual([expect.objectContaining({ outcome: 'success', guard: 'confirmed' })]);
    });

    it('reads it for the run when Review read nothing of this graph', async () => {
      const reader = readerOf(FIRES);
      handler.setForgeOrchestrator(orchestratorHanding(), { targetAutomation: reader });

      await execute();

      expect(reader.readForGraph).toHaveBeenCalledWith('tgt-org', graphOf(), new Set());
      expect(questions.map((q) => q.stage)).toEqual(['automation']);
    });

    it('reads it again when Review read it for another graph', async () => {
      const reader = readerOf(FIRES);
      handler.setForgeOrchestrator(orchestratorHanding(), { targetAutomation: reader });
      await reviewReads({ ...graphOf(), nodes: [node('Account', 0)] });

      await execute();

      expect(reader.readForGraph).toHaveBeenCalledTimes(2);
    });

    it('asks nothing when nothing fires on insert and all of it was read', async () => {
      const orchestrator = orchestratorHanding();
      handler.setForgeOrchestrator(orchestrator, { targetAutomation: readerOf(QUIET) });

      await execute();

      expect(questions).toEqual([]);
      expect(orchestrator.execute).toHaveBeenCalledTimes(1);
      expect(runs()).toEqual([expect.objectContaining({ outcome: 'success', guard: 'allowed' })]);
    });

    it('stops the run when the user declines, with nothing read or written, and back where they were', async () => {
      answers = [false];
      const orchestrator = orchestratorHanding();
      handler.setForgeOrchestrator(orchestrator, { targetAutomation: readerOf(FIRES) });

      await execute();

      expect(orchestrator.execute).not.toHaveBeenCalled();
      // Not even the record types of either org.
      expect(mockGetConn).not.toHaveBeenCalled();
      expectStoppedAtTheGate('AUTOMATION_DECLINED');
      expect(posted('forge:execute:error')[0].payload.message).toBe(
        'Forge execution was cancelled at the confirmation of what the target org runs as it ' +
          'inserts the records. Nothing was read or written.',
      );
      expect(runs()).toEqual([
        expect.objectContaining({
          outcome: 'stopped',
          guard: 'declined',
          objects: [],
          details: { code: 'AUTOMATION_DECLINED' },
        }),
      ]);
      // Nothing to remove, so nothing in the history.
      expect(store.get('forge:history')).toBeUndefined();
    });

    it('says in the question a read that failed, and asks though it found nothing', async () => {
      handler.setForgeOrchestrator(orchestratorHanding(), {
        targetAutomation: readerOf(new Error('INVALID_SESSION_ID: Session expired or invalid')),
      });

      await execute();

      expect(questions).toEqual([
        expect.objectContaining({
          stage: 'automation',
          fired: [],
          unread: [
            { part: 'automation', reason: 'INVALID_SESSION_ID: Session expired or invalid' },
          ],
        }),
      ]);
    });

    it('says in the question the parts the target refused, a start condition aside', async () => {
      handler.setForgeOrchestrator(orchestratorHanding(), {
        targetAutomation: readerOf({
          ...QUIET,
          unread: [
            { part: 'triggers', reason: 'INSUFFICIENT_ACCESS' },
            { part: 'conditions', reason: 'MALFORMED_QUERY' },
          ],
        }),
      });

      await execute();

      expect(questions).toEqual([
        expect.objectContaining({
          unread: [{ part: 'triggers', reason: 'INSUFFICIENT_ACCESS' }],
        }),
      ]);
    });

    it('never runs on a host with nobody to answer the question', async () => {
      deps.infraServices = {
        productionGuard: new ProductionGuard(),
      } as unknown as HandlerDeps['infraServices'];
      const orchestrator = orchestratorHanding();
      handler.setForgeOrchestrator(orchestrator, { targetAutomation: readerOf(FIRES) });

      await execute();

      expect(orchestrator.execute).not.toHaveBeenCalled();
      expectStoppedAtTheGate('CONFIRMATION_UNAVAILABLE');
    });

    it('leaves out of the question an object the user left out after Review read it', async () => {
      const reader = readerOf(FIRES);
      handler.setForgeOrchestrator(orchestratorHanding(), { targetAutomation: reader });
      await reviewReads(graphOf());

      await execute(graphOf({ included: false, leftOutByUser: true }));

      expect(reader.readForGraph).toHaveBeenCalledTimes(1);
      expect(questions).toEqual([]);
    });

    it("forgets Review's read of an org that is no longer the org it was", async () => {
      const reader = readerOf(FIRES);
      handler.setForgeOrchestrator(orchestratorHanding(), { targetAutomation: reader });
      await reviewReads(graphOf());

      handler.forgetOrg('tgt-org');
      await execute();

      expect(reader.readForGraph).toHaveBeenCalledTimes(2);
    });

    it('starts nothing once aborted while the question waits', async () => {
      let asked = false;
      let answer: (confirmed: boolean) => void = () => {};
      deps.infraServices = {
        productionGuard: new ProductionGuard({
          requestRunConfirmation: () =>
            new Promise<boolean>((resolve) => {
              asked = true;
              answer = resolve;
            }),
        }),
      } as unknown as HandlerDeps['infraServices'];
      const orchestrator = orchestratorHanding();
      handler.setForgeOrchestrator(orchestrator, { targetAutomation: readerOf(FIRES) });

      const running = execute();
      await vi.waitFor(() => expect(asked).toBe(true));
      await handler.handle(
        inboundRequest({
          id: 'wv-abort',
          type: 'forge:abort',
          timestamp: Date.now(),
        } as BaseMessage),
      );
      answer(true);
      await running;

      expect(orchestrator.execute).not.toHaveBeenCalled();
      expect(mockGetConn).not.toHaveBeenCalled();
      expect(runs()).toEqual([
        expect.objectContaining({ outcome: 'stopped', details: { code: 'ABORTED_BEFORE_START' } }),
      ]);
    });
  });

  describe('what the run is about to write', () => {
    it('asks past sandforge.safety.confirmAboveRecords, with the records per object and the storage they take', async () => {
      handler.setForgeOrchestrator(orchestratorHanding(boundaryOf(2_400)), {
        targetAutomation: readerOf(QUIET),
      });

      await execute();

      expect(questions).toEqual([
        {
          stage: 'write',
          org: 'DEV',
          orgTier: 'development',
          objects: [
            { objectApiName: 'Contact', rows: 2_400 },
            { objectApiName: 'Account', rows: 1 },
          ],
          total: 2_401,
          aboveRecords: 2_000,
          storage: {
            estimateMB: (2_401 * 2048) / MB,
            maxMB: 200,
            remainingMB: 150,
            near: false,
          },
        },
      ]);
      expect(calls.indexOf('asked write')).toBeLessThan(calls.indexOf('written'));
      expect(runs()).toEqual([expect.objectContaining({ outcome: 'success', guard: 'confirmed' })]);
    });

    it('asks nothing below it while the rows fit, and the run goes on', async () => {
      handler.setForgeOrchestrator(orchestratorHanding(boundaryOf(1_999)), {
        targetAutomation: readerOf(QUIET),
      });

      await execute();

      expect(questions).toEqual([]);
      expect(calls).toContain('written');
      expect(runs()).toEqual([expect.objectContaining({ outcome: 'success', guard: 'allowed' })]);
    });

    it('follows the setting, and asks about no volume at 0', async () => {
      settings['safety.confirmAboveRecords'] = 0;
      handler.setForgeOrchestrator(orchestratorHanding(boundaryOf(5_000)), {
        targetAutomation: readerOf(QUIET),
      });

      await execute();

      expect(questions).toEqual([]);
      expect(calls).toContain('written');
    });

    it('asks past a lower setting', async () => {
      settings['safety.confirmAboveRecords'] = 10;
      handler.setForgeOrchestrator(orchestratorHanding(boundaryOf(10)), {
        targetAutomation: readerOf(QUIET),
      });

      await execute();

      expect(questions).toEqual([expect.objectContaining({ total: 11, aboveRecords: 10 })]);
    });

    it('refuses rows that take more data storage than the target has left, without asking', async () => {
      limits = { DataStorageMB: { Max: 200, Remaining: 1 } };
      handler.setForgeOrchestrator(orchestratorHanding(boundaryOf(999)), {
        targetAutomation: readerOf(QUIET),
      });

      await execute();

      expect(questions).toEqual([]);
      expect(calls).not.toContain('written');
      expectStoppedAtTheGate('STORAGE_EXCEEDED');
      const [error] = posted('forge:execute:error');
      expect(error.payload.gate).toEqual({
        code: 'STORAGE_EXCEEDED',
        storage: { estimateMB: 1.96, remainingMB: 1 },
      });
      expect(error.payload.message).toBe(
        'The records to write take about 1.96 MB of data storage, and DEV has 1 MB left of ' +
          '200 MB: leave objects out, lower the records per object, or free data storage in ' +
          'DEV. Nothing was written.',
      );
      expect(runs()).toEqual([
        expect.objectContaining({
          outcome: 'stopped',
          guard: 'allowed',
          details: { code: 'STORAGE_EXCEEDED' },
        }),
      ]);
    });

    it('asks near what the target has left, whatever the volume', async () => {
      // 100 records take 0.2 MB: more than 80 % of what is left.
      limits = { DataStorageMB: { Max: 200, Remaining: 0.22 } };
      handler.setForgeOrchestrator(orchestratorHanding(boundaryOf(99)), {
        targetAutomation: readerOf(QUIET),
      });

      await execute();

      expect(questions).toEqual([
        expect.objectContaining({
          stage: 'write',
          total: 100,
          storage: expect.objectContaining({ near: true, remainingMB: 0.22 }),
        }),
      ]);
      expect(questions[0]).not.toHaveProperty('aboveRecords');
    });

    it('asks when the target will not say what it has left, and never refuses the run for that alone', async () => {
      limits = new Error('INSUFFICIENT_ACCESS: insufficient access rights on object id');
      handler.setForgeOrchestrator(orchestratorHanding(boundaryOf(5)), {
        targetAutomation: readerOf(QUIET),
      });

      await execute();

      expect(questions).toEqual([
        expect.objectContaining({
          stage: 'write',
          storage: {
            estimateMB: (6 * 2048) / MB,
            unread: 'INSUFFICIENT_ACCESS: insufficient access rights on object id',
          },
        }),
      ]);
      expect(calls).toContain('written');
    });

    it("puts the guard's large-volume warning in the question past 50 000 records on a sandbox", async () => {
      limits = { DataStorageMB: { Max: 1_000, Remaining: 900 } };
      handler.setForgeOrchestrator(orchestratorHanding(boundaryOf(50_000)), {
        targetAutomation: readerOf(QUIET),
      });

      await execute();

      expect(questions).toEqual([
        expect.objectContaining({ total: 50_001, aboveRecords: 2_000, largeVolume: 50_000 }),
      ]);
    });

    it('stops the run with nothing written when the user declines', async () => {
      answers = [false];
      handler.setForgeOrchestrator(orchestratorHanding(boundaryOf(2_400)), {
        targetAutomation: readerOf(QUIET),
      });

      await execute();

      expect(calls).not.toContain('written');
      expectStoppedAtTheGate('WRITE_DECLINED');
      expect(runs()).toEqual([
        expect.objectContaining({
          outcome: 'stopped',
          guard: 'declined',
          details: { code: 'WRITE_DECLINED' },
        }),
      ]);
    });
  });

  describe('through a real run', () => {
    const FIELDS: Record<string, FieldInfo[]> = {
      Account: [
        { name: 'Id', queryable: true, createable: false, isReference: false },
        { name: 'Name', queryable: true, createable: true, isReference: false },
      ],
      Contact: [
        { name: 'Id', queryable: true, createable: false, isReference: false },
        { name: 'LastName', queryable: true, createable: true, isReference: false },
        {
          name: 'AccountId',
          queryable: true,
          createable: true,
          isReference: true,
          referenceTo: ['Account'],
          nillable: true,
        },
      ],
    };

    /** An executor over a source holding the account and `n` of its contacts. */
    function realRun(n: number): ForgeExecutorDeps {
      const executorDeps = {
        describeFields: vi.fn(async (_org: string, object: string) => FIELDS[object] ?? []),
        queryRecords: vi.fn(async (org: string, soql: string) => {
          if (org !== 'src-org') return [];
          if (/FROM Account\b/.test(soql)) return [{ Id: ACCOUNT_ID, Name: 'Acme' }];
          if (/FROM Contact\b/.test(soql)) return contacts(n);
          return [];
        }),
        insertRecords: vi.fn(async (_org: string, _object: string, rows: unknown[]) =>
          rows.map((_, i) => ({
            id: `003${String(900 + i).padStart(12, '0')}`,
            success: true,
            errors: [],
          })),
        ),
      } satisfies ForgeExecutorDeps;
      handler.setForgeOrchestrator(
        new ForgeOrchestrator({
          discoveryService: {} as ForgeOrchestratorDeps['discoveryService'],
          executor: new ForgeExecutor(executorDeps),
        }),
        { targetAutomation: readerOf(QUIET) },
      );
      return executorDeps;
    }

    it('writes nothing of a plan a hundred times the size its dry run said, once the user declines', async () => {
      // The dry run counted 37 records; the real read held 3 700 contacts.
      answers = [false];
      const executorDeps = realRun(3_700);

      await execute();

      expect(questions).toEqual([
        expect.objectContaining({ stage: 'write', total: 3_701, aboveRecords: 2_000 }),
      ]);
      expect(executorDeps.insertRecords).not.toHaveBeenCalled();
      expectStoppedAtTheGate('WRITE_DECLINED');
      expect(runs()).toEqual([
        expect.objectContaining({ outcome: 'stopped', objects: [], guard: 'declined' }),
      ]);
      expect(store.get('forge:history')).toBeUndefined();
    });

    it('writes nothing when the rows do not fit in the target', async () => {
      limits = { DataStorageMB: { Max: 200, Remaining: 2 } };
      const executorDeps = realRun(1_500);

      await execute();

      expect(questions).toEqual([]);
      expect(executorDeps.insertRecords).not.toHaveBeenCalled();
      expectStoppedAtTheGate('STORAGE_EXCEEDED');
    });

    it('writes once the user confirms', async () => {
      const executorDeps = realRun(2_100);

      await execute();

      expect(questions.map((q) => q.stage)).toEqual(['write']);
      expect(executorDeps.insertRecords).toHaveBeenCalled();
      expect(posted('forge:execute:response')).toHaveLength(1);
    });
  });
});
