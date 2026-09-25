import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import '../../../i18n';
import { ControlPanel } from './ControlPanel';

/** Captured bridge messages sent by the control panel. */
const mockSendMessage = vi.fn();

vi.mock('../../../hooks/useMessageBus', () => ({
  useSendMessage: () => mockSendMessage,
}));

/** Mutable autopilot store mock (pause/resume flips executionStatus). */
let mockStoreState: Record<string, unknown>;

vi.mock('../../../stores/useAutopilotStore', () => {
  const store = Object.assign(
    (selector: (state: Record<string, unknown>) => unknown) => selector(mockStoreState),
    { getState: () => mockStoreState },
  );
  return { useAutopilotStore: store };
});

describe('ControlPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStoreState = {
      liveStats: {
        recordsProcessed: 0,
        recordsTotal: 100,
        apiCallsUsed: 0,
        apiCallsEstimated: 50,
        elapsedMs: 0,
        currentWave: 0,
        totalWaves: 3,
      },
      executionStatus: 'executing',
      selectedNodeName: null,
      complianceFramework: 'none',
      rules: [],
      graph: null,
      selectedNode: () => undefined,
      failedCount: () => 0,
      completedCount: () => 0,
      overallProgress: () => 0,
      setExecutionStatus: vi.fn(),
      updateNodeStatus: vi.fn(),
    };
  });

  it('should render without crashing', () => {
    render(<ControlPanel />);
    expect(screen.getByTestId('control-panel')).toBeDefined();
  });

  it('should show control tabs', () => {
    render(<ControlPanel />);
    expect(screen.getByTestId('control-tabs')).toBeDefined();
  });

  it('should show live stats by default', () => {
    render(<ControlPanel />);
    expect(screen.getByTestId('live-stats')).toBeDefined();
  });

  it('should show action buttons when executing', () => {
    render(<ControlPanel />);
    expect(screen.getByTestId('control-actions')).toBeDefined();
  });

  it('should post autopilot:pause when pause is clicked', () => {
    render(<ControlPanel />);
    fireEvent.click(screen.getByTestId('control-pause-resume'));
    expect(mockSendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'autopilot:pause' }),
    );
  });

  it('should post autopilot:resume when paused and resume is clicked', () => {
    mockStoreState.executionStatus = 'paused';
    render(<ControlPanel />);
    fireEvent.click(screen.getByTestId('control-pause-resume'));
    expect(mockSendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'autopilot:resume' }),
    );
  });

  it('should disable skip when no node is selected', () => {
    render(<ControlPanel />);
    expect(screen.getByTestId('control-skip')).toHaveProperty('disabled', true);
  });

  it('should post autopilot:skip-node with the selected object when skip is clicked', () => {
    mockStoreState.selectedNodeName = 'Account';
    render(<ControlPanel />);
    fireEvent.click(screen.getByTestId('control-skip'));
    expect(mockSendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'autopilot:skip-node',
        payload: { objectApiName: 'Account' },
      }),
    );
  });
});

describe('ControlPanel progress bars', () => {
  beforeEach(() => {
    mockStoreState = {
      liveStats: {
        recordsProcessed: 25,
        recordsTotal: 100,
        apiCallsUsed: 10,
        apiCallsEstimated: 50,
        elapsedMs: 0,
        currentWave: 0,
        totalWaves: 3,
      },
      executionStatus: 'executing',
      selectedNodeName: 'Account',
      complianceFramework: 'none',
      rules: [],
      graph: null,
      selectedNode: () => ({
        objectApiName: 'Account',
        status: 'extracting',
        progress: 60,
        recordCount: 100,
        successCount: 60,
        failureCount: 0,
        errors: [],
      }),
      failedCount: () => 0,
      completedCount: () => 0,
      overallProgress: () => 0,
      setExecutionStatus: vi.fn(),
      updateNodeStatus: vi.fn(),
    };
  });

  it('names the live stats bars after the figure they draw', () => {
    render(<ControlPanel />);
    const records = screen.getByRole('progressbar', { name: 'Records Processed' });
    expect(records.getAttribute('aria-valuetext')).toBe('25%');
    const calls = screen.getByRole('progressbar', { name: 'API Calls' });
    expect(calls.getAttribute('aria-valuetext')).toBe('20%');
  });

  it('counts the calls the run made, and gives the plan’s calls as the estimate they are', () => {
    // The plan puts a call on each batch of the rows the scan counted, before
    // anything is read: "10 / 50" under "API Calls" read the guess as the
    // calls the run would make, where the review had said it was estimated.
    render(<ControlPanel />);
    const calls = screen.getByTestId('live-stats-api-calls');

    expect(within(calls).getByText('10')).toBeDefined();
    expect(within(calls).getByText('50 estimated API calls')).toBeDefined();
    expect(calls.textContent).not.toContain('/');
  });

  it('names the selected node progress bar', () => {
    render(<ControlPanel />);
    fireEvent.click(screen.getByTestId('control-tab-node'));
    const bar = screen.getByRole('progressbar', { name: 'Progress' });
    expect(bar.getAttribute('aria-valuenow')).toBe('60');
  });

  it('tells a screen reader how far the run has got', () => {
    // A run of several minutes updated only silent DOM: nothing was spoken
    // from start to finish.
    render(<ControlPanel />);
    expect(screen.getByTestId('autopilot-progress-status').textContent).toBe(
      'Autopilot progress: 25%',
    );
  });

  it('tells a screen reader the run finished, and what it wrote', () => {
    mockStoreState = { ...mockStoreState, executionStatus: 'completed' };
    render(<ControlPanel />);
    expect(screen.getByTestId('autopilot-progress-status').textContent).toBe(
      'Autopilot finished. Written: 25 of 100.',
    );
  });
});

