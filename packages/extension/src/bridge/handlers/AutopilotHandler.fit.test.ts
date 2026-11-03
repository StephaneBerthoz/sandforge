import path from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AutopilotHandler } from './AutopilotHandler.js';
import { AUTOPILOT_FIT_CODES } from '../../modules/autopilot/AutopilotRunGate.js';
import type { HandlerDeps } from './HandlerTypes.js';
import type {
  AutopilotFitReport,
  AutopilotPlanWriteGate,
  BaseMessage,
  ExecutionPlan,
  ForgeTargetAutomation,
  RunCheckpointEstimate,
  RunCheckpointTaken,
} from '@sandforge/shared';
import {
  writePathOrderDefects,
  type BeforeRunCheckpoints,
  type WritePathStep,
} from '../../modules/checkpoint/beforeRunCheckpoint.js';
import { ProductionGuard } from '../../core/precheck/ProductionGuard.js';
import { ConfigStore } from '../../core/storage/ConfigStore.js';
import { InMemoryConfigStoreBackend } from '../../test/InMemoryConfigStoreBackend.js';
import { AuditTrailStore } from '../../modules/audit/auditTrail.js';
import { inboundRequest } from '../../test/mockFactories.js';
import { memoryPermissionOrg } from '../../test/memoryPermissionOrg.js';
import { countingConnection, type LargeOrgRow } from '../../test/largeOrg.js';
import { fitConnection, fitOrg } from '../../test/fitOrg.js';
import { AutopilotOrchestrator } from '../../modules/autopilot/AutopilotOrchestrator.js';
import { SchemaScanner } from '../../modules/autopilot/SchemaScanner.js';
import { DependencyGraphBuilder } from '../../modules/autopilot/DependencyGraphBuilder.js';
import { ComplianceEngine } from '../../modules/autopilot/ComplianceEngine.js';
import { SmartAnonymizer } from '../../modules/autopilot/SmartAnonymizer.js';
import { ExecutionPlanGenerator } from '../../modules/autopilot/ExecutionPlanGenerator.js';
import { RecordIdRemapper } from '../../modules/autopilot/RecordIdRemapper.js';
import { AutopilotGrappeAdapter } from '../../modules/autopilot/AutopilotGrappeAdapter.js';
import type { ExecutionResult } from '../../modules/autopilot/AutopilotExecutor.js';

vi.mock('../../core/connection/ConnectionHelper.js', () => ({
  getJsforceConnection: vi.fn(),
}));

import { getJsforceConnection } from '../../core/connection/ConnectionHelper.js';

const mockGetConn = vi.mocked(getJsforceConnection);

/*
 * The panel's Fit to storage, through the real handler and the real fit: the
 * review says what the plan comes to against the target before Run; a fit
 * starts from the plan as it was made, never from a fit of it, and Undo goes
 * back to it; the plan fitted is what runs, and meets the gate again; a read
 * the source refuses is said; the audit trail keeps the fit. Nothing is
 * written, assigned or taken while the plan is fitted.
 */

const SET = '0PSxx0000000001AAA';
const id = (prefix: string, n: number): string => `${prefix}${String(n).padStart(12, '0')}AAA`;
const account = (n: number): string => id('001', n);
const contact = (n: number): string => id('003', n);

/** Four accounts, a hierarchy of three among them, and a contact of each of two. */
function rows(): Record<string, LargeOrgRow[]> {
  return {
    Account: [
      { Id: account(1), Name: 'One', ParentId: null },
      { Id: account(2), Name: 'Two', ParentId: account(1), Primary_Contact__c: contact(1) },
      { Id: account(3), Name: 'Three', ParentId: account(1) },
      { Id: account(4), Name: 'Four' },
    ],
    Contact: [
      { Id: contact(1), Name: 'Of One', AccountId: account(1) },
      { Id: contact(2), Name: 'Of Two', AccountId: account(2) },
    ],
  };
}

