import { lazy } from 'react';

/*
 * The Sync page's Schedules tab, a chunk of its own fetched the first time the
 * tab opens: its cron builder and the list of saved configurations. The page
 * opens on its Sync tab, which needs neither, and parsed both before it
 * painted.
 */

/** The Schedules tab. */
export const SyncSchedulePanel = lazy(() =>
  import('./SyncSchedulePanel').then((module) => ({ default: module.SyncSchedulePanel })),
);
