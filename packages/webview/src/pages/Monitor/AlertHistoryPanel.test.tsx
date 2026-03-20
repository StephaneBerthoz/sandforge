import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { AlertInstance } from '@sandforge/shared';
import { AlertHistoryPanel } from './AlertHistoryPanel';

/* ------------------------------------------------------------------ */
/* Mock i18n                                                           */
/* ------------------------------------------------------------------ */
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, valOrDefault?: string | Record<string, unknown>) => {
      if (typeof valOrDefault === 'string') return valOrDefault;
      if (valOrDefault && typeof valOrDefault === 'object' && 'defaultValue' in valOrDefault) {
        return String(valOrDefault.defaultValue).replace('{{count}}', String(valOrDefault.count ?? ''));
      }
      return key;
    },
  }),
}));

/* ------------------------------------------------------------------ */
/* Mock bridge hooks                                                   */
/* ------------------------------------------------------------------ */
const mockRefetch = vi.fn();
let mockData: { alerts: AlertInstance[]; history: AlertInstance[] } | null = null;

vi.mock('../../hooks/useBridgeQuery', () => ({
  useBridgeQuery: () => ({
    data: mockData,
    loading: false,
    error: null,
    refetch: mockRefetch,
  }),
}));

/* ------------------------------------------------------------------ */
/* Test data                                                           */
/* ------------------------------------------------------------------ */
function makeAlert(overrides: Partial<AlertInstance> = {}): AlertInstance {
  return {
    id: 'alert-1',
    definitionId: 'def-1',
    severity: 'critical',
    status: 'active',
    message: 'API usage above 90%',
    currentValue: 92,
    threshold: 90,
    orgId: 'org-1',
    triggeredAt: '2026-03-20T14:30:00.000Z',
    ...overrides,
  };
}

const today = '2026-03-20';
const yesterday = '2026-03-19';

const historyAlerts: AlertInstance[] = [
  makeAlert({
    id: 'h1',
    status: 'active',
    triggeredAt: `${today}T14:30:00.000Z`,
    severity: 'critical',
    message: 'API above 90%',
  }),
  makeAlert({
    id: 'h2',
    status: 'acknowledged',
    triggeredAt: `${today}T10:00:00.000Z`,
    severity: 'warning',
    message: 'Storage above 75%',
    acknowledgedAt: `${today}T10:05:00.000Z`,
  }),
  makeAlert({
    id: 'h3',
    status: 'resolved',
    triggeredAt: `${yesterday}T08:00:00.000Z`,
    severity: 'info',
    message: 'SOQL resolved',
    resolvedAt: `${yesterday}T09:00:00.000Z`,
  }),
  makeAlert({
    id: 'h4',
    status: 'dismissed',
    triggeredAt: `${yesterday}T06:00:00.000Z`,
    severity: 'warning',
    message: 'Dismissed alert',
  }),
];

