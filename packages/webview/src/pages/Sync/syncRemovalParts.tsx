import { lazy, Suspense, type FC } from 'react';
import { withEnglish } from '../../i18n/englishNamespaces';
import { PartBoundary } from '../../components/ui/PartBoundary';
import type { SyncRunRemovalProps } from './SyncRunRemoval';

/*
 * What a Sync run created and wrote over, with its removal, and the runs that
 * never ended: drawn once a run has ended, or under History, each a chunk of
 * its own fetched with its English (`runRemoval`, and `orgAutomation` for the
 * sweep's listing) the first time it is drawn. Parsed with the page, they and
 * their words took Sync past the 900 kB a page may parse before it paints.
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
