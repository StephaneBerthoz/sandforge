import type { UUID, ISODateString, ApiName } from './common.types.js';

/** Sync direction */
export type SyncDirection = 'source_to_target' | 'target_to_source' | 'bidirectional';

/** Sync mode */
export type SyncMode = 'full' | 'incremental' | 'delta' | 'cdc';

/** Conflict resolution strategy */
export type ConflictStrategy =
  | 'source_wins'
  | 'target_wins'
  | 'newest_wins'
  | 'manual'
  | 'merge';

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
  preScript?: string;
  postScript?: string;
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

/** Per-object sync result */
export interface SyncObjectResult {
  objectApiName: ApiName;
  operation: SyncOperation;
  processed: number;
  success: number;
  failed: number;
  skipped: number;
  errors: string[];
}

/** Conflict record needing resolution */
export interface ConflictRecord {
  objectApiName: ApiName;
  recordId: string;
  sourceValues: Record<string, unknown>;
  targetValues: Record<string, unknown>;
  conflictFields: string[];
  resolution?: ConflictStrategy;
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
