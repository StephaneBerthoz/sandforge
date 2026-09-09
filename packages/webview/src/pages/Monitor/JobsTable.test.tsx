import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '../../i18n';
import { JobsTable } from './JobsTable';
import type { JobDisplayInfo } from './MonitorPage';

function createJob(overrides: Partial<JobDisplayInfo> = {}): JobDisplayInfo {
  return {
    id: `j-${Math.random().toString(36).slice(2, 8)}`,
    jobType: 'BatchApex',
    status: 'Completed',
    objectType: 'Account',
    createdBy: 'Admin',
    createdDate: '2026-02-24T10:00:00Z',
    totalRecords: 100,
    processedRecords: 100,
    failedRecords: 0,
    ...overrides,
  };
}

describe('JobsTable', () => {
  it('should render empty state when no jobs', () => {
    render(<JobsTable jobs={[]} />);
    expect(screen.getByText(/No recent jobs/i)).toBeDefined();
  });

  it('should render filter buttons', () => {
    render(<JobsTable jobs={[createJob()]} />);
    expect(screen.getByTestId('job-filters')).toBeDefined();
    expect(screen.getByTestId('filter-all')).toBeDefined();
    expect(screen.getByTestId('filter-running')).toBeDefined();
    expect(screen.getByTestId('filter-failed')).toBeDefined();
    expect(screen.getByTestId('filter-completed')).toBeDefined();
  });

  it('should group jobs by type', () => {
    const jobs = [
      createJob({ jobType: 'BatchApex' }),
      createJob({ jobType: 'BatchApex' }),
      createJob({ jobType: 'Future' }),
    ];
    render(<JobsTable jobs={jobs} />);
    expect(screen.getByTestId('job-group-BatchApex')).toBeDefined();
    expect(screen.getByTestId('job-group-Future')).toBeDefined();
  });

  it('should show run count and success rate per group', () => {
    const jobs = [
      createJob({ jobType: 'BatchApex', status: 'Completed' }),
      createJob({ jobType: 'BatchApex', status: 'Failed' }),
    ];
    render(<JobsTable jobs={jobs} />);
    expect(screen.getByText('2 runs')).toBeDefined();
    expect(screen.getByText('50% success')).toBeDefined();
    expect(screen.getByText('1 failed')).toBeDefined();
  });

  it('should expand/collapse groups on click', () => {
    const jobs = [createJob({ id: 'j1', jobType: 'BatchApex' })];
    render(<JobsTable jobs={jobs} />);

    // Initially collapsed
    expect(screen.queryByTestId('group-jobs-BatchApex')).toBeNull();

    // Expand
    fireEvent.click(screen.getByTestId('group-toggle-BatchApex'));
    expect(screen.getByTestId('group-jobs-BatchApex')).toBeDefined();
    expect(screen.getByTestId('job-row-j1')).toBeDefined();

    // Collapse
    fireEvent.click(screen.getByTestId('group-toggle-BatchApex'));
    expect(screen.queryByTestId('group-jobs-BatchApex')).toBeNull();
  });

  it('should filter by running status', () => {
    const jobs = [
      createJob({ id: 'j-run', jobType: 'BatchApex', status: 'Processing' }),
      createJob({ id: 'j-done', jobType: 'BatchApex', status: 'Completed' }),
    ];
    render(<JobsTable jobs={jobs} />);

    fireEvent.click(screen.getByTestId('filter-running'));
    // After filtering, only 1 job should appear — expand and verify the Processing row
    fireEvent.click(screen.getByTestId('group-toggle-BatchApex'));
    expect(screen.getByTestId('job-row-j-run')).toBeDefined();
    expect(screen.queryByTestId('job-row-j-done')).toBeNull();
  });

  it('should filter by failed status', () => {
    const jobs = [
      createJob({ id: 'j-fail', jobType: 'BatchApex', status: 'Failed' }),
      createJob({ id: 'j-ok', jobType: 'BatchApex', status: 'Completed' }),
    ];
    render(<JobsTable jobs={jobs} />);

    fireEvent.click(screen.getByTestId('filter-failed'));
    fireEvent.click(screen.getByTestId('group-toggle-BatchApex'));
    expect(screen.getByTestId('job-row-j-fail')).toBeDefined();
    expect(screen.queryByTestId('job-row-j-ok')).toBeNull();
  });

  it('should show job details in expanded row', () => {
    const jobs = [
      createJob({
        id: 'j1',
        jobType: 'BatchApex',
        status: 'Completed',
        objectType: 'Account',
        totalRecords: 500,
        processedRecords: 500,
        createdBy: 'John',
      }),
    ];
    render(<JobsTable jobs={jobs} />);
    fireEvent.click(screen.getByTestId('group-toggle-BatchApex'));

    expect(screen.getByText('Account')).toBeDefined();
    expect(screen.getByText('John')).toBeDefined();
    expect(screen.getByText(/500/)).toBeDefined();
  });

  it('should show error count on failed jobs', () => {
    const jobs = [
      createJob({
        id: 'j1',
        jobType: 'BatchApex',
        status: 'Failed',
        failedRecords: 42,
        totalRecords: 100,
        processedRecords: 58,
      }),
    ];
    render(<JobsTable jobs={jobs} />);
    fireEvent.click(screen.getByTestId('group-toggle-BatchApex'));

    expect(screen.getByText(/42 err/)).toBeDefined();
  });

  it('should show active count in header', () => {
    const jobs = [
      createJob({ status: 'Processing' }),
      createJob({ status: 'Queued' }),
      createJob({ status: 'Completed' }),
    ];
    render(<JobsTable jobs={jobs} />);
    expect(screen.getByText('2 active')).toBeDefined();
  });

  it('should show how many jobs each filter keeps', () => {
    const jobs = [
      createJob({ status: 'Failed' }),
      createJob({ status: 'Failed' }),
      createJob({ status: 'Processing' }),
      createJob({ status: 'Completed' }),
      createJob({ status: 'Completed' }),
      createJob({ status: 'Completed' }),
    ];
    render(<JobsTable jobs={jobs} />);

    expect(screen.getByTestId('filter-count-all').textContent).toBe('6');
    expect(screen.getByTestId('filter-count-running').textContent).toBe('1');
    expect(screen.getByTestId('filter-count-failed').textContent).toBe('2');
    expect(screen.getByTestId('filter-count-completed').textContent).toBe('3');
  });

  it('should keep the filter counts on the full job list, not on the filtered one', () => {
    const jobs = [createJob({ status: 'Failed' }), createJob({ status: 'Completed' })];
    render(<JobsTable jobs={jobs} />);

    fireEvent.click(screen.getByTestId('filter-running'));

    // The list is empty under this filter; the counters must still say why.
    expect(screen.getByTestId('filter-count-running').textContent).toBe('0');
    expect(screen.getByTestId('filter-count-failed').textContent).toBe('1');
    expect(screen.getByTestId('filter-count-all').textContent).toBe('2');
  });

  it('should list groups carrying failures before healthy ones', () => {
    const jobs = [
      createJob({ id: 'a1', jobType: 'AlphaBatch', status: 'Completed' }),
      createJob({ id: 'a2', jobType: 'AlphaBatch', status: 'Completed' }),
      createJob({ id: 'z1', jobType: 'ZuluBatch', status: 'Failed' }),
    ];
    render(<JobsTable jobs={jobs} />);

    const order = Array.from(screen.getByTestId('job-groups').children).map((el) =>
      el.getAttribute('data-testid'),
    );
    expect(order).toEqual(['job-group-ZuluBatch', 'job-group-AlphaBatch']);
  });
});
