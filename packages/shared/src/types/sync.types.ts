import type {
  UUID,
  ISODateString,
  ApiName,
  CurrencyReplaced,
  PriceCurrencySettled,
} from './common.types.js';
import type {
  ForgeContactPointsReport,
  ForgeRefusedField,
  ForgeSweepResult,
  ForgeUndoMark,
  ForgeUndoObjectResult,
  ForgeUndoStatus,
} from './forge.types.js';

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
  /**
   * The records the run wrote that it left without a lookup it was to set
   * once the record named had its copy — one of the same object, or of one
   * written after it in a cycle — the update refused, or never sent: the
   * watermark is not moved past them, and the next run reads them again to
   * set it. Recorded past them, it read only what the source changed since,
   * and the lookup stayed unset for good. Absent when none.
   */
  lookupsOwed?: number;
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
  /**
   * What the run did with the email addresses and phone numbers it wrote, as
   * a Forge run reports it: neutralized, field by field — absent when it
   * neutralized none — or kept as the source holds them, as its
   * configuration asked (`keepContactPoints`).
   */
  contactPoints?: ForgeContactPointsReport;
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
  /**
   * Records the target held that the run wrote over — an update, an upsert
   * that matched — whose values from before, of the fields it wrote, were
   * read and kept first: what removing the run puts back. Absent when none.
   */
  overwritten?: number;
  /**
   * Records of the target the run deleted, as the source had deleted them
   * (`SyncConfig.propagateDeletes`): what removing the run brings back from
   * the target's recycle bin while they are there. Absent when none.
   */
  deleted?: number;
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
  /**
   * Of a run a closed window stopped part way, the call it had under way: the
   * rows of it that the target took are in the org and not in `created`, and
   * no removal of the run takes them.
   */
  inFlight?: { objectApiName: string; rows: number };
  /**
   * Set for a run with no end that another window is writing now — the
   * process its file names is alive: not one a closed window left. Its
   * removal is refused until it ends, as one still writing in this window.
   */
  runningElsewhere?: true;
  /** Records and files it created, in all. */
  created: number;
  /**
   * What a removal takes now, per object, in the order it hands them to the
   * removal: files first, then each object the reverse of the order the run
   * wrote them. Empty once removals took them all.
   */
  left: Array<{ objectApiName: string; count: number }>;
  /**
   * Records the target held that the run wrote over, whose values from before
   * it kept: see {@link SyncRunCreated.overwritten}. Absent when none.
   */
  overwritten?: number;
  /**
   * What a removal puts back now, per object: the records the run wrote over
   * that no removal has given their values back. Absent when none.
   */
  putBack?: Array<{ objectApiName: string; count: number }>;
  /**
   * Records the run wrote over whose values from before are no longer kept —
   * their backup was deleted from the Restore tab, or reached
   * `sandforge.backup.maxAgeDays` — and that no removal puts back: left out
   * of {@link putBack}. Absent when none.
   */
  putBackNotKept?: number;
  /**
   * When the values {@link putBack} gives back reach `sandforge.backup.maxAgeDays`
   * and go with their backup, ISO 8601: the first of them. Absent when the
   * retention keeps them all, or nothing is put back.
   */
  putBackKeptUntil?: ISODateString;
  /** Records of the target it deleted: see {@link SyncRunCreated.deleted}. Absent when none. */
  deleted?: number;
  /**
   * The classic encrypted fields, `Object.Field`, it wrote to records the
   * target held whose values from before were not kept: the run's user read
   * them masked. A removal leaves them as the run wrote them. Absent when none.
   */
  notKeptEncrypted?: string[];
  /**
   * What a removal brings back from the recycle bin now, per object: the
   * records it deleted that no removal has brought back. Absent when none.
   */
  bringBack?: Array<{ objectApiName: string; count: number }>;
  /** What the removals of it did, once one took some. */
  removed?: ForgeUndoMark;
  /**
   * The later runs of the same target, not removed, that wrote records this
   * run still has to take back or give back, newest first: until each is
   * removed, this run's removal reads those records as changed since it, and
   * a removal of the later one after it gives them back this run's values.
   * Absent when none.
   */
  writtenAgain?: Array<{
    runId: string;
    configName: string;
    startedAt: ISODateString;
    records: number;
  }>;
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
  /**
   * What the sweep asked with the removal took, before the run's records
   * went: what the target's automation created during the run, as its user,
   * that the run did not write (Forge's sweep). Absent when none was asked.
   */
  sweep?: ForgeSweepResult;
  /**
   * What the removal put back, per object, before anything was deleted: the
   * records the run wrote over, given back the values they held before it.
   * Absent when the run wrote over none, or a removal before this one put
   * them all back.
   */
  restored?: SyncRestoreObjectResult[];
  /**
   * What the removal brought back from the recycle bin, per object, before
   * anything else: the records the run deleted as the source had deleted
   * them. Absent when the run deleted none, or a removal before this one
   * brought them all back.
   */
  undeleted?: SyncUndeleteObjectResult[];
}

