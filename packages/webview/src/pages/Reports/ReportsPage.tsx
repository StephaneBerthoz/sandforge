import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { m } from 'framer-motion';
import type {
  GeneratedReport,
  AnalyticsTimeSeries,
  AuditFacets,
  AuditLogEntry,
  DataLineageGraph,
  LineageRunSummary,
} from '@sandforge/shared';
import { Tabs } from '../../components/ui/Tabs';
import { BentoGrid, BentoTile } from '../../components/ui/BentoGrid';
import { ComingSoon } from '../../components/ui/ComingSoon';
import { EmptyState } from '../../components/ui/EmptyState';
import { ErrorBanner } from '../../components/ui/ErrorBanner';
import { KPICard } from '../../components/ui/KPICard';
import { Select } from '../../components/ui/Select';
import { fadeIn, staggerContainer, slideUp } from '../../motion/presets';
import { ExecutionReportView } from './ExecutionReportView';
import { AnalyticsDashboard } from './AnalyticsDashboard';
import type { AnalyticsSummary } from './AnalyticsDashboard';
import { AuditTrailViewer } from './AuditTrailViewer';
import type { AuditFilter } from './AuditTrailViewer';
import { LineageGraph } from './LineageGraph';
import { uiLocale } from '../../utils/formatters';

/** ReportsPage component props. */
export interface ReportsPageProps {
  /** Reports to display — the page has no data source of its own. */
  reports?: GeneratedReport[];
  analyticsSummary?: AnalyticsSummary;
  operationsOverTime?: AnalyticsTimeSeries;
  errorTimeSeries?: AnalyticsTimeSeries;
  auditEntries?: AuditLogEntry[];
  /** Entries the trail holds for the current filter, the page shown or not. */
  auditTotal?: number;
  /** Every module and org of the trail, for its filters. */
  auditFacets?: AuditFacets;
  auditFilter?: AuditFilter;
  onAuditFilterChange?: (filter: AuditFilter) => void;
  onShowMoreAudit?: () => void;
  /** Why the trail could not be read, when it could not. */
  auditError?: string;
  /** `null` is a producer saying no run has been traced yet. */
  lineageData?: DataLineageGraph | null;
  /** The runs a lineage is kept for, newest first. */
  lineageRuns?: LineageRunSummary[];
  onSelectLineageRun?: (operationId: string) => void;
  /** Why the lineage could not be read, when it could not. */
  lineageError?: string;
  onSelectReport?: (id: string) => void;
  onExportReport?: (id: string) => void;
}

/**
 * Main reports and analytics page with tabbed navigation.
 *
 * Presentational only: every datum arrives through props, from
 * ReportsContainer. It used to fire `reports:list` / `reports:export` on the
 * bridge itself — the broker dropped both as undeclared and the page sat on a
 * 30 s timeout it then swallowed.
 *
 * A prop left `undefined` means no producer supplied it. Rendering the panels
 * anyway once printed four KPI tiles reading 0 / 0 / 0.0 % / 0 — figures with
 * no source behind them, which a reader takes for measurements ("this org ran
 * nothing and fails every operation") rather than for an absent feature. A
 * tab whose data has no producer says so, through the same {@link ComingSoon}
 * notice DataOps uses; the KPI row only appears once every figure it prints
 * has a source. A producer that answered with nothing — no run recorded, no
 * lineage traced — gets an empty state that says what will appear, and when.
 */
