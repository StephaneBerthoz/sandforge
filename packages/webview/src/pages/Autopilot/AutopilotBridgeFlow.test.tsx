import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import type { AutopilotGraph, ComplianceReport, ExecutionPlan } from '@sandforge/shared';
import '../../i18n';
import { AutopilotPage } from './AutopilotPage';
import { useAutopilotStore } from '../../stores/useAutopilotStore';

/**
 * End-to-end bridge flow test: real store, real message bus and real
 * useBridgeMutation/useBridgeQuery hooks — only the VSCode API transport is
 * mocked. Drives scan-schema → generate-plan → execute → node-progress →
 * completed → compliance-report plus error paths.
 */

/** Captured envelopes posted to the extension host. */
const mockPostMessage = vi.fn();

vi.mock('../../hooks/useVSCodeApi', () => ({
  useVSCodeApi: () => ({
    postMessage: mockPostMessage,
    getState: () => undefined,
    setState: () => undefined,
  }),
}));

/** Avoid reactflow in jsdom — graph rendering is covered by its own tests. */
vi.mock('./AutopilotGraph', () => ({
  AutopilotGraph: () => <div data-testid="autopilot-graph-mock" />,
}));

vi.mock('../../stores/useOrgStore', () => ({
  useOrgStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      orgs: [
        {
          id: 'org-1',
          alias: 'DevSandbox',
          username: 'dev@test.com',
          instanceUrl: 'https://dev.salesforce.com',
          status: 'connected',
          orgType: 'sandbox',
          safetyTier: 'safe',
        },
        {
          id: 'org-2',
          alias: 'QASandbox',
          username: 'qa@test.com',
          instanceUrl: 'https://qa.salesforce.com',
          status: 'connected',
          orgType: 'sandbox',
          safetyTier: 'caution',
        },
      ],
      selectedOrgId: 'org-1',
    }),
}));

vi.mock('../../stores/useAppStore', () => ({
  useAppStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({ navigate: vi.fn(), currentRoute: 'autopilot' }),
}));

/** Envelope shape posted by useSendMessage. */
interface PostedEnvelope {
  protocolVersion: string;
  correlationId?: string;
  payload: { id: string; type: string; payload?: Record<string, unknown> };
}

/** Return the inner message of the last posted request of the given type. */
function lastRequestOfType(type: string): PostedEnvelope['payload'] {
  const envelopes = mockPostMessage.mock.calls.map((c) => c[0] as PostedEnvelope);
  const match = envelopes.filter((e) => e.payload.type === type).pop();
  if (!match) throw new Error(`No posted request of type ${type}`);
  return match.payload;
}

/** Simulate an extension-host message arriving in the webview. */
function dispatchBridgeMessage(type: string, payload: unknown, correlationId?: string): void {
  act(() => {
    window.dispatchEvent(
      new MessageEvent('message', {
        data: {
          id: `ext-${Date.now()}-${Math.random()}`,
          type,
          timestamp: Date.now(),
          ...(correlationId ? { correlationId } : {}),
          payload,
        },
      }),
    );
  });
}

/** Reply to the last request of `requestType` with a correlated response. */
function respondTo(requestType: string, responseType: string, payload: unknown): void {
  dispatchBridgeMessage(responseType, payload, lastRequestOfType(requestType).id);
}

/** Fixture graph used by scan/plan responses. */
const GRAPH: AutopilotGraph = {
  nodes: [
    {
      objectApiName: 'Account',
      recordCount: 100,
      estimatedApiCalls: 1,
      piiFields: [],
      anonymizationRules: [],
      status: 'pending',
      progress: 0,
      insertOrder: 0,
      level: 0,
      successCount: 0,
      failureCount: 0,
      errors: [],
      elapsedMs: 0,
      apiCallsUsed: 0,
    },
    {
      objectApiName: 'Contact',
      recordCount: 80,
      estimatedApiCalls: 1,
      piiFields: [],
      anonymizationRules: [],
      status: 'pending',
      progress: 0,
      insertOrder: 1,
      level: 1,
      successCount: 0,
      failureCount: 0,
      errors: [],
      elapsedMs: 0,
      apiCallsUsed: 0,
    },
  ],
  edges: [],
  cycles: [],
  stats: {
    totalObjects: 2,
    totalRelationships: 0,
    cycleCount: 0,
    maxDepth: 1,
    totalRecords: 180,
    totalEstimatedApiCalls: 2,
  },
};

