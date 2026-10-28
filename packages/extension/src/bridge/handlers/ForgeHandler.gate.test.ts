import path from 'node:path';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ForgeHandler } from './ForgeHandler.js';
import type { HandlerDeps } from './HandlerTypes.js';
import type {
  BaseMessage,
  ForgeConfig,
  ForgeExecutionResult,
  ForgeGraph,
  ForgeGraphNode,
  ForgeRemovalPlan,
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
import type { ForgeRemovalPlanStore } from '../../modules/forge/ForgeRemovalPlanStore.js';
import { ForgeRunJournal } from '../../modules/forge/ForgeRunJournal.js';
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

/**
 * A disk in memory, keyed as the platform writes paths: the journal joins its
 * paths with the platform's separator (a backslash on Windows), and a test
 * names a file with forward slashes. Both reach the same entry.
 */
class PathMap extends Map<string, string> {
  override get(key: string): string | undefined {
    return super.get(path.normalize(key));
  }
  override set(key: string, value: string): this {
    return super.set(path.normalize(key), value);
  }
  override has(key: string): boolean {
    return super.has(path.normalize(key));
  }
  override delete(key: string): boolean {
    return super.delete(path.normalize(key));
  }
}

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
        options?: Pick<ExecuteOptions, 'beforeWrite' | 'stream'>,
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
          // A contact under its account is written after it: nothing updates it.
          firedOnUpdate: [],
          updateSteps: [],
          unread: [],
          bypass: ['Load_Data'],
          // Whether a permission set holds it was not read: named, with no command.
          assign: [{ permission: 'Load_Data', others: [] }],
        },
      ]);
      // Asked before either org was read.
      expect(calls[0]).toBe('asked automation');
      expect(calls).toContain('written');
      expect(runs()).toEqual([expect.objectContaining({ outcome: 'success', guard: 'confirmed' })]);
    });

    it('says in that question what may refuse a removal of the records the run creates', async () => {
      const guarded: ForgeTargetAutomation = {
        ...FIRES,
        objects: [
          ...FIRES.objects,
          {
            objectApiName: 'Account',
            flows: [
              {
                apiName: 'Account_Guard',
                label: 'Account guard',
                timing: 'beforeDelete',
                startsOn: 'delete',
                condition: 'read',
                permissions: [],
              },
            ],
            triggers: [{ name: 'pkg.AccountAudit', events: ['afterDelete'] }],
          },
        ],
      };
      handler.setForgeOrchestrator(orchestratorHanding(), {
        targetAutomation: readerOf(guarded),
      });

      await execute();

      expect(questions[0]).toMatchObject({
        stage: 'automation',
        removal: [
          { objectApiName: 'Account', kind: 'flow', name: 'Account guard' },
          { objectApiName: 'Account', kind: 'packageTrigger', name: 'pkg.AccountAudit' },
        ],
      });
    });

    it('asks, in the same question, about what fires as the run gives an order back its status', async () => {
      // In a client's sandbox, a flow on orders sent each to an external system
      // as the clone gave it back the status it had past Draft.
      const ORDERS: ForgeTargetAutomation = {
        ...QUIET,
        objectsRead: ['Account', 'Order'],
        objects: [
          {
            objectApiName: 'Order',
            flows: [
              {
                apiName: 'Order_Sync',
                label: 'Order sync',
                timing: 'afterSave',
                startsOn: 'update',
                condition: 'read',
                permissions: [],
              },
            ],
            triggers: [],
          },
        ],
      };
      const graph: ForgeGraph = {
        ...graphOf(),
        nodes: [node('Account', 0), node('Order', 1)],
        edges: [
          {
            sourceObject: 'Account',
            targetObject: 'Order',
            relationshipName: 'Orders',
            type: 'lookup',
            required: true,
          },
        ],
      };
      const orchestrator = orchestratorHanding();
      handler.setForgeOrchestrator(orchestrator, { targetAutomation: readerOf(ORDERS) });

      await execute(graph);

      expect(questions).toEqual([
        expect.objectContaining({
          stage: 'automation',
          fired: [],
          firedOnUpdate: [{ objectApiName: 'Order', kind: 'flow', name: 'Order sync' }],
          updateSteps: ['statuses'],
        }),
      ]);
      expect(orchestrator.execute).toHaveBeenCalledTimes(1);
      expect(runs()[0]?.context).toMatchObject({
        firedOnUpdate: { flow: 1, trigger: 0, process: 0, workflowRule: 0 },
        confirmed: ['automation'],
      });
    });

    it('stops a run whose updates fire automation when the user declines, under the same code', async () => {
      answers = [false];
      const LOOPS: ForgeTargetAutomation = {
        ...QUIET,
        objects: [
          {
            objectApiName: 'Account',
            flows: [],
            triggers: [{ name: 'AccountTrigger', events: ['afterUpdate'] }],
          },
        ],
      };
      // An account's parent account: left empty at insert, filled in by an update.
      const graph: ForgeGraph = {
        ...graphOf(),
        edges: [
          ...graphOf().edges,
          {
            sourceObject: 'Account',
            targetObject: 'Account',
            relationshipName: 'ChildAccounts',
            type: 'lookup',
          },
        ],
      };
      const orchestrator = orchestratorHanding();
      handler.setForgeOrchestrator(orchestrator, { targetAutomation: readerOf(LOOPS) });

      await execute(graph);

      expect(questions[0]).toMatchObject({
        firedOnUpdate: [{ objectApiName: 'Account', kind: 'trigger', name: 'AccountTrigger' }],
        updateSteps: ['lookups'],
      });
      expect(orchestrator.execute).not.toHaveBeenCalled();
      expectStoppedAtTheGate('AUTOMATION_DECLINED');
    });

    it('puts with a bypass the command that assigns the smallest permission set holding it, to the user the run writes as', async () => {
      vi.mocked(deps.orgManager.getOrg).mockImplementation(
        (id: string) =>
          ({
            orgType: 'Sandbox',
            alias: id === 'tgt-org' ? 'DEV' : 'UAT',
            username: 'loader@example.com.dev',
          }) as never,
      );
      handler.setForgeOrchestrator(orchestratorHanding(), {
        targetAutomation: readerOf({
          ...FIRES,
          bypassGrants: [
            {
              permission: 'Load_Data',
              permissionSets: [
                { name: 'Data_Load', label: 'Data load', grants: 1 },
                { name: 'Integration', label: 'Integration', grants: 80 },
              ],
            },
          ],
        }),
      });

      await execute();

      expect(questions[0]).toMatchObject({
        assign: [
          {
            permission: 'Load_Data',
            permissionSet: 'Data_Load',
            others: ['Integration'],
            command:
              'sf org assign permset --name Data_Load --target-org DEV --on-behalf-of loader@example.com.dev',
          },
        ],
      });
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
          'inserts and updates the records. Nothing was read or written.',
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
      // The page is told what the trail records, not that the run failed.
      expect(posted('forge:execute:error').map((e) => e.payload.code)).toEqual([
        'ABORTED_BEFORE_START',
      ]);
    });

    it('reads the target again for the run after a declined question, not the read Review made meanwhile', async () => {
      // "Copy the command" cancels the clone, and the page goes back to Review,
      // which reads the target again as it opens — before the command is run.
      // Execute again within ten minutes took that read, the bypass still not
      // held, and asked the same question.
      const flowWith = (held: boolean): ForgeTargetAutomation => ({
        ...QUIET,
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
                permissions: [{ name: 'Load_Data', bypass: true, held }],
              },
            ],
            triggers: [],
          },
        ],
      });
      let target = flowWith(false);
      const reader = {
        readForGraph: vi.fn(async () => target),
      } as unknown as TargetAutomationReader & { readForGraph: ReturnType<typeof vi.fn> };
      const orchestrator = orchestratorHanding();
      handler.setForgeOrchestrator(orchestrator, { targetAutomation: reader });
      await reviewReads(graphOf());
      answers = [false];

      await execute();
      expect(questions).toHaveLength(1);
      expect(posted('forge:execute:error').map((e) => e.payload.code)).toEqual([
        'AUTOMATION_DECLINED',
      ]);

      await reviewReads(graphOf());
      // The user ran the command: the permission set is assigned.
      target = flowWith(true);
      await execute(graphOf(), 'wv-execute-again');

      expect(reader.readForGraph).toHaveBeenCalledTimes(3);
      // The flow is kept quiet now, and nothing else fires: nothing is asked.
      expect(questions).toHaveLength(1);
      expect(orchestrator.execute).toHaveBeenCalledTimes(1);
    });

    it('reads the target for each read Review asks for, and takes the newest for the run', async () => {
      // Review's Automation tab reads the target again on request: once the
      // user has run the command that assigns the bypass, that read shows it
      // held, and the run that follows takes it, not the read Review made as
      // it opened.
      const flowWith = (held: boolean): ForgeTargetAutomation => ({
        ...QUIET,
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
                permissions: [{ name: 'Load_Data', bypass: true, held }],
              },
            ],
            triggers: [],
          },
        ],
      });
      let target = flowWith(false);
      const reader = {
        readForGraph: vi.fn(async () => target),
      } as unknown as TargetAutomationReader & { readForGraph: ReturnType<typeof vi.fn> };
      const orchestrator = orchestratorHanding();
      handler.setForgeOrchestrator(orchestrator, { targetAutomation: reader });
      await reviewReads(graphOf());

      target = flowWith(true);
      await reviewReads(graphOf());

      expect(reader.readForGraph).toHaveBeenCalledTimes(2);
      expect(posted('forge:automation:response').map((m) => m.payload)).toEqual([
        { automation: flowWith(false) },
        { automation: flowWith(true) },
      ]);
      await execute();
      // The bypass is held: the flow stays quiet, and nothing else fires.
      expect(reader.readForGraph).toHaveBeenCalledTimes(2);
      expect(questions).toEqual([]);
      expect(orchestrator.execute).toHaveBeenCalledTimes(1);
    });

    it('still takes Review’s read for a run whose question was confirmed', async () => {
      const reader = readerOf(FIRES);
      const orchestrator = orchestratorHanding();
      // Wrote nothing: the second run is not refused as the first sent twice.
      orchestrator.execute.mockResolvedValue({ ...RESULT, createdCount: 0, idRemapCount: 0 });
      handler.setForgeOrchestrator(orchestrator, { targetAutomation: reader });
      await reviewReads(graphOf());

      await execute();
      await execute(graphOf(), 'wv-execute-again');

      expect(orchestrator.execute).toHaveBeenCalledTimes(2);
      expect(questions).toHaveLength(2);
      expect(reader.readForGraph).toHaveBeenCalledTimes(1);
    });
  });

  describe('what may refuse a removal, for a run Review was skipped for', () => {
    /** Nothing fires as the run writes; a flow before an account's delete may refuse it. */
    const GUARDED: ForgeTargetAutomation = {
      ...QUIET,
      objects: [
        {
          objectApiName: 'Account',
          flows: [
            {
              apiName: 'Account_Guard',
              label: 'Account guard',
              timing: 'beforeDelete',
              startsOn: 'delete',
              condition: 'read',
              permissions: [],
            },
          ],
          triggers: [],
        },
      ],
    };

    /** Clone directly: the run started with no stop on Review. */
    function cloneDirectly(): Promise<boolean> {
      return handler.handle(
        inboundRequest({
          id: 'wv-execute',
          type: 'forge:execute',
          timestamp: Date.now(),
          payload: { graph: graphOf(), config: CONFIG, reviewSkipped: true },
        } as BaseMessage),
      );
    }

    it('asks about it alone when nothing else is asked: Review, which says it, was never shown', async () => {
      const orchestrator = orchestratorHanding();
      handler.setForgeOrchestrator(orchestrator, { targetAutomation: readerOf(GUARDED) });

      await cloneDirectly();

      expect(questions).toEqual([
        {
          stage: 'automation',
          org: 'DEV',
          orgTier: 'development',
          fired: [],
          firedOnUpdate: [],
          updateSteps: [],
          unread: [],
          bypass: [],
          assign: [],
          removal: [{ objectApiName: 'Account', kind: 'flow', name: 'Account guard' }],
        },
      ]);
      expect(orchestrator.execute).toHaveBeenCalledTimes(1);
      expect(runs()).toEqual([expect.objectContaining({ guard: 'confirmed' })]);
    });

    it('stops the run when the user declines it, with nothing read or written', async () => {
      answers = [false];
      const orchestrator = orchestratorHanding();
      handler.setForgeOrchestrator(orchestrator, { targetAutomation: readerOf(GUARDED) });

      await cloneDirectly();

      expect(orchestrator.execute).not.toHaveBeenCalled();
      expectStoppedAtTheGate('AUTOMATION_DECLINED');
      expect(posted('forge:execute:error')[0].payload.message).toBe(
        'Forge execution was cancelled at the confirmation of what may refuse a removal of the ' +
          'records it creates. Nothing was read or written.',
      );
    });

    it('asks nothing of a run started from Review, whose Automation tab said it', async () => {
      const orchestrator = orchestratorHanding();
      handler.setForgeOrchestrator(orchestrator, { targetAutomation: readerOf(GUARDED) });

      await execute();

      expect(questions).toEqual([]);
      expect(orchestrator.execute).toHaveBeenCalledTimes(1);
    });

    it('asks nothing when nothing may refuse it', async () => {
      const orchestrator = orchestratorHanding();
      handler.setForgeOrchestrator(orchestrator, { targetAutomation: readerOf(QUIET) });

      await cloneDirectly();

      expect(questions).toEqual([]);
      expect(orchestrator.execute).toHaveBeenCalledTimes(1);
      expect(runs()).toEqual([expect.objectContaining({ guard: 'allowed' })]);
    });
  });

  describe('the tables it reads past the most rows of one object it holds', () => {
    /** Contacts whose table holds 80 000 rows, past the ceiling of 50 000. */
    const big = () => graphOf({ recordCount: 80_000 });

    it('asks before anything is read when nothing caps the read of a table past 50 000 rows', async () => {
      const orchestrator = orchestratorHanding();
      handler.setForgeOrchestrator(orchestrator, { targetAutomation: readerOf(QUIET) });

      await execute(big());

      expect(questions).toEqual([
        {
          stage: 'read',
          org: 'DEV',
          orgTier: 'development',
          source: 'UAT',
          objects: [{ objectApiName: 'Contact', rows: 80_000 }],
          ceiling: 50_000,
        },
      ]);
      // Asked before either org was read.
      expect(calls[0]).toBe('asked read');
      expect(orchestrator.execute).toHaveBeenCalledTimes(1);
      expect(runs()[0]).toMatchObject({ guard: 'confirmed', context: { confirmed: ['volume'] } });
    });

    it('stops the run when the user declines, with nothing read or written, under a code of its own', async () => {
      answers = [false];
      const orchestrator = orchestratorHanding();
      handler.setForgeOrchestrator(orchestrator, { targetAutomation: readerOf(QUIET) });

      await execute(big());

      expect(orchestrator.execute).not.toHaveBeenCalled();
      expect(mockGetConn).not.toHaveBeenCalled();
      expectStoppedAtTheGate('READ_DECLINED');
      expect(runs()).toEqual([
        expect.objectContaining({
          outcome: 'stopped',
          guard: 'declined',
          details: { code: 'READ_DECLINED' },
        }),
      ]);
    });

    it('asks after what fires on insert, each question in turn', async () => {
      const orchestrator = orchestratorHanding();
      handler.setForgeOrchestrator(orchestrator, { targetAutomation: readerOf(FIRES) });

      await execute(big());

      expect(questions.map((q) => q.stage)).toEqual(['automation', 'read']);
    });

    it('asks nothing of a table under the most rows of one object the settings set, and the run reads to it', async () => {
      settings['forge.maxRecordsPerObject'] = 100_000;
      const orchestrator = orchestratorHanding();
      handler.setForgeOrchestrator(orchestrator, { targetAutomation: readerOf(QUIET) });

      await execute(big());

      expect(questions).toEqual([]);
      expect(vi.mocked(orchestrator.execute).mock.calls[0][2]).toMatchObject({
        stream: { ceiling: 100_000 },
      });
    });

    it('asks past the most rows of one object the settings set, with that number', async () => {
      settings['forge.maxRecordsPerObject'] = 60_000;
      const orchestrator = orchestratorHanding();
      handler.setForgeOrchestrator(orchestrator, { targetAutomation: readerOf(QUIET) });

      await execute(big());

      expect(questions).toEqual([expect.objectContaining({ stage: 'read', ceiling: 60_000 })]);
    });

    it('says the most rows the run was set to read when the user declines past it', async () => {
      settings['forge.maxRecordsPerObject'] = 60_000;
      answers = [false];
      const orchestrator = orchestratorHanding();
      handler.setForgeOrchestrator(orchestrator, { targetAutomation: readerOf(QUIET) });

      await execute(big());

      expectStoppedAtTheGate('READ_DECLINED');
      expect(posted('forge:execute:error')[0].payload).toMatchObject({
        gate: { code: 'READ_DECLINED', ceiling: 60_000 },
      });
    });

    it.each([
      [5_000_000, 1_000_000],
      ['all', 50_000],
      [0, 50_000],
    ])('holds a setting of %s to %i, what a run may read', async (setting, ceiling) => {
      settings['forge.maxRecordsPerObject'] = setting;
      const orchestrator = orchestratorHanding();
      handler.setForgeOrchestrator(orchestrator, { targetAutomation: readerOf(QUIET) });

      await execute(graphOf({ recordCount: 10 }));

      expect(vi.mocked(orchestrator.execute).mock.calls[0][2]?.stream).toEqual({ ceiling });
    });

    it('asks nothing of a run whose cap per object keeps every read under the ceiling', async () => {
      const orchestrator = orchestratorHanding();
      handler.setForgeOrchestrator(orchestrator, { targetAutomation: readerOf(QUIET) });

      await handler.handle(
        inboundRequest({
          id: 'wv-execute',
          type: 'forge:execute',
          timestamp: Date.now(),
          payload: { graph: big(), config: { ...CONFIG, maxRecordsPerObject: 1_000 } },
        } as BaseMessage),
      );

      expect(questions).toEqual([]);
      expect(orchestrator.execute).toHaveBeenCalledTimes(1);
    });

    it('never runs on a host with nobody to answer the question', async () => {
      deps.infraServices = {
        productionGuard: new ProductionGuard(),
      } as unknown as HandlerDeps['infraServices'];
      const orchestrator = orchestratorHanding();
      handler.setForgeOrchestrator(orchestrator, { targetAutomation: readerOf(QUIET) });

      await execute(big());

      expect(orchestrator.execute).not.toHaveBeenCalled();
      expectStoppedAtTheGate('CONFIRMATION_UNAVAILABLE');
    });
  });

  describe('the journal of a run', () => {
    /** A disk in memory under a real journal: each file's text, by its path. */
    function journalOnMemory(options: { unwritable?: boolean } = {}) {
      const files = new PathMap();
      const journal = new ForgeRunJournal({
        storagePath: '/storage',
        appendFile: async (filePath, content) => {
          if (options.unwritable) throw new Error('ENOSPC: no space left on device');
          files.set(filePath, (files.get(filePath) ?? '') + content);
        },
        readLines: (filePath) =>
          (async function* lines(): AsyncGenerator<string> {
            for (const line of (files.get(filePath) ?? '').split('\n')) yield line;
          })(),
        mkdir: async () => {},
        rm: async (filePath) => void files.delete(filePath),
        listFiles: async (dirPath) =>
          [...files.keys()]
            .filter((filePath) => path.dirname(filePath) === path.normalize(dirPath))
            .map((filePath) => path.basename(filePath)),
        openRunFile: (filePath) => ({
          size: () => Buffer.byteLength(files.get(filePath) ?? ''),
          append: (text) => void files.set(filePath, (files.get(filePath) ?? '') + text),
          read: (offset, length) =>
            Buffer.from(files.get(filePath) ?? '').subarray(offset, offset + length),
          close: () => {},
        }),
      });
      return { journal, files };
    }

    function runOfWholeTables(): Promise<boolean> {
      return handler.handle(
        inboundRequest({
          id: 'wv-execute',
          type: 'forge:execute',
          timestamp: Date.now(),
          payload: {
            graph: graphOf({ recordCount: 10 }),
            config: {
              ...CONFIG,
              inputMode: 'soql',
              recordId: undefined,
              soqlQuery: 'SELECT Id FROM Contact',
            },
          },
        } as BaseMessage),
      );
    }

    it('writes its journal through the store it hands the run, and drops it once the run is in the history', async () => {
      const { journal, files } = journalOnMemory();
      const orchestrator = orchestratorHanding();
      let during: string[] = [];
      orchestrator.execute.mockImplementation(async (_graph, _config, options) => {
        const runStore = options?.stream?.store;
        runStore?.beginPart(new Date());
        runStore?.setMapping('created', '003000000000001AAA', '003000000000901AAA', 'Contact');
        runStore?.flush();
        during = [...files.values()];
        return RESULT;
      });
      handler.setForgeOrchestrator(orchestrator, {
        targetAutomation: readerOf(QUIET),
        runJournal: journal,
      });

      await runOfWholeTables();

      expect(during).toHaveLength(1);
      const [head, part, created] = during[0].trim().split('\n');
      // The head says what the run was started with: what resuming it needs.
      expect(JSON.parse(head)).toMatchObject({
        run: {
          targetOrgId: 'tgt-org',
          resume: {
            sourceOrgId: 'src-org',
            fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
            startedWith: { config: { soqlQuery: 'SELECT Id FROM Contact' } },
          },
        },
      });
      expect(part).toMatch(/^\{"part":\{"n":0,/);
      expect(created).toBe('["c","003000000000001AAA","003000000000901AAA","Contact"]');
      expect(files.size).toBe(0);
      expect(posted('forge:execute:response')).toHaveLength(1);
    });

    it('runs on when its journal cannot be written: the history records what it created', async () => {
      const { journal } = journalOnMemory({ unwritable: true });
      const orchestrator = orchestratorHanding();
      handler.setForgeOrchestrator(orchestrator, {
        targetAutomation: readerOf(QUIET),
        runJournal: journal,
      });

      await runOfWholeTables();

      expect(vi.mocked(orchestrator.execute).mock.calls[0][2]?.stream?.store).toBeUndefined();
      expect(posted('forge:execute:response')).toHaveLength(1);
      expect(posted('forge:execute:error')).toEqual([]);
    });

    it('never starts a run the user stopped while its journal was opened, and drops the journal', async () => {
      // The journal is opened after the run's last check of its cancel and
      // before the executor has it; the executor clears an abort on entry.
      // A Cancel landing there was taken, Live Operations listed the run as
      // stopped, and the run wrote all the same.
      const { journal } = journalOnMemory();
      let opened: () => void = () => {};
      const begin = vi.spyOn(journal, 'begin').mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            opened = resolve;
          }),
      );
      const end = vi.spyOn(journal, 'end');
      const orchestrator = orchestratorHanding();
      handler.setForgeOrchestrator(orchestrator, {
        targetAutomation: readerOf(QUIET),
        runJournal: journal,
      });

      const run = runOfWholeTables();
      await vi.waitFor(() => expect(begin).toHaveBeenCalledTimes(1));
      await handler.handle(
        inboundRequest({
          id: 'wv-abort',
          type: 'forge:abort',
          timestamp: Date.now(),
        } as BaseMessage),
      );
      opened();
      await run;

      expect(orchestrator.execute).not.toHaveBeenCalled();
      expect(posted('forge:execute:response')).toEqual([]);
      expect(posted('forge:execute:error')).toEqual([
        expect.objectContaining({
          payload: expect.objectContaining({ code: 'ABORTED_BEFORE_START' }),
        }),
      ]);
      const [id] = begin.mock.calls[0] as unknown as [string];
      expect(end).toHaveBeenCalledWith(id);
    });

    it('keeps the journal of a run from a record too, and drops it once the run is in the history', async () => {
      const { journal, files } = journalOnMemory();
      const orchestrator = orchestratorHanding();
      let during: string[] = [];
      orchestrator.execute.mockImplementation(async (_graph, _config, options) => {
        const runStore = options?.stream?.store;
        runStore?.beginPart(new Date());
        runStore?.setMapping('created', '003000000000001AAA', '003000000000901AAA', 'Contact');
        runStore?.flush();
        during = [...files.values()];
        return RESULT;
      });
      handler.setForgeOrchestrator(orchestrator, {
        targetAutomation: readerOf(QUIET),
        runJournal: journal,
      });

      await execute();

      expect(during).toHaveLength(1);
      const [head, , created] = during[0].trim().split('\n');
      expect(JSON.parse(head)).toMatchObject({
        run: { resume: { startedWith: { config: { inputMode: 'record' } } } },
      });
      expect(created).toBe('["c","003000000000001AAA","003000000000901AAA","Contact"]');
      expect(files.size).toBe(0);
    });

    it('offers what a run of 1.50 a closed window never ended created, among the runs the history dropped', async () => {
      const { journal, files } = journalOnMemory();
      files.set(
        '/storage/forge-runs/forge-run-1.ndjson',
        '{"run":{"journalId":"forge-run-1","targetOrgId":"tgt-org","startedAt":"2026-10-13T10:00:00.000Z"}}\n' +
          '{"object":"Contact","created":[["003000000000001AAA","003000000000901AAA"]]}\n',
      );
      const left: ForgeRemovalPlan = {
        forgeId: 'forge-run-1',
        targetOrgId: 'tgt-org',
        timestamp: '2026-10-13T10:00:00.000Z',
        duration: 0,
        status: 'partial',
        objects: [{ objectApiName: 'Contact', ids: ['003000000000901AAA'] }],
        linked: 0,
      };
      const plans: ForgeRemovalPlan[] = [];
      const removalPlans = {
        list: vi.fn(async () => plans),
        putIfAbsent: vi.fn(async (plan: ForgeRemovalPlan) => void plans.push(plan)),
      };
      handler.setForgeOrchestrator(orchestratorHanding(), {
        runJournal: journal,
        removalPlans: removalPlans as unknown as ForgeRemovalPlanStore,
      });

      await handler.handle(
        inboundRequest({
          id: 'wv-history',
          type: 'forge:history:list',
          timestamp: Date.now(),
          payload: {},
        } as BaseMessage),
      );

      expect(removalPlans.putIfAbsent).toHaveBeenCalledWith(left);
      expect(files.size).toBe(0);
      expect(posted('forge:history:list:response')[0].payload).toMatchObject({
        olderRuns: [left],
      });
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

    it('says in the question what it does not count, and that counted rows were not read yet', async () => {
      handler.setForgeOrchestrator(
        orchestratorHanding({
          objects: [
            {
              objectApiName: 'Contact',
              rows: [],
              counted: { rows: 2_400 },
              leftOut: { writtenBefore: 600 },
            },
            {
              objectApiName: 'Opportunity',
              rows: [],
              counted: { rows: 0 },
              leftOut: { heldBack: 30 },
            },
          ],
          dryRun: false,
        }),
        { targetAutomation: readerOf(QUIET) },
      );

      await execute();

      expect(questions).toEqual([
        expect.objectContaining({
          stage: 'write',
          total: 2_400,
          leftOut: { writtenBefore: 600, heldBack: [{ objectApiName: 'Opportunity', rows: 30 }] },
          counted: true,
        }),
      ]);
    });

    it('says in the question the objects that stop at Records per object with more left in the source', async () => {
      handler.setForgeOrchestrator(
        orchestratorHanding({
          ...boundaryOf(2_400),
          capped: { perObject: 100, objects: ['Case'] },
        }),
        { targetAutomation: readerOf(QUIET) },
      );

      await execute();

      expect(questions).toEqual([
        expect.objectContaining({
          stage: 'write',
          capped: { perObject: 100, objects: ['Case'] },
        }),
      ]);
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

    it('counts in the prices the write may read besides those in hand, and says them', async () => {
      // Read as the prices were written, a price wanted in two currencies
      // wrote 17 records where the gate had counted 13.
      settings['safety.confirmAboveRecords'] = 10;
      const priced: ForgeWriteBoundary = {
        objects: [
          { objectApiName: 'PricebookEntry', rows: contacts(8), mayAdd: 4 },
          { objectApiName: 'Account', rows: [{ Id: ACCOUNT_ID, Name: 'Acme' }] },
        ],
        dryRun: false,
      };
      handler.setForgeOrchestrator(orchestratorHanding(priced), {
        targetAutomation: readerOf(QUIET),
      });

      await execute();

      expect(questions).toEqual([
        expect.objectContaining({
          total: 13,
          aboveRecords: 10,
          pricesForLines: 4,
          objects: [
            { objectApiName: 'PricebookEntry', rows: 12 },
            { objectApiName: 'Account', rows: 1 },
          ],
        }),
      ]);
    });

    it('asks before rows whose flows would send more single emails than the target has left today', async () => {
      // Live, into a Developer Edition: a contact flow's Send Email went past
      // fifteen a day, and thirty contacts were refused.
      limits = {
        DataStorageMB: { Max: 200, Remaining: 150 },
        SingleEmail: { Max: 15, Remaining: 3 },
      };
      const sending: ForgeTargetAutomation = {
        ...FIRES,
        objects: [
          {
            ...FIRES.objects[0],
            triggers: [],
            flows: [
              {
                ...FIRES.objects[0].flows[0],
                messages: [{ kind: 'email', name: 'Send welcome', limit: 'SingleEmail' }],
              },
            ],
          },
        ],
      };
      handler.setForgeOrchestrator(orchestratorHanding(boundaryOf(10)), {
        targetAutomation: readerOf(sending),
      });

      await execute();

      expect(questions.map((q) => q.stage)).toEqual(['automation', 'write']);
      expect(questions[1]).toEqual(
        expect.objectContaining({
          emails: [
            {
              limit: 'SingleEmail',
              emails: 10,
              remaining: 3,
              max: 15,
              objects: [{ objectApiName: 'Contact', perRecord: 1 }],
            },
          ],
        }),
      );
      expect(calls).toContain('written');
    });

    it("counts a Developer Edition's email alerts against its single emails, and asks past them", async () => {
      // Live, on 2026-10-14: a clone of 36 contacts into the trap Developer
      // Edition said "36 workflow emails; 8019 of 8040 left", its single
      // emails at −75 of 15, and the alert of its contact rule took them to −117.
      limits = {
        DataStorageMB: { Max: 200, Remaining: 150 },
        SingleEmail: { Max: 15, Remaining: -75 },
        DailyWorkflowEmails: { Max: 8_040, Remaining: 8_019 },
      };
      const alerting: ForgeTargetAutomation = {
        ...FIRES,
        objects: [
          {
            ...FIRES.objects[0],
            triggers: [],
            flows: [],
            workflowRules: [
              {
                ...FIRES.objects[0].flows[0],
                apiName: 'Contact_Welcome_Rule',
                label: 'Contact welcome rule',
                permissions: [],
                messages: [{ kind: 'email', name: 'Contact alert', limit: 'DailyWorkflowEmails' }],
              },
            ],
          },
        ],
      };
      handler.setForgeOrchestrator(orchestratorHanding(boundaryOf(36)), {
        targetAutomation: readerOf(alerting),
      });

      await execute();

      expect(questions.map((q) => q.stage)).toEqual(['automation', 'write']);
      expect(questions[1]).toEqual(
        expect.objectContaining({
          emails: [
            {
              limit: 'SingleEmail',
              emails: 36,
              remaining: -75,
              max: 15,
              objects: [{ objectApiName: 'Contact', perRecord: 1 }],
              alertsCounted: true,
            },
          ],
        }),
      );
    });

    it('asks before rows whose flows send emails against a daily limit the target did not say it has left of', async () => {
      // Execute and Clone directly dropped such a limit: said nowhere, while
      // an Autopilot run of the same rows asked about it.
      limits = { DataStorageMB: { Max: 200, Remaining: 150 } };
      const sending: ForgeTargetAutomation = {
        ...FIRES,
        objects: [
          {
            ...FIRES.objects[0],
            triggers: [],
            flows: [
              {
                ...FIRES.objects[0].flows[0],
                messages: [{ kind: 'email', name: 'Send welcome', limit: 'SingleEmail' }],
              },
            ],
          },
        ],
      };
      handler.setForgeOrchestrator(orchestratorHanding(boundaryOf(10)), {
        targetAutomation: readerOf(sending),
      });

      await execute();

      expect(questions.map((q) => q.stage)).toEqual(['automation', 'write']);
      expect(questions[1]).toEqual(
        expect.objectContaining({
          total: 11,
          emailsUnread: [
            { limit: 'SingleEmail', emails: 10, unread: "the org's limits list no SingleEmail" },
          ],
        }),
      );
      expect(questions[1]).not.toHaveProperty('aboveRecords');
      expect(questions[1]).not.toHaveProperty('emails');
      expect(calls).toContain('written');
    });

    it('asks nothing of emails when the target says it has enough of them left', async () => {
      limits = {
        DataStorageMB: { Max: 200, Remaining: 150 },
        SingleEmail: { Max: 15, Remaining: 15 },
      };
      const sending: ForgeTargetAutomation = {
        ...FIRES,
        objects: [
          {
            ...FIRES.objects[0],
            triggers: [],
            flows: [
              {
                ...FIRES.objects[0].flows[0],
                messages: [{ kind: 'email', name: 'Send welcome', limit: 'SingleEmail' }],
              },
            ],
          },
        ],
      };
      handler.setForgeOrchestrator(orchestratorHanding(boundaryOf(10)), {
        targetAutomation: readerOf(sending),
      });

      await execute();

      expect(questions.map((q) => q.stage)).toEqual(['automation']);
      expect(calls).toContain('written');
    });

    describe('emails that were not counted', () => {
      /**
       * The contacts' flow after the save, as the reader gives one a package
       * installed: probed on a Developer Edition, its active version was named
       * after it, not by an id, and no user reads its definition.
       */
      const packaged = (
        over: Partial<ForgeTargetAutomation['objects'][number]['flows'][number]> = {},
      ) =>
        ({
          ...FIRES,
          objects: [
            {
              objectApiName: 'Contact',
              triggers: [],
              flows: [
                {
                  apiName: 'survey_kit__Contact_Feedback',
                  label: 'Contact feedback',
                  timing: 'afterSave',
                  startsOn: 'create',
                  condition: 'unreadable',
                  permissions: [],
                  paths: [],
                  messages: [],
                  switches: [],
                  ...over,
                },
              ],
            },
          ],
        }) satisfies ForgeTargetAutomation;

      it('asks before rows a flow a package installed fires on, saying its emails were not counted and why', async () => {
        // It fires on every contact the run creates: what it sends was
        // counted as nothing, and the gate let the run write without a word.
        handler.setForgeOrchestrator(orchestratorHanding(boundaryOf(10)), {
          targetAutomation: readerOf(packaged()),
        });

        await execute();

        expect(questions.map((q) => q.stage)).toEqual(['automation', 'write']);
        expect(questions[1]).toEqual(
          expect.objectContaining({
            total: 11,
            emailsUncounted:
              'the definition of Contact feedback (package survey_kit, whose flows the org lets ' +
              'no one read) on Contact',
          }),
        );
        expect(questions[1]).not.toHaveProperty('emails');
        expect(questions[1]).not.toHaveProperty('emailsUnread');
        expect(questions[1]).not.toHaveProperty('aboveRecords');
        expect(calls.indexOf('asked write')).toBeLessThan(calls.indexOf('written'));
      });

      it('asks nothing of a flow whose definition was read and sends no email', async () => {
        handler.setForgeOrchestrator(orchestratorHanding(boundaryOf(10)), {
          targetAutomation: readerOf(packaged({ apiName: 'Contact_Feedback', condition: 'read' })),
        });

        await execute();

        expect(questions.map((q) => q.stage)).toEqual(['automation']);
        expect(calls).toContain('written');
      });

      it("asks when the target's automation could not be read, none of its emails counted", async () => {
        handler.setForgeOrchestrator(orchestratorHanding(boundaryOf(10)), {
          targetAutomation: readerOf(new Error('INVALID_SESSION_ID: Session expired or invalid')),
        });

        await execute();

        expect(questions.map((q) => q.stage)).toEqual(['automation', 'write']);
        expect(questions[1]).toEqual(
          expect.objectContaining({
            emailsUncounted:
              "the target's automation: INVALID_SESSION_ID: Session expired or invalid",
          }),
        );
      });

      it('writes nothing when the user declines it', async () => {
        handler.setForgeOrchestrator(orchestratorHanding(boundaryOf(10)), {
          targetAutomation: readerOf(packaged()),
        });
        answers = [true, false];

        await execute();

        expect(calls).not.toContain('written');
        expectStoppedAtTheGate('WRITE_DECLINED');
      });
    });

    describe('beside the last simulation of the same case', () => {
      /** Review's Simulate of `config`, its gate handed `boundary`. */
      async function simulateHanding(
        orchestrator: ReturnType<typeof orchestratorHanding>,
        boundary: ForgeWriteBoundary,
        config: ForgeConfig = CONFIG,
      ): Promise<void> {
        orchestrator.execute.mockImplementationOnce(async (_graph, _config, options) => {
          await options?.beforeWrite?.({ ...boundary, dryRun: true });
          return { ...RESULT, createdCount: 0, idRemapCount: 0, dryRun: true as const };
        });
        await handler.handle(
          inboundRequest({
            id: 'wv-simulate',
            type: 'forge:execute',
            timestamp: Date.now(),
            payload: { graph: graphOf(), config: { ...config, dryRun: true } },
          } as BaseMessage),
        );
      }

      it('asks, whatever the volume, before a run far past what the simulation counted, with the gap per object', async () => {
        // A clone whose dry run said 37 records wrote 34 216 into a sandbox:
        // a parent added to its graph widened what was read of its children.
        const orchestrator = orchestratorHanding(boundaryOf(40));
        handler.setForgeOrchestrator(orchestrator, { targetAutomation: readerOf(QUIET) });
        await simulateHanding(orchestrator, boundaryOf(5));
        expect(questions).toEqual([]);

        await execute();

        expect(questions).toEqual([
          expect.objectContaining({
            stage: 'write',
            total: 41,
            objects: [
              { objectApiName: 'Contact', rows: 40 },
              { objectApiName: 'Account', rows: 1 },
            ],
            simulated: {
              minutesBefore: 1,
              total: 6,
              objects: [
                { objectApiName: 'Contact', rows: 5 },
                { objectApiName: 'Account', rows: 1 },
              ],
              farAbove: true,
            },
          }),
        ]);
        expect(questions[0]).not.toHaveProperty('aboveRecords');
        expect(calls).toContain('written');
      });

      it('asks nothing of a run near what the simulation counted', async () => {
        const orchestrator = orchestratorHanding(boundaryOf(6));
        handler.setForgeOrchestrator(orchestrator, { targetAutomation: readerOf(QUIET) });
        await simulateHanding(orchestrator, boundaryOf(5));

        await execute();

        expect(questions).toEqual([]);
        expect(calls).toContain('written');
      });

      it('says what the simulation counted when the run is asked about for its volume', async () => {
        settings['safety.confirmAboveRecords'] = 3;
        const orchestrator = orchestratorHanding(boundaryOf(6));
        handler.setForgeOrchestrator(orchestrator, { targetAutomation: readerOf(QUIET) });
        await simulateHanding(orchestrator, boundaryOf(5));

        await execute();

        expect(questions).toEqual([
          expect.objectContaining({
            aboveRecords: 3,
            simulated: expect.objectContaining({ total: 6 }),
          }),
        ]);
        const [asked] = questions;
        expect(asked?.stage === 'write' ? asked.simulated : undefined).not.toHaveProperty(
          'farAbove',
        );
      });

      it('measures a run against no simulation of another record', async () => {
        const orchestrator = orchestratorHanding(boundaryOf(40));
        handler.setForgeOrchestrator(orchestrator, { targetAutomation: readerOf(QUIET) });
        await simulateHanding(orchestrator, boundaryOf(5), {
          ...CONFIG,
          recordId: '001000000000456',
        });

        await execute();

        expect(questions).toEqual([]);
        expect(calls).toContain('written');
      });
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
