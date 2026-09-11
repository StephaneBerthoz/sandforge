import type { UUID, ISODateString, ApiName } from './common.types.js';

/** Sync direction */
export type SyncDirection = 'source_to_target' | 'target_to_source' | 'bidirectional';

/** Sync mode */
export type SyncMode = 'full' | 'incremental' | 'delta' | 'cdc';

/** Conflict resolution strategy */
export type ConflictStrategy = 'source_wins' | 'target_wins' | 'newest_wins' | 'manual' | 'merge';

/** Field mapping type */
export type MappingType =
  | 'direct'
  | 'rename'
  | 'transform'
  | 'constant'
  | 'formula'
  | 'exclude'
  | 'add_on';

/** Transform rule type */
export type TransformRuleType =
  | 'uppercase'
  | 'lowercase'
  | 'trim'
  | 'truncate'
  | 'prefix'
  | 'suffix'
  | 'replace'
  | 'regex_replace'
  | 'map_value'
  | 'default_value'
  | 'format_date'
  | 'format_number'
  | 'custom_formula';

/** Sync configuration */
export interface SyncConfig {
  id: UUID;
  name: string;
  description: string;
  sourceOrgId: UUID;
  targetOrgId: UUID;
  direction: SyncDirection;
  mode: SyncMode;
  objects: SyncObjectConfig[];
  conflictStrategy: ConflictStrategy;
  enableRollback: boolean;
  dryRun: boolean;
  schedule?: SyncSchedule;
  createdAt: ISODateString;
  updatedAt: ISODateString;
}

/** Per-object sync configuration */
export interface SyncObjectConfig {
  objectApiName: ApiName;
  externalIdField?: string;
  operation: SyncOperation;
  query?: string;
  fieldMappings: FieldMapping[];
  transformRules: TransformRule[];
  excludedFields: string[];
  addOnFields: AddOnField[];
  batchSize: number;
  orderBy?: string;
  where?: string;
  insertOrder: number;
}

/** Sync operation type */
export type SyncOperation = 'insert' | 'update' | 'upsert' | 'delete';

/** Field mapping definition */
export interface FieldMapping {
  sourceField: string;
  targetField: string;
  type: MappingType;
  transformRules?: TransformRule[];
}

/** Transform rule */
export interface TransformRule {
  type: TransformRuleType;
  config: TransformRuleConfig;
}

/** Transform rule configuration */
export interface TransformRuleConfig {
  length?: number;
  prefix?: string;
  suffix?: string;
  search?: string;
  replace?: string;
  regex?: string;
  valueMap?: Record<string, string>;
  defaultValue?: string;
  dateFormat?: string;
  numberFormat?: string;
  formula?: string;
}

/** Add-on field — constant or computed field added during sync */
export interface AddOnField {
  fieldApiName: string;
  value: string | number | boolean;
  overwriteExisting: boolean;
}

/** Sync schedule configuration */
export interface SyncSchedule {
  enabled: boolean;
  cron: string;
  timezone: string;
  maxRetries: number;
  notifyOnFailure: boolean;
}

/** Sync execution result */
export interface SyncExecutionResult {
  configId: UUID;
  operationId: UUID;
  status: 'success' | 'partial' | 'failure';
  objectResults: SyncObjectResult[];
  totalProcessed: number;
  totalSuccess: number;
  totalFailed: number;
  totalSkipped: number;
  duration: number;
  timestamp: ISODateString;
}

/** A snapshot of a sync execution for history tracking and re-run support. */
export interface SyncHistoryEntry {
  /** Unique identifier for this history entry. */
  id: UUID;
  /** Full copy of the SyncConfig used at execution time (for re-run support). */
  configSnapshot: SyncConfig;
  /** The execution result returned by the orchestrator. */
  result: SyncExecutionResult;
  /** When the sync execution started (computed from result.timestamp - result.duration). */
  startTime: ISODateString;
  /** When the sync execution ended. */
  endTime: ISODateString;
  /** How this execution was triggered. */
  triggeredBy: 'manual' | 'schedule' | 'rerun';
  /** If triggered by a schedule, the schedule entry ID. */
  scheduleId?: UUID;
}

/** A scheduled sync entry with cron, toggle, and audit metadata. */
export interface SyncScheduleEntry {
  /** Unique schedule identifier. */
  id: UUID;
  /** Human-readable name for the schedule. */
  name: string;
  /** Reference to the SyncConfig to execute. */
  configId: UUID;
  /** Cron expression (5-field). */
  cron: string;
  /** IANA timezone string. */
  timezone: string;
  /** Whether this schedule is currently active. */
  enabled: boolean;
  /** Maximum retry attempts on failure. */
  maxRetries: number;
  /** Notify on successful completion. */
  notifyOnComplete: boolean;
  /** Notify on failure. */
  notifyOnFailure: boolean;
  /** Next planned execution time. */
  nextRunAt?: ISODateString;
  /** Last execution time. */
  lastRunAt?: ISODateString;
  /** Result of the last execution. */
  lastResult?: 'success' | 'partial' | 'failure';
  /** When this schedule was created. */
  createdAt: ISODateString;
  /** When this schedule was last updated. */
  updatedAt: ISODateString;
  /** Schema version for future migration support. */
  version: number;
}

