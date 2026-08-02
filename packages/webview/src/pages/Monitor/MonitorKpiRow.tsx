import React from 'react';
import { useTranslation } from 'react-i18next';
import type { ApiLimit, HealthReport, TrendData } from '@sandforge/shared';
import { KPICard } from '../../components/ui/KPICard';
import { HealthScoreCard } from './HealthScoreCard';
import { HealthGauge } from './HealthGauge';
import { PanelOverlay } from './PanelOverlay';
import { usageVariant, fmtGB } from './monitorUtils';
import { formatNumber } from '../../utils/formatters';

/** Props for the MonitorKpiRow section. */
export interface MonitorKpiRowProps {
  /** Overall health score (0-100). */
  healthScore: number;
  /** Detailed health report breakdown, if available. */
  healthReport: HealthReport | undefined;
  /** DailyApiRequests limit detail. */
  apiLimit: ApiLimit;
  /** DataStorageMB limit detail. */
  storageLimit: ApiLimit;
  /** FileStorageMB limit detail. */
  fileStorageLimit: ApiLimit;
  /** Raw trends record keyed by limit name (drives limit warnings). */
  trends: Record<string, TrendData>;
  /** Number of active or acknowledged alerts. */
  activeAlertsCount: number;
  /** Whether a background refresh is in progress. */
  isRefreshing: boolean;
}

/** Renders the "~Xh to limit" warning for a trend, if a prediction exists. */
function limitWarning(
  t: ReturnType<typeof useTranslation>['t'],
  limitName: string,
  trends: Record<string, TrendData>,
): string | undefined {
  const predicted = trends[limitName]?.predictedTimeToLimit;
  if (!predicted) return undefined;
  return t('monitor.limitReachedIn', 'Limit reached in ~{{hours}}h').replace(
    '{{hours}}',
    String(Math.round(predicted)),
  );
}

/**
 * KPI row: health score tile + API/storage/alerts KPI cards.
 * Memoized — re-renders only when its own slice of monitor data changes.
 */
export const MonitorKpiRow: React.FC<MonitorKpiRowProps> = React.memo(
  ({
    healthScore,
    healthReport,
    apiLimit,
    storageLimit,
    fileStorageLimit,
    trends,
    activeAlertsCount,
    isRefreshing,
  }) => {
    const { t } = useTranslation();

    const apiUsed = apiLimit.max - apiLimit.remaining;
    const storageUsedMB = storageLimit.max - storageLimit.remaining;
    const fileStorageUsedMB = fileStorageLimit.max - fileStorageLimit.remaining;

    const apiWarning = limitWarning(t, 'DailyApiRequests', trends);
    const storageWarning = limitWarning(t, 'DataStorageMB', trends);
    const fileStorageWarning = limitWarning(t, 'FileStorageMB', trends);

    return (
      <PanelOverlay isRefreshing={isRefreshing}>
        <div
          className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3"
          data-testid="kpi-row"
        >
          {/* Health */}
          <div className="rounded-lg border border-subtle bg-surface-1 p-4 flex flex-col items-center justify-center gap-1">
            {healthReport ? (
              <HealthScoreCard report={healthReport} />
            ) : (
              <>
                <HealthGauge value={healthScore} size={100} />
                <span className="text-xs text-text-secondary">
                  {t('monitor.health', 'Health Score')}
                </span>
              </>
            )}
          </div>

          {/* API Calls */}
          <KPICard
            icon="zap"
            label={t('monitor.apiCalls', 'API Calls Today')}
            value={formatNumber(apiUsed)}
            subtitle={`/ ${formatNumber(apiLimit.max)}`}
            progress={apiLimit.usedPercent}
            variant={usageVariant(apiLimit.usedPercent)}
            trendWarning={apiWarning}
          />

          {/* Storage */}
          <KPICard
            icon="database"
            label={t('monitor.dataStorage', 'Data Storage')}
            value={`${fmtGB(storageUsedMB)} GB`}
            subtitle={`/ ${fmtGB(storageLimit.max)} GB`}
            progress={storageLimit.usedPercent}
            variant={usageVariant(storageLimit.usedPercent)}
            trendWarning={storageWarning}
          />

          {/* File Storage */}
          <KPICard
            icon="database"
            label={t('monitor.fileStorage', 'File Storage')}
            value={`${fmtGB(fileStorageUsedMB)} GB`}
            subtitle={`/ ${fmtGB(fileStorageLimit.max)} GB`}
            progress={fileStorageLimit.usedPercent}
            variant={usageVariant(fileStorageLimit.usedPercent)}
            trendWarning={fileStorageWarning}
          />

          {/* Alerts */}
          <KPICard
            icon="bell"
            label={t('monitor.alerts', 'Alerts')}
            value={String(activeAlertsCount)}
            subtitle={t('monitor.alertsCount', 'alert(s)')}
            variant={activeAlertsCount > 0 ? 'warning' : 'default'}
          />
        </div>
      </PanelOverlay>
    );
  },
);

MonitorKpiRow.displayName = 'MonitorKpiRow';
