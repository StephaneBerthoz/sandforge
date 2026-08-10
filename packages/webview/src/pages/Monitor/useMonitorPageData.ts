import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useOrgStore } from '../../stores/useOrgStore';
import { useNotificationStore } from '../../stores/useNotificationStore';
import { useBridgeQuery } from '../../hooks/useBridgeQuery';
import { useBridgeMutation } from '../../hooks/useBridgeMutation';
import type { ApiLimit, HealthReport, TrendData, JobInsight, OrgInfo } from '@sandforge/shared';
import type { TrendSeries } from './TrendCharts';
import type { JobDisplayInfo } from './MonitorPage';
import type { OrgHealthStatus } from './HealthCheckPanel';

/** Payload received from monitor:data message. */
interface MonitorData {
  limits: ApiLimit[];
  jobs: JobDisplayInfo[];
  healthScore: number;
  healthReport?: HealthReport;
  trends?: Record<string, TrendData>;
  jobInsights?: JobInsight[];
  orgInfo?: OrgInfo;
  orgHealthStatus?: OrgHealthStatus;
  lastUpdated: string;
}

/** Auto-refresh interval in milliseconds. */
const AUTO_REFRESH_INTERVAL_MS = 30_000;

/** Stale data threshold in milliseconds (2 minutes). */
const STALE_THRESHOLD_MS = 120_000;

/** Number of consecutive failures before declaring connection lost. */
const CONNECTION_LOST_THRESHOLD = 3;

/** Finds a limit by name or returns a default. */
function findLimit(limits: ApiLimit[], name: string): ApiLimit {
  return limits.find((l) => l.name === name) ?? { name, max: 0, remaining: 0, usedPercent: 0 };
}

