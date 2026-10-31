import { lazy, Suspense, type FC } from 'react';
import { withEnglish } from '../../i18n/englishNamespaces';
import { PartBoundary } from '../../components/ui/PartBoundary';
import type { RewindStepConfirmProps } from './RewindStepConfirm';

/*
 * The parts of the Automation page its first paint does not draw, each a
 * chunk of its own fetched the first time it is shown: the confirmation of a
 * Rewind step comes once Confirm… is pressed on the step. It shows the
 * Checkpoints page's preview of the rewind, and with it the words of the
 * Checkpoints page and of what the org runs as a removal writes, loaded with
 * the part: the page parsed 983 kB before it painted while it held them.
 */

const LoadedRewindStepConfirm = lazy(() =>
  withEnglish(() => import('./RewindStepConfirm'), [
    'checkpoint',
    'orgAutomation',
    'runRemoval',
  ])().then((module) => ({
    default: module.RewindStepConfirm,
  })),
);

/** The confirmation of a Rewind step, typed once below the preview of what it would do now. */
export const RewindStepConfirm: FC<RewindStepConfirmProps> = (props) => (
  <PartBoundary>
    <Suspense fallback={null}>
      <LoadedRewindStepConfirm {...props} />
    </Suspense>
  </PartBoundary>
);
