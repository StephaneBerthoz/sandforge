import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AnimatePresence, motion } from 'framer-motion';
import {
  RefreshCw, Clock, Activity, Database, Bell, AlertTriangle,
  Zap, ChevronDown, ChevronRight, Search, Plug,
  Server, WifiOff,
} from 'lucide-react';
import { useOrgStore } from '../../stores/useOrgStore';
import { useAppStore } from '../../stores/useAppStore';
import { EmptyState } from '../../components/ui/EmptyState';
import { useAnomalyScan } from '../../hooks/useAIFeatures';
import { cn } from '../../theme';
import { ORG_TYPE_STYLES } from '../../theme/orgStyles';
import { Badge } from '../../components/ui/Badge';
import type { BadgeVariant } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { ProgressBar } from '../../components/ui/ProgressBar';
import { Skeleton } from '../../components/ui/Skeleton';
import { Spinner } from '../../components/ui/Spinner';
import { HealthScoreCard } from './HealthScoreCard';
import { HealthGauge } from './HealthGauge';
import { TrendChart } from './TrendChart';
import { TrendCharts } from './TrendCharts';
import { JobsTable } from './JobsTable';
import { AlertsPanel } from './AlertsPanel';
import { PredictionsTile } from './PredictionsTile';
import { useMonitorPageData } from './useMonitorPageData';
import { LiveOperationsPanel } from './LiveOperationsPanel';
import { StorageBreakdownPanel } from './StorageBreakdownPanel';
import { DeploymentTimeline } from './DeploymentTimeline';
import { LimitExportButton } from './LimitExportButton';
import { ApiUsagePanel } from './ApiUsagePanel';
import { ErrorLogsPanel } from './ErrorLogsPanel';
import { SessionsPanel } from './SessionsPanel';
import { ApexInsightsPanel } from './ApexInsightsPanel';
import { RefreshPanel } from './RefreshPanel';
import { HealthCheckPanel } from './HealthCheckPanel';
import { useBridgeQuery } from '../../hooks/useBridgeQuery';
import { useBridgeMutation } from '../../hooks/useBridgeMutation';
import type { SalesforceOrg, LiveOperationSnapshot } from '@sandforge/shared';
import { formatNumber } from '../../utils/formatters';

/** Job info for display in the jobs DataTable. */
export interface JobDisplayInfo {
  id: string;
  jobType: string;
  status: string;
  objectType?: string;
  createdBy: string;
  createdDate: string;
  totalRecords?: number;
  processedRecords?: number;
  failedRecords?: number;
}

/** Returns progress bar variant based on usage. */
function usageVariant(pct: number): 'default' | 'warning' | 'error' {
  if (pct > 80) return 'error';
  if (pct >= 60) return 'warning';
  return 'default';
}

/** Returns badge variant based on usage. */
function usageBadge(pct: number): BadgeVariant {
  if (pct > 80) return 'error';
  if (pct >= 60) return 'warning';
  return 'success';
}

/** Formats MB as GB with one decimal. */
function fmtGB(mb: number): string {
  return (mb / 1024).toFixed(1);
}

/** Org card for the empty state — click to select. */
const OrgSelectCard: React.FC<{ org: SalesforceOrg; onSelect: (id: string) => void }> = ({ org, onSelect }) => (
  <button
    className={cn(
      'flex items-center gap-3 rounded-lg border border-subtle bg-surface-1 px-4 py-3',
      'hover:bg-surface-2 hover:border-active transition-all text-left w-full',
    )}
    onClick={() => onSelect(org.id)}
    data-testid={`empty-org-${org.id}`}
  >
    <span className={cn('h-2 w-2 rounded-full shrink-0', org.status === 'connected' ? 'bg-green-500' : 'bg-gray-500')} />
    <div className="flex-1 min-w-0">
      <div className="text-sm font-medium text-text-primary truncate">{org.alias || org.username}</div>
      <div className="text-xs text-text-muted truncate">{org.instanceUrl}</div>
    </div>
    <span className={cn('text-[9px] font-bold px-1.5 py-0.5 rounded border shrink-0', ORG_TYPE_STYLES[org.orgType] ?? 'bg-gray-500/20 text-gray-400 border-gray-500/30')}>
      {org.orgType === 'Production' ? 'PROD' : org.orgType.toUpperCase()}
    </span>
  </button>
);

