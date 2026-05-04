import { describe, it, expect, vi, beforeEach } from 'vitest';
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
    await handler.handle({
      id: 'scan-1',
      type: 'autopilot:scan-schema',
      timestamp: Date.now(),
      payload: {
        sourceOrgId: 'src',
        targetOrgId: 'tgt',
        selectedObjects: [],
        includeStandardObjects: false,
      },
    } as BaseMessage);

    // Now generate plan
    const msg: BaseMessage & { payload: { complianceFramework: string } } = {
      id: 'req-ap-2',
      type: 'autopilot:generate-plan',
      timestamp: Date.now(),
      payload: { complianceFramework: 'GDPR' },
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
    await handler.handle({
      id: 'scan-exec',
      type: 'autopilot:scan-schema',
      timestamp: Date.now(),
      payload: {
        sourceOrgId: 'src',
        targetOrgId: 'tgt',
        selectedObjects: [],
        includeStandardObjects: false,
      },
    } as BaseMessage);

    await handler.handle({
      id: 'plan-exec',
      type: 'autopilot:generate-plan',
      timestamp: Date.now(),
      payload: { complianceFramework: 'GDPR' },
    } as BaseMessage);

    const postToWebview = deps.broker.postToWebview as ReturnType<typeof vi.fn>;
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
      (
        call: [
          BaseMessage & {
            correlationId?: string;
            payload: { status?: string; objectName?: string };
          },
        ],
      ) => call[0],
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
});
