import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { PROTOCOL_VERSION } from '@sandforge/shared';
import type { ForgeExecutionResult, ForgeGraph } from '@sandforge/shared';
import '../../i18n';
import type { ForgeLogEntry, ForgeRunError } from '../../stores/useForgeStore';
import { ForgeExecution } from './ForgeExecution';

/* ---- Mocks ---- */

/**
 * The component posts via sendBridgeMessage -> getVscodeApi().postMessage.
 * Mock the accessor module (the real code path) — window.vscodeApi is never
 * assigned in production and must not be relied upon.
 */
const mockPostMessage = vi.fn();

// Both exports: the page reaches the bridge through the hook as well as through
// the module-cached accessor, and a partial mock fails only at render time.
// `mockPostMessage` is referenced lazily — this factory is hoisted above its
// declaration, so building the object here would read it before it exists.
vi.mock('../../hooks/useVSCodeApi', () => {
  const api = {
    postMessage: (...args: unknown[]) => mockPostMessage(...args),
    getState: () => undefined,
    setState: () => undefined,
  };
  return { getVscodeApi: () => api, useVSCodeApi: () => api };
});

/** Envelope shape posted to the extension host (see sendBridgeMessage). */
interface PostedEnvelope {
  protocolVersion: number;
  correlationId?: string;
  payload: { type: string; payload?: Record<string, unknown> };
}

const mockSetPhase = vi.fn();
const mockSetStoppedAt = vi.fn();
const mockAddLog = vi.fn();
const mockShowStoppedRun = vi.fn();
const mockReviewAgain = vi.fn();
/** The run's log, as the store keeps it. */
let mockLogs: ForgeLogEntry[] = [];
/** Why the run stopped, when an error ended it. */
let mockRunError: ForgeRunError | null = null;

// Typed as the real graph, so a test can set any node status the union
// allows without the fixture's literal types getting in the way.
const makeMockGraph = (): ForgeGraph => ({
  nodes: [
    {
      objectApiName: 'Account',
      recordCount: 10,
      fieldCount: 15,
      status: 'done' as const,
      progress: 100,
      included: true,
      piiFields: [] as string[],
      anonymizeFields: [] as string[],
      level: 0,
      successCount: 10,
      failureCount: 0,
      errors: [] as string[],
      createableFieldCount: 0,
      estimatedSizeMB: 0,
      estimatedApiCalls: 5,
      batchStrategy: 'auto' as const,
    },
    {
      objectApiName: 'Contact',
      recordCount: 20,
      fieldCount: 18,
      status: 'running' as const,
      progress: 50,
      included: true,
      piiFields: [] as string[],
      anonymizeFields: [] as string[],
      level: 1,
      successCount: 10,
      failureCount: 0,
      errors: [] as string[],
      createableFieldCount: 0,
      estimatedSizeMB: 0,
      estimatedApiCalls: 12,
      batchStrategy: 'auto' as const,
    },
    {
      objectApiName: 'Opportunity',
      recordCount: 5,
      fieldCount: 12,
      status: 'idle' as const,
      progress: 0,
      included: true,
      piiFields: [] as string[],
      anonymizeFields: [] as string[],
      level: 1,
      successCount: 0,
      failureCount: 0,
      errors: [] as string[],
      createableFieldCount: 0,
      estimatedSizeMB: 0,
      estimatedApiCalls: 0,
      batchStrategy: 'auto' as const,
    },
    {
      objectApiName: 'Case',
      recordCount: 3,
      fieldCount: 10,
      status: 'error' as const,
      progress: 0,
      included: true,
      piiFields: [] as string[],
      anonymizeFields: [] as string[],
      level: 2,
      successCount: 0,
      failureCount: 3,
      errors: ['FIELD_INTEGRITY_EXCEPTION'],
      createableFieldCount: 0,
      estimatedSizeMB: 0,
      estimatedApiCalls: 0,
      batchStrategy: 'auto' as const,
    },
  ],
  edges: [],
  totalRecords: 38,
  estimatedSizeMB: 1.5,
  estimatedDurationSeconds: 15,
});

let mockGraph = makeMockGraph();