/** What a removal of a Sync run brought back of one object whose records the run deleted. */
export interface SyncUndeleteObjectResult {
  objectApiName: string;
  /** Records the removal set out to bring back. */
  planned: number;
  /** Records brought back from the recycle bin. */
  undeleted: number;
  /** Records in the org already: brought back since by someone else. */
  alreadyBack: number;
  /** Records no longer in the recycle bin either: emptied, or purged since. Gone for good. */
  goneForGood: number;
  /** Records whose undelete the org refused. */
  refused: number;
  /** Records a stop kept the removal from reaching. Absent when none. */
  notReached?: number;
  /** Why records were refused, in the org's words, a few of each. */
  reasons: string[];
}

/** What a removal of a Sync run put back of one object it wrote over. */
export interface SyncRestoreObjectResult {
  objectApiName: string;
  /** Records the removal set out to give back their values from before the run. */
  planned: number;
  /** Records that hold their values from before the run again: written back, or holding them already. */
  restored: number;
  /** Records changed since the run, left as they are: the change stays unless included. */
  keptChanged: number;
  /** Records no longer in the target. */
  alreadyGone: number;
  /** Records whose write back the target refused. */
  refused: number;
  /**
   * Records given back their values from before but for the fields the
   * target no longer takes them in — a picklist value deactivated since, an
   * owner no longer active, a lookup to a record deleted since — which keep
   * the run's values, named in {@link reasons}. Not counted in
   * {@link restored}; absent when none.
   */
  restoredWithout?: number;
  /**
   * Records whose values from before are no longer kept on this machine —
   * their backup was deleted from the Restore tab of DataOps, or reached
   * `sandforge.backup.maxAgeDays` — and that no removal can put back.
   */
  notKept: number;
  /** Records a stop kept the removal from reaching. Absent when none. */
  notReached?: number;
  /** Why records were refused, in the target's words, a few of each. */
  reasons: string[];
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
  /**
   * Set on the price books when the source's standard one was matched to the
   * target's and never written: every org has one, which no copy can create.
   * Said apart from `errors`, as `pricesSettled` is: the sentence saying so
   * was listed among the price books' refusals, in red in the Sync results
   * and history. Absent when the run wrote no price book of its own.
   */
  standardPricebookMatched?: true;
  /**
   * Of the records an insert of a saved configuration read, those an earlier
   * run of it copied whose copy is still in the target: left as they are,
   * not inserted a second time, and counted among `skipped`. Absent when none.
   */
  alreadyCopied?: number;
  /**
   * The records the target refused as a duplicate of one it holds, naming
   * it, and that the run linked to that record rather than writing: counted
   * among `skipped`, neither written nor failed. Said apart from `errors`,
   * as `pricesSettled` is: the sentence saying so was listed among the
   * refusals, in red under a run that had succeeded. Absent when none.
   */
  linkedToExisting?: SyncLinkedToExisting;
  /**
   * The records written without lookups they held from the source, and why.
   * Written, so said apart from `errors` too. Absent when none.
   */
  lookupsLeftOut?: SyncLookupsLeftOut[];
  /**
   * The records the target refused on fields it named — a validation rule,
   * a restricted picklist refusing their value, a lookup filter — and that
   * went in once written again without those fields, as Forge's
   * `writtenWithoutFields` says it. Written, so said apart from `errors`:
   * the sentence saying so was listed among the refusals, in red under a run
   * that had succeeded. Absent when none.
   */
  writtenWithoutFields?: SyncWrittenWithoutFields;
  /**
   * The records written first without the lookups at an object written after
   * them — a cycle of lookups no order breaks — and given them by an update
   * once that object's records had their copies. Absent when none.
   */
  lookupsSetAfter?: SyncLookupsSetAfter;
}

