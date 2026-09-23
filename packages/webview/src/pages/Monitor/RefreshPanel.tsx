import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { RefreshCcw } from 'lucide-react';
import { isSandboxRefreshInProgress } from '@sandforge/shared';
import { useBridgeQuery } from '../../hooks/useBridgeQuery';
import { useOrgStore } from '../../stores/useOrgStore';
import { Skeleton } from '../../components/ui/Skeleton';
import { Badge } from '../../components/ui/Badge';
import type { BadgeVariant } from '../../components/ui/Badge';
import { Spinner } from '../../components/ui/Spinner';
import { ListCapNote } from './ListCapNote';
import { dateTimeFormat, formatStoredDate } from '../../utils/formatters';

/** How SandForge came to notice a refresh of the org itself. */
type RefreshEvidence = 'connection' | 'monitor' | 'production';

/**
 * A refresh SandForge noticed on the org it shows: the org answered with
 * another org id than the one it answered with before.
 */
interface DetectedRefresh {
  detectedAt: string;
  evidence: RefreshEvidence;
  previousOrganizationId?: string;
  organizationId?: string;
  previousInstanceName?: string;
  instanceName?: string;
  /** The registered production org whose refresh history reported it. */
  reportedBy?: string;
}

/** Response shape from monitor:sandbox-refresh. */
interface SandboxRefreshData {
  success: boolean;
  /** False when the org has no SandboxProcess to query at all. */
  supported?: boolean;
  refreshes: Array<{
    orgId: string;
    sandboxName: string;
    refreshDate: string;
    status: string;
    sourceOrg?: string;
  }>;
  inProgress: boolean;
  /** The read stopped at its bound: older refreshes are not listed. */
  truncated?: boolean;
  /** Absent from answers of builds that did not notice refreshes. */
  detected?: DetectedRefresh[];
}

/** Shared date formatter for refresh timestamps. */
const dateFormatter = (): Intl.DateTimeFormat =>
  dateTimeFormat({
    dateStyle: 'short',
    timeStyle: 'short',
  });

/** How each way of noticing is told, as catalogue keys. */
const EVIDENCE_KEYS: Record<Exclude<RefreshEvidence, 'production'>, string> = {
  connection: 'monitor.sandboxRefresh.detected.byConnection',
  monitor: 'monitor.sandboxRefresh.detected.byMonitor',
};

/**
 * Returns badge variant based on refresh status.
 *
 * Under way is whatever the extension counts as a refresh in progress, from
 * the same list: this one used to know Pending and Processing only. A stopped
 * process is the copy that ended without replacing the sandbox; the red went
 * to `Failed`, which is not a status Salesforce has.
 */
function statusVariant(status: string): BadgeVariant {
  if (status === 'Completed') return 'success';
  if (isSandboxRefreshInProgress(status)) return 'warning';
  if (status === 'Stopped') return 'error';
  return 'default';
}

/**
 * The refreshes SandForge noticed on the org itself.
 *
 * A sandbox cannot list its own refreshes — only the org that manages it can
 * — so on a sandbox this is the only refresh the panel can show. It is shown
 * whatever the org's own history says.
 */
const DetectedRefreshes: React.FC<{ refreshes: DetectedRefresh[] }> = ({ refreshes }) => {
  const { t } = useTranslation();
  const orgs = useOrgStore((s) => s.orgs);
  if (refreshes.length === 0) return null;
  const aliasOf = (orgId: string): string => orgs.find((org) => org.id === orgId)?.alias ?? orgId;

  return (
    <section className="mt-3 pt-3 border-t border-subtle" data-testid="refresh-detected">
      <h4 className="text-xs font-semibold text-text-primary">
        {t('monitor.sandboxRefresh.detected.title')}
      </h4>
      <p className="text-[11px] text-text-secondary mt-1 mb-2">
        {t('monitor.sandboxRefresh.detected.note')}
      </p>
      <ul className="flex flex-col gap-1.5">
        {refreshes.map((refresh) => (
          <li
            key={refresh.detectedAt}
            className="flex flex-col gap-0.5 px-2 py-1.5 rounded bg-surface-2"
            data-testid="refresh-detected-row"
          >
            <span className="flex items-center gap-2">
              <Badge variant="warning">{t('monitor.sandboxRefresh.detected.badge')}</Badge>
              <span className="text-[11px] tabular-nums text-text-secondary">
                {formatStoredDate(refresh.detectedAt, dateFormatter().format) ??
                  t('common.dateUnknown')}
              </span>
            </span>
            <span className="text-[11px] text-text-secondary">
              {refresh.evidence === 'production'
                ? t('monitor.sandboxRefresh.detected.byProduction', {
                    org: aliasOf(refresh.reportedBy ?? ''),
                  })
                : t(EVIDENCE_KEYS[refresh.evidence])}
            </span>
            {refresh.previousOrganizationId && refresh.organizationId && (
              <span className="text-[11px] text-text-primary tabular-nums">
                {t('monitor.sandboxRefresh.detected.orgChanged', {
                  from: refresh.previousOrganizationId,
                  to: refresh.organizationId,
                })}
              </span>
            )}
            {refresh.previousInstanceName &&
              refresh.instanceName &&
              refresh.previousInstanceName !== refresh.instanceName && (
                <span className="text-[11px] text-text-secondary">
                  {t('monitor.sandboxRefresh.detected.instanceChanged', {
                    from: refresh.previousInstanceName,
                    to: refresh.instanceName,
                  })}
                </span>
              )}
          </li>
        ))}
      </ul>
    </section>
  );
};

