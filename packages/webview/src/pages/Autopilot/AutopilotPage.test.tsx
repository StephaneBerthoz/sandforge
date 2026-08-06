import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '../../i18n';
import { AutopilotPage } from './AutopilotPage';

/** Mock message bus hooks used by AutopilotPage. */
vi.mock('../../hooks/useMessageBus', () => ({
  useMessageListener: vi.fn(),
  useSendMessage: () => vi.fn(),
}));

/** Mock the execute bridge mutation. */
const mockExecuteMutate = vi.fn();
vi.mock('../../hooks/useBridgeMutation', () => ({
  useBridgeMutation: () => ({
    mutate: mockExecuteMutate,
    data: null,
    loading: false,
    error: null,
    reset: vi.fn(),
  }),
}));

/** Avoid reactflow in jsdom — graph rendering is covered by its own tests. */
vi.mock('./AutopilotGraph', () => ({
  AutopilotGraph: () => <div data-testid="autopilot-graph-mock" />,
}));

/** Mutable autopilot store mock — default to wizard mode (step = 'connect'). */
let mockAutopilotState: Record<string, unknown>;

vi.mock('../../stores/useAutopilotStore', () => {
  const store = Object.assign(
    (selector: (state: Record<string, unknown>) => unknown) => selector(mockAutopilotState),
    { getState: () => mockAutopilotState },
  );
  return { useAutopilotStore: store };
});

/** Mock org store for the wizard. */
let mockOrgState: Record<string, unknown> = {
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
  selectedOrgId: 'org-1',
};

vi.mock('../../stores/useOrgStore', () => ({
  useOrgStore: (selector: (state: Record<string, unknown>) => unknown) => selector(mockOrgState),
}));

const mockNavigate = vi.fn();
vi.mock('../../stores/useAppStore', () => ({
  useAppStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({ navigate: mockNavigate, currentRoute: 'autopilot' }),
}));

const defaultAutopilotState = (): Record<string, unknown> => ({
  step: 'connect',
  liveStats: {
    recordsProcessed: 0,
    recordsTotal: 0,
    apiCallsUsed: 0,
    apiCallsEstimated: 0,
    elapsedMs: 0,
    currentWave: 0,
    totalWaves: 0,
  },
  executionStatus: 'idle',
  selectedNodeName: null,
  sourceOrgId: null,
  targetOrgId: null,
  selectedObjects: [],
  complianceFramework: 'none',
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
});

describe('AutopilotPage', () => {
  beforeEach(() => {
    mockAutopilotState = defaultAutopilotState();
    mockOrgState = {
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
      selectedOrgId: 'org-1',
    };
    mockNavigate.mockClear();
    mockExecuteMutate.mockClear();
  });

  it('should show empty state when no org selected', () => {
    mockOrgState = { orgs: [], selectedOrgId: null };
    render(<AutopilotPage />);
    expect(screen.getByTestId('empty-state')).toBeDefined();
    expect(screen.getByTestId('illustration-autopilot')).toBeDefined();
    expect(screen.getByTestId('empty-action-button')).toBeDefined();
  });

  it('should navigate to orgs when empty state CTA clicked', () => {
    mockOrgState = { orgs: [], selectedOrgId: null };
    render(<AutopilotPage />);
    fireEvent.click(screen.getByTestId('empty-action-button'));
    expect(mockNavigate).toHaveBeenCalledWith('orgs');
  });

  it('should render without crashing', () => {
    render(<AutopilotPage />);
    expect(screen.getByTestId('autopilot-page')).toBeDefined();
  });

  it('should render in wizard mode when step is connect', () => {
    render(<AutopilotPage />);
    expect(screen.getByTestId('autopilot-wizard')).toBeDefined();
  });

  it('should post autopilot:execute with grappeThreshold when execute is triggered', () => {
    mockAutopilotState = {
      ...defaultAutopilotState(),
      step: 'review',
      selectedObjects: ['Account'],
    };
    render(<AutopilotPage />);
    fireEvent.click(screen.getByTestId('execute-button'));
    expect(mockExecuteMutate).toHaveBeenCalledWith({ grappeThreshold: 0 });
    const state = mockAutopilotState as {
      setExecutionStatus: ReturnType<typeof vi.fn>;
      setStep: ReturnType<typeof vi.fn>;
    };
    expect(state.setExecutionStatus).toHaveBeenCalledWith('executing');
    expect(state.setStep).toHaveBeenCalledWith('executing');
  });

  it('should render the execution view (graph + control panel) when executing', () => {
    mockAutopilotState = {
      ...defaultAutopilotState(),
      step: 'executing',
      executionStatus: 'executing',
    };
    render(<AutopilotPage />);
    expect(screen.getByTestId('autopilot-graph-area')).toBeDefined();
    expect(screen.getByTestId('control-panel')).toBeDefined();
  });

  it('should show the compliance report button once completed', () => {
    mockAutopilotState = {
      ...defaultAutopilotState(),
      step: 'completed',
      executionStatus: 'completed',
    };
    render(<AutopilotPage />);
    expect(screen.getByTestId('view-compliance-report')).toBeDefined();
  });
});