export const ReportsPage: React.FC<ReportsPageProps> = ({
  reports,
  analyticsSummary,
  operationsOverTime,
  errorTimeSeries,
  auditEntries,
  auditTotal,
  auditFacets,
  auditFilter,
  onAuditFilterChange,
  onShowMoreAudit,
  auditError,
  lineageData,
  lineageRuns,
  onSelectLineageRun,
  lineageError,
  onSelectReport,
  onExportReport,
}) => {
  const { t } = useTranslation();
  const [activeTab, setActiveTab] = useState('executions');
  const [selectedReportId, setSelectedReportId] = useState<string | undefined>();

  const tabs = [
    { id: 'executions', label: t('reports.executions') },
    { id: 'analytics', label: t('reports.analytics') },
    { id: 'audit', label: t('reports.audit') },
    { id: 'lineage', label: t('reports.lineage') },
  ];

  const handleSelectReport = (id: string): void => {
    setSelectedReportId(id);
    onSelectReport?.(id);
  };

  const handleExportReport = (id: string): void => {
    onExportReport?.(id);
  };

  const reportCount = reports?.length ?? 0;
  const totalOps = analyticsSummary?.totalOperations ?? 0;
  const successRate = analyticsSummary?.successRate ?? 0;
  const auditCount = auditTotal ?? auditEntries?.length ?? 0;

  /**
   * Whether each tab has been given something to show. `undefined` means "no
   * producer supplied this", which is not the same as an empty array: `[]` is
   * a measured "nothing to report" and still renders the real view.
   */
  const hasReports = reports !== undefined;
  const hasAnalytics =
    analyticsSummary !== undefined ||
    operationsOverTime !== undefined ||
    errorTimeSeries !== undefined;
  const hasAudit = auditEntries !== undefined;
  const hasLineage = lineageData !== undefined;
  /**
   * A producer that answered with nothing at all: the trail holds no module,
   * whatever the filter. A filter that matches nothing is not this — the
   * viewer says so itself, under the filter that caused it.
   */
  const auditNothingRecorded =
    hasAudit && auditEntries.length === 0 && (auditFacets?.modules.length ?? 0) === 0;

  /**
   * Every KPI tile needs its OWN source — a tile with no source behind it is
   * the same lie in miniature as the row of four this module used to print.
   *
   * Gated per tile rather than all-or-nothing: a figure with a source is
   * shown even when another tile has none, rather than hidden to avoid an
   * invented one.
   */
  const hasMetrics = hasReports || analyticsSummary !== undefined || hasAudit;

  return (
    <m.div
      data-testid="reports-page"
      className="flex flex-col gap-3 p-4"
      variants={fadeIn}
      initial="hidden"
      animate="visible"
    >
      <h1 className="text-lg font-bold text-text-primary">{t('reports.title')}</h1>

      {/* KPI summary row — omitted entirely when nothing feeds it. */}
      {hasMetrics && (
        <m.div
          variants={staggerContainer}
          initial="hidden"
          animate="visible"
          data-testid="reports-kpi-row"
        >
          <BentoGrid columns={4} gap="md">
            {hasReports && (
              <m.div variants={slideUp}>
                <KPICard
                  icon="file"
                  label={t('reports.totalReports')}
                  value={reportCount}
                  variant="default"
                />
              </m.div>
            )}
            {analyticsSummary !== undefined && (
              <m.div variants={slideUp}>
                <KPICard
                  icon="pulse"
                  label={t('reports.totalOperations')}
                  value={totalOps.toLocaleString(uiLocale())}
                  variant="default"
                />
              </m.div>
            )}
            {analyticsSummary !== undefined && (
              <m.div variants={slideUp}>
                <KPICard
                  icon="check"
                  label={t('reports.successRate')}
                  value={`${successRate.toFixed(1)}%`}
                  variant={successRate >= 90 ? 'success' : 'warning'}
                />
              </m.div>
            )}
            {hasAudit && (
              <m.div variants={slideUp}>
                <KPICard
                  icon="shield"
                  label={t('reports.auditEntries')}
                  value={auditCount}
                  variant="default"
                />
              </m.div>
            )}
          </BentoGrid>
        </m.div>
      )}

      <Tabs tabs={tabs} activeTab={activeTab} onTabChange={setActiveTab} />

      <BentoTile className="p-0">
        {tabs.map((tab) => (
          <div
            key={tab.id}
            id={`tabpanel-${tab.id}`}
            role="tabpanel"
            aria-labelledby={`tab-${tab.id}`}
            hidden={activeTab !== tab.id}
          >
            {activeTab === tab.id && (
              <div className="p-4">
                {/* Each panel either shows data it was given, or says the
                    capability is not wired. An empty list here would read as
                    "the report ran and found nothing" — it never ran. */}
                {tab.id === 'executions' &&
                  (hasReports ? (
                    <ExecutionReportView
                      reports={reports}
                      selectedReportId={selectedReportId}
                      onSelectReport={handleSelectReport}
                      onExport={handleExportReport}
                    />
                  ) : (
                    <ComingSoon
                      data-testid="reports-executions-soon"
                      description={t('reports.executionsDesc')}
                    />
                  ))}
                {tab.id === 'analytics' &&
                  (hasAnalytics ? (
                    <AnalyticsDashboard
                      summary={analyticsSummary}
                      operationsOverTime={operationsOverTime}
                      errorTimeSeries={errorTimeSeries}
                    />
                  ) : (
                    <ComingSoon
                      data-testid="reports-analytics-soon"
                      description={t('reports.analyticsDesc')}
                    />
                  ))}
                {tab.id === 'audit' &&
                  (auditError ? (
                    <ErrorBanner
                      data-testid="reports-audit-error"
                      message={t('reports.auditUnreadable', { error: auditError })}
                    />
                  ) : !hasAudit ? (
                    <ComingSoon
                      data-testid="reports-audit-soon"
                      description={t('reports.auditDesc')}
                    />
                  ) : auditNothingRecorded ? (
                    <div data-testid="reports-audit-empty">
                      <EmptyState
                        title={t('reports.auditEmptyTitle')}
                        description={t('reports.auditEmptyDesc')}
                      />
                    </div>
                  ) : (
                    <AuditTrailViewer
                      entries={auditEntries}
                      total={auditTotal}
                      facets={auditFacets}
                      filter={auditFilter}
                      onFilterChange={onAuditFilterChange}
                      onShowMore={onShowMoreAudit}
                    />
                  ))}
                {tab.id === 'lineage' &&
                  (lineageError ? (
                    <ErrorBanner
                      data-testid="reports-lineage-error"
                      message={t('reports.lineageUnreadable', { error: lineageError })}
                    />
                  ) : !hasLineage ? (
                    <ComingSoon
                      data-testid="reports-lineage-soon"
                      description={t('reports.lineageDesc')}
                    />
                  ) : lineageData === null ? (
                    <div data-testid="reports-lineage-empty">
                      <EmptyState
                        title={t('reports.lineageEmptyTitle')}
                        description={t('reports.lineageEmptyDesc')}
                      />
                    </div>
                  ) : (
                    <div className="flex flex-col gap-3">
                      {lineageRuns && lineageRuns.length > 1 && onSelectLineageRun && (
                        <Select
                          data-testid="lineage-run"
                          label={t('reports.lineageRun')}
                          options={lineageRuns.map((run) => ({
                            value: run.operationId,
                            label: [
                              run.action ? t(`reports.auditActions.${run.action}`) : run.module,
                              run.targetLabel,
                              run.generatedAt.slice(0, 16).replace('T', ' '),
                            ]
                              .filter(Boolean)
                              .join(' · '),
                          }))}
                          value={lineageData.operationId}
                          onChange={(e) => onSelectLineageRun(e.target.value)}
                        />
                      )}
                      <LineageGraph lineage={lineageData} />
                    </div>
                  ))}
              </div>
            )}
          </div>
        ))}
      </BentoTile>
    </m.div>
  );
};
