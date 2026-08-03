import type { BaseMessage } from './base.messages.js';
import type { MetricSample } from '../../monitor/MetricEvent.js';
import type { AlertInstance } from '../monitor.types.js';

/** Monitor messages */
export interface MonitorRefreshRequest extends BaseMessage {
  type: 'monitor:refresh';
  payload: { orgId: string };
}

/** Request to start monitoring an org (alias for monitor:refresh). */
export interface MonitorStartRequest extends BaseMessage {
  type: 'monitor:start';
  payload: { orgId: string };
}

/** Request to fetch trend data for an org over a given period. */
export interface MonitorTrendsRequest extends BaseMessage {
  type: 'monitor:trends';
  payload: { orgId: string; period?: string };
}

/** Monitor abort job */
export interface MonitorAbortJobRequest extends BaseMessage {
  type: 'monitor:abort-job';
  payload: { orgId: string; jobId: string };
}

/** Response after attempting to abort a Salesforce async job */
export interface MonitorAbortJobResponse extends BaseMessage {
  type: 'monitor:abort-job:response';
  payload: { jobId: string; success: boolean; message: string };
}

/**
 * Single-sample metric event forwarded from MetricBus across the WebView
 * bridge (Phase 03 Plan 03-01). The payload is a `MetricSample` validated
 * by `MetricSampleSchema` in `monitor/MetricEvent.ts`.
 *
 * In practice the MetricBus coalesces these into
 * {@link MonitorMetricsBatchMessage} over a 250 ms window before forwarding
 * (P-03.9 mitigation). This single-sample variant is reserved for very low
 * frequency / high-priority metrics that must not wait for the batch window.
 */
export interface MonitorMetricMessage extends BaseMessage {
  type: 'monitor:metric';
  payload: MetricSample;
}

/**
 * Batched metric samples produced by the MetricBus coalescing window
 * (default 250 ms). The `samples` array is non-empty and capped at 1000
 * by `MetricBatchEventSchema` (Phase 03 Plan 03-01). Webview subscribers
 * iterate samples and route by `seriesId` prefix.
 */
export interface MonitorMetricsBatchMessage extends BaseMessage {
  type: 'monitor:metrics:batch';
  payload: { samples: MetricSample[] };
}

/**
 * Subscription request from WebView panels — narrows the firehose to a
 * single `seriesId` prefix so the bridge does not waste throughput on
 * series the panel is not rendering (P-03.9 mitigation #2).
 */
export interface MonitorMetricSubscribeMessage extends BaseMessage {
  type: 'monitor:metric:subscribe';
  payload: { seriesPrefix: string };
}

// ─── Alert Panel Messages (AlertsPanel / AlertHistoryPanel) ──────────────────

/**
 * `monitor:alerts`. WebView -> Extension.
 *
 * Asks the extension for the active alert list plus the persisted alert
 * history. The result comes back on the `monitor:alerts:result` channel
 * (not `:response`). No filter payload is currently honoured — the handler
 * returns every active alert regardless of org.
 */
export interface MonitorAlertsRequest extends BaseMessage {
  type: 'monitor:alerts';
  payload?: Record<string, never>;
}

/**
 * `monitor:alerts:result`. Extension -> WebView.
 *
 * `alerts` is the live list from `AlertEngine.getActiveAlerts()`; `history`
 * is the persisted trail from `AlertStateStore.loadHistory()` (both are
 * `AlertInstance` collections — history entries carry terminal statuses).
 */
export interface MonitorAlertsResultMessage extends BaseMessage {
  type: 'monitor:alerts:result';
  payload: { alerts: AlertInstance[]; history: AlertInstance[] };
}

/** `monitor:alert:acknowledge`. WebView -> Extension. */
export interface MonitorAlertAcknowledgeRequest extends BaseMessage {
  type: 'monitor:alert:acknowledge';
  payload: { alertId: string };
}

/** `monitor:alert:acknowledge:response`. Extension -> WebView. */
export interface MonitorAlertAcknowledgeResponse extends BaseMessage {
  type: 'monitor:alert:acknowledge:response';
  payload: { success: boolean };
}

/** `monitor:alert:dismiss`. WebView -> Extension. */
export interface MonitorAlertDismissRequest extends BaseMessage {
  type: 'monitor:alert:dismiss';
  payload: { alertId: string };
}

/** `monitor:alert:dismiss:response`. Extension -> WebView. */
export interface MonitorAlertDismissResponse extends BaseMessage {
  type: 'monitor:alert:dismiss:response';
  payload: { success: boolean };
}

// ─── Live Operations Dashboard Messages ──────────────────────────────────────

/** Request to get the list of live operations. */
export interface LiveOperationsRequest extends BaseMessage {
  type: 'monitor:live-operations';
}

/** Live operation snapshot sent from extension to webview. */
export interface LiveOperationSnapshot {
  operationId: string;
  module: string;
  description: string;
  status: 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';
  percentage: number;
  processedRecords: number;
  totalRecords: number;
  currentStep: string;
  startedAt: string;
  elapsedMs: number;
  recordsPerSecond: number;
  error?: string;
}

/** Response containing the list of live operations. */
export interface LiveOperationsResponse extends BaseMessage {
  type: 'monitor:live-operations:response';
  payload: { operations: LiveOperationSnapshot[] };
}