/** Fixture plan used by plan-ready responses. */
const PLAN: ExecutionPlan = {
  waves: [
    { order: 0, objects: ['Account'], dependsOn: [] },
    { order: 1, objects: ['Contact'], dependsOn: [0] },
  ],
  totalRecords: 180,
  estimatedDurationSec: 120,
  estimatedApiCalls: 4,
  complianceFramework: 'gdpr',
  anonymizationSummary: {
    totalPiiFields: 2,
    totalFieldsToAnonymize: 2,
    methodBreakdown: { hash: 2 } as ExecutionPlan['anonymizationSummary']['methodBreakdown'],
    objectsWithPii: ['Contact'],
  },
  cycleResolutions: [],
};

/** Fixture compliance report. */
const REPORT: ComplianceReport = {
  id: 'report-1',
  framework: 'gdpr',
  generatedAt: '2026-08-06T00:00:00.000Z',
  sourceOrgId: 'org-1',
  targetOrgId: 'org-2',
  totalFieldsScanned: 120,
  piiFieldsDetected: 2,
  piiFieldsAnonymized: 2,
  entries: [
    {
      objectApiName: 'Contact',
      fieldApiName: 'Email',
      piiCategory: 'PII',
      anonymizationMethod: 'hash',
      recordsAnonymized: 80,
      ruleApplied: 'gdpr-email',
      userOverridden: false,
    },
  ],
  objectSummaries: [],
  overallStatus: 'pass',
  checksumSha256: 'abc123',
};

