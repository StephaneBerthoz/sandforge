import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { AutopilotHandler } from './AutopilotHandler.js';
import type { HandlerDeps } from './HandlerTypes.js';
import type { BaseMessage } from '@sandforge/shared';

vi.mock('../../core/connection/ConnectionHelper.js', () => ({
  getJsforceConnection: vi.fn(),
}));

import { getJsforceConnection } from '../../core/connection/ConnectionHelper.js';

const mockGetConn = vi.mocked(getJsforceConnection);

/**
 * Creates minimal mock deps for AutopilotHandler tests.
 */
function createMockDeps(): HandlerDeps {
  let idCounter = 0;
  return {
    log: vi.fn(),
    broker: { postToWebview: vi.fn() } as unknown as HandlerDeps['broker'],
    stateSync: {} as HandlerDeps['stateSync'],
    orgManager: { getOrg: vi.fn() } as unknown as HandlerDeps['orgManager'],
    orgRegistry: {} as unknown as HandlerDeps['orgRegistry'],
    configStore: {
      get: vi.fn(),
      set: vi.fn(),
    } as unknown as HandlerDeps['configStore'],
    secretVault: {} as unknown as HandlerDeps['secretVault'],
    authProvider: {} as unknown as HandlerDeps['authProvider'],
    sfdxBridge: {} as unknown as HandlerDeps['sfdxBridge'],
    nextId: () => String(++idCounter),
  };
}

/**
 * Creates a mock AutopilotOrchestrator with configurable behavior.
 */
function createMockOrchestrator(
  overrides: Record<string, unknown> = {},
): Parameters<AutopilotHandler['setOrchestrator']>[0] {
  return {
    scanSchemas: vi.fn().mockResolvedValue({ recordCounts: new Map(), totalObjectsScanned: 5 }),
    buildGraph: vi.fn().mockReturnValue({ nodes: [], edges: [] }),
    buildCompliance: vi.fn().mockReturnValue({ profile: {}, rules: [] }),
    generatePlan: vi.fn().mockReturnValue({ steps: [] }),
    executePlan: vi
      .fn()
      .mockResolvedValue({ totalSuccess: 10, totalFailure: 0, totalSkipped: 0, elapsedMs: 100 }),
    generateReport: vi.fn().mockReturnValue({ score: 100, issues: [] }),
    pause: vi.fn(),
    resume: vi.fn(),
    skip: vi.fn(),
    ...overrides,
  } as unknown as Parameters<AutopilotHandler['setOrchestrator']>[0];
}

