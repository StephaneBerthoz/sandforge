import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '../../i18n';
import en from '../../i18n/locales/en.json';
import { AutopilotPage } from './AutopilotPage';
import { RUN_OUTLIVED_WAIT } from '../../hooks/useMessageResponse';
import { WRITE_RUN_TIMEOUT_MS } from '../../hooks/writeRunTimeout';

/** Mock message bus hooks used by AutopilotPage. */
vi.mock('../../hooks/useMessageBus', () => ({
  useMessageListener: vi.fn(),
  useSendMessage: () => vi.fn(),
}));

/** Mock the execute bridge mutation. */
const mockExecuteMutate = vi.fn();
/** How the execute request ended, as the page reads it; nothing yet by default. */
let executeEnded: { error: string | null; errorCode: string | null } = {
  error: null,
  errorCode: null,
};
/** The options the page asked the execute request with. */
let executeOptions: Record<string, unknown> | undefined;
vi.mock('../../hooks/useBridgeMutation', () => ({
  useBridgeMutation: (type: string, options?: Record<string, unknown>) => {
    if (type === 'autopilot:execute') executeOptions = options;
    return {
      mutate: mockExecuteMutate,
      data: null,
      loading: false,
      ...executeEnded,
      requestId: null,
      reset: vi.fn(),
    };
  },
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
    executeEnded = { error: null, errorCode: null };
  });

  it('waits on a run as long as any write run, and never offers to try it again', () => {
    render(<AutopilotPage />);
    expect(executeOptions).toMatchObject({
      timeoutMs: WRITE_RUN_TIMEOUT_MS,
      runOutlivesWait: true,
    });
  });

  it('stays on the run once it stops waiting for it, and says where to follow it', () => {
    // It went back to the review saying "Try again" while the run went on
    // writing: a second Execute wrote every table again.
    mockAutopilotState = {
      ...defaultAutopilotState(),
      step: 'executing',
      executionStatus: 'executing',
    };
    executeEnded = {
      error:
        'SandForge stopped waiting for autopilot:execute after 12 h, but the run may still be writing.',
      errorCode: RUN_OUTLIVED_WAIT,
    };

    render(<AutopilotPage />);

    const state = mockAutopilotState as {
      setStep: ReturnType<typeof vi.fn>;
      setExecutionStatus: ReturnType<typeof vi.fn>;
      addError: ReturnType<typeof vi.fn>;
    };
    expect(state.setStep).not.toHaveBeenCalledWith('review');
    expect(state.setExecutionStatus).not.toHaveBeenCalledWith('failed');
    expect(state.addError).not.toHaveBeenCalled();
    expect(screen.getByTestId('autopilot-outlived-wait').textContent).toContain(
      'the run may still be writing',
    );
  });

  it('goes back to the review on a run refused before it wrote, a run still writing included', () => {
    mockAutopilotState = {
      ...defaultAutopilotState(),
      step: 'executing',
      executionStatus: 'executing',
    };
    executeEnded = { error: en.common.refusal.autopilotRunning, errorCode: 'AUTOPILOT_RUNNING' };

    render(<AutopilotPage />);

    const state = mockAutopilotState as {
      setStep: ReturnType<typeof vi.fn>;
      addError: ReturnType<typeof vi.fn>;
    };
    expect(state.setStep).toHaveBeenCalledWith('review');
    expect(state.addError).toHaveBeenCalledWith(en.common.refusal.autopilotRunning);
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

  it('asks the run to keep emails and phone numbers as read only when the review unticked the box', () => {
    mockAutopilotState = {
      ...defaultAutopilotState(),
      step: 'review',
      selectedObjects: ['Account'],
      neutralizeContactPoints: false,
    };
    render(<AutopilotPage />);
    fireEvent.click(screen.getByTestId('execute-button'));
    expect(mockExecuteMutate).toHaveBeenCalledWith({ grappeThreshold: 0, keepContactPoints: true });
  });

  it('mutes the target’s automation for the run only once the review’s box is ticked', () => {
    mockAutopilotState = {
      ...defaultAutopilotState(),
      step: 'review',
      selectedObjects: ['Account'],
      muteAutomation: true,
    };
    render(<AutopilotPage />);
    expect(screen.getByTestId('step4-mute-at-start')).toBeDefined();
    fireEvent.click(screen.getByTestId('execute-button'));
    expect(mockExecuteMutate).toHaveBeenCalledWith({ grappeThreshold: 0, muteAutomation: true });
  });

  it('hands the keyboard to the running view’s heading when Execute takes the wizard away', () => {
    // Execute leaves with the wizard, and the focus it held fell to the page.
    mockAutopilotState = {
      ...defaultAutopilotState(),
      step: 'review',
      selectedObjects: ['Account'],
    };
    const { rerender } = render(<AutopilotPage />);
    const execute = screen.getByTestId('execute-button');
    execute.focus();
    fireEvent.click(execute);

    mockAutopilotState = { ...mockAutopilotState, step: 'executing', executionStatus: 'executing' };
    rerender(<AutopilotPage />);

    expect(document.activeElement).toBe(screen.getByRole('heading', { name: en.autopilot.title }));
  });

  it('leaves the focus alone when the page opens on a run already under way', () => {
    mockAutopilotState = {
      ...defaultAutopilotState(),
      step: 'executing',
      executionStatus: 'executing',
    };
    render(<AutopilotPage />);

    expect(document.activeElement).toBe(document.body);
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
