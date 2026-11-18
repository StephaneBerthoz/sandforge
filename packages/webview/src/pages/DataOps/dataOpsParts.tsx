import { lazy, Suspense, type FC } from 'react';
import { withEnglish } from '../../i18n/englishNamespaces';
import { PartBoundary } from '../../components/ui/PartBoundary';
import type { CompliancePanelProps } from './CompliancePanel';
import type { CleanupPanelProps } from './CleanupPanel';
import type { AnonymizePanelProps } from './AnonymizePanel';
import type { EmptyPanelProps } from './empty/EmptyPanel';

/*
 * The tabs of the DataOps page its first paint does not draw, each a chunk of
 * its own fetched the first time it is opened: Masking, the tab the page opens
 * on, is fetched once the page has painted, and Personal data, Cleanup and
 * Emptying once their tab is chosen. Their words are the page's own
 * namespace, loaded with the page. The page parsed 900 kB before it painted
 * while it held the last three, its budget to the byte; and 1,009 kB while it
 * held Masking, past its budget of 1 MB once the masking in slices came: the
 * tab's 160 kB, zod's 97 of them, for the template schema built beside the
 * constants its editor reads.
 */

const LoadedCompliancePanel = lazy(() =>
  withEnglish(() => import('./CompliancePanel'), [])().then((module) => ({
    default: module.CompliancePanel,
  })),
);

const LoadedCleanupPanel = lazy(() =>
  withEnglish(() => import('./CleanupPanel'), [])().then((module) => ({
    default: module.CleanupPanel,
  })),
);

// Emptying objects or the whole org: its own chunk and its own words, fetched
// once the Emptying tab is opened, as what the page paints first leaves out.
const LoadedEmptyPanel = lazy(() =>
  withEnglish(() => import('./empty/EmptyPanel'), ['checkpointNotes', 'dataopsEmpty'])().then(
    (module) => ({
      default: module.EmptyPanel,
    }),
  ),
);

const LoadedAnonymizePanel = lazy(() =>
  withEnglish(() => import('./AnonymizePanel'), [])().then((module) => ({
    default: module.AnonymizePanel,
  })),
);

/** The Masking tab: templates, their preview, and a masking run, whole or in slices. */
export const AnonymizePanel: FC<AnonymizePanelProps> = (props) => (
  <PartBoundary>
    <Suspense fallback={null}>
      <LoadedAnonymizePanel {...props} />
    </Suspense>
  </PartBoundary>
);

/** The Personal data tab: subject requests and what the org holds of a person. */
export const CompliancePanel: FC<CompliancePanelProps> = (props) => (
  <PartBoundary>
    <Suspense fallback={null}>
      <LoadedCompliancePanel {...props} />
    </Suspense>
  </PartBoundary>
);

/** The Cleanup tab: stale records found, then removed under a plan, and how filled each field is. */
export const CleanupPanel: FC<CleanupPanelProps> = (props) => (
  <PartBoundary>
    <Suspense fallback={null}>
      <LoadedCleanupPanel {...props} />
    </Suspense>
  </PartBoundary>
);

/** The Emptying tab: every record of objects picked, or of the whole org. */
export const EmptyPanel: FC<EmptyPanelProps> = (props) => (
  <PartBoundary>
    <Suspense fallback={null}>
      <LoadedEmptyPanel {...props} />
    </Suspense>
  </PartBoundary>
);
