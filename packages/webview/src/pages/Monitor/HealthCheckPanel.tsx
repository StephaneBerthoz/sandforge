import React from 'react';
import { useTranslation } from 'react-i18next';
import { Shield } from 'lucide-react';
import { Badge } from '../../components/ui/Badge';
import type { BadgeVariant } from '../../components/ui/Badge';
import { dateTimeFormat } from '../../utils/formatters';

/** Org health status payload from the monitor:data response. */
export interface OrgHealthStatus {
  orgId: string;
  overall: 'healthy' | 'degraded' | 'critical' | 'unknown';
  apiLimitsStatus: SignalStatus;
  storageStatus: SignalStatus;
  /** Null when the jobs could not be read — not the same as none failed. */
  failedJobs: number | null;
  /** How many of the latest jobs `failedJobs` counts among; absent from older builds. */
  failedJobsOutOf?: number | null;
  /** Null when the logs could not be read — not the same as none found. */
  recentErrorLogs: number | null;
  lastChecked: string;
}

/** One signal's status; `unknown` when the monitor could not read it. */
type SignalStatus = 'ok' | 'warning' | 'critical' | 'unknown';

/** Props for the HealthCheckPanel component. */
interface HealthCheckPanelProps {
  /** Health status from the monitor:data response. Undefined while loading or unavailable. */
  orgHealthStatus?: OrgHealthStatus;
}

/** Shared date formatter for the last-checked timestamp. */
const dateFormatter = (): Intl.DateTimeFormat =>
  dateTimeFormat({
    dateStyle: 'short',
    timeStyle: 'short',
  });

/** Returns badge variant based on health or status value. */
function statusVariant(status: SignalStatus | OrgHealthStatus['overall']): BadgeVariant {
  switch (status) {
    case 'ok':
    case 'healthy':
      return 'success';
    case 'warning':
    case 'degraded':
      return 'warning';
    case 'critical':
      return 'error';
    default:
      return 'default';
  }
}

/**
 * Panel displaying the org health check summary.
 *
 * Unlike other panels, HealthCheckPanel does not make its own bridge query.
 * It receives `orgHealthStatus` as a prop from MonitorPage which extracts
 * it from the existing monitor:data response.
 *
 * Renders two states: empty (no data) or a health status grid with
 * API limits, storage, active jobs, and recent error counts.
 */
export const HealthCheckPanel: React.FC<HealthCheckPanelProps> = React.memo(
  ({ orgHealthStatus }) => {
    const { t } = useTranslation();

    if (!orgHealthStatus) {
      return (
        <div
          className="rounded-lg border border-subtle bg-surface-1 p-4"
          data-testid="health-check-panel-empty"
        >
          <div className="flex items-center gap-2 mb-3">
            <Shield className="w-4 h-4 text-text-secondary" />
            <h3 className="text-sm font-semibold text-text-primary">
              {t('monitor.healthCheck.title', 'Org Health Check')}
            </h3>
          </div>
          <p className="text-xs text-text-secondary text-center py-6">
            {t('monitor.healthCheck.empty', 'Health data loads with dashboard refresh')}
          </p>
        </div>
      );
    }

    return (
      <div
        className="rounded-lg border border-subtle bg-surface-1 p-4"
        data-testid="health-check-panel"
      >
        {/* Header */}
        <div className="flex items-center gap-2 mb-3">
          <Shield className="w-4 h-4 text-text-secondary" />
          <h3 className="text-sm font-semibold text-text-primary flex-1">
            {t('monitor.healthCheck.title', 'Org Health Check')}
          </h3>
          <Badge variant={statusVariant(orgHealthStatus.overall)}>
            {t(`monitor.healthCheck.overall.${orgHealthStatus.overall}`)}
          </Badge>
        </div>

        {/* Status grid */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-3">
          {/* API Limits */}
          <div className="flex flex-col gap-1">
            <span className="text-[10px] text-text-secondary font-medium uppercase tracking-wider">
              {t('monitor.healthCheck.apiLimits', 'API Limits')}
            </span>
            <Badge variant={statusVariant(orgHealthStatus.apiLimitsStatus)}>
              {t(`monitor.healthCheck.signal.${orgHealthStatus.apiLimitsStatus}`)}
            </Badge>
          </div>

          {/* Storage */}
          <div className="flex flex-col gap-1">
            <span className="text-[10px] text-text-secondary font-medium uppercase tracking-wider">
              {t('monitor.healthCheck.storage', 'Storage')}
            </span>
            <Badge variant={statusVariant(orgHealthStatus.storageStatus)}>
              {t(`monitor.healthCheck.signal.${orgHealthStatus.storageStatus}`)}
            </Badge>
          </div>

          {/* Failed Jobs */}
          <div className="flex flex-col gap-1">
            <span className="text-[10px] text-text-secondary font-medium uppercase tracking-wider">
              {t('monitor.healthCheck.failedJobs', 'Failed Jobs')}
            </span>
            <span className="text-sm font-semibold tabular-nums text-text-primary">
              {orgHealthStatus.failedJobs ?? t('monitor.healthCheck.notRead')}
            </span>
            {/* The count holds for the latest jobs only: the refresh reads a
                bounded number of them, and a bare "3" read as the org's total. */}
            {orgHealthStatus.failedJobs !== null &&
              typeof orgHealthStatus.failedJobsOutOf === 'number' && (
                <span
                  className="text-[10px] text-text-secondary"
                  data-testid="health-failed-jobs-out-of"
                >
                  {t('monitor.healthCheck.failedJobsOutOf', {
                    count: orgHealthStatus.failedJobsOutOf,
                  })}
                </span>
              )}
          </div>

          {/* Recent Error Logs */}
          <div className="flex flex-col gap-1">
            <span className="text-[10px] text-text-secondary font-medium uppercase tracking-wider">
              {t('monitor.healthCheck.recentErrorLogs', 'Recent Error Logs')}
            </span>
            {(orgHealthStatus.recentErrorLogs ?? 0) > 0 ? (
              <Badge variant="error">{orgHealthStatus.recentErrorLogs}</Badge>
            ) : (
              <span className="text-sm font-semibold tabular-nums text-text-primary">
                {orgHealthStatus.recentErrorLogs ?? t('monitor.healthCheck.notRead')}
              </span>
            )}
          </div>
        </div>

        {/* Last checked */}
        <p className="text-[10px] text-text-secondary">
          {t('monitor.healthCheck.lastChecked', 'Last checked')}:{' '}
          {dateFormatter().format(new Date(orgHealthStatus.lastChecked))}
        </p>
      </div>
    );
  },
);

HealthCheckPanel.displayName = 'HealthCheckPanel';
