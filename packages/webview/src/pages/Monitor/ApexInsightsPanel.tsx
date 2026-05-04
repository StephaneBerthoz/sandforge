import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { FileCode } from 'lucide-react';
import { useBridgeQuery } from '../../hooks/useBridgeQuery';
import { useOrgStore } from '../../stores/useOrgStore';
import { Skeleton } from '../../components/ui/Skeleton';
import { Badge } from '../../components/ui/Badge';
import type { BadgeVariant } from '../../components/ui/Badge';
import { ProgressBar } from '../../components/ui/ProgressBar';
import { formatNumber } from '../../utils/formatters';

/** Response shape from monitor:apex-insights. */
interface ApexInsightsData {
  success: boolean;
  analyses: Array<{
    logId: string;
    totalDuration: number;
    soqlQueries: number;
    dmlStatements: number;
    heapUsed: number;
    cpuTime: number;
    issues: Array<{
      type: string;
      severity: string;
      message: string;
      line?: number;
    }>;
  }>;
  topIssues: Array<{
    type: string;
    severity: string;
    message: string;
    line?: number;
  }>;
}

/** Returns badge variant based on issue severity. */
function severityVariant(severity: string): BadgeVariant {
  switch (severity) {
    case 'critical':
      return 'error';
    case 'warning':
      return 'warning';
    case 'info':
      return 'info';
    default:
      return 'default';
  }
}

/**
 * Panel displaying Apex performance insights fetched via the monitor:apex-insights bridge query.
 *
 * Renders three states: loading skeleton, empty message, or a breakdown of
 * Apex log analyses with top issues and per-log resource usage metrics.
 */
export const ApexInsightsPanel: React.FC = () => {
  const { t } = useTranslation();
  const selectedOrgId = useOrgStore((s) => s.selectedOrgId);

  const { data, loading } = useBridgeQuery<ApexInsightsData>(
    'monitor:apex-insights',
    selectedOrgId ? { orgId: selectedOrgId } : undefined,
    { responseType: 'monitor:apex-insights:response', skip: !selectedOrgId },
  );

  const analyses = useMemo(() => data?.analyses ?? [], [data?.analyses]);
  const topIssues = useMemo(() => data?.topIssues ?? [], [data?.topIssues]);

  if (loading) {
    return (
      <div
        className="rounded-lg border border-subtle bg-surface-1 p-4"
        data-testid="apex-insights-panel-loading"
      >
        <Skeleton variant="rect" height="200px" />
      </div>
    );
  }

  if (analyses.length === 0) {
    return (
      <div
        className="rounded-lg border border-subtle bg-surface-1 p-4"
        data-testid="apex-insights-panel-empty"
      >
        <div className="flex items-center gap-2 mb-3">
          <FileCode className="w-4 h-4 text-text-secondary" />
          <h3 className="text-sm font-semibold text-text-primary">
            {t('monitor.apexInsights.title', 'Apex Insights')}
          </h3>
        </div>
        <p className="text-xs text-text-muted text-center py-6">
          {t('monitor.apexInsights.empty', 'No Apex log data available')}
        </p>
      </div>
    );
  }

  return (
    <div
      className="rounded-lg border border-subtle bg-surface-1 p-4"
      data-testid="apex-insights-panel"
    >
      {/* Header */}
      <div className="flex items-center gap-2 mb-3">
        <FileCode className="w-4 h-4 text-text-secondary" />
        <h3 className="text-sm font-semibold text-text-primary flex-1">
          {t('monitor.apexInsights.title', 'Apex Insights')}
        </h3>
        <Badge variant="default">{analyses.length}</Badge>
      </div>

      {/* Top Issues */}
      {topIssues.length > 0 ? (
        <div className="flex flex-col gap-1.5 mb-3" data-testid="apex-top-issues">
          {topIssues.map((issue, idx) => (
            <div
              key={`${issue.type}-${idx}`}
              className="flex items-start gap-2 px-2 py-1.5 rounded bg-surface-2"
              data-testid={`apex-issue-${idx}`}
            >
              <Badge variant={severityVariant(issue.severity)}>{issue.severity}</Badge>
              <span className="text-xs text-text-secondary flex-1">{issue.message}</span>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-xs text-text-muted mb-3">
          {t('monitor.apexInsights.noIssues', 'No performance issues detected')}
        </p>
      )}

      {/* Analysis table header */}
      <div className="flex items-center gap-3 px-2 py-1 text-[10px] text-text-muted font-medium uppercase tracking-wider border-b border-subtle mb-1">
        <span className="w-20 shrink-0">{t('monitor.apexInsights.logId', 'Log ID')}</span>
        <span className="w-16 shrink-0 text-right">
          {t('monitor.apexInsights.duration', 'Duration')}
        </span>
        <span className="flex-1">{t('monitor.apexInsights.soql', 'SOQL')}</span>
        <span className="w-12 text-right">{t('monitor.apexInsights.dml', 'DML')}</span>
        <span className="w-16 text-right">{t('monitor.apexInsights.heap', 'Heap')}</span>
      </div>

      {/* Analysis rows */}
      <div className="flex flex-col gap-0.5">
        {analyses.map((analysis) => (
          <div
            key={analysis.logId}
            className="flex items-center gap-3 px-2 py-1.5 rounded hover:bg-surface-2 transition-colors"
            data-testid={`apex-analysis-row-${analysis.logId}`}
          >
            <span className="text-[11px] font-mono text-text-muted w-20 shrink-0 truncate">
              {analysis.logId.slice(0, 8)}
            </span>
            <span className="text-xs tabular-nums text-text-secondary w-16 shrink-0 text-right">
              {analysis.totalDuration}ms
            </span>
            <div className="flex-1">
              <ProgressBar value={analysis.soqlQueries} max={100} size="sm" />
            </div>
            <span className="text-xs tabular-nums text-text-secondary w-12 text-right">
              {analysis.dmlStatements}
            </span>
            <span className="text-xs tabular-nums text-text-secondary w-16 text-right">
              {formatNumber(analysis.heapUsed)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
};
