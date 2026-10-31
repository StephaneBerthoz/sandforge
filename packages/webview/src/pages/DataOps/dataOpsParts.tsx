import { lazy, Suspense, type FC } from 'react';
import { withEnglish } from '../../i18n/englishNamespaces';
import { PartBoundary } from '../../components/ui/PartBoundary';
import type { CompliancePanelProps } from './CompliancePanel';
import type { CleanupPanelProps } from './CleanupPanel';
import type { QualityPanelProps } from './QualityPanel';

/*
 * The tabs of the DataOps page its first paint does not draw, each a chunk of
 * its own fetched the first time it is opened: the page opens on Backup, and
 * GDPR, Cleanup and Quality come once their tab is chosen. Their words are the
 * page's own namespace, loaded with the page. The page parsed 900 kB before
 * it painted while it held them, its budget to the byte.
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

const LoadedQualityPanel = lazy(() =>
  withEnglish(() => import('./QualityPanel'), [])().then((module) => ({
    default: module.QualityPanel,
  })),
);

/** The GDPR tab: subject requests and what the org holds of a person. */
export const CompliancePanel: FC<CompliancePanelProps> = (props) => (
  <PartBoundary>
    <Suspense fallback={null}>
      <LoadedCompliancePanel {...props} />
    </Suspense>
  </PartBoundary>
);

/** The Cleanup tab: stale records found, then removed under a plan. */
export const CleanupPanel: FC<CleanupPanelProps> = (props) => (
  <PartBoundary>
    <Suspense fallback={null}>
      <LoadedCleanupPanel {...props} />
    </Suspense>
  </PartBoundary>
);

/** The Quality tab: what the org's records lack, per object. */
export const QualityPanel: FC<QualityPanelProps> = (props) => (
  <PartBoundary>
    <Suspense fallback={null}>
      <LoadedQualityPanel {...props} />
    </Suspense>
  </PartBoundary>
);
