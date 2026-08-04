import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '../../i18n';
import { useNotificationStore, resetNotificationCounter } from '../../stores/useNotificationStore';
import { LimitExportButton, generateLimitsCsv, generateHistoricalCsv } from './LimitExportButton';
import type { ApiLimit, TrendData } from '@sandforge/shared';

describe('LimitExportButton', () => {
  const mockLimits: ApiLimit[] = [
    { name: 'DailyApiRequests', max: 15000, remaining: 2550, usedPercent: 83 },
    { name: 'DataStorageMB', max: 5120, remaining: 1843, usedPercent: 64 },
  ];

  beforeEach(() => {
    resetNotificationCounter();
    useNotificationStore.setState({ notifications: [] });
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

  it('triggers download and shows notification on click', () => {
    const mockClick = vi.fn();
    const mockCreateObjectURL = vi.fn().mockReturnValue('blob:mock-url');
    const mockRevokeObjectURL = vi.fn();

    // Mock URL API
    globalThis.URL.createObjectURL = mockCreateObjectURL;
    globalThis.URL.revokeObjectURL = mockRevokeObjectURL;

    // Mock createElement to capture the link click
    const origCreateElement = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      const el = origCreateElement(tag);
      if (tag === 'a') {
        el.click = mockClick;
      }
      return el;
    });

    render(<LimitExportButton limits={mockLimits} />);
    fireEvent.click(screen.getByTestId('limit-export-btn'));

    expect(mockCreateObjectURL).toHaveBeenCalledOnce();
    expect(mockClick).toHaveBeenCalledOnce();
    expect(mockRevokeObjectURL).toHaveBeenCalledWith('blob:mock-url');

    const notifications = useNotificationStore.getState().notifications;
    expect(notifications.length).toBe(1);
    expect(notifications[0].level).toBe('success');

    vi.restoreAllMocks();
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

  it('triggers historical download with correct filename pattern when historical mode and trends with timestamps', () => {
    const mockClick = vi.fn();
    const mockCreateObjectURL = vi.fn().mockReturnValue('blob:mock-url');
    const mockRevokeObjectURL = vi.fn();

    globalThis.URL.createObjectURL = mockCreateObjectURL;
    globalThis.URL.revokeObjectURL = mockRevokeObjectURL;

    const origCreateElement = document.createElement.bind(document);
    let capturedDownload = '';
    vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      const el = origCreateElement(tag);
      if (tag === 'a') {
        el.click = mockClick;
        const originalDescriptor = Object.getOwnPropertyDescriptor(
          HTMLAnchorElement.prototype,
          'download',
        );
        Object.defineProperty(el, 'download', {
          set(val: string) {
            capturedDownload = val;
            if (originalDescriptor?.set) originalDescriptor.set.call(el, val);
          },
          get() {
            return capturedDownload;
          },
        });
      }
      return el;
    });

    const trendsWithTimestamps: Record<string, TrendData> = {
      DailyApiRequests: {
        limitName: 'DailyApiRequests',
        direction: 'up',
        changePercent: 5,
        sparklineData: [50, 60, 70],
        timestamps: ['2026-03-20T10:00:00Z', '2026-03-20T10:15:00Z', '2026-03-20T10:30:00Z'],
      },
    };

    render(<LimitExportButton limits={mockLimits} trends={trendsWithTimestamps} />);

    // Switch to historical mode
    const select = screen.getByTestId('export-mode-select');
    fireEvent.change(select, { target: { value: 'historical' } });

    // Click export
    fireEvent.click(screen.getByTestId('limit-export-btn'));

    expect(mockClick).toHaveBeenCalledOnce();
    expect(capturedDownload).toMatch(/^sandforge-limits-history-\d{4}-\d{2}-\d{2}\.csv$/);

    vi.restoreAllMocks();
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
