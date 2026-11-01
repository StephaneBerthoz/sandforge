import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import '../../i18n';
import en from '../../i18n/locales/en.json';
import { AutopilotPage } from './AutopilotPage';
import { RUN_OUTLIVED_WAIT } from '../../hooks/useMessageResponse';
import { WRITE_RUN_TIMEOUT_MS } from '../../hooks/writeRunTimeout';
import { useMessageListener } from '../../hooks/useMessageBus';

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
      tags: [],
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
  recordNodeFinish: vi.fn(),
  clearNodeFinishes: vi.fn(),
  nodeFinishes: {},
  setRunEnd: vi.fn(),
  runEnd: null,
  checkpointFirst: false,
  setCheckpointFirst: vi.fn(),
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
          tags: [],
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
      clearNodeFinishes: ReturnType<typeof vi.fn>;
    };
    expect(state.setExecutionStatus).toHaveBeenCalledWith('executing');
    expect(state.setStep).toHaveBeenCalledWith('executing');
    // The last run's settle times go: its timeline is not this run's.
    expect(state.clearNodeFinishes).toHaveBeenCalledTimes(1);
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

  describe('the checkpoint first', () => {
    /** The listener the page last gave for `type`. */
    const listenerOf = (type: string): ((msg: Record<string, unknown>) => void) => {
      const calls = vi.mocked(useMessageListener).mock.calls.filter(([t]) => t === type);
      return calls[calls.length - 1]?.[1] as unknown as (msg: Record<string, unknown>) => void;
    };
    const addError = (): ReturnType<typeof vi.fn> =>
      (mockAutopilotState as { addError: ReturnType<typeof vi.fn> }).addError;

    it('asks the run for it once the review’s option is ticked, and not before', () => {
      mockAutopilotState = {
        ...defaultAutopilotState(),
        step: 'review',
        selectedObjects: ['Account'],
        checkpointFirst: true,
      };
      render(<AutopilotPage />);
      fireEvent.click(screen.getByTestId('execute-button'));
      expect(mockExecuteMutate).toHaveBeenCalledWith({ grappeThreshold: 0, checkpointFirst: {} });
    });

    it('forgets the last run as another starts', () => {
      mockAutopilotState = {
        ...defaultAutopilotState(),
        step: 'review',
        selectedObjects: ['Account'],
      };
      render(<AutopilotPage />);
      fireEvent.click(screen.getByTestId('execute-button'));
      expect(
        (mockAutopilotState as { setRunEnd: ReturnType<typeof vi.fn> }).setRunEnd,
      ).toHaveBeenCalledWith(null);
    });

    it.each([
      [
        'CHECKPOINT_REFUSED',
        false,
        'The run was refused before it wrote anything: the checkpoint it was to take first of the objects it writes was refused, or could not be taken, which the SandForge output says. Nothing was written. Untick Checkpoint first to run without it, or fix what refuses it.',
      ],
      [
        'API_BUDGET_EXCEEDED',
        false,
        'The run was refused before it wrote anything: it takes more API requests than the target org has left today, and would have stopped part way through. Run it once the org has requests to spare — the daily limit is counted over the last 24 hours — or copy fewer records.',
      ],
      [
        'API_BUDGET_EXCEEDED',
        true,
        'The run was refused before it wrote anything: it takes more API requests than the target org has left today, the checkpoint it was to take first among them, and would have stopped part way through. Run it once the org has requests to spare — the daily limit is counted over the last 24 hours —, copy fewer records, or untick Checkpoint first.',
      ],
      [
        'RUN_CANCELLED',
        true,
        'The run was stopped while it took the checkpoint first: nothing of it was kept, and nothing was written.',
      ],
    ])('words %s from its own keys, not the host’s English (asked: %s)', (code, asked, words) => {
      executeEnded = { error: 'The English the host logs', errorCode: code };
      mockAutopilotState = { ...defaultAutopilotState(), checkpointFirst: asked };
      render(<AutopilotPage />);
      expect(addError()).toHaveBeenLastCalledWith(words);
    });

    it('keeps the host’s words for a code it has none of its own for', () => {
      executeEnded = { error: 'Past the data storage', errorCode: 'AUTOPILOT_STORAGE_EXCEEDED' };
      render(<AutopilotPage />);
      expect(addError()).toHaveBeenLastCalledWith('Past the data storage');
    });

    it('keeps what became of the checkpoint of a run its error ended, for the review to say', () => {
      executeEnded = { error: 'The mute was refused.', errorCode: 'MUTE_REFUSED' };
      mockAutopilotState = { ...defaultAutopilotState(), targetOrgId: 'org-1' };
      render(<AutopilotPage />);
      act(() =>
        listenerOf('autopilot:error')({
          correlationId: null,
          timestamp: Date.parse('2026-11-01T10:25:00.000Z'),
          payload: { checkpoint: { state: 'deleted', deleted: 'nothingWritten' } },
        }),
      );
      expect(
        (mockAutopilotState as { setRunEnd: ReturnType<typeof vi.fn> }).setRunEnd,
      ).toHaveBeenLastCalledWith(
        expect.objectContaining({
          orgId: 'org-1',
          endedAt: '2026-11-01T10:25:00.000Z',
          checkpoint: { state: 'deleted', deleted: 'nothingWritten' },
        }),
      );
      expect(addError()).toHaveBeenLastCalledWith('The mute was refused.');
    });

    it('keeps no end of a run its error says nothing of a checkpoint for', () => {
      executeEnded = { error: 'Socket hang up', errorCode: 'UNKNOWN' };
      mockAutopilotState = { ...defaultAutopilotState(), targetOrgId: 'org-1' };
      render(<AutopilotPage />);
      act(() => listenerOf('autopilot:error')({ correlationId: null, timestamp: 1, payload: {} }));
      expect(
        (mockAutopilotState as { setRunEnd: ReturnType<typeof vi.fn> }).setRunEnd,
      ).not.toHaveBeenCalled();
    });

    it('keeps the run that ended, with its checkpoint, for the panel and a rewind’s mark', () => {
      const taken = {
        state: 'taken' as const,
        checkpointId: 'ck-20261101-101540-a1b2',
        name: 'Before Autopilot run 2026-11-01 10:15 UTC',
        takenAt: '2026-11-01T10:15:40.000Z',
        expiresAt: '2026-11-08T10:15:40.000Z',
        objects: ['Account', 'Contact'],
        records: 38,
        bytes: 2_100_000,
        requests: 66,
        added: [],
        notHeld: [],
      };
      mockAutopilotState = {
        ...defaultAutopilotState(),
        targetOrgId: 'org-1',
        plan: { waves: [{ objects: ['Account', 'Contact'] }] },
      };
      render(<AutopilotPage />);
      act(() =>
        listenerOf('autopilot:completed')({
          timestamp: Date.parse('2026-11-01T10:25:00.000Z'),
          payload: {
            totalRecords: 2,
            totalSuccessCount: 2,
            totalFailureCount: 0,
            totalElapsedMs: 600_000,
            totalApiCalls: 3,
            checkpoint: taken,
          },
        }),
      );
      expect(
        (mockAutopilotState as { setRunEnd: ReturnType<typeof vi.fn> }).setRunEnd,
      ).toHaveBeenCalledWith({
        orgId: 'org-1',
        startedAt: '2026-11-01T10:15:00.000Z',
        endedAt: '2026-11-01T10:25:00.000Z',
        objects: ['Account', 'Contact'],
        checkpoint: taken,
      });
    });
  });
});
