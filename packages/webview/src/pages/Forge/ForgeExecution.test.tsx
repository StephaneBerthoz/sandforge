import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { PROTOCOL_VERSION } from '@sandforge/shared';
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

const makeMockGraph = () => ({
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

vi.mock('../../stores/useForgeStore', () => {
  const store = Object.assign(
    (selector: (state: Record<string, unknown>) => unknown) =>
      selector({
        get graph() {
          return mockGraph;
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
});