/** Per-object sync result */
export interface SyncObjectResult {
  objectApiName: ApiName;
  operation: SyncOperation;
  processed: number;
  success: number;
  failed: number;
  skipped: number;
  /** Number of conflicts detected during this object's sync */
  conflictCount: number;
  errors: string[];
}

/** Conflict record needing resolution */
export interface ConflictRecord {
  objectApiName: ApiName;
  recordId: string;
  sourceValues: Record<string, unknown>;
  targetValues: Record<string, unknown>;
  /** Base (common ancestor) values for 3-way merge, if available */
  baseValues?: Record<string, unknown>;
  conflictFields: string[];
  resolution?: ConflictStrategy;
}

/** Type of conflict detected between source and target */
export type ConflictType = 'edit/edit' | 'delete/edit' | 'edit/delete' | 'create/edit';

/** Per-field resolution choice for manual conflict resolution */
export interface FieldResolution {
  /** The resolved value for this field */
  value: unknown;
  /** Where the value came from */
  source: 'source' | 'target' | 'manual';
}

/**
 * Unified conflict representation for the UI.
 * Normalizes both CDCConflict (real-time) and ConflictRecord (batch sync)
 * into a single shape for display and resolution in the WebView.
 */
export interface UIConflict {
  /** Unique ID for this conflict (e.g., `${objectApiName}:${recordId}:${timestamp}`) */
  id: string;
  /** API name of the Salesforce object */
  objectApiName: ApiName;
  /** Salesforce record ID */
  recordId: string;
  /** Type of conflict */
  conflictType: ConflictType;
  /** Values from the source org */
  sourceValues: Record<string, unknown>;
  /** Values from the target org */
  targetValues: Record<string, unknown>;
  /** Base (common ancestor) values for 3-way merge */
  baseValues?: Record<string, unknown>;
  /** List of field API names that are in conflict */
  conflictFields: string[];
  /** When the conflict was detected */
  timestamp: ISODateString;
  /** Whether the conflict has been resolved */
  resolved: boolean;
  /** Bulk resolution strategy applied, if any */
  resolution?: ConflictStrategy;
  /** Per-field resolution choices when strategy is 'manual' */
  fieldResolutions?: Record<string, FieldResolution>;
}

/** Delta detection result */
export interface DeltaResult {
  objectApiName: ApiName;
  newRecords: number;
  modifiedRecords: number;
  deletedRecords: number;
  unchangedRecords: number;
  lastSyncTimestamp?: ISODateString;
}

// ─── CDC (Change Data Capture) Real-Time Sync Types ──────────────────────────

/** CDC change type from Salesforce Streaming API */
export type CDCChangeType = 'CREATE' | 'UPDATE' | 'DELETE' | 'UNDELETE';

/** Parsed CDC event from the Salesforce Streaming API */
export interface CDCEvent {
  /** Unique replay ID for event ordering and replay */
  replayId: number;
  /** API name of the changed object */
  objectApiName: ApiName;
  /** Type of change */
  changeType: CDCChangeType;
  /** Salesforce record IDs affected */
  recordIds: string[];
  /** Changed field values (for CREATE/UPDATE) */
  changedFields: Record<string, unknown>;
  /** Header info: commit timestamp, transaction key, etc. */
  commitTimestamp: ISODateString;
  /** User ID who made the change */
  commitUser: string;
  /** Transaction key for grouping related changes */
  transactionKey: string;
}

/** Status of a real-time sync session */
export type RealTimeSyncStatus =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'syncing'
  | 'paused'
  | 'error';

/** Metrics for a real-time sync session */
export interface RealTimeSyncMetrics {
  /** Total events received since session start */
  eventsReceived: number;
  /** Total events successfully applied to target */
  eventsApplied: number;
  /** Total events that failed to apply */
  eventsFailed: number;
  /** Events received in the current minute */
  eventsPerMinute: number;
  /** Average replication lag in milliseconds */
  averageLagMs: number;
  /** Current replication lag in milliseconds */
  currentLagMs: number;
  /** Error rate as a percentage (0-100) */
  errorRate: number;
  /** Session start time */
  startedAt: ISODateString;
  /** Last event received timestamp */
  lastEventAt?: ISODateString;
}

/** Configuration for a real-time CDC sync session */
export interface RealTimeSyncConfig {
  /** Unique session identifier */
  sessionId: UUID;
  /** Source org ID (where CDC events originate) */
  sourceOrgId: UUID;
  /** Target org ID (where changes are replicated) */
  targetOrgId: UUID;
  /** Object API names to subscribe to */
  watchedObjects: ApiName[];
  /** Conflict resolution strategy for incoming changes */
  conflictStrategy: ConflictStrategy;
  /** Flush interval in milliseconds for batching changes */
  flushIntervalMs: number;
  /** Maximum batch size for flushing buffered changes */
  maxBatchSize: number;
}

/** A single replication conflict detected during CDC sync */
export interface CDCConflict {
  /** CDC event that triggered the conflict */
  event: CDCEvent;
  /** Current values in the target org */
  targetValues: Record<string, unknown>;
  /** When the target record was last modified */
  targetLastModified: ISODateString;
  /** Whether the conflict has been resolved */
  resolved: boolean;
  /** Resolution chosen, if resolved */
  resolution?: ConflictStrategy;
}
