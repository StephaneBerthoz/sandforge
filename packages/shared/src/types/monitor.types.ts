import type { UUID, ISODateString } from './common.types.js';

/** Alert severity level */
export type AlertSeverity = 'info' | 'warning' | 'critical';

/** Alert status */
export type AlertStatus = 'active' | 'acknowledged' | 'resolved' | 'dismissed';

/** Monitoring metric type */
export type MetricType = 'gauge' | 'counter' | 'rate' | 'percentage';

/** Salesforce API limit information */
export interface ApiLimit {
  name: string;
  max: number;
  remaining: number;
  usedPercent: number;
}

/** API limits snapshot */
export interface LimitsSnapshot {
  orgId: string;
  limits: ApiLimit[];
  timestamp: ISODateString;
}

/** Alert definition */
export interface AlertDefinition {
  id: UUID;
  name: string;
  description: string;
  enabled: boolean;
  metric: string;
  condition: AlertCondition;
  severity: AlertSeverity;
  cooldownMinutes: number;
  notificationChannels: NotificationChannel[];
}

/** Alert condition — when to trigger */
export interface AlertCondition {
  operator: 'gt' | 'gte' | 'lt' | 'lte' | 'eq' | 'neq';
  threshold: number;
  sustainedSeconds?: number;
}

/** Notification channel type */
export type NotificationChannel =
  | 'toast'
  | 'vscode_notification'
  | 'status_bar'
  | 'sound'
  | 'webhook';

/** Triggered alert instance */
export interface AlertInstance {
  id: UUID;
  definitionId: UUID;
  severity: AlertSeverity;
  status: AlertStatus;
  message: string;
  currentValue: number;
  threshold: number;
  orgId: string;
  triggeredAt: ISODateString;
  acknowledgedAt?: ISODateString;
  resolvedAt?: ISODateString;
  /**
   * Phase 03 Plan 03-05 — UI badge variant. `'anomaly'` is set by
   * AnomalyEngine bridge so AlertsPanel can render the synthetic instance
   * with a distinct visual treatment without inspecting `definitionId`.
   * Absent on alerts produced by the rule-based `AlertEngine.evaluate`
   * pipeline.
   */
  badge?: 'anomaly';
  /**
   * Phase 03 Plan 03-05 — opaque per-source metadata bag. AnomalyEngine
   * stores `{ mean, stdDev, zScore, recentContext }` here so downstream
   * consumers (Phase 04 AI narrator, AlertsPanel detail view) can render
   * richer context without widening the core AlertInstance shape.
   */
  metadata?: Record<string, unknown>;
}

/** Monitoring dashboard layout */
export interface DashboardLayout {
  id: UUID;
  name: string;
  widgets: DashboardWidget[];
  createdAt: ISODateString;
  updatedAt: ISODateString;
}

/** Dashboard widget configuration */
export interface DashboardWidget {
  id: UUID;
  type: WidgetType;
  title: string;
  metric: string;
  position: WidgetPosition;
  config: WidgetConfig;
}

/** Dashboard widget types */
export type WidgetType =
  | 'gauge'
  | 'line_chart'
  | 'bar_chart'
  | 'stat_card'
  | 'table'
  | 'alert_list'
  | 'heatmap';

/** Widget position in the grid layout */
export interface WidgetPosition {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Widget-specific configuration */
export interface WidgetConfig {
  refreshInterval?: number;
  timeRange?: string;
  orgIds?: string[];
  soqlQuery?: string;
  thresholds?: { warning: number; critical: number };
}

/** Apex log entry */
export interface ApexLogEntry {
  id: string;
  operation: string;
  status: string;
  durationMs: number;
  logSize: number;
  startTime: ISODateString;
  user: string;
}

/** Org health status */
export interface OrgHealthStatus {
  orgId: string;
  overall: 'healthy' | 'degraded' | 'critical';
  apiLimitsStatus: 'ok' | 'warning' | 'critical';
  storageStatus: 'ok' | 'warning' | 'critical';
  activeJobs: number;
  recentErrors: number;
  lastChecked: ISODateString;
}

/** Trend data for a single metric */
export interface TrendData {
  limitName: string;
  direction: 'up' | 'down' | 'stable';
  changePercent: number;
  predictedTimeToLimit?: number;
  sparklineData: number[];
  /** ISO timestamps corresponding to each sparklineData entry. When present, charts should use these instead of synthesizing timestamps. */
  timestamps?: string[];
}

/** Trend data collection for an org */
export interface OrgTrendPayload {
  orgId: string;
  trends: Record<string, TrendData>;
  periodLabel: string;
}

/** Custom metric definition */
export interface CustomMetric {
  id: UUID;
  name: string;
  description: string;
  soqlQuery: string;
  type: MetricType;
  unit?: string;
  refreshInterval: number;
  orgId: string;
}

/** A factor contributing to the health score */
export interface HealthFactor {
  name: string;
  category: 'limits' | 'jobs' | 'storage' | 'metadata' | 'coverage' | 'security';
  score: number;
  weight: number;
  status: 'healthy' | 'warning' | 'critical';
  detail: string;
  recommendation: string;
  trend: 'improving' | 'stable' | 'degrading';
}

/** Full health report with explanations */
export interface HealthReport {
  overallScore: number;
  overallStatus: 'healthy' | 'warning' | 'critical';
  factors: HealthFactor[];
  summary: string;
  topRisks: HealthFactor[];
}

/** Job insight type produced by JobAnalyzer */
export type JobInsightType = 'frequent_failures' | 'long_running' | 'high_consumer' | 'stuck';

/** Insight about Apex job patterns */
export interface JobInsight {
  type: JobInsightType;
  severity: 'info' | 'warning' | 'critical';
  title: string;
  detail: string;
  affectedJobs: string[];
  recommendation: string;
}

/** Async Apex job record from Salesforce */
export interface AsyncApexJob {
  id: string;
  apexClassId: string;
  apexClassName: string;
  status: 'Queued' | 'Processing' | 'Completed' | 'Failed' | 'Aborted' | 'Preparing' | 'Holding';
  jobType: 'BatchApex' | 'Future' | 'Queueable' | 'ScheduledApex' | 'SharingRecalculation';
  numberOfErrors: number;
  totalJobItems: number;
  jobItemsProcessed: number;
  extendedStatus?: string;
  createdDate: ISODateString;
  completedDate?: ISODateString;
  createdById: string;
  createdByName: string;
}

/** Org info fetched for overview panel */
export interface OrgInfo {
  name: string;
  orgId: string;
  type: 'Production' | 'Sandbox' | 'Scratch' | 'Developer';
  edition: string;
  instanceName: string;
  apiVersion: string;
  userCount: number;
  customObjectCount: number;
  apexClassCount: number;
  flowCount: number;
  lastLoginDate: ISODateString;
  /** Salesforce release name, e.g. "Spring '26" */
  releaseName?: string;
  /** Next major release name, e.g. "Summer '26" */
  nextReleaseName?: string;
  /** Approximate next release date, e.g. "2026-06-14" */
  nextReleaseDate?: string;
  /** Whether the org runs on Hyperforce */
  isHyperforce?: boolean;
  /** Datacenter / pod location, e.g. "US East (AWS)" */
  datacenter?: string;
  /** Namespace prefix if managed package org */
  namespacePrefix?: string;
  /** Org creation date */
  createdDate?: ISODateString;
  /** Number of active licenses */
  activeLicenses?: number;
  /** Salesforce stack/pod, e.g. "na45-pod1" */
  podName?: string;
}
