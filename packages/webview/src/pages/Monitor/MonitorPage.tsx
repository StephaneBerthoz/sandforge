import React, { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { AnimatePresence, m } from 'framer-motion';
import {
  RefreshCw,
  Clock,
  Activity,
  AlertTriangle,
  WifiOff,
  Plug,
  CircleDashed,
  ExternalLink,
} from 'lucide-react';
import { useOrgStore, selectSelectedOrg } from '../../stores/useOrgStore';
import { sendBridgeMessage } from '../../bridge/sendBridgeMessage';
import { useAppStore } from '../../stores/useAppStore';
import { EmptyState } from '../../components/ui/EmptyState';
import { useAnomalyScan } from '../../hooks/useAIFeatures';
import { cn } from '../../theme';
import { ORG_TYPE_STYLES } from '../../theme/orgStyles';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Skeleton } from '../../components/ui/Skeleton';
import { SkeletonTable } from '../../components/ui/SkeletonTable';
import { SkeletonPanel } from '../../components/ui/SkeletonPanel';
import { AlertsPanel } from './AlertsPanel';
import { PredictionsTile } from './PredictionsTile';
import { useMonitorPageData } from './useMonitorPageData';
import { LiveOperationsPanel } from './LiveOperationsPanel';
import { StorageBreakdownPanel } from './StorageBreakdownPanel';
import { DeploymentTimeline } from './DeploymentTimeline';
import { ApiUsagePanel } from './ApiUsagePanel';
import { ErrorLogsPanel } from './ErrorLogsPanel';
import { SessionsPanel } from './SessionsPanel';
import { ApexInsightsPanel } from './ApexInsightsPanel';
import { RefreshPanel } from './RefreshPanel';
import { HealthCheckPanel } from './HealthCheckPanel';
import { AlertHistoryPanel } from './AlertHistoryPanel';
import { GovernancePanelConnected } from './GovernancePanel';
import { ResetCountdown } from './ResetCountdown';
import { SectionHeader } from './SectionHeader';
import { MonitorKpiRow } from './MonitorKpiRow';
import { MonitorOrgInfoBar } from './MonitorOrgInfoBar';
import { MonitorTrendsJobsRow } from './MonitorTrendsJobsRow';
import { MonitorLimitsSection } from './MonitorLimitsSection';
import { useBridgeQuery } from '../../hooks/useBridgeQuery';
import type { SalesforceOrg, LiveOperationSnapshot } from '@sandforge/shared';

/* Re-export so existing importers (`JobsTable`, `useMonitorPageData`) keep working. */
export type { JobDisplayInfo } from './monitorUtils';

/** Org card for the empty state — click to select. */
const OrgSelectCard: React.FC<{ org: SalesforceOrg; onSelect: (id: string) => void }> = ({
  org,
  onSelect,
}) => (
  <button
    className={cn(
      'flex items-center gap-3 rounded-lg border border-subtle bg-surface-1 px-4 py-3',
      'hover:bg-surface-2 hover:border-active transition-all text-left w-full',
    )}
    onClick={() => onSelect(org.id)}
    data-testid={`empty-org-${org.id}`}
  >
    <span
      className={cn(
        'h-2 w-2 rounded-full shrink-0',
        org.status === 'connected' ? 'bg-green-500' : 'bg-gray-500',
      )}
    />
    <div className="flex-1 min-w-0">
      <div className="text-sm font-medium text-text-primary truncate">
        {org.alias || org.username}
      </div>
      <div className="text-xs text-text-muted truncate">{org.instanceUrl}</div>
    </div>
    <span
      className={cn(
        'text-[9px] font-bold px-1.5 py-0.5 rounded border shrink-0',
        ORG_TYPE_STYLES[org.orgType] ?? 'bg-gray-500/20 text-gray-400 border-gray-500/30',
      )}
    >
      {org.orgType === 'Production' ? 'PROD' : org.orgType.toUpperCase()}
    </span>
  </button>
);

