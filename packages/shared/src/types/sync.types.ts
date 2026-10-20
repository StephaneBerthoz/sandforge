import type {
  UUID,
  ISODateString,
  ApiName,
  CurrencyReplaced,
  PriceCurrencySettled,
} from './common.types.js';
import type { ForgeUndoMark, ForgeUndoObjectResult, ForgeUndoStatus } from './forge.types.js';

/** Sync direction */
export type SyncDirection = 'source_to_target' | 'target_to_source' | 'bidirectional';

/** Sync mode */
export type SyncMode = 'full' | 'incremental' | 'delta' | 'cdc';

/**
 * Conflict resolution strategy. `manual` holds a change for a person to
 * decide, which only real-time replication does: see {@link SyncConflictStrategy}.
 */
export type ConflictStrategy = 'source_wins' | 'target_wins' | 'newest_wins' | 'manual' | 'merge';

/**
 * How a bidirectional sync run settles a record both orgs hold with different
 * values. `manual` is not one of them: a run has no screen on which a person
 * decides before it writes, and the resolver answered it with the source
 * values — the write of source wins, under a name that promised a decision.
 */
export type SyncConflictStrategy = Exclude<ConflictStrategy, 'manual'>;

/** Field mapping type */
export type MappingType =
  'direct' | 'rename' | 'transform' | 'constant' | 'formula' | 'exclude' | 'add_on';

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
  conflictStrategy: SyncConflictStrategy;
  enableRollback: boolean;
  createdAt: ISODateString;
  updatedAt: ISODateString;
  /**
   * With `mode: 'delta'` only: delete in the target the records the source
   * deleted since the object's last good run, found by the key the write
   * matches on. Off unless set.
   */
  propagateDeletes?: boolean;
  /**
   * Copy the files of the records each object writes: the latest version of
   * every Salesforce File linked to one of them, and their legacy
   * attachments. Off unless set; absent, no file is read.
   */
  files?: SyncFileCopyOption;
  /**
   * Write the email addresses and phone numbers of the rows as the source
   * holds them. Absent or false — the default — every row a run writes has
   * them neutralized first, as a Forge run's are: each address under
   * `.invalid`, each phone number a fictional one. Copied as read into a
   * sandbox whose record-triggered flows email and text the contacts they are
   * written for, the copies were real people, reachable from the sandbox.
   */
  keepContactPoints?: boolean;
}

/**
 * A configuration's choice to copy the files of the records it writes, with
 * the two caps a run keeps to.
 */
export interface SyncFileCopyOption {
  /** Largest file copied, in MB: a larger one is skipped and counted, never cut short. */
  maxFileSizeMB: number;
  /**
   * Most a run copies, in MB: the files past it are skipped and counted, and
   * the next run copies them.
   */
  maxRunMB: number;
}

/**
 * What a run did with the files of one object's records, or what a
 * simulation found it would do.
 */
export interface SyncFilesOutcome {
  /** Files created in the target: a Salesforce File's first copy, or an attachment. */
  copied: number;
  /**
   * New versions added to a Salesforce File an earlier run copied, because the
   * source holds a newer version of it: never a second document.
   */
  versions: number;
  /**
   * Legacy attachments an earlier run copied whose source changed since: each
   * copy replaced, the new one written under the target record and the old
   * one deleted. An attachment has no versions. Absent when there are none.
   */
  replaced?: number;
  /** The bytes those files, versions and replaced attachments took. */
  bytes: number;
  /** Links written from a copied file to the other target records it hangs on. */
  links: number;
  /** Files an earlier run copied whose source has not changed since: not copied again. */
  unchanged: number;
  /** Skipped: larger than the configuration's largest file. */
  tooLarge: number;
  /** Skipped: past the most a run copies. The next run copies them. */
  pastRunCap: number;
  /** Skipped: kept outside Salesforce, so there is no content to copy. */
  external: number;
  /** Not copied: no record they hang on was written. */
  recordNotWritten: number;
  /** Not copied: their content could not be read, or the target refused it. */
  failed: number;
}

/**
 * What a run's files came to against the target's file storage, read before
 * anything was written.
 */
export interface SyncFilesStorage {
  /** The target's file storage left, in bytes, as its `/limits` said. */
  remainingBytes: number;
  /** What the files the run set out to copy take, in bytes, within its caps. */
  plannedBytes: number;
  /** Why the files do not fit, with the numbers: a run is refused on it. Absent when they fit. */
  shortfall?: string;
}

/**
 * Why an object of a delta configuration was read whole rather than from its
 * watermark:
 * - `first_run`: no run of the object has succeeded yet;
 * - `reset`: "Run full next time" cleared its watermark;
 * - `scope_changed`: its filter, fields, mapping, key or operation changed
 *   since the watermark was recorded, so the records it holds in the target
 *   were written under another scope;
 * - `unreadable`: the stored watermarks did not read as watermarks;
 * - `no_modstamp`: the source would not say the object's latest
 *   `SystemModstamp`, so no watermark can be taken from it;
 * - `not_saved`: the configuration run is not a saved one, and a watermark is
 *   kept for a saved configuration only;
 * - `removed`: a removal took back records or files a run of it had created
 *   for the object, so the copies its watermark counted on are gone.
 */
