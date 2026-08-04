import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import '../../i18n';
import type { RealTimeSyncMetrics } from '@sandforge/shared';
import { CDCMetricsDashboard, formatUptime } from './CDCMetricsDashboard';
import { useCDCMetricsStore } from '../../stores/useCDCMetricsStore';
import { useCDCLiveStore } from '../../stores/useCDCLiveStore';

vi.mock('../../hooks/useVSCodeApi', () => ({
  getVscodeApi: () => ({
    postMessage: vi.fn(),
    getState: () => undefined,
    setState: () => undefined,
  }),
}));

/** Create a fake metrics snapshot with sensible defaults. */
function fakeMetrics(overrides?: Partial<RealTimeSyncMetrics>): RealTimeSyncMetrics {
  return {
    eventsReceived: 100,
    eventsApplied: 95,
    eventsFailed: 5,
    eventsPerMinute: 120,
    averageLagMs: 200,
    currentLagMs: 150,
    errorRate: 0.5,
    startedAt: '2026-03-27T10:00:00.000Z',
    lastEventAt: '2026-03-27T10:05:00.000Z',
    ...overrides,
  };
}

describe('CDCMetricsDashboard', () => {
  beforeEach(() => {
    useCDCMetricsStore.getState().reset();
    useCDCLiveStore.getState().reset();
  });

  it('should render placeholder when no metrics available', () => {
    render(<CDCMetricsDashboard />);
    const dashboard = screen.getByTestId('cdc-metrics-dashboard');
    expect(dashboard.textContent).toContain('Start a CDC stream to see metrics');
  });

  it('should render all 6 metric cards when metrics are available', () => {
    useCDCMetricsStore.setState({ metrics: fakeMetrics(), metricsHistory: [fakeMetrics()] });
    useCDCLiveStore.setState({ status: 'syncing' });

    render(<CDCMetricsDashboard />);

    expect(screen.getByTestId('cdc-metric-throughput')).toBeDefined();
    expect(screen.getByTestId('cdc-metric-lag')).toBeDefined();
    expect(screen.getByTestId('cdc-metric-applied')).toBeDefined();
    expect(screen.getByTestId('cdc-metric-failed')).toBeDefined();
    expect(screen.getByTestId('cdc-metric-error-rate')).toBeDefined();
    expect(screen.getByTestId('cdc-metric-uptime')).toBeDefined();
  });

  it('should display correct evt/s throughput value', () => {
    useCDCMetricsStore.setState({
      metrics: fakeMetrics({ eventsPerMinute: 300 }),
      metricsHistory: [],
    });

    render(<CDCMetricsDashboard />);

    const throughput = screen.getByTestId('cdc-metric-throughput');
    expect(throughput.textContent).toContain('5.0');
    expect(throughput.textContent).toContain('evt/s');
  });

  it('should apply green color for lag under 500ms', () => {
    useCDCMetricsStore.setState({
      metrics: fakeMetrics({ currentLagMs: 100 }),
      metricsHistory: [],
    });

    render(<CDCMetricsDashboard />);

    const lag = screen.getByTestId('cdc-metric-lag');
    const valueEl = lag.querySelector('.text-green-500');
    expect(valueEl).not.toBeNull();
  });

  it('should apply yellow color for lag between 500-2000ms', () => {
    useCDCMetricsStore.setState({
      metrics: fakeMetrics({ currentLagMs: 1000 }),
      metricsHistory: [],
    });

    render(<CDCMetricsDashboard />);

    const lag = screen.getByTestId('cdc-metric-lag');
    const valueEl = lag.querySelector('.text-yellow-500');
    expect(valueEl).not.toBeNull();
  });

  it('should apply red color for lag over 2000ms', () => {
    useCDCMetricsStore.setState({
      metrics: fakeMetrics({ currentLagMs: 3000 }),
      metricsHistory: [],
    });

    render(<CDCMetricsDashboard />);

    const lag = screen.getByTestId('cdc-metric-lag');
    const valueEl = lag.querySelector('.text-red-500');
    expect(valueEl).not.toBeNull();
  });

  it('should apply green color for error rate under 1%', () => {
    useCDCMetricsStore.setState({ metrics: fakeMetrics({ errorRate: 0.5 }), metricsHistory: [] });

    render(<CDCMetricsDashboard />);

    const errorRate = screen.getByTestId('cdc-metric-error-rate');
    const valueEl = errorRate.querySelector('.text-green-500');
    expect(valueEl).not.toBeNull();
  });

  it('should apply red color for error rate over 5%', () => {
    useCDCMetricsStore.setState({ metrics: fakeMetrics({ errorRate: 10 }), metricsHistory: [] });

    render(<CDCMetricsDashboard />);

    const errorRate = screen.getByTestId('cdc-metric-error-rate');
    const valueEl = errorRate.querySelector('.text-red-500');
    expect(valueEl).not.toBeNull();
  });

  it('should render sparklines with correct SVG polyline when history has 2+ points', () => {
    const history = [fakeMetrics({ eventsPerMinute: 60 }), fakeMetrics({ eventsPerMinute: 120 })];
    useCDCMetricsStore.setState({ metrics: fakeMetrics(), metricsHistory: history });

    render(<CDCMetricsDashboard />);

    const sparklines = screen.getAllByTestId('sparkline');
    expect(sparklines.length).toBeGreaterThanOrEqual(1);
    const polyline = sparklines[0]?.querySelector('polyline');
    expect(polyline).not.toBeNull();
  });

  it('should display uptime in the uptime card', () => {
    useCDCMetricsStore.setState({
      metrics: fakeMetrics({ startedAt: new Date(Date.now() - 7200000).toISOString() }),
      metricsHistory: [],
    });

    render(<CDCMetricsDashboard />);

    const uptime = screen.getByTestId('cdc-metric-uptime');
    expect(uptime.textContent).toContain('h');
  });
});

describe('formatUptime', () => {
  it('should format seconds only', () => {
    expect(formatUptime(45)).toBe('45s');
  });

  it('should format minutes and seconds', () => {
    expect(formatUptime(135)).toBe('2m 15s');
  });

  it('should format hours, minutes, and seconds', () => {
    expect(formatUptime(8130)).toBe('2h 15m 30s');
  });

  it('should show 0m when hours present but no minutes', () => {
    expect(formatUptime(3605)).toBe('1h 0m 5s');
  });
});
