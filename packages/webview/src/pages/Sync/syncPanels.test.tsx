import { Suspense } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

/**
 * When the Sync page loads its tabs past Sync. The stand-ins note when their
 * module is evaluated: the page imported them up front, so every panel showing
 * Sync parsed the cron builder, the History, Conflicts and Real-Time tables and
 * the virtual list under them before its Sync tab.
 */
const evaluated = vi.hoisted(() => new Set<string>());

vi.mock('./SyncSchedulePanel', () => {
  evaluated.add('SyncSchedulePanel');
  return { SyncSchedulePanel: () => <div data-testid="schedules">schedules</div> };
});
vi.mock('./SyncHistoryPanel', () => {
  evaluated.add('SyncHistoryPanel');
  return { SyncHistoryPanel: () => <div data-testid="history">history</div> };
});
vi.mock('./RealTimeSyncPanel', () => {
  evaluated.add('RealTimeSyncPanel');
  return { RealTimeSyncPanel: () => <div data-testid="realtime">realtime</div> };
});
vi.mock('./ConflictListPanel', () => {
  evaluated.add('ConflictListPanel');
  return { ConflictListPanel: () => <div data-testid="conflicts">conflicts</div> };
});
vi.mock('./ConflictResolutionPanel', () => {
  evaluated.add('ConflictResolutionPanel');
  return { ConflictResolutionPanel: () => <div data-testid="conflict">conflict</div> };
});

import {
  ConflictListPanel,
  ConflictResolutionPanel,
  RealTimeSyncPanel,
  SyncHistoryPanel,
  SyncSchedulePanel,
} from './syncPanels';

describe('syncPanels', () => {
  it('loads the Schedules tab only once it is drawn', async () => {
    expect([...evaluated]).toEqual([]);

    render(
      <Suspense fallback={<div data-testid="loading" />}>
        <SyncSchedulePanel onRunConfig={() => undefined} runDisabled={false} />
      </Suspense>,
    );

    expect(screen.getByTestId('loading')).toBeDefined();
    expect(await screen.findByTestId('schedules')).toBeDefined();
    expect([...evaluated]).toEqual(['SyncSchedulePanel']);
  });

  it('loads the History, Real-Time and Conflicts tabs only once each is drawn', async () => {
    const { unmount } = render(
      <Suspense fallback={<div data-testid="loading" />}>
        <SyncHistoryPanel />
      </Suspense>,
    );
    expect(await screen.findByTestId('history')).toBeDefined();
    expect(evaluated.has('RealTimeSyncPanel')).toBe(false);
    expect(evaluated.has('ConflictListPanel')).toBe(false);
    unmount();

    render(
      <Suspense fallback={<div data-testid="loading" />}>
        <RealTimeSyncPanel sourceOrgId="org-1" targetOrgId="org-2" />
        <ConflictListPanel />
      </Suspense>,
    );
    expect(await screen.findByTestId('realtime')).toBeDefined();
    expect(await screen.findByTestId('conflicts')).toBeDefined();
    // A conflict's decision is drawn once one is picked in the list.
    expect(evaluated.has('ConflictResolutionPanel')).toBe(false);
    expect(ConflictResolutionPanel).toBeDefined();
  });
});
