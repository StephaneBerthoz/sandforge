import type { UUID, ISODateString } from './common.types.js';
import type { ForgeGapDecisionKind, ForgeVerificationVerdict } from './forge.types.js';

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
  | 'forge_verify'
  | 'forge_rehearse'
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
  /**
   * Of the records written, those the target refused on fields it named — a
   * validation rule, or a restricted picklist refusing their value — and that
   * went in once those fields were left out, or, for a Frozen load whose
   * picklist rule replaces a rejected value, given that value: counted among
   * the created or updated too, and said apart because they lack a value the
   * source held. Absent when there are none.
   */
  writtenWithoutFields?: number;
  /**
   * Records the run had to write and never sent: its cancel came while the
   * object was written, or the failure it ended on, and kept them from the
   * target. Neither written nor failed, they were counted nowhere, and an
   * object the cancel cut short read as written whole. Absent when there are
   * none.
   */
  notSent?: number;
  /**
   * Records of a call whose answer never came back: the target may hold any
   * of them under an id the run never learned. Counted among the failed, and
   * apart, because they may be in the org all the same. Absent when there are
   * none.
   */
  mayHaveBeenWritten?: number;
  /**
   * Set when the run skipped the object whole and sent none of it: a record
   * its rows cannot be written without failed, or the target takes no insert
   * of it. `counted` when the run had read those rows, which `failed` counts;
   * `uncounted` when it never learned how many there were, which no column
   * can then say. Counted as nothing, such an object was not listed, and a
   * run that lost it read as one that never met it. Absent otherwise.
   */
  skipped?: 'counted' | 'uncounted';
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
  /**
   * Set on a removal of the records a run or a load created that took up what
   * an earlier removal of them left in the org: when that one ended. Its
   * counts are of those records alone.
   */
  leftBy?: ISODateString;
  /**
   * Set on the verification of a run's records (`forge_verify`): what it
   * concluded. Its counts are in `details`.
   */
  verdict?: ForgeVerificationVerdict;
  /**
   * The user the run wrote as, by the username this machine's org registry
   * holds for the org: `sha256:` and the first twelve hex characters of the
   * SHA-256 of that username in lower case. Never the username itself, which
   * often carries a person's name; whoever knows it can tell it from the
   * entry. Absent when the registry holds no username for the org, and from
   * entries recorded before it was kept.
   */
  userId?: string;
  /** How the run was set up and let through, beside what it wrote; see {@link AuditRunContext}. */
  context?: AuditRunContext;
  details: Record<string, unknown>;
  timestamp: ISODateString;
  ipAddress?: string;
}

/** A part of the target's automation a read before a run could not take. */
export type AuditAutomationPart =
  'flows' | 'triggers' | 'processes' | 'workflowRules' | 'automation';

/**
 * What fires in the target as a run inserts its records, by kind, as the run
 * read it and put it to the user before it read anything: counts, never the
 * name of a flow or a trigger.
 */
export interface AuditFiredOnInsert {
  flow: number;
  trigger: number;
  process: number;
  workflowRule: number;
  /**
   * What the read could not take of what fires on insert, which may hide
   * more than the counts say; `automation` when none of it could be read.
   */
  unread: AuditAutomationPart[];
}

/**
 * What fires in the target as a run updates the records it inserted — a
 * lookup filled in once its record exists, an order given back its status —
 * by kind, put to the user in the same question as what fires on insert:
 * counts, never the name of a flow or a trigger. What could not be read is
 * said with what fires on insert.
 */
export interface AuditFiredOnUpdate {
  flow: number;
  trigger: number;
  process: number;
  workflowRule: number;
}

/**
 * A kind of decision the run's config held — taken on Review's Gaps tab, or
 * kept by a template — how many of it, and the rows those changed as the run
 * wrote them. Never what a decision maps from or to.
 */
export interface AuditDecisionCount {
  kind: ForgeGapDecisionKind;
  /** Decisions of the kind the config held. */
  count: number;
  /**
   * Rows they changed, as the run counted them. Absent when the run counted
   * none: a run stopped before it wrote, or a kind it does not count by row.
   */
  rows?: number;
}

/**
 * A question of a run's gate a person answered by going on: `automation`,
 * what fires in the target as the run inserts its records and updates those
 * it writes a second time; `volume`, the
 * records the run had read and was about to write — past the volume that
 * asks, or near the data storage the target has left, or with that storage
 * unread.
 */
export type AuditConfirmation = 'automation' | 'volume';

/**
 * How a run was set up and let through, beside what it wrote: what a reader of
 * the trail asks of a run that wrote into an org — whether it anonymized, what
 * it did with email addresses and phone numbers, whether it was reviewed,
 * simulated or rehearsed first, what fired as it inserted and updated, what
 * the user confirmed and decided. Words and counts, never a value of a record.
 */
export interface AuditRunContext {
  /** Whether the run anonymized the personal data of the fields selected for it. */
  anonymized: boolean;
  /**
   * What the run did with the email addresses and phone numbers it wrote, as
   * its config chose: neutralized, or kept as the source holds them. Said of a
   * run stopped before it wrote too, which never reports counts.
   */
  contactPoints: 'neutralized' | 'kept';
  /** Started with no stop on the discovery and Review screens (Clone directly). */
  reviewSkipped: boolean;
  /**
   * Minutes between the end of a simulation of the same case — the same orgs,
   * the same input, the same objects discovered, whatever was decided since —
   * and the request of the run, when one ended in the half hour before it.
   */
  simulatedMinutesBefore?: number;
  /** As {@link simulatedMinutesBefore}, for a rehearsal. */
  rehearsedMinutesBefore?: number;
  /** What fires as the run inserts, as it was put to the user; absent when the run never got there. */
  firedOnInsert?: AuditFiredOnInsert;
  /**
   * What fires as the run updates the records it inserted, put to the user
   * with what fires on insert; absent when the run never got there.
   */
  firedOnUpdate?: AuditFiredOnUpdate;
  /** The questions of the run's gate a person answered by going on, in the order they were put. */
  confirmed?: AuditConfirmation[];
  /** The decisions the run's config held, kind by kind; absent when it held none. */
  decisions?: AuditDecisionCount[];
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