describe('Autopilot bridge flow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAutopilotStore.getState().reset();
  });

  /** Drive the wizard from connect to the review step via real bridge round-trips. */
  const driveToReview = (): void => {
    fireEvent.click(screen.getByTestId('source-org-org-1'));
    fireEvent.click(screen.getByTestId('target-org-org-2'));
    fireEvent.click(screen.getByTestId('seed-wizard-next'));
    respondTo('autopilot:scan-schema', 'autopilot:schema-result', { graph: GRAPH });
    fireEvent.click(screen.getByTestId('seed-wizard-next'));
    fireEvent.click(screen.getByTestId('seed-wizard-next'));
    respondTo('autopilot:generate-plan', 'autopilot:plan-ready', { plan: PLAN, graph: GRAPH });
  };

  it('should run the full scan → plan → execute → progress → completed → report flow', () => {
    render(<AutopilotPage />);

    // ── Step 1: connect + scan-schema ──────────────────────────────────
    fireEvent.click(screen.getByTestId('source-org-org-1'));
    fireEvent.click(screen.getByTestId('target-org-org-2'));
    fireEvent.click(screen.getByTestId('seed-wizard-next'));

    const scanRequest = lastRequestOfType('autopilot:scan-schema');
    expect(scanRequest.payload).toEqual({
      sourceOrgId: 'org-1',
      targetOrgId: 'org-2',
      selectedObjects: [],
      includeStandardObjects: true,
    });

    dispatchBridgeMessage('autopilot:schema-result', { graph: GRAPH }, scanRequest.id);
    expect(useAutopilotStore.getState().step).toBe('objects');
    expect(screen.getByTestId('object-Account')).toBeDefined();
    expect(screen.getByTestId('object-Contact')).toBeDefined();

    // ── Step 2: all objects selected → straight to compliance ─────────
    fireEvent.click(screen.getByTestId('seed-wizard-next'));
    expect(useAutopilotStore.getState().step).toBe('compliance');

    // ── Step 3: framework + generate-plan ──────────────────────────────
    fireEvent.click(screen.getByTestId('framework-gdpr'));
    fireEvent.click(screen.getByTestId('seed-wizard-next'));

    const planRequest = lastRequestOfType('autopilot:generate-plan');
    expect(planRequest.payload).toEqual({
      complianceFramework: 'gdpr',
      maxRecordsPerObject: 0,
      objectFilters: {},
      overrides: [],
    });

    dispatchBridgeMessage('autopilot:plan-ready', { plan: PLAN, graph: GRAPH }, planRequest.id);
    expect(useAutopilotStore.getState().step).toBe('review');
    expect(screen.getByTestId('stat-waves').textContent).toContain('2');
    expect(screen.getByTestId('stat-pii-fields').textContent).toContain('2');

    // ── Step 4: execute ────────────────────────────────────────────────
    fireEvent.click(screen.getByTestId('execute-button'));

    const executeRequest = lastRequestOfType('autopilot:execute');
    expect(executeRequest.payload).toEqual({ grappeThreshold: 0 });
    expect(useAutopilotStore.getState().step).toBe('executing');
    expect(useAutopilotStore.getState().executionStatus).toBe('executing');
    expect(useAutopilotStore.getState().liveStats.recordsTotal).toBe(180);
    expect(useAutopilotStore.getState().liveStats.totalWaves).toBe(2);
    expect(screen.getByTestId('control-panel')).toBeDefined();

    // ── Real-time progress ─────────────────────────────────────────────
    dispatchBridgeMessage(
      'autopilot:node-progress',
      { nodeId: 'Account', objectName: 'Account', status: 'processing', wave: 0 },
      executeRequest.id,
    );
    expect(
      useAutopilotStore.getState().graph?.nodes.find((n) => n.objectApiName === 'Account')?.status,
    ).toBe('extracting');

    dispatchBridgeMessage(
      'autopilot:node-progress',
      { nodeId: 'Account', objectName: 'Account', status: 'completed', wave: 0, recordCount: 100 },
      executeRequest.id,
    );
    const accountNode = useAutopilotStore
      .getState()
      .graph?.nodes.find((n) => n.objectApiName === 'Account');
    expect(accountNode?.status).toBe('completed');
    expect(accountNode?.successCount).toBe(100);

    // ── Pause / resume / skip ──────────────────────────────────────────
    fireEvent.click(screen.getByTestId('control-pause-resume'));
    expect(lastRequestOfType('autopilot:pause')).toBeDefined();
    expect(useAutopilotStore.getState().executionStatus).toBe('paused');

    fireEvent.click(screen.getByTestId('control-pause-resume'));
    expect(lastRequestOfType('autopilot:resume')).toBeDefined();
    expect(useAutopilotStore.getState().executionStatus).toBe('executing');

    act(() => {
      useAutopilotStore.getState().selectNode('Contact');
    });
    fireEvent.click(screen.getByTestId('control-skip'));
    expect(lastRequestOfType('autopilot:skip-node').payload).toEqual({
      objectApiName: 'Contact',
    });
    expect(
      useAutopilotStore.getState().graph?.nodes.find((n) => n.objectApiName === 'Contact')?.status,
    ).toBe('skipped');

    // ── Completion ─────────────────────────────────────────────────────
    dispatchBridgeMessage(
      'autopilot:completed',
      {
        totalRecords: 180,
        totalSuccessCount: 178,
        totalFailureCount: 2,
        totalElapsedMs: 5000,
        totalApiCalls: 4,
      },
      executeRequest.id,
    );
    expect(useAutopilotStore.getState().step).toBe('completed');
    expect(useAutopilotStore.getState().executionStatus).toBe('completed');
    expect(useAutopilotStore.getState().liveStats.recordsProcessed).toBe(178);

    // ── Compliance report ──────────────────────────────────────────────
    fireEvent.click(screen.getByTestId('view-compliance-report'));
    expect(lastRequestOfType('autopilot:compliance-report')).toBeDefined();

    // `{ report }`, because that is what AutopilotHandler posts and what
    // `AutopilotComplianceReportReady` declares. Answering with a bare REPORT
    // is how the panel shipped broken: this flow test was green against a
    // message shape the extension has never once emitted.
    respondTo('autopilot:compliance-report', 'autopilot:compliance-report', {
      report: REPORT,
    });
    expect(screen.getByTestId('compliance-report')).toBeDefined();
    expect(screen.getByTestId('report-framework').textContent).toContain('GDPR');
    expect(screen.getByText('gdpr-email')).toBeDefined();
  });

  it('should surface a scan error and stay on the connect step', () => {
    render(<AutopilotPage />);
    fireEvent.click(screen.getByTestId('source-org-org-1'));
    fireEvent.click(screen.getByTestId('target-org-org-2'));
    fireEvent.click(screen.getByTestId('seed-wizard-next'));

    const scanRequest = lastRequestOfType('autopilot:scan-schema');
    dispatchBridgeMessage('autopilot:error', { message: 'describe failed' }, scanRequest.id);

    expect(screen.getByTestId('autopilot-scan-error')).toBeDefined();
    expect(screen.getByTestId('autopilot-scan-error').textContent).toContain('describe failed');
    expect(useAutopilotStore.getState().step).toBe('connect');
  });

  it('should return to review when execution is declined by the production guard', () => {
    render(<AutopilotPage />);
    driveToReview();

    fireEvent.click(screen.getByTestId('execute-button'));
    expect(useAutopilotStore.getState().step).toBe('executing');

    const executeRequest = lastRequestOfType('autopilot:execute');
    dispatchBridgeMessage(
      'autopilot:error',
      { message: 'Operation cancelled by user (production confirmation declined).' },
      executeRequest.id,
    );

    const state = useAutopilotStore.getState();
    expect(state.step).toBe('review');
    expect(state.executionStatus).toBe('failed');
    expect(screen.getByTestId('autopilot-execute-error')).toBeDefined();
    expect(screen.getByTestId('autopilot-execute-error').textContent).toContain(
      'production confirmation declined',
    );
  });
});