/** Formats ISO date as relative time string. */
function timeAgo(iso: string): string {
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.floor(m / 60)}h ago`;
}

/** Prediction item returned by the hook. */
export interface PredictionItem {
  limitName: string;
  currentUsage: number;
  estimatedHoursToLimit: number;
}

/** Return type for the useMonitorPageData hook. */
export interface MonitorPageData {
  /** Whether the monitor query is loading. */
  loading: boolean;
  /** Error message from the monitor query. */
  error: string | null;
  /** Raw limits array from the monitor data. */
  limits: ApiLimit[];
  /** Jobs from the monitor data. */
  jobs: JobDisplayInfo[];
  /** Overall health score (0-100). */
  healthScore: number;
  /** Detailed health report breakdown. */
  healthReport: HealthReport | undefined;
  /** Raw trends record keyed by limit name. */
  trends: Record<string, TrendData>;
  /** Job insights array with severity and details. */
  jobInsights: JobInsight[];
  /** Org metadata (edition, instance, users, etc.). */
  orgInfo: OrgInfo | undefined;
  /** ISO timestamp of last data refresh. */
  lastUpdated: string | null;
  /** Human-readable relative time since last update (e.g. "2m ago"). */
  lastUpdatedStr: string;
  /** Number of active or acknowledged alerts. */
  activeAlertsCount: number;
  /** DailyApiRequests limit detail. */
  apiLimit: ApiLimit;
  /** DataStorageMB limit detail. */
  storageLimit: ApiLimit;
  /** FileStorageMB limit detail. */
  fileStorageLimit: ApiLimit;
  /** Limits sorted by usage percentage descending. */
  sortedLimits: ApiLimit[];
  /** Limits at or above 60% usage. */
  criticalLimits: ApiLimit[];
  /** Trend chart data points for the DailyApiRequests sparkline. */
  trendChartData: Array<{ timestamp: number; value: number }>;
  /** Multi-series trend data for the TrendCharts component. */
  trendSeries: TrendSeries[];
  /** Predictions for limits approaching exhaustion. */
  predictions: PredictionItem[];
  /** Whether a background refresh is in progress (distinct from initial load). */
  isRefreshing: boolean;
  /** Whether lastUpdated exceeds the stale threshold (2 minutes). */
  isStale: boolean;
  /** Number of minutes since the last successful update. */
  minutesSinceUpdate: number;
  /** Number of consecutive auto-refresh failures. */
  consecutiveFailures: number;
  /** True when consecutiveFailures >= 3 (connection considered lost). */
  connectionLost: boolean;
  /** Per-section error state for partial refresh failures. */
  sectionErrors: Record<string, string>;
  /** Whether error details panel is expanded. */
  showErrorDetails: boolean;
  /** Toggle error details visibility. */
  toggleErrorDetails: () => void;
  /** Retry only the failed sections. */
  retryFailed: () => void;
  /** Whether auto-refresh is enabled. */
  autoRefresh: boolean;
  /** Toggle auto-refresh on/off. */
  setAutoRefresh: (value: boolean) => void;
  /** Manually trigger a data refresh. */
  handleRefresh: () => void;
  /** Abort a running job by its ID. */
  handleAbortJob: (jobId: string) => void;
  /** Org health status from the monitor:data response. */
  orgHealthStatus: OrgHealthStatus | undefined;
}

/**
 * Extracts all data-fetching logic, bridge queries, derived state,
 * and side-effects from MonitorPage into a single composable hook.
 *
 * This hook manages:
 * - Bridge queries for monitor data and alerts
 * - Bridge mutation for job abort
 * - All useMemo derived state (limits, jobs, healthScore, trends, predictions, etc.)
 * - The timeAgo ticker effect
 * - The auto-refresh interval effect
 * - The error notification effect
 */
export function useMonitorPageData(): MonitorPageData {
  const { t } = useTranslation();
  const selectedOrgId = useOrgStore((s) => s.selectedOrgId);
  const addNotification = useNotificationStore((s) => s.addNotification);

  const [autoRefresh, setAutoRefresh] = useState(false);
  const [lastUpdatedStr, setLastUpdatedStr] = useState('');
  const [consecutiveFailures, setConsecutiveFailures] = useState(0);
  const [sectionErrors, setSectionErrors] = useState<Record<string, string>>({});
  const [showErrorDetails, setShowErrorDetails] = useState(false);
  const autoRefreshRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const prevErrorRef = useRef<string | null>(null);
  const prevLoadingRef = useRef(false);

  // Bridge queries
  const monitorQuery = useBridgeQuery<MonitorData>(
    'monitor:refresh',
    selectedOrgId ? { orgId: selectedOrgId } : undefined,
    { responseType: 'monitor:data', skip: !selectedOrgId },
  );

  const abortJobMutation = useBridgeMutation<{ success: boolean }>('monitor:abort-job', {
    responseType: 'monitor:abort-job:response',
  });

  const alertsQuery = useBridgeQuery<{ alerts: Array<{ status: string }> }>(
    'monitor:alerts',
    undefined,
    { responseType: 'monitor:alerts:result', skip: !selectedOrgId },
  );

  // Derived state
  const loading = monitorQuery.loading;
  const error = monitorQuery.error;
  const data = monitorQuery.data;
  const limits = useMemo(() => data?.limits ?? [], [data?.limits]);
  // Memoised fallbacks keep referential stability when there is no data yet,
  // so the memoised page sections don't re-render on every parent render.
  const jobs = useMemo(() => data?.jobs ?? [], [data?.jobs]);
  const healthScore = data?.healthScore ?? 0;
  const healthReport = data?.healthReport;
  const trends = useMemo(() => data?.trends ?? {}, [data?.trends]);
  const jobInsights = useMemo(() => data?.jobInsights ?? [], [data?.jobInsights]);
  const orgInfo = data?.orgInfo;
  const orgHealthStatus = data?.orgHealthStatus;
  const lastUpdated = data?.lastUpdated ?? null;

  const activeAlertsCount = useMemo(() => {
    const alerts = alertsQuery.data?.alerts ?? [];
    return alerts.filter((a) => a.status === 'active' || a.status === 'acknowledged').length;
  }, [alertsQuery.data?.alerts]);

  const apiLimit = useMemo(() => findLimit(limits, 'DailyApiRequests'), [limits]);
  const storageLimit = useMemo(() => findLimit(limits, 'DataStorageMB'), [limits]);
  const fileStorageLimit = useMemo(() => findLimit(limits, 'FileStorageMB'), [limits]);

  const sortedLimits = useMemo(
    () => [...limits].sort((a, b) => b.usedPercent - a.usedPercent),
    [limits],
  );

  const criticalLimits = useMemo(
    () => sortedLimits.filter((l) => l.usedPercent >= 60),
    [sortedLimits],
  );

  // Trend chart data
  const trendChartData = useMemo(() => {
    const apiTrend = trends['DailyApiRequests'];
    if (!apiTrend || apiTrend.sparklineData.length < 2) return [];
    return apiTrend.sparklineData.map((value, i) => ({
      timestamp: apiTrend.timestamps?.[i]
        ? new Date(apiTrend.timestamps[i]).getTime()
        : Date.now() - (apiTrend.sparklineData.length - 1 - i) * 15 * 60 * 1000,
      value,
    }));
  }, [trends]);

  const trendSeries: TrendSeries[] = useMemo(() => {
    const colorMap: Record<string, string> = {
      DailyApiRequests: 'var(--sf-info, #3B82F6)',
      DataStorageMB: 'var(--sf-success, #10B981)',
      DailySoqlQueries: 'var(--sf-warning, #F59E0B)',
      DailyAsyncApexExecutions: 'var(--sf-accent, #8B5CF6)',
    };
    return Object.entries(trends)
      .filter(([, td]) => td.sparklineData.length >= 2)
      .map(([key, td]) => ({
        id: key,
        name: key.replace(/([A-Z])/g, ' $1').trim(),
        color: colorMap[key] ?? 'var(--sf-accent)',
        data: td.sparklineData.map((value, i) => ({
          timestamp:
            td.timestamps?.[i] ??
            new Date(Date.now() - (td.sparklineData.length - 1 - i) * 15 * 60 * 1000).toISOString(),
          value,
        })),
      }));
  }, [trends]);

  const predictions = useMemo(() => {
    return Object.entries(trends)
      .filter(([, td]) => td.predictedTimeToLimit !== undefined && td.predictedTimeToLimit > 0)
      .map(([key, td]) => ({
        limitName: key,
        currentUsage: findLimit(limits, key).usedPercent,
        estimatedHoursToLimit: td.predictedTimeToLimit ?? 999,
      }));
  }, [trends, limits]);

  // isRefreshing: true when loading but we already have data (not initial load)
  const isRefreshing = loading && lastUpdated !== null;

  // Stale data computation. lastUpdatedStr is derived from lastUpdated and
  // does not need to be in the deps array — recomputing on lastUpdated alone
  // is sufficient and avoids the lint warning.
  const minutesSinceUpdate = useMemo(() => {
    if (!lastUpdated) return 0;
    return Math.floor((Date.now() - new Date(lastUpdated).getTime()) / 60_000);
  }, [lastUpdated]);

  const isStale =
    lastUpdated !== null && Date.now() - new Date(lastUpdated).getTime() > STALE_THRESHOLD_MS;

  // Connection lost when 3+ consecutive failures
  const connectionLost = consecutiveFailures >= CONNECTION_LOST_THRESHOLD;

  // Track consecutive failures: increment on new error, reset on success
  useEffect(() => {
    const currentError = monitorQuery.error;
    const currentLoading = monitorQuery.loading;
    const prevError = prevErrorRef.current;
    const prevLoading = prevLoadingRef.current;

    // Transition from loading to not-loading
    if (prevLoading && !currentLoading) {
      if (currentError && currentError !== prevError) {
        // New error after a refresh cycle
        setConsecutiveFailures((prev) => prev + 1);
        setSectionErrors((prev) => ({ ...prev, monitor: currentError }));
      } else if (!currentError) {
        // Successful refresh -- reset failures
        setConsecutiveFailures(0);
        setSectionErrors({});
      }
    }

    prevErrorRef.current = currentError;
    prevLoadingRef.current = currentLoading;
  }, [monitorQuery.error, monitorQuery.loading]);

  const toggleErrorDetails = useCallback(() => {
    setShowErrorDetails((prev) => !prev);
  }, []);

  const retryFailed = useCallback(() => {
    monitorQuery.refetch();
  }, [monitorQuery]);

  // Error notification effect
  useEffect(() => {
    if (monitorQuery.error) {
      addNotification({
        level: 'error',
        title: t('monitor.errorTitle', 'Monitor Error'),
        message: monitorQuery.error,
      });
    }
  }, [monitorQuery.error, addNotification, t]);

  // Time ago ticker effect
  useEffect(() => {
    if (!lastUpdated) return;
    setLastUpdatedStr(timeAgo(lastUpdated));
    const interval = setInterval(() => setLastUpdatedStr(timeAgo(lastUpdated)), 10_000);
    return () => clearInterval(interval);
  }, [lastUpdated]);

  // Auto-refresh effect. Depends on `monitorQuery.refetch` (a stable
  // useCallback reference from useBridgeQuery) rather than the whole
  // `monitorQuery` object: useBridgeQuery returns a fresh object on every
  // render, so depending on it made the time-ago ticker (10 s) perpetually
  // reset this 30 s interval and auto-refresh never fired.
  const monitorRefetch = monitorQuery.refetch;
  useEffect(() => {
    if (autoRefresh && selectedOrgId) {
      autoRefreshRef.current = setInterval(() => monitorRefetch(), AUTO_REFRESH_INTERVAL_MS);
    }
    return () => {
      if (autoRefreshRef.current) {
        clearInterval(autoRefreshRef.current);
        autoRefreshRef.current = null;
      }
    };
  }, [autoRefresh, selectedOrgId, monitorRefetch]);

  const handleRefresh = useCallback(() => monitorQuery.refetch(), [monitorQuery]);
  const handleAbortJob = useCallback(
    (jobId: string) => {
      if (selectedOrgId) abortJobMutation.mutate({ orgId: selectedOrgId, jobId });
    },
    [selectedOrgId, abortJobMutation],
  );

  return {
    loading,
    error,
    limits,
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
    handleAbortJob,
    orgHealthStatus,
  };
}
