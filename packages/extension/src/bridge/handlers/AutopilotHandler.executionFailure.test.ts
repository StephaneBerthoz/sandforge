import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { AutopilotHandler } from './AutopilotHandler.js';
import type { HandlerDeps, InboundRequest } from './HandlerTypes.js';
import type { BaseMessage } from '@sandforge/shared';

vi.mock('../../core/connection/ConnectionHelper.js', () => ({
  getJsforceConnection: vi.fn(),
}));

import { getJsforceConnection } from '../../core/connection/ConnectionHelper.js';
import { inboundRequest } from '../../test/mockFactories.js';

const mockGetConn = vi.mocked(getJsforceConnection);

/** Plan the mock orchestrator returns: one wave, one object. */
const PLAN = {
  waves: [{ order: 0, objects: ['Account'], dependsOn: [] }],
  totalRecords: 5,
  estimatedDurationSec: 1,
  estimatedApiCalls: 2,
  complianceFramework: 'none',
  anonymizationSummary: { totalRules: 0, rulesByType: {} },
  cycleResolutions: [],
};

/** Minimal handler deps: only broker/log/nextId are exercised here. */
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

/** Mock orchestrator whose executePlan behaviour each test overrides. */
function createMockOrchestrator(
  executePlan: Mock,
): Parameters<AutopilotHandler['setOrchestrator']>[0] {
  return {
    scanSchemas: vi.fn().mockResolvedValue({ recordCounts: new Map(), totalObjectsScanned: 1 }),
    buildGraph: vi.fn().mockReturnValue({ nodes: [], edges: [] }),
    buildCompliance: vi.fn().mockReturnValue({ profile: {}, rules: [] }),
    generatePlan: vi.fn().mockReturnValue(PLAN),
    executePlan,
    generateReport: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    skip: vi.fn(),
  } as unknown as Parameters<AutopilotHandler['setOrchestrator']>[0];
}

/** Messages posted to the webview so far. */
function postedMessages(deps: HandlerDeps): Array<BaseMessage & { payload?: unknown }> {
  const postToWebview = deps.broker.postToWebview as Mock<(message: BaseMessage) => void>;
  return postToWebview.mock.calls.map((call) => call[0]);
}

describe('AutopilotHandler — execution failures', () => {
  let handler: AutopilotHandler;
  let deps: HandlerDeps;

  beforeEach(() => {
    vi.clearAllMocks();
    deps = createMockDeps();
    handler = new AutopilotHandler(deps);
  });

  /** Runs scan → generate-plan so the operation is ready to execute. */
  async function scanAndPlan(
    orchestrator: Parameters<AutopilotHandler['setOrchestrator']>[0],
  ): Promise<void> {
    handler.setOrchestrator(orchestrator);
    mockGetConn.mockResolvedValue({} as never);
    await handler.handle(
      inboundRequest({
        id: 'scan-1',
        type: 'autopilot:scan-schema',
        timestamp: Date.now(),
        payload: {
          sourceOrgId: 'src',
          targetOrgId: 'tgt',
          selectedObjects: [],
          includeStandardObjects: false,
        },
      } as BaseMessage),
    );
    await handler.handle(
      inboundRequest({
        id: 'plan-1',
        type: 'autopilot:generate-plan',
        timestamp: Date.now(),
        payload: { complianceFramework: 'gdpr' },
      } as BaseMessage),
    );
    (deps.broker.postToWebview as Mock).mockClear();
  }

  /** Builds the autopilot:execute request. */
  function executeMsg(): InboundRequest {
    return inboundRequest({
      id: 'exec-1',
      type: 'autopilot:execute',
      timestamp: Date.now(),
      payload: { grappeThreshold: 0 },
    } as BaseMessage);
  }

  it('reports a crashed run as autopilot:error, never as autopilot:completed', async () => {
    const orchestrator = createMockOrchestrator(
      vi.fn().mockRejectedValue(new Error('INVALID_SESSION_ID: session expired')),
    );
    await scanAndPlan(orchestrator);

    await handler.handle(executeMsg());

    const posted = postedMessages(deps);
    expect(posted.filter((m) => m.type === 'autopilot:completed')).toHaveLength(0);

    const errors = posted.filter((m) => m.type === 'autopilot:error');
    expect(errors).toHaveLength(1);
    expect((errors[0] as BaseMessage & { payload: { message: string } }).payload.message).toContain(
      'INVALID_SESSION_ID: session expired',
    );

    const notifications = posted.filter((m) => m.type === 'notification');
    expect(notifications).toHaveLength(1);
    expect(
      (notifications[0] as BaseMessage & { payload: { message: string } }).payload.message,
    ).toContain('INVALID_SESSION_ID: session expired');
  });

  it('reports the failing node with the error the executor recorded', async () => {
    const orchestrator = createMockOrchestrator(
      vi.fn().mockResolvedValue({
        totalSuccess: 0,
        totalFailure: 5,
        totalSkipped: 0,
        elapsedMs: 12,
        completedObjects: [],
        failedObjects: ['Account'],
        skippedObjects: [],
        nodeErrors: {
          Account: 'REQUIRED_FIELD_MISSING: Required fields are missing: [Name]',
        },
      }),
    );
    await scanAndPlan(orchestrator);

    await handler.handle(executeMsg());

    const failed = postedMessages(deps).find(
      (m) =>
        m.type === 'autopilot:node-progress' &&
        (m as BaseMessage & { payload: { status: string } }).payload.status === 'failed',
    ) as BaseMessage & { payload: { objectName: string; error: string } };

    expect(failed).toBeDefined();
    expect(failed.payload.objectName).toBe('Account');
    expect(failed.payload.error).toBe(
      'REQUIRED_FIELD_MISSING: Required fields are missing: [Name]',
    );
  });

  it('falls back to a generic node message when the failure has no recorded error', async () => {
    const orchestrator = createMockOrchestrator(
      vi.fn().mockResolvedValue({
        totalSuccess: 0,
        totalFailure: 5,
        totalSkipped: 0,
        elapsedMs: 12,
        completedObjects: [],
        failedObjects: ['Account'],
        skippedObjects: [],
      }),
    );
    await scanAndPlan(orchestrator);

    await handler.handle(executeMsg());

    const failed = postedMessages(deps).find(
      (m) =>
        m.type === 'autopilot:node-progress' &&
        (m as BaseMessage & { payload: { status: string } }).payload.status === 'failed',
    ) as BaseMessage & { payload: { error: string } };

    expect(failed.payload.error).toBe('Execution failed for Account');
  });
});
