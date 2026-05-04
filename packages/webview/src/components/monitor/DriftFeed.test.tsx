import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { DriftFeed } from './DriftFeed';

/**
 * Plan 03-04 — DriftFeed.tsx component tests.
 *
 * Verifies:
 *   - Empty state when no events.
 *   - Renders 3 events when bridge dispatches 3 envelopes.
 *   - Permission filter chip narrows the visible events.
 *   - Click on an event row toggles the expanded delta block.
 *   - Unsubscribe is called on unmount (P-03.7 H7).
 */

/** Helper: dispatch a `monitor:drift:detected` MessageEvent on the window. */
function dispatchDrift(payload: {
  orgId: string;
  snapshotPairId: string;
  summary: string;
  deltaCount: number;
  severity: 'info' | 'breaking' | 'permission';
}): void {
  act(() => {
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { type: 'monitor:drift:detected', payload },
        origin: '',
      }),
    );
  });
}

describe('DriftFeed (Plan 03-04)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: new Date('2026-05-02T10:00:00Z') });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders the empty state when no events have been received', () => {
    render(<DriftFeed orgId="org-1" />);
    expect(screen.getByTestId('monitor-drift-feed')).toBeTruthy();
    expect(screen.getByTestId('monitor-drift-feed-empty')).toBeTruthy();
  });

  it('renders 3 event rows when the bridge dispatches 3 envelopes', () => {
    render(<DriftFeed orgId="org-1" />);
    dispatchDrift({
      orgId: 'org-1',
      snapshotPairId: 'pair-1',
      summary: 'Field added',
      deltaCount: 1,
      severity: 'info',
    });
    dispatchDrift({
      orgId: 'org-1',
      snapshotPairId: 'pair-2',
      summary: 'Field type changed',
      deltaCount: 2,
      severity: 'breaking',
    });
    dispatchDrift({
      orgId: 'org-1',
      snapshotPairId: 'pair-3',
      summary: 'Permission revoked',
      deltaCount: 3,
      severity: 'permission',
    });

    const rows = screen.getAllByTestId('monitor-drift-event-row');
    expect(rows).toHaveLength(3);
  });

  it('ignores envelopes for a different org', () => {
    render(<DriftFeed orgId="org-1" />);
    dispatchDrift({
      orgId: 'org-other',
      snapshotPairId: 'pair-x',
      summary: 'Other org event',
      deltaCount: 1,
      severity: 'info',
    });
    expect(screen.queryAllByTestId('monitor-drift-event-row')).toHaveLength(0);
  });

  it('hides non-permission events when the Permission chip is active', () => {
    render(<DriftFeed orgId="org-1" />);
    dispatchDrift({
      orgId: 'org-1',
      snapshotPairId: 'pair-info',
      summary: 'Info event',
      deltaCount: 1,
      severity: 'info',
    });
    dispatchDrift({
      orgId: 'org-1',
      snapshotPairId: 'pair-perm',
      summary: 'Permission event',
      deltaCount: 1,
      severity: 'permission',
    });

    expect(screen.getAllByTestId('monitor-drift-event-row')).toHaveLength(2);

    fireEvent.click(screen.getByTestId('monitor-drift-filter-permission'));

    const filtered = screen.getAllByTestId('monitor-drift-event-row');
    expect(filtered).toHaveLength(1);
    expect(filtered[0].textContent ?? '').toContain('Permission event');
  });

  it('toggles an expanded delta panel on row click', () => {
    render(<DriftFeed orgId="org-1" />);
    dispatchDrift({
      orgId: 'org-1',
      snapshotPairId: 'pair-1',
      summary: 'A breaking change',
      deltaCount: 4,
      severity: 'breaking',
    });

    const row = screen.getByTestId('monitor-drift-event-row');
    expect(screen.queryByTestId('monitor-drift-event-row-expanded')).toBeNull();

    fireEvent.click(row);
    expect(screen.getByTestId('monitor-drift-event-row-expanded')).toBeTruthy();

    fireEvent.click(row);
    expect(screen.queryByTestId('monitor-drift-event-row-expanded')).toBeNull();
  });

  it('removes the message listener on unmount (P-03.7 H7)', () => {
    const removeSpy = vi.spyOn(window, 'removeEventListener');
    const { unmount } = render(<DriftFeed orgId="org-1" />);
    unmount();
    const calls = removeSpy.mock.calls.filter(([type]) => type === 'message');
    expect(calls.length).toBeGreaterThanOrEqual(1);
    removeSpy.mockRestore();
  });

  it('disables the Setup chip (Setup Audit Trail deferred)', () => {
    render(<DriftFeed orgId="org-1" />);
    const setup = screen.getByTestId('monitor-drift-filter-setup') as HTMLButtonElement;
    expect(setup.disabled).toBe(true);
  });
});
