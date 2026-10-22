import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '../../i18n';
import { ChartTooltip, TrendChart, formatXAxis } from './TrendChart';
import type { TrendDataPoint } from './TrendChart';

describe('a point whose time is not a date', () => {
  // Formatting it threw "Invalid time value", and the chart was left blank.
  it('gets no axis time of its own, for the chart to write as unknown', () => {
    expect(formatXAxis(Number.NaN, '24h')).toBeNull();
    expect(formatXAxis(Number.NaN, '7d')).toBeNull();
    expect(formatXAxis(Date.UTC(2026, 0, 1, 10), '7d')).toMatch(/\d{2}.\d{2}/);
  });

  it('shows its value in the tooltip, and its time as unknown', () => {
    render(<ChartTooltip active payload={[{ value: 42 }]} label={Number.NaN} />);

    const tooltip = screen.getByTestId('trend-tooltip');
    expect(tooltip.textContent).toContain('unknown');
    expect(tooltip.textContent).toContain('42');
  });
});

/* Mock recharts ResponsiveContainer to avoid layout issues in jsdom. */
vi.mock('recharts', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('recharts');
  return {
    ...actual,
    ResponsiveContainer: ({ children }: { children: React.ReactNode }) => (
      <div data-testid="responsive-container" style={{ width: 400, height: 200 }}>
        {children}
      </div>
    ),
  };
});

const sampleData: TrendDataPoint[] = [
  { timestamp: Date.now() - 3_600_000, value: 100 },
  { timestamp: Date.now() - 1_800_000, value: 200 },
  { timestamp: Date.now(), value: 150 },
];

/** The area chart's chunk could not be fetched, as on a remote window that dropped. */
const areaUnreadable = vi.hoisted(() => ({ value: false }));
vi.mock('./TrendArea', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./TrendArea')>();
  return {
    ...actual,
    TrendArea: (props: React.ComponentProps<typeof actual.TrendArea>) => {
      if (areaUnreadable.value) {
        throw new TypeError(
          'Failed to fetch dynamically imported module: https://file+.vscode-resource.vscode-cdn.net/x/assets/chunks/TrendArea-a1.js',
        );
      }
      return <actual.TrendArea {...props} />;
    },
  };
});

describe('TrendChart', () => {
  it('keeps a chart whose chunk could not be fetched to its box, the period buttons up', async () => {
    // The page's boundary caught it: the whole Monitor page, its Stop
    // buttons with it, went with a chart.
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    areaUnreadable.value = true;
    try {
      render(<TrendChart data={sampleData} />);

      const failed = await screen.findByTestId('trend-chart-failed');
      expect(failed.textContent).toContain('This part did not load');
      expect(screen.getByTestId('trend-chart-container').contains(failed)).toBe(true);
      expect(screen.getByTestId('trend-period-7d')).toBeDefined();
    } finally {
      areaUnreadable.value = false;
    }
  });

  it('should render the chart container', () => {
    render(<TrendChart data={sampleData} />);
    expect(screen.getByTestId('trend-chart')).toBeDefined();
  });

  it('should render the chart area container', () => {
    render(<TrendChart data={sampleData} />);
    expect(screen.getByTestId('trend-chart-container')).toBeDefined();
  });

  it('should render period selector buttons', () => {
    render(<TrendChart data={sampleData} />);
    expect(screen.getByTestId('trend-period-selector')).toBeDefined();
    expect(screen.getByTestId('trend-period-24h')).toBeDefined();
    expect(screen.getByTestId('trend-period-7d')).toBeDefined();
    // History is kept for seven days: a 30-day view would show that same week.
    expect(screen.queryByTestId('trend-period-30d')).toBeNull();
  });

  it('should default to 24h period', () => {
    render(<TrendChart data={sampleData} />);
    const btn24h = screen.getByTestId('trend-period-24h');
    expect(btn24h.className).toContain('bg-(--sf-button-bg)');
  });

  it('should switch period on button click', () => {
    render(<TrendChart data={sampleData} />);
    const btn7d = screen.getByTestId('trend-period-7d');
    fireEvent.click(btn7d);
    expect(btn7d.className).toContain('bg-(--sf-button-bg)');
    const btn24h = screen.getByTestId('trend-period-24h');
    expect(btn24h.className).not.toContain('bg-(--sf-button-bg)');
  });

  it('should render with empty data without crashing', () => {
    render(<TrendChart data={[]} />);
    expect(screen.getByTestId('trend-chart')).toBeDefined();
  });

  it('should accept a custom className', () => {
    render(<TrendChart data={sampleData} className="custom-class" />);
    const container = screen.getByTestId('trend-chart');
    expect(container.className).toContain('custom-class');
  });
});
