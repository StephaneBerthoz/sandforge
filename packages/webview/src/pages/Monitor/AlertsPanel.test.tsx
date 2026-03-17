import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '../../i18n';
import type { AlertInstance } from '@sandforge/shared';
import { AlertsPanel } from './AlertsPanel';

/* ------------------------------------------------------------------ */
/* Mock bridge hooks                                                   */
/* ------------------------------------------------------------------ */
const mockAlertsRefetch = vi.fn();
const mockAcknowledgeMutate = vi.fn();
const mockAcknowledgeReset = vi.fn();
const mockDismissMutate = vi.fn();
const mockDismissReset = vi.fn();

vi.mock('../../hooks/useBridgeQuery', () => ({
  useBridgeQuery: () => ({
    data: null,
    loading: false,
    error: null,
    refetch: mockAlertsRefetch,
  }),
}));

vi.mock('../../hooks/useBridgeMutation', () => ({
  useBridgeMutation: (type: string) => {
    if (type === 'monitor:alert:acknowledge') {
      return { mutate: mockAcknowledgeMutate, data: null, loading: false, error: null, reset: mockAcknowledgeReset };
    }
    if (type === 'monitor:alert:dismiss') {
      return { mutate: mockDismissMutate, data: null, loading: false, error: null, reset: mockDismissReset };
    }
    return { mutate: vi.fn(), data: null, loading: false, error: null, reset: vi.fn() };
  },
}));

const mockAlerts: AlertInstance[] = [
  {
    id: 'a1',
    definitionId: 'd1',
    severity: 'critical',
    status: 'active',
    message: 'API usage above 90%',
    currentValue: 92,
    threshold: 90,
    orgId: 'org-1',
    triggeredAt: '2024-01-01T12:00:00Z',
  },
  {
    id: 'a2',
    definitionId: 'd2',
    severity: 'warning',
    status: 'acknowledged',
    message: 'Storage usage above 70%',
    currentValue: 75,
    threshold: 70,
    orgId: 'org-1',
    triggeredAt: '2024-01-01T11:00:00Z',
    acknowledgedAt: '2024-01-01T11:05:00Z',
  },
  {
    id: 'a3',
    definitionId: 'd3',
    severity: 'info',
    status: 'resolved',
    message: 'Resolved alert',
    currentValue: 10,
    threshold: 50,
    orgId: 'org-1',
    triggeredAt: '2024-01-01T10:00:00Z',
    resolvedAt: '2024-01-01T10:30:00Z',
  },
];

describe('AlertsPanel', () => {
  it('should render the alerts title', () => {
    render(<AlertsPanel alerts={mockAlerts} />);
    expect(screen.getByText('monitor.alerts')).toBeDefined();
  });

  it('should show active alert count (active + acknowledged)', () => {
    render(<AlertsPanel alerts={mockAlerts} />);
    expect(screen.getByText('2 active')).toBeDefined();
  });

  it('should render active and acknowledged alerts', () => {
    render(<AlertsPanel alerts={mockAlerts} />);
    expect(screen.getByTestId('alert-a1')).toBeDefined();
    expect(screen.getByTestId('alert-a2')).toBeDefined();
  });

  it('should not render resolved alerts', () => {
    render(<AlertsPanel alerts={mockAlerts} />);
    expect(screen.queryByTestId('alert-a3')).toBeNull();
  });

  it('should display alert message', () => {
    render(<AlertsPanel alerts={mockAlerts} />);
    expect(screen.getByText('API usage above 90%')).toBeDefined();
  });

  it('should display current value and threshold', () => {
    render(<AlertsPanel alerts={mockAlerts} />);
    expect(screen.getByText(/Value: 92.*threshold: 90/)).toBeDefined();
  });

  it('should show severity badges', () => {
    render(<AlertsPanel alerts={mockAlerts} />);
    expect(screen.getByText('critical')).toBeDefined();
    expect(screen.getByText('warning')).toBeDefined();
  });

  it('should call onAcknowledge prop for active alerts when provided', () => {
    const handler = vi.fn();
    render(<AlertsPanel alerts={mockAlerts} onAcknowledge={handler} />);
    fireEvent.click(screen.getByText('monitor.acknowledge'));
    expect(handler).toHaveBeenCalledWith('a1');
  });

  it('should call bridge mutation for acknowledge when no prop provided', () => {
    render(<AlertsPanel alerts={mockAlerts} />);
    fireEvent.click(screen.getByText('monitor.acknowledge'));
    expect(mockAcknowledgeMutate).toHaveBeenCalledWith({ alertId: 'a1' });
  });

  it('should call onDismiss prop when dismiss is clicked and prop provided', () => {
    const handler = vi.fn();
    render(<AlertsPanel alerts={mockAlerts} onDismiss={handler} />);
    const dismissBtns = screen.getAllByText('monitor.dismiss');
    fireEvent.click(dismissBtns[0]);
    expect(handler).toHaveBeenCalledWith('a1');
  });

  it('should call bridge mutation for dismiss when no prop provided', () => {
    render(<AlertsPanel alerts={mockAlerts} />);
    const dismissBtns = screen.getAllByText('monitor.dismiss');
    fireEvent.click(dismissBtns[0]);
    expect(mockDismissMutate).toHaveBeenCalledWith({ alertId: 'a1' });
  });

  it('should show no alerts message when empty', () => {
    render(<AlertsPanel alerts={[]} />);
    expect(screen.getByText('monitor.noAlerts')).toBeDefined();
  });
});
