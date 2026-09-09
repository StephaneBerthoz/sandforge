import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '../../i18n';
import { useNotificationStore, resetNotificationCounter } from '../../stores/useNotificationStore';
import { LimitExportButton, generateLimitsCsv, generateHistoricalCsv } from './LimitExportButton';
import type { ApiLimit, TrendData } from '@sandforge/shared';

const mockPostMessage = vi.fn();
vi.mock('../../hooks/useVSCodeApi', () => ({
  useVSCodeApi: () => ({
    postMessage: mockPostMessage,
    getState: () => undefined,
    setState: () => undefined,
  }),
}));

/** The inner messages the webview sent, unwrapped from their envelope. */
function postedMessages(): Array<{ type: string; payload: unknown }> {
  return mockPostMessage.mock.calls.map((c) => {
    const env = c[0] as { payload?: { type: string; payload: unknown } };
    return env.payload ?? (c[0] as { type: string; payload: unknown });
  });
}

describe('LimitExportButton', () => {
  const mockLimits: ApiLimit[] = [
    { name: 'DailyApiRequests', max: 15000, remaining: 2550, usedPercent: 83 },
    { name: 'DataStorageMB', max: 5120, remaining: 1843, usedPercent: 64 },
  ];

  beforeEach(() => {
    resetNotificationCounter();
    useNotificationStore.setState({ notifications: [] });
    // Without this every assertion on what was sent also sees the previous
    // test's message.
    mockPostMessage.mockClear();
  });

  it('renders the export button', () => {
    render(<LimitExportButton limits={mockLimits} />);
    expect(screen.getByTestId('limit-export-btn')).toBeDefined();
    expect(screen.getByText('Export CSV')).toBeDefined();
  });

  it('is disabled when limits are empty', () => {
    render(<LimitExportButton limits={[]} />);
    const btn = screen.getByTestId('limit-export-btn');
    expect(btn.hasAttribute('disabled')).toBe(true);
  });

  it('asks the host to save the export, with the right name and contents', () => {
    // This test used to spy on createObjectURL / <a>.click / revokeObjectURL and
    // assert a success toast — it documented the defect rather than the
    // behaviour. A webview is sandboxed without `allow-downloads`, so that
    // click often wrote nothing while the toast claimed otherwise. Only the
    // host can save, so what matters is that it is asked, and asked correctly.
    render(<LimitExportButton limits={mockLimits} />);
    fireEvent.click(screen.getByTestId('limit-export-btn'));

    const sent = postedMessages().filter((m) => m.type === 'file:save');
    expect(sent).toHaveLength(1);
    const payload = sent[0].payload as { suggestedName: string; content: string };
    expect(payload.suggestedName).toMatch(/^sandforge-limits-\d{4}-\d{2}-\d{2}\.csv$/);
    expect(payload.content).toContain('DailyApiRequests');

    // And nothing is announced until the host answers.
    expect(useNotificationStore.getState().notifications).toHaveLength(0);
  });

  it('renders the export mode selector', () => {
    render(<LimitExportButton limits={mockLimits} />);
    const select = screen.getByTestId('export-mode-select');
    expect(select).toBeDefined();
    expect(select.getAttribute('aria-label')).toBe('Export mode');
  });

  it('renders the export group container', () => {
    render(<LimitExportButton limits={mockLimits} />);
    expect(screen.getByTestId('export-group')).toBeDefined();
  });

  it('shows Export History button text when historical mode is selected', () => {
    render(<LimitExportButton limits={mockLimits} />);
    const select = screen.getByTestId('export-mode-select');
    fireEvent.change(select, { target: { value: 'historical' } });
    expect(screen.getByText('Export History')).toBeDefined();
  });

  it('names the historical export differently from the current one', () => {
    const trends: Record<string, TrendData> = {
      DailyApiRequests: {
        limitName: 'DailyApiRequests',
        direction: 'up',
        changePercent: 4,
        sparklineData: [40, 42],
        timestamps: ['2026-09-01T00:00:00.000Z', '2026-09-02T00:00:00.000Z'],
      },
    };
    render(<LimitExportButton limits={mockLimits} trends={trends} />);
    fireEvent.change(screen.getByTestId('export-mode-select'), {
      target: { value: 'historical' },
    });
    fireEvent.click(screen.getByTestId('limit-export-btn'));

    const sent = postedMessages().filter((m) => m.type === 'file:save');
    expect(sent).toHaveLength(1);
    expect((sent[0].payload as { suggestedName: string }).suggestedName).toMatch(
      /^sandforge-limits-history-\d{4}-\d{2}-\d{2}\.csv$/,
    );
  });

  it('shows warning notification when historical export has no data rows', () => {
    render(<LimitExportButton limits={mockLimits} trends={{}} />);

    // Switch to historical mode
    const select = screen.getByTestId('export-mode-select');
    fireEvent.change(select, { target: { value: 'historical' } });

    // Click export
    fireEvent.click(screen.getByTestId('limit-export-btn'));

    const notifications = useNotificationStore.getState().notifications;
    expect(notifications.length).toBe(1);
    expect(notifications[0].level).toBe('warning');
  });
});

