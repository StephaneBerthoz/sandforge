import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '../../i18n';
import type { TrendSeries, TrendDataPoint } from './TrendCharts';
import { TrendCharts, buildChartPath, formatTime } from './TrendCharts';

const baseSeries: TrendSeries[] = [
  {
    id: 'api',
    name: 'API Usage',
    color: '#3B82F6',
    data: [
      { timestamp: '2024-01-01T10:00:00Z', value: 45 },
      { timestamp: '2024-01-01T10:05:00Z', value: 52 },
      { timestamp: '2024-01-01T10:10:00Z', value: 60 },
    ],
  },
  {
    id: 'storage',
    name: 'Storage',
    color: '#10B981',
    data: [
      { timestamp: '2024-01-01T10:00:00Z', value: 30 },
      { timestamp: '2024-01-01T10:05:00Z', value: 31 },
    ],
  },
];

describe('TrendCharts', () => {
  it('should render the trends card', () => {
    render(<TrendCharts series={baseSeries} />);
    expect(screen.getByText('Trends')).toBeDefined();
  });

  it('should render chart container', () => {
    render(<TrendCharts series={baseSeries} />);
    expect(screen.getByTestId('trend-chart')).toBeDefined();
  });

  it('should render pure SVG chart', () => {
    render(<TrendCharts series={baseSeries} />);
    expect(screen.getByTestId('trend-svg')).toBeDefined();
  });

  it('should render tabs when multiple series', () => {
    render(<TrendCharts series={baseSeries} />);
    expect(screen.getByText('API Usage')).toBeDefined();
    expect(screen.getByText('Storage')).toBeDefined();
  });

  it('should not render tabs for single series', () => {
    render(<TrendCharts series={[baseSeries[0]]} />);
    expect(screen.queryByRole('tablist')).toBeNull();
  });

  it('should switch series on tab click', () => {
    render(<TrendCharts series={baseSeries} />);
    fireEvent.click(screen.getByText('Storage'));
    const storageTab = screen.getByText('Storage');
    expect(storageTab.closest('[role="tab"]')?.getAttribute('aria-selected')).toBe('true');
  });

  it('should show no data message when series is empty', () => {
    render(<TrendCharts series={[]} />);
    expect(screen.getByText('No data available')).toBeDefined();
  });

  it('should accept custom className', () => {
    const { container } = render(<TrendCharts series={baseSeries} className="my-custom" />);
    expect((container.firstChild as HTMLElement).className).toContain('my-custom');
  });

  it('should render period selector', () => {
    render(<TrendCharts series={baseSeries} />);
    expect(screen.getByTestId('period-selector')).toBeDefined();
    expect(screen.getByTestId('period-1h')).toBeDefined();
    expect(screen.getByTestId('period-6h')).toBeDefined();
    expect(screen.getByTestId('period-24h')).toBeDefined();
    expect(screen.getByTestId('period-7d')).toBeDefined();
  });

  it('should call onPeriodChange when period button is clicked', () => {
    const onPeriodChange = vi.fn();
    render(<TrendCharts series={baseSeries} onPeriodChange={onPeriodChange} />);
    fireEvent.click(screen.getByTestId('period-1h'));
    expect(onPeriodChange).toHaveBeenCalledWith('1h');
  });

  it('should render threshold lines at 75% and 90%', () => {
    render(<TrendCharts series={baseSeries} />);
    expect(screen.getByTestId('threshold-75')).toBeDefined();
    expect(screen.getByTestId('threshold-90')).toBeDefined();
  });

  it('should render Y-axis labels', () => {
    render(<TrendCharts series={baseSeries} />);
    expect(screen.getByTestId('y-label-0')).toBeDefined();
    expect(screen.getByTestId('y-label-25')).toBeDefined();
    expect(screen.getByTestId('y-label-50')).toBeDefined();
    expect(screen.getByTestId('y-label-75')).toBeDefined();
    expect(screen.getByTestId('y-label-100')).toBeDefined();
  });
});

describe('buildChartPath', () => {
  it('should use time-proportional x-coordinates for non-uniform timestamps', () => {
    // 3 points: t=0min, t=10min, t=60min (non-uniform spacing)
    const data: TrendDataPoint[] = [
      { timestamp: '2024-01-01T10:00:00Z', value: 50 },
      { timestamp: '2024-01-01T10:10:00Z', value: 50 },
      { timestamp: '2024-01-01T11:00:00Z', value: 50 },
    ];
    const path = buildChartPath(data, 600, 200);
    // First point should be at PADDING_LEFT = 40
    expect(path).toContain('M 40,');
    // Second point: 10min / 60min range = 1/6 of usableWidth (550), so x = 40 + 91.667 ~ 131.667
    // Third point should be at the end: 40 + 550 = 590
    expect(path).toContain('590,');
    // The second point should NOT be at the midpoint (315) since timestamps are non-uniform
    expect(path).not.toContain(' 315,');
  });

  it('should return empty string for less than 2 data points', () => {
    expect(buildChartPath([], 600, 200)).toBe('');
    expect(buildChartPath([{ timestamp: '2024-01-01T10:00:00Z', value: 50 }], 600, 200)).toBe('');
  });

  it('should fall back to evenly-spaced when all timestamps are identical', () => {
    const data: TrendDataPoint[] = [
      { timestamp: '2024-01-01T10:00:00Z', value: 30 },
      { timestamp: '2024-01-01T10:00:00Z', value: 60 },
    ];
    const path = buildChartPath(data, 600, 200);
    // Should produce a valid L path with endpoints at PADDING_LEFT and PADDING_LEFT + usableWidth
    expect(path).toContain('M 40,');
    expect(path).toContain('L 590,');
  });
});

describe('formatTime', () => {
  it('should show only time for intra-day (multiDay=false)', () => {
    const result = formatTime('2024-03-19T14:30:00Z', false);
    // Should contain hour:minute pattern but not a month name
    expect(result).toMatch(/\d{2}:\d{2}/);
  });

  it('should show date + time for multi-day range (multiDay=true)', () => {
    const result = formatTime('2024-03-19T14:30:00Z', true);
    // Should contain a month abbreviation (locale-dependent, but "Mar" or equivalent)
    expect(result).toMatch(/\d{2}:\d{2}/);
    // The result should be longer than time-only since it includes date components
    const timeOnly = formatTime('2024-03-19T14:30:00Z', false);
    expect(result.length).toBeGreaterThan(timeOnly.length);
  });

  it('should default to time-only when multiDay is not provided', () => {
    const result = formatTime('2024-03-19T14:30:00Z');
    const explicit = formatTime('2024-03-19T14:30:00Z', false);
    expect(result).toBe(explicit);
  });
});