/** What the target runs on the contacts: a flow creating a task under each, its bypass held by `Data_Load`. */
const CONTACT_FLOW: ForgeTargetAutomation = {
  objectsRead: ['Account', 'Contact'],
  objects: [
    {
      objectApiName: 'Contact',
      flows: [
        {
          apiName: 'Contact_Follow_Up',
          label: 'Contact follow-up',
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
  estimate: { records: 6, apiRequests: 5, apiRequestsLeft: 14_000, seconds: 2, bytes: 20_000 },
  objects: ['Account', 'Contact'],
  added: [],
  notHeld: [],
  keepDays: 7,
};

const TAKEN: RunCheckpointTaken = {
  state: 'taken',
  checkpointId: 'ck-before-fit-1',
  name: 'Before Autopilot run 2026-11-01 10:00 UTC',
  takenAt: '2026-11-01T10:00:00.000Z',
  expiresAt: '2026-11-08T10:00:00.000Z',
  objects: ['Account', 'Contact'],
  records: 6,
  bytes: 20_000,
  requests: 5,
  added: [],
  notHeld: [],
};

/** What the target runs on the objects of the plan: nothing. */
const NO_FLOWS: ForgeTargetAutomation = { ...CONTACT_FLOW, objects: [], bypassGrants: [] };

/** What the target's `/limits` say of its data storage, as each test sets it. */
interface Room {
  maxMB: number;
  remainingMB: number;
}

describe('autopilot:fit-plan, the panel fitting a plan to its target', () => {
  let handler: AutopilotHandler;
  let deps: HandlerDeps;
  let store: ConfigStore;
  let calls: string[];
  let dir: string;
  let orchestrator: AutopilotOrchestrator;
  let refuseSourceReads: boolean;

  beforeEach(() => {
    mockGetConn.mockReset();
    calls = [];
    refuseSourceReads = false;
    dir = mkdtempSync(path.join(tmpdir(), 'autopilot-fit-'));
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
            return true;
          },
        }),
      } as unknown as HandlerDeps['infraServices'],
      nextId: () => String(++n),
    };
    handler = new AutopilotHandler(deps);
    handler.setMuteLeases({ dir, renewEveryMs: 0 });
    handler.setTargetAutomation({ read: vi.fn(async () => NO_FLOWS) });
    orchestrator = new AutopilotOrchestrator({
      schemaScanner: new SchemaScanner(),
      graphBuilder: new DependencyGraphBuilder(),
      complianceEngine: new ComplianceEngine(),
      anonymizer: new SmartAnonymizer(),
      planGenerator: new ExecutionPlanGenerator(),
      remapper: new RecordIdRemapper(),
      createExecutor: () => {
        throw new Error('the test runs no executor');
      },
      grappeAdapter: new AutopilotGrappeAdapter(),
    });
    handler.setOrchestrator(orchestrator);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /**
   * The source holding `source`, its reads in `calls`; a target of the same
   * objects, holding none of their records, its permission sets, each write
   * of an assignment in `calls`, and its `/limits`.
   */
  function orgs(room: Room = { maxMB: 200, remainingMB: 150 }, source = rows()) {
    const reading = fitConnection(fitOrg(source));
    const sourceConn = {
      ...reading.conn,
      query: async (soql: string) => {
        if (refuseSourceReads) {
          throw Object.assign(new Error('REQUEST_LIMIT_EXCEEDED: TotalRequests Limit exceeded.'), {
            errorCode: 'REQUEST_LIMIT_EXCEEDED',
          });
        }
        calls.push('source read');
        return reading.conn.query(soql);
      },
    };
    const target = countingConnection(fitOrg({}));
    const permissions = memoryPermissionOrg({
      sets: [{ id: SET, name: 'Data_Load' }],
      beforeWrite: (write) => {
        calls.push(`assignment ${write.kind}`);
      },
    });
    const PERMISSION_READS =
      /FROM (Organization|UserPermissionAccess|PermissionSetAssignment|SetupEntityAccess|ObjectPermissions|CustomPermission|PermissionSet)\b/i;
    const targetConn = {
      ...target.conn,
      identity: permissions.connection.identity,
      query: async (soql: string) =>
        PERMISSION_READS.test(soql) ? permissions.connection.query(soql) : target.conn.query(soql),
      sobject: (name: string) =>
        name === 'PermissionSetAssignment'
          ? permissions.connection.sobject(name)
          : target.conn.sobject(name),
      request: vi.fn(async () => {
        const { maxMB, remainingMB } = room;
        calls.push('limits');
        return {
          DataStorageMB: { Max: maxMB, Remaining: remainingMB },
          DailyApiRequests: { Max: 15_000, Remaining: 14_000 },
        };
      }),
    };
    mockGetConn.mockImplementation(
      async (orgId: string) => (orgId === 'src' ? sourceConn : targetConn) as never,
    );
    return { permissions, targetConn };
  }

  /** The run's executor: what it was handed, each run a write in `calls`. */
  function executor(result: Partial<ExecutionResult> = {}) {
    return vi.spyOn(orchestrator, 'executePlan').mockImplementation(async () => {
      calls.push('written');
      return {
        totalSuccess: 3,
        totalFailure: 0,
        totalSkipped: 0,
        elapsedMs: 10,
        completedObjects: ['Account', 'Contact'],
        failedObjects: [],
        skippedObjects: [],
        ...result,
      };
    });
  }

  function checkpointsAnswering(): BeforeRunCheckpoints {
    const port = {
      scope: vi.fn(async () => {
        calls.push('checkpointScope');
        return ESTIMATE;
      }),
      take: vi.fn(async () => {
        calls.push('checkpointTake');
        return { taken: true as const, checkpoint: TAKEN };
      }),
      settle: vi.fn(async (taken: RunCheckpointTaken) => taken),
    } satisfies BeforeRunCheckpoints;
    handler.setBeforeRunCheckpoints(port);
    return port;
  }

  const send = (msgId: string, type: string, body?: Record<string, unknown>) =>
    handler.handle(
      inboundRequest({
        id: msgId,
        type,
        timestamp: Date.now(),
        ...(body ? { payload: body } : {}),
      } as BaseMessage),
    );

  /** The scan and the plan of the accounts and contacts. */
  async function planned(): Promise<void> {
    await send('scan-1', 'autopilot:scan-schema', {
      sourceOrgId: 'src',
      targetOrgId: 'tgt',
      selectedObjects: ['Account', 'Contact'],
      includeStandardObjects: true,
    });
    await send('plan-1', 'autopilot:generate-plan', { complianceFramework: 'none' });
  }

  function posted(type: string): Array<BaseMessage & { payload: Record<string, unknown> }> {
    return vi
      .mocked(deps.broker.postToWebview)
      .mock.calls.map(([m]) => m as BaseMessage & { payload: Record<string, unknown> })
      .filter((m) => m.type === type);
  }

  /** The plan-ready answering a request. */
  function planReadyOf(correlationId: string) {
    const ready = posted('autopilot:plan-ready').find((m) => m.correlationId === correlationId);
    return ready?.payload as
      | {
          plan: ExecutionPlan;
          writeGate?: AutopilotPlanWriteGate;
          fitNotApplied?: AutopilotFitReport;
        }
      | undefined;
  }

  function errorOf(correlationId: string) {
    return posted('autopilot:error').find((m) => m.correlationId === correlationId)?.payload;
  }

  const runs = () =>
    new AuditTrailStore(store).list().entries.filter((e) => e.action === 'autopilot_execute');

  it('says before Run what the plan comes to against the target, from one read of its limits', async () => {
    orgs({ maxMB: 5, remainingMB: 0 });

    await planned();

    const ready = planReadyOf('plan-1');
    expect(ready?.plan.totalRecords).toBe(6);
    expect(ready?.writeGate).toMatchObject({
      records: 6,
      remainingMB: 0,
      maxMB: 5,
      verdict: 'exceeds',
      apiRequests: { remaining: 14_000, max: 15_000, verdict: 'fits' },
    });
    expect(calls.filter((call) => call === 'limits')).toHaveLength(1);
  });

  it('fits from the plan as it was made, keeping a contact with its account, and says what it kept', async () => {
    orgs();
    await planned();

    await send('fit-1', 'autopilot:fit-plan', { mode: { share: true, withinMB: 0.006 } });

    const fitted = planReadyOf('fit-1');
    const report = fitted?.plan.scope?.fitted;
    expect(fitted?.plan.totalRecords).toBe(3);
    expect(report).toMatchObject({
      heldBy: 'within',
      share: 0.5,
      records: 3,
      objects: [
        { objectApiName: 'Account', inSource: 4, kept: 2, cutSpread: 2, cutWithParent: [] },
        {
          objectApiName: 'Contact',
          inSource: 2,
          kept: 1,
          cutSpread: 0,
          cutWithParent: [{ field: 'AccountId', parent: 'Account', count: 1 }],
        },
      ],
    });
    expect(report?.emptied).toEqual(
      expect.arrayContaining([
        { objectApiName: 'Account', field: 'ParentId', count: 1, why: 'selfReference' },
      ]),
    );
    expect(fitted?.writeGate).toMatchObject({ records: 3, verdict: 'fits' });

    // A second fit starts from the six records planned, not from the three
    // the first kept: a share of all of them again.
    await send('fit-2', 'autopilot:fit-plan', { mode: { share: true, withinMB: 0.1 } });

    const again = planReadyOf('fit-2');
    expect(again?.plan.scope?.fitted).toBeUndefined();
    expect(again?.fitNotApplied).toMatchObject({ heldBy: 'whole', records: 6 });
    expect(again?.plan.totalRecords).toBe(6);
  });

  it('goes back to the plan it fitted from on Undo, and runs that one', async () => {
    orgs();
    const execute = executor();
    await planned();
    await send('fit-1', 'autopilot:fit-plan', { mode: { share: true, withinMB: 0.006 } });

    await send('undo-1', 'autopilot:fit-undo');

    const undone = planReadyOf('undo-1');
    expect(undone?.plan.totalRecords).toBe(6);
    expect(undone?.plan.scope?.fitted).toBeUndefined();

    await send('exec-1', 'autopilot:execute', { grappeThreshold: 0 });

    const [plan, , , counts, , , , options] = execute.mock.calls[0] ?? [];
    expect(plan?.totalRecords).toBe(6);
    expect(counts?.get('Account')).toBe(4);
    expect(options).not.toHaveProperty('fit');
    expect(runs()[0]).not.toHaveProperty('fit');
  });

  it('runs the plan fitted, by the ids kept, held to them as it reads, and keeps the fit in the audit trail', async () => {
    orgs();
    const execute = executor({ cutSinceFit: 1 });
    await planned();
    await send('fit-1', 'autopilot:fit-plan', { mode: { share: true, withinMB: 0.006 } });

    await send('exec-1', 'autopilot:execute', { grappeThreshold: 0 });

    const [plan, , , counts, , , parentIds, options] = execute.mock.calls[0] ?? [];
    expect(plan?.totalRecords).toBe(3);
    expect(Object.fromEntries(counts ?? [])).toEqual({ Account: 2, Contact: 1 });
    expect(parentIds?.get('Account')).toEqual([account(2), account(4)]);
    expect(parentIds?.get('Contact')).toEqual([contact(2)]);
    expect(options?.fit?.holds).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          objectApiName: 'Contact',
          field: 'AccountId',
          parent: 'Account',
        }),
      ]),
    );
    expect(posted('autopilot:completed')[0]?.payload).toMatchObject({ cutSinceFit: 1 });
    expect(runs()[0]).toMatchObject({
      outcome: 'success',
      fit: { module: 'autopilot', share: 0.5, withinMB: 0.006, kept: 3, inSource: 6 },
    });
  });

  it('holds the plan fitted to the gate again, the limits read again, and refuses it with its figures once the room is gone', async () => {
    // Room as the plan and its fit are made; none once Run is pressed.
    const room = { maxMB: 200, remainingMB: 150 };
    orgs(room);
    const execute = executor();
    await planned();
    await send('fit-1', 'autopilot:fit-plan', { mode: { share: true, withinMB: 0.006 } });
    const before = calls.filter((call) => call === 'limits').length;
    Object.assign(room, { maxMB: 5, remainingMB: 0 });

    await send('exec-1', 'autopilot:execute', { grappeThreshold: 0 });

    expect(calls.filter((call) => call === 'limits').length).toBeGreaterThan(before);
    expect(execute).not.toHaveBeenCalled();
    const refusal = errorOf('exec-1');
    expect(refusal).toMatchObject({
      code: 'AUTOPILOT_STORAGE_EXCEEDED',
      org: 'TGT',
      remainingMB: 0,
      maxMB: 5,
      writeGate: { records: 3, verdict: 'exceeds', remainingMB: 0, maxMB: 5 },
    });
    expect(runs()[0]).toMatchObject({
      outcome: 'stopped',
      fit: { module: 'autopilot', kept: 3, inSource: 6 },
    });
  });

  it('says a read the source refuses, and leaves the plan under review as it was', async () => {
    orgs();
    const execute = executor();
    await planned();
    refuseSourceReads = true;

    await send('fit-1', 'autopilot:fit-plan', { mode: { share: true } });

    expect(planReadyOf('fit-1')).toBeUndefined();
    expect(errorOf('fit-1')).toMatchObject({
      code: AUTOPILOT_FIT_CODES.READ_REFUSED,
      reason: expect.stringContaining('REQUEST_LIMIT_EXCEEDED'),
    });

    refuseSourceReads = false;
    await send('exec-1', 'autopilot:execute', { grappeThreshold: 0 });
    expect(execute.mock.calls[0]?.[0].totalRecords).toBe(6);
  });

  it('refuses to fit to a target that would not say what storage it has left', async () => {
    const { targetConn } = orgs();
    await planned();
    const planning = calls.length;
    targetConn.request.mockRejectedValue(new Error('INVALID_SESSION_ID'));

    await send('fit-1', 'autopilot:fit-plan', { mode: { share: true } });

    expect(errorOf('fit-1')).toMatchObject({
      code: AUTOPILOT_FIT_CODES.STORAGE_UNREAD,
      reason: expect.stringContaining('INVALID_SESSION_ID'),
    });
    // Nothing is chosen from a budget that could not be read: no record read.
    expect(calls.slice(planning)).not.toContain('source read');
  });

  it('refuses to fit while a run writes to the target', async () => {
    orgs();
    await planned();
    let release: () => void = () => {};
    vi.spyOn(orchestrator, 'executePlan').mockImplementation(
      () =>
        new Promise<ExecutionResult>((resolve) => {
          release = () =>
            resolve({
              totalSuccess: 0,
              totalFailure: 0,
              totalSkipped: 0,
              elapsedMs: 1,
              completedObjects: [],
              failedObjects: [],
              skippedObjects: [],
            });
        }),
    );
    const running = send('exec-1', 'autopilot:execute', { grappeThreshold: 0 });
    await vi.waitFor(() => expect(orchestrator.executePlan).toHaveBeenCalled());

    await send('fit-1', 'autopilot:fit-plan', { mode: { share: true } });

    expect(errorOf('fit-1')).toMatchObject({ code: 'AUTOPILOT_RUNNING' });
    release();
    await running;
  });

  it('fits without a write, an assignment or a take, and the run that follows keeps the order of the write path', async () => {
    handler.setTargetAutomation({ read: vi.fn(async () => CONTACT_FLOW) });
    const port = checkpointsAnswering();
    const { permissions } = orgs();
    executor();
    await planned();
    const planning = calls.length;

    await send('fit-1', 'autopilot:fit-plan', {
      mode: { share: true, withinMB: 0.006 },
      muteAutomation: true,
      checkpointFirst: {},
    });

    const fitting = calls.slice(planning);
    expect(fitting).not.toContain('written');
    expect(fitting.some((call) => call.startsWith('assignment'))).toBe(false);
    expect(fitting).not.toContain('checkpointTake');
    expect(permissions.writes).toEqual([]);
    expect(port.take).not.toHaveBeenCalled();
    // The rows of each selected object, then the parents of those kept: what
    // the report counts, and nothing it does not.
    const report = planReadyOf('fit-1')?.plan.scope?.fitted;
    expect(fitting.filter((call) => call === 'source read')).toHaveLength(
      report?.requestsRead ?? -1,
    );
    // The mute keeps the contact flow quiet: no room kept for its tasks.
    expect(report?.budget.automationMB).toBe(0);
    expect(report?.countedMuted).toBe(true);
    expect(report).not.toHaveProperty('automationUnread');

    await send('exec-1', 'autopilot:execute', {
      grappeThreshold: 0,
      muteAutomation: true,
      checkpointFirst: {},
    });

    const steps: Record<string, WritePathStep> = {
      'source read': 'reads',
      'question write': 'question',
      checkpointTake: 'checkpointTake',
      'assignment insert': 'leaseAcquire',
      written: 'write',
      'assignment delete': 'leaseRelease',
    };
    const said = calls.slice(planning).flatMap((call) => (steps[call] ? [steps[call]] : []));
    const reads = said.lastIndexOf('reads') + 1;
    expect(
      writePathOrderDefects([
        ...said.slice(0, reads),
        'leasePlan',
        'stillRunning',
        ...said.slice(reads),
        'result',
      ]),
    ).toEqual([]);
    expect(said.slice(reads)).toEqual([
      'question',
      'checkpointTake',
      'leaseAcquire',
      'write',
      'leaseRelease',
    ]);
  });

  it('keeps room for the tasks the contact flow creates when the run does not mute it', async () => {
    handler.setTargetAutomation({ read: vi.fn(async () => CONTACT_FLOW) });
    orgs();
    await planned();

    await send('fit-1', 'autopilot:fit-plan', { mode: { share: true, withinMB: 0.01 } });

    // Three accounts and the contact of one: 8 KB, and 2 KB for its task.
    const report = planReadyOf('fit-1')?.plan.scope?.fitted;
    expect(report?.records).toBe(4);
    expect(report?.budget.automationMB).toBeCloseTo(2 / 1024, 6);
  });

  it('says the automation could not be read, and keeps no room it cannot count', async () => {
    orgs();
    handler.setTargetAutomation({
      read: vi.fn(async () => Promise.reject(new Error('timed out'))),
    });
    await planned();

    await send('fit-1', 'autopilot:fit-plan', { mode: { share: true, withinMB: 0.006 } });

    expect(planReadyOf('fit-1')?.plan.scope?.fitted).toMatchObject({
      automationUnread: 'timed out',
    });
  });

  it('says in figures why nothing fits, and keeps the plan under review', async () => {
    orgs({ maxMB: 5, remainingMB: 0 });
    await planned();

    await send('fit-1', 'autopilot:fit-plan', { mode: { share: true } });

    const answer = planReadyOf('fit-1');
    expect(answer?.plan.totalRecords).toBe(6);
    expect(answer?.fitNotApplied?.cannotFit).toMatchObject({
      why: 'least',
      over: { bound: 'storage', fitsMB: 0 },
    });
  });

  it('keeps the fit when another framework is picked: the same records, planned again', async () => {
    orgs();
    await planned();
    await send('fit-1', 'autopilot:fit-plan', { mode: { share: true, withinMB: 0.006 } });

    await send('plan-2', 'autopilot:generate-plan', { complianceFramework: 'gdpr' });

    const replanned = planReadyOf('plan-2');
    expect(replanned?.plan.totalRecords).toBe(3);
    expect(replanned?.plan.complianceFramework).toBe('gdpr');
    expect(replanned?.plan.scope?.fitted?.records).toBe(3);
  });
});