export type SyncFullReadReason =
  'first_run' | 'reset' | 'scope_changed' | 'unreadable' | 'no_modstamp' | 'not_saved' | 'removed';

/**
 * How an object of a delta configuration was read and what came of it.
 * Absent on an object of a full configuration.
 */
export interface SyncDeltaOutcome {
  /** `delta`: the records changed since `since`; `full`: every record its filter allows. */
  read: 'delta' | 'full';
  /** On a delta read: the watermark of the last good run the read started from. */
  since?: ISODateString;
  /** On a full read: why. */
  reason?: SyncFullReadReason;
  /** Rows the source read returned: on a delta read, the records changed since `since`. */
  changed: number;
  /** Whether deletions were looked for: on a delta read of a configuration that propagates them. */
  deletionsChecked: boolean;
  /**
   * Target records deleted because the source deleted the record they were
   * matched to; in a simulation, the records a run would delete.
   */
  deleted: number;
  /** Target deletes the org refused. */
  deleteFailed: number;
  /** Why the deletions could not be carried, when they could not. */
  deletionError?: string;
  /**
   * The watermark recorded for the next run, read from the source before
   * this one read it. Absent when the object did not finish cleanly — it then
   * keeps the watermark it had — and in a simulation.
   */
  recorded?: ISODateString;
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
  /**
   * Why the run ended early: the error it ended on, or the cancel that stopped
   * it. Absent on a clean run.
   *
   * A run that threw was stored as "failure, 0 ms, 0 objects" and nothing
   * else: the message went to the output channel and to a toast, and the
   * history row — the one place the user comes back to — had nothing to show
   * but the word "failure". The only error text the detail panel could render
   * lived on a per-object result, and a run that threw before reading an
   * object has none.
   */
  error?: string;
  /**
   * Set when a cancel stopped the run before it had synced every object. The
   * objects listed are the ones it reached; its status is never `success`,
   * since the objects after the cancel were not synced.
   */
  cancelled?: boolean;
  /**
   * On a configuration that copies files: the target's file storage as read
   * before the run wrote anything, and what its files were to take of it.
   */
  files?: SyncFilesStorage;
  /**
   * What the run created in its target, counted, when it created anything:
   * the ids are kept apart, where its removal reads them. Absent from a run
   * recorded before runs kept what they created.
   */
  created?: SyncRunCreated;
}

/**
 * What a run created in its target, counted: the records it inserted, or
 * upserted where the target held none — never one it updated, which was the
 * target's before — and the files it created, a Salesforce File's first copy
 * or a legacy attachment, never a version added to an earlier copy. The ids
 * are kept outside the history, as the run writes them, under `runId`.
 */
export interface SyncRunCreated {
  /** The id they are kept under: what a removal of the run names. */
  runId: string;
  /** Records created, per object, in the order the run wrote them. */
  objects: Array<{ objectApiName: ApiName; count: number }>;
  /** Files created: Salesforce Files and legacy attachments. */
  files: number;
}

/**
 * Why a removal of a run's creations cannot run now:
 * - `GUARD_BLOCKED`: Production Guard allows no delete in the target — a
 *   production org; a Developer Edition is not taken for one, as for a Forge
 *   run's removal;
 * - `NO_GUARD`: no Production Guard was given, and nothing deletes without it;
 * - `ORG_GONE`: the target is no longer a registered org;
 * - `RUNNING`: the run is still writing.
 */
export type SyncRemovalRefusalCode = 'GUARD_BLOCKED' | 'NO_GUARD' | 'ORG_GONE' | 'RUNNING';

/** A run whose creations are kept, as its removal reads it before anything is asked of the org. */
export interface SyncRunRemovalInfo {
  runId: string;
  configId: string;
  /** The configuration's name when the run started. */
  configName: string;
  sourceOrgId: string;
  targetOrgId: string;
  /** When the run started, by this machine's clock. */
  startedAt: ISODateString;
  /** When it ended; absent from a run a closed window stopped part way. */
  endedAt?: ISODateString;
  /** Records and files it created, in all. */
  created: number;
  /**
   * What a removal takes now, per object, in the order it hands them to the
   * removal: files first, then each object the reverse of the order the run
   * wrote them. Empty once removals took them all.
   */
  left: Array<{ objectApiName: string; count: number }>;
  /** What the removals of it did, once one took some. */
  removed?: ForgeUndoMark;
  /** Why no removal can run now; absent when one can. */
  refusal?: { code: SyncRemovalRefusalCode; message: string };
}