describe('AlertHistoryPanel', () => {
  beforeEach(() => {
    mockData = null;
    mockRefetch.mockReset();
  });

  it('renders empty state when no history', () => {
    mockData = { alerts: [], history: [] };
    render(<AlertHistoryPanel />);
    expect(screen.getByTestId('alert-history-panel')).toBeDefined();
    expect(screen.getByTestId('alert-history-empty')).toBeDefined();
    expect(screen.getByText('No alert history yet')).toBeDefined();
  });

  it('renders empty state when data is null', () => {
    mockData = null;
    render(<AlertHistoryPanel />);
    expect(screen.getByTestId('alert-history-empty')).toBeDefined();
  });

  it('renders alert entries with correct status badges', () => {
    mockData = { alerts: [], history: historyAlerts };
    render(<AlertHistoryPanel />);

    expect(screen.getByTestId('history-entry-h1')).toBeDefined();
    expect(screen.getByTestId('history-entry-h2')).toBeDefined();
    expect(screen.getByTestId('history-entry-h3')).toBeDefined();
    expect(screen.getByTestId('history-entry-h4')).toBeDefined();

    // Status badges
    expect(screen.getByTestId('status-badge-h1')).toBeDefined();
    expect(screen.getByTestId('status-badge-h1').textContent).toBe('active');
    expect(screen.getByTestId('status-badge-h2').textContent).toBe('acknowledged');
    expect(screen.getByTestId('status-badge-h3').textContent).toBe('resolved');
    expect(screen.getByTestId('status-badge-h4').textContent).toBe('dismissed');

    // Severity badges
    expect(screen.getByTestId('severity-badge-h1').textContent).toBe('critical');
    expect(screen.getByTestId('severity-badge-h2').textContent).toBe('warning');
  });

  it('sorts entries by triggeredAt descending (newest first)', () => {
    mockData = { alerts: [], history: historyAlerts };
    render(<AlertHistoryPanel />);

    const entries = screen.getAllByTestId(/^history-entry-/);
    // h1 (today 14:30) first, h2 (today 10:00), h3 (yesterday 08:00), h4 (yesterday 06:00)
    expect(entries[0].getAttribute('data-testid')).toBe('history-entry-h1');
    expect(entries[1].getAttribute('data-testid')).toBe('history-entry-h2');
    expect(entries[2].getAttribute('data-testid')).toBe('history-entry-h3');
    expect(entries[3].getAttribute('data-testid')).toBe('history-entry-h4');
  });

  it('shows date group headers', () => {
    mockData = { alerts: [], history: historyAlerts };
    render(<AlertHistoryPanel />);

    // Should have two date groups (today and yesterday)
    const dateGroups = screen.getAllByTestId(/^date-group-/);
    expect(dateGroups.length).toBe(2);
  });

  it('shows acknowledged timestamp when present', () => {
    mockData = { alerts: [], history: [historyAlerts[1]] };
    render(<AlertHistoryPanel />);
    expect(screen.getByTestId('acknowledged-time-h2')).toBeDefined();
  });

  it('shows resolved timestamp when present', () => {
    mockData = { alerts: [], history: [historyAlerts[2]] };
    render(<AlertHistoryPanel />);
    expect(screen.getByTestId('resolved-time-h3')).toBeDefined();
  });

  it('does not show acknowledged/resolved timestamps when absent', () => {
    mockData = { alerts: [], history: [historyAlerts[0]] };
    render(<AlertHistoryPanel />);
    expect(screen.queryByTestId('acknowledged-time-h1')).toBeNull();
    expect(screen.queryByTestId('resolved-time-h1')).toBeNull();
  });

  it('shows alert message and metric values', () => {
    mockData = { alerts: [], history: [historyAlerts[0]] };
    render(<AlertHistoryPanel />);
    expect(screen.getByText('API above 90%')).toBeDefined();
    // Metric line shows "Value: 92 (threshold: 90)"
    expect(screen.getByText(/Value.*92.*threshold.*90/)).toBeDefined();
  });

  it('shows show-more button when entries exceed limit', () => {
    const manyAlerts: AlertInstance[] = Array.from({ length: 110 }, (_, i) =>
      makeAlert({
        id: `bulk-${i}`,
        triggeredAt: new Date(Date.now() - i * 60_000).toISOString(),
      }),
    );
    mockData = { alerts: [], history: manyAlerts };
    render(<AlertHistoryPanel />);

    // 100 shown, 10 remaining
    expect(screen.getByTestId('show-more-btn')).toBeDefined();
    fireEvent.click(screen.getByTestId('show-more-btn'));

    // After clicking, all 110 should be shown
    expect(screen.queryByTestId('show-more-btn')).toBeNull();
  });

  it('displays history count in subtitle', () => {
    mockData = { alerts: [], history: historyAlerts };
    render(<AlertHistoryPanel />);
    expect(screen.getByText('4 events')).toBeDefined();
  });
});