/** Push update when live operations change. */
export interface LiveOperationsUpdated extends BaseMessage {
  type: 'monitor:live-operations:updated';
  payload: { operations: LiveOperationSnapshot[] };
}

// ─── Monitor Storage / Deployments / API Usage Messages ──────────────────────

/** Per-object storage entry returned by monitor:storage. */
export interface StorageObjectEntry {
  objectName: string;
  recordCount: number;
  label: string;
}

/** Request to fetch per-object storage breakdown. */
export interface MonitorStorageRequest extends BaseMessage {
  type: 'monitor:storage';
  payload: { orgId: string };
}

/** Response containing per-object storage breakdown. */
export interface MonitorStorageResponse extends BaseMessage {
  type: 'monitor:storage:response';
  payload: {
    success: boolean;
    objects: StorageObjectEntry[];
    totalRecords: number;
    error?: string;
  };
}

/** Deployment entry for the deployment timeline. */
export interface DeploymentEntry {
  id: string;
  status: 'Succeeded' | 'Failed' | 'Canceled' | 'InProgress' | 'Pending';
  startDate: string;
  completedDate?: string;
  createdBy: string;
  componentCount: number;
  errorCount: number;
}

/** Request to fetch recent deployments. */
export interface MonitorDeploymentsRequest extends BaseMessage {
  type: 'monitor:deployments';
  payload: { orgId: string };
}

/** Response containing recent deployments. */
export interface MonitorDeploymentsResponse extends BaseMessage {
  type: 'monitor:deployments:response';
  payload: {
    success: boolean;
    deployments: DeploymentEntry[];
    error?: string;
  };
}

/** Per-category API usage entry. */
export interface ApiUsageCategory {
  category: string;
  used: number;
  max: number;
  usedPercent: number;
}

/** Request to fetch per-category API usage breakdown. */
export interface MonitorApiUsageRequest extends BaseMessage {
  type: 'monitor:api-usage';
  payload: { orgId: string };
}

/** Response containing per-category API usage. */
export interface MonitorApiUsageResponse extends BaseMessage {
  type: 'monitor:api-usage:response';
  payload: {
    success: boolean;
    categories: ApiUsageCategory[];
    error?: string;
  };
}

// --- Monitor Service Panels ---

/** Request to fetch recent error log entries for an org. */
export interface MonitorErrorLogsRequest extends BaseMessage {
  type: 'monitor:error-logs';
  payload: { orgId: string };
}

/** Response containing recent error log entries grouped by type. */
export interface MonitorErrorLogsResponse extends BaseMessage {
  type: 'monitor:error-logs:response';
  payload: {
    success: boolean;
    errors: Array<{
      id: string;
      errorType: string;
      message: string;
      stackTrace?: string;
      timestamp: string;
      user?: string;
      context?: string;
    }>;
    errorsByType: Array<{ type: string; count: number }>;
    totalCount: number;
    error?: string;
  };
}

/** Request to fetch active user sessions for an org. */
export interface MonitorSessionsRequest extends BaseMessage {
  type: 'monitor:sessions';
  payload: { orgId: string };
}

/** Response containing active user sessions and distinct user count. */
export interface MonitorSessionsResponse extends BaseMessage {
  type: 'monitor:sessions:response';
  payload: {
    success: boolean;
    sessions: Array<{
      userId: string;
      username: string;
      sessionType: string;
      loginTime: string;
      sourceIp: string;
    }>;
    activeUserCount: number;
    error?: string;
  };
}

/** Request to fetch Apex log analysis insights for an org. */
export interface MonitorApexInsightsRequest extends BaseMessage {
  type: 'monitor:apex-insights';
  payload: { orgId: string };
}

/** Response containing Apex log analyses and top performance issues. */
export interface MonitorApexInsightsResponse extends BaseMessage {
  type: 'monitor:apex-insights:response';
  payload: {
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
    error?: string;
  };
}

/** Request to fetch sandbox refresh events for an org. */
export interface MonitorSandboxRefreshRequest extends BaseMessage {
  type: 'monitor:sandbox-refresh';
  payload: { orgId: string };
}

/** Response containing sandbox refresh events and in-progress status. */
export interface MonitorSandboxRefreshResponse extends BaseMessage {
  type: 'monitor:sandbox-refresh:response';
  payload: {
    success: boolean;
    refreshes: Array<{
      orgId: string;
      sandboxName: string;
      refreshDate: string;
      status: string;
      sourceOrg?: string;
    }>;
    inProgress: boolean;
    error?: string;
  };
}

// ─── Org Health Score Messages ────────────────────────────────────────────────

/** Request to compute the full org health score. */
export interface OrgHealthScoreRequest extends BaseMessage {
  type: 'monitor:health-score';
  payload: { orgId: string };
}

/** Dimension score within the org health radar. */
export interface OrgHealthDimension {
  name: string;
  score: number;
  label: string;
  detail: string;
  recommendation: string;
}

/** Response containing the org health score breakdown. */
export interface OrgHealthScoreResponse extends BaseMessage {
  type: 'monitor:health-score:response';
  payload: {
    success: boolean;
    overallScore: number;
    dimensions: OrgHealthDimension[];
    recommendations: string[];
    error?: string;
  };
}
