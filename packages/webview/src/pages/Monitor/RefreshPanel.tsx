import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { RefreshCcw } from 'lucide-react';
import { useBridgeQuery } from '../../hooks/useBridgeQuery';
import { useOrgStore } from '../../stores/useOrgStore';
import { Skeleton } from '../../components/ui/Skeleton';
import { Badge } from '../../components/ui/Badge';
import type { BadgeVariant } from '../../components/ui/Badge';
import { Spinner } from '../../components/ui/Spinner';

/** Response shape from monitor:sandbox-refresh. */
interface SandboxRefreshData {
  success: boolean;
  refreshes: Array<{
    orgId: string;
    sandboxName: string;
    refreshDate: string;
    status: string;
    sourceOrg?: string;
  }>;
  inProgress: boolean;
}

/** Shared date formatter for refresh timestamps. */
const dateFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'short',
  timeStyle: 'short',
});

/** Returns badge variant based on refresh status. */
function statusVariant(status: string): BadgeVariant {
  switch (status) {
    case 'Completed': return 'success';
    case 'Processing':
    case 'Pending': return 'warning';
    case 'Failed': return 'error';
    default: return 'default';
  }
}

/**
 * Panel displaying sandbox refresh events fetched via the monitor:sandbox-refresh bridge query.
 *
 * Renders three states: loading skeleton, empty message, or a table of refresh
 * events with status badges and an in-progress indicator.
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
  const inProgress = data?.inProgress ?? false;

  if (loading) {
    return (
      <div className="rounded-lg border border-subtle bg-surface-1 p-4" data-testid="refresh-panel-loading">
        <Skeleton variant="rect" height="200px" />
      </div>
    );
  }

  if (refreshes.length === 0) {
    return (
      <div className="rounded-lg border border-subtle bg-surface-1 p-4" data-testid="refresh-panel-empty">
        <div className="flex items-center gap-2 mb-3">
          <RefreshCcw className="w-4 h-4 text-text-secondary" />
          <h3 className="text-sm font-semibold text-text-primary">
            {t('monitor.sandboxRefresh.title', 'Sandbox Refreshes')}
          </h3>
        </div>
        <p className="text-xs text-text-muted text-center py-6">
          {t('monitor.sandboxRefresh.empty', 'No sandbox refresh events')}
        </p>
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
              <Badge variant={statusVariant(refresh.status)}>
                {refresh.status}
              </Badge>
            </span>
            <span className="text-[11px] tabular-nums text-text-muted w-28 shrink-0">
              {dateFormatter.format(new Date(refresh.refreshDate))}
            </span>
            {refresh.sourceOrg && (
              <span className="text-[11px] text-text-muted truncate max-w-24">
                {refresh.sourceOrg}
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
};
