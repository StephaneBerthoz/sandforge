import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { PROTOCOL_VERSION } from '@sandforge/shared';
import type { ForgeGraph } from '@sandforge/shared';
import '../../i18n';
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

const mockUpdateNodeStatus = vi.fn();
const mockSetPhase = vi.fn();
const mockAddLog = vi.fn();
const mockClearLogs = vi.fn();
const mockStoreLogs: unknown[] = [];

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
/** Id of the forge:execute request that started the run on screen. */
let mockExecutionRequestId: string | null = null;

vi.mock('../../stores/useForgeStore', () => {
  const store = Object.assign(
    (selector: (state: Record<string, unknown>) => unknown) =>
      selector({
        get graph() {
          return mockGraph;
        },
        get executionRequestId() {
          return mockExecutionRequestId;
        },
        updateNodeStatus: mockUpdateNodeStatus,
        setPhase: mockSetPhase,
        addLog: (...args: unknown[]) => {
          mockAddLog(...args);
          mockStoreLogs.push(args[0]);
        },
        clearLogs: mockClearLogs,
        logs: mockStoreLogs,
      }),
    {
      getState: () => ({
        graph: mockGraph,
        updateNodeStatus: mockUpdateNodeStatus,
        setPhase: mockSetPhase,
        addLog: mockAddLog,
        clearLogs: mockClearLogs,
        logs: mockStoreLogs,
      }),
    },
  );
  return { useForgeStore: store };
});

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
    mockExecutionRequestId = null;
    mockStoreLogs.length = 0;
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
    render(<ForgeExecution />);

    // Simulate incoming messages: one info, one error
    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            type: 'forge:progress',
            payload: { objectName: 'Account', status: 'running', progress: 50 },
          },
        }),
      );
    });
    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            type: 'forge:progress',
            payload: { objectName: 'Case', status: 'error', progress: 0 },
          },
        }),
      );
    });

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

  it('should generate unique log IDs via useRef counter', () => {
    render(<ForgeExecution />);

    // Send two progress messages to generate log entries
    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            type: 'forge:progress',
            payload: { objectName: 'Account', status: 'running', progress: 10 },
          },
        }),
      );
    });
    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            type: 'forge:progress',
            payload: { objectName: 'Contact', status: 'running', progress: 20 },
          },
        }),
      );
    });

    const entries = screen.getAllByTestId('logstream-entry');
    expect(entries.length).toBe(2);
    // Each entry has a unique key — if IDs were not unique, React would warn and rendering would be wrong
    expect(entries[0]).not.toBe(entries[1]);
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

  it('should persist log entries to the store via addLog', () => {
    render(<ForgeExecution />);
    // Simulate a forge:progress message
    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            type: 'forge:progress',
            payload: {
              objectName: 'Account',
              status: 'running',
              progress: 50,
              message: 'Processing Account',
            },
          },
        }),
      );
    });
    // Verify the store's addLog was called
    expect(mockAddLog).toHaveBeenCalled();
  });

  describe('messages answering another run', () => {
    /** Deliver a forge message correlated to `correlationId`. */
    function deliver(type: string, correlationId: string, payload: Record<string, unknown>): void {
      act(() => {
        window.dispatchEvent(
          new MessageEvent('message', {
            data: { id: 'host-forge', type, timestamp: Date.now(), correlationId, payload },
          }),
        );
      });
    }

    beforeEach(() => {
      mockExecutionRequestId = 'wv-forge-own';
    });

    it('does not mark its run aborted on an error answering another request', () => {
      // Every panel receives every forge:execute:error; one from another
      // panel's run used to end this one.
      render(<ForgeExecution />);

      deliver('forge:execute:error', 'wv-forge-other', { message: 'Other run failed' });

      expect(screen.getByTestId('forge-execution-status').textContent).toBe('FORGING...');
    });

    it('ignores progress and a result belonging to another run', () => {
      render(<ForgeExecution />);

      deliver('forge:progress', 'wv-forge-other', { objectName: 'Opportunity', status: 'done' });
      deliver('forge:execute:response', 'wv-forge-other', {});

      expect(mockUpdateNodeStatus).not.toHaveBeenCalled();
      expect(mockSetPhase).not.toHaveBeenCalledWith('results');
      expect(screen.getByTestId('forge-execution-status').textContent).toBe('FORGING...');
    });

    it('still ends its run on an error answering its own request', () => {
      render(<ForgeExecution />);

      deliver('forge:execute:error', 'wv-forge-own', { message: 'Insert failed' });

      expect(screen.getByTestId('forge-execution-status').textContent).toBe('ABORTED');
    });
  });
});

describe('ForgeExecution progress for assistive technology', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGraph = makeMockGraph();
    mockExecutionRequestId = null;
    mockStoreLogs.length = 0;
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

    /** Post a message from the extension host. */
    function host(type: string, payload: Record<string, unknown>): void {
      act(() => {
        window.dispatchEvent(
          new MessageEvent('message', {
            data: { id: `host-${type}`, type, timestamp: Date.now(), payload },
          }),
        );
      });
    }

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
     * A run at 50% whose third object finishes within the announcement interval.
     *
     * The graph is Account done, Contact running, Opportunity queued, Case in
     * error — so two of its four nodes have settled before anything happens.
     * These numbers used to be 25% and 50%: the bar counted only the nodes that
     * succeeded, so the failed Case read as outstanding work and the run could
     * never reach 100%.
     */
    function runUnderway(): HTMLElement {
      vi.useFakeTimers();
      render(<ForgeExecution />);
      const region = screen.getByTestId('forge-progress-status');
      expect(region.textContent).toBe('Forge progress: 50%');
      finish('Contact');
      host('forge:progress', { objectName: 'Contact', status: 'done', progress: 100 });
      expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('75');
      // Mid-run values wait for the interval.
      expect(region.textContent).toBe('Forge progress: 50%');
      return region;
    }

    it('says 100% as soon as the run completes', () => {
      const region = runUnderway();
      finish('Opportunity');
      host('forge:execute:response', {});
      expect(region.textContent).toBe('Forge progress: 100%');
    });

    it('says where an aborted run stopped, as soon as it stops', () => {
      const region = runUnderway();
      host('forge:execute:error', { message: 'Insert failed' });
      expect(region.textContent).toBe('Forge progress: 75%');
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
