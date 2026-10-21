import { Suspense } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

/**
 * When the Sync page loads its Schedules tab. The stand-in notes when its
 * module is evaluated: the page imported it up front, so every panel showing
 * Sync parsed the cron builder before its Sync tab.
 */
const evaluated = vi.hoisted(() => new Set<string>());

vi.mock('./SyncSchedulePanel', () => {
  evaluated.add('SyncSchedulePanel');
  return { SyncSchedulePanel: () => <div data-testid="schedules">schedules</div> };
});

import { SyncSchedulePanel } from './syncPanels';

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
});
