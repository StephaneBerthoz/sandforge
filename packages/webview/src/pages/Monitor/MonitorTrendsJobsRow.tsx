import React from 'react';
import { useTranslation } from 'react-i18next';
import type { ApiLimit, TrendData } from '@sandforge/shared';
import { SectionHeader } from './SectionHeader';
import { PanelOverlay } from './PanelOverlay';
import { LimitExportButton } from './LimitExportButton';
import { TrendChart } from './TrendChart';
import { TrendCharts } from './TrendCharts';
import type { TrendSeries } from './TrendCharts';
import { JobsTable } from './JobsTable';
import type { JobDisplayInfo } from './monitorUtils';

/** Props for the MonitorTrendsJobsRow section. */
export interface MonitorTrendsJobsRowProps {
  /** Limits sorted by usage (export button). */
  sortedLimits: ApiLimit[];
  /** Raw trends record keyed by limit name (export button). */
  trends: Record<string, TrendData>;
  /** Trend chart data points for the DailyApiRequests chart. */
  trendChartData: Array<{ timestamp: number; value: number }>;
  /** Multi-series trend data for the TrendCharts component. */
  trendSeries: TrendSeries[];
  /** Jobs from the monitor data. */
  jobs: JobDisplayInfo[];
  /** Whether a background refresh is in progress. */
  isRefreshing: boolean;
}

/**
 * Two-column row: trend charts + active jobs table.
 * Memoized — re-renders only when its own slices change.
 */
export const MonitorTrendsJobsRow: React.FC<MonitorTrendsJobsRowProps> = React.memo(
  ({ sortedLimits, trends, trendChartData, trendSeries, jobs, isRefreshing }) => {
    const { t } = useTranslation();

    return (
      <PanelOverlay isRefreshing={isRefreshing}>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {/* Trend chart */}
          <div className="rounded-lg border border-subtle bg-surface-1 p-4">
            <SectionHeader
              title={t('monitor.trends', 'Trends')}
              actions={<LimitExportButton limits={sortedLimits} trends={trends} />}
            />
            {trendChartData.length >= 2 ? (
              <TrendChart data={trendChartData} />
            ) : trendSeries.length > 0 ? (
              <TrendCharts series={trendSeries} />
            ) : (
              <div className="flex items-center justify-center h-32 text-xs text-text-muted">
                {t('monitor.noTrends', 'Not enough data for trends yet')}
              </div>
            )}
          </div>

          {/* Active Jobs */}
          <div className="rounded-lg border border-subtle bg-surface-1 p-4">
            <SectionHeader
              title={t('monitor.jobs', 'Jobs')}
              count={jobs.length > 0 ? jobs.length : undefined}
            />
            <JobsTable jobs={jobs} />
          </div>
        </div>
      </PanelOverlay>
    );
  },
);

MonitorTrendsJobsRow.displayName = 'MonitorTrendsJobsRow';
