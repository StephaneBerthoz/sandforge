import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '../../i18n';
import { PipelineExecutionView } from './PipelineExecutionView';
import type { PipelineExecutionData } from './PipelineExecutionView';

const execution: PipelineExecutionData = {
  runId: 'run-1',
  pipelineName: 'Daily Sync',
  status: 'running',
  progress: 50,
  startTime: '2025-01-01T00:00:00.000Z',
  elapsed: 120,
  steps: [
    { stepId: 'step-1', stepName: 'Backup', stepType: 'backup', status: 'completed', duration: 30000 },
    { stepId: 'step-2', stepName: 'Sync Accounts', stepType: 'sync', status: 'running', startTime: '2025-01-01T00:01:00.000Z' },
    { stepId: 'step-3', stepName: 'Notify', stepType: 'notification', status: 'pending' },
  ],
};

describe('PipelineExecutionView', () => {
  it('should show empty state when no execution', () => {
    render(<PipelineExecutionView />);
    expect(screen.getByTestId('execution-empty')).toBeDefined();
  });

  it('should render execution view', () => {
    render(<PipelineExecutionView execution={execution} />);
    expect(screen.getByTestId('execution-view')).toBeDefined();
  });

  it('should show pipeline name and status', () => {
    render(<PipelineExecutionView execution={execution} />);
    expect(screen.getByTestId('execution-view').textContent).toContain('Daily Sync');
    expect(screen.getByTestId('execution-status').textContent).toContain('Running');
  });

  it('should show progress bar', () => {
    render(<PipelineExecutionView execution={execution} />);
    expect(screen.getByTestId('execution-progress')).toBeDefined();
  });

  it('should show step count and elapsed', () => {
    render(<PipelineExecutionView execution={execution} />);
    const stats = screen.getByTestId('execution-stats');
    expect(stats.textContent).toContain('1/3');
    expect(stats.textContent).toContain('2m');
  });

  it('should render all steps', () => {
    render(<PipelineExecutionView execution={execution} />);
    expect(screen.getByTestId('exec-step-step-1')).toBeDefined();
    expect(screen.getByTestId('exec-step-step-2')).toBeDefined();
    expect(screen.getByTestId('exec-step-step-3')).toBeDefined();
  });

  it('should show step status badges', () => {
    render(<PipelineExecutionView execution={execution} />);
    expect(screen.getByTestId('exec-step-status-step-1').textContent).toContain('Completed');
    expect(screen.getByTestId('exec-step-status-step-2').textContent).toContain('Running');
    expect(screen.getByTestId('exec-step-status-step-3').textContent).toContain('Pending');
  });

  it('should show pause button when running', () => {
    const onPause = vi.fn();
    render(<PipelineExecutionView execution={execution} onPause={onPause} />);
    const btn = screen.getByTestId('execution-pause');
    expect(btn).toBeDefined();
    fireEvent.click(btn);
    expect(onPause).toHaveBeenCalled();
  });

  it('should show resume button when paused', () => {
    const onResume = vi.fn();
    const paused: PipelineExecutionData = { ...execution, status: 'paused' };
    render(<PipelineExecutionView execution={paused} onResume={onResume} />);
    const btn = screen.getByTestId('execution-resume');
    fireEvent.click(btn);
    expect(onResume).toHaveBeenCalled();
  });

  it('should show cancel button when active', () => {
    const onCancel = vi.fn();
    render(<PipelineExecutionView execution={execution} onCancel={onCancel} />);
    const btn = screen.getByTestId('execution-cancel');
    fireEvent.click(btn);
    expect(onCancel).toHaveBeenCalled();
  });

  it('should show error details for failed steps', () => {
    const withError: PipelineExecutionData = {
      ...execution,
      steps: [
        { stepId: 'step-1', stepName: 'Backup', stepType: 'backup', status: 'failed', error: 'Connection timeout' },
      ],
    };
    render(<PipelineExecutionView execution={withError} />);
    expect(screen.getByTestId('execution-errors')).toBeDefined();
    expect(screen.getByTestId('exec-error-step-1').textContent).toContain('Connection timeout');
  });

  it('should show failed step count', () => {
    const withFailed: PipelineExecutionData = {
      ...execution,
      steps: [
        { stepId: 's1', stepName: 'A', stepType: 'backup', status: 'completed' },
        { stepId: 's2', stepName: 'B', stepType: 'sync', status: 'failed', error: 'err' },
      ],
    };
    render(<PipelineExecutionView execution={withFailed} />);
    const stats = screen.getByTestId('execution-stats');
    expect(stats.textContent).toContain('1');
    expect(stats.textContent).toContain('failed');
  });

  it('should not show pause when completed', () => {
    const completed: PipelineExecutionData = { ...execution, status: 'completed' };
    render(<PipelineExecutionView execution={completed} onPause={vi.fn()} />);
    expect(screen.queryByTestId('execution-pause')).toBeNull();
  });
});
