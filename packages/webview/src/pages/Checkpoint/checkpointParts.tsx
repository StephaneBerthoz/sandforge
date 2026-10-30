import { lazy, Suspense, type FC } from 'react';
import { withEnglish } from '../../i18n/englishNamespaces';
import { PartBoundary } from '../../components/ui/PartBoundary';
import type { TakeCheckpointProps } from './TakeCheckpoint';
import type { RewindPreviewProps } from './RewindPreview';
import type { RewindRunProps } from './RewindRun';
import type { StopComparingFieldsProps } from './StopComparingFields';
import type { ExportCheckpointProps, ImportCheckpointProps } from './CheckpointTransfer';

/*
 * The parts of the Checkpoints page its first paint does not draw, each a
 * chunk of its own fetched the first time it is shown: the page paints the
 * org's checkpoints, or its empty state, and what a take asks and shows comes
 * once Take a checkpoint is pressed, what a rewind would do once Rewind… is,
 * the rewind and what it did once it is confirmed, the fields a checkpoint
 * compares once they are to change, and the key of an export or the facts of
 * a file to import once Export… or Import… has its answer. Their words are the page's own
 * namespace, loaded with the page; the preview names beside it the words of
 * what the org runs as a removal writes, which it lists as the Forge and Sync
 * removals do, and the run those of what a removal deleted, which it says as
 * they do.
 */

const LoadedTakeCheckpoint = lazy(() =>
  withEnglish(() => import('./TakeCheckpoint'), [])().then((module) => ({
    default: module.TakeCheckpoint,
  })),
);

const LoadedRewindPreview = lazy(() =>
  withEnglish(() => import('./RewindPreview'), ['orgAutomation', 'runRemoval'])().then(
    (module) => ({
      default: module.RewindPreview,
    }),
  ),
);

const LoadedRewindRun = lazy(() =>
  withEnglish(() => import('./RewindRun'), ['orgAutomation', 'runRemoval'])().then((module) => ({
    default: module.RewindRun,
  })),
);

const LoadedStopComparingFields = lazy(() =>
  withEnglish(() => import('./StopComparingFields'), [])().then((module) => ({
    default: module.StopComparingFields,
  })),
);

const LoadedExportCheckpoint = lazy(() =>
  withEnglish(() => import('./CheckpointTransfer'), [])().then((module) => ({
    default: module.ExportCheckpoint,
  })),
);

const LoadedImportCheckpoint = lazy(() =>
  withEnglish(() => import('./CheckpointTransfer'), [])().then((module) => ({
    default: module.ImportCheckpoint,
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

/** What a rewind of an org to a checkpoint would do, read from the org and written nowhere. */
export const RewindPreview: FC<RewindPreviewProps> = (props) => (
  <PartBoundary>
    <Suspense fallback={null}>
      <LoadedRewindPreview {...props} />
    </Suspense>
  </PartBoundary>
);

/** A rewind, or the undo of one, as it runs, with Stop, and what it did. */
export const RewindRun: FC<RewindRunProps> = (props) => (
  <PartBoundary>
    <Suspense fallback={null}>
      <LoadedRewindRun {...props} />
    </Suspense>
  </PartBoundary>
);

/** The fields a checkpoint stops comparing, chosen among those it holds. */
export const StopComparingFields: FC<StopComparingFieldsProps> = (props) => (
  <PartBoundary>
    <Suspense fallback={null}>
      <LoadedStopComparingFields {...props} />
    </Suspense>
  </PartBoundary>
);

/** A checkpoint exported to a file, and the key it is encrypted under, shown once. */
export const ExportCheckpoint: FC<ExportCheckpointProps> = (props) => (
  <PartBoundary>
    <Suspense fallback={null}>
      <LoadedExportCheckpoint {...props} />
    </Suspense>
  </PartBoundary>
);

/** A checkpoint file another machine exported, as its header says it, and its import with the key. */
export const ImportCheckpoint: FC<ImportCheckpointProps> = (props) => (
  <PartBoundary>
    <Suspense fallback={null}>
      <LoadedImportCheckpoint {...props} />
    </Suspense>
  </PartBoundary>
);
