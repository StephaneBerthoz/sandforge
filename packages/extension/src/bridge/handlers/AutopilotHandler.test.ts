import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { AutopilotHandler } from './AutopilotHandler.js';
import type { HandlerDeps, InboundRequest } from './HandlerTypes.js';
import type { BaseMessage, ForgeTargetAutomation } from '@sandforge/shared';

vi.mock('../../core/connection/ConnectionHelper.js', () => ({
  getJsforceConnection: vi.fn(),
}));

import { getJsforceConnection } from '../../core/connection/ConnectionHelper.js';
import { ProductionGuard } from '../../core/precheck/ProductionGuard.js';
import { inboundRequest } from '../../test/mockFactories.js';

/** What a target that runs nothing on `objects` answers a read of its automation. */
function quietTarget(objects: readonly string[]): ForgeTargetAutomation {
  return {
    objectsRead: [...objects],
    objects: [],
    unread: [],
    conditionsNotRead: 0,
    conditionsBound: 25,
    requests: 6,
  };
}
import { ConfigStore } from '../../core/storage/ConfigStore.js';
import { InMemoryConfigStoreBackend } from '../../test/InMemoryConfigStoreBackend.js';
import { AuditTrailStore } from '../../modules/audit/auditTrail.js';
import { BackgroundOperationRegistry } from '../../core/engine/BackgroundOperationRegistry.js';
import { ExecutionHandler } from './ExecutionHandler.js';
import { LiveOperationTracker } from '../../modules/monitor/LiveOperationTracker.js';

const mockGetConn = vi.mocked(getJsforceConnection);

/**
 * A connection whose org says it has the data storage a small run fits in:
 * the run's write gate reads it before the first write.
 */
const ROOMY_CONN = {
  request: vi.fn(async () => ({ DataStorageMB: { Max: 200, Remaining: 150 } })),
};

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
    // An execution refuses to write without a Production Guard, and the
    // extension always injects one.
    infraServices: {
      productionGuard: new ProductionGuard(),
    } as unknown as HandlerDeps['infraServices'],
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
    scanSchemas: vi.fn().mockResolvedValue({
      objectDescribes: new Map(),
      recordCounts: new Map(),
      totalObjectsScanned: 5,
    }),
    buildGraph: vi.fn().mockReturnValue({ nodes: [], edges: [] }),
    buildCompliance: vi.fn().mockReturnValue({ profile: {}, rules: [] }),
    generatePlan: vi.fn().mockReturnValue({ steps: [] }),
    executePlan: vi.fn().mockResolvedValue({
      totalSuccess: 10,
      totalFailure: 0,
      totalSkipped: 0,
      elapsedMs: 100,
    }),
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
function scanMsg(id: string): InboundRequest {
  return inboundRequest({
    id,
    type: 'autopilot:scan-schema',
    timestamp: Date.now(),
    payload: {
      sourceOrgId: 'src',
      targetOrgId: 'tgt',
      selectedObjects: [],
      includeStandardObjects: false,
    },
  } as BaseMessage);
}

