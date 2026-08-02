import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import '../../i18n';
import type { JobDisplayInfo } from './JobsPanel';
import { JobsPanel } from './JobsPanel';

const mockJobs: JobDisplayInfo[] = [
  {
    id: 'j1',
    jobType: 'Bulk',
    status: 'Processing',
    objectType: 'Account',
    createdBy: 'admin@test.com',
    createdDate: '2024-01-01T10:00:00Z',
    totalRecords: 5000,
    processedRecords: 2500,
    failedRecords: 10,
  },
  {
    id: 'j2',
    jobType: 'Batch',
    status: 'Completed',
    objectType: 'Contact',
    createdBy: 'user@test.com',
    createdDate: '2024-01-01T09:00:00Z',
    totalRecords: 1000,
    processedRecords: 1000,
    failedRecords: 0,
  },
  {
    id: 'j3',
    jobType: 'Future',
    status: 'Failed',
    createdBy: 'batch@test.com',
    createdDate: '2024-01-01T08:00:00Z',
  },
];

describe('JobsPanel', () => {
  it('should render the jobs title', () => {
    render(<JobsPanel jobs={mockJobs} />);
    expect(screen.getByText('Jobs')).toBeDefined();
  });

  it('should show active job count in subtitle', () => {
    render(<JobsPanel jobs={mockJobs} />);
    expect(screen.getByText('1 active')).toBeDefined();
  });

  it('should render table with headers', () => {
    render(<JobsPanel jobs={mockJobs} />);
    expect(screen.getByTestId('jobs-table')).toBeDefined();
    expect(screen.getByText('Type')).toBeDefined();
    expect(screen.getByText('Status')).toBeDefined();
  });

  it('should render all job rows', () => {
    render(<JobsPanel jobs={mockJobs} />);
    expect(screen.getByTestId('job-row-j1')).toBeDefined();
    expect(screen.getByTestId('job-row-j2')).toBeDefined();
    expect(screen.getByTestId('job-row-j3')).toBeDefined();
  });

  it('should display job type and object', () => {
    render(<JobsPanel jobs={mockJobs} />);
    expect(screen.getByText('Bulk')).toBeDefined();
    expect(screen.getByText('Account')).toBeDefined();
  });

  it('should display status badges', () => {
    render(<JobsPanel jobs={mockJobs} />);
    expect(screen.getByText('Processing')).toBeDefined();
    expect(screen.getByText('Completed')).toBeDefined();
    expect(screen.getByText('Failed')).toBeDefined();
  });

  it('should display progress with record counts', () => {
    render(<JobsPanel jobs={mockJobs} />);
    /* toLocaleString may or may not add commas depending on test environment locale */
    expect(screen.getByText(/2.?500 \/ 5.?000/)).toBeDefined();
  });

  it('should show error count for failed records', () => {
    render(<JobsPanel jobs={mockJobs} />);
    expect(screen.getByText(/10 err/)).toBeDefined();
  });

  it('should show no data message when empty', () => {
    render(<JobsPanel jobs={[]} />);
    expect(screen.getByText('No data available')).toBeDefined();
  });
});
