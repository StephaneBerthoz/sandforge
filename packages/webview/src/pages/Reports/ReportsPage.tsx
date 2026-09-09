import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { m } from 'framer-motion';
import type {
  GeneratedReport,
  AnalyticsTimeSeries,
  AuditLogEntry,
  DataLineageGraph,
} from '@sandforge/shared';
import { Tabs } from '../../components/ui/Tabs';
import { BentoGrid, BentoTile } from '../../components/ui/BentoGrid';
import { ComingSoon } from '../../components/ui/ComingSoon';
import { KPICard } from '../../components/ui/KPICard';
import { fadeIn, staggerContainer, slideUp } from '../../motion/presets';
import { ExecutionReportView } from './ExecutionReportView';
import { AnalyticsDashboard } from './AnalyticsDashboard';
import type { AnalyticsSummary } from './AnalyticsDashboard';
import { AuditTrailViewer } from './AuditTrailViewer';
import { LineageGraph } from './LineageGraph';

/** ReportsPage component props. */
export interface ReportsPageProps {
  /** Reports to display — the page has no data source of its own. */
  reports?: GeneratedReport[];
  analyticsSummary?: AnalyticsSummary;
  operationsOverTime?: AnalyticsTimeSeries;
  errorTimeSeries?: AnalyticsTimeSeries;
  auditEntries?: AuditLogEntry[];
  lineageData?: DataLineageGraph;
  onSelectReport?: (id: string) => void;
  onExportReport?: (id: string) => void;
}

/**
 * Main reports and analytics page with tabbed navigation.
 *
 * Presentational only: there is no `reports:*` channel in the shared protocol
 * and no handler behind one, so every datum arrives through props. It used to
 * fire `reports:list` / `reports:export` on the bridge — the broker dropped
 * both as undeclared and the page sat on a 30 s timeout it then swallowed.
 *
 * PanelRouter mounts it with no props at all, so in the shipped product every
 * prop below is `undefined`. Rendering the panels anyway printed four KPI
 * tiles reading 0 / 0 / 0.0 % / 0 — figures with no source behind them, which
 * a reader takes for measurements ("this org ran nothing and fails every
 * operation") rather than for an absent feature. A tab whose data has no
 * producer says so, through the same {@link ComingSoon} notice DataOps uses;
 * the KPI row only appears once every figure it prints has a source.
 */
export const ReportsPage: React.FC<ReportsPageProps> = ({
  reports,
  analyticsSummary,
  operationsOverTime,
  errorTimeSeries,
  auditEntries,
  lineageData,
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
  const auditCount = auditEntries?.length ?? 0;

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
   * Every KPI tile needs its OWN source — a tile with no source behind it is
   * the same lie in miniature as the row of four this module used to print.
   *
   * Gated per tile rather than all-or-nothing: the audit trail has no store
   * behind it, and tying the three figures that do have one to the one that
   * does not would hide real measurements to avoid an invented one.
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
                  value={totalOps.toLocaleString()}
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
                  (hasAudit ? (
                    <AuditTrailViewer entries={auditEntries} />
                  ) : (
                    <ComingSoon
                      data-testid="reports-audit-soon"
                      description={t('reports.auditDesc')}
                    />
                  ))}
                {tab.id === 'lineage' &&
                  (hasLineage ? (
                    <LineageGraph lineage={lineageData} />
                  ) : (
                    <ComingSoon
                      data-testid="reports-lineage-soon"
                      description={t('reports.lineageDesc')}
                    />
                  ))}
              </div>
            )}
          </div>
        ))}
      </BentoTile>
    </m.div>
  );
};