/** Compact KPI stat tile. */
const KPIStat: React.FC<{
  icon: React.ReactNode;
  label: string;
  value: string;
  sub?: string;
  pct?: number;
  variant?: 'default' | 'warning' | 'error';
  spark?: number[];
  warning?: string;
}> = ({ icon, label, value, sub, pct, variant = 'default', warning }) => (
  <div
    className={cn(
      'rounded-lg border bg-surface-1 p-4 flex flex-col gap-2',
      variant === 'error' ? 'border-red-500/30' : variant === 'warning' ? 'border-amber-500/30' : 'border-subtle',
    )}
  >
    <div className="flex items-center gap-2 text-text-secondary">
      {icon}
      <span className="text-xs font-medium">{label}</span>
    </div>
    <div className="flex items-baseline gap-1.5">
      <span className="text-2xl font-bold tabular-nums text-text-primary">{value}</span>
      {sub && <span className="text-xs text-text-muted">{sub}</span>}
    </div>
    {pct !== undefined && (
      <ProgressBar value={pct} variant={usageVariant(pct)} size="sm" />
    )}
    {warning && (
      <div className="flex items-center gap-1 text-[10px] text-amber-400">
        <AlertTriangle className="w-3 h-3" />
        <span>{warning}</span>
      </div>
    )}
  </div>
);

