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

  return (
    <m.div
      data-testid="reports-page"
      className="flex flex-col gap-3 p-4"
      variants={fadeIn}
      initial="hidden"
      animate="visible"
    >
      <h1 className="text-lg font-bold text-text-primary">{t('reports.title')}</h1>

      {/* KPI summary row */}
      <m.div
        variants={staggerContainer}
        initial="hidden"
        animate="visible"
        data-testid="reports-kpi-row"
      >
        <BentoGrid columns={4} gap="md">
          <m.div variants={slideUp}>
            <KPICard
              icon="file"
              label={t('reports.totalReports')}
              value={reportCount}
              variant="default"
            />
          </m.div>
          <m.div variants={slideUp}>
            <KPICard
              icon="pulse"
              label={t('reports.totalOperations')}
              value={totalOps.toLocaleString()}
              variant="default"
            />
          </m.div>
          <m.div variants={slideUp}>
            <KPICard
              icon="check"
              label={t('reports.successRate')}
              value={`${successRate.toFixed(1)}%`}
              variant={successRate >= 90 ? 'success' : 'warning'}
            />
          </m.div>
          <m.div variants={slideUp}>
            <KPICard
              icon="shield"
              label={t('reports.auditEntries')}
              value={auditCount}
              variant="default"
            />
          </m.div>
        </BentoGrid>
      </m.div>

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
                {tab.id === 'executions' && (
                  <ExecutionReportView
                    reports={reports}
                    selectedReportId={selectedReportId}
                    onSelectReport={handleSelectReport}
                    onExport={handleExportReport}
                  />
                )}
                {tab.id === 'analytics' && (
                  <AnalyticsDashboard
                    summary={analyticsSummary}
                    operationsOverTime={operationsOverTime}
                    errorTimeSeries={errorTimeSeries}
                  />
                )}
                {tab.id === 'audit' && <AuditTrailViewer entries={auditEntries} />}
                {tab.id === 'lineage' && <LineageGraph lineage={lineageData} />}
              </div>
            )}
          </div>
        ))}
      </BentoTile>
    </m.div>
  );
};
