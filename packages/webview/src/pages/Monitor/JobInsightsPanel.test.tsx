import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '../../i18n';
import { JobInsightsPanel } from './JobInsightsPanel';
import type { JobInsight } from '@sandforge/shared';

const stuckInsight: JobInsight = {
  type: 'stuck',
  severity: 'critical',
  title: 'Stuck job: ScheduledReportJob',
  detail: 'Job j-stuck has been processing for 2.5h. This appears stuck.',
  affectedJobs: ['j-stuck'],
  recommendation: 'Consider aborting job j-stuck.',
};

const failureInsight: JobInsight = {
  type: 'frequent_failures',
  severity: 'warning',
  title: 'Frequent failures: BatchAccountSync',
  detail: 'Failed 8 times in the last 24h. Most common error: System.LimitException',
  affectedJobs: ['j1', 'j2', 'j3', 'j4', 'j5', 'j6', 'j7', 'j8'],
  recommendation: 'Check the error handling in BatchAccountSync.',
};

const infoInsight: JobInsight = {
  type: 'high_consumer',
  severity: 'info',
  title: 'High consumer: BatchDataMigration',
  detail: 'Processing up to 5,000 batch items.',
  affectedJobs: ['j-big'],
  recommendation: 'Monitor for governor limit consumption.',
};

describe('JobInsightsPanel', () => {
  it('should render nothing when insights are empty', () => {
    const { container } = render(<JobInsightsPanel insights={[]} />);
    expect(container.innerHTML).toBe('');
  });

  it('should render the panel with insights count', () => {
    render(<JobInsightsPanel insights={[stuckInsight, failureInsight]} />);
    expect(screen.getByTestId('job-insights-panel')).toBeDefined();
    expect(screen.getByText(/2 alert/)).toBeDefined();
  });

  it('should show critical and warning badges', () => {
    render(<JobInsightsPanel insights={[stuckInsight, failureInsight]} />);
    const criticalMatches = screen.getAllByText(/critical/i);
    expect(criticalMatches.length).toBeGreaterThanOrEqual(1);
    const warningMatches = screen.getAllByText(/warning/i);
    expect(warningMatches.length).toBeGreaterThanOrEqual(1);
  });

  it('should display insight details when expanded', () => {
    render(<JobInsightsPanel insights={[failureInsight]} />);
    expect(screen.getByText(/Frequent failures: BatchAccountSync/)).toBeDefined();
    expect(screen.getByText(/Failed 8 times/)).toBeDefined();
    expect(screen.getByText(/Check the error handling/)).toBeDefined();
  });

  it('should toggle expanded/collapsed on click', () => {
    render(<JobInsightsPanel insights={[failureInsight]} />);
    expect(screen.getByTestId('insights-list')).toBeDefined();

    fireEvent.click(screen.getByTestId('insights-toggle'));
    expect(screen.queryByTestId('insights-list')).toBeNull();

    fireEvent.click(screen.getByTestId('insights-toggle'));
    expect(screen.getByTestId('insights-list')).toBeDefined();
  });

  it('should show Abort Job button for stuck jobs', () => {
    const onAbort = vi.fn();
    render(<JobInsightsPanel insights={[stuckInsight]} onAbortJob={onAbort} />);
    const abortBtn = screen.getByTestId('abort-job-j-stuck');
    expect(abortBtn).toBeDefined();

    fireEvent.click(abortBtn);
    expect(onAbort).toHaveBeenCalledWith('j-stuck');
  });

  it('should not show Abort Job button without onAbortJob callback', () => {
    render(<JobInsightsPanel insights={[stuckInsight]} />);
    expect(screen.queryByTestId('abort-job-j-stuck')).toBeNull();
  });

  it('should not show Abort Job for non-stuck insights', () => {
    const onAbort = vi.fn();
    render(<JobInsightsPanel insights={[failureInsight]} onAbortJob={onAbort} />);
    expect(screen.queryByText(/Abort Job/)).toBeNull();
  });

  it('should render all insight types', () => {
    render(<JobInsightsPanel insights={[stuckInsight, failureInsight, infoInsight]} />);
    expect(screen.getByTestId('insight-stuck')).toBeDefined();
    expect(screen.getByTestId('insight-frequent_failures')).toBeDefined();
    expect(screen.getByTestId('insight-high_consumer')).toBeDefined();
  });
});
