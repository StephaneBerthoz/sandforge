import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { motion } from 'framer-motion';
import type {
  GeneratedReport,
  AnalyticsTimeSeries,
  AuditLogEntry,
  DataLineageGraph,
} from '@sandforge/shared';
import { useBridgeQuery } from '../../hooks/useBridgeQuery';
import { useBridgeMutation } from '../../hooks/useBridgeMutation';
import { Tabs } from '../../components/ui/Tabs';
import { BentoGrid, BentoTile } from '../../components/ui/BentoGrid';
import { KPICard } from '../../components/ui/KPICard';
import { Skeleton } from '../../components/ui/Skeleton';
import { ErrorBanner } from '../../components/ui/ErrorBanner';
import { fadeIn, staggerContainer, slideUp } from '../../motion/presets';
import { ExecutionReportView } from './ExecutionReportView';
import { AnalyticsDashboard } from './AnalyticsDashboard';
import type { AnalyticsSummary } from './AnalyticsDashboard';
import { AuditTrailViewer } from './AuditTrailViewer';
import { LineageGraph } from './LineageGraph';

/** ReportsPage component props. */
export interface ReportsPageProps {
  /** Override reports (used in tests or when data is passed from parent). */
  reports?: GeneratedReport[];
  analyticsSummary?: AnalyticsSummary;
  operationsOverTime?: AnalyticsTimeSeries;
  errorTimeSeries?: AnalyticsTimeSeries;
  auditEntries?: AuditLogEntry[];
  lineageData?: DataLineageGraph;
  onSelectReport?: (id: string) => void;
  onExportReport?: (id: string) => void;
}

/** Main reports and analytics page with tabbed navigation — wired to extension via bridge hooks. */
export const ReportsPage: React.FC<ReportsPageProps> = ({
  reports: reportsProp,
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

  /** Bridge query: load reports list. */
  const reportsQuery = useBridgeQuery<{ reports: GeneratedReport[] }>('reports:list', undefined, {
    responseType: 'reports:list:result',
  });

  /** Bridge mutation: export a report. */
  const exportMutation = useBridgeMutation<{ url: string }>('reports:export', {
    responseType: 'reports:export:result',
  });

  // Suppress unused variable warning for export mutation data
  void exportMutation;

  // Use prop override if provided, otherwise use bridge query data
  const reports = reportsProp ?? reportsQuery.data?.reports;

  /** Show error from bridge hooks (silent — no notification store dependency). */
  useEffect(() => {
    if (reportsQuery.error) {
      // Error is available via reportsQuery.error for consumers
    }
  }, [reportsQuery.error]);

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
    exportMutation.mutate({ reportId: id });
    onExportReport?.(id);
  };

  const reportCount = reports?.length ?? 0;
  const totalOps = analyticsSummary?.totalOperations ?? 0;
  const successRate = analyticsSummary?.successRate ?? 0;
  const auditCount = auditEntries?.length ?? 0;

  return (
    <motion.div
      data-testid="reports-page"
      className="flex flex-col gap-3 p-4"
      variants={fadeIn}
      initial="hidden"
      animate="visible"
    >
      <h1 className="text-lg font-bold text-text-primary">{t('reports.title')}</h1>

      {reportsQuery.error && (
        <ErrorBanner message={reportsQuery.error} data-testid="reports-error" />
      )}

      {reportsQuery.loading && !reportsProp && (
        <div className="flex gap-3" data-testid="reports-loading">
          {Array.from({ length: 4 }, (_, i) => (
            <div key={i} className="flex-1">
              <Skeleton variant="rect" height="88px" />
            </div>
          ))}
        </div>
      )}

      {/* KPI summary row */}
      <motion.div
        variants={staggerContainer}
        initial="hidden"
        animate="visible"
        data-testid="reports-kpi-row"
      >
        <BentoGrid columns={4} gap="md">
          <motion.div variants={slideUp}>
            <KPICard
              icon="file"
              label={t('reports.totalReports')}
              value={reportCount}
              variant="default"
            />
          </motion.div>
          <motion.div variants={slideUp}>
            <KPICard
              icon="pulse"
              label={t('reports.totalOperations')}
              value={totalOps.toLocaleString()}
              variant="default"
            />
          </motion.div>
          <motion.div variants={slideUp}>
            <KPICard
              icon="check"
              label={t('reports.successRate')}
              value={`${successRate.toFixed(1)}%`}
              variant={successRate >= 90 ? 'success' : 'warning'}
            />
          </motion.div>
          <motion.div variants={slideUp}>
            <KPICard
              icon="shield"
              label={t('reports.auditEntries')}
              value={auditCount}
              variant="default"
            />
          </motion.div>
        </BentoGrid>
      </motion.div>

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
    </motion.div>
  );
};