/**
 * Panel displaying sandbox refresh events fetched via the monitor:sandbox-refresh bridge query.
 *
 * Renders three states: loading skeleton, empty message, or a table of refresh
 * events with status badges and an in-progress indicator. Under each, the
 * refreshes SandForge noticed on the org itself.
 */
export const RefreshPanel: React.FC = () => {
  const { t } = useTranslation();
  const selectedOrgId = useOrgStore((s) => s.selectedOrgId);

  const { data, loading } = useBridgeQuery<SandboxRefreshData>(
    'monitor:sandbox-refresh',
    selectedOrgId ? { orgId: selectedOrgId } : undefined,
    { responseType: 'monitor:sandbox-refresh:response', skip: !selectedOrgId },
  );

  const refreshes = useMemo(() => data?.refreshes ?? [], [data?.refreshes]);
  const detected = useMemo(() => data?.detected ?? [], [data?.detected]);
  const inProgress = data?.inProgress ?? false;

  if (loading) {
    return (
      <div
        className="rounded-lg border border-subtle bg-surface-1 p-4"
        data-testid="refresh-panel-loading"
      >
        <Skeleton variant="rect" height="200px" />
      </div>
    );
  }

  // Not an empty history: the org itself has no refresh history to read, and
  // the empty state answered a question that was never asked.
  if (data?.supported === false) {
    return (
      <div
        className="rounded-lg border border-subtle bg-surface-1 p-4"
        data-testid="refresh-panel-unsupported"
      >
        <div className="flex items-center gap-2 mb-3">
          <RefreshCcw className="w-4 h-4 text-text-secondary" />
          <h3 className="text-sm font-semibold text-text-primary">
            {t('monitor.sandboxRefresh.title')}
          </h3>
        </div>
        <p className="text-xs text-text-secondary text-center py-6">
          {t('monitor.sandboxRefresh.unsupported')}
        </p>
        <DetectedRefreshes refreshes={detected} />
      </div>
    );
  }

  if (refreshes.length === 0) {
    return (
      <div
        className="rounded-lg border border-subtle bg-surface-1 p-4"
        data-testid="refresh-panel-empty"
      >
        <div className="flex items-center gap-2 mb-3">
          <RefreshCcw className="w-4 h-4 text-text-secondary" />
          <h3 className="text-sm font-semibold text-text-primary">
            {t('monitor.sandboxRefresh.title', 'Sandbox Refreshes')}
          </h3>
        </div>
        <p className="text-xs text-text-secondary text-center py-6">
          {t('monitor.sandboxRefresh.empty', 'No sandbox refresh events')}
        </p>
        <DetectedRefreshes refreshes={detected} />
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-subtle bg-surface-1 p-4" data-testid="refresh-panel">
      {/* Header */}
      <div className="flex items-center gap-2 mb-3">
        <RefreshCcw className="w-4 h-4 text-text-secondary" />
        <h3 className="text-sm font-semibold text-text-primary flex-1">
          {t('monitor.sandboxRefresh.title', 'Sandbox Refreshes')}
        </h3>
        {inProgress && (
          <div className="flex items-center gap-1.5" data-testid="refresh-in-progress">
            <Badge variant="warning">
              {t('monitor.sandboxRefresh.inProgress', 'Refresh in progress')}
            </Badge>
            <Spinner size="sm" />
          </div>
        )}
      </div>

      {data?.truncated && <ListCapNote shown={refreshes.length} testId="refresh-list-cap" />}

      {/* Table rows */}
      <div className="flex flex-col gap-0.5">
        {refreshes.map((refresh) => (
          <div
            key={refresh.sandboxName}
            className="flex items-center gap-3 px-2 py-1.5 rounded hover:bg-surface-2 transition-colors"
            data-testid={`refresh-row-${refresh.sandboxName}`}
          >
            <span className="text-xs font-semibold text-text-primary flex-1 truncate">
              {refresh.sandboxName}
            </span>
            <span className="shrink-0">
              <Badge variant={statusVariant(refresh.status)}>{refresh.status}</Badge>
            </span>
            <span className="text-[11px] tabular-nums text-text-secondary w-28 shrink-0">
              {formatStoredDate(refresh.refreshDate, dateFormatter().format) ??
                t('common.dateUnknown')}
            </span>
            {refresh.sourceOrg && (
              <span className="text-[11px] text-text-secondary truncate max-w-24">
                {refresh.sourceOrg}
              </span>
            )}
          </div>
        ))}
      </div>
      <DetectedRefreshes refreshes={detected} />
    </div>
  );
};
