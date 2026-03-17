import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import '../../../i18n';
import { ControlPanel } from './ControlPanel';

vi.mock('../../../stores/useAutopilotStore', () => {
  const defaultState = {
    liveStats: {
      recordsProcessed: 0,
      recordsTotal: 100,
      apiCallsUsed: 0,
      apiCallsEstimated: 50,
      elapsedMs: 0,
      currentWave: 0,
      totalWaves: 3,
    },
    executionStatus: 'executing' as const,
    selectedNodeName: null,
    complianceFramework: 'none' as const,
    rules: [],
    graph: null,
    selectedNode: () => undefined,
    failedCount: () => 0,
    completedCount: () => 0,
    overallProgress: () => 0,
    setExecutionStatus: vi.fn(),
    updateNodeStatus: vi.fn(),
  };

  const store = Object.assign(
    (selector: (state: typeof defaultState) => unknown) => selector(defaultState),
    { getState: () => defaultState },
  );

  return { useAutopilotStore: store };
});

describe('ControlPanel', () => {
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

  it('should show pause button when executing', () => {
    render(<ControlPanel />);
    expect(screen.getByTestId('control-pause-resume')).toBeDefined();
  });
});