/** Section header with optional collapse toggle. */
const SectionHeader: React.FC<{
  title: string;
  count?: number;
  collapsed?: boolean;
  onToggle?: () => void;
  actions?: React.ReactNode;
}> = ({ title, count, collapsed, onToggle, actions }) => (
  <div className="flex items-center gap-2 mb-3">
    {onToggle && (
      <button className="text-text-muted hover:text-text-secondary" onClick={onToggle}>
        {collapsed ? <ChevronRight className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
      </button>
    )}
    <h3 className="text-sm font-semibold text-text-primary flex-1">{title}</h3>
    {count !== undefined && (
      <Badge variant="default">{count}</Badge>
    )}
    {actions}
  </div>
);

/** Semi-transparent overlay shown on each panel during refresh. */
function PanelOverlay({ isRefreshing, children }: { isRefreshing: boolean; children: React.ReactNode }) {
  return (
    <div className="relative">
      {children}
      {isRefreshing && (
        <div
          className="absolute inset-0 bg-background/50 flex items-center justify-center z-10 rounded-lg"
          data-testid="panel-overlay"
        >
          <Spinner size="sm" />
        </div>
      )}
    </div>
  );
}

/** Main monitoring dashboard page. */
export const MonitorPage: React.FC = () => {
  const { t } = useTranslation();
  const orgs = useOrgStore((s) => s.orgs);
  const selectedOrgId = useOrgStore((s) => s.selectedOrgId);
  const selectOrg = useOrgStore((s) => s.selectOrg);
  const selectedOrg = useOrgStore((s) => s.selectedOrg);

  const [limitsExpanded, setLimitsExpanded] = useState(false);

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
    handleAbortJob,
    orgHealthStatus,
  } = useMonitorPageData();

  // Live operations tracking
  const liveOpsQuery = useBridgeQuery<{ operations: LiveOperationSnapshot[] }>(
    'monitor:live-operations',
    undefined,
    { responseType: 'monitor:live-operations:response', skip: !selectedOrgId },
  );
  const cancelOp = useBridgeMutation<{ success: boolean }>('operation:cancel', { responseType: 'operation:cancel:response' });
  const pauseOp = useBridgeMutation<{ success: boolean }>('operation:pause', { responseType: 'operation:pause:response' });
  const resumeOp = useBridgeMutation<{ success: boolean }>('operation:resume', { responseType: 'operation:resume:response' });
  const liveOperations = liveOpsQuery.data?.operations ?? [];

  const navigate = useAppStore((s) => s.navigate);
  const currentOrg = selectedOrg();
  const connectedOrgs = orgs.filter((o) => o.status === 'connected');

  // ─── Empty state ───────────────────────────────────────────────────────
  if (orgs.length === 0) {
    return (
      <EmptyState
        module="monitor"
        title={t('monitor.emptyState.title')}
        description={t('monitor.emptyState.description')}
        actionLabel={t('monitor.emptyState.cta')}
        onAction={() => navigate('orgs')}
      />
    );
  }

  if (!selectedOrgId) {
    return (
      <div className="flex flex-col items-center justify-center h-full px-6" data-testid="monitor-empty">
        <div className="max-w-md w-full flex flex-col items-center gap-6">
          <div className="w-16 h-16 rounded-2xl bg-surface-1 border border-subtle flex items-center justify-center">
            <Activity className="w-8 h-8 text-text-muted" />
          </div>
          <div className="text-center">
            <h2 className="text-lg font-semibold text-text-primary mb-1">
              {t('monitor.selectOrg', 'Select an org to monitor')}
            </h2>
            <p className="text-sm text-text-secondary">
              {t('monitor.selectOrgDesc', 'Choose a connected org to view real-time health, limits and jobs.')}
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
              <span>{t('monitor.noOrgsHint', 'No connected orgs. Go to Organizations to connect one.')}</span>
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
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          {Array.from({ length: 4 }, (_, i) => <Skeleton key={i} variant="rect" height="110px" />)}
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <Skeleton variant="rect" height="200px" />
          <Skeleton variant="rect" height="200px" />
        </div>
        <Skeleton variant="rect" height="160px" />
      </div>
    );
  }

  // ─── Dashboard ─────────────────────────────────────────────────────────
  const apiUsed = apiLimit.max - apiLimit.remaining;
  const storageUsedMB = storageLimit.max - storageLimit.remaining;

  return (
    <div className="flex flex-col gap-4 p-6 w-full" data-testid="monitor-page">

      {/* ── Header ── */}
      <div className="flex items-center gap-3 flex-wrap">
        {/* Org identity */}
        <div className="flex items-center gap-2 flex-1 min-w-0">
          {currentOrg && (
            <>
              <span className="h-2.5 w-2.5 rounded-full bg-green-500 shrink-0 animate-pulse" />
              <span className="text-base font-semibold text-text-primary truncate">
                {currentOrg.alias || currentOrg.username}
              </span>
              <span className={cn('text-[9px] font-bold px-1.5 py-0.5 rounded border shrink-0', ORG_TYPE_STYLES[currentOrg.orgType] ?? '')}>
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
          {lastUpdatedStr && (
            <span className="text-xs text-text-muted">
              {lastUpdatedStr}
            </span>
          )}
          <Button
            variant="ghost"
            size="sm"
            onClick={handleRefresh}
            disabled={loading}
            data-testid="refresh-btn"
          >
            <RefreshCw className={cn('w-3.5 h-3.5', loading && 'animate-spin')} />
          </Button>
          <Button
            variant={autoRefresh ? 'primary' : 'ghost'}
            size="sm"
            onClick={() => setAutoRefresh(!autoRefresh)}
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
            {t('monitor.connectionLost', 'Connection lost. Auto-refresh failed {{count}} times.').replace('{{count}}', String(consecutiveFailures))}
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
          <span className="flex-1 text-sm text-red-400">{t('monitor.refreshFailed', 'Failed to refresh dashboard data')}</span>
          <Button size="sm" variant="secondary" onClick={retryFailed} data-testid="error-retry-btn">
            {t('monitor.retry', 'Retry')}
          </Button>
          <Button size="sm" variant="ghost" onClick={toggleErrorDetails} data-testid="error-details-btn">
            {t('monitor.details', 'Details')}
          </Button>
        </div>
      )}

      {/* ── Error details (expandable) ── */}
      {showErrorDetails && Object.keys(sectionErrors).length > 0 && (
        <div className="rounded-md border border-red-500/10 bg-surface-1 p-3 text-xs text-red-400" data-testid="error-details-panel">
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
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') handleRefresh(); }}
            data-testid="stale-data-badge"
          >
            <Badge variant="warning">
              {t('monitor.staleData', 'Data is {{minutes}}m old').replace('{{minutes}}', String(minutesSinceUpdate))}
              {' \u2014 '}
              {t('monitor.refreshNow', 'Refresh now')}
            </Badge>
          </span>
        </div>
      )}

      {/* ── Job Insights (critical alerts at top) ── */}
      {jobInsights.filter((i) => i.severity === 'critical').length > 0 && (
        <div className="flex flex-col gap-2">
          {jobInsights.filter((i) => i.severity === 'critical').map((insight, idx) => (
            <div
              key={`${insight.type}-${idx}`}
              className="flex items-center gap-3 rounded-lg border border-red-500/30 bg-red-500/5 px-4 py-2"
            >
              <AlertTriangle className="w-4 h-4 text-red-400 shrink-0" />
              <div className="flex-1 min-w-0">
                <span className="text-sm font-medium text-text-primary">{insight.title}</span>
                <span className="text-xs text-text-secondary ml-2">{insight.detail}</span>
              </div>
              {insight.type === 'stuck' && insight.affectedJobs.length > 0 && (
                <Button variant="ghost" size="sm" onClick={() => handleAbortJob(insight.affectedJobs[0])}>
                  {t('monitor.abortJob', 'Abort')}
                </Button>
              )}
            </div>
          ))}
        </div>
      )}

      <AnimatePresence mode="wait">
        <motion.div
          key="dashboard"
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3 }}
          className="flex flex-col gap-4"
        >

          {/* ── KPI Row ── */}
          <PanelOverlay isRefreshing={isRefreshing}>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3" data-testid="kpi-row">
            {/* Health */}
            <div className="rounded-lg border border-subtle bg-surface-1 p-4 flex flex-col items-center justify-center gap-1">
              {healthReport ? (
                <HealthScoreCard report={healthReport} />
              ) : (
                <>
                  <HealthGauge value={healthScore} size={100} />
                  <span className="text-xs text-text-secondary">{t('monitor.health', 'Health Score')}</span>
                </>
              )}
            </div>

            {/* API Calls */}
            <KPIStat
              icon={<Zap className="w-4 h-4" />}
              label={t('monitor.apiCalls', 'API Calls Today')}
              value={formatNumber(apiUsed)}
              sub={`/ ${formatNumber(apiLimit.max)}`}
              pct={apiLimit.usedPercent}
              variant={usageVariant(apiLimit.usedPercent)}
              warning={
                trends['DailyApiRequests']?.predictedTimeToLimit
                  ? t('monitor.limitReachedIn', 'Limit reached in ~{{hours}}h').replace('{{hours}}', String(Math.round(trends['DailyApiRequests'].predictedTimeToLimit)))
                  : undefined
              }
            />

            {/* Storage */}
            <KPIStat
              icon={<Database className="w-4 h-4" />}
              label={t('monitor.dataStorage', 'Data Storage')}
              value={`${fmtGB(storageUsedMB)} GB`}
              sub={`/ ${fmtGB(storageLimit.max)} GB`}
              pct={storageLimit.usedPercent}
              variant={usageVariant(storageLimit.usedPercent)}
              warning={
                trends['DataStorageMB']?.predictedTimeToLimit
                  ? t('monitor.limitReachedIn', 'Limit reached in ~{{hours}}h').replace('{{hours}}', String(Math.round(trends['DataStorageMB'].predictedTimeToLimit)))
                  : undefined
              }
            />

            {/* Alerts */}
            <KPIStat
              icon={<Bell className="w-4 h-4" />}
              label={t('monitor.alerts', 'Alerts')}
              value={String(activeAlertsCount)}
              sub={t('monitor.alertsCount', 'alert(s)')}
              variant={activeAlertsCount > 0 ? 'warning' : 'default'}
            />
          </div>
          </PanelOverlay>

          {/* ── Live Operations ── */}
          {liveOperations.length > 0 && (
            <div className="rounded-lg border border-blue-500/20 bg-surface-1 p-4" data-testid="live-ops-section">
              <LiveOperationsPanel
                operations={liveOperations}
                onCancel={(opId) => cancelOp.mutate({ operationId: opId })}
                onPause={(opId) => pauseOp.mutate({ operationId: opId })}
                onResume={(opId) => resumeOp.mutate({ operationId: opId })}
              />
            </div>
          )}

          {/* ── Org Info Panel (compact, right after KPIs) ── */}
          {orgInfo && (
            <div className="rounded-lg border border-subtle bg-surface-1 px-4 py-3" data-testid="org-info-panel">
              <div className="flex items-center gap-2 mb-2.5">
                <Server className="w-4 h-4 text-text-secondary" />
                <h3 className="text-sm font-semibold text-text-primary">{orgInfo.name}</h3>
                <span className="font-mono text-[10px] text-text-muted">{orgInfo.orgId}</span>
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-8 gap-x-5 gap-y-2">
                <div>
                  <div className="text-[10px] text-text-muted">{t('monitor.release', 'Release')}</div>
                  <div className="text-xs font-medium text-text-primary">{orgInfo.releaseName ?? `API v${orgInfo.apiVersion}`}</div>
                </div>
                {orgInfo.nextReleaseName && (
                  <div>
                    <div className="text-[10px] text-text-muted">{t('monitor.nextRelease', 'Next Release')}</div>
                    <div className="text-xs font-medium text-text-primary">{orgInfo.nextReleaseName}</div>
                  </div>
                )}
                <div>
                  <div className="text-[10px] text-text-muted">{t('monitor.instance', 'Instance')}</div>
                  <div className="text-xs font-medium text-text-primary">
                    {orgInfo.instanceName}
                    {orgInfo.isHyperforce && <Badge variant="info" className="ml-1 text-[8px] px-1 py-0">HF</Badge>}
                  </div>
                </div>
                <div>
                  <div className="text-[10px] text-text-muted">{t('monitor.edition', 'Edition')}</div>
                  <div className="text-xs font-medium text-text-primary">{orgInfo.edition}</div>
                </div>
                <div>
                  <div className="text-[10px] text-text-muted">{t('monitor.users', 'Users')}</div>
                  <div className="text-xs font-medium text-text-primary">{formatNumber(orgInfo.userCount)}</div>
                </div>
                <div>
                  <div className="text-[10px] text-text-muted">{t('monitor.customObjects', 'Objects')}</div>
                  <div className="text-xs font-medium text-text-primary">{formatNumber(orgInfo.customObjectCount)}</div>
                </div>
                <div>
                  <div className="text-[10px] text-text-muted">{t('monitor.code', 'Code')}</div>
                  <div className="text-xs font-medium text-text-primary">{formatNumber(orgInfo.apexClassCount)} Apex &middot; {formatNumber(orgInfo.flowCount)} Flows</div>
                </div>
                {orgInfo.datacenter && (
                  <div>
                    <div className="text-[10px] text-text-muted">{t('monitor.datacenter', 'Datacenter')}</div>
                    <div className="text-xs font-medium text-text-primary">{orgInfo.datacenter}</div>
                  </div>
                )}
              </div>

              {(orgInfo.namespacePrefix || orgInfo.createdDate || orgInfo.podName) && (
                <div className="flex items-center gap-4 mt-2 pt-2 border-t border-subtle text-[10px] text-text-muted">
                  {orgInfo.namespacePrefix && <span>Namespace: <span className="font-mono text-text-secondary">{orgInfo.namespacePrefix}</span></span>}
                  {orgInfo.createdDate && <span>{t('monitor.orgCreated', 'Created')}: {new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(orgInfo.createdDate))}</span>}
                  {orgInfo.podName && <span>Pod: <span className="font-mono text-text-secondary">{orgInfo.podName}</span></span>}
                </div>
              )}
            </div>
          )}

          {/* ── Storage Breakdown ── */}
          <StorageBreakdownPanel />

          {/* ── Two-column: Trends + Jobs ── */}
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

          {/* ── Governor Limits ── */}
          <PanelOverlay isRefreshing={isRefreshing}>
          <div className="rounded-lg border border-subtle bg-surface-1 p-4">
            <SectionHeader
              title={t('monitor.governorLimits', 'Governor Limits')}
              count={criticalLimits.length > 0 ? criticalLimits.length : undefined}
              collapsed={!limitsExpanded}
              onToggle={() => setLimitsExpanded(!limitsExpanded)}
              actions={
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => anomalyScan.mutate({ orgId: selectedOrgId, objectName: 'Account' })}
                  disabled={anomalyScan.loading}
                  loading={anomalyScan.loading}
                  data-testid="anomaly-scan-btn"
                >
                  <Search className="w-3.5 h-3.5 mr-1" />
                  {t('monitor.scanAnomalies', 'Scan')}
                </Button>
              }
            />

            {limitsExpanded && (
              <div className="flex flex-col gap-1.5">
                {sortedLimits.length === 0 ? (
                  <p className="text-xs text-text-muted text-center py-4">
                    {t('monitor.noLimits', 'No limits data available')}
                  </p>
                ) : (
                  sortedLimits.map((l) => {
                    const used = l.max - l.remaining;
                    return (
                      <div
                        key={l.name}
                        className="flex items-center gap-3 px-3 py-1.5 rounded hover:bg-surface-2 transition-colors"
                        data-testid={`limit-${l.name}`}
                      >
                        <span className="text-xs font-medium text-text-primary w-48 truncate shrink-0">{l.name}</span>
                        <div className="flex-1">
                          <ProgressBar value={l.usedPercent} variant={usageVariant(l.usedPercent)} size="sm" />
                        </div>
                        <span className="text-xs tabular-nums text-text-secondary w-24 text-right shrink-0">
                          {formatNumber(used)} / {formatNumber(l.max)}
                        </span>
                        <span className="w-12 text-right shrink-0">
                          <Badge variant={usageBadge(l.usedPercent)}>
                            {Math.round(l.usedPercent)}%
                          </Badge>
                        </span>
                      </div>
                    );
                  })
                )}
              </div>
            )}
          </div>
          </PanelOverlay>

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
          {anomalyScan.data?.success && anomalyScan.data.anomalies && anomalyScan.data.anomalies.length > 0 && (
            <div className="rounded-lg border border-amber-500/30 bg-surface-1 p-4" data-testid="anomaly-scan-results">
              <SectionHeader
                title={t('monitor.anomaliesFound', 'Anomalies Found')}
                count={anomalyScan.data.anomalies.length}
              />
              <div className="flex flex-col gap-2">
                {anomalyScan.data.anomalies.map((anomaly, idx) => (
                  <div key={`${anomaly.field}-${idx}`} className="flex items-start gap-2 p-2 rounded bg-surface-2">
                    <Badge variant={anomaly.severity === 'high' ? 'error' : anomaly.severity === 'medium' ? 'warning' : 'info'}>
                      {anomaly.severity}
                    </Badge>
                    <div className="flex-1 min-w-0">
                      <span className="text-xs font-semibold text-text-primary">{anomaly.field}</span>
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

        </motion.div>
      </AnimatePresence>
    </div>
  );
};
