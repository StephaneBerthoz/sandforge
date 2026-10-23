import { lazy, Suspense, type FC } from 'react';
import { withEnglish } from '../../i18n/englishNamespaces';
import { PartBoundary } from '../../components/ui/PartBoundary';
import type { TakeCheckpointProps } from './TakeCheckpoint';

/*
 * The parts of the Checkpoints page its first paint does not draw, each a
 * chunk of its own fetched the first time it is shown: the page paints the
 * org's checkpoints, or its empty state, and what a take asks and shows comes
 * once Take a checkpoint is pressed. Their words are the page's own
 * namespace, loaded with the page, so each loader names none beyond it.
 */

const LoadedTakeCheckpoint = lazy(() =>
  withEnglish(() => import('./TakeCheckpoint'), [])().then((module) => ({
    default: module.TakeCheckpoint,
  })),
);

/** Take a checkpoint of an org: what it keeps and costs, then the take and what it kept. */
export const TakeCheckpoint: FC<TakeCheckpointProps> = (props) => (
  <PartBoundary>
    <Suspense fallback={null}>
      <LoadedTakeCheckpoint {...props} />
    </Suspense>
  </PartBoundary>
);
