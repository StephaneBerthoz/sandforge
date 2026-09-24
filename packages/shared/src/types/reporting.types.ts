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
  | 'template_delete'
  | 'forge_execute'
  | 'seed_csv_import'
  | 'seed_clone'
  | 'autopilot_execute'
  | 'frozen_load'
  | 'metadata_deploy'
  | 'realtime_sync'
  | 'subject_erase'
  | 'cleanup_delete';

/**
 * How a recorded run ended. `stopped` is a run stopped before it wrote
 * anything: by Production Guard — refused by the guard, or declined at its
 * confirmation, which the entry's `guard` says — or by a check of its own path
 * or a cancel, which the entry's `details.code` names.
 */
export type AuditOutcome = 'success' | 'partial' | 'failure' | 'stopped';

/**
 * What Production Guard decided about a run.
 *
 * `confirmed` means a person answered the production confirmation; a run the
 * guard would have asked about, on a host with no one to ask, is `allowed`.
 */
export type GuardDecision = 'allowed' | 'confirmed' | 'declined' | 'refused';

/**
 * What one run did to one object of the org it wrote, in counts.
 *
 * Counts only, never a record, an id or a field value: an audit trail that
 * kept what was written would be a second copy of the data, outside every
 * control the org puts on it.
 */
export interface AuditObjectCounts {
  objectApiName: string;
  created: number;
  updated: number;
  deleted: number;
  failed: number;
  /**
   * Records an upsert wrote without the run knowing whether it created or
   * updated them, counted apart rather than guessed into either column. An
   * upsert whose answer says which, record by record, counts its records as
   * created or updated instead. Absent when there are none.
   */
  upserted?: number;
}

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
  /** The org the run wrote to. */
  orgId?: string;
  /** Its alias when the entry was written: an alias can be renamed, the id cannot. */
  orgAlias?: string;
  /** The org the records were read from, when they came from one. */
  sourceOrgId?: string;
  sourceOrgAlias?: string;
  /** The run's operation id — the one its `operation:*` messages carried. */
  operationId?: string;
  outcome?: AuditOutcome;
  /** Production Guard's decision, when the guard was consulted. */
  guard?: GuardDecision;
  /** Per object, what the run did. Empty when it wrote nothing. */
  objects?: AuditObjectCounts[];
  userId?: string;
  details: Record<string, unknown>;
  timestamp: ISODateString;
  ipAddress?: string;
}

/** Every module and org an audit trail holds: what its filters can offer. */
export interface AuditFacets {
  modules: string[];
  /** Each org under the alias it was last recorded with. */
  orgs: Array<{ orgId: string; orgAlias?: string }>;
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

/**
 * Where the records of a run came from, when a lineage names its source.
 * `org` is another org; the others are what the run read instead of one: a
 * seed generator, a CSV file, a backup, a frozen dataset.
 */
export type LineageOrigin = 'org' | 'generator' | 'csv' | 'backup' | 'dataset';

/** Data lineage node — tracks data flow through the system */
export interface LineageNode {
  id: UUID;
  /** `object` is one object whose records the run carried. */
  type: 'source' | 'transform' | 'filter' | 'object' | 'destination';
  /** An org alias, an object API name, or what the source is called. */
  label: string;
  objectApiName?: string;
  orgId?: string;
  /** On a source node: what kind of source it is. */
  origin?: LineageOrigin;
  /** On an object node: the records of that object the run carried. */
  recordCount?: number;
  config?: Record<string, unknown>;
}

/** Data lineage edge — connection between nodes */
export interface LineageEdge {
  sourceId: UUID;
  targetId: UUID;
  label?: string;
  recordCount?: number;
}

/** A run whose lineage is kept, as a list of runs names it. */
export interface LineageRunSummary {
  operationId: UUID;
  generatedAt: ISODateString;
  module?: string;
  action?: AuditAction;
  /** Label of the org the run wrote to. */
  targetLabel?: string;
}

/** Complete data lineage graph */
export interface DataLineageGraph {
  nodes: LineageNode[];
  edges: LineageEdge[];
  operationId: UUID;
  generatedAt: ISODateString;
  /** The module whose run this graph traces. */
  module?: string;
  /** The audit action of that run, so a list of runs can name each one. */
  action?: AuditAction;
}