/** Creates a manually-resolved promise for in-flight concurrency tests. */
function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (err: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Builds a valid autopilot:scan-schema request message. */
function scanMsg(id: string): BaseMessage {
  return {
    id,
    type: 'autopilot:scan-schema',
    timestamp: Date.now(),
    payload: {
      sourceOrgId: 'src',
      targetOrgId: 'tgt',
      selectedObjects: [],
      includeStandardObjects: false,
    },
  } as BaseMessage;
}

/** Extracts all messages posted to the webview. */
function postedMessages(deps: HandlerDeps): Array<BaseMessage & { correlationId?: string }> {
  const postToWebview = deps.broker.postToWebview as Mock<[BaseMessage], void>;
  return postToWebview.mock.calls.map((call) => call[0]);
}

describe('AutopilotHandler', () => {
  let handler: AutopilotHandler;
  let deps: HandlerDeps;

  beforeEach(() => {
    vi.clearAllMocks();
    deps = createMockDeps();
    handler = new AutopilotHandler(deps);
  });

  it('returns false for unhandled message types', async () => {
    const msg: BaseMessage = { id: '1', type: 'unknown:type', timestamp: Date.now() };
    const result = await handler.handle(msg);
    expect(result).toBe(false);
  });

  it('handles autopilot:scan-schema and response includes correlationId', async () => {
    const orchestrator = createMockOrchestrator();
    handler.setOrchestrator(orchestrator);

    mockGetConn.mockResolvedValue({} as never);

    const msg: BaseMessage & {
      payload: {
        sourceOrgId: string;
        targetOrgId: string;
        selectedObjects: string[];
        includeStandardObjects: boolean;
      };
    } = {
      id: 'req-ap-1',
      type: 'autopilot:scan-schema',
      timestamp: Date.now(),
      payload: {
        sourceOrgId: 'src',
        targetOrgId: 'tgt',
        selectedObjects: [],
        includeStandardObjects: false,
      },
    };

    const result = await handler.handle(msg);
    expect(result).toBe(true);

    const postToWebview = deps.broker.postToWebview as ReturnType<typeof vi.fn>;
    expect(postToWebview).toHaveBeenCalledTimes(1);

    const response = postToWebview.mock.calls[0][0] as BaseMessage & { correlationId?: string };
    expect(response.type).toBe('autopilot:schema-result');
    expect(response.correlationId).toBe('req-ap-1');
  });

  it('handles autopilot:generate-plan and response includes correlationId', async () => {
    const orchestrator = createMockOrchestrator();
    handler.setOrchestrator(orchestrator);

    // Must scan schema first to populate graph
    mockGetConn.mockResolvedValue({} as never);
    await handler.handle(scanMsg('scan-1'));

    // Now generate plan
    const msg: BaseMessage & { payload: { complianceFramework: string } } = {
      id: 'req-ap-2',
      type: 'autopilot:generate-plan',
      timestamp: Date.now(),
      payload: { complianceFramework: 'gdpr' },
    };

    await handler.handle(msg);

    const postToWebview = deps.broker.postToWebview as ReturnType<typeof vi.fn>;
    // First call was schema-result, second is plan-ready
    const planResponse = postToWebview.mock.calls[1][0] as BaseMessage & { correlationId?: string };
    expect(planResponse.type).toBe('autopilot:plan-ready');
    expect(planResponse.correlationId).toBe('req-ap-2');
  });

  it('error path sends BOTH notification AND typed error response', async () => {
    const orchestrator = createMockOrchestrator({
      scanSchemas: vi.fn().mockRejectedValue(new Error('Schema scan exploded')),
    });
    handler.setOrchestrator(orchestrator);

    mockGetConn.mockResolvedValue({} as never);

    const msg: BaseMessage & {
      payload: {
        sourceOrgId: string;
        targetOrgId: string;
        selectedObjects: string[];
        includeStandardObjects: boolean;
      };
    } = {
      id: 'req-ap-err',
      type: 'autopilot:scan-schema',
      timestamp: Date.now(),
      payload: {
        sourceOrgId: 'src',
        targetOrgId: 'tgt',
        selectedObjects: [],
        includeStandardObjects: false,
      },
    };

    await handler.handle(msg);

    const postToWebview = deps.broker.postToWebview as ReturnType<typeof vi.fn>;
    // Should have 2 postToWebview calls: typed error response + notification
    expect(postToWebview).toHaveBeenCalledTimes(2);

    // First call: typed error response from sendHandlerError
    const errorResponse = postToWebview.mock.calls[0][0] as BaseMessage & {
      payload: { message: string };
    };
    expect(errorResponse.type).toBe('autopilot:error');
    expect(errorResponse.payload.message).toBe('Schema scan exploded');

    // Second call: notification
    const notification = postToWebview.mock.calls[1][0] as BaseMessage & {
      payload: { title: string };
    };
    expect(notification.type).toBe('notification');
  });

  it('not-initialized error sends notification for scan-schema', async () => {
    // No orchestrator injected
    const msg: BaseMessage & {
      payload: {
        sourceOrgId: string;
        targetOrgId: string;
        selectedObjects: string[];
        includeStandardObjects: boolean;
      };
    } = {
      id: 'req-ap-noinit',
      type: 'autopilot:scan-schema',
      timestamp: Date.now(),
      payload: {
        sourceOrgId: 'src',
        targetOrgId: 'tgt',
        selectedObjects: [],
        includeStandardObjects: false,
      },
    };

    await handler.handle(msg);

    const postToWebview = deps.broker.postToWebview as ReturnType<typeof vi.fn>;
    expect(postToWebview).toHaveBeenCalledTimes(1);

    const notification = postToWebview.mock.calls[0][0] as BaseMessage & {
      payload: { message: string };
    };
    expect(notification.type).toBe('notification');
  });

  it('sends node-progress messages during execution', async () => {
    const orchestrator = createMockOrchestrator({
      executePlan: vi.fn().mockResolvedValue({
        totalSuccess: 10,
        totalFailure: 1,
        totalSkipped: 0,
        elapsedMs: 500,
        completedObjects: ['Account'],
        failedObjects: ['Contact'],
        skippedObjects: [],
      }),
      generatePlan: vi.fn().mockReturnValue({
        waves: [
          { order: 0, objects: ['Account'], dependsOn: [] },
          { order: 1, objects: ['Contact'], dependsOn: [0] },
        ],
        totalRecords: 100,
        estimatedDurationSec: 10,
        estimatedApiCalls: 20,
        complianceFramework: 'none',
        anonymizationSummary: { totalRules: 0, rulesByType: {} },
        cycleResolutions: [],
      }),
    });
    handler.setOrchestrator(orchestrator);

    // Setup: scan-schema -> generate-plan -> execute
    mockGetConn.mockResolvedValue({} as never);
    await handler.handle(scanMsg('scan-exec'));

    await handler.handle({
      id: 'plan-exec',
      type: 'autopilot:generate-plan',
      timestamp: Date.now(),
      payload: { complianceFramework: 'gdpr' },
    } as BaseMessage);

    const postToWebview = deps.broker.postToWebview as Mock<[BaseMessage], void>;
    postToWebview.mockClear();

    // Execute
    const executeMsg: BaseMessage & { payload: { grappeThreshold: number } } = {
      id: 'req-ap-exec',
      type: 'autopilot:execute',
      timestamp: Date.now(),
      payload: { grappeThreshold: 0 },
    };

    await handler.handle(executeMsg);

    // Expect: 2 processing + 2 completed/failed + 1 autopilot:completed = 5 calls
    const allCalls = postToWebview.mock.calls.map(
      (call) =>
        call[0] as BaseMessage & {
          correlationId?: string;
          payload: { status?: string; objectName?: string };
        },
    );

    // Filter node-progress messages
    const nodeProgressMsgs = allCalls.filter((m) => m.type === 'autopilot:node-progress');
    expect(nodeProgressMsgs.length).toBe(4);

    // First two should be 'processing' (one per node)
    const processingMsgs = nodeProgressMsgs.filter((m) => m.payload.status === 'processing');
    expect(processingMsgs.length).toBe(2);

    // One completed (Account) and one failed (Contact)
    const completedMsgs = nodeProgressMsgs.filter((m) => m.payload.status === 'completed');
    expect(completedMsgs.length).toBe(1);
    expect(completedMsgs[0].payload.objectName).toBe('Account');

    const failedMsgs = nodeProgressMsgs.filter((m) => m.payload.status === 'failed');
    expect(failedMsgs.length).toBe(1);
    expect(failedMsgs[0].payload.objectName).toBe('Contact');

    // All node-progress messages should have correlationId
    for (const npm of nodeProgressMsgs) {
      expect(npm.correlationId).toBe('req-ap-exec');
    }

    // Final autopilot:completed message
    const completedResponse = allCalls.find((m) => m.type === 'autopilot:completed');
    expect(completedResponse).toBeDefined();
    expect(completedResponse?.correlationId).toBe('req-ap-exec');
  });

  describe('payload validation', () => {
    it('rejects autopilot:scan-schema with INVALID_PAYLOAD on malformed payload', async () => {
      const orchestrator = createMockOrchestrator();
      handler.setOrchestrator(orchestrator);

      const msg = {
        id: 'req-bad-scan',
        type: 'autopilot:scan-schema',
        timestamp: Date.now(),
        payload: {
          sourceOrgId: 'src',
          targetOrgId: 'tgt',
          selectedObjects: 'Account',
          includeStandardObjects: false,
        },
      } as unknown as BaseMessage;

      const result = await handler.handle(msg);
      expect(result).toBe(true);

      const postToWebview = deps.broker.postToWebview as ReturnType<typeof vi.fn>;
      expect(postToWebview).toHaveBeenCalledTimes(1);
      const errMsg = postToWebview.mock.calls[0][0] as BaseMessage & {
        payload: { code: string };
      };
      expect(errMsg.type).toBe('autopilot:error');
      expect(errMsg.payload.code).toBe('INVALID_PAYLOAD');
      expect(mockGetConn).not.toHaveBeenCalled();
      expect(orchestrator.scanSchemas).not.toHaveBeenCalled();
    });

    it('rejects autopilot:generate-plan with INVALID_PAYLOAD on unknown framework', async () => {
      const orchestrator = createMockOrchestrator();
      handler.setOrchestrator(orchestrator);
      mockGetConn.mockResolvedValue({} as never);
      await handler.handle(scanMsg('scan-val'));

      const postToWebview = deps.broker.postToWebview as ReturnType<typeof vi.fn>;
      postToWebview.mockClear();

      await handler.handle({
        id: 'req-bad-plan',
        type: 'autopilot:generate-plan',
        timestamp: Date.now(),
        payload: { complianceFramework: 'sox' },
      } as BaseMessage);

      expect(postToWebview).toHaveBeenCalledTimes(1);
      const errMsg = postToWebview.mock.calls[0][0] as BaseMessage & {
        payload: { code: string };
      };
      expect(errMsg.type).toBe('autopilot:error');
      expect(errMsg.payload.code).toBe('INVALID_PAYLOAD');
      expect(orchestrator.buildCompliance).not.toHaveBeenCalled();
    });

    it('rejects autopilot:execute with INVALID_PAYLOAD on negative threshold', async () => {
      const orchestrator = createMockOrchestrator();
      handler.setOrchestrator(orchestrator);
      mockGetConn.mockResolvedValue({} as never);
      await handler.handle(scanMsg('scan-val-exec'));
      await handler.handle({
        id: 'plan-val-exec',
        type: 'autopilot:generate-plan',
        timestamp: Date.now(),
        payload: { complianceFramework: 'gdpr' },
      } as BaseMessage);

      const postToWebview = deps.broker.postToWebview as ReturnType<typeof vi.fn>;
      postToWebview.mockClear();

      await handler.handle({
        id: 'req-bad-exec',
        type: 'autopilot:execute',
        timestamp: Date.now(),
        payload: { grappeThreshold: -1 },
      } as BaseMessage);

      expect(postToWebview).toHaveBeenCalledTimes(1);
      const errMsg = postToWebview.mock.calls[0][0] as BaseMessage & {
        payload: { code: string };
      };
      expect(errMsg.type).toBe('autopilot:error');
      expect(errMsg.payload.code).toBe('INVALID_PAYLOAD');
      expect(orchestrator.executePlan).not.toHaveBeenCalled();
    });

    it('rejects autopilot:skip-node with INVALID_PAYLOAD on missing object name', async () => {
      const orchestrator = createMockOrchestrator();
      handler.setOrchestrator(orchestrator);

      await handler.handle({
        id: 'req-bad-skip',
        type: 'autopilot:skip-node',
        timestamp: Date.now(),
        payload: {},
      } as BaseMessage);

      const postToWebview = deps.broker.postToWebview as ReturnType<typeof vi.fn>;
      expect(postToWebview).toHaveBeenCalledTimes(1);
      const errMsg = postToWebview.mock.calls[0][0] as BaseMessage & {
        payload: { code: string };
      };
      expect(errMsg.type).toBe('autopilot:error');
      expect(errMsg.payload.code).toBe('INVALID_PAYLOAD');
      expect(orchestrator.skip).not.toHaveBeenCalled();
    });
  });

  describe('concurrency', () => {
    it('keeps concurrent scans isolated: each response carries its own graph', async () => {
      const scanA = { recordCounts: new Map([['Account', 5]]), totalObjectsScanned: 1 };
      const scanB = { recordCounts: new Map([['Contact', 99]]), totalObjectsScanned: 1 };
      const graphA = { nodes: ['graph-A'], edges: [] };
      const graphB = { nodes: ['graph-B'], edges: [] };
      const dA = deferred<typeof scanA>();
      const dB = deferred<typeof scanB>();

      const orchestrator = createMockOrchestrator({
        scanSchemas: vi
          .fn()
          .mockImplementationOnce(() => dA.promise)
          .mockImplementationOnce(() => dB.promise),
        buildGraph: vi.fn().mockImplementation((sr: unknown) => (sr === scanA ? graphA : graphB)),
      });
      handler.setOrchestrator(orchestrator);
      mockGetConn.mockResolvedValue({} as never);

      const pA = handler.handle(scanMsg('scan-A'));
      const pB = handler.handle(scanMsg('scan-B'));

      // B finishes first; A must still deliver its own graph afterwards.
      dB.resolve(scanB);
      dA.resolve(scanA);
      await Promise.all([pA, pB]);

      const messages = postedMessages(deps);
      const responseA = messages.find((m) => m.correlationId === 'scan-A') as
        | (BaseMessage & { payload: { graph: unknown } })
        | undefined;
      const responseB = messages.find((m) => m.correlationId === 'scan-B') as
        | (BaseMessage & { payload: { graph: unknown } })
        | undefined;
      expect(responseA?.type).toBe('autopilot:schema-result');
      expect(responseB?.type).toBe('autopilot:schema-result');
      expect(responseA?.payload.graph).toBe(graphA);
      expect(responseB?.payload.graph).toBe(graphB);
    });

    it('does not let a concurrent scan clobber an in-flight execution', async () => {
      const scan1 = { recordCounts: new Map([['Account', 5]]), totalObjectsScanned: 1 };
      const scan2 = { recordCounts: new Map([['Contact', 99]]), totalObjectsScanned: 1 };
      const plan = {
        waves: [{ order: 0, objects: ['Account'], dependsOn: [] }],
        totalRecords: 5,
        estimatedDurationSec: 1,
        estimatedApiCalls: 2,
        complianceFramework: 'none',
        anonymizationSummary: { totalRules: 0, rulesByType: {} },
        cycleResolutions: [],
      };
      const dExec = deferred<{
        totalSuccess: number;
        totalFailure: number;
        totalSkipped: number;
        elapsedMs: number;
        completedObjects: string[];
        failedObjects: string[];
        skippedObjects: string[];
      }>();

      const orchestrator = createMockOrchestrator({
        scanSchemas: vi
          .fn()
          .mockImplementationOnce(() => Promise.resolve(scan1))
          .mockImplementationOnce(() => Promise.resolve(scan2)),
        generatePlan: vi.fn().mockReturnValue(plan),
        executePlan: vi.fn().mockImplementation(() => dExec.promise),
      });
      handler.setOrchestrator(orchestrator);
      mockGetConn.mockResolvedValue({} as never);

      await handler.handle(scanMsg('scan-1'));
      await handler.handle({
        id: 'plan-1',
        type: 'autopilot:generate-plan',
        timestamp: Date.now(),
        payload: { complianceFramework: 'gdpr' },
      } as BaseMessage);

      const execPromise = handler.handle({
        id: 'exec-1',
        type: 'autopilot:execute',
        timestamp: Date.now(),
        payload: { grappeThreshold: 0 },
      } as BaseMessage);

      // While the execution is in flight, a new scan arrives and completes.
      await handler.handle(scanMsg('scan-2'));

      dExec.resolve({
        totalSuccess: 5,
        totalFailure: 0,
        totalSkipped: 0,
        elapsedMs: 10,
        completedObjects: ['Account'],
        failedObjects: [],
        skippedObjects: [],
      });
      await execPromise;

      const messages = postedMessages(deps);
      const completedNode = messages.find(
        (m) =>
          m.type === 'autopilot:node-progress' &&
          (m as BaseMessage & { payload: { status?: string } }).payload.status === 'completed',
      ) as (BaseMessage & { payload: { objectName: string; recordCount?: number } }) | undefined;
      expect(completedNode).toBeDefined();
      expect(completedNode?.payload.objectName).toBe('Account');
      // Record count must come from the execution's own scan (5), not scan-2 (99).
      expect(completedNode?.payload.recordCount).toBe(5);
    });

    it('keeps the previous operation usable when a newer scan fails', async () => {
      const graph1 = { nodes: ['graph-1'], edges: [] };
      const orchestrator = createMockOrchestrator({
        scanSchemas: vi
          .fn()
          .mockResolvedValueOnce({ recordCounts: new Map(), totalObjectsScanned: 1 })
          .mockRejectedValueOnce(new Error('boom')),
        buildGraph: vi.fn().mockReturnValue(graph1),
      });
      handler.setOrchestrator(orchestrator);
      mockGetConn.mockResolvedValue({} as never);

      await handler.handle(scanMsg('scan-ok'));
      await handler.handle(scanMsg('scan-ko'));

      const postToWebview = deps.broker.postToWebview as ReturnType<typeof vi.fn>;
      postToWebview.mockClear();

      await handler.handle({
        id: 'plan-after-failed-scan',
        type: 'autopilot:generate-plan',
        timestamp: Date.now(),
        payload: { complianceFramework: 'gdpr' },
      } as BaseMessage);

      const planReady = (postToWebview.mock.calls[0][0] ?? {}) as BaseMessage & {
        payload: { graph: unknown };
      };
      expect(planReady.type).toBe('autopilot:plan-ready');
      expect(planReady.payload.graph).toBe(graph1);
    });

    it('warns instead of delegating pause/resume/skip when no execution is in progress', async () => {
      const orchestrator = createMockOrchestrator();
      handler.setOrchestrator(orchestrator);

      await handler.handle({ id: 'p1', type: 'autopilot:pause', timestamp: Date.now() });
      await handler.handle({ id: 'r1', type: 'autopilot:resume', timestamp: Date.now() });
      await handler.handle({
        id: 's1',
        type: 'autopilot:skip-node',
        timestamp: Date.now(),
        payload: { objectApiName: 'Account' },
      } as BaseMessage);

      expect(orchestrator.pause).not.toHaveBeenCalled();
      expect(orchestrator.resume).not.toHaveBeenCalled();
      expect(orchestrator.skip).not.toHaveBeenCalled();

      const notifications = postedMessages(deps).filter((m) => m.type === 'notification');
      expect(notifications).toHaveLength(3);
      for (const n of notifications) {
        expect((n as BaseMessage & { payload: { level: string } }).payload.level).toBe('warning');
      }
    });

    it('targets the in-flight execution for pause/resume/skip', async () => {
      const dExec = deferred<{
        totalSuccess: number;
        totalFailure: number;
        totalSkipped: number;
        elapsedMs: number;
        completedObjects: string[];
        failedObjects: string[];
        skippedObjects: string[];
      }>();
      const orchestrator = createMockOrchestrator({
        generatePlan: vi.fn().mockReturnValue({
          waves: [{ order: 0, objects: ['Account'], dependsOn: [] }],
          totalRecords: 5,
          estimatedDurationSec: 1,
          estimatedApiCalls: 2,
          complianceFramework: 'none',
          anonymizationSummary: { totalRules: 0, rulesByType: {} },
          cycleResolutions: [],
        }),
        executePlan: vi.fn().mockImplementation(() => dExec.promise),
      });
      handler.setOrchestrator(orchestrator);
      mockGetConn.mockResolvedValue({} as never);

      await handler.handle(scanMsg('scan-ctl'));
      await handler.handle({
        id: 'plan-ctl',
        type: 'autopilot:generate-plan',
        timestamp: Date.now(),
        payload: { complianceFramework: 'gdpr' },
      } as BaseMessage);

      const execPromise = handler.handle({
        id: 'exec-ctl',
        type: 'autopilot:execute',
        timestamp: Date.now(),
        payload: { grappeThreshold: 0 },
      } as BaseMessage);

      await handler.handle({ id: 'p2', type: 'autopilot:pause', timestamp: Date.now() });
      await handler.handle({ id: 'r2', type: 'autopilot:resume', timestamp: Date.now() });
      await handler.handle({
        id: 's2',
        type: 'autopilot:skip-node',
        timestamp: Date.now(),
        payload: { objectApiName: 'Contact' },
      } as BaseMessage);

      expect(orchestrator.pause).toHaveBeenCalledTimes(1);
      expect(orchestrator.resume).toHaveBeenCalledTimes(1);
      expect(orchestrator.skip).toHaveBeenCalledWith('Contact');

      dExec.resolve({
        totalSuccess: 5,
        totalFailure: 0,
        totalSkipped: 0,
        elapsedMs: 10,
        completedObjects: ['Account'],
        failedObjects: [],
        skippedObjects: [],
      });
      await execPromise;

      // Once the execution is over, control messages no longer target it.
      await handler.handle({ id: 'p3', type: 'autopilot:pause', timestamp: Date.now() });
      expect(orchestrator.pause).toHaveBeenCalledTimes(1);
    });
  });

  describe('production guard', () => {
    const GUARD_PLAN = {
      waves: [{ order: 0, objects: ['Account'], dependsOn: [] }],
      totalRecords: 5,
      estimatedDurationSec: 1,
      estimatedApiCalls: 2,
      complianceFramework: 'none',
      anonymizationSummary: { totalRules: 0, rulesByType: {} },
      cycleResolutions: [],
    };

    /** Wires a mock ProductionGuard into deps.infraServices and returns its spies. */
    function wireGuard(behavior: {
      allowed: boolean;
      requiresConfirmation?: boolean;
      blockedReason?: string;
      confirmed?: boolean;
    }): { check: Mock; logOperation: Mock; confirmIfNeeded: Mock } {
      const check = vi.fn().mockReturnValue({
        allowed: behavior.allowed,
        requiresConfirmation: behavior.requiresConfirmation ?? false,
        requiresApproval: false,
        blockedReason: behavior.blockedReason,
        warnings: [],
        impactSummary: 'INSERT 5 Account record(s) on production org tgt [module: autopilot]',
      });
      const logOperation = vi.fn();
      const confirmIfNeeded = vi.fn().mockResolvedValue(behavior.confirmed ?? true);
      deps.infraServices = {
        performanceTracker: { start: vi.fn(), complete: vi.fn() },
        productionGuard: { check, logOperation, confirmIfNeeded },
        offlineManager: undefined,
        piiDetector: undefined,
      } as unknown as NonNullable<HandlerDeps['infraServices']>;
      return { check, logOperation, confirmIfNeeded };
    }

    /** Runs scan → generate-plan so the operation is ready for execute. */
    async function scanAndPlan(orchestrator: ReturnType<typeof createMockOrchestrator>) {
      handler.setOrchestrator(orchestrator);
      mockGetConn.mockResolvedValue({} as never);
      await handler.handle(scanMsg('scan-guard'));
      await handler.handle({
        id: 'plan-guard',
        type: 'autopilot:generate-plan',
        timestamp: Date.now(),
        payload: { complianceFramework: 'gdpr' },
      } as BaseMessage);
      const postToWebview = deps.broker.postToWebview as Mock<[BaseMessage], void>;
      postToWebview.mockClear();
    }

    function executeMsg(): BaseMessage {
      return {
        id: 'exec-guard',
        type: 'autopilot:execute',
        timestamp: Date.now(),
        payload: { grappeThreshold: 0 },
      } as BaseMessage;
    }

    function mockTargetOrgType(orgType: string): void {
      (deps.orgManager.getOrg as Mock).mockReturnValue({ orgType });
    }

    it('asks for production confirmation before executing on a production target', async () => {
      const guard = wireGuard({ allowed: true, requiresConfirmation: true, confirmed: true });
      mockTargetOrgType('Production');
      const orchestrator = createMockOrchestrator({
        generatePlan: vi.fn().mockReturnValue(GUARD_PLAN),
      });
      await scanAndPlan(orchestrator);

      await handler.handle(executeMsg());

      // The tier is resolved from the scanned target org ('tgt').
      expect(guard.check).toHaveBeenCalledTimes(1);
      expect(guard.check.mock.calls[0][0]).toMatchObject({
        orgId: 'tgt',
        orgTier: 'production',
        operation: 'insert',
        module: 'autopilot',
      });
      expect(guard.confirmIfNeeded).toHaveBeenCalledTimes(1);
      expect(guard.logOperation).toHaveBeenCalledTimes(1);
      expect(orchestrator.executePlan).toHaveBeenCalledTimes(1);
      const completed = postedMessages(deps).find((m) => m.type === 'autopilot:completed');
      expect(completed).toBeDefined();
    });

    it('blocks the execution when the guard refuses — no insert, actionable autopilot:error', async () => {
      const guard = wireGuard({
        allowed: false,
        blockedReason: 'insert is not allowed on production org tgt',
      });
      mockTargetOrgType('Production');
      const orchestrator = createMockOrchestrator({
        generatePlan: vi.fn().mockReturnValue(GUARD_PLAN),
      });
      await scanAndPlan(orchestrator);

      await handler.handle(executeMsg());

      expect(guard.logOperation).toHaveBeenCalledTimes(1);
      expect(guard.confirmIfNeeded).not.toHaveBeenCalled();
      expect(orchestrator.executePlan).not.toHaveBeenCalled();
      const errors = postedMessages(deps).filter((m) => m.type === 'autopilot:error');
      expect(errors).toHaveLength(1);
      expect(
        (errors[0] as BaseMessage & { payload: { message: string } }).payload.message,
      ).toContain('insert is not allowed on production org tgt');
    });

    it('cancels the execution when the user declines the production confirmation', async () => {
      const guard = wireGuard({ allowed: true, requiresConfirmation: true, confirmed: false });
      mockTargetOrgType('Production');
      const orchestrator = createMockOrchestrator({
        generatePlan: vi.fn().mockReturnValue(GUARD_PLAN),
      });
      await scanAndPlan(orchestrator);

      await handler.handle(executeMsg());

      expect(guard.confirmIfNeeded).toHaveBeenCalledTimes(1);
      expect(orchestrator.executePlan).not.toHaveBeenCalled();
      const errors = postedMessages(deps).filter((m) => m.type === 'autopilot:error');
      expect(errors).toHaveLength(1);
      expect(
        (errors[0] as BaseMessage & { payload: { message: string } }).payload.message,
      ).toContain('production confirmation declined');
    });

    it('lets sandbox executions through and audits them via logOperation', async () => {
      const guard = wireGuard({ allowed: true, requiresConfirmation: false });
      mockTargetOrgType('Sandbox');
      const orchestrator = createMockOrchestrator({
        generatePlan: vi.fn().mockReturnValue(GUARD_PLAN),
      });
      await scanAndPlan(orchestrator);

      await handler.handle(executeMsg());

      expect(guard.logOperation).toHaveBeenCalledTimes(1);
      expect(guard.logOperation.mock.calls[0][0]).toMatchObject({
        orgId: 'tgt',
        orgTier: 'development',
        module: 'autopilot',
      });
      expect(orchestrator.executePlan).toHaveBeenCalledTimes(1);
      const errors = postedMessages(deps).filter((m) => m.type === 'autopilot:error');
      expect(errors).toHaveLength(0);
    });
  });
});
