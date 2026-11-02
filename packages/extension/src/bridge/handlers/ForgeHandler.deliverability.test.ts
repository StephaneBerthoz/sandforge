import path from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
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
  ForgeTargetFlow,
  MutedAutomation,
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
  type WritePathStep,
} from '../../modules/checkpoint/beforeRunCheckpoint.js';
import { ProductionGuard } from '../../core/precheck/ProductionGuard.js';
import type { RunConfirmation } from '../../core/precheck/ProductionGuard.js';
import { ConfigStore } from '../../core/storage/ConfigStore.js';
import { InMemoryConfigStoreBackend } from '../../test/InMemoryConfigStoreBackend.js';
import { AuditTrailStore } from '../../modules/audit/auditTrail.js';
import { inboundRequest } from '../../test/mockFactories.js';
import { memoryPermissionOrg } from '../../test/memoryPermissionOrg.js';
import { muteForRun, muteOrgOf } from '../../modules/forge/AutomationMuteLease.js';
import { EMAIL_NOT_PERMITTED } from '../../modules/forge/targetDeliverability.js';

vi.mock('../../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../core/connection/ConnectionHelper.js', () => ({
  getJsforceConnection: vi.fn(),
}));
vi.mock('../../core/common/sforceLimitParser.js', () => ({
  checkApiLimits: vi.fn(),
}));
vi.mock('../../modules/forge/AutomationMuteLease.js', async (original) => {
  const actual = await original<typeof import('../../modules/forge/AutomationMuteLease.js')>();
  return { ...actual, muteForRun: vi.fn(actual.muteForRun) };
});

import { getJsforceConnection } from '../../core/connection/ConnectionHelper.js';

const mockGetConn = vi.mocked(getJsforceConnection);

/*
 * A Forge run on the emails of what still runs, from the panel: whether the
 * target delivers them is read once the mute's plan says what does, and only
 * when something may send one, as the user the run writes as; it is judged at
 * the automation question, before a row is read, and going on is the accord.
 * What the org answers is what the probes read of it.
 */

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
  nodes: [node('Contact', 0)],
  edges: [],
  totalRecords: 10,
  estimatedSizeMB: 0.02,
  estimatedDurationSeconds: 0.1,
};

const CONFIG: ForgeConfig = {
  inputMode: 'record',
  recordId: '001000000000123',
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
  idRemapCount: 1,
  createdCount: 1,
};

const BOUNDARY: ForgeWriteBoundary = {
  objects: [{ objectApiName: 'Contact', rows: [{ Id: '003000000000001', LastName: 'One' }] }],
  dryRun: false,
};

const welcome = (over: Partial<ForgeTargetFlow> = {}): ForgeTargetFlow => ({
  apiName: 'Contact_Welcome',
  label: 'Contact welcome',
  timing: 'afterSave',
  startsOn: 'create',
  condition: 'read',
  permissions: [{ name: 'Load_Data', bypass: true }],
  messages: [{ kind: 'email', name: 'Send welcome', limit: 'SingleEmail' }],
  ...over,
});

