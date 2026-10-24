import { lazy, Suspense, type FC } from 'react';
import { withEnglish } from '../../i18n/englishNamespaces';
import { PartBoundary } from '../../components/ui/PartBoundary';
import type { SyncRunRemovalProps } from './SyncRunRemoval';

/*
 * What a Sync run created and wrote over, with its removal, the runs that
 * never ended and the sessions of the Real-Time tab: drawn once a run has
 * ended, under History, or under Real-Time, each a chunk of its own fetched
 * with its English (`runRemoval`, and `orgAutomation` for the sweep's
 * listing) the first time it is drawn. Parsed with the page, they and their
 * words took Sync past the 900 kB a page may parse before it paints.
 */

const LoadedRunRemoval = lazy(() =>
  withEnglish(() => import('./SyncRunRemoval'), ['orgAutomation', 'runRemoval'])().then(
    (module) => ({
      default: module.SyncRunRemoval,
    }),
  ),
);

const LoadedUnfinishedRuns = lazy(() =>
  withEnglish(() => import('./SyncUnfinishedRuns'), ['orgAutomation', 'runRemoval'])().then(
    (module) => ({
      default: module.SyncUnfinishedRuns,
    }),
  ),
);

const LoadedSessionRuns = lazy(() =>
  withEnglish(() => import('./RealtimeSessionRuns'), ['orgAutomation', 'runRemoval'])().then(
    (module) => ({
      default: module.RealtimeSessionRuns,
    }),
  ),
);

/** A run's removal card: what it created and wrote over, and how to take it back. */
export const SyncRunRemoval: FC<SyncRunRemovalProps> = (props) => (
  <PartBoundary>
    <Suspense fallback={null}>
      <LoadedRunRemoval {...props} />
    </Suspense>
  </PartBoundary>
);

/** The runs that never ended, with what each created. */
export const SyncUnfinishedRuns: FC = () => (
  <PartBoundary>
    <Suspense fallback={null}>
      <LoadedUnfinishedRuns />
    </Suspense>
  </PartBoundary>
);

/** The sessions of the Real-Time tab that wrote, with what each wrote and its removal. */
export const RealtimeSessionRuns: FC = () => (
  <PartBoundary>
    <Suspense fallback={null}>
      <LoadedSessionRuns />
    </Suspense>
  </PartBoundary>
);
