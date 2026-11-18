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
    {
      stepId: 'step-1',
      stepName: 'Backup',
      stepType: 'backup',
      status: 'completed',
      duration: 30000,
    },
    {
      stepId: 'step-2',
      stepName: 'Sync Accounts',
      stepType: 'sync',
      status: 'running',
      startTime: '2025-01-01T00:01:00.000Z',
    },
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

  it('gives the run progress bar an accessible name', () => {
    render(<PipelineExecutionView execution={execution} />);
    expect(screen.getByRole('progressbar', { name: 'Progress' })).toBeDefined();
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
        {
          stepId: 'step-1',
          stepName: 'Backup',
          stepType: 'backup',
          status: 'failed',
          error: 'Connection timeout',
        },
      ],
    };
    render(<PipelineExecutionView execution={withError} />);
    expect(screen.getByTestId('execution-errors')).toBeDefined();
    expect(screen.getByTestId('exec-error-step-1').textContent).toContain('Connection timeout');
  });

  it('reads a stopped step as neither failed nor completed, and what the stop left in no red', () => {
    const stopped: PipelineExecutionData = {
      ...execution,
      steps: [
        {
          stepId: 'step-1',
          stepName: 'Pause',
          stepType: 'delay',
          status: 'stopped',
          error: 'Step "Pause" was stopped before it finished.',
        },
      ],
    };
    render(<PipelineExecutionView execution={stopped} />);

    const badge = screen.getByTestId('exec-step-status-step-1').firstElementChild;
    expect(badge?.textContent).toBe('Stopped');
    expect(badge?.className).not.toContain('status-error');
    expect(badge?.className).not.toContain('status-success');
    const left = screen.getByTestId('exec-error-step-1');
    expect(left.textContent).toContain('was stopped before it finished');
    expect(left.className).not.toContain('status-error');
    expect(screen.queryByText(/failed/i)).toBeNull();
  });

  it('reads a cancelled run in the neutral colour History reads it in', () => {
    render(<PipelineExecutionView execution={{ ...execution, status: 'cancelled' }} />);

    const badge = screen.getByTestId('execution-status').firstElementChild;
    expect(badge?.textContent).toBe('Cancelled');
    expect(badge?.className).not.toContain('status-error');
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

  it('offers to cancel a run only while it is running', () => {
    const completed: PipelineExecutionData = { ...execution, status: 'completed' };
    render(<PipelineExecutionView execution={completed} onCancel={vi.fn()} />);
    expect(screen.queryByTestId('execution-cancel')).toBeNull();
  });

  it('offers Approve and Reject beside an Approval step that waits, with its message', () => {
    const onAnswerApproval = vi.fn();
    const waiting: PipelineExecutionData = {
      ...execution,
      steps: [
        {
          stepId: 'ok',
          stepName: 'Look first',
          stepType: 'approval',
          status: 'running',
          awaitingApproval: {
            message: 'Check the comparison.',
            expiresAt: '2026-10-13T09:00:00.000Z',
          },
        },
      ],
    };
    render(<PipelineExecutionView execution={waiting} onAnswerApproval={onAnswerApproval} />);

    const question = screen.getByTestId('exec-approval-ok');
    expect(question.textContent).toContain('Waiting for your approval until');
    expect(question.textContent).toContain('Check the comparison.');
    fireEvent.click(screen.getByTestId('exec-approve-ok'));
    fireEvent.click(screen.getByTestId('exec-reject-ok'));
    expect(onAnswerApproval.mock.calls).toEqual([
      ['ok', 'approved'],
      ['ok', 'rejected'],
    ]);
  });

  it('offers no answer once the Approval step has ended', () => {
    const ended: PipelineExecutionData = {
      ...execution,
      steps: [
        {
          stepId: 'ok',
          stepName: 'Look first',
          stepType: 'approval',
          status: 'completed',
          awaitingApproval: { expiresAt: '2026-10-13T09:00:00.000Z' },
        },
      ],
    };
    render(<PipelineExecutionView execution={ended} onAnswerApproval={vi.fn()} />);
    expect(screen.queryByTestId('exec-approval-ok')).toBeNull();
  });

  describe('a dry run', () => {
    /** A dry run as it ended: what each step would do, in the host's words. */
    const dry: PipelineExecutionData = {
      runId: 'dry-1',
      pipelineName: 'Nightly reset',
      status: 'failed',
      progress: 100,
      startTime: '2026-11-20T02:00:00.000Z',
      elapsed: 4,
      dryRun: true,
      steps: [
        {
          stepId: 'sync',
          stepName: 'Accounts',
          stepType: 'sync',
          status: 'completed',
          summary: 'Would sync "Accounts" into UAT: 120 to create. Nothing was written.',
        },
        {
          stepId: 'gate',
          stepName: 'Go?',
          stepType: 'approval',
          status: 'completed',
          summary: 'Not asked in a dry run: the route goes on as if it were approved.',
        },
        {
          stepId: 'seed',
          stepName: 'Demo',
          stepType: 'seed',
          status: 'failed',
          error: 'Seed "Demo" would be refused: the org has 2 MB left.',
        },
        { stepId: 'mask', stepName: 'Mask', stepType: 'anonymize', status: 'skipped' },
      ],
    };

    it('says it is a simulation, that nothing was written, and names each step’s end as what it would be', () => {
      render(<PipelineExecutionView execution={dry} />);

      // Named as the button that starts it, Simulate.
      expect(screen.getByTestId('execution-dry-run').textContent).toBe('Simulation');
      expect(screen.getByTestId('execution-dry-run-note').textContent).toMatch(/^A simulation: /);
      expect(screen.getByTestId('execution-dry-run-note').textContent).toContain(
        'nothing is written to any org',
      );
      expect(screen.getByTestId('execution-status').textContent).toBe('Would stop');
      expect(screen.getByTestId('exec-step-status-sync').textContent).toBe('Would run');
      expect(screen.getByTestId('exec-step-status-seed').textContent).toBe('Would stop here');
      expect(screen.getByTestId('exec-step-status-mask').textContent).toBe('Would be skipped');
      expect(screen.getByTestId('exec-step-summary-sync').textContent).toBe(
        'Would sync "Accounts" into UAT: 120 to create. Nothing was written.',
      );
      expect(screen.getByTestId('exec-error-seed').textContent).toContain('would be refused');
    });

    it('names a run’s steps as a run’s, never as what they would do', () => {
      render(<PipelineExecutionView execution={{ ...dry, dryRun: false }} />);
      expect(screen.queryByTestId('execution-dry-run')).toBeNull();
      expect(screen.queryByTestId('execution-dry-run-note')).toBeNull();
      expect(screen.getByTestId('execution-status').textContent).toBe('Failed');
      expect(screen.getByTestId('exec-step-status-sync').textContent).toBe('Completed');
    });

    it('is put away by Close once it has ended, and offers no Cancel', () => {
      const onClose = vi.fn();
      render(<PipelineExecutionView execution={dry} onClose={onClose} onCancel={vi.fn()} />);
      expect(screen.queryByTestId('execution-cancel')).toBeNull();
      fireEvent.click(screen.getByTestId('execution-close'));
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('offers no Close while it goes', () => {
      render(
        <PipelineExecutionView
          execution={{ ...dry, status: 'running' }}
          onClose={vi.fn()}
          onCancel={vi.fn()}
        />,
      );
      expect(screen.queryByTestId('execution-close')).toBeNull();
      expect(screen.getByTestId('execution-cancel')).toBeDefined();
    });
  });
});
