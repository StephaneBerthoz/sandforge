import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import '../../i18n';
import { AnalyticsDashboard } from './AnalyticsDashboard';
import type { AnalyticsSummary } from './AnalyticsDashboard';
import type { AnalyticsTimeSeries } from '@sandforge/shared';

/* Mock Recharts since it requires DOM measurements */
vi.mock('recharts', () => ({
  BarChart: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="mock-barchart">{children}</div>
  ),
  Bar: () => <div />,
  XAxis: () => <div />,
  YAxis: () => <div />,
  Tooltip: () => <div />,
  ResponsiveContainer: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  LineChart: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="mock-linechart">{children}</div>
  ),
  Line: () => <div />,
  CartesianGrid: () => <div />,
}));

const summary: AnalyticsSummary = {
  totalOperations: 150,
  successRate: 94.5,
  avgDuration: 8500,
  errorRate: 5.5,
};

const opsTimeSeries: AnalyticsTimeSeries = {
  metric: 'operations',
  points: [
    { metric: 'operations', value: 10, timestamp: '2026-02-18T00:00:00Z', dimensions: {} },
    { metric: 'operations', value: 15, timestamp: '2026-02-19T00:00:00Z', dimensions: {} },
    { metric: 'operations', value: 8, timestamp: '2026-02-20T00:00:00Z', dimensions: {} },
  ],
  aggregation: 'count',
  interval: 'day',
};

const errorTimeSeries: AnalyticsTimeSeries = {
  metric: 'errors',
  points: [
    { metric: 'errors', value: 2, timestamp: '2026-02-18T00:00:00Z', dimensions: {} },
    { metric: 'errors', value: 1, timestamp: '2026-02-19T00:00:00Z', dimensions: {} },
  ],
  aggregation: 'count',
  interval: 'day',
};

describe('AnalyticsDashboard', () => {
  it('should render the dashboard', () => {
    render(<AnalyticsDashboard summary={summary} />);
    expect(screen.getByTestId('analytics-dashboard')).toBeDefined();
  });

  it('should show empty state when no data', () => {
    render(<AnalyticsDashboard />);
    expect(screen.getByText('No reports generated yet')).toBeDefined();
  });

  it('should show summary cards', () => {
    render(<AnalyticsDashboard summary={summary} />);
    expect(screen.getByTestId('analytics-summary')).toBeDefined();
  });

  it('should show total operations', () => {
    render(<AnalyticsDashboard summary={summary} />);
    expect(screen.getByText('150')).toBeDefined();
  });

  it('should show success rate', () => {
    render(<AnalyticsDashboard summary={summary} />);
    expect(screen.getByText('94.5%')).toBeDefined();
  });

  it('should show avg duration', () => {
    render(<AnalyticsDashboard summary={summary} />);
    expect(screen.getByText('8.5s')).toBeDefined();
  });

  it('should show error rate', () => {
    render(<AnalyticsDashboard summary={summary} />);
    expect(screen.getByText('5.5%')).toBeDefined();
  });

  it('should render operations chart', () => {
    render(<AnalyticsDashboard summary={summary} operationsOverTime={opsTimeSeries} />);
    expect(screen.getByTestId('ops-chart')).toBeDefined();
    expect(screen.getByTestId('mock-barchart')).toBeDefined();
  });

  it('should render error chart', () => {
    render(<AnalyticsDashboard summary={summary} errorTimeSeries={errorTimeSeries} />);
    expect(screen.getByTestId('error-chart')).toBeDefined();
    expect(screen.getByTestId('mock-linechart')).toBeDefined();
  });
});
