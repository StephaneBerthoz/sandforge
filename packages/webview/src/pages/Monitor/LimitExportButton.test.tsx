import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '../../i18n';
import { useNotificationStore, resetNotificationCounter } from '../../stores/useNotificationStore';
import { LimitExportButton, generateLimitsCsv } from './LimitExportButton';
import type { ApiLimit } from '@sandforge/shared';

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
        sparklineData: [50, 60, 70, 80, 90],
        predictedTimeToLimit: 5,
      },
    };

    const csv = generateLimitsCsv(limits, trends);
    expect(csv).toContain('up');
  });
});
