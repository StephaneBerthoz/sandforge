import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertCircle } from 'lucide-react';
import { useBridgeQuery } from '../../hooks/useBridgeQuery';
import { useOrgStore } from '../../stores/useOrgStore';
import { Skeleton } from '../../components/ui/Skeleton';
import { Badge } from '../../components/ui/Badge';

/** Response shape from monitor:error-logs. */
interface ErrorLogsData {
  success: boolean;
  errors: Array<{
    id: string;
    errorType: string;
    message: string;
    stackTrace?: string;
    timestamp: string;
    user?: string;
    context?: string;
  }>;
  errorsByType: Array<{ type: string; count: number }>;
  totalCount: number;
}

/** Shared date formatter for error log timestamps. */
const dateFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'short',
  timeStyle: 'short',
});

/**
 * Panel displaying recent error logs fetched via the monitor:error-logs bridge query.
 *
 * Renders three states: loading skeleton, empty message, or a table of errors
 * grouped by type with severity badges and timestamps.
 */
export const ErrorLogsPanel: React.FC = () => {
  const { t } = useTranslation();
  const selectedOrgId = useOrgStore((s) => s.selectedOrgId);

  const { data, loading } = useBridgeQuery<ErrorLogsData>(
    'monitor:error-logs',
    selectedOrgId ? { orgId: selectedOrgId } : undefined,
    { responseType: 'monitor:error-logs:response', skip: !selectedOrgId },
  );

  const errors = useMemo(() => data?.errors ?? [], [data?.errors]);
  const errorsByType = useMemo(() => data?.errorsByType ?? [], [data?.errorsByType]);
  const totalCount = data?.totalCount ?? 0;

  if (loading) {
    return (
      <div className="rounded-lg border border-subtle bg-surface-1 p-4" data-testid="error-logs-panel-loading">
        <Skeleton variant="rect" height="200px" />
      </div>
    );
  }

  if (errors.length === 0) {
    return (
      <div className="rounded-lg border border-subtle bg-surface-1 p-4" data-testid="error-logs-panel-empty">
        <div className="flex items-center gap-2 mb-3">
          <AlertCircle className="w-4 h-4 text-text-secondary" />
          <h3 className="text-sm font-semibold text-text-primary">
            {t('monitor.errorLogs.title', 'Error Logs')}
          </h3>
        </div>
        <p className="text-xs text-text-muted text-center py-6">
          {t('monitor.errorLogs.empty', 'No recent errors detected')}
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-subtle bg-surface-1 p-4" data-testid="error-logs-panel">
      {/* Header */}
      <div className="flex items-center gap-2 mb-3">
        <AlertCircle className="w-4 h-4 text-text-secondary" />
        <h3 className="text-sm font-semibold text-text-primary flex-1">
          {t('monitor.errorLogs.title', 'Error Logs')}
        </h3>
        <Badge variant="error">{totalCount}</Badge>
      </div>

      {/* Error type summary */}
      {errorsByType.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mb-3" data-testid="error-type-summary">
          {errorsByType.slice(0, 3).map((et) => (
            <Badge key={et.type} variant="default">
              {et.type}: {et.count}
            </Badge>
          ))}
        </div>
      )}

      {/* Table header */}
      <div className="flex items-center gap-3 px-2 py-1 text-[10px] text-text-muted font-medium uppercase tracking-wider border-b border-subtle mb-1">
        <span className="w-28 shrink-0">{t('monitor.errorLogs.time', 'Time')}</span>
        <span className="w-24 shrink-0">{t('monitor.errorLogs.type', 'Type')}</span>
        <span className="flex-1">{t('monitor.errorLogs.message', 'Message')}</span>
        <span className="w-20 text-right">{t('monitor.errorLogs.user', 'User')}</span>
      </div>

      {/* Table rows */}
      <div className="flex flex-col gap-0.5">
        {errors.map((error) => (
          <div
            key={error.id}
            className="flex items-center gap-3 px-2 py-1.5 rounded hover:bg-surface-2 transition-colors"
            data-testid={`error-log-row-${error.id}`}
          >
            <span className="text-[11px] tabular-nums text-text-muted w-28 shrink-0">
              {dateFormatter.format(new Date(error.timestamp))}
            </span>
            <span className="w-24 shrink-0">
              <Badge variant="error">{error.errorType}</Badge>
            </span>
            <span className="text-xs text-text-secondary flex-1 truncate">
              {error.message}
            </span>
            {error.user && (
              <span className="text-[11px] text-text-muted w-20 text-right truncate">
                {error.user}
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
};
