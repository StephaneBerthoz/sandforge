import { lazy } from 'react';

/*
 * The Sync page's tabs past its first, each a chunk of its own fetched the
 * first time the tab opens. The page opens on its Sync tab and parsed them all
 * before it painted: the Schedules tab's cron builder and saved
 * configurations, and the tables of History, Conflicts and Real-Time, with the
 * virtual list under them, which took the page to its first-paint budget.
 */

/** The Schedules tab. */
export const SyncSchedulePanel = lazy(() =>
  import('./SyncSchedulePanel').then((module) => ({ default: module.SyncSchedulePanel })),
);

/** The History tab. */
export const SyncHistoryPanel = lazy(() =>
  import('./SyncHistoryPanel').then((module) => ({ default: module.SyncHistoryPanel })),
);

/** The Real-Time tab. */
export const RealTimeSyncPanel = lazy(() =>
  import('./RealTimeSyncPanel').then((module) => ({ default: module.RealTimeSyncPanel })),
);

/** The Conflicts tab's list of the changes held for a decision. */
export const ConflictListPanel = lazy(() =>
  import('./ConflictListPanel').then((module) => ({ default: module.ConflictListPanel })),
);

/** The Conflicts tab's decision on the conflict picked in the list. */
export const ConflictResolutionPanel = lazy(() =>
  import('./ConflictResolutionPanel').then((module) => ({
    default: module.ConflictResolutionPanel,
  })),
);