describe('ControlPanel node detail — what the node came to', () => {
  /** A settled Order node, as the handler reconciles it at the end of a run. */
  function settledOrder(overrides: Record<string, unknown> = {}) {
    return {
      objectApiName: 'Order',
      status: 'completed',
      progress: 100,
      recordCount: 11,
      successCount: 8,
      failureCount: 2,
      linkedCount: 1,
      errors: [],
      refusals: [
        {
          statusCode: 'INVALID_CROSS_REFERENCE_KEY',
          fields: ['Pricebook2Id'],
          count: 2,
          message: 'invalid cross reference id',
        },
      ],
      statusesApplied: 2,
      statusRefusals: [
        {
          statusCode: 'FIELD_INTEGRITY_EXCEPTION',
          fields: [],
          count: 1,
          message: 'Commande sans produit',
        },
      ],
      ...overrides,
    };
  }

  beforeEach(() => {
    mockStoreState = {
      liveStats: {
        recordsProcessed: 0,
        recordsTotal: 0,
        apiCallsUsed: 0,
        apiCallsEstimated: 0,
        elapsedMs: 0,
        currentWave: 0,
        totalWaves: 0,
      },
      executionStatus: 'completed',
      selectedNodeName: 'Order',
      complianceFramework: 'none',
      rules: [],
      graph: null,
      selectedNode: () => settledOrder(),
      failedCount: () => 0,
      completedCount: () => 0,
      overallProgress: () => 0,
      setExecutionStatus: vi.fn(),
      updateNodeStatus: vi.fn(),
    };
  });

  it('says why records were refused: the code, the fields, how many and the message', () => {
    render(<ControlPanel />);
    fireEvent.click(screen.getByTestId('control-tab-node'));

    const refusals = screen.getByTestId('node-refusals');
    expect(refusals.textContent).toContain('INVALID_CROSS_REFERENCE_KEY');
    expect(refusals.textContent).toContain('Pricebook2Id');
    expect(refusals.textContent).toContain('2 records');
    expect(refusals.textContent).toContain('invalid cross reference id');
  });

  it('shows the records linked to what the target held, and the statuses given back', () => {
    render(<ControlPanel />);
    fireEvent.click(screen.getByTestId('control-tab-node'));

    expect(screen.getByTestId('node-linked').textContent).toContain('1');
    expect(screen.getByTestId('node-statuses').textContent).toContain('2');
    const statusRefusals = screen.getByTestId('node-status-refusals');
    expect(statusRefusals.textContent).toContain('FIELD_INTEGRITY_EXCEPTION');
    expect(statusRefusals.textContent).toContain('1 record');
  });

  it('shows the records left out because the platform writes them, or what they depend on, itself', () => {
    // A tracked change is never sent — the platform refuses one from a copy —
    // and neither written nor refused, it would count nowhere else.
    mockStoreState.selectedNode = () => settledOrder({ leftToThePlatform: 3 });
    render(<ControlPanel />);
    fireEvent.click(screen.getByTestId('control-tab-node'));

    const leftOut = screen.getByTestId('node-left-to-the-platform');
    expect(leftOut.textContent).toContain('the platform writes them');
    expect(leftOut.textContent).toContain('3');
  });

  it('shows none of it for a node that wrote everything', () => {
    mockStoreState.selectedNode = () =>
      settledOrder({
        failureCount: 0,
        linkedCount: 0,
        refusals: [],
        statusesApplied: undefined,
        statusRefusals: undefined,
      });
    render(<ControlPanel />);
    fireEvent.click(screen.getByTestId('control-tab-node'));

    expect(screen.queryByTestId('node-refusals')).toBeNull();
    expect(screen.queryByTestId('node-linked')).toBeNull();
    expect(screen.queryByTestId('node-statuses')).toBeNull();
    expect(screen.queryByTestId('node-left-to-the-platform')).toBeNull();
  });
});