/** See {@link SyncObjectResult.writtenWithoutFields}. */
export interface SyncWrittenWithoutFields {
  /** The records written so. */
  rows: number;
  /** Each field left out of them, what refused it, in its words, and of how many. */
  fields: ForgeRefusedField[];
}

/** See {@link SyncObjectResult.lookupsSetAfter}. */
export interface SyncLookupsSetAfter {
  /** The records given their lookups. */
  records: number;
  /** The lookups set, by API name, sorted. */
  fields: string[];
  /** The objects of the cycle written after it, whose records the lookups waited for. */
  after: ApiName[];
}

/** See {@link SyncObjectResult.linkedToExisting}. */
export interface SyncLinkedToExisting {
  /** The records linked. */
  records: number;
  /** The target's refusal of the first of them, in its words: which value or rule matched. */
  refusal?: string;
}

/**
 * Records of one object written without some of the lookups they held, for
 * one reason:
 * - `notInTarget`: the target refused them for an id it does not have — the
 *   owner, a record no object of the run wrote — and took them sent again
 *   without those lookups;
 * - `ownerRefusedEarlier`: the target refused the same owner earlier in the
 *   run, so they were sent without it from the start;
 * - `parentRefused`: the lookup names a record written after them — of the
 *   same object, or of one their lookups and its own tie in a cycle — that
 *   the run set out to create and could not: they stay without it;
 * - `notSet`: written first without that lookup, the target refused the
 *   update that set it once the record it names was written (`refusal`);
 * - `notReached`: written first without that lookup, the run was cancelled,
 *   or stopped, before it was set.
 */
export interface SyncLookupsLeftOut {
  /** The records written so. */
  records: number;
  /** The lookups they went without, by API name, sorted. */
  fields: string[];
  reason: 'notInTarget' | 'ownerRefusedEarlier' | 'parentRefused' | 'notSet' | 'notReached';
  /** For `notSet`: the target's words on the first update it refused, or why the update failed. */
  refusal?: string;
}

/**
 * An object a run writes later than its configuration lists it: after the
 * parent one of its lookups names, which the run writes first so that the
 * lookup names the parent's copy rather than an id the target does not hold.
 */
export interface SyncWriteOrderMove {
  objectApiName: ApiName;
  /** The object written before it, which `field` names. */
  after: ApiName;
  /** The lookup of `objectApiName` at `after`. */
  field: string;
}

/**
 * The order a run writes its objects in, computed from the target's describe
 * of each before the first write: every parent a lookup names before the
 * object holding the lookup, the configuration's order kept otherwise.
 */
export interface SyncWriteOrder {
  /** Every object of the run, in the order it writes them. */
  objects: ApiName[];
  /** The objects written later than the configuration lists them, and the lookup why. */
  moved: SyncWriteOrderMove[];
  /**
   * Objects whose lookups name each other, which no order puts each after
   * the other: written in the configuration's order, the lookups at the ones
   * written later are left out of the write and set by an update once their
   * records are written. Empty when there are none.
   */
  cycles: ApiName[][];
}

/**
 * Why a target takes no record of an object as a run writes it: it has not
 * the object, or the user the run writes as cannot see it (its describe
 * answers NOT_FOUND alike); that user may not create its records, for an
 * insert or an upsert, or edit them, for an update or an upsert; or its
 * describe failed.
 */
export type SyncUnwritableReason = 'notInTarget' | 'notCreateable' | 'notUpdateable' | 'unread';

/**
 * What a run is held to before its first write, as the run and a simulation
 * of it measure it: the records it writes, counted object by object under
 * each filter, the data storage they take against what the target has left,
 * and the daily emails the target's automation sends as they go in, as
 * Forge, Seed and Autopilot hold their runs.
 */
