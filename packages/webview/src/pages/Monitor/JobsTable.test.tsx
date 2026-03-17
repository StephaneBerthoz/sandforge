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
    expect(screen.getByText(/2/)).toBeDefined(); // 2 runs
    expect(screen.getByText(/50%/)).toBeDefined(); // 50% success
    expect(screen.getByText(/1/)).toBeDefined(); // 1 failed
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
    expect(screen.getByText(/2/)).toBeDefined();
  });
});