/** Main monitoring dashboard page. */
export const MonitorPage: React.FC = () => {
  const { t } = useTranslation();
  const orgs = useOrgStore((s) => s.orgs);
  const selectedOrgId = useOrgStore((s) => s.selectedOrgId);
  // Selection propagates: local store for this panel + `org:select` through
  // the broker so the extension updates the status bar and broadcasts
  // `org:selected` to the sidebar and every other panel.
  const selectOrgLocal = useOrgStore((s) => s.selectOrg);
  const selectOrg = useCallback(
    (id: string | null) => {
      selectOrgLocal(id);
      if (id) sendBridgeMessage('org:select', { orgId: id });
    },
    [selectOrgLocal],
  );
  // Reactive selector — subscribing to the `selectedOrg` *method* would return
  // a stable function reference and never notify on org changes.
  const currentOrg = useOrgStore(selectSelectedOrg);

  const anomalyScan = useAnomalyScan();

  const {
    loading,
    error,
    jobs,
    healthScore,
    healthReport,
    trends,
    jobInsights,
    orgInfo,
    lastUpdated,
    lastUpdatedStr,
    activeAlertsCount,
    apiLimit,
    storageLimit,
    fileStorageLimit,
    sortedLimits,
    criticalLimits,
    trendChartData,
    trendSeries,
    predictions,
    isRefreshing,
    isStale,
    minutesSinceUpdate,
    consecutiveFailures,
    connectionLost,
    sectionErrors,
    showErrorDetails,
    toggleErrorDetails,
    retryFailed,
    autoRefresh,
    setAutoRefresh,
    handleRefresh,
    openApexJobs,
    openingApexJobs,
    openApexJobsError,
    orgHealthStatus,
  } = useMonitorPageData();

  /**
   * The insights the band shows, split by what they may do. Filtered here
   * rather than in the producer: the extension reports what it found at the
   * severity it found it at, and the page decides what a user is interrupted
   * for. Critical takes red, warning takes amber, info is not banded.
   */
  const criticalInsights = (jobInsights ?? []).filter((insight) => insight.severity === 'critical');
  const warningInsights = (jobInsights ?? []).filter((insight) => insight.severity === 'warning');

  // Live operations tracking
  const liveOpsQuery = useBridgeQuery<{ operations: LiveOperationSnapshot[] }>(
    'monitor:live-operations',
    undefined,
    { responseType: 'monitor:live-operations:response', skip: !selectedOrgId },
  );
  const liveOperations = liveOpsQuery.data?.operations ?? [];

  const navigate = useAppStore((s) => s.navigate);
  const connectedOrgs = orgs.filter((o) => o.status === 'connected');

  // ─── Empty state ───────────────────────────────────────────────────────
  if (orgs.length === 0) {
    return (
      <EmptyState
        module="monitor"
        title={t('monitor.emptyState.title')}
        description={t('monitor.emptyState.description')}
        steps={[
          t('emptyState.connectViaSfdx'),
          t('monitor.emptyState.step2'),
          t('monitor.emptyState.step3'),
          t('monitor.emptyState.step4'),
        ]}
        actionLabel={t('emptyState.connectOrg')}
        onAction={() => navigate('orgs')}
      />
    );
  }

  if (!selectedOrgId) {
    return (
      <div
        className="flex flex-col items-center justify-center h-full px-6"
        data-testid="monitor-empty"
      >
        <div className="max-w-md w-full flex flex-col items-center gap-6">
          <div className="w-16 h-16 rounded-2xl bg-surface-1 border border-subtle flex items-center justify-center">
            <Activity className="w-8 h-8 text-text-muted" />
          </div>
          <div className="text-center">
            <h2 className="text-lg font-semibold text-text-primary mb-1">
              {t('monitor.selectOrg', 'Select an org to monitor')}
            </h2>
            <p className="text-sm text-text-secondary">
              {t(
                'monitor.selectOrgDesc',
                'Choose a connected org to see its live health, limits and jobs.',
              )}
            </p>
          </div>
          {connectedOrgs.length > 0 ? (
            <div className="w-full flex flex-col gap-2">
              {connectedOrgs.map((org) => (
                <OrgSelectCard key={org.id} org={org} onSelect={selectOrg} />
              ))}
            </div>
          ) : (
            <div className="flex items-center gap-2 text-sm text-text-muted">
              <Plug className="w-4 h-4" />
              <span>
                {t('monitor.noOrgsHint', 'No connected orgs. Go to Organizations to connect one.')}
              </span>
            </div>
          )}
        </div>
      </div>
    );
  }

  // ─── Loading skeleton ──────────────────────────────────────────────────
  if (loading && !lastUpdated) {
    return (
      <div className="flex flex-col gap-4 p-6 w-full" data-testid="monitor-loading">
        <Skeleton variant="text" width="30%" height="1.5em" />
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
          {Array.from({ length: 5 }, (_, i) => (
            <Skeleton key={i} variant="rect" height="110px" />
          ))}
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <SkeletonPanel sections={2} />
          <SkeletonTable rows={4} columns={3} />
        </div>
        <SkeletonPanel sections={1} />
      </div>
    );
  }

  // ─── Dashboard ─────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col gap-4 p-6 w-full" data-testid="monitor-page">
      {/* ── Header ── */}
      <div className="flex items-center gap-3 flex-wrap">
        {/* Org identity */}
        <div className="flex items-center gap-2 flex-1 min-w-[8rem]">
          {currentOrg && (
            <>
              <span className="h-2.5 w-2.5 rounded-full bg-green-500 shrink-0 animate-pulse" />
              {/* The org under observation is what this dashboard is about, so it carries the page's only h1. */}
              <h1 className="text-base font-semibold text-text-primary truncate">
                {currentOrg.alias || currentOrg.username}
              </h1>
              <span
                className={cn(
                  'text-[9px] font-bold px-1.5 py-0.5 rounded border shrink-0',
                  ORG_TYPE_STYLES[currentOrg.orgType] ?? '',
                )}
              >
                {currentOrg.orgType === 'Production' ? 'PROD' : currentOrg.orgType.toUpperCase()}
              </span>
            </>
          )}
          {orgInfo && (
            <span className="text-xs text-text-muted hidden sm:inline">
              {orgInfo.edition} &middot; {orgInfo.instanceName} &middot; API v{orgInfo.apiVersion}
            </span>
          )}
        </div>

        {/* Actions */}
        <div className="flex items-center gap-2 shrink-0">
          <ResetCountdown />
          {lastUpdatedStr && <span className="text-xs text-text-muted">{lastUpdatedStr}</span>}
          <Button
            variant="ghost"
            size="sm"
            onClick={handleRefresh}
            disabled={loading}
            aria-label={t('monitor.refresh')}
            data-testid="refresh-btn"
          >
            <RefreshCw className={cn('w-3.5 h-3.5', loading && 'animate-spin')} />
          </Button>
          <Button
            variant={autoRefresh ? 'primary' : 'ghost'}
            size="sm"
            onClick={() => setAutoRefresh(!autoRefresh)}
            aria-label={t('monitor.autoRefresh')}
            aria-pressed={autoRefresh}
            data-testid="auto-refresh-toggle"
          >
            <Clock className="w-3.5 h-3.5" />
          </Button>
        </div>
      </div>

      {/* ── Connection lost warning ── */}
      {connectionLost && (
        <div
          className="flex items-center gap-2 p-3 bg-amber-500/10 border border-amber-500/20 rounded-md"
          data-testid="connection-lost-warning"
        >
          <WifiOff className="h-4 w-4 text-amber-400 shrink-0" />
          <span className="flex-1 text-sm text-amber-300">
            {t('monitor.connectionLost', {
              defaultValue: 'Connection lost. Auto-refresh failed {{count}} times.',
              count: consecutiveFailures,
            })}
          </span>
          <Button size="sm" variant="secondary" onClick={handleRefresh}>
            {t('monitor.tryReconnect', 'Try Reconnect')}
          </Button>
        </div>
      )}

      {/* ── Error retry banner ── */}
      {error && !connectionLost && (
        <div
          className="flex items-center gap-2 p-3 bg-red-500/10 border border-red-500/20 rounded-md"
          data-testid="monitor-error"
        >
          <AlertTriangle className="h-4 w-4 text-red-400 shrink-0" />
          <span className="flex-1 text-sm text-red-400">
            {t('monitor.refreshFailed', 'Failed to refresh dashboard data')}
          </span>
          <Button size="sm" variant="secondary" onClick={retryFailed} data-testid="error-retry-btn">
            {t('monitor.retry', 'Retry')}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={toggleErrorDetails}
            data-testid="error-details-btn"
          >
            {t('monitor.details', 'Details')}
          </Button>
        </div>
      )}

      {/* ── Error details (expandable) ── */}
      {showErrorDetails && Object.keys(sectionErrors).length > 0 && (
        <div
          className="rounded-md border border-red-500/10 bg-surface-1 p-3 text-xs text-red-400"
          data-testid="error-details-panel"
        >
          {Object.entries(sectionErrors).map(([section, msg]) => (
            <div key={section} className="flex gap-2">
              <span className="font-medium text-text-secondary">{section}:</span>
              <span>{msg}</span>
            </div>
          ))}
        </div>
      )}

      {/* ── Stale data indicator ── */}
      {isStale && !error && (
        <div className="flex items-center gap-2" data-testid="stale-data-indicator">
          <span
            className="cursor-pointer"
            onClick={handleRefresh}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') handleRefresh();
            }}
            data-testid="stale-data-badge"
          >
            <Badge variant="warning">
              {t('monitor.staleData', 'Data is {{minutes}}m old').replace(
                '{{minutes}}',
                String(minutesSinceUpdate),
              )}
              {' — '}
              {t('monitor.refreshNow', 'Refresh now')}
            </Badge>
          </span>
        </div>
      )}

      {/* ── Job Insights ──

          The band reads `jobInsights`, which MonitorOpsHandler computes from
          the AsyncApexJob window it already fetched, plus what its earlier
          refreshes saw of the same jobs. No extra org call.

          An empty band is the one thing this surface must never render: no
          rows reads as "no problem", and that reassurance has to be earned.
          So the page states which situation it is in:
          - no verdict received (no payload yet, a failed first refresh, or a
            payload without the field): nothing is known, and it says so;
          - something to report: critical rows in red, warnings in amber;
          - nothing ran;
          - nothing wrong across N jobs, with its denominator printed.

          A warning never borrows the red, and never gets an action. Only a
          critical `stuck` row, a stall the extension proved from a batch
          counter that stood still under observation, carries one: a link to
          the org's Setup > Apex Jobs page, where the job can be aborted.
          SandForge aborts nothing itself (AsyncApexJob is not updateable), so
          the link asks for no confirmation, and a failed open shows as an
          error. The stall detection never names a scheduled job, which that
          page does not abort. ── */}
      {jobInsights === null ? (
        <div
          data-testid="monitor-job-insights-unknown"
          className="flex items-center gap-3 rounded-lg border border-dashed border-subtle bg-surface-1 px-4 py-2"
        >
          <CircleDashed className="w-4 h-4 text-text-muted shrink-0" />
          <span className="text-sm text-text-secondary">{t('common.noData')}</span>
        </div>
      ) : criticalInsights.length > 0 || warningInsights.length > 0 ? (
        <div className="flex flex-col gap-2" data-testid="monitor-job-insights">
          {criticalInsights.map((insight, idx) => (
            <div
              key={`critical-${insight.type}-${idx}`}
              data-testid="monitor-job-insight-critical"
              className="flex items-center gap-3 rounded-lg border border-red-500/30 bg-red-500/5 px-4 py-2"
            >
              <AlertTriangle className="w-4 h-4 text-red-400 shrink-0" />
              <div className="flex-1 min-w-0">
                <span className="text-sm font-medium text-text-primary">{insight.title}</span>
                <span className="text-xs text-text-secondary ml-2">{insight.detail}</span>
              </div>
              {insight.type === 'stuck' && insight.affectedJobs.length > 0 && (
                <Button
                  variant="ghost"
                  size="sm"
                  icon={<ExternalLink className="w-3.5 h-3.5" />}
                  loading={openingApexJobs}
                  onClick={openApexJobs}
                >
                  {t('monitor.openApexJobs')}
                </Button>
              )}
            </div>
          ))}
          {openApexJobsError !== null && (
            <p
              role="alert"
              data-testid="monitor-open-apex-jobs-error"
              className="rounded-lg border border-red-500/30 bg-red-500/5 px-4 py-2 text-xs text-red-400"
            >
              {openApexJobsError}
            </p>
          )}
          {warningInsights.map((insight, idx) => (
            <div
              key={`warning-${insight.type}-${idx}`}
              data-testid="monitor-job-insight-warning"
              className="flex items-center gap-3 rounded-lg border border-amber-500/30 bg-amber-500/5 px-4 py-2"
            >
              <Clock className="w-4 h-4 text-amber-400 shrink-0" />
              <div className="flex-1 min-w-0">
                <span className="text-sm font-medium text-text-primary">{insight.title}</span>
                <span className="text-xs text-text-secondary ml-2">{insight.detail}</span>
              </div>
            </div>
          ))}
        </div>
      ) : jobs.length === 0 ? (
        <div
          data-testid="monitor-job-insights-idle"
          className="flex items-center gap-3 rounded-lg border border-subtle bg-surface-1 px-4 py-2"
        >
          <Clock className="w-4 h-4 text-text-muted shrink-0" />
          <span className="text-sm text-text-secondary">
            {t('monitor.noJobs', 'No recent jobs')}
          </span>
        </div>
      ) : (
        <div
          data-testid="monitor-job-insights-clear"
          className="flex items-center gap-3 rounded-lg border border-subtle bg-surface-1 px-4 py-2"
        >
          <Activity className="w-4 h-4 text-green-400 shrink-0" />
          <span className="text-sm text-text-primary">{t('monitor.apexInsights.noIssues')}</span>
          <span className="text-xs text-text-secondary">
            {jobs.length} {t('monitor.jobs')}
          </span>
        </div>
      )}

      <AnimatePresence mode="wait">
        <m.div
          key="dashboard"
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3 }}
          className="flex flex-col gap-4 min-w-0"
        >
          {/* ── KPI Row ── */}
          <MonitorKpiRow
            healthScore={healthScore}
            healthReport={healthReport}
            apiLimit={apiLimit}
            storageLimit={storageLimit}
            fileStorageLimit={fileStorageLimit}
            trends={trends}
            activeAlertsCount={activeAlertsCount}
            isRefreshing={isRefreshing}
          />

          {/* ── Live Operations ── */}
          {liveOperations.length > 0 && (
            <div
              className="rounded-lg border border-blue-500/20 bg-surface-1 p-4"
              data-testid="live-ops-section"
            >
              {/*
                Fire-and-forget on purpose: AutomationHandler acknowledges
                cancel/pause/resume with a `notification`, never an
                `operation:*:response`. Sending these through a request/response
                hook armed a 30 s timer per click that could only ever expire,
                on a channel the shared protocol does not declare.
              */}
              <LiveOperationsPanel
                operations={liveOperations}
                onCancel={(opId) => sendBridgeMessage('operation:cancel', { operationId: opId })}
                onPause={(opId) => sendBridgeMessage('operation:pause', { operationId: opId })}
                onResume={(opId) => sendBridgeMessage('operation:resume', { operationId: opId })}
              />
            </div>
          )}

          {/* ── Org Info Panel (compact, right after KPIs) ── */}
          {orgInfo && <MonitorOrgInfoBar orgInfo={orgInfo} />}

          {/* ── Storage Breakdown ── */}
          <StorageBreakdownPanel />

          {/* ── Two-column: Trends + Jobs ── */}
          <MonitorTrendsJobsRow
            sortedLimits={sortedLimits}
            trends={trends}
            trendChartData={trendChartData}
            trendSeries={trendSeries}
            jobs={jobs}
            isRefreshing={isRefreshing}
          />

          {/* ── Governor Limits ── */}
          <MonitorLimitsSection
            sortedLimits={sortedLimits}
            criticalLimits={criticalLimits}
            isRefreshing={isRefreshing}
            anomalyScan={anomalyScan}
          />

          {/* ── API Usage Breakdown ── */}
          <ApiUsagePanel />

          {/* ── Deployment Timeline ── */}
          <DeploymentTimeline />

          {/* ── Service Panels (WIRE-01..05) ── */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <ErrorLogsPanel />
            <SessionsPanel />
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <ApexInsightsPanel />
            <RefreshPanel />
          </div>
          <HealthCheckPanel orgHealthStatus={orgHealthStatus} />

          {/* ── Anomaly results (if any) ── */}
          {anomalyScan.data?.success &&
            anomalyScan.data.anomalies &&
            anomalyScan.data.anomalies.length > 0 && (
              <div
                className="rounded-lg border border-amber-500/30 bg-surface-1 p-4"
                data-testid="anomaly-scan-results"
              >
                <SectionHeader
                  title={t('monitor.anomaliesFound', 'Anomalies Found')}
                  count={anomalyScan.data.anomalies.length}
                />
                <div className="flex flex-col gap-2">
                  {anomalyScan.data.anomalies.map((anomaly, idx) => (
                    <div
                      key={`${anomaly.field}-${idx}`}
                      className="flex items-start gap-2 p-2 rounded bg-surface-2"
                    >
                      <Badge
                        variant={
                          anomaly.severity === 'high'
                            ? 'error'
                            : anomaly.severity === 'medium'
                              ? 'warning'
                              : 'info'
                        }
                      >
                        {anomaly.severity}
                      </Badge>
                      <div className="flex-1 min-w-0">
                        <span className="text-xs font-semibold text-text-primary">
                          {anomaly.field}
                        </span>
                        <span className="text-xs text-text-muted ml-1">({anomaly.type})</span>
                        <p className="text-xs text-text-secondary mt-0.5">{anomaly.description}</p>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

          {/* ── Bottom row: Predictions + Alerts ── */}
          {(predictions.length > 0 || activeAlertsCount > 0) && (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <div className="rounded-lg border border-subtle bg-surface-1 p-4">
                <PredictionsTile predictions={predictions} />
              </div>
              <div className="rounded-lg border border-subtle bg-surface-1 p-4">
                <AlertsPanel />
              </div>
            </div>
          )}

          {/* ── Alert History ── */}
          <div className="rounded-lg border border-subtle bg-surface-1 p-4">
            <AlertHistoryPanel />
          </div>

          {/* ── Governance ── */}
          <div className="rounded-lg border border-subtle bg-surface-1 p-4">
            <GovernancePanelConnected />
          </div>
        </m.div>
      </AnimatePresence>
    </div>
  );
};
