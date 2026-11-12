import path from 'node:path';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { BaseMessage, ForgeTargetAutomation, ForgeTargetFlow } from '@sandforge/shared';
import { AutopilotHandler } from './AutopilotHandler.js';
import type { HandlerDeps } from './HandlerTypes.js';
import {
  writePathOrderDefects,
  type WritePathStep,
} from '../../modules/checkpoint/beforeRunCheckpoint.js';
import { ProductionGuard, type RunConfirmation } from '../../core/precheck/ProductionGuard.js';
import { ConfigStore } from '../../core/storage/ConfigStore.js';
import { InMemoryConfigStoreBackend } from '../../test/InMemoryConfigStoreBackend.js';
import { AuditTrailStore } from '../../modules/audit/auditTrail.js';
import { inboundRequest } from '../../test/mockFactories.js';
import { memoryPermissionOrg } from '../../test/memoryPermissionOrg.js';
import { answeringDeliverability, type DeliverabilityLevel } from '../../test/deliverabilityOrg.js';

vi.mock('../../core/connection/ConnectionHelper.js', () => ({
  getJsforceConnection: vi.fn(),
}));
// The mute is the real one, a test reading back a lease that holds less.
vi.mock('../../modules/forge/AutomationMuteLease.js', async (original) => {
  const actual = await original<typeof import('../../modules/forge/AutomationMuteLease.js')>();
  return { ...actual, muteForRun: vi.fn(actual.muteForRun) };
});

import { getJsforceConnection } from '../../core/connection/ConnectionHelper.js';
import { muteForRun } from '../../modules/forge/AutomationMuteLease.js';

const mockGetConn = vi.mocked(getJsforceConnection);

/*
 * An Autopilot run from the panel on a target whose flows email the leads it
 * creates: whether the target delivers them is read once the mute's plan is
 * known and before the run's one question, only when something still sends,
 * its requests counted; asked about, its answer the accord, written in the
 * audit trail; and checked again once the lease is read back.
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

/** A lead flow that emails the lead it creates, kept quiet by `bypass` when given. */
function emailingFlow(label: string, bypass?: string): ForgeTargetFlow {
  return {
    apiName: label.replace(/ /g, '_'),
    label,
    timing: 'afterSave',
    startsOn: 'create',
    condition: 'read',
    permissions: bypass ? [{ name: bypass, bypass: true }] : [],
    messages: [{ kind: 'email', name: `Send ${label}`, limit: 'SingleEmail' }],
  };
}

