import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
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
