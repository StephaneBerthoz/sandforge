import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '../../i18n';
import { PipelineHistoryView } from './PipelineHistoryView';
import type { PipelineHistoryEntry } from '@sandforge/shared';

const entries: PipelineHistoryEntry[] = [
  {
    runId: 'run-1',
    pipelineId: 'pipe-1',
    pipelineName: 'Daily Backup',
    status: 'completed',
    triggeredBy: 'schedule',
    startTime: '2026-02-20T00:00:00Z',
    duration: 45000,
    stepCount: 3,
    errorCount: 0,
  },
  {
    runId: 'run-2',
    pipelineId: 'pipe-2',
    pipelineName: 'Weekly Sync',
    status: 'failed',
    triggeredBy: 'manual',
    startTime: '2026-02-19T10:00:00Z',
    duration: 120000,
    stepCount: 5,
    errorCount: 2,
  },
];

describe('PipelineHistoryView', () => {
  it('should render the history view', () => {
    render(<PipelineHistoryView />);
    expect(screen.getByTestId('pipeline-history')).toBeDefined();
  });

  it('should show empty state when no entries', () => {
    render(<PipelineHistoryView />);
    expect(screen.getByText('No execution history')).toBeDefined();
  });

  it('should show history entries', () => {
    render(<PipelineHistoryView entries={entries} />);
    expect(screen.getByTestId('history-run-1')).toBeDefined();
    expect(screen.getByTestId('history-run-2')).toBeDefined();
  });

  it('should show pipeline names', () => {
    render(<PipelineHistoryView entries={entries} />);
    expect(screen.getByText('Daily Backup')).toBeDefined();
    expect(screen.getByText('Weekly Sync')).toBeDefined();
  });

  it('should show status badges', () => {
    render(<PipelineHistoryView entries={entries} />);
    expect(screen.getByText('Completed')).toBeDefined();
    expect(screen.getByText('Failed')).toBeDefined();
  });

  it('should show duration', () => {
    render(<PipelineHistoryView entries={entries} />);
    expect(screen.getByText(/45s/)).toBeDefined();
    expect(screen.getByText(/2min/)).toBeDefined();
  });

  it('should show error count for failed runs', () => {
    render(<PipelineHistoryView entries={entries} />);
    expect(screen.getByText('2 errors')).toBeDefined();
  });

  it('should call onSelectRun when clicked', () => {
    const onSelect = vi.fn();
    render(<PipelineHistoryView entries={entries} onSelectRun={onSelect} />);
    const wrapper = screen.getByTestId('history-run-1');
    fireEvent.click(wrapper.querySelector('[role="button"]')!);
    expect(onSelect).toHaveBeenCalledWith('run-1');
  });

  it('should show triggered by info', () => {
    render(<PipelineHistoryView entries={entries} />);
    expect(screen.getAllByText(/Schedule/).length).toBeGreaterThan(0);
  });
});