describe('generateLimitsCsv', () => {
  it('generates CSV with correct headers and rows', () => {
    const limits: ApiLimit[] = [
      { name: 'DailyApiRequests', max: 15000, remaining: 2550, usedPercent: 83 },
      { name: 'DataStorageMB', max: 5120, remaining: 1843, usedPercent: 64 },
    ];

    const csv = generateLimitsCsv(limits);
    const lines = csv.split('\n');

    expect(lines[0]).toBe('Limit Name,Max,Remaining,Used %,Trend Direction');
    expect(lines[1]).toBe('"DailyApiRequests",15000,2550,83,N/A');
    expect(lines[2]).toBe('"DataStorageMB",5120,1843,64,N/A');
  });

  it('includes trend direction when trends provided', () => {
    const limits: ApiLimit[] = [
      { name: 'DailyApiRequests', max: 15000, remaining: 2550, usedPercent: 83 },
    ];
    const trends = {
      DailyApiRequests: {
        limitName: 'DailyApiRequests',
        direction: 'up' as const,
        changePercent: 5,
        sparklineData: [50, 60, 70, 80, 90],
        predictedTimeToLimit: 5,
      },
    };

    const csv = generateLimitsCsv(limits, trends);
    expect(csv).toContain('up');
  });
});

describe('generateHistoricalCsv', () => {
  it('produces correct CSV header and rows with real timestamps', () => {
    const trends: Record<string, TrendData> = {
      DailyApiRequests: {
        limitName: 'DailyApiRequests',
        direction: 'up',
        changePercent: 5,
        sparklineData: [50, 60],
        timestamps: ['2026-03-20T10:00:00Z', '2026-03-20T10:15:00Z'],
      },
    };

    const csv = generateHistoricalCsv(trends);
    const lines = csv.split('\n');

    expect(lines[0]).toBe('Timestamp,Limit Name,Used %');
    expect(lines[1]).toBe('"2026-03-20T10:00:00Z","DailyApiRequests",50');
    expect(lines[2]).toBe('"2026-03-20T10:15:00Z","DailyApiRequests",60');
    expect(lines).toHaveLength(3);
  });

  it('produces only the header line when trends is empty', () => {
    const csv = generateHistoricalCsv({});
    const lines = csv.split('\n');

    expect(lines[0]).toBe('Timestamp,Limit Name,Used %');
    expect(lines).toHaveLength(1);
  });

  it('skips entries with no timestamps field', () => {
    const trends: Record<string, TrendData> = {
      DailyApiRequests: {
        limitName: 'DailyApiRequests',
        direction: 'stable',
        changePercent: 0,
        sparklineData: [50, 60],
        // No timestamps field
      },
    };

    const csv = generateHistoricalCsv(trends);
    const lines = csv.split('\n');

    expect(lines[0]).toBe('Timestamp,Limit Name,Used %');
    expect(lines).toHaveLength(1);
  });

  it('handles multiple limits with timestamps', () => {
    const trends: Record<string, TrendData> = {
      DailyApiRequests: {
        limitName: 'DailyApiRequests',
        direction: 'up',
        changePercent: 5,
        sparklineData: [50, 60],
        timestamps: ['2026-03-20T10:00:00Z', '2026-03-20T10:15:00Z'],
      },
      DataStorageMB: {
        limitName: 'DataStorageMB',
        direction: 'stable',
        changePercent: 0,
        sparklineData: [30, 31],
        timestamps: ['2026-03-20T10:00:00Z', '2026-03-20T10:15:00Z'],
      },
    };

    const csv = generateHistoricalCsv(trends);
    const lines = csv.split('\n');

    expect(lines[0]).toBe('Timestamp,Limit Name,Used %');
    // 2 limits x 2 timestamps = 4 data rows + 1 header = 5 lines
    expect(lines).toHaveLength(5);
    expect(csv).toContain('"DailyApiRequests"');
    expect(csv).toContain('"DataStorageMB"');
  });
});