/** What the target runs on contacts: a flow that emails each, kept quiet by `Load_Data`. */
function targetOf(flows: ForgeTargetFlow[] = [welcome()]): ForgeTargetAutomation {
  return {
    objectsRead: ['Contact'],
    objects: flows.length > 0 ? [{ objectApiName: 'Contact', flows, triggers: [] }] : [],
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
}

/** What an org on All email answers its anonymous Apex with. */
const ALL_EMAIL = { compiled: true, success: true };
/** What an org on System email only or No access answers it with. */
const CLOSED = { compiled: true, success: false, exceptionMessage: EMAIL_NOT_PERMITTED };

describe('forge:execute, the emails of what still runs', () => {
  let handler: ForgeHandler;
  let deps: HandlerDeps;
  let store: ConfigStore;
  let questions: RunConfirmation[];
  let answers: boolean[];
  /** What happened, in order: reads, questions, assignments, writes. */
  let calls: string[];
  /** What the target answers its anonymous Apex with. */
  let apex: unknown;
  let limits: Record<string, unknown>;
  let dir: string;

  beforeEach(() => {
    mockGetConn.mockReset();
    vi.mocked(muteForRun).mockClear();
    questions = [];
    answers = [];
    calls = [];
    apex = ALL_EMAIL;
    limits = {
      DataStorageMB: { Max: 200, Remaining: 150 },
      DailyApiRequests: { Max: 15_000, Remaining: 14_000 },
      SingleEmail: { Max: 15, Remaining: 15 },
      DailyWorkflowEmails: { Max: 500, Remaining: 500 },
    };
    dir = mkdtempSync(path.join(tmpdir(), 'forge-emails-'));
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
    mockGetConn.mockImplementation(
      async () =>
        ({
          query: vi.fn().mockResolvedValue({ records: [], done: true, totalSize: 0 }),
          queryMore: vi.fn(),
          request: vi.fn(async ({ url }: { url: string }) => {
            if (url.startsWith('/tooling/executeAnonymous')) {
              calls.push('deliverability read');
              return apex;
            }
            if (url.includes('UserPermissionAccess')) {
              return { records: [{ PermissionsEmailSingle: true }] };
            }
            if (url !== '/limits') throw new Error(`unexpected ${url}`);
            return limits;
          }),
        }) as never,
    );
    handler = new ForgeHandler(deps);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** An orchestrator whose run hands the rows to the gate, "writes", and gives the lease back. */
  function orchestratorHanding() {
    const execute = vi.fn(
      async (
        _graph: ForgeGraph,
        _config: ForgeConfig,
        options?: Pick<ExecuteOptions, 'beforeWrite' | 'stream'>,
      ) => {
        const answer: ForgeWriteGateAnswer | void = await options?.beforeWrite?.(BOUNDARY);
        calls.push('written');
        if (answer?.lease) await answer.lease.giveBack();
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

  function setUp(read: () => Promise<ForgeTargetAutomation> = async () => targetOf()) {
    const org = memoryPermissionOrg({
      sets: [{ id: SET, name: 'Data_Load' }],
      beforeWrite: (write) => {
        calls.push(`assignment ${write.kind}`);
      },
    });
    const orchestrator = orchestratorHanding();
    handler.setForgeOrchestrator(orchestrator, {
      targetAutomation: {
        readForGraph: vi.fn(read),
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

  /** The steps of the write path `calls` went through. */
  function stepsOf(said: readonly string[]): WritePathStep[] {
    const steps: Record<string, WritePathStep> = {
      'deliverability read': 'deliverabilityRead',
      'question automation': 'question',
      'question write': 'question',
      'assignment insert': 'leaseAcquire',
      written: 'write',
      'assignment delete': 'leaseRelease',
    };
    return said.flatMap((call) => (steps[call] ? [steps[call]] : []));
  }

  it('reads the org before the question, puts what sends in it, and takes going on for the accord', async () => {
    const { orchestrator } = setUp();

    await execute();

    expect(calls).toEqual(['deliverability read', 'question automation', 'written']);
    expect(
      writePathOrderDefects(['reads', 'leasePlan', 'stillRunning', ...stepsOf(calls), 'result']),
    ).toEqual([]);
    expect(questions[0]).toMatchObject({
      stage: 'automation',
      deliverability: {
        reading: { level: 'all' },
        senders: [
          { objectApiName: 'Contact', kind: 'flow', name: 'Contact welcome', why: 'email' },
        ],
      },
    });
    expect(orchestrator.execute).toHaveBeenCalledOnce();
    expect(runs()[0]?.context).toMatchObject({
      confirmed: ['automation', 'emails'],
      deliverability: 'all',
    });
  });

  it('asks and writes nothing when the answer is no, before a row is read', async () => {
    const { orchestrator } = setUp();
    answers = [false];

    await execute();

    expect(orchestrator.execute).not.toHaveBeenCalled();
    expect(posted('forge:execute:error')[0]?.payload).toMatchObject({
      code: 'AUTOMATION_DECLINED',
    });
    expect(runs()[0]?.context).toMatchObject({ deliverability: 'all' });
    expect(runs()[0]?.context?.confirmed).toBeUndefined();
  });

  it('asks as it does for All email when the org answers anything else, its words in the question', async () => {
    setUp();
    apex = { compiled: true, success: false, exceptionMessage: 'System.LimitException: no' };

    await execute();

    expect(questions[0]).toMatchObject({
      deliverability: { reading: { unread: 'the org answered: System.LimitException: no' } },
    });
    expect(runs()[0]?.context).toMatchObject({
      confirmed: ['automation', 'emails'],
      deliverability: 'unread',
    });
  });

  it('asks nothing of the emails of an org that withholds them, and says so in the audit trail', async () => {
    setUp();
    apex = CLOSED;

    await execute();

    expect(questions[0]).toMatchObject({ stage: 'automation' });
    expect(questions[0]).not.toHaveProperty('deliverability');
    expect(runs()[0]?.context).toMatchObject({
      confirmed: ['automation'],
      deliverability: 'withheld',
    });
  });

  it('reads nothing of an org whose automation sends nothing', async () => {
    setUp(async () => targetOf([welcome({ messages: [] })]));

    await execute();

    expect(calls).not.toContain('deliverability read');
    expect(questions[0]).not.toHaveProperty('deliverability');
    expect(runs()[0]?.context).not.toHaveProperty('deliverability');
  });

  it('reads nothing when the mute’s plan keeps every sender quiet, then holds the lease for the writes', async () => {
    setUp();

    await execute({ muteAutomation: true });

    expect(calls).toEqual(['assignment insert', 'written', 'assignment delete']);
    expect(questions).toEqual([]);
    expect(
      writePathOrderDefects(['reads', 'leasePlan', 'stillRunning', ...stepsOf(calls), 'result']),
    ).toEqual([]);
  });

  it('judges a muted run on what still runs: a flow no bypass keeps quiet is asked about before the lease', async () => {
    setUp(async () =>
      targetOf([
        welcome(),
        welcome({
          apiName: 'Contact_Notice',
          label: 'Contact notice',
          permissions: [],
        }),
      ]),
    );

    await execute({ muteAutomation: true });

    expect(calls).toEqual([
      'deliverability read',
      'question automation',
      'assignment insert',
      'written',
      'assignment delete',
    ]);
    expect(questions[0]).toMatchObject({
      deliverability: { senders: [expect.objectContaining({ name: 'Contact notice' })] },
    });
    expect(
      writePathOrderDefects(['reads', 'leasePlan', 'stillRunning', ...stepsOf(calls), 'result']),
    ).toEqual([]);
  });

  it('asks when the target’s automation could not be read at all, saying why nothing is named', async () => {
    setUp(async () => {
      throw new Error('INSUFFICIENT_ACCESS');
    });

    await execute();

    expect(questions[0]).toMatchObject({
      deliverability: {
        senders: [],
        sendersUnread: expect.stringContaining("the target's flows: INSUFFICIENT_ACCESS") as string,
      },
    });
  });

  it('counts what the read sent with the run’s requests, and refuses past what the target has left', async () => {
    const { orchestrator } = setUp();
    apex = CLOSED;
    limits = { ...limits, DailyApiRequests: { Max: 15_000, Remaining: 2 } };

    await execute();

    expect(orchestrator.execute).toHaveBeenCalledOnce();
    const error = posted('forge:execute:error')[0]?.payload;
    expect(error).toMatchObject({ code: 'API_BUDGET_EXCEEDED' });
    expect(String(error?.message)).toContain(
      '2 of them to read whether the target delivers its emails',
    );
    expect(calls).not.toContain('written');
  });

  describe('a lease that does not hold what its plan said', () => {
    /** A lease whose read-back holds no set, each end of it in `calls`. */
    function shortLease(): void {
      vi.mocked(muteForRun).mockImplementationOnce(async (org, read, options) => {
        const { muteForRun: actual } = await vi.importActual<
          typeof import('../../modules/forge/AutomationMuteLease.js')
        >('../../modules/forge/AutomationMuteLease.js');
        const planned = await actual(org, read, options);
        const held: MutedAutomation = { ...planned.muted, state: 'muted', assigned: [] };
        return {
          ...planned,
          ...(planned.prepared
            ? {
                prepared: {
                  ...planned.prepared,
                  acquire: async () => {
                    calls.push('assignment insert');
                    return {
                      outcome: held,
                      release: async () => {
                        calls.push('assignment delete');
                        return held;
                      },
                    };
                  },
                },
              }
            : {}),
        };
      });
    }

    it('refuses the run before its first write, gives the lease back, and deletes nothing it took', async () => {
      const { orchestrator } = setUp();
      shortLease();

      await execute({ muteAutomation: true });

      expect(orchestrator.execute).toHaveBeenCalledOnce();
      expect(calls).toEqual(['assignment insert', 'assignment delete']);
      expect(posted('forge:execute:error')[0]?.payload).toMatchObject({
        code: 'EMAILS_NOT_ACCEPTED',
        message: expect.stringContaining('Contact welcome') as string,
      });
      expect(runs()[0]).toMatchObject({
        outcome: 'stopped',
        details: { code: 'EMAILS_NOT_ACCEPTED' },
      });
      expect(
        writePathOrderDefects([
          'reads',
          'leasePlan',
          'stillRunning',
          'leaseAcquire',
          'afterLeaseCheck',
          'leaseRelease',
        ]),
      ).toEqual([]);
    });

    it('goes on when the question took the emails it left running', async () => {
      setUp(async () =>
        targetOf([
          welcome(),
          welcome({ apiName: 'Contact_Notice', label: 'Contact notice', permissions: [] }),
        ]),
      );
      shortLease();

      await execute({ muteAutomation: true });

      expect(calls).toContain('written');
    });
  });

  it('stops at the run’s Stop while the org is read, nothing asked and nothing written', async () => {
    const { orchestrator } = setUp();
    let answerRead: () => void = () => {};
    mockGetConn.mockImplementation(
      () =>
        new Promise((resolve) => {
          answerRead = () => resolve({} as never);
        }),
    );

    const running = execute();
    await vi.waitFor(() => expect(mockGetConn).toHaveBeenCalled());
    await handler.handle(
      inboundRequest({ id: 'stop', type: 'forge:abort', timestamp: Date.now() } as BaseMessage),
    );
    await running;
    answerRead();

    expect(orchestrator.execute).not.toHaveBeenCalled();
    expect(questions).toEqual([]);
    expect(posted('forge:execute:error')[0]?.payload).toMatchObject({
      code: 'ABORTED_BEFORE_START',
    });
  });

  describe('Review’s read', () => {
    const review = () =>
      handler.handle(
        inboundRequest({
          id: 'wv-automation',
          type: 'forge:automation:request',
          timestamp: Date.now(),
          payload: { targetOrgId: 'tgt-org', graph: GRAPH },
        } as BaseMessage),
      );

    it('says whether the org delivers what may send, and the requests it took', async () => {
      setUp();

      await review();

      expect(posted('forge:automation:response')[0]?.payload.automation).toMatchObject({
        deliverability: { level: 'all' },
        requests: 4,
      });
    });

    it('reads nothing when nothing sends', async () => {
      setUp(async () => targetOf([]));

      await review();

      expect(calls).toEqual([]);
      expect(posted('forge:automation:response')[0]?.payload.automation).not.toHaveProperty(
        'deliverability',
      );
    });

    it('runs no Apex in a production org', async () => {
      setUp();
      vi.mocked(deps.orgManager.getOrg).mockReturnValue({
        orgType: 'Production',
        alias: 'PROD',
      } as never);

      await review();

      expect(calls).not.toContain('deliverability read');
      expect(posted('forge:automation:response')[0]?.payload.automation).toMatchObject({
        deliverability: { unread: 'SandForge runs no Apex in a production org' },
        requests: 3,
      });
    });

    it('leaves the read the run takes up as it was: the run reads the org again', async () => {
      setUp();

      await review();
      calls = [];
      await execute();

      expect(calls[0]).toBe('deliverability read');
    });
  });
});
