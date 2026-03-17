import type { UUID, ISODateString } from './common.types.js';

/** Report type */
export type ReportType =
  | 'seed_execution'
  | 'sync_execution'
  | 'compare_result'
  | 'backup_result'
  | 'anonymization_result'
  | 'pipeline_run'
  | 'data_quality'
  | 'org_health'
  | 'audit_trail'
  | 'custom';

/** Export format */
export type ExportFormat = 'json' | 'csv' | 'html' | 'pdf' | 'xlsx' | 'sarif';

/** Audit log action category */
export type AuditAction =
  | 'org_connect'
  | 'org_disconnect'
  | 'seed_execute'
  | 'sync_execute'
  | 'backup_create'
  | 'backup_restore'
  | 'anonymize_execute'
  | 'delete_execute'
  | 'compare_execute'
  | 'pipeline_run'
  | 'settings_change'
  | 'template_create'
  | 'template_update'
  | 'template_delete';

/** Report definition */
export interface ReportDefinition {
  id: UUID;
  name: string;
  type: ReportType;
  description: string;
  template?: string;
  createdAt: ISODateString;
}

/** Generated report */
export interface GeneratedReport {
  id: UUID;
  definitionId: UUID;
  type: ReportType;
  title: string;
  summary: string;
  sections: ReportSection[];
  metadata: ReportMetadata;
  generatedAt: ISODateString;
}

/** Report section */
export interface ReportSection {
  title: string;
  type: 'text' | 'table' | 'chart' | 'summary' | 'detail';
  content: Record<string, unknown>;
  order: number;
}

/** Report metadata */
export interface ReportMetadata {
  orgId?: string;
  operationId?: string;
  module: string;
  duration?: number;
  recordCount?: number;
  exportedAs?: ExportFormat;
}

/** Audit log entry */
export interface AuditLogEntry {
  id: UUID;
  action: AuditAction;
  module: string;
  orgId?: string;
  userId?: string;
  details: Record<string, unknown>;
  timestamp: ISODateString;
  ipAddress?: string;
}

/** Analytics data point */
export interface AnalyticsDataPoint {
  metric: string;
  value: number;
  timestamp: ISODateString;
  dimensions: Record<string, string>;
}

/** Analytics time series */
export interface AnalyticsTimeSeries {
  metric: string;
  points: AnalyticsDataPoint[];
  aggregation: 'sum' | 'avg' | 'min' | 'max' | 'count';
  interval: 'minute' | 'hour' | 'day' | 'week' | 'month';
}

/** Data lineage node — tracks data flow through the system */
export interface LineageNode {
  id: UUID;
  type: 'source' | 'transform' | 'filter' | 'destination';
  label: string;
  objectApiName?: string;
  orgId?: string;
  config?: Record<string, unknown>;
}

/** Data lineage edge — connection between nodes */
export interface LineageEdge {
  sourceId: UUID;
  targetId: UUID;
  label?: string;
  recordCount?: number;
}

/** Complete data lineage graph */
export interface DataLineageGraph {
  nodes: LineageNode[];
  edges: LineageEdge[];
  operationId: UUID;
  generatedAt: ISODateString;
}