// The run's progress, log and error are the store's, and this file draws what
// the store holds: how the store takes them is tested with it, and the two
// together with the page (`ForgePage.runState.test.tsx`). Only the store
// stands in here; the module's helpers are its own. The state is read at each
// render: hoisted, this factory runs before the mocks above are initialized.
vi.mock('../../stores/useForgeStore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../stores/useForgeStore')>();
  const state = () => ({
    graph: mockGraph,
    logs: mockLogs,
    runError: mockRunError,
    setPhase: mockSetPhase,
    setStoppedAt: mockSetStoppedAt,
    addLog: mockAddLog,
    showStoppedRun: mockShowStoppedRun,
    reviewAgain: mockReviewAgain,
  });
  const store = Object.assign(
    (selector: (s: ReturnType<typeof state>) => unknown) => selector(state()),
    { getState: state },
  );
  return { ...actual, useForgeStore: store };
});

/** A line of the run's log. */
function logLine(id: string, level: ForgeLogEntry['level'], message: string): ForgeLogEntry {
  return { id, timestamp: Date.now(), level, message };
}

vi.mock('../../components/graph/LiveGraph', () => ({
  LiveGraph: ({ className }: { className?: string }) => (
    <div data-testid="live-graph" className={className}>
      LiveGraph mock
    </div>
  ),
}));

vi.mock('../../components/ui/SplitView', () => ({
  SplitView: ({ left, right }: { left: React.ReactNode; right: React.ReactNode }) => (
    <div data-testid="splitview">
      <div data-testid="splitview-left">{left}</div>
      <div data-testid="splitview-right">{right}</div>
    </div>
  ),
}));

/* ---- Tests ---- */

