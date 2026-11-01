import { lazy, Suspense, useState, type FC } from 'react';
import { withEnglish } from '../../i18n/englishNamespaces';
import { PartBoundary } from '../../components/ui/PartBoundary';
import type { DangerConfirmProps } from '../../components/ui/DangerConfirm';
import type { RewindStepConfirmProps } from './RewindStepConfirm';
import type { SchedulerCalendarProps } from './SchedulerCalendar';

/*
 * The parts of the Automation page its first paint does not draw, each a
 * chunk of its own fetched the first time it is shown: the confirmation of a
 * Rewind step comes once Preview and confirm… is pressed on the step. It
 * shows the Checkpoints page's preview of the rewind, and with it the words
 * of the Checkpoints page and of what the org runs as a removal writes,
 * loaded with the part: the page parsed 983 kB before it painted while it
 * held them. The Scheduler tab comes once it is opened, with the Sync page's
 * schedule panel it lays out by day: its words are the page's own, and the
 * room it took went to the canvas's empty states, the Rewind step's riskier
 * boxes and the steps' names. The questions a pipeline's Delete and the loss
 * of its unsaved changes ask come with the first of them: the dialog and what
 * it is built on are 15 kB no first paint draws.
 */

const LoadedRewindStepConfirm = lazy(() =>
  withEnglish(
    () => import('./RewindStepConfirm'),
    ['checkpoint', 'orgAutomation', 'runRemoval'],
  )().then((module) => ({
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

const LoadedSchedulerCalendar = lazy(() =>
  withEnglish(() => import('./SchedulerCalendar'), [])().then((module) => ({
    default: module.SchedulerCalendar,
  })),
);

/** The Scheduler tab: the sync schedules by the day each next runs, then the pipelines'. */
export const SchedulerCalendar: FC<SchedulerCalendarProps> = (props) => (
  <PartBoundary>
    <Suspense fallback={null}>
      <LoadedSchedulerCalendar {...props} />
    </Suspense>
  </PartBoundary>
);

const LoadedDangerConfirm = lazy(() =>
  withEnglish(() => import('../../components/ui/DangerConfirm'), [])().then((module) => ({
    default: module.DangerConfirm,
  })),
);

/**
 * A question the page asks before something goes. Loaded the first time it is
 * asked, and kept from then on: taken off the page as it closes, it would not
 * play its way out, and gave the keyboard back to nothing.
 */
export const PipelineQuestion: FC<DangerConfirmProps> = (props) => {
  const [asked, setAsked] = useState(props.open);
  if (props.open && !asked) setAsked(true);
  if (!asked) return null;
  return (
    <PartBoundary>
      <Suspense fallback={null}>
        <LoadedDangerConfirm {...props} />
      </Suspense>
    </PartBoundary>
  );
};