/** What the target runs on the leads: `flows`, the bypass `Load_Data` held by `Data_Load`. */
function leadAutomation(flows: ForgeTargetFlow[]): ForgeTargetAutomation {
  return {
    objectsRead: ['Lead'],
    objects: [{ objectApiName: 'Lead', flows, triggers: [] }],
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
}

/** A welcome email the bypass keeps quiet, and an owner's email nothing keeps quiet. */
const BOTH = leadAutomation([
  emailingFlow('Lead welcome', 'Load_Data'),
  emailingFlow('Lead owner email'),
]);
/** The welcome email alone. */
const WELCOME = leadAutomation([emailingFlow('Lead welcome', 'Load_Data')]);

describe('autopilot:execute, the emails of what still runs', () => {
  let handler: AutopilotHandler;
  let deps: HandlerDeps;
  let store: ConfigStore;
  let calls: string[];
  let questions: RunConfirmation[];
  let answer: boolean;
  let dir: string;

  beforeEach(() => {
    mockGetConn.mockReset();
    calls = [];
    questions = [];
    answer = true;
    dir = mkdtempSync(path.join(tmpdir(), 'autopilot-emails-'));
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
            return answer;
          },
        }),
      } as unknown as HandlerDeps['infraServices'],
      nextId: () => String(++n),
    };
    handler = new AutopilotHandler(deps);
    handler.setMuteLeases({ dir, renewEveryMs: 0 });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.mocked(muteForRun).mockClear();
  });

  /**
   * The target, delivering the emails of its automation at `level`: its
   * limits, its permission sets — each write of an assignment in `calls` —
   * and each read of its deliverability in `calls` too.
   */
  function target(
    level: DeliverabilityLevel,
    remaining = 14_000,
    alsoBeforeWrite: (kind: 'insert' | 'delete') => void = () => undefined,
  ) {
    const org = memoryPermissionOrg({
      sets: [{ id: SET, name: 'Data_Load' }],
      beforeWrite: (write) => {
        calls.push(`assignment ${write.kind}`);
        alsoBeforeWrite(write.kind);
      },
    });
    const asked: string[] = [];
    const answering = answeringDeliverability(
      level,
      async () => ({
        DataStorageMB: { Max: 200, Remaining: 150 },
        DailyApiRequests: { Max: 15_000, Remaining: remaining },
        SingleEmail: { Max: 5_000, Remaining: 5_000 },
      }),
      asked,
    );
    mockGetConn.mockResolvedValue({
      ...org.connection,
      request: vi.fn(async (request: string | { url: string }) => {
        const before = asked.length;
        const said = await answering.request(request);
        if (asked.length > before && asked[asked.length - 1] === 'apex') {
          calls.push('deliverability read');
        }
        return said;
      }),
    } as never);
    return { org, asked };
  }

  /** Scan, plan and execute the plan of leads. */
  async function run(automation: ForgeTargetAutomation, payload: Record<string, unknown> = {}) {
    handler.setTargetAutomation({ read: vi.fn(async () => automation) });
    const executePlan = vi.fn(async () => {
      calls.push('written');
      return {
        totalSuccess: 30,
        totalFailure: 0,
        totalSkipped: 0,
        elapsedMs: 10,
        completedObjects: ['Lead'],
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
      'deliverability read': 'deliverabilityRead',
      'question write': 'question',
      'assignment insert': 'leaseAcquire',
      written: 'write',
      'assignment delete': 'leaseRelease',
    };
    return said.flatMap((call) => (steps[call] ? [steps[call]] : []));
  }

  it('reads it once the lease is planned, asks with the emails it delivers, then takes the lease and writes; the audit keeps it', async () => {
    target('all');

    const { executePlan } = await run(BOTH, { muteAutomation: true });

    expect(calls).toEqual([
      'deliverability read',
      'question write',
      'assignment insert',
      'written',
      'assignment delete',
    ]);
    expect(
      writePathOrderDefects(['reads', 'leasePlan', 'stillRunning', ...stepsOf(calls), 'result']),
    ).toEqual([]);
    // What the lease's plan keeps quiet sends nothing it is asked about.
    expect(questions[0]).toMatchObject({
      stage: 'write',
      module: 'autopilot',
      deliverability: {
        reading: { level: 'all' },
        senders: [{ objectApiName: 'Lead', kind: 'flow', name: 'Lead owner email', why: 'email' }],
      },
    });
    expect(executePlan).toHaveBeenCalledTimes(1);
    expect(runs()[0]).toMatchObject({
      outcome: 'success',
      details: expect.objectContaining({ deliverability: 'all', confirmed: 'emails' }),
    });
  });

  it('says the emails reach the addresses the records keep when the run keeps them', async () => {
    target('all');

    await run(BOTH, { keepContactPoints: true });

    expect(questions[0]).toMatchObject({ deliverability: { keepsAddresses: true } });
  });

  it('writes nothing once the question is declined, the audit keeping what the org delivers', async () => {
    answer = false;
    const { org } = target('all');

    const { executePlan } = await run(BOTH);

    expect(executePlan).not.toHaveBeenCalled();
    expect(org.writes).toEqual([]);
    expect(posted('autopilot:error')[0]?.payload).toMatchObject({
      code: 'AUTOPILOT_WRITE_DECLINED',
    });
    expect(runs()[0]).toMatchObject({
      outcome: 'stopped',
      details: { code: 'WRITE_DECLINED', deliverability: 'all' },
    });
  });

  it('reads nothing when the mute keeps quiet the one flow that sends, and asks nothing', async () => {
    const { asked } = target('all');

    const { executePlan } = await run(WELCOME, { muteAutomation: true });

    expect(asked).toEqual([]);
    expect(questions).toEqual([]);
    expect(executePlan).toHaveBeenCalledTimes(1);
    expect(runs()[0]?.details).not.toHaveProperty('deliverability');
  });

  it('asks nothing of an org that withholds them, and says it read them so', async () => {
    const { asked } = target('withheld');

    await run(BOTH);

    expect(asked).toEqual(['apex', 'sendEmail']);
    expect(questions).toEqual([]);
    expect(runs()[0]?.details).toMatchObject({ deliverability: 'withheld' });
  });

  it('counts the read of the deliverability and the reads back of the record types in its requests', async () => {
    // One call of thirty leads, one read back, and the Apex of an org on All
    // email: three, of the two the target has left.
    target('all', 2);

    const { executePlan } = await run(BOTH);

    expect(executePlan).not.toHaveBeenCalled();
    const [error] = posted('autopilot:error');
    expect(error?.payload).toMatchObject({ code: 'API_BUDGET_EXCEEDED' });
    expect(String(error?.payload.message)).toContain(
      '(1 of them to read back the record types the target gave, 1 to read whether the target ' +
        'delivers its emails)',
    );
  });

  it('runs no Apex in a production org, and asks as it does of one that would not say', async () => {
    vi.mocked(deps.orgManager.getOrg).mockReturnValue({
      orgType: 'Production',
      alias: 'PROD',
    } as never);
    const { asked } = target('all');

    await run(BOTH);

    expect(asked).toEqual([]);
    expect(questions[0]).toMatchObject({
      deliverability: { reading: { unread: 'SandForge runs no Apex in a production org' } },
    });
  });

  // The leases' folder turned read only once the lease was journaled: the
  // run failed under no code, and the audit kept it a failure.
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'refuses the run before its first write, under its code, when the journal of its lease cannot be written once the set is assigned',
    async () => {
      let readOnly = false;
      const { org } = target('all', 14_000, (kind) => {
        if (kind === 'insert' && !readOnly) {
          chmodSync(dir, 0o500);
          readOnly = true;
        }
      });

      let executePlan: Awaited<ReturnType<typeof run>>['executePlan'];
      try {
        ({ executePlan } = await run(WELCOME, { muteAutomation: true }));
      } finally {
        if (readOnly) chmodSync(dir, 0o700);
      }

      expect(executePlan).not.toHaveBeenCalled();
      const [error] = posted('autopilot:error');
      expect(error?.payload).toMatchObject({ code: 'MUTE_FAILED' });
      expect(String(error?.payload.message)).toContain('could not be written (EACCES)');
      expect(String(error?.payload.message)).toContain(
        'What this run had assigned was taken back: Data_Load.',
      );
      expect(calls.filter((call) => call.startsWith('assignment'))).toEqual([
        'assignment insert',
        'assignment delete',
      ]);
      expect(org.assignments()).toEqual([]);
      expect(runs()[0]).toMatchObject({
        outcome: 'stopped',
        details: expect.objectContaining({ code: 'MUTE_FAILED' }),
      });
    },
  );

  it('refuses the run before its first write when the lease read back does not hold what it was to keep quiet', async () => {
    const { org } = target('all');
    const actual = await vi.importActual<
      typeof import('../../modules/forge/AutomationMuteLease.js')
    >('../../modules/forge/AutomationMuteLease.js');
    vi.mocked(muteForRun).mockImplementationOnce(async (...args) => {
      const mute = await actual.muteForRun(...args);
      const prepared = mute.prepared;
      if (!prepared) return mute;
      return {
        ...mute,
        prepared: {
          ...prepared,
          acquire: async (runId: string) => {
            const held = await prepared.acquire(runId);
            return { outcome: { ...held.outcome, assigned: [], held: [] }, release: held.release };
          },
        },
      };
    });

    const { executePlan } = await run(WELCOME, { muteAutomation: true });

    expect(executePlan).not.toHaveBeenCalled();
    const [error] = posted('autopilot:error');
    expect(error?.payload).toMatchObject({ code: 'EMAILS_NOT_ACCEPTED' });
    expect(String(error?.payload.message)).toContain(
      'flow "Lead welcome" on Lead may send emails, and whether TGT delivers them was not read',
    );
    expect(String(error?.payload.message)).toContain(
      'Untick Mute automation to be asked about them and run it all the same',
    );
    // The lease is given back before anything is written.
    expect(calls).toEqual(['assignment insert', 'assignment delete']);
    expect(org.assignments()).toEqual([]);
    expect(runs()[0]).toMatchObject({
      outcome: 'stopped',
      details: expect.objectContaining({ code: 'EMAILS_NOT_ACCEPTED' }),
    });
  });
});