/** Extracts all messages posted to the webview. */
function postedMessages(deps: HandlerDeps): Array<BaseMessage & { correlationId?: string }> {
  const postToWebview = deps.broker.postToWebview as Mock<(message: BaseMessage) => void>;
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
    const msg: InboundRequest = inboundRequest({
      id: '1',
      type: 'unknown:type',
      timestamp: Date.now(),
    });
    const result = await handler.handle(msg);
    expect(result).toBe(false);
  });

  it('handles autopilot:scan-schema and response includes correlationId', async () => {
    const orchestrator = createMockOrchestrator();
    handler.setOrchestrator(orchestrator);

    mockGetConn.mockResolvedValue(ROOMY_CONN as never);

    const msg: InboundRequest & {
      payload: {
        sourceOrgId: string;
        targetOrgId: string;
        selectedObjects: string[];
        includeStandardObjects: boolean;
      };
    } = inboundRequest({
      id: 'req-ap-1',
      type: 'autopilot:scan-schema',
      timestamp: Date.now(),
      payload: {
        sourceOrgId: 'src',
        targetOrgId: 'tgt',
        selectedObjects: [],
        includeStandardObjects: false,
      },
    });

    const result = await handler.handle(msg);
    expect(result).toBe(true);

    const postToWebview = deps.broker.postToWebview as ReturnType<typeof vi.fn>;
    expect(postToWebview).toHaveBeenCalledTimes(1);

    const response = postToWebview.mock.calls[0][0] as BaseMessage & {
      correlationId?: string;
    };
    expect(response.type).toBe('autopilot:schema-result');
    expect(response.correlationId).toBe('req-ap-1');
  });

  it('handles autopilot:generate-plan and response includes correlationId', async () => {
    const orchestrator = createMockOrchestrator();
    handler.setOrchestrator(orchestrator);

    // Must scan schema first to populate graph
    mockGetConn.mockResolvedValue(ROOMY_CONN as never);
    await handler.handle(scanMsg('scan-1'));

    // Now generate plan
    const msg: InboundRequest & { payload: { complianceFramework: string } } = inboundRequest({
      id: 'req-ap-2',
      type: 'autopilot:generate-plan',
      timestamp: Date.now(),
      payload: { complianceFramework: 'gdpr' },
    });

    await handler.handle(msg);

    const postToWebview = deps.broker.postToWebview as ReturnType<typeof vi.fn>;
    // First call was schema-result, second is plan-ready
    const planResponse = postToWebview.mock.calls[1][0] as BaseMessage & {
      correlationId?: string;
    };
    expect(planResponse.type).toBe('autopilot:plan-ready');
    expect(planResponse.correlationId).toBe('req-ap-2');
  });

  it('error path sends BOTH notification AND typed error response', async () => {
    const orchestrator = createMockOrchestrator({
      scanSchemas: vi.fn().mockRejectedValue(new Error('Schema scan exploded')),
    });
    handler.setOrchestrator(orchestrator);

    mockGetConn.mockResolvedValue(ROOMY_CONN as never);

    const msg: InboundRequest & {
      payload: {
        sourceOrgId: string;
        targetOrgId: string;
        selectedObjects: string[];
        includeStandardObjects: boolean;
      };
    } = inboundRequest({
      id: 'req-ap-err',
      type: 'autopilot:scan-schema',
      timestamp: Date.now(),
      payload: {
        sourceOrgId: 'src',
        targetOrgId: 'tgt',
        selectedObjects: [],
        includeStandardObjects: false,
      },
    });

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

  describe('before the module has reached the handler', () => {
    /** The seven requests, each with a payload that would pass its schema. */
    const requests: Array<{ type: string; payload?: Record<string, unknown> }> = [
      {
        type: 'autopilot:scan-schema',
        payload: {
          sourceOrgId: 'src',
          targetOrgId: 'tgt',
          selectedObjects: [],
          includeStandardObjects: false,
        },
      },
      { type: 'autopilot:generate-plan', payload: { complianceFramework: 'gdpr' } },
      { type: 'autopilot:execute', payload: { grappeThreshold: 0 } },
      { type: 'autopilot:pause' },
      { type: 'autopilot:resume' },
      { type: 'autopilot:skip-node', payload: { objectApiName: 'Account' } },
      { type: 'autopilot:compliance-report' },
    ];

    it.each(requests)(
      'answers $type with one code the page words in its language, and no English notification beside it',
      async ({ type, payload }) => {
        await handler.handle(
          inboundRequest({
            id: `req-${type}`,
            type,
            timestamp: Date.now(),
            payload,
          } as BaseMessage),
        );

        const posted = postedMessages(deps) as Array<
          BaseMessage & { payload: { code?: string; message: string } }
        >;
        const answer = posted.find((m) => m.type === 'autopilot:error');
        expect(answer).toMatchObject({
          correlationId: `req-${type}`,
          payload: { code: 'AUTOPILOT_NOT_READY' },
        });
        // The page waiting on the answer shows it; one sent without waiting
        // for an answer has only the notification, which carries the code.
        const notifications = posted.filter((m) => m.type === 'notification');
        if (['autopilot:pause', 'autopilot:resume', 'autopilot:skip-node'].includes(type)) {
          expect(notifications).toHaveLength(1);
          expect(notifications[0].payload.code).toBe('AUTOPILOT_NOT_READY');
        } else {
          expect(notifications).toEqual([]);
        }
      },
    );
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
    mockGetConn.mockResolvedValue(ROOMY_CONN as never);
    await handler.handle(scanMsg('scan-exec'));

    await handler.handle(
      inboundRequest({
        id: 'plan-exec',
        type: 'autopilot:generate-plan',
        timestamp: Date.now(),
        payload: { complianceFramework: 'gdpr' },
      } as BaseMessage),
    );

    const postToWebview = deps.broker.postToWebview as Mock<(message: BaseMessage) => void>;
    postToWebview.mockClear();

    // Execute
    const executeMsg: InboundRequest & {
      payload: { grappeThreshold: number };
    } = inboundRequest({
      id: 'req-ap-exec',
      type: 'autopilot:execute',
      timestamp: Date.now(),
      payload: { grappeThreshold: 0 },
    });

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

      const msg = inboundRequest({
        id: 'req-bad-scan',
        type: 'autopilot:scan-schema',
        timestamp: Date.now(),
        payload: {
          sourceOrgId: 'src',
          targetOrgId: 'tgt',
          selectedObjects: 'Account',
          includeStandardObjects: false,
        },
      } as unknown as BaseMessage);

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
      mockGetConn.mockResolvedValue(ROOMY_CONN as never);
      await handler.handle(scanMsg('scan-val'));

      const postToWebview = deps.broker.postToWebview as ReturnType<typeof vi.fn>;
      postToWebview.mockClear();

      await handler.handle(
        inboundRequest({
          id: 'req-bad-plan',
          type: 'autopilot:generate-plan',
          timestamp: Date.now(),
          payload: { complianceFramework: 'sox' },
        } as BaseMessage),
      );

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
      mockGetConn.mockResolvedValue(ROOMY_CONN as never);
      await handler.handle(scanMsg('scan-val-exec'));
      await handler.handle(
        inboundRequest({
          id: 'plan-val-exec',
          type: 'autopilot:generate-plan',
          timestamp: Date.now(),
          payload: { complianceFramework: 'gdpr' },
        } as BaseMessage),
      );

      const postToWebview = deps.broker.postToWebview as ReturnType<typeof vi.fn>;
      postToWebview.mockClear();

      await handler.handle(
        inboundRequest({
          id: 'req-bad-exec',
          type: 'autopilot:execute',
          timestamp: Date.now(),
          payload: { grappeThreshold: -1 },
        } as BaseMessage),
      );

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

      await handler.handle(
        inboundRequest({
          id: 'req-bad-skip',
          type: 'autopilot:skip-node',
          timestamp: Date.now(),
          payload: {},
        } as BaseMessage),
      );

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
      const scanA = {
        objectDescribes: new Map(),
        recordCounts: new Map([['Account', 5]]),
        totalObjectsScanned: 1,
      };
      const scanB = {
        objectDescribes: new Map(),
        recordCounts: new Map([['Contact', 99]]),
        totalObjectsScanned: 1,
      };
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
      mockGetConn.mockResolvedValue(ROOMY_CONN as never);

      const pA = handler.handle(scanMsg('scan-A'));
      const pB = handler.handle(scanMsg('scan-B'));

      // B finishes first; A must still deliver its own graph afterwards.
      dB.resolve(scanB);
      dA.resolve(scanA);
      await Promise.all([pA, pB]);

      const messages = postedMessages(deps);
      const responseA = messages.find((m) => m.correlationId === 'scan-A') as
        (BaseMessage & { payload: { graph: unknown } }) | undefined;
      const responseB = messages.find((m) => m.correlationId === 'scan-B') as
        (BaseMessage & { payload: { graph: unknown } }) | undefined;
      expect(responseA?.type).toBe('autopilot:schema-result');
      expect(responseB?.type).toBe('autopilot:schema-result');
      expect(responseA?.payload.graph).toBe(graphA);
      expect(responseB?.payload.graph).toBe(graphB);
    });

    it('does not let a concurrent scan clobber an in-flight execution', async () => {
      const scan1 = {
        objectDescribes: new Map(),
        recordCounts: new Map([['Account', 5]]),
        totalObjectsScanned: 1,
      };
      const scan2 = {
        objectDescribes: new Map(),
        recordCounts: new Map([['Contact', 99]]),
        totalObjectsScanned: 1,
      };
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
      handler.setTargetAutomation({ read: async (_org, objects) => quietTarget(objects) });
      mockGetConn.mockResolvedValue(ROOMY_CONN as never);

      await handler.handle(scanMsg('scan-1'));
      await handler.handle(
        inboundRequest({
          id: 'plan-1',
          type: 'autopilot:generate-plan',
          timestamp: Date.now(),
          payload: { complianceFramework: 'gdpr' },
        } as BaseMessage),
      );

      const execPromise = handler.handle(
        inboundRequest({
          id: 'exec-1',
          type: 'autopilot:execute',
          timestamp: Date.now(),
          payload: { grappeThreshold: 0 },
        } as BaseMessage),
      );

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
      ) as
        | (BaseMessage & {
            payload: { objectName: string; recordCount?: number };
          })
        | undefined;
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
          .mockResolvedValueOnce({
            objectDescribes: new Map(),
            recordCounts: new Map(),
            totalObjectsScanned: 1,
          })
          .mockRejectedValueOnce(new Error('boom')),
        buildGraph: vi.fn().mockReturnValue(graph1),
      });
      handler.setOrchestrator(orchestrator);
      mockGetConn.mockResolvedValue(ROOMY_CONN as never);

      await handler.handle(scanMsg('scan-ok'));
      await handler.handle(scanMsg('scan-ko'));

      const postToWebview = deps.broker.postToWebview as ReturnType<typeof vi.fn>;
      postToWebview.mockClear();

      await handler.handle(
        inboundRequest({
          id: 'plan-after-failed-scan',
          type: 'autopilot:generate-plan',
          timestamp: Date.now(),
          payload: { complianceFramework: 'gdpr' },
        } as BaseMessage),
      );

      const planReady = (postToWebview.mock.calls[0][0] ?? {}) as BaseMessage & {
        payload: { graph: unknown };
      };
      expect(planReady.type).toBe('autopilot:plan-ready');
      expect(planReady.payload.graph).toBe(graph1);
    });

    it('warns instead of delegating pause/resume/skip when no execution is in progress', async () => {
      const orchestrator = createMockOrchestrator();
      handler.setOrchestrator(orchestrator);

      await handler.handle(
        inboundRequest({
          id: 'p1',
          type: 'autopilot:pause',
          timestamp: Date.now(),
        }),
      );
      await handler.handle(
        inboundRequest({
          id: 'r1',
          type: 'autopilot:resume',
          timestamp: Date.now(),
        }),
      );
      await handler.handle(
        inboundRequest({
          id: 's1',
          type: 'autopilot:skip-node',
          timestamp: Date.now(),
          payload: { objectApiName: 'Account' },
        } as BaseMessage),
      );

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
      mockGetConn.mockResolvedValue(ROOMY_CONN as never);

      await handler.handle(scanMsg('scan-ctl'));
      await handler.handle(
        inboundRequest({
          id: 'plan-ctl',
          type: 'autopilot:generate-plan',
          timestamp: Date.now(),
          payload: { complianceFramework: 'gdpr' },
        } as BaseMessage),
      );

      const execPromise = handler.handle(
        inboundRequest({
          id: 'exec-ctl',
          type: 'autopilot:execute',
          timestamp: Date.now(),
          payload: { grappeThreshold: 0 },
        } as BaseMessage),
      );
      // The run is in flight once the Production Guard has answered.
      await vi.waitFor(() => expect(orchestrator.executePlan).toHaveBeenCalled());

      await handler.handle(
        inboundRequest({
          id: 'p2',
          type: 'autopilot:pause',
          timestamp: Date.now(),
        }),
      );
      await handler.handle(
        inboundRequest({
          id: 'r2',
          type: 'autopilot:resume',
          timestamp: Date.now(),
        }),
      );
      await handler.handle(
        inboundRequest({
          id: 's2',
          type: 'autopilot:skip-node',
          timestamp: Date.now(),
          payload: { objectApiName: 'Contact' },
        } as BaseMessage),
      );

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
      await handler.handle(
        inboundRequest({
          id: 'p3',
          type: 'autopilot:pause',
          timestamp: Date.now(),
        }),
      );
      expect(orchestrator.pause).toHaveBeenCalledTimes(1);
    });
  });

  describe('audit trail', () => {
    const PLAN = {
      waves: [{ order: 0, objects: ['Account', 'Contact'], dependsOn: [] }],
      totalRecords: 10,
      estimatedDurationSec: 1,
      estimatedApiCalls: 2,
      complianceFramework: 'none',
      anonymizationSummary: { totalRules: 0, rulesByType: {} },
      cycleResolutions: [],
    };

    /** A real store, read back the way the Reports page reads it. */
    function recordingStore(): ConfigStore {
      const store = new ConfigStore(new InMemoryConfigStoreBackend());
      store.initialize();
      deps.configStore = store;
      return store;
    }

    /** Scan, plan and execute with an orchestrator whose run is `executePlan`. */
    async function run(executePlan: Mock): Promise<void> {
      handler.setOrchestrator(
        createMockOrchestrator({ generatePlan: vi.fn().mockReturnValue(PLAN), executePlan }),
      );
      mockGetConn.mockResolvedValue(ROOMY_CONN as never);
      await handler.handle(scanMsg('scan-audit'));
      await handler.handle(
        inboundRequest({
          id: 'plan-audit',
          type: 'autopilot:generate-plan',
          timestamp: Date.now(),
          payload: { complianceFramework: 'gdpr' },
        } as BaseMessage),
      );
      await handler.handle(
        inboundRequest({
          id: 'exec-audit',
          type: 'autopilot:execute',
          timestamp: Date.now(),
          payload: { grappeThreshold: 0 },
        } as BaseMessage),
      );
    }

    type Settle = (event: Record<string, unknown>) => void;

    it('records a run once, per object as its nodes settled, from the org it scanned', async () => {
      const store = recordingStore();

      await run(
        vi.fn(async (_p: unknown, _g: unknown, _r: unknown, _c: unknown, settle: Settle) => {
          settle({
            type: 'node-completed',
            objectApiName: 'Account',
            successCount: 3,
            failureCount: 1,
            elapsedMs: 1,
            apiCallsUsed: 1,
          });
          settle({
            type: 'node-failed',
            objectApiName: 'Contact',
            errors: ['REQUIRED_FIELD_MISSING'],
            partialSuccessCount: 2,
            failureCount: 4,
          });
          return {
            totalSuccess: 5,
            totalFailure: 5,
            totalSkipped: 0,
            elapsedMs: 10,
            completedObjects: ['Account'],
            failedObjects: ['Contact'],
            skippedObjects: [],
          };
        }),
      );

      const { entries } = new AuditTrailStore(store).list();
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        action: 'autopilot_execute',
        module: 'autopilot',
        operationId: 'exec-audit',
        orgId: 'tgt',
        sourceOrgId: 'src',
        outcome: 'partial',
        objects: [
          { objectApiName: 'Account', created: 3, failed: 1 },
          { objectApiName: 'Contact', created: 2, failed: 4 },
        ],
      });
      expect(JSON.stringify(store.get('audit:trail'))).not.toContain('REQUIRED_FIELD_MISSING');
    });

    it('records a run that died with what the nodes settled before it wrote', async () => {
      const store = recordingStore();

      await run(
        vi.fn(async (_p: unknown, _g: unknown, _r: unknown, _c: unknown, settle: Settle) => {
          settle({
            type: 'node-completed',
            objectApiName: 'Account',
            successCount: 3,
            failureCount: 0,
            elapsedMs: 1,
            apiCallsUsed: 1,
          });
          throw new Error('INVALID_SESSION_ID');
        }),
      );

      expect(new AuditTrailStore(store).list().entries).toEqual([
        expect.objectContaining({
          outcome: 'failure',
          objects: [expect.objectContaining({ objectApiName: 'Account', created: 3 })],
        }),
      ]);
    });
  });

  describe('a run stopped through execution:abort', () => {
    const PLAN = {
      waves: [
        { order: 0, objects: ['Account'], dependsOn: [] },
        { order: 1, objects: ['Contact'], dependsOn: [0] },
      ],
      totalRecords: 10,
      estimatedDurationSec: 1,
      estimatedApiCalls: 2,
      complianceFramework: 'none',
      anonymizationSummary: { totalRules: 0, rulesByType: {} },
      cycleResolutions: [],
    };

    /** A real store, read back the way the Reports page reads it. */
    function recordingStore(): ConfigStore {
      const store = new ConfigStore(new InMemoryConfigStoreBackend());
      store.initialize();
      deps.configStore = store;
      return store;
    }

    /**
     * Scan and plan, then start the run without waiting for it: its
     * `executePlan` waits for the signal it is handed, and returns `stopped`
     * once it aborts.
     */
    async function startStoppableRun(
      stopped: Record<string, unknown>,
      plan: typeof PLAN = PLAN,
    ): Promise<{
      registry: BackgroundOperationRegistry;
      executePlan: Mock;
      running: Promise<boolean>;
    }> {
      const registry = new BackgroundOperationRegistry();
      handler.setRegistry(registry);
      const executePlan = vi.fn(
        (_p: unknown, _g: unknown, _r: unknown, _c: unknown, _s: unknown, signal: AbortSignal) =>
          new Promise((resolve) => {
            signal.addEventListener('abort', () => resolve(stopped));
          }),
      );
      handler.setOrchestrator(
        createMockOrchestrator({ generatePlan: vi.fn().mockReturnValue(plan), executePlan }),
      );
      mockGetConn.mockResolvedValue(ROOMY_CONN as never);
      await handler.handle(scanMsg('scan-stop'));
      await handler.handle(
        inboundRequest({
          id: 'plan-stop',
          type: 'autopilot:generate-plan',
          timestamp: Date.now(),
          payload: { complianceFramework: 'gdpr' },
        } as BaseMessage),
      );
      const running = handler.handle(
        inboundRequest({
          id: 'exec-stop',
          type: 'autopilot:execute',
          timestamp: Date.now(),
          payload: { grappeThreshold: 0 },
        } as BaseMessage),
      );
      await vi.waitFor(() => expect(executePlan).toHaveBeenCalled());
      return { registry, executePlan, running };
    }

    /** Send `execution:abort` for the run, as Stop and Live Operations do. */
    async function abort(registry: BackgroundOperationRegistry): Promise<void> {
      await new ExecutionHandler(deps, registry).handle(
        inboundRequest({
          id: 'abort-1',
          type: 'execution:abort',
          timestamp: Date.now(),
          payload: { operationId: 'exec-stop' },
        } as BaseMessage),
      );
    }

    const PART_WRITTEN = {
      totalSuccess: 2,
      totalFailure: 0,
      totalSkipped: 0,
      elapsedMs: 10,
      completedObjects: [],
      failedObjects: [],
      skippedObjects: [],
      stopped: true,
      stoppedObjects: ['Account', 'Contact'],
      objectOutcomes: {
        Account: { written: 2, linked: 0, failed: 0, refusals: [], notSent: 3 },
        Contact: { written: 0, linked: 0, failed: 0, refusals: [], notSent: 5 },
      },
    };

    it('reaches the run by the id of its execute request, and the run says it stopped', async () => {
      recordingStore();
      const { registry, running } = await startStoppableRun(PART_WRITTEN);
      expect(registry.get('exec-stop')?.status).toBe('running');

      await abort(registry);
      await running;

      expect(postedMessages(deps).find((m) => m.type === 'execution:abort:response')).toMatchObject(
        {
          payload: { success: true, operationId: 'exec-stop' },
        },
      );
      expect(registry.get('exec-stop')?.status).toBe('aborted');
      expect(postedMessages(deps).find((m) => m.type === 'autopilot:completed')).toMatchObject({
        correlationId: 'exec-stop',
        payload: {
          totalSuccessCount: 2,
          stopped: true,
          notWritten: ['Account', 'Contact'],
        },
      });
      // Each node the stop cut short or never reached is said to be stopped.
      const stoppedNodes = postedMessages(deps)
        .filter((m) => m.type === 'autopilot:node-progress')
        .map((m) => (m as BaseMessage & { payload: Record<string, unknown> }).payload)
        .filter((payload) => payload.status === 'stopped');
      expect(stoppedNodes).toEqual([
        expect.objectContaining({ objectName: 'Account', recordCount: 2, notSent: 3 }),
        expect.objectContaining({ objectName: 'Contact', recordCount: 0, notSent: 5 }),
      ]);
    });

    it('is listed in Live Operations while it runs, and cancelled there once stopped', async () => {
      recordingStore();
      const tracker = new LiveOperationTracker();
      handler.setLiveOperationTracker(tracker);
      const { registry, running } = await startStoppableRun(PART_WRITTEN);
      expect(tracker.get('exec-stop')).toMatchObject({ module: 'autopilot', status: 'running' });

      await abort(registry);
      await running;

      expect(tracker.get('exec-stop')?.status).toBe('cancelled');
      tracker.dispose();
    });

    it('refuses a second run on the same target while the first writes, and writes nothing for it', async () => {
      recordingStore();
      const { registry, executePlan, running } = await startStoppableRun(PART_WRITTEN);

      await handler.handle(
        inboundRequest({
          id: 'exec-again',
          type: 'autopilot:execute',
          timestamp: Date.now(),
          payload: { grappeThreshold: 0 },
        } as BaseMessage),
      );

      expect(executePlan).toHaveBeenCalledTimes(1);
      expect(postedMessages(deps).find((m) => m.correlationId === 'exec-again')).toMatchObject({
        type: 'autopilot:error',
        payload: { code: 'AUTOPILOT_RUNNING' },
      });
      expect(registry.get('exec-again')).toBeUndefined();

      // Once the first has ended, a run starts again.
      await abort(registry);
      await running;
      const after = handler.handle(
        inboundRequest({
          id: 'exec-after',
          type: 'autopilot:execute',
          timestamp: Date.now(),
          payload: { grappeThreshold: 0 },
        } as BaseMessage),
      );
      await vi.waitFor(() => expect(executePlan).toHaveBeenCalledTimes(2));
      registry.abort('exec-after');
      await after;
    });

    it('is listed paused in Live Operations while it is paused, and running once resumed', async () => {
      recordingStore();
      const tracker = new LiveOperationTracker();
      handler.setLiveOperationTracker(tracker);
      const { registry, running } = await startStoppableRun(PART_WRITTEN);

      await handler.handle(
        inboundRequest({ id: 'pause-1', type: 'autopilot:pause', timestamp: Date.now() }),
      );
      expect(tracker.get('exec-stop')?.status).toBe('paused');
      await handler.handle(
        inboundRequest({ id: 'resume-1', type: 'autopilot:resume', timestamp: Date.now() }),
      );
      expect(tracker.get('exec-stop')?.status).toBe('running');

      await abort(registry);
      await running;
      tracker.dispose();
    });

    it('records a run stopped after it wrote as cancelled, with what it never sent', async () => {
      const store = recordingStore();
      const { registry, running } = await startStoppableRun(PART_WRITTEN);

      await abort(registry);
      await running;

      expect(new AuditTrailStore(store).list().entries).toEqual([
        expect.objectContaining({
          operationId: 'exec-stop',
          outcome: 'cancelled',
          objects: [
            expect.objectContaining({ objectApiName: 'Account', created: 2, notSent: 3 }),
            expect.objectContaining({ objectApiName: 'Contact', created: 0, notSent: 5 }),
          ],
        }),
      ]);
    });

    it('records and says what the stop left undone in the records it wrote', async () => {
      // Stopped as its first wave ended: the accounts went in without the
      // parents the second pass fills, and the orders as drafts.
      const store = recordingStore();
      const { registry, running } = await startStoppableRun({
        ...PART_WRITTEN,
        completedObjects: ['Account'],
        stoppedObjects: ['Contact'],
        objectOutcomes: {
          Account: {
            written: 5,
            linked: 0,
            failed: 0,
            refusals: [],
            lookupsLeftEmpty: 3,
            statusesNotGivenBack: 2,
          },
          Contact: { written: 0, linked: 0, failed: 0, refusals: [], notSent: 5 },
        },
      });

      await abort(registry);
      await running;

      expect(postedMessages(deps).find((m) => m.type === 'autopilot:completed')).toMatchObject({
        payload: {
          stopped: true,
          notWritten: ['Contact'],
          leftByStop: [{ objectApiName: 'Account', lookupsLeftEmpty: 3, statusesNotGivenBack: 2 }],
        },
      });
      expect(new AuditTrailStore(store).list().entries).toEqual([
        expect.objectContaining({
          outcome: 'cancelled',
          objects: expect.arrayContaining([
            expect.objectContaining({
              objectApiName: 'Account',
              lookupsLeftEmpty: 3,
              statusesNotGivenBack: 2,
            }),
          ]),
        }),
      ]);
    });

    it('records and says the emails a stop kept from going while they waited for their task', async () => {
      // The emails on a case wait for the task each names; the stop came as
      // the tasks went in, and none of the three waiting was sent.
      const store = recordingStore();
      const { registry, running } = await startStoppableRun(
        {
          ...PART_WRITTEN,
          completedObjects: ['Task'],
          stoppedObjects: ['EmailMessage'],
          objectOutcomes: {
            EmailMessage: {
              written: 1,
              linked: 0,
              failed: 0,
              refusals: [],
              notSent: 3,
              heldForTheirTask: 3,
            },
            Task: { written: 1, linked: 0, failed: 0, refusals: [] },
          },
        },
        { ...PLAN, waves: [{ order: 0, objects: ['EmailMessage', 'Task'], dependsOn: [] }] },
      );

      await abort(registry);
      await running;

      expect(postedMessages(deps).find((m) => m.type === 'autopilot:completed')).toMatchObject({
        payload: { stopped: true, notWritten: ['EmailMessage'], emailsHeldForTheirTask: 3 },
      });
      expect(new AuditTrailStore(store).list().entries).toEqual([
        expect.objectContaining({
          outcome: 'cancelled',
          objects: expect.arrayContaining([
            expect.objectContaining({ objectApiName: 'EmailMessage', created: 1, notSent: 3 }),
          ]),
        }),
      ]);
    });

    it('says no held email for a stopped run that held none back', async () => {
      recordingStore();
      const { registry, running } = await startStoppableRun(PART_WRITTEN);

      await abort(registry);
      await running;

      const completed = postedMessages(deps).find((m) => m.type === 'autopilot:completed') as
        (BaseMessage & { payload: Record<string, unknown> }) | undefined;
      expect(completed?.payload).not.toHaveProperty('emailsHeldForTheirTask');
    });

    it('records a run stopped before it wrote as stopped, under the code of a cancel', async () => {
      const store = recordingStore();
      const { registry, running } = await startStoppableRun({
        ...PART_WRITTEN,
        totalSuccess: 0,
        objectOutcomes: {
          Account: { written: 0, linked: 0, failed: 0, refusals: [], notSent: 5 },
          Contact: { written: 0, linked: 0, failed: 0, refusals: [], notSent: 5 },
        },
      });

      await abort(registry);
      await running;

      expect(new AuditTrailStore(store).list().entries).toEqual([
        expect.objectContaining({
          outcome: 'stopped',
          details: expect.objectContaining({ code: 'RUN_CANCELLED' }),
        }),
      ]);
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
    }): { check: Mock; confirmIfNeeded: Mock } {
      const check = vi.fn().mockReturnValue({
        allowed: behavior.allowed,
        requiresConfirmation: behavior.requiresConfirmation ?? false,
        blockedReason: behavior.blockedReason,
        warnings: [],
        impactSummary: 'INSERT 5 Account record(s) on production org tgt [module: autopilot]',
      });
      const confirmIfNeeded = vi.fn().mockResolvedValue(behavior.confirmed ?? true);
      deps.infraServices = {
        performanceTracker: { start: vi.fn(), complete: vi.fn() },
        productionGuard: { check, confirmIfNeeded },
        offlineManager: undefined,
        piiDetector: undefined,
      } as unknown as NonNullable<HandlerDeps['infraServices']>;
      return { check, confirmIfNeeded };
    }

    /** Runs scan → generate-plan so the operation is ready for execute. */
    async function scanAndPlan(orchestrator: ReturnType<typeof createMockOrchestrator>) {
      handler.setOrchestrator(orchestrator);
      mockGetConn.mockResolvedValue(ROOMY_CONN as never);
      await handler.handle(scanMsg('scan-guard'));
      await handler.handle(
        inboundRequest({
          id: 'plan-guard',
          type: 'autopilot:generate-plan',
          timestamp: Date.now(),
          payload: { complianceFramework: 'gdpr' },
        } as BaseMessage),
      );
      const postToWebview = deps.broker.postToWebview as Mock<(message: BaseMessage) => void>;
      postToWebview.mockClear();
    }

    function executeMsg(): InboundRequest {
      return inboundRequest({
        id: 'exec-guard',
        type: 'autopilot:execute',
        timestamp: Date.now(),
        payload: { grappeThreshold: 0 },
      } as BaseMessage);
    }

    function mockTargetOrgType(orgType: string): void {
      (deps.orgManager.getOrg as Mock).mockReturnValue({ orgType });
    }

    it('asks for production confirmation before executing on a production target', async () => {
      const guard = wireGuard({
        allowed: true,
        requiresConfirmation: true,
        confirmed: true,
      });
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
      expect(guard.check).toHaveBeenCalledTimes(1);
      expect(orchestrator.executePlan).toHaveBeenCalledTimes(1);
      const completed = postedMessages(deps).find((m) => m.type === 'autopilot:completed');
      expect(completed).toBeDefined();
    });

    it('judges a Developer Edition target as the development org it is, registered as production or not', async () => {
      // A Trailhead playground says IsSandbox false: every run into one opened
      // the production question.
      for (const orgType of ['Developer', 'Production']) {
        const guard = wireGuard({ allowed: true });
        (deps.orgManager.getOrg as Mock).mockReturnValue({
          orgType,
          metadata: { edition: 'Developer Edition' },
        });
        const orchestrator = createMockOrchestrator({
          generatePlan: vi.fn().mockReturnValue(GUARD_PLAN),
        });
        await scanAndPlan(orchestrator);

        await handler.handle(executeMsg());

        expect(guard.check.mock.calls[0][0]).toMatchObject({
          orgId: 'tgt',
          orgTier: 'development',
          module: 'autopilot',
        });
      }
    });

    it('runs the plan neutralizing emails and phone numbers unless the review said to keep them', async () => {
      wireGuard({ allowed: true });
      mockTargetOrgType('Sandbox');
      const orchestrator = createMockOrchestrator({
        generatePlan: vi.fn().mockReturnValue(GUARD_PLAN),
      });
      await scanAndPlan(orchestrator);

      await handler.handle(executeMsg());
      expect(vi.mocked(orchestrator.executePlan).mock.calls[0].at(-1)).toEqual({});

      await scanAndPlan(orchestrator);
      await handler.handle(
        inboundRequest({
          id: 'exec-keep',
          type: 'autopilot:execute',
          timestamp: Date.now(),
          payload: { grappeThreshold: 0, keepContactPoints: true },
        } as BaseMessage),
      );
      expect(vi.mocked(orchestrator.executePlan).mock.calls[1].at(-1)).toEqual({
        keepContactPoints: true,
      });
    });

    it('refuses with NOT_INITIALIZED and inserts nothing when no Production Guard was injected', async () => {
      // A host that never wired the guard used to skip it and run the plan,
      // on a production target as on any other.
      deps.infraServices = undefined;
      mockTargetOrgType('Production');
      const orchestrator = createMockOrchestrator({
        generatePlan: vi.fn().mockReturnValue(GUARD_PLAN),
      });
      await scanAndPlan(orchestrator);

      await handler.handle(executeMsg());

      expect(orchestrator.executePlan).not.toHaveBeenCalled();
      const errors = postedMessages(deps).filter((m) => m.type === 'autopilot:error');
      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatchObject({
        correlationId: 'exec-guard',
        payload: { code: 'NOT_INITIALIZED' },
      });
      // Said by the page in the interface language, by its code: no
      // notification beside it repeats the refusal in English.
      expect(postedMessages(deps).filter((m) => m.type === 'notification')).toEqual([]);
      // Recorded as the guard's own refusals are, with the code that says why.
      const trail = vi
        .mocked(deps.configStore.set)
        .mock.calls.filter(([key]) => key === 'audit:trail');
      expect(trail.at(-1)?.[1]).toEqual([
        expect.objectContaining({
          action: 'autopilot_execute',
          operationId: 'exec-guard',
          outcome: 'stopped',
          details: { code: 'NOT_INITIALIZED' },
        }),
      ]);
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

      expect(guard.check).toHaveBeenCalledTimes(1);
      expect(guard.confirmIfNeeded).not.toHaveBeenCalled();
      expect(orchestrator.executePlan).not.toHaveBeenCalled();
      const errors = postedMessages(deps).filter((m) => m.type === 'autopilot:error');
      expect(errors).toHaveLength(1);
      expect(
        (errors[0] as BaseMessage & { payload: { message: string } }).payload.message,
      ).toContain('insert is not allowed on production org tgt');
      // The code the page says it by, in the interface language.
      expect((errors[0] as BaseMessage & { payload: { code: string } }).payload.code).toBe(
        'GUARD_BLOCKED',
      );
      // And no notification repeating it in English beside the page's own.
      expect(postedMessages(deps).filter((m) => m.type === 'notification')).toEqual([]);
    });

    it('cancels the execution when the user declines the production confirmation', async () => {
      const guard = wireGuard({
        allowed: true,
        requiresConfirmation: true,
        confirmed: false,
      });
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
      expect((errors[0] as BaseMessage & { payload: { code: string } }).payload.code).toBe(
        'GUARD_DECLINED',
      );
      expect(postedMessages(deps).filter((m) => m.type === 'notification')).toEqual([]);
    });

    it('asks before executing on a target the registry does not know, and inserts nothing when declined', async () => {
      // A real guard, and getOrg left unstubbed: the org named at scan time is
      // not in the registry, so nothing shows it is a sandbox. It was classed
      // as development, and the plan ran without a word to the user.
      const requestConfirmation = vi.fn().mockResolvedValue(false);
      const guard = new ProductionGuard({ requestConfirmation });
      const check = vi.spyOn(guard, 'check');
      deps.infraServices = {
        performanceTracker: { start: vi.fn(), complete: vi.fn() },
        productionGuard: guard,
        offlineManager: undefined,
        piiDetector: undefined,
      } as unknown as NonNullable<HandlerDeps['infraServices']>;
      const orchestrator = createMockOrchestrator({
        generatePlan: vi.fn().mockReturnValue(GUARD_PLAN),
      });
      await scanAndPlan(orchestrator);

      await handler.handle(executeMsg());

      expect(requestConfirmation).toHaveBeenCalledWith(
        'INSERT 0 Account record(s) on production org tgt [module: autopilot]',
        'production',
      );
      expect(check.mock.calls.map(([request]) => request.orgTier)).toEqual(['production']);
      expect(orchestrator.executePlan).not.toHaveBeenCalled();
      const errors = postedMessages(deps).filter((m) => m.type === 'autopilot:error');
      expect(errors).toHaveLength(1);
      expect(
        (errors[0] as BaseMessage & { payload: { message: string } }).payload.message,
      ).toContain('production confirmation declined');
    });

    it('lets sandbox executions through once the guard has judged them', async () => {
      const guard = wireGuard({ allowed: true, requiresConfirmation: false });
      mockTargetOrgType('Sandbox');
      const orchestrator = createMockOrchestrator({
        generatePlan: vi.fn().mockReturnValue(GUARD_PLAN),
      });
      await scanAndPlan(orchestrator);

      await handler.handle(executeMsg());

      expect(guard.check).toHaveBeenCalledTimes(1);
      expect(guard.check.mock.calls[0][0]).toMatchObject({
        orgId: 'tgt',
        orgTier: 'development',
        module: 'autopilot',
      });
      expect(orchestrator.executePlan).toHaveBeenCalledTimes(1);
      const errors = postedMessages(deps).filter((m) => m.type === 'autopilot:error');
      expect(errors).toHaveLength(0);
    });
  });

  describe('write gate', () => {
    const PLAN = {
      waves: [{ order: 0, objects: ['Lead'], dependsOn: [] }],
      totalRecords: 3_000,
      estimatedDurationSec: 1,
      estimatedApiCalls: 2,
      complianceFramework: 'none',
      anonymizationSummary: { totalRules: 0, rulesByType: {} },
      cycleResolutions: [],
    };

    /**
     * Scan, plan and execute a plan of 3 000 leads into a target with
     * `remainingMB` left; with `automation`, what the target runs on them,
     * and the single emails it has left today.
     */
    async function run(options: {
      remainingMB: number;
      confirmAboveRecords?: number;
      answer?: 'confirmed' | 'declined';
      automation?: ForgeTargetAutomation;
      /** The answer of a read of the target's automation that fails. */
      automationFails?: string;
      singleEmailsLeft?: number;
      /** Another plan than the leads', with the scan's counts of it. */
      scanned?: {
        plan: typeof PLAN;
        recordCounts: Map<string, number>;
        personAccounts: Map<string, number>;
      };
      /** What the connection to the target answers besides its limits. */
      conn?: Record<string, unknown>;
    }) {
      const read = vi.fn(async (_org: string, objects: readonly string[]) => {
        if (options.automationFails !== undefined) throw new Error(options.automationFails);
        return options.automation ?? quietTarget(objects);
      });
      // A target that runs nothing on the plan's objects, unless told; the
      // handler's own reader when the test hands the connection it reads.
      if (!options.conn) handler.setTargetAutomation({ read });
      const confirmRun = vi.fn(async () => options.answer ?? 'confirmed');
      const guard = new ProductionGuard({
        requestRunConfirmation: async () => (await confirmRun()) === 'confirmed',
      });
      const asked = vi.spyOn(guard, 'confirmRun');
      deps.infraServices = { productionGuard: guard } as unknown as HandlerDeps['infraServices'];
      deps.services = {
        getSandforgeSetting: <T>(key: string, fallback: T): T =>
          (key === 'safety.confirmAboveRecords' && options.confirmAboveRecords !== undefined
            ? options.confirmAboveRecords
            : fallback) as T,
      } as unknown as HandlerDeps['services'];
      (deps.orgManager.getOrg as Mock).mockReturnValue({ orgType: 'Sandbox', alias: 'TGT' });
      const orchestrator = createMockOrchestrator({
        scanSchemas: vi.fn().mockResolvedValue({
          objectDescribes: new Map(),
          recordCounts: options.scanned?.recordCounts ?? new Map([['Lead', 3_000]]),
          parentIds: new Map(),
          personAccounts: options.scanned?.personAccounts ?? new Map(),
          totalObjectsScanned: 1,
        }),
        generatePlan: vi.fn().mockReturnValue(options.scanned?.plan ?? PLAN),
      });
      handler.setOrchestrator(orchestrator);
      mockGetConn.mockResolvedValue({
        ...options.conn,
        request: vi.fn(async () => ({
          DataStorageMB: { Max: 200, Remaining: options.remainingMB },
          SingleEmail: { Max: 15, Remaining: options.singleEmailsLeft ?? 15 },
        })),
      } as never);
      await handler.handle(scanMsg('scan-gate'));
      await handler.handle(
        inboundRequest({
          id: 'plan-gate',
          type: 'autopilot:generate-plan',
          timestamp: Date.now(),
          payload: { complianceFramework: 'none' },
        } as BaseMessage),
      );
      await handler.handle(
        inboundRequest({
          id: 'exec-gate',
          type: 'autopilot:execute',
          timestamp: Date.now(),
          payload: { grappeThreshold: 0 },
        } as BaseMessage),
      );
      const errors = postedMessages(deps).filter((m) => m.type === 'autopilot:error') as Array<
        BaseMessage & { payload: { code?: string; message: string } }
      >;
      return { orchestrator, asked, errors, read };
    }

    /** A lead flow of the target that sends one single email for each lead created. */
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
              permissions: [],
              messages: [{ kind: 'email', name: 'Send welcome', limit: 'SingleEmail' }],
            },
          ],
          triggers: [],
        },
      ],
      unread: [],
      conditionsNotRead: 0,
      conditionsBound: 25,
      requests: 4,
    };

    it("reads the target's automation through its own reader, with none handed to it", async () => {
      // The reader was Forge's, handed over once Forge's composition had
      // loaded: a run started before, the Forge page never opened, counted
      // none of the emails the target's flows send.
      const asked: string[] = [];
      const page = (records: unknown[]) => ({ totalSize: records.length, done: true, records });
      const answered = vi.fn(async (soql: string) => {
        asked.push(soql);
        return page([]);
      });

      const { orchestrator, errors } = await run({
        remainingMB: 150,
        conn: {
          version: '66.0',
          query: answered,
          queryMore: vi.fn(async () => page([])),
          tooling: { query: answered, queryMore: vi.fn(async () => page([])) },
        },
      });

      expect(asked.some((soql) => /FROM FlowDefinitionView/.test(soql))).toBe(true);
      expect(
        vi
          .mocked(deps.log)
          .mock.calls.some(([line]) => String(line).includes("no reader of the target org's")),
      ).toBe(false);
      expect(errors).toEqual([]);
      expect(orchestrator.executePlan).toHaveBeenCalledTimes(1);
    });

    it("asks before a plan the target's flows would send more emails for than it has left today, and writes nothing when declined", async () => {
      // A Developer Edition sends fifteen single emails a day: the 3 000 leads
      // would each send one, and every lead past the fifteenth would be refused.
      const { orchestrator, asked, errors, read } = await run({
        remainingMB: 150,
        confirmAboveRecords: 5_000,
        automation: LEAD_FLOW,
        answer: 'declined',
      });

      expect(read).toHaveBeenCalledWith('tgt', ['Lead']);
      expect(asked).toHaveBeenCalledWith(
        expect.objectContaining({
          stage: 'write',
          module: 'autopilot',
          emails: [
            {
              limit: 'SingleEmail',
              emails: 3_000,
              remaining: 15,
              max: 15,
              objects: [{ objectApiName: 'Lead', perRecord: 1 }],
            },
          ],
        }),
      );
      expect(orchestrator.executePlan).not.toHaveBeenCalled();
      expect(errors.map((e) => e.payload.code)).toEqual(['AUTOPILOT_WRITE_DECLINED']);
    });

    it("asks before a plan whose target's flows could not be read, saying their emails were not counted, and writes nothing when declined", async () => {
      // Forge and Sync ask when what the target runs could not be read: its
      // emails were not counted at all. Autopilot logged it and wrote.
      const { orchestrator, asked, errors } = await run({
        remainingMB: 150,
        confirmAboveRecords: 5_000,
        automation: {
          ...LEAD_FLOW,
          objects: [],
          unread: [
            { part: 'flows', reason: 'INSUFFICIENT_ACCESS: no access to FlowDefinitionView' },
          ],
        },
        answer: 'declined',
      });

      expect(asked).toHaveBeenCalledWith(
        expect.objectContaining({
          stage: 'write',
          module: 'autopilot',
          emailsUncounted:
            "the target's flows: INSUFFICIENT_ACCESS: no access to FlowDefinitionView",
        }),
      );
      expect(orchestrator.executePlan).not.toHaveBeenCalled();
      expect(errors.map((e) => e.payload.code)).toEqual(['AUTOPILOT_WRITE_DECLINED']);
    });

    it("asks before a plan when the target's automation could not be read at all, and runs once confirmed", async () => {
      const { orchestrator, asked } = await run({
        remainingMB: 150,
        confirmAboveRecords: 5_000,
        automationFails: 'timed out',
      });

      expect(asked).toHaveBeenCalledWith(
        expect.objectContaining({ emailsUncounted: "the target's automation: timed out" }),
      );
      expect(orchestrator.executePlan).toHaveBeenCalledTimes(1);
    });

    it('asks nothing of a plan whose emails fit in what the target has left', async () => {
      const { orchestrator, asked } = await run({
        remainingMB: 150,
        confirmAboveRecords: 5_000,
        automation: LEAD_FLOW,
        singleEmailsLeft: 5_000,
      });

      expect(asked).not.toHaveBeenCalled();
      expect(orchestrator.executePlan).toHaveBeenCalledTimes(1);
    });

    it("refuses a plan past the target's data storage before anything is written", async () => {
      // 3 000 records take about 5.9 MB; the target has 1 MB left.
      const { orchestrator, asked, errors } = await run({ remainingMB: 1 });

      expect(orchestrator.executePlan).not.toHaveBeenCalled();
      expect(asked).not.toHaveBeenCalled();
      expect(errors.map((e) => e.payload.code)).toEqual(['AUTOPILOT_STORAGE_EXCEEDED']);
      expect(errors[0].payload.message).toContain('Nothing was written.');
    });

    it('asks past sandforge.safety.confirmAboveRecords with the counts of the plan, then runs', async () => {
      const { orchestrator, asked, errors } = await run({ remainingMB: 150 });

      expect(asked).toHaveBeenCalledWith(
        expect.objectContaining({
          stage: 'write',
          module: 'autopilot',
          org: 'TGT',
          objects: [{ objectApiName: 'Lead', rows: 3_000 }],
          aboveRecords: 2_000,
          counted: true,
        }),
      );
      expect(errors).toEqual([]);
      expect(orchestrator.executePlan).toHaveBeenCalledTimes(1);
    });

    it('writes nothing when the question is declined', async () => {
      const { orchestrator, errors } = await run({ remainingMB: 150, answer: 'declined' });

      expect(orchestrator.executePlan).not.toHaveBeenCalled();
      expect(errors.map((e) => e.payload.code)).toEqual(['AUTOPILOT_WRITE_DECLINED']);
    });

    it('asks nothing of a plan under the setting that fits', async () => {
      const { orchestrator, asked } = await run({ remainingMB: 150, confirmAboveRecords: 5_000 });

      expect(asked).not.toHaveBeenCalled();
      expect(orchestrator.executePlan).toHaveBeenCalledTimes(1);
    });

    it('sizes the person accounts of the plan at 4 KB, and refuses them past the storage left', async () => {
      // 300 person accounts take about 1.2 MB, as Salesforce counts them; at
      // 2 KB each the gate said 0.6 MB, and let them into a target with 1 MB.
      const { orchestrator, errors } = await run({
        remainingMB: 1,
        confirmAboveRecords: 5_000,
        scanned: {
          plan: { ...PLAN, waves: [{ order: 0, objects: ['Account'], dependsOn: [] }] },
          recordCounts: new Map([['Account', 300]]),
          personAccounts: new Map([['Account', 300]]),
        },
      });

      expect(orchestrator.executePlan).not.toHaveBeenCalled();
      expect(errors.map((e) => e.payload.code)).toEqual(['AUTOPILOT_STORAGE_EXCEEDED']);
    });
  });

  describe('the bounds of the walk', () => {
    it('hands the scan the bounds a request names, and none of its own otherwise', async () => {
      const orchestrator = createMockOrchestrator();
      handler.setOrchestrator(orchestrator);
      mockGetConn.mockResolvedValue(ROOMY_CONN as never);
      const scan = (id: string, extra: Record<string, unknown>) =>
        handler.handle(
          inboundRequest({
            id,
            type: 'autopilot:scan-schema',
            timestamp: Date.now(),
            payload: {
              sourceOrgId: 'src',
              targetOrgId: 'tgt',
              selectedObjects: ['Lead'],
              includeStandardObjects: true,
              ...extra,
            },
          } as BaseMessage),
        );

      await scan('scan-bounded', { maxDepth: 2, maxObjects: 12 });
      await scan('scan-default', {});
      await scan('scan-unbounded', { maxObjects: 100_000 });

      const configs = (orchestrator.scanSchemas as Mock).mock.calls.map((call) => call[2]);
      expect(configs[0]).toEqual({
        selectedObjects: ['Lead'],
        includeStandardObjects: true,
        maxDepth: 2,
        maxObjects: 12,
      });
      expect(configs[1]).toEqual({ selectedObjects: ['Lead'], includeStandardObjects: true });
      // Past Forge's own limit, refused before any scan.
      expect(configs).toHaveLength(2);
    });
  });

  describe('personal fields', () => {
    it("hands the compliance profile the detector's fields when a framework anonymizes", async () => {
      // Without an AI scan the profile had no detection at all, and a GDPR
      // plan anonymized nothing.
      const contact = {
        name: 'Contact',
        label: 'Contact',
        custom: false,
        keyPrefix: '003',
        recordTypeInfos: [],
        fields: ['FirstName', 'LastName', 'Email'].map((name) => ({
          name,
          label: name,
          type: name === 'Email' ? 'email' : 'string',
          nillable: true,
          createable: true,
          updateable: true,
          unique: false,
          externalId: false,
          referenceTo: [],
          relationshipName: null,
          defaultValue: null,
        })),
      };
      const orchestrator = createMockOrchestrator({
        scanSchemas: vi.fn().mockResolvedValue({
          objectDescribes: new Map([['Contact', contact]]),
          recordCounts: new Map([['Contact', 1]]),
          parentIds: new Map(),
          totalObjectsScanned: 1,
        }),
      });
      handler.setOrchestrator(orchestrator);
      mockGetConn.mockResolvedValue(ROOMY_CONN as never);
      await handler.handle(scanMsg('scan-pii'));
      for (const complianceFramework of ['gdpr', 'none']) {
        await handler.handle(
          inboundRequest({
            id: `plan-${complianceFramework}`,
            type: 'autopilot:generate-plan',
            timestamp: Date.now(),
            payload: { complianceFramework },
          } as BaseMessage),
        );
      }

      const calls = (orchestrator.buildCompliance as Mock).mock.calls;
      expect(calls[0][0]).toBe('gdpr');
      expect(calls[0][2].map((d: { fieldApiName: string }) => d.fieldApiName).sort()).toEqual([
        'Email',
        'FirstName',
        'LastName',
      ]);
      expect(calls[1]).toEqual(['none', [], []]);
    });
  });
});
