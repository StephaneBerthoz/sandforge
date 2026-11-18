import React from 'react';
import { useTranslation } from 'react-i18next';
import { useBridgeQuery } from '../../hooks/useBridgeQuery';
import { ErrorBanner } from '../../components/ui/ErrorBanner';
import { Skeleton } from '../../components/ui/Skeleton';
import { PermissionPresence, readPermissionComparison } from './PermissionPresence';
import type { PermissionComparison } from './PermissionPresence';
import { SnapshotComparison, readSnapshotComparison } from './SnapshotComparison';
import type { OrgSnapshotComparison } from './SnapshotComparison';
import { SettingsDrift, readSettingsDrift } from './SettingsDrift';
import type { SettingsDriftReport } from './SettingsDrift';

/** Props for {@link OrgOverview}. */
export interface OrgOverviewProps {
  sourceOrgId: string;
  targetOrgId: string;
  /** Whether those are two different orgs this machine holds: nothing is read before. */
  orgsPicked: boolean;
}

/**
 * The two orgs side by side, read as the tab opens: the objects each
 * describes, the permission sets and profiles each holds by name, and five
 * fields of each one's Organization record.
 *
 * None of the three needs a comparison: each asks the two orgs alone. They
 * were three tabs shown only once a diff had come back, and a diff of every
 * category took from 24 s to 106 s against two real sandboxes before five
 * fields of `Organization` could be read.
 */
export const OrgOverview: React.FC<OrgOverviewProps> = ({
  sourceOrgId,
  targetOrgId,
  orgsPicked,
}) => {
  const { t } = useTranslation();
  const pair = { sourceOrgId, targetOrgId };
  const skip = !orgsPicked;

  /*
   * Each generic is the *envelope* the matching CompareHandler method posts,
   * not the value inside it. Typing these as the bare payload (`Row[]`,
   * `OrgSnapshot[]`, `DriftResult`) is what let three tabs hand an object to a
   * component expecting an array: the key was never unwrapped, TypeScript
   * believed the lie, and the ErrorBoundary took the whole panel down at
   * runtime. Unwrapping happens here, once, where the contract is visible.
   */
  const snapshotsQuery = useBridgeQuery<{ snapshot?: OrgSnapshotComparison }>(
    'compare:snapshots',
    pair,
    { skip },
  );
  const permissionsQuery = useBridgeQuery<{ permissions?: PermissionComparison }>(
    'compare:permissions',
    pair,
    { skip },
  );
  const driftQuery = useBridgeQuery<{ drift?: SettingsDriftReport }>('compare:drift', pair, {
    skip,
  });

  if (!orgsPicked) {
    return (
      <p className="text-xs text-(--sf-text-secondary)" data-testid="compare-overview-needs">
        {t('compare.overviewNeeds')}
      </p>
    );
  }

  /*
   * A response that does not carry what the section needs is reported as the
   * failed exchange it is -- never rendered as an empty comparison, which a
   * reader would take for a measurement ("the two orgs match"). The message is
   * a channel diagnostic, in the same register as the bridge's own timeout
   * text, because it names a wire contract rather than a user-facing fact.
   */
  const snapshot = readSnapshotComparison(snapshotsQuery.data?.snapshot);
  const permissions = readPermissionComparison(permissionsQuery.data?.permissions);
  const drift = readSettingsDrift(driftQuery.data?.drift);
  const sourceLabel = t('compareParts.source');
  const targetLabel = t('compareParts.target');

  return (
    <div className="flex flex-col gap-(--sf-space-4)" data-testid="compare-overview">
      {snapshotsQuery.loading ? (
        <Skeleton variant="rect" height="200px" />
      ) : snapshot ? (
        <SnapshotComparison
          snapshot={snapshot}
          sourceLabel={sourceLabel}
          targetLabel={targetLabel}
        />
      ) : (
        <ErrorBanner
          message={snapshotsQuery.error ?? 'compare:snapshots returned no org snapshot'}
          data-testid="compare-snapshots-error"
        />
      )}

      {permissionsQuery.loading ? (
        <Skeleton variant="rect" height="200px" />
      ) : permissions ? (
        <PermissionPresence
          comparison={permissions}
          sourceLabel={sourceLabel}
          targetLabel={targetLabel}
        />
      ) : (
        <ErrorBanner
          message={permissionsQuery.error ?? 'compare:permissions returned no permission data'}
          data-testid="compare-permissions-error"
        />
      )}

      {driftQuery.loading ? (
        <Skeleton variant="rect" height="200px" />
      ) : drift ? (
        <SettingsDrift drift={drift} sourceLabel={sourceLabel} targetLabel={targetLabel} />
      ) : (
        <ErrorBanner
          message={driftQuery.error ?? 'compare:drift returned no settings to compare'}
          data-testid="compare-drift-error"
        />
      )}
    </div>
  );
};
