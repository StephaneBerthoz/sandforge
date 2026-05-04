import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '../../i18n';
import { HealthScoreCard } from './HealthScoreCard';
import type { HealthReport } from '@sandforge/shared';

const healthyReport: HealthReport = {
  overallScore: 95,
  overallStatus: 'healthy',
  factors: [
    {
      name: 'DailyApiRequests',
      category: 'limits',
      score: 100,
      weight: 0.2,
      status: 'healthy',
      detail: '20% used (3,000 / 15,000)',
      recommendation: 'No action needed.',
      trend: 'stable',
    },
    {
      name: 'DataStorageMB',
      category: 'storage',
      score: 80,
      weight: 0.2,
      status: 'healthy',
      detail: '60% used (300 / 500)',
      recommendation: 'No action needed.',
      trend: 'stable',
    },
  ],
  summary: 'Your org is healthy. All limits are within safe thresholds.',
  topRisks: [],
};

const warningReport: HealthReport = {
  overallScore: 62,
  overallStatus: 'warning',
  factors: [
    {
      name: 'DailyApiRequests',
      category: 'limits',
      score: 50,
      weight: 0.2,
      status: 'warning',
      detail: '83% used (12,450 / 15,000)',
      recommendation: 'Review scheduled batch jobs.',
      trend: 'degrading',
    },
    {
      name: 'DataStorageMB',
      category: 'storage',
      score: 20,
      weight: 0.2,
      status: 'critical',
      detail: '93% used (465 / 500)',
      recommendation: 'Urgent: Consider archiving old records.',
      trend: 'degrading',
    },
  ],
  summary: 'Warning: DailyApiRequests, DataStorageMB approaching limits.',
  topRisks: [
    {
      name: 'DataStorageMB',
      category: 'storage',
      score: 20,
      weight: 0.2,
      status: 'critical',
      detail: '93% used',
      recommendation: 'Urgent: Archive old records.',
      trend: 'degrading',
    },
    {
      name: 'DailyApiRequests',
      category: 'limits',
      score: 50,
      weight: 0.2,
      status: 'warning',
      detail: '83% used',
      recommendation: 'Review batch jobs.',
      trend: 'degrading',
    },
  ],
};

describe('HealthScoreCard', () => {
  it('should render the gauge', () => {
    render(<HealthScoreCard report={healthyReport} />);
    expect(screen.getByTestId('health-gauge')).toBeDefined();
    expect(screen.getByText('95')).toBeDefined();
  });

  it('should render summary text', () => {
    render(<HealthScoreCard report={healthyReport} />);
    expect(screen.getByTestId('health-summary')).toBeDefined();
    expect(screen.getByText(healthyReport.summary)).toBeDefined();
  });

  it('should show no top risks for healthy report', () => {
    render(<HealthScoreCard report={healthyReport} />);
    expect(screen.queryByTestId('top-risks')).toBeNull();
  });

  it('should show top risks for warning report', () => {
    render(<HealthScoreCard report={warningReport} />);
    expect(screen.getByTestId('top-risks')).toBeDefined();
    const matches = screen.getAllByText(/DataStorageMB/);
    expect(matches.length).toBeGreaterThanOrEqual(1);
  });

  it('should show View Full Report button', () => {
    render(<HealthScoreCard report={healthyReport} />);
    expect(screen.getByTestId('view-full-report')).toBeDefined();
  });

  it('should open modal on View Full Report click', () => {
    render(<HealthScoreCard report={warningReport} />);
    fireEvent.click(screen.getByTestId('view-full-report'));
    expect(screen.getByTestId('health-report-modal')).toBeDefined();
  });

  it('should close modal on close button click', () => {
    render(<HealthScoreCard report={warningReport} />);
    fireEvent.click(screen.getByTestId('view-full-report'));
    expect(screen.getByTestId('health-report-modal')).toBeDefined();
    fireEvent.click(screen.getByTestId('close-report-modal'));
    expect(screen.queryByTestId('health-report-modal')).toBeNull();
  });

  it('should display categories in modal', () => {
    render(<HealthScoreCard report={warningReport} />);
    fireEvent.click(screen.getByTestId('view-full-report'));
    expect(screen.getByTestId('category-limits')).toBeDefined();
    expect(screen.getByTestId('category-storage')).toBeDefined();
  });

  it('should display factor recommendations in modal', () => {
    render(<HealthScoreCard report={warningReport} />);
    fireEvent.click(screen.getByTestId('view-full-report'));
    expect(screen.getByText(/Review scheduled batch jobs/)).toBeDefined();
  });
});
