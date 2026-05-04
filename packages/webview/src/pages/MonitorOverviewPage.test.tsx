import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import type { OrgFleetSummary } from '@sandforge/shared';
import { useFleetStore } from '../store/useFleetStore';
import { MonitorOverviewPage } from './MonitorOverviewPage';

const sendSpy = vi.fn();
vi.mock('../hooks/useMessageBus', () => ({
  useSendMessage: () => sendSpy,
}));
vi.mock('../hooks/useVisibilityGate', () => ({
  useVisibilityGate: () => undefined,
}));

function summary(overrides: Partial<OrgFleetSummary> = {}): OrgFleetSummary {
  return {
    orgId: 'o1',
    alias: 'Org One',
    healthScore: 85,
    apiUsedPercent: 12,
    activeAlerts: 0,
    lastUpdatedMs: Date.now(),
    ...overrides,
  };
}

describe('MonitorOverviewPage', () => {
  beforeEach(() => {
    sendSpy.mockReset();
    useFleetStore.getState().clear();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    cleanup();
  });

  it('renders empty state when 0 orgs', () => {
    render(<MonitorOverviewPage />);
    expect(screen.getByTestId('monitor-overview-page')).toBeDefined();
    expect(screen.getByTestId('monitor-overview-empty')).toBeDefined();
  });

  it('renders 3 org cards when fleet store has 3 orgs', () => {
    useFleetStore
      .getState()
      .setSummaries([summary({ orgId: 'o1' }), summary({ orgId: 'o2' }), summary({ orgId: 'o3' })]);
    render(<MonitorOverviewPage />);
    const cards = screen.getAllByTestId('monitor-overview-org-card');
    expect(cards).toHaveLength(3);
  });

  it('shows stale pill when summary.stale is true', () => {
    useFleetStore.getState().setSummaries([summary({ orgId: 'o1', stale: true })]);
    render(<MonitorOverviewPage />);
    expect(screen.getByTestId('monitor-overview-org-stale')).toBeDefined();
  });

  it('clicking drilldown btn calls onDrilldown with orgId', () => {
    useFleetStore.getState().setSummaries([summary({ orgId: 'org-42' })]);
    const onDrilldown = vi.fn();
    render(<MonitorOverviewPage onDrilldown={onDrilldown} />);
    fireEvent.click(screen.getByTestId('monitor-overview-org-drilldown-btn'));
    expect(onDrilldown).toHaveBeenCalledWith('org-42');
  });

  it('dispatches monitor:fleet:summary:request on mount + every 60s', () => {
    render(<MonitorOverviewPage />);
    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(sendSpy.mock.calls[0][0]).toMatchObject({ type: 'monitor:fleet:summary:request' });
    vi.advanceTimersByTime(60_000);
    expect(sendSpy).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(60_000);
    expect(sendSpy).toHaveBeenCalledTimes(3);
  });

  it('unmount clears the polling interval', () => {
    const { unmount } = render(<MonitorOverviewPage />);
    sendSpy.mockClear();
    unmount();
    vi.advanceTimersByTime(60_000 * 5);
    expect(sendSpy).not.toHaveBeenCalled();
  });
});