describe('ForgeExecution', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGraph = makeMockGraph();
    mockLogs = [];
    mockRunError = null;
  });

  describe('a run whose objects have all settled', () => {
    /** Every object settled: the last event the run sends about an object has come. */
    function allSettled(): void {
      mockGraph = {
        ...mockGraph,
        nodes: mockGraph.nodes.map((node) =>
          node.objectApiName === 'Case' ? node : { ...node, status: 'done' as const },
        ),
      };
    }

    it('stays and says it is finishing: its answer comes after its last object', () => {
      // Its last steps — the lookups filled in last, the files, the statuses
      // given back, its write dates — follow the last object's event. The
      // screen left for the results there, and the answer came too late.
      allSettled();
      render(<ForgeExecution />);

      expect(screen.getByTestId('forge-execution-status').textContent).toBe('FINISHING...');
      expect(screen.getByTestId('forge-execution-finishing').textContent).toBe(
        'Every object on the graph has settled. The run is finishing; its results follow once it is done.',
      );
      expect(mockSetPhase).not.toHaveBeenCalled();
    });

    it('shows no time remaining once there is no object left to measure it on', () => {
      allSettled();
      render(<ForgeExecution />);
      expect(screen.queryByTestId('forge-execution-eta')).toBeNull();
    });

    it('keeps its controls: the run can still be paused or aborted while it finishes', () => {
      allSettled();
      render(<ForgeExecution />);
      expect(screen.getByTestId('forge-pause-button').hasAttribute('disabled')).toBe(false);
      expect(screen.getByTestId('forge-abort-button').hasAttribute('disabled')).toBe(false);
    });

    it('says it is paused, not finishing, while the user holds it', () => {
      allSettled();
      render(<ForgeExecution />);
      fireEvent.click(screen.getByTestId('forge-pause-button'));
      expect(screen.getByTestId('forge-execution-status').textContent).toBe('PAUSED');
      expect(screen.queryByTestId('forge-execution-finishing')).toBeNull();
    });
  });

  it('should render execution view with progress bar', () => {
    render(<ForgeExecution />);
    expect(screen.getByTestId('forge-execution')).toBeDefined();
    expect(screen.getByTestId('forge-execution-progress')).toBeDefined();
    expect(screen.getByRole('progressbar')).toBeDefined();
  });

  it('should show FORGING status text', () => {
    render(<ForgeExecution />);
    expect(screen.getByTestId('forge-execution-status').textContent).toBe('FORGING...');
  });

  it('should show KPI counters matching node statuses', () => {
    render(<ForgeExecution />);
    const kpiCards = screen.getAllByTestId('kpi-card');
    expect(kpiCards.length).toBe(5);

    // Values: Done=1, Running=1, Queued=1, Failed=1, API Calls=17
    const values = screen.getAllByTestId('kpi-value');
    expect(values[0].textContent).toBe('1'); // done
    expect(values[1].textContent).toBe('1'); // running
    expect(values[2].textContent).toBe('1'); // queued
    expect(values[3].textContent).toBe('1'); // failed
    expect(values[4].textContent).toBe('17'); // estimated API calls (5+12)
  });

  it('should toggle pause button to resume', () => {
    render(<ForgeExecution />);
    const btn = screen.getByTestId('forge-pause-button');
    expect(btn.textContent).toContain('Pause');
    fireEvent.click(btn);
    expect(btn.textContent).toContain('Resume');
    expect(screen.getByTestId('forge-execution-status').textContent).toBe('PAUSED');
  });

  it('should post enveloped forge:pause then forge:resume when toggling pause', () => {
    render(<ForgeExecution />);
    const btn = screen.getByTestId('forge-pause-button');

    fireEvent.click(btn);
    expect(mockPostMessage).toHaveBeenCalledTimes(1);
    let envelope = mockPostMessage.mock.calls[0][0] as PostedEnvelope;
    expect(envelope.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(envelope.payload.type).toBe('forge:pause');

    fireEvent.click(btn);
    expect(mockPostMessage).toHaveBeenCalledTimes(2);
    envelope = mockPostMessage.mock.calls[1][0] as PostedEnvelope;
    expect(envelope.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(envelope.payload.type).toBe('forge:resume');
  });

  it('should post an enveloped forge:abort when abort is confirmed', () => {
    render(<ForgeExecution />);

    fireEvent.click(screen.getByTestId('forge-abort-button'));
    fireEvent.change(screen.getByTestId('danger-input'), { target: { value: 'Abort' } });
    fireEvent.click(screen.getByTestId('danger-confirm-btn'));

    expect(mockPostMessage).toHaveBeenCalledTimes(1);
    const envelope = mockPostMessage.mock.calls[0][0] as PostedEnvelope;
    expect(envelope.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(envelope.payload.type).toBe('forge:abort');
    expect(screen.getByTestId('forge-execution-status').textContent).toBe('ABORTED');
  });

  it('records where a run the user aborted stopped, before it leaves the screen', () => {
    // The abort goes back to the input screen at once, and this screen's
    // announcer goes with it: the page says the run stopped from the store.
    render(<ForgeExecution />);

    fireEvent.click(screen.getByTestId('forge-abort-button'));
    fireEvent.change(screen.getByTestId('danger-input'), { target: { value: 'Abort' } });
    fireEvent.click(screen.getByTestId('danger-confirm-btn'));

    expect(mockSetStoppedAt).toHaveBeenCalledWith(50);
    expect(mockSetStoppedAt.mock.invocationCallOrder[0]).toBeLessThan(
      mockSetPhase.mock.invocationCallOrder[0],
    );
  });

  it('should not post forge:abort when the confirm text does not match', () => {
    render(<ForgeExecution />);

    fireEvent.click(screen.getByTestId('forge-abort-button'));
    fireEvent.change(screen.getByTestId('danger-input'), { target: { value: 'nope' } });
    fireEvent.click(screen.getByTestId('danger-confirm-btn'));

    expect(mockPostMessage).not.toHaveBeenCalled();
  });

  it('should render log stream', () => {
    render(<ForgeExecution />);
    expect(screen.getByTestId('logstream')).toBeDefined();
  });

  it('should render abort button', () => {
    render(<ForgeExecution />);
    const abortBtn = screen.getByTestId('forge-abort-button');
    expect(abortBtn).toBeDefined();
    expect(abortBtn.textContent).toContain('Abort');
  });

  it('should render log filter buttons', () => {
    render(<ForgeExecution />);
    expect(screen.getByTestId('log-filter-all')).toBeDefined();
    expect(screen.getByTestId('log-filter-errors')).toBeDefined();
    expect(screen.getByTestId('log-filter-warnings')).toBeDefined();
  });

  it('should filter logs to errors only', () => {
    mockLogs = [
      logLine('forge-log-1', 'info', 'Account: running (50%)'),
      logLine('forge-log-2', 'error', 'Case: error (0%)'),
    ];
    render(<ForgeExecution />);

    // Before filter: both entries should be visible
    const entriesBefore = screen.getAllByTestId('logstream-entry');
    expect(entriesBefore.length).toBe(2);

    // Click the Errors filter button
    fireEvent.click(screen.getByTestId('log-filter-errors'));

    // After filter: only the error entry should be visible
    const entriesAfter = screen.getAllByTestId('logstream-entry');
    expect(entriesAfter.length).toBe(1);
  });

  it('should render 5 KPI cards including API calls', () => {
    render(<ForgeExecution />);
    const kpiCards = screen.getAllByTestId('kpi-card');
    expect(kpiCards.length).toBe(5);

    // The 5th KPI card should show the API calls sum (5+12 = 17)
    const values = screen.getAllByTestId('kpi-value');
    expect(values[4].textContent).toBe('17');
  });

  it('shows the log the store kept, not one of its own that a new mount starts empty', () => {
    mockLogs = [
      logLine('forge-log-1', 'info', 'Account: done (100%)'),
      logLine('forge-log-2', 'info', 'Contact: running (10%)'),
    ];
    render(<ForgeExecution />);

    const entries = screen.getAllByTestId('logstream-entry');
    expect(entries.map((entry) => entry.textContent)).toEqual([
      expect.stringContaining('Account: done (100%)'),
      expect.stringContaining('Contact: running (10%)'),
    ]);
  });

  it('should display ETA in the top bar', () => {
    render(<ForgeExecution />);
    expect(screen.getByTestId('forge-execution-eta')).toBeDefined();
  });

  /* ---- aria-pressed on external filter buttons ---- */
  it('should have aria-pressed matching logFilter state', () => {
    render(<ForgeExecution />);
    expect(screen.getByTestId('log-filter-all').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('log-filter-errors').getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByTestId('log-filter-warnings').getAttribute('aria-pressed')).toBe('false');
  });

  it('should toggle aria-pressed when clicking a filter button', () => {
    render(<ForgeExecution />);
    fireEvent.click(screen.getByTestId('log-filter-errors'));
    expect(screen.getByTestId('log-filter-all').getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByTestId('log-filter-errors').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('log-filter-warnings').getAttribute('aria-pressed')).toBe('false');
  });

  it('logs the abort in a line of its own', () => {
    render(<ForgeExecution />);

    fireEvent.click(screen.getByTestId('forge-abort-button'));
    fireEvent.change(screen.getByTestId('danger-input'), { target: { value: 'Abort' } });
    fireEvent.click(screen.getByTestId('danger-confirm-btn'));

    expect(mockAddLog).toHaveBeenCalledWith(
      expect.objectContaining({ level: 'warn', message: 'ABORTED', id: expect.any(String) }),
    );
  });

  describe('a run an error stopped', () => {
    /** A run the extension kept, with what it had created before it stopped. */
    const WROTE_ONE: ForgeExecutionResult = {
      forgeId: 'forge-stopped',
      status: 'failure',
      graph: makeMockGraph(),
      duration: 3_000,
      timestamp: '2026-09-24T08:00:00.000Z',
      idRemapCount: 1,
      createdCount: 1,
    };

    it('says why it stopped, in an alert, and has nothing left to pause or abort', () => {
      // After the error, Pause and Abort stayed on screen, disabled, and
      // nothing else: the only way off was to leave the page.
      mockRunError = { message: 'Insert failed', stoppedRun: null };
      render(<ForgeExecution />);

      expect(screen.getByTestId('forge-execution-status').textContent).toBe('STOPPED');
      const alert = screen.getByRole('alert');
      expect(alert.getAttribute('data-testid')).toBe('forge-execution-error');
      expect(alert.textContent).toContain('The run stopped before its end: Insert failed');
      expect(screen.queryByTestId('forge-pause-button')).toBeNull();
      expect(screen.queryByTestId('forge-abort-button')).toBeNull();
      expect(screen.queryByTestId('forge-execution-eta')).toBeNull();
    });

    it('goes back to the Review when its error says nothing of what it wrote', () => {
      mockRunError = { message: 'Insert failed', stoppedRun: null };
      render(<ForgeExecution />);

      expect(screen.queryByTestId('forge-execution-error-written')).toBeNull();
      expect(screen.queryByTestId('forge-execution-see-stopped')).toBeNull();
      fireEvent.click(screen.getByTestId('forge-execution-back-to-review'));

      expect(mockReviewAgain).toHaveBeenCalledTimes(1);
    });

    it('says what it had created, and shows it, when its error says', () => {
      mockRunError = { message: 'Insert failed', stoppedRun: WROTE_ONE };
      render(<ForgeExecution />);

      expect(screen.getByTestId('forge-execution-error-written').textContent).toBe(
        'Before it stopped, it had created 1 record in the target org.',
      );
      expect(screen.queryByTestId('forge-execution-back-to-review')).toBeNull();
      fireEvent.click(screen.getByTestId('forge-execution-see-stopped'));

      expect(mockShowStoppedRun).toHaveBeenCalledTimes(1);
    });

    it('stops its clock', () => {
      vi.useFakeTimers();
      try {
        mockRunError = { message: 'Insert failed', stoppedRun: null };
        render(<ForgeExecution />);
        const before = screen.getByTestId('forge-execution-timer').textContent;

        act(() => {
          vi.advanceTimersByTime(5_000);
        });

        expect(screen.getByTestId('forge-execution-timer').textContent).toBe(before);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});

describe('ForgeExecution progress for assistive technology', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGraph = makeMockGraph();
    mockLogs = [];
    mockRunError = null;
  });

  it('draws the run progress with a named progress bar', () => {
    render(<ForgeExecution />);
    const bar = screen.getByRole('progressbar', { name: 'Forge progress' });
    expect(bar.getAttribute('aria-valuetext')).toMatch(/^\d+%$/);
    expect(screen.getByTestId('forge-execution-progress').contains(bar)).toBe(true);
    expect((bar.firstChild as HTMLElement).className).toContain('bg-forge');
  });

  it('announces the run progress in a polite status region', () => {
    render(<ForgeExecution />);
    const region = screen.getByTestId('forge-progress-status');
    expect(region.getAttribute('role')).toBe('status');
    expect(region.getAttribute('aria-live')).toBe('polite');
    const value = screen.getByRole('progressbar').getAttribute('aria-valuenow');
    expect(region.textContent).toBe(`Forge progress: ${value}%`);
  });

  describe('the last announcement of a run', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    /** Mark the named objects done in the graph the store hands out. */
    function finish(...names: string[]): void {
      mockGraph = {
        ...mockGraph,
        nodes: mockGraph.nodes.map((node) =>
          names.includes(node.objectApiName) ? { ...node, status: 'done' as const } : node,
        ),
      };
    }

    /**
     * A run at 50% whose third object finishes within the announcement
     * interval; gives back the region, and a way to draw the screen again from
     * what the store then holds.
     *
     * The graph is Account done, Contact running, Opportunity queued, Case in
     * error — so two of its four nodes have settled before anything happens.
     * These numbers used to be 25% and 50%: the bar counted only the nodes that
     * succeeded, so the failed Case read as outstanding work and the run could
     * never reach 100%.
     */
    function runUnderway(): { region: HTMLElement; redraw: () => void } {
      vi.useFakeTimers();
      const view = render(<ForgeExecution />);
      const redraw = (): void => view.rerender(<ForgeExecution />);
      const region = screen.getByTestId('forge-progress-status');
      expect(region.textContent).toBe('Forge progress: 50%');
      finish('Contact');
      redraw();
      expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('75');
      // Mid-run values wait for the interval.
      expect(region.textContent).toBe('Forge progress: 50%');
      return { region, redraw };
    }

    it('says the run is finishing as soon as its last object settles', () => {
      // At once, not at the next interval: heard as "100%", the bar said the
      // run was over while its last steps were still to come.
      const { region, redraw } = runUnderway();
      finish('Opportunity');
      redraw();
      expect(region.textContent).toBe(
        'Every object on the graph has settled. The run is finishing; its results follow once it is done.',
      );
    });

    it('says no percentage more of a run an error stopped: the page says where, the alert why', () => {
      // Drawn again as the page came back, the region said the last
      // percentage of a run that had ended as though it went on.
      const { region, redraw } = runUnderway();
      mockRunError = { message: 'Insert failed', stoppedRun: null };
      redraw();
      expect(region.textContent).toBe('');
    });

    it('counts a skipped node as settled, so a run of skips reaches 100%', () => {
      // Back-to-back skips used to leave their nodes "queued" forever: the
      // throttle coalesced the events and the bar never passed done/total.
      vi.useFakeTimers();
      mockGraph = {
        ...mockGraph,
        nodes: mockGraph.nodes.map((node) => ({ ...node, status: 'skipped' as const })),
      };
      render(<ForgeExecution />);
      expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('100');
    });
  });
});
