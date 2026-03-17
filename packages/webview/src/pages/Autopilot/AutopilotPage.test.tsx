import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import '../../i18n';
import { AutopilotPage } from './AutopilotPage';

/** Mock autopilot store — default to wizard mode (step = 'connect'). */
vi.mock('../../stores/useAutopilotStore', () => {
  const defaultState = {
    step: 'connect' as const,
    liveStats: {
      recordsProcessed: 0,
      recordsTotal: 0,
      apiCallsUsed: 0,
      apiCallsEstimated: 0,
      elapsedMs: 0,
      currentWave: 0,
      totalWaves: 0,
    },
    executionStatus: 'idle' as const,
    selectedNodeName: null,
    sourceOrgId: null,
    targetOrgId: null,
    selectedObjects: [],
    complianceFramework: 'none' as const,
    rules: [],
    graph: null,
    plan: null,
    errors: [],
    selectedNode: () => undefined,
    failedCount: () => 0,
    completedCount: () => 0,
    overallProgress: () => 0,
    setStep: vi.fn(),
    setSourceOrg: vi.fn(),
    setTargetOrg: vi.fn(),
    setSelectedObjects: vi.fn(),
    toggleObject: vi.fn(),
    setComplianceFramework: vi.fn(),
    setGraph: vi.fn(),
    setPlan: vi.fn(),
    setRules: vi.fn(),
    setExecutionStatus: vi.fn(),
    selectNode: vi.fn(),
    updateNodeStatus: vi.fn(),
    updateNodeProgress: vi.fn(),
    updateLiveStats: vi.fn(),
    addError: vi.fn(),
    reset: vi.fn(),
  };

  const store = Object.assign(
    (selector: (state: typeof defaultState) => unknown) => selector(defaultState),
    { getState: () => defaultState },
  );

  return { useAutopilotStore: store };
});

/** Mock org store for the wizard. */
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
      ],
    }),
}));

describe('AutopilotPage', () => {
  it('should render without crashing', () => {
    render(<AutopilotPage />);
    expect(screen.getByTestId('autopilot-page')).toBeDefined();
  });

  it('should render in wizard mode when step is connect', () => {
    render(<AutopilotPage />);
    expect(screen.getByTestId('autopilot-wizard')).toBeDefined();
  });
});