/** What removing what a Sync run created did, object by object. */
export interface SyncRemovalResult {
  runId: string;
  status: ForgeUndoStatus;
  /** Whether records modified since the run, and what was added to them since, went too. */
  includeChanged: boolean;
  /** Per object, in the order they were removed: files first, children before their parents. */
  objects: ForgeUndoObjectResult[];
  /** When the removal ended, ISO 8601. */
  finishedAt: ISODateString;
  /** Set on a removal of what an earlier one left: when that one ended, ISO 8601. */
  leftBy?: ISODateString;
  /**
   * The objects the next run of the configuration reads whole, since the
   * copies its watermark counted on are gone. Absent when there are none.
   */
  readWhole?: string[];
  /** Files dropped from the configuration's record of the files it copied. Absent when none. */
  filesForgotten?: number;
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
  /**
   * How this execution was triggered: from the Sync page, by a re-run from
   * the history, by a schedule, or by a pipeline's Sync step.
   */
  triggeredBy: 'manual' | 'schedule' | 'rerun' | 'pipeline';
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
  /** Result of the last execution; `cancelled` when a cancel stopped it before its last object. */
  lastResult?: 'success' | 'partial' | 'failure' | 'cancelled';
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
  /**
   * Refused records whose refusals `errors` leaves out: a run keeps those of
   * the first records it counts, and its history fewer. Absent when it left
   * none out. A validation rule refusing every record of a large object
   * posted one line per record, uncapped, into the page and into each of
   * the five hundred history entries kept.
   */
  refusalsDropped?: number;
  /**
   * Of the records an upsert wrote, those it created and those it updated,
   * as the org said for each. A record the org said neither of is in
   * neither. Absent for the other operations.
   */
  upsertSplit?: { created: number; updated: number };
  /** On a delta configuration: how the object was read, and the deletions it carried. */
  delta?: SyncDeltaOutcome;
  /** On a configuration that copies files: what became of the files of the records it wrote. */
  files?: SyncFilesOutcome;
  /**
   * The records written in another currency than they were read in — the
   * target does not hold theirs active, or their parent went in another —
   * and what became of their amounts.
   */
  currenciesReplaced?: CurrencyReplaced[];
  /**
   * Of the prices, those read in a currency the target does not hold active,
   * and how each went: replaced by the source's own price in the currency
   * written, linked to its copy, or written in it at its amount converted.
   * Said apart from `errors`: none of it is a refusal. Absent when none.
   */
  pricesSettled?: PriceCurrencySettled[];
}

/**
 * An active validation rule of the target on an object a run writes: what a
 * simulation cannot evaluate, listed beside what it predicts.
 */
export interface SyncValidationRule {
  /** The rule's name, after its package's namespace for a packaged one. */
  name: string;
  /** What the rule says when it refuses a record. */
  message: string;
  /** The field it shows its error on; absent for the top of the page. */
  field?: string;
}

/**
 * What a sync run would do with one object, as a simulation found it: both
 * orgs read and compared, nothing written. The target's validation rules,
 * duplicate rules and automations are not run, so a record they would refuse
 * is counted as the run would send it; the validation rules are listed.
 */
export interface SyncObjectSimulation {
  objectApiName: ApiName;
  operation: SyncOperation;
  /** Rows the source read returned. */
  read: number;
  /** Records the target would create. */
  insert: number;
  /** Records the target holds already, which the write would update. */
  update: number;
  /** Records the target holds, which the write would delete. */
  delete: number;
  /** Rows the run leaves out before it writes; `notes` says why. */
  skipped: number;
  /** Records the run would send that the target cannot take as asked; `notes` says why. */
  refused: number;
  /**
   * On a bidirectional run, records both orgs hold whose values differ on a
   * field the run writes: the strategy decides which value is written. Zero
   * on a run that writes source to target, which does not compare.
   */
  conflicts: number;
  /** The fields those records differ on, the most frequent first, ten at most. */
  conflictFields: string[];
  /** What the counts leave unsaid, in words. */
  notes: string[];
  /**
   * On a delta configuration: how a run would read the object, and the target
   * records it would delete for the source's deletions — counted in `delete`
   * as well.
   */
  delta?: SyncDeltaOutcome;
  /** On a configuration that copies files: the files a run would copy, and those it would skip. */
  files?: SyncFilesOutcome;
  /**
   * The target's active validation rules on the object, which the simulation
   * cannot evaluate: a record one of them refuses is counted as written.
   * Absent when the object has none, when the run only deletes, or when they
   * could not be read (`SyncSimulationResult.validationRulesUnread`).
   */
  validationRules?: SyncValidationRule[];
}

/** What a sync run would do, object by object, as a simulation found it. */
export interface SyncSimulationResult {
  configId: UUID;
  operationId: UUID;
  direction: SyncDirection;
  conflictStrategy: SyncConflictStrategy;
  /** The objects simulated, in the order the run would write them. */
  objects: SyncObjectSimulation[];
  duration: number;
  timestamp: ISODateString;
  /** Set when a cancel stopped the simulation before its last object. */
  cancelled?: boolean;
  /** The error a read met. A run would stop on it too, at the same object. */
  error?: string;
  /** The object whose read failed, when one did. */
  failedObject?: ApiName;
  /** On a configuration that copies files: what they would take of the target's file storage. */
  files?: SyncFilesStorage;
  /**
   * Why the target's validation rules could not be listed, when the org
   * refused to say: any of them may still refuse a record counted as written.
   */
  validationRulesUnread?: string;
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
  resolution?: SyncConflictStrategy;
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
  'disconnected' | 'connecting' | 'connected' | 'syncing' | 'paused' | 'error';

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