export interface SyncWriteCheck {
  /** Records the run writes, per object, the most first. */
  objects: Array<{ objectApiName: ApiName; rows: number }>;
  total: number;
  /** Of the records read, those an earlier run of the configuration copied, left as they are. */
  alreadyCopied: number;
  /**
   * Of `total`, the records an update or an upsert writes, which may each
   * write over a record the target holds — every one an update writes, at
   * most every one an upsert writes. Their values from before are read and
   * kept first, and removing the run puts them back. Absent when none.
   */
  overwrites?: number;
  /** The `sandforge.safety.confirmAboveRecords` value `total` is past; absent when it is not. */
  aboveRecords?: number;
  /** The data storage the records it creates take, against what the target has left. */
  storage: {
    verdict: 'fits' | 'near' | 'exceeds' | 'unread';
    estimateMB: number;
    maxMB?: number;
    remainingMB?: number;
    /** Why the target did not say what it has left. */
    unread?: string;
  };
  /** Per daily email limit the target's automation sends against as the records go in. */
  emails: Array<{
    limit: 'SingleEmail' | 'DailyWorkflowEmails';
    emails: number;
    verdict: 'fits' | 'exceeds' | 'unread';
    remaining?: number;
    max?: number;
    /** Set where the target counts its email alerts against its single emails, as a Developer Edition does. */
    alertsCounted?: true;
    objects: Array<{ objectApiName: ApiName; perRecord: number }>;
    /** Why the limit could not be read. */
    unread?: string;
  }>;
  /** Why the target's automation could not be read, so no email was counted; absent when it was. */
  emailsUnread?: string;
  /**
   * The objects the target would take none of, as the run writes them, with
   * the records the run would write of each: it has not the object, or the
   * user the run writes as may not see, create or edit it, or it would not
   * describe it. Not counted in `objects`. A run asks whether to leave them
   * out; one nobody watches, and the command line, are refused. Absent when none.
   */
  unwritable?: Array<{ objectApiName: ApiName; rows: number; why: SyncUnwritableReason }>;
  /**
   * The API requests the run takes of the target, roughly, against the daily
   * requests it has left: `near` when the run would leave it under a tenth of
   * them, `exceeds` past them — refused, as a run would stop part way through.
   * Absent for a run that writes nothing.
   */
  apiRequests?: {
    verdict: 'fits' | 'near' | 'exceeds' | 'unread';
    estimate: number;
    remaining?: number;
    max?: number;
    /** Why the target did not say what it has left. */
    unread?: string;
  };
  /**
   * What the run comes to before it writes, asked from the page: it writes,
   * it asks first — past the setting's volume, near the storage, when the
   * storage could not be read, or past a daily email limit — or it is
   * refused, past the storage. A run nobody watches is refused past a daily
   * email limit too, and the command line past either.
   */
  verdict: 'writes' | 'asks' | 'refused';
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
  /**
   * Of the records an insert of a saved configuration would read, those an
   * earlier run of it copied whose copy is still in the target, which a run
   * leaves as they are: counted among `skipped`. Absent when none.
   */
  alreadyCopied?: number;
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
  /** The order a run writes the objects in, as `objects` lists them; absent when it could not be computed. */
  writeOrder?: SyncWriteOrder;
  /** What a run would be held to before its first write; absent when it could not be measured. */
  writeCheck?: SyncWriteCheck;
  /** Why the records could not be counted before the first write, when they could not. */
  writeCheckUnread?: string;
}

/**
 * What earlier runs between two orgs left in the target, as a re-run or a
 * Quick Sync of the same objects would meet it: a run of a saved
 * configuration leaves what earlier runs of it copied as it is; any other
 * insert writes every record again.
 */
export interface SyncEarlierCopies {
  /** Whether the configuration is saved, so its runs leave what earlier runs of it copied as it is. */
  leftAsIs: boolean;
  /** The last run kept between these orgs that created records of the objects asked about. */
  run?: { runId: string; configName: string; startedAt: ISODateString };
  /** Of what that run created, per object asked about, the records still in the target. */
  objects: Array<{ objectApiName: ApiName; count: number }>;
  /**
   * Why the target could not be asked which are still there: the counts are
   * then what the run created less what its removals took.
   */
  unread?: string;
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
