import React from 'react';
import { useTranslation } from 'react-i18next';
import { Shield } from 'lucide-react';
import { Badge } from '../../components/ui/Badge';
import type { BadgeVariant } from '../../components/ui/Badge';

/** Org health status payload from the monitor:data response. */
export interface OrgHealthStatus {
  orgId: string;
  overall: 'healthy' | 'degraded' | 'critical';
  apiLimitsStatus: 'ok' | 'warning' | 'critical';
  storageStatus: 'ok' | 'warning' | 'critical';
  activeJobs: number;
  recentErrors: number;
  lastChecked: string;
}

/** Props for the HealthCheckPanel component. */
interface HealthCheckPanelProps {
  /** Health status from the monitor:data response. Undefined while loading or unavailable. */
  orgHealthStatus?: OrgHealthStatus;
}

/** Shared date formatter for the last-checked timestamp. */
const dateFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'short',
  timeStyle: 'short',
});

/** Returns badge variant based on health or status value. */
function statusVariant(
  status: 'ok' | 'warning' | 'critical' | 'healthy' | 'degraded',
): BadgeVariant {
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

/** Returns human-readable label for overall health status. */
function overallLabel(status: 'healthy' | 'degraded' | 'critical'): string {
  switch (status) {
    case 'healthy':
      return 'Healthy';
    case 'degraded':
      return 'Degraded';
    case 'critical':
      return 'Critical';
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
export const HealthCheckPanel: React.FC<HealthCheckPanelProps> = React.memo(({ orgHealthStatus }) => {
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
        <p className="text-xs text-text-muted text-center py-6">
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
          {t(
            `monitor.healthCheck.${orgHealthStatus.overall}`,
            overallLabel(orgHealthStatus.overall),
          )}
        </Badge>
      </div>

      {/* Status grid */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-3">
        {/* API Limits */}
        <div className="flex flex-col gap-1">
          <span className="text-[10px] text-text-muted font-medium uppercase tracking-wider">
            {t('monitor.healthCheck.apiLimits', 'API Limits')}
          </span>
          <Badge variant={statusVariant(orgHealthStatus.apiLimitsStatus)}>
            {orgHealthStatus.apiLimitsStatus}
          </Badge>
        </div>

        {/* Storage */}
        <div className="flex flex-col gap-1">
          <span className="text-[10px] text-text-muted font-medium uppercase tracking-wider">
            {t('monitor.healthCheck.storage', 'Storage')}
          </span>
          <Badge variant={statusVariant(orgHealthStatus.storageStatus)}>
            {orgHealthStatus.storageStatus}
          </Badge>
        </div>

        {/* Active Jobs */}
        <div className="flex flex-col gap-1">
          <span className="text-[10px] text-text-muted font-medium uppercase tracking-wider">
            {t('monitor.healthCheck.jobs', 'Active Jobs')}
          </span>
          <span className="text-sm font-semibold tabular-nums text-text-primary">
            {orgHealthStatus.activeJobs}
          </span>
        </div>

        {/* Recent Errors */}
        <div className="flex flex-col gap-1">
          <span className="text-[10px] text-text-muted font-medium uppercase tracking-wider">
            {t('monitor.healthCheck.errors', 'Recent Errors')}
          </span>
          {orgHealthStatus.recentErrors > 0 ? (
            <Badge variant="error">{orgHealthStatus.recentErrors}</Badge>
          ) : (
            <span className="text-sm font-semibold tabular-nums text-text-primary">
              {orgHealthStatus.recentErrors}
            </span>
          )}
        </div>
      </div>

      {/* Last checked */}
      <p className="text-[10px] text-text-muted">
        {t('monitor.healthCheck.lastChecked', 'Last checked')}:{' '}
        {dateFormatter.format(new Date(orgHealthStatus.lastChecked))}
      </p>
    </div>
  );
});

HealthCheckPanel.displayName = 'HealthCheckPanel';
