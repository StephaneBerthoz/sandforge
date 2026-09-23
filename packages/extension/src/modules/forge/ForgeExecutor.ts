import type {
  ForgeCreatedRecords,
  ForgeFilesReport,
  ForgeGraph,
  ForgeGraphEdge,
  ForgeGraphNode,
  ForgeNodeStatus,
  ForgeRemapObjectCounts,
} from '@sandforge/shared';
import { fileCopyRefusal } from '@sandforge/shared';
import { IdRemapper } from './IdRemapper.js';
import { ForgeBatchStrategy as ForgeBatchStrategyService } from './ForgeBatchStrategy.js';
import { extractErrorMessage } from '../../core/common/extractErrorMessage.js';
import { RecordScopeCache } from './RecordScopeCache.js';
import { ScopedSoqlBuilder } from './ScopedSoqlBuilder.js';
import { ReferenceDataMapper } from './ReferenceDataMapper.js';
import { CONCURRENT_DESCRIBE_LIMIT } from './orgConcurrency.js';
import { RecordTypeMapper, warnUnmappedRecordType } from '../sync/RecordTypeMapper.js';
import type { RecordTypeMapping } from '../sync/RecordTypeMapper.js';
import { resolveStageConfig, type ForgeStageConfig } from './stages/ForgeStageConfig.js';
import {
  buildNodeQuery,
  CATALOG_OBJECTS,
  CATALOG_READ_ORDER,
  catalogWriteEdges,
  PRODUCT_OBJECT,
  queryNodeRecords,
  readsFromAbove,
  seedOwnIds,
  seedScopeCache,
  getParentObjects,
  sortNodesForExecution,
  sortNodesForWriting,
  type NodeQueryResult,
} from './stages/ScopeResolver.js';
import { OrphanExpander } from './stages/OrphanExpander.js';
import {
  cleanNodeRecords,
  describeTargetFieldSets,
  intersect,
  type TargetFieldSets,
} from './stages/RecordCleaner.js';
import { BatchWriter, type PendingFkUpdate } from './stages/BatchWriter.js';
import { UNSCOPED_NO_PARENT_REASON } from './ScopedSoqlBuilder.js';
import { assertSoqlIdentifier, sanitizeSoqlValue } from '../../core/common/soqlValidator.js';
import {
  PRICEBOOK_ENTRY_OBJECT,
  PRICEBOOK_OBJECT,
  STANDARD_PRICEBOOK_SOQL,
  PRICEBOOK_ENTRY_BOOK_FIELD,
  PRICEBOOK_ENTRY_PRODUCT_FIELD,
  PRICEBOOK_ENTRY_SELLING_MODEL_FIELD,
  SELLING_MODEL_OBJECT,
  SELLING_MODEL_OPTION_OBJECT,
  isPricebookEntry,
  isRequiredLookup,
  splitStandardPricebookEntries,
  dedupePricebookEntries,
} from '@sandforge/shared';
import { patchCycleFkUpdates } from './stages/CycleFkPatcher.js';
import {
  bytesOf,
  copyFiles,
  dryRunLine,
  filesRunError,
  ForgeFilesRefusedError,
  plannedFilesReport,
  remainingStorageBytes,
  selectFiles,
  storageShortfall,
  type FileCopyDeps,
  type FileToCopy,
} from './stages/FileCopier.js';
import {
  ForgeAnonymizer,
  type ForgeAnonymizeRequest,
  type ForgeRunAnonymization,
} from './ForgeAnonymizer.js';
import { keepPartialSummary } from './interruptedRun.js';
import {
  findUnavailableRecordTypes,
  recordTypeBlockedMessage,
  recordTypeBlockedReason,
  type RecordTypeAvailability,
  type UnavailableRecordTypeUse,
} from '../../core/metadata/recordTypeAvailability.js';

/**
 * Raised when the user aborts a forge run.
 *
 * A distinct type is required, not a plain Error: the per-node catch treats
 * every thrown value as a node-level failure, records it and moves on to the
 * next object. An abort raised as a generic Error was therefore absorbed by
 * that handler and the run kept writing to the target org.
 */
export class ForgeAbortedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ForgeAbortedError';
  }
}

/** Result of a single record insert operation. */
export interface InsertResult {
  /** New Salesforce record ID. */
  id: string;
  /** Whether the insert succeeded. */
  success: boolean;
  /** Error messages if the insert failed, `STATUS_CODE: message` when Salesforce gave a code. */
  errors: string[];
  /**
   * What an upsert did with the row: `false` when it matched a record the
   * target already held by its external id and wrote over it. Absent on an
   * insert, which only ever creates.
   */
  created?: boolean;
  /**
   * Records of the same object a duplicate rule matched when it refused the
   * row. Only the structured error carries them, so a writer that has it
   * passes them on; see `toSaveOutcome`.
   */
  duplicateMatchIds?: string[];
}

/** What the target org's describe of an object says about writing to it. */
export interface TargetObjectInfo {
  /** Key prefix of the object's ids; `null` when the describe gives none. */
  keyPrefix: string | null;
  /** The object's record types, as the user the run writes as sees them. */
  recordTypes: RecordTypeAvailability[];
}

/** Result of a single record update operation. */
export interface UpdateResult {
  /** Salesforce record ID that was updated. */
  id: string;
  /** Whether the update succeeded. */
  success: boolean;
  /** Error messages if the update failed. */
  errors: string[];
}

/** Field metadata returned by describeFields. */
export interface FieldInfo {
  /** Field API name. */
  name: string;
  /** Whether the field can be queried. */
  queryable: boolean;
  /** Whether the field can be set on create. */
  createable: boolean;
  /** Whether the field is a reference (lookup/master-detail). */
  isReference: boolean;
  /**
   * The field's Salesforce type (`email`, `phone`, `string`…). Anonymization
   * reads it to put a field in its category; without it a field is placed by
   * its name alone.
   */
  type?: string;
  /**
   * Objects this reference field can point to (one entry for monomorphic,
   * many for polymorphic fields like Task.WhatId). Only meaningful when
   * `isReference === true`. Required for scope-aware execution; optional
   * for legacy (full-table) execution.
   */
  referenceTo?: string[];
  /**
   * Whether the field accepts `null` on create. When `false` AND the
   * field is a required reference, an orphan FK (no remap entry) makes
   * the whole record unsavable — the executor will skip that record
   * rather than send a payload Salesforce will reject.
   */
  nillable?: boolean;
  /**
   * For picklist / multipicklist fields, the list of *active* values the
   * field accepts. When this dep is populated for the *target* org, the
   * executor strips values that don't appear in the list before insert,
   * avoiding `INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST` rejections caused
   * by source-org picklist entries that don't exist on the target.
   * Empty / missing list = no validation.
   */
  picklistValues?: string[];
  /**
   * Whether this field is an `externalId` on the SObject — i.e. uniquely
   * identifies a record across orgs. Used by the upsert path so devs can
   * re-run the recipe against the same source record without hitting
   * `DUPLICATE_VALUE` on a previously cloned target row.
   */
  externalId?: boolean;
}

/** Optional execution mode parameters. */
export interface ExecuteOptions {
  /**
   * The root record ID supplied by the user (`ForgeConfig.recordId`). When
   * provided alongside `rootObjectApiName`, the executor enters
   * **record-scoped mode**: queries are restricted to the transitive closure
   * of this record instead of cloning every row of every table.
   */
  rootRecordId?: string;
  /** API name of the root object (resolved from the record ID prefix). */
  rootObjectApiName?: string;
  /**
   * When true, the executor still queries source records and populates the
   * scope cache, but skips all writes to the target org. Used by the recipe
   * to preview what *would* happen before committing real writes.
   */
  dryRun?: boolean;
  /**
   * How to handle reference fields whose value points to a record that was
   * never cloned (User, Owner, an excluded parent, etc.) — i.e. the
   * `IdRemapper` has no entry for it.
   *
   * - `'nullify'`: replace the orphaned reference with `null`. Salesforce
   *   then either leaves the field empty or assigns the running user
   *   (for OwnerId). Default in scoped mode.
   * - `'keep'`: preserve the original source-org ID. Almost always rejected
   *   by Salesforce for FKs; left as escape hatch and for legacy
   *   compatibility (default outside scoped mode).
   *
   * `RecordTypeId` is preserved unless a `recordTypeMappings` entry exists
   * for the source value, in which case it is translated to the target ID.
   */
  referenceFallback?: 'nullify' | 'keep';
  /**
   * Cross-org RecordType ID translations (matched by `developerName`).
   * Built up-front by the caller — typically by querying `RecordType` on
   * both orgs and passing the result through {@link RecordTypeMapper}.
   *
   * When supplied, every cloned record's `RecordTypeId` is rewritten to the
   * target-org ID. Records whose `RecordTypeId` has no mapping keep the
   * source value (which Salesforce will reject if the target org does not
   * happen to share that ID).
   */
  recordTypeMappings?: RecordTypeMapping[];
  /**
   * Optional per-object hard cap on the number of records to clone. When
   * set (and > 0), the executor appends `LIMIT N` to every scoped query.
   * Useful for keeping dev-sized clones bounded even when a node's scope
   * naturally pulls thousands of rows (e.g. `InsurancePolicyCoverage`).
   *
   * Records are picked by Salesforce's natural row order — caller can
   * influence this via SOQL hints in a future iteration.
   */
  maxRecordsPerObject?: number;
  /**
   * Object API names whose rows should be *mapped* to existing target
   * records (matched on `Name` / `DeveloperName`) instead of inserted.
   * Defaults to a small set of canonical reference-data tables that are
   * expected to be metadata-deployed: `BusinessHours`, `OperatingHours`.
   * Override or extend per environment as needed.
   */
  referenceDataObjects?: string[];
  /**
   * Single-hop orphan parent expansion. When a record has a
   * required reference field whose target was *never* in the discovery
   * graph (e.g. `Asset.AccountId` pointing at an Account outside the
   * scoped clone), the executor on-demand:
   *
   *   1. Fetches the missing parent by Id from the source org.
   *   2. Inserts a minimal copy into the target org.
   *   3. Records the source→target mapping in the IdRemapper.
   *
   * Single-hop only — the fetched parent's *own* required FKs are
   * orphan-nullified normally (no recursion). Capped at
   * `maxOrphanParentExpansions` to bound API usage.
   *
   * Default: `false` (back-compat — required orphans surface as
   * REQUIRED_FIELD_MISSING errors).
   */
  expandOrphanParents?: boolean;
  /**
   * Maximum number of orphan parents the executor will fetch+insert per
   * `execute()` call when `expandOrphanParents` is true. Default 20.
   */
  maxOrphanParentExpansions?: number;
  /**
   * Insert vs upsert behaviour:
   *   - `'auto'` — for objects whose describe surfaces an `externalId`
   *     field, use `sobject.upsert(records, externalIdField)` so re-runs
   *     against an already-cloned source record patch the existing
   *     target row instead of failing with DUPLICATE_VALUE. Falls back
   *     to insert when no external Id is found.
   *   - `undefined` (default) — always insert.
   */
  upsertMode?: 'auto';
  /**
   * Per-object field exclusions. Field names listed here are stripped
   * from every record before insert/upsert, even if the source describe
   * marks them as createable. Common BA use case: clone Accounts but
   * skip `Description` (long-text PII) or `NumberOfEmployees`
   * (org-specific calc).
   *
   * Lookup is keyed by SObject API name; the inner array is a list of
   * field API names. Case-sensitive (matches Salesforce API name casing).
   */
  fieldExclusions?: Record<string, string[]>;
  /**
   * What to anonymize before insert: per object, the fields selected on its
   * node, and the method for each PII category. Absent, every record is
   * written as the source holds it.
   */
  anonymization?: ForgeRunAnonymization;
  /**
   * Per-object owner remap. When the source-org `OwnerId` of a record
   * matches a key, the cleaned record gets the mapped target Id instead.
   * Useful when cloning records authored by users that don't exist on
   * the target sandbox (e.g. ex-employees) — without this, Salesforce
   * rejects the insert with INVALID_OWNER. Pass-through when no mapping
   * exists for the source Id (the executor's reference fallback then
   * applies — typically nullify in scoped mode).
   */
  ownerMappings?: Record<string, string>;
  /**
   * Per-object SOQL WHERE-clause fragment, appended via `AND (...)` to the
   * scope-derived clause in scoped mode (record root) and used as the whole
   * `WHERE (...)` otherwise. Lets BAs narrow a clone to a subset
   * (e.g. `Status = 'Open' AND CreatedDate > LAST_N_DAYS:30`) without
   * changing graph topology.
   * Validated upstream — see `forgeConfigSchema.objectSoqlFilters`.
   */
  objectSoqlFilters?: Record<string, string>;
  /**
   * Per-object source→target field rename. When the target sandbox has
   * the same logical field under a different API name (schema drift,
   * managed-package re-key, namespace change), this map rewrites the
   * keys in every cleaned record before insert.
   *
   * Example: `{ Account: { 'Region__c': 'Region__pc' } }` — sources every
   * `Region__c` value into `Region__pc` on the target Account. The
   * original key is dropped from the cleaned record so the target
   * describe doesn't reject the unknown field.
   */
  fieldMappings?: Record<string, Record<string, string>>;
  /**
   * Copy the files attached to the records the run clones — the latest
   * version of each Salesforce File linked to one of them, and the legacy
   * attachments under them — after those records are written. Absent, no
   * file is read. See `stages/FileCopier.ts`.
   */
  files?: {
    /** Largest file copied, in bytes: a larger one is left out and listed, never cut. */
    maxFileBytes: number;
    /**
     * Accepted, while the run anonymizes, that files are copied as they are.
     * Without it such a run is refused before anything is read.
     */
    acceptedAsIs?: boolean;
  };
}

/** Dependencies for ForgeExecutor, injected at construction time. */
export interface ForgeExecutorDeps {
  /**
   * Query records from a Salesforce org.
   *
   * @param onTruncated - Called before the rows return when a bound stopped
   *   the paged read short of the end of the cursor. The reader is what knows
   *   about the bounds; the executor is what has to put the shortfall in the
   *   summary instead of reporting a full success.
   */
  queryRecords: (
    orgId: string,
    soql: string,
    onTruncated?: () => void,
  ) => Promise<Record<string, unknown>[]>;
  /** Insert records into a Salesforce org. */
  insertRecords: (
    orgId: string,
    objectName: string,
    records: Record<string, unknown>[],
  ) => Promise<InsertResult[]>;
  /**
   * Update existing records on a Salesforce org. Used by two-pass cycle
   * handling: when a record was inserted with a nullified cycle FK, the
   * second pass patches the FK to the now-cloned parent's target ID via
   * this method. Optional — when omitted, the executor skips the
   * second-pass UPDATE and surfaces the missing FKs in the error report.
   */
  updateRecords?: (
    orgId: string,
    objectName: string,
    records: Record<string, unknown>[],
  ) => Promise<UpdateResult[]>;
  /**
   * Upsert records on a Salesforce org via an external Id field. Used by
   * the upsert path (`ExecuteOptions.upsertMode = 'auto'`) so re-runs
   * patch existing target rows instead of failing on DUPLICATE_VALUE.
   * Optional — when omitted, the executor falls back to insert.
   */
  upsertRecords?: (
    orgId: string,
    objectName: string,
    externalIdField: string,
    records: Record<string, unknown>[],
  ) => Promise<InsertResult[]>;
  /** Get field metadata for an object (queryable, createable, reference flags). */
  describeFields: (orgId: string, objectName: string) => Promise<FieldInfo[]>;
  /**
   * Whether the SObject as a whole accepts inserts on this org. False for
   * read-only system entities like CaseHistory, ContentDocumentLink,
   * AuditTrail variants, etc. When provided, the executor consults this
   * before scheduling inserts so unsupported nodes are skipped cleanly
   * with a helpful error rather than failing record-by-record at runtime.
   */
  isObjectCreatable?: (orgId: string, objectName: string) => Promise<boolean>;
  /**
   * The key prefix and record types of an object, from the describe the run
   * already holds for it — a writer that would have to describe again for
   * this should leave it out.
   *
   * The key prefix is what makes sure an id a duplicate refusal names belongs
   * to the object written before children are linked to it; the record types
   * say which ones the running user may not use, so the object is held back
   * before a single record of it is refused. Optional: without it an id is
   * checked for form alone and record types are left to the platform.
   */
  describeObject?: (orgId: string, objectName: string) => Promise<TargetObjectInfo>;
  /** Optional batch strategy for splitting inserts into batches. */
  batchStrategy?: ForgeBatchStrategyService;
  /**
   * Anonymize one object's rows before insert, as `ExecuteOptions.anonymization`
   * asks. Optional: without it each run anonymizes with a `ForgeAnonymizer`
   * of its own, so a caller that asks for anonymization cannot get the rows
   * back untouched for want of wiring.
   */
  anonymize?: (request: ForgeAnonymizeRequest) => Record<string, unknown>[];
  /**
   * The content of one file, base64-encoded. With the two below, what a run
   * asked to copy files needs; a caller that wires none of them cannot, and
   * such a run is refused before anything is read.
   */
  readFileBody?: FileCopyDeps['readFileBody'];
  /** Create one record carrying a file's content, in a call of its own. */
  insertFile?: FileCopyDeps['insertFile'];
  /** The file storage an org has left, in MB. */
  remainingFileStorageMB?: FileCopyDeps['remainingFileStorageMB'];
}

/** Progress event emitted during execution. */
export interface ForgeProgressEvent {
  /** Object being processed. */
  objectName: string;
  /** Current status of the object. */
  status: ForgeNodeStatus;
  /** Progress percentage (0-100). */
  progress: number;
  /** Human-readable status message. */
  message: string;
  /**
   * What the node turned out to hold, once the run has read it.
   *
   * A graph built from a template is assembled locally, with every count at
   * zero, on the promise that "the real record counts arrive later via the
   * executor's per-node query". They never did: this event carried four fields
   * and none of them was a count, so the cards read "0 records, 0 fields" about
   * objects that were being cloned at that moment. Absent on events that do not
   * know — a status change is not a measurement.
   */
  recordCount?: number;
  fieldCount?: number;
  createableFieldCount?: number;
}

/** Sample of a record that failed insertion, with the platform errors. */
export interface ExecutionErrorSample {
  /** Compact key=value summary of up to 4 fields (for UI display). */
  recordSummary: string;
  /** Error messages returned by Salesforce, one per error on the record. */
  messages: string[];
}

/** Aggregated error report for a single object that failed during execution. */
export interface ExecutionObjectError {
  /** API name of the object. */
  objectApiName: string;
  /** Stage where the failure happened — 'query' (read source), 'insert', 'scope'. */
  stage: 'query' | 'insert' | 'scope';
  /** Number of records that failed at this stage. */
  failedCount: number;
  /** Total records attempted at this stage (0 for 'scope' stage). */
  attemptedCount: number;
  /** Up to 3 sample failures (truncated to keep payloads UI-friendly). */
  samples: ExecutionErrorSample[];
}

/**
 * The rows of one object the target refused because it already held them.
 * Reported apart from created and failed rows: a linked row is neither.
 */
export interface ExistingRecordReport {
  /** API name of the object. */
  objectApiName: string;
  /** Rows mapped onto the record the refusal named; their children link to it. */
  linked: number;
  /**
   * Rows refused as duplicates without one record to trust. Counted as
   * failed, and their children lose the lookup.
   */
  unidentified: number;
}

/** Summary returned after execution completes. */
export interface ExecutionSummary {
  /** Number of records the run created. */
  successCount: number;
  /**
   * Records an upsert matched by their external id and wrote over: the target
   * held them before the run. Counted in neither `successCount` nor
   * `linkedCount`, and never among what the run created.
   */
  updatedCount: number;
  /**
   * Records the target already held, linked to and never written: the rows
   * it refused as duplicates and named, and reference data matched by name.
   * Counted in neither `successCount` nor `failedCount`.
   */
  linkedCount: number;
  /**
   * Records a dry run read and would have inserted. It writes nothing, so
   * they are counted here and never as created. Zero on a real run.
   */
  wouldInsertCount: number;
  /** Number of records that failed to insert. */
  failedCount: number;
  /** Number of skipped objects. */
  skippedCount: number;
  /** Total remapped IDs. */
  remapCount: number;
  /** Per-object error reports — populated whenever any record or object fails. */
  errors: ExecutionObjectError[];
  /**
   * Objects whose source read stopped on a bound rather than at the end of
   * the cursor: everything past the bound was never cloned. Empty on a run
   * that read every object whole.
   */
  truncatedObjects: string[];
  /**
   * Full source→target ID mapping table produced during execution. Lets
   * the caller audit which source-org record became which target-org
   * record (BA need: post-clone reconciliation, CSV export, or a "where
   * did this Account go on the new sandbox?" lookup). Always populated
   * — empty Record when no inserts succeeded. Persisted as part of the
   * checkpoint state for resume.
   */
  remapTable: Record<string, string>;
  /**
   * Per object, the rows the target refused because it already held them —
   * linked, or not identified. Empty when the target held none.
   */
  existingRecords: ExistingRecordReport[];
  /**
   * Source ids whose `remapTable` entry is a record the target already held:
   * linked to, matched by name, or the standard price book.
   */
  existingSourceIds: string[];
  /**
   * Source ids whose `remapTable` entry is a record an upsert matched by its
   * external id and wrote over. The table's other entries, neither these nor
   * `existingSourceIds`, are the records this run created.
   */
  updatedSourceIds: string[];
  /**
   * Per object, the rows of `remapTable` this run created and the ones it
   * linked to a record the target already held — the table counted by object.
   */
  remapByObject: ForgeRemapObjectCounts[];
  /**
   * Per object, the source ids of the rows this run created, in the order it
   * wrote them: what removing the run's records reads backwards.
   */
  createdByObject: ForgeCreatedRecords[];
  /**
   * What the run did with the files of the records it cloned — or, on a dry
   * run, would do. Absent when it was not asked to copy them.
   */
  files?: ForgeFilesReport;
}

/**
 * Per-`execute()` shared state threaded through the node pipeline. The
 * stages receive the slices they need; the executor stays the single owner
 * of counters, error reports and ID mappings.
 */
/**
 * What reading a node produced, held between the read pass and the write one.
 *
 * A record-scoped run reads outwards from the root and writes parents first,
 * and those two orders disagree: an object reached only through one of its own
 * children — a product behind a price book entry behind an opportunity's line
 * items — is read late and has to be written early. Holding the rows between
 * the passes is what lets each order be the one it needs to be.
 */
interface PrereadNode {
  /** Source-org field metadata for the node. */
  fieldInfos: FieldInfo[];
  /** Field names createable on the source org. */
  createableSet: Set<string>;
  /** The rows read from the source org. */
  records: Record<string, unknown>[];
  /**
   * A target describe started alongside the source query, or null when the
   * write does not follow straight away.
   */
  targetSetsPending: Promise<
    { ok: true; sets: TargetFieldSets } | { ok: false; error: unknown }
  > | null;
}

interface ExecutionState {
  /** Normalized stage configuration resolved from `ExecuteOptions`. */
  readonly config: ForgeStageConfig;
  readonly sourceOrgId: string;
  readonly targetOrgId: string;
  readonly graph: ForgeGraph;
  readonly onProgress: (event: ForgeProgressEvent) => void;
  readonly remapper: IdRemapper;
  /** Scope cache — `null` outside record-scoped mode. */
  readonly scopeCache: RecordScopeCache | null;
  /** Scoped SOQL builder — `null` outside record-scoped mode. */
  readonly scopedBuilder: ScopedSoqlBuilder | null;
  /** RecordType translator — `null` when no mappings were supplied. */
  readonly recordTypeMapper: RecordTypeMapper | null;
  readonly referenceDataMapper: ReferenceDataMapper;
  readonly orphanExpander: OrphanExpander;
  readonly batchWriter: BatchWriter;
  /** Objects whose downstream children must be skipped. */
  readonly failedObjects: Set<string>;
  readonly errors: ExecutionObjectError[];
  /** Objects whose source read hit a bound, in the order they were read. */
  readonly truncatedObjects: Set<string>;
  /** Nullified cycle FKs queued for the pass-2 UPDATE. */
  readonly pendingFkUpdates: PendingFkUpdate[];
  /**
   * Nodes that were out of scope when their turn came, to be asked again
   * once the rest of the graph has filled the scope cache.
   */
  readonly deferredNodes: ForgeGraphNode[];
  /**
   * Catalog nodes put off until the rest of the graph has been read, so
   * their scope is what the records read point at. See `CATALOG_READ_ORDER`.
   */
  readonly catalogNodes: ForgeGraphNode[];
  /** Rows read from the source, keyed by object, awaiting their write. */
  readonly preread: Map<string, PrereadNode>;
  /**
   * Objects this run reads or maps, the only ones a required lookup may hold
   * a scoped read to: the included nodes, and the standard price book's
   * object once that book is matched.
   */
  readonly readObjects: Set<string>;
  /**
   * Whether the run carries selling models, so a price keeps its own: a book
   * then holds one price per product and selling model, and a custom price
   * needs the standard one of its selling model.
   */
  readonly sellingModels: boolean;
  /**
   * The source org's standard price book, once looked up. `null` when the run
   * carries no price book entries, or when the lookup found nothing.
   */
  standardPricebookId: string | null;
  /** Rows the target already held, per object, in the order they were written. */
  readonly existingRecords: ExistingRecordReport[];
  /** Anonymizes a node's rows before insert; `null` when the run anonymizes nothing. */
  readonly anonymize: ((request: ForgeAnonymizeRequest) => Record<string, unknown>[]) | null;
  /** Per object no node knows the fields of, the personal fields the detector named. */
  readonly detectedPersonalFields: Map<string, string[]>;
  /**
   * Per object, the source ids of the rows read to be cloned: the records
   * whose files the run copies, when it is asked to. Empty otherwise.
   */
  readonly fileScope: Map<string, string[]>;
  /** What the run did with the files, kept up to date as it goes; `null` when it copies none. */
  files: ForgeFilesReport | null;
  successCount: number;
  updatedCount: number;
  linkedCount: number;
  wouldInsertCount: number;
  failedCount: number;
  skippedCount: number;
}

/** Whether an object with these fields prices from the catalog: one of them points at a price. */
function pricesFrom(fieldInfos: readonly FieldInfo[]): boolean {
  return fieldInfos.some(
    (f) => f.isReference && (f.referenceTo ?? []).includes(PRICEBOOK_ENTRY_OBJECT),
  );
}

/**
 * The objects a record of `objectApiName` cannot be written without: those
 * behind a required or master-detail edge of the graph, and those behind a
 * lookup its fields say it may not leave empty — which the graph can have
 * lost.
 */
function requiredParentsOf(
  objectApiName: string,
  graph: ForgeGraph,
  fieldInfos: readonly FieldInfo[],
): string[] {
  const parents = new Set(
    graph.edges
      .filter(
        (e) =>
          e.targetObject === objectApiName && (e.required === true || e.type === 'master-detail'),
      )
      .map((e) => e.sourceObject),
  );
  for (const field of fieldInfos) {
    if (!field.isReference || !isRequiredLookup(objectApiName, field.name, field.nillable))
      continue;
    for (const target of field.referenceTo ?? []) parents.add(target);
  }
  parents.delete(objectApiName);
  return [...parents];
}

/**
 * Executes a Forge plan by processing graph nodes in topological order.
 *
 * Thin orchestrator over the stage pipeline in `./stages/`:
 * ScopeResolver (ordering + SOQL) → OrphanExpander (single-hop parents) →
 * RecordCleaner (remap/nullify/strip) → BatchWriter (insert/upsert) →
 * CycleFkPatcher (pass-2 cycle FK UPDATE). For each included node the
 * executor queries records from the source org, lets the stages transform
 * and write them, and tracks new ID mappings. Errors on a parent cause
 * dependent children to be skipped.
 */
export class ForgeExecutor {
  private readonly deps: ForgeExecutorDeps;
  private isPaused = false;
  private pauseResolve: (() => void) | null = null;
  private isAborted = false;

  /** @param deps - Injected dependencies for org data operations. */
  constructor(deps: ForgeExecutorDeps) {
    this.deps = deps;
  }

  /** Pause execution between batches. Idempotent — calling twice is safe. */
  pause(): void {
    if (this.isPaused) return;
    this.isPaused = true;
  }

  /** Resume execution after pause. */
  resume(): void {
    this.isPaused = false;
    const resolver = this.pauseResolve;
    this.pauseResolve = null;
    resolver?.();
  }

  /** Abort execution. Resumes any paused state to propagate the abort. */
  abort(): void {
    this.isAborted = true;
    // Snapshot+null+invoke so a concurrent pause/resume can't leak the
    // promise resolver into a paused state from a previous run.
    const resolver = this.pauseResolve;
    this.pauseResolve = null;
    this.isPaused = false;
    resolver?.();
  }

  /**
   * Wait if paused, throw if aborted.
   * Called between batch iterations.
   */
  private async waitIfPaused(): Promise<void> {
    if (this.isAborted) {
      throw new ForgeAbortedError(
        'Forge execution was aborted by user request. No further batches will be processed.',
      );
    }
    if (!this.isPaused) {
      return;
    }
    await new Promise<void>((resolve) => {
      this.pauseResolve = resolve;
    });
    if (this.isAborted) {
      throw new ForgeAbortedError(
        'Forge execution was aborted while paused. No further batches will be processed.',
      );
    }
  }

  /**
   * Anonymize rows of `objectApiName` as the run asks: the fields selected on
   * the object's node, each with the method of its category — or, for an
   * object no node knows the fields of, the fields the run's detector names
   * in `fieldInfos`. Rows of an object with nothing selected, or of a run
   * that anonymizes nothing, are returned as they are.
   *
   * @param sourceIds - The source id of each row, index-aligned with `rows`.
   * @param fieldInfos - The object's source fields, for their types.
   * @param rename - Source to target field names: a renamed field is
   *   anonymized under the name the row holds it by.
   */
  private anonymizeRows(
    state: ExecutionState,
    objectApiName: string,
    rows: Record<string, unknown>[],
    sourceIds: string[],
    fieldInfos: FieldInfo[],
    rename: Record<string, string>,
  ): Record<string, unknown>[] {
    const anonymization = state.config.anonymization;
    if (!state.anonymize || !anonymization) return rows;
    const selected =
      anonymization.fields[objectApiName] ??
      this.detectedPersonalFields(state, anonymization, objectApiName, fieldInfos);
    if (selected.length === 0) return rows;
    const typeOf = new Map(fieldInfos.map((f) => [f.name, f.type ?? '']));
    return state.anonymize({
      objectApiName,
      records: rows,
      sourceIds,
      fields: selected.map((name) => ({
        name: rename[name] ?? name,
        type: typeOf.get(name) ?? '',
      })),
      methods: anonymization.methods,
    });
  }

  /**
   * The personal fields the run's detector names on an object no node knows
   * the fields of, named once per object and run: an orphan parent's fields
   * are asked for each parent fetched.
   */
  private detectedPersonalFields(
    state: ExecutionState,
    anonymization: ForgeRunAnonymization,
    objectApiName: string,
    fieldInfos: FieldInfo[],
  ): string[] {
    const known = state.detectedPersonalFields.get(objectApiName);
    if (known) return known;
    const named =
      anonymization.personalFieldsOf?.(
        fieldInfos.map((f) => ({ name: f.name, type: f.type ?? '' })),
      ) ?? [];
    state.detectedPersonalFields.set(objectApiName, named);
    return named;
  }

  /** Why this executor cannot copy files, or null when it can. */
  private fileCopyUnwired(): string | null {
    const { readFileBody, insertFile, remainingFileStorageMB } = this.deps;
    return readFileBody && insertFile && remainingFileStorageMB
      ? null
      : 'This session cannot copy files: it reads no file content or file storage. ' +
          'Nothing was read or written.';
  }

  /** What the file stage needs, from the executor's own deps; null when they are not wired. */
  private fileCopyDeps(): FileCopyDeps | null {
    const { readFileBody, insertFile, remainingFileStorageMB } = this.deps;
    if (!readFileBody || !insertFile || !remainingFileStorageMB) return null;
    return {
      queryRecords: (orgId, soql) => this.deps.queryRecords(orgId, soql),
      readFileBody,
      insertFile,
      insertRecords: this.deps.insertRecords,
      remainingFileStorageMB,
    };
  }

  /**
   * The anonymizer a run uses: the one injected, or one of the run's own —
   * so the fake values and hashes of one run are keyed apart from the next.
   */
  private anonymizerForRun(): (request: ForgeAnonymizeRequest) => Record<string, unknown>[] {
    if (this.deps.anonymize) return this.deps.anonymize;
    const anonymizer = new ForgeAnonymizer();
    return (request) => anonymizer.anonymize(request);
  }

  /**
   * Execute the forge plan for the given graph.
   *
   * @param graph - The dependency graph to execute.
   * @param sourceOrgId - ID of the source Salesforce org.
   * @param targetOrgId - ID of the target Salesforce org.
   * @param onProgress - Callback for progress events.
   * @returns Execution summary with counts.
   */
  async execute(
    graph: ForgeGraph,
    sourceOrgId: string,
    targetOrgId: string,
    onProgress: (event: ForgeProgressEvent) => void,
    options?: ExecuteOptions,
  ): Promise<ExecutionSummary> {
    this.isAborted = false;
    this.isPaused = false;
    this.pauseResolve = null;

    const config = resolveStageConfig(options);
    // A run asked to copy files that may not is refused before it reads
    // anything: stopped at the file stage instead, its records would already
    // be in the target without the files they were cloned for.
    if (config.files) {
      const refusal =
        fileCopyRefusal(config.anonymization !== undefined, config.files.acceptedAsIs) ??
        this.fileCopyUnwired();
      if (refusal) throw new ForgeFilesRefusedError(refusal);
    }
    const runGraph = await this.withSellingModelOptions(graph, sourceOrgId);
    const state: ExecutionState = {
      config,
      sourceOrgId,
      targetOrgId,
      graph: runGraph,
      onProgress,
      remapper: new IdRemapper(),
      scopeCache: config.isScoped ? new RecordScopeCache() : null,
      scopedBuilder: config.isScoped ? new ScopedSoqlBuilder() : null,
      // An empty mapping list still means "translate": the target org shares
      // no record type, and every RecordTypeId met must be reported as such.
      recordTypeMapper: config.recordTypeMappings ? new RecordTypeMapper() : null,
      referenceDataMapper: new ReferenceDataMapper((orgId, soql) =>
        this.deps.queryRecords(orgId, soql),
      ),
      orphanExpander: new OrphanExpander(this.deps),
      batchWriter: new BatchWriter(this.deps, this.deps.batchStrategy),
      failedObjects: new Set<string>(),
      errors: [],
      truncatedObjects: new Set<string>(),
      pendingFkUpdates: [],
      deferredNodes: [],
      catalogNodes: [],
      preread: new Map<string, PrereadNode>(),
      readObjects: new Set(runGraph.nodes.filter((n) => n.included).map((n) => n.objectApiName)),
      sellingModels: runGraph.nodes.some(
        (n) => n.included && n.objectApiName === SELLING_MODEL_OBJECT,
      ),
      standardPricebookId: null,
      existingRecords: [],
      anonymize: config.anonymization ? this.anonymizerForRun() : null,
      detectedPersonalFields: new Map<string, string[]>(),
      fileScope: new Map<string, string[]>(),
      files: null,
      successCount: 0,
      updatedCount: 0,
      linkedCount: 0,
      wouldInsertCount: 0,
      failedCount: 0,
      skippedCount: 0,
    };

    try {
      return await this.runPasses(state);
    } catch (err: unknown) {
      // What the run had done before it stopped goes with the error: thrown
      // bare, an abort or a failure past the first object took the tallies
      // with it, and the run was recorded as failed with nothing written.
      keepPartialSummary(err, this.summaryOf(state));
      throw err;
    }
  }

  /** The read and write passes of {@link execute}, over the state it opened. */
  private async runPasses(state: ExecutionState): Promise<ExecutionSummary> {
    const { config, graph, sourceOrgId, targetOrgId, onProgress } = state;

    if (state.scopeCache && config.rootRecordId && config.rootObjectApiName) {
      state.scopeCache.add(config.rootObjectApiName, [config.rootRecordId]);
    }

    const sortedNodes = sortNodesForExecution(
      graph,
      config.isScoped ? config.rootObjectApiName : undefined,
    );

    /**
     * A record-scoped run reads and writes in two separate passes.
     *
     * Reading has to start at the root and work outwards, because that is the
     * only direction in which the scope is known: an object is read through
     * the ids of something already read. Writing has to go the other way,
     * parents before children, because a lookup the platform will not let a
     * record omit cannot be filled in afterwards. Those two orders disagree
     * for any object reached only through one of its own children — a product
     * behind a price book entry behind an opportunity's line items — and one
     * pass can only satisfy one of them. Run for real against two sandboxes,
     * that disagreement is what left every line item of a cloned opportunity
     * refused for want of a price book entry that was written too late.
     *
     * A full-table run has no scope to resolve, so it keeps the single pass:
     * two would hold every row of every object in memory to no purpose —
     * unless it copies files, whose size is checked against the target's
     * storage before anything is written, which needs every record read.
     * A single pass's one order is the one writing needs.
     */
    const twoPhase = config.isScoped === true || config.files !== undefined;
    const runOrder = twoPhase ? sortedNodes : await this.singlePassOrder(state, sortedNodes);

    // The standard price book, when the run carries prices at all. See
    // `standard-pricebook.ts`: the platform refuses a custom price for a
    // product that has no standard one, and neither describe nor graph says
    // so. Best effort — a failure here costs the ordering, not the run.
    if (graph.nodes.some((n) => isPricebookEntry(n.objectApiName))) {
      try {
        const [sourceBook, targetBook] = await Promise.all([
          this.deps.queryRecords(sourceOrgId, STANDARD_PRICEBOOK_SOQL),
          this.deps.queryRecords(targetOrgId, STANDARD_PRICEBOOK_SOQL),
        ]);
        const sourceId = sourceBook[0]?.['Id'];
        const targetId = targetBook[0]?.['Id'];
        if (typeof sourceId === 'string' && typeof targetId === 'string') {
          state.standardPricebookId = sourceId;
          // Never cloned — every org has exactly one and it cannot be
          // created. Registered so entries pointing at it remap, as a record
          // the target already held: the run did not create it.
          state.remapper.addExisting(sourceId, targetId);
          // Among the books the run has, so a standard entry found under a
          // product in scope is not filtered out as belonging to a book
          // outside the graph. Matched and never reached, it brings none of
          // its own entries: those come by product, for the prices in hand.
          state.scopeCache?.add(PRICEBOOK_OBJECT, [sourceId]);
          // Matched rather than read, and the entries in it can be written
          // all the same, so it holds them in scope like a book that is read.
          state.readObjects.add(PRICEBOOK_OBJECT);
          // With no price book node to read, it is all the run will have of
          // the object: settled as read, a required lookup at a book stays
          // held to it instead of waiting for a read that never comes.
          if (!graph.nodes.some((n) => n.included && n.objectApiName === PRICEBOOK_OBJECT)) {
            state.scopeCache?.addRead(PRICEBOOK_OBJECT, []);
          }
        }
      } catch (err) {
        state.errors.push({
          objectApiName: PRICEBOOK_ENTRY_OBJECT,
          stage: 'scope',
          failedCount: 0,
          attemptedCount: 0,
          samples: [
            {
              recordSummary: '(standard price book lookup)',
              messages: [extractErrorMessage(err)],
            },
          ],
        });
      }
    }

    // Pre-flight: skip nodes the target org refuses to accept inserts on
    // (read-only system entities like Case History or audit-log variants).
    // The check is best-effort — when the dep is not provided we fall back
    // to the legacy behaviour of letting the runtime reject batch-by-batch.
    // The describes run in waves before the loop rather than one per node
    // awaited inside it, which made a large graph wait for each answer in turn
    // before the first record was written. Settled, so a describe that failed
    // is read below instead of rejecting the whole run. Abort is checked
    // between waves: nothing is written yet, but a user who hits Abort should
    // not wait for the describes of a graph that will not be executed, and the
    // node loop below turns the stop into ForgeAbortedError. A name left out of
    // the map falls through exactly as when the dep is absent.
    const creatableChecks = new Map<string, PromiseSettledResult<boolean>>();
    const isObjectCreatable = this.deps.isObjectCreatable;
    if (!config.dryRun && isObjectCreatable) {
      const names = [...new Set(sortedNodes.filter((n) => n.included).map((n) => n.objectApiName))];
      for (let i = 0; i < names.length; i += CONCURRENT_DESCRIBE_LIMIT) {
        if (this.isAborted) break;
        const wave = names.slice(i, i + CONCURRENT_DESCRIBE_LIMIT);
        const settled = await Promise.allSettled(
          wave.map(async (name) => isObjectCreatable(targetOrgId, name)),
        );
        wave.forEach((name, j) => creatableChecks.set(name, settled[j]));
      }
    }

    for (const node of runOrder) {
      // Abort is checked per node, not only per batch: waitIfPaused() runs
      // between batches, so a node small enough to fit one batch never reached
      // it, and the per-node catch below swallowed every error anyway — the
      // loop advanced to the next object and kept writing after Abort.
      //
      // Throwing rather than breaking keeps abort a single signal: the caller
      // sees ForgeAbortedError whether the user hit Abort mid-batch or between
      // objects, instead of a rejection in one case and a partial summary that
      // looks like success in the other.
      if (this.isAborted) {
        throw new ForgeAbortedError(
          'Forge execution was aborted by user request. Remaining objects were not processed.',
        );
      }

      if (!node.included) {
        state.skippedCount++;
        onProgress({
          objectName: node.objectApiName,
          status: 'skipped',
          progress: 100,
          message: `Skipped ${node.objectApiName} (excluded)`,
        });
        continue;
      }

      // Check if any parent object has failed
      const parentObjects = getParentObjects(node.objectApiName, graph);
      const hasFailedParent = parentObjects.some((p) => state.failedObjects.has(p));
      if (hasFailedParent) {
        state.skippedCount++;
        state.failedObjects.add(node.objectApiName);
        onProgress({
          objectName: node.objectApiName,
          status: 'skipped',
          progress: 100,
          message: `Skipped ${node.objectApiName} (parent failed)`,
        });
        continue;
      }

      const creatableCheck = creatableChecks.get(node.objectApiName);
      if (creatableCheck) {
        if (creatableCheck.status === 'fulfilled') {
          if (!creatableCheck.value) {
            state.skippedCount++;
            state.errors.push({
              objectApiName: node.objectApiName,
              stage: 'scope',
              failedCount: 0,
              attemptedCount: 0,
              samples: [
                {
                  recordSummary: '(node-level skip)',
                  messages: [`Object is not createable on target org`],
                },
              ],
            });
            onProgress({
              objectName: node.objectApiName,
              status: 'skipped',
              progress: 100,
              message: `Skipped ${node.objectApiName} (target org rejects inserts on this entity)`,
            });
            continue;
          }
        } else {
          const err: unknown = creatableCheck.reason;
          // Surface as a per-object error instead of silently dropping —
          // the user gets a clear hint when auth dropped or describe blocked.
          state.errors.push({
            objectApiName: node.objectApiName,
            stage: 'scope',
            failedCount: 0,
            attemptedCount: 0,
            samples: [
              {
                recordSummary: '(target describe failed)',
                messages: [
                  `isObjectCreatable check failed: ${err instanceof Error ? err.message : String(err)}`,
                ],
              },
            ],
          });
        }
      }

      if (twoPhase) {
        await this.readNode(node, state, true, false);
      } else if (await this.readNode(node, state, false, true)) {
        await this.writeNode(node, state);
      }
    }

    // A node can be an ancestor whose IDs are only knowable from a
    // descendant — an Opportunity's price book entry is reached through its
    // line items, not the other way round — and the execution order puts
    // parents first, so its turn came before anything could say which rows
    // it needed. Asked once more now that the pass has filled the cache, it
    // answers; asked and still out of scope, it reports as it always did.
    // One retry, not a loop: a second unscoped verdict means nothing read in
    // this run refers to the object at all.
    //
    // The catalog put off goes first, prices before products and books: a
    // price names its product and its book, and what the catalog points at
    // in turn — a selling model — is among the nodes asked again after it.
    const catalog = CATALOG_READ_ORDER.flatMap((name) =>
      state.catalogNodes.filter((n) => n.objectApiName === name),
    );
    const deferred = [...catalog, ...state.deferredNodes.splice(0, state.deferredNodes.length)];
    for (const node of deferred) {
      if (this.isAborted) {
        throw new ForgeAbortedError(
          'Forge execution was aborted by user request. Remaining objects were not processed.',
        );
      }
      // The retry does not relax the rule the first pass applied: a node
      // whose parent failed is still skipped, or the run writes children of
      // records that were never created.
      if (getParentObjects(node.objectApiName, graph).some((p) => state.failedObjects.has(p))) {
        state.skippedCount++;
        state.failedObjects.add(node.objectApiName);
        onProgress({
          objectName: node.objectApiName,
          status: 'skipped',
          progress: 100,
          message: `Skipped ${node.objectApiName} (parent failed)`,
        });
        continue;
      }
      if (twoPhase) {
        await this.readNode(node, state, false, false);
      } else if (await this.readNode(node, state, false, true)) {
        await this.writeNode(node, state);
      }
    }

    // The files of what was read, chosen and measured while nothing is
    // written yet: a run whose files do not fit in the target stops here.
    const filesToCopy = config.files ? await this.prepareFiles(state) : [];

    // The write pass. Every row is in hand, so the order is free to be the
    // one writing needs: parents first, the root no longer pulled to the
    // front because nothing is being scoped any more — and the catalog in the
    // order the platform takes it, which the fields read say more about than
    // the graph does.
    if (twoPhase) {
      for (const node of this.writeOrderOf(state)) {
        if (this.isAborted) {
          throw new ForgeAbortedError(
            'Forge execution was aborted by user request. Remaining objects were not processed.',
          );
        }
        // Nodes excluded, out of scope, resolved as reference data or read in
        // a dry run left nothing to write and have already reported.
        const read = state.preread.get(node.objectApiName);
        if (!read) continue;
        // Only a parent the rows cannot be written without takes them down.
        // Parents now come first wherever nothing but a cycle stands in the
        // way, and a failed optional one — the quote synced to an opportunity,
        // held back for its record type in a real org — skipped the
        // opportunity and every line behind it, where written first it had
        // gone in with that lookup left empty. It still is: the second pass
        // reports the lookup it could not fill in.
        if (
          requiredParentsOf(node.objectApiName, graph, read.fieldInfos).some((o) =>
            state.failedObjects.has(o),
          )
        ) {
          state.skippedCount++;
          state.failedObjects.add(node.objectApiName);
          onProgress({
            objectName: node.objectApiName,
            status: 'skipped',
            progress: 100,
            message: `Skipped ${node.objectApiName} (parent failed)`,
          });
          continue;
        }
        await this.writeNode(node, state);

        // Settle what this node's write has just made resolvable, before the
        // next one reads it. An opportunity's price book is nullified at
        // insert, and its line items are refused for want of it — waiting
        // until the end of the run is waiting until after they were written.
        if (state.pendingFkUpdates.length > 0 && !config.dryRun) {
          const owed = state.pendingFkUpdates.splice(0, state.pendingFkUpdates.length);
          const stillPending: PendingFkUpdate[] = [];
          const settled = await patchCycleFkUpdates({
            pendingFkUpdates: owed,
            remapper: state.remapper,
            updateRecords: this.deps.updateRecords,
            targetOrgId,
            enabled: true,
            onProgress,
            deferUnresolved: true,
            stillPending,
          });
          if (settled) state.errors.push(settled);
          state.pendingFkUpdates.push(...stillPending);
        }
      }
    }

    // Pass 2 — patch nullified cycle FKs whose targets are now cloned.
    const pass2Error = await patchCycleFkUpdates({
      pendingFkUpdates: state.pendingFkUpdates,
      remapper: state.remapper,
      updateRecords: this.deps.updateRecords,
      targetOrgId,
      enabled: !config.dryRun,
      onProgress,
    });
    if (pass2Error) {
      state.errors.push(pass2Error);
    }

    // Files come after the records they hang on: a file is published on the
    // record the run created, and there is nothing to publish it on before.
    if (filesToCopy.length > 0 && !config.dryRun) {
      await this.writeFiles(state, filesToCopy);
    }

    const orphanExpansionError = state.orphanExpander.buildErrorReport();
    if (orphanExpansionError) {
      state.errors.push(orphanExpansionError);
    }

    return this.summaryOf(state);
  }

  /**
   * The order a record-scoped run writes its nodes in, once every one of
   * them has been read: required parents first, and the catalog as
   * `catalogWriteEdges` lays it out — its lines being the nodes whose fields,
   * as read, point at a price.
   */
  private writeOrderOf(state: ExecutionState): ForgeGraphNode[] {
    return this.orderByFields(
      state,
      new Map([...state.preread].map(([objectApiName, read]) => [objectApiName, read.fieldInfos])),
    );
  }

  /**
   * Required parents first, and the catalog as `catalogWriteEdges` lays it
   * out, both read from the fields of the objects written.
   *
   * The graph keeps one edge per pair of objects, the first discovery met,
   * and when that was a parent's list of its children it says nothing of a
   * required lookup: in a real graph, the opportunity's line items, the
   * quote's lines and the order's items all read as optional. While the
   * order followed discovery's, the parent happened to come first. With
   * optional parents breaking ties, an opportunity that points at a quote
   * pointing back at it waited for it, and its line went first — refused for
   * want of the opportunity. The fields a run described say it plainly.
   *
   * @param fieldsByObject - The source fields of each object the run writes.
   */
  private orderByFields(
    state: ExecutionState,
    fieldsByObject: ReadonlyMap<string, readonly FieldInfo[]>,
  ): ForgeGraphNode[] {
    const objects = new Set(
      state.graph.nodes.filter((n) => n.included).map((n) => n.objectApiName),
    );
    const required: ForgeGraphEdge[] = [];
    const lines: string[] = [];
    for (const [child, fields] of fieldsByObject) {
      if (pricesFrom(fields)) lines.push(child);
      for (const field of fields) {
        if (!field.isReference || !isRequiredLookup(child, field.name, field.nillable)) continue;
        for (const parent of field.referenceTo ?? []) {
          if (parent === child || !objects.has(parent)) continue;
          required.push({
            sourceObject: parent,
            targetObject: child,
            relationshipName: field.name,
            type: 'lookup',
            required: true,
          });
        }
      }
    }
    return sortNodesForWriting(state.graph, [...required, ...catalogWriteEdges(objects, lines)]);
  }

  /**
   * The order a full-table run reads and writes its nodes in, one after the
   * other, when it carries prices: the order a record-scoped run writes them
   * in. Anything else keeps its parents-first order.
   *
   * A full-table run writes each node as soon as it has read it, so the order
   * is settled before anything is read — from the fields of every node,
   * described first, as a record-scoped run settles it from what it read.
   * Taken from the graph alone, a line at the edge of discovery, whose
   * lookups were never walked, went before the prices it could not be
   * written without, as it did in a record-scoped run. A node whose describe
   * fails is ordered as one with no lookup: its own read reports why.
   */
  private async singlePassOrder(
    state: ExecutionState,
    sortedNodes: ForgeGraphNode[],
  ): Promise<ForgeGraphNode[]> {
    const included = state.graph.nodes.filter((n) => n.included);
    if (!included.some((n) => isPricebookEntry(n.objectApiName))) return sortedNodes;
    const fieldsByObject = new Map<string, readonly FieldInfo[]>();
    for (let i = 0; i < included.length; i += CONCURRENT_DESCRIBE_LIMIT) {
      if (this.isAborted) break;
      const wave = included.slice(i, i + CONCURRENT_DESCRIBE_LIMIT);
      const settled = await Promise.allSettled(
        wave.map((node) => this.deps.describeFields(state.sourceOrgId, node.objectApiName)),
      );
      settled.forEach((described, j) => {
        if (described.status === 'fulfilled') {
          fieldsByObject.set(wave[j].objectApiName, described.value);
        }
      });
    }
    return this.orderByFields(state, fieldsByObject);
  }

  /**
   * The graph of a run, with the selling model options its prices need when
   * it carries prices, products and selling models and discovery left the
   * options out.
   *
   * They sit two levels past the line items that name the prices: out of
   * reach of the depth a clone of an opportunity is usually asked for, and
   * past the cap on any graph that walks further. Without them the platform
   * refused every price sold under a selling model, and every line item
   * behind the prices went with them. Added only when the source can describe
   * them — an org that sells by selling models has them — and never over a
   * node the user left out.
   */
  private async withSellingModelOptions(
    graph: ForgeGraph,
    sourceOrgId: string,
  ): Promise<ForgeGraph> {
    const included = (name: string): ForgeGraphNode | undefined =>
      graph.nodes.find((n) => n.included && n.objectApiName === name);
    const product = included(PRODUCT_OBJECT);
    const model = included(SELLING_MODEL_OBJECT);
    if (!included(PRICEBOOK_ENTRY_OBJECT) || !product || !model) return graph;
    if (graph.nodes.some((n) => n.objectApiName === SELLING_MODEL_OPTION_OBJECT)) return graph;
    let fields: FieldInfo[];
    try {
      fields = await this.deps.describeFields(sourceOrgId, SELLING_MODEL_OPTION_OBJECT);
    } catch {
      return graph;
    }
    const option: ForgeGraphNode = {
      objectApiName: SELLING_MODEL_OPTION_OBJECT,
      recordCount: 0,
      fieldCount: fields.length,
      status: 'idle',
      progress: 0,
      included: true,
      piiFields: [],
      anonymizeFields: [],
      level: Math.max(product.level, model.level) + 1,
      successCount: 0,
      failureCount: 0,
      errors: [],
      createableFieldCount: fields.filter((f) => f.createable).length,
      estimatedSizeMB: 0,
      estimatedApiCalls: 0,
      batchStrategy: 'auto',
    };
    const joins = (parent: string, field: string): ForgeGraphEdge => ({
      sourceObject: parent,
      targetObject: SELLING_MODEL_OPTION_OBJECT,
      relationshipName: field,
      type: 'lookup',
      required: true,
    });
    return {
      ...graph,
      nodes: [...graph.nodes, option],
      edges: [
        ...graph.edges,
        joins(PRODUCT_OBJECT, 'Product2Id'),
        joins(SELLING_MODEL_OBJECT, 'ProductSellingModelId'),
      ],
    };
  }

  /** What a run has done so far: the summary a finished run returns. */
  private summaryOf(state: ExecutionState): ExecutionSummary {
    return {
      successCount: state.successCount,
      updatedCount: state.updatedCount,
      linkedCount: state.linkedCount,
      wouldInsertCount: state.wouldInsertCount,
      failedCount: state.failedCount,
      skippedCount: state.skippedCount,
      remapCount: state.remapper.count,
      errors: [...state.errors],
      truncatedObjects: [...state.truncatedObjects],
      // BA reconciliation: dump the full source→target ID map so callers
      // can audit, export to CSV, or persist as part of a checkpoint.
      // toJSON returns a plain object (Record) so it serializes cleanly
      // through the bridge envelope.
      remapTable: state.remapper.toJSON(),
      existingRecords: [...state.existingRecords],
      existingSourceIds: state.remapper.existingSourceIds(),
      updatedSourceIds: state.remapper.updatedSourceIds(),
      remapByObject: state.remapper.countsByObject(),
      createdByObject: state.remapper.createdByObject(),
      ...(state.files ? { files: structuredClone(state.files) } : {}),
    };
  }

  /**
   * Choose the files of the records read and measure them against the
   * target, before anything is written.
   *
   * A file over the run's cap, or kept outside Salesforce, is left out and
   * listed. The rest are checked against the file storage the target has
   * left: a real run that would not fit stops here with nothing written, and
   * a dry run says so and lists what it would copy.
   *
   * @returns The files the write pass is to copy; none on a dry run.
   */
  private async prepareFiles(state: ExecutionState): Promise<FileToCopy[]> {
    const { config, onProgress } = state;
    const files = config.files;
    const deps = this.fileCopyDeps();
    if (!files || !deps) return [];
    const selection = await selectFiles({
      scope: state.fileScope,
      sourceOrgId: state.sourceOrgId,
      maxFileBytes: files.maxFileBytes,
      queryRecords: deps.queryRecords,
    });
    state.errors.push(...selection.errors);

    let remaining: number | undefined;
    if (selection.files.length > 0) {
      try {
        remaining = await remainingStorageBytes(deps, state.targetOrgId);
      } catch (err) {
        const reason =
          `The file storage the target has left could not be read (${extractErrorMessage(err)}), ` +
          'so the files could not be checked against it.';
        if (!config.dryRun) throw new ForgeFilesRefusedError(`${reason} Nothing was written.`);
        state.errors.push(filesRunError(reason));
      }
    }
    state.files = plannedFilesReport(selection, files.maxFileBytes, remaining);

    const shortfall =
      remaining === undefined ? null : storageShortfall(bytesOf(selection.files), remaining);
    if (shortfall && !config.dryRun) {
      throw new ForgeFilesRefusedError(`${shortfall} Nothing was written.`);
    }
    if (shortfall) state.errors.push(filesRunError(shortfall));

    if (config.dryRun) {
      state.files.wouldCopy = selection.files.map(({ objectApiName, sourceId, name, bytes }) => ({
        objectApiName,
        sourceId,
        name,
        bytes,
      }));
      for (const entry of state.files.objects) {
        onProgress({
          objectName: entry.objectApiName,
          status: 'done',
          progress: 100,
          message: dryRunLine(entry),
        });
      }
      return [];
    }
    return selection.files;
  }

  /** Write the files chosen before the write pass, after the records they hang on. */
  private async writeFiles(state: ExecutionState, files: FileToCopy[]): Promise<void> {
    const deps = this.fileCopyDeps();
    if (!deps || !state.files) return;
    state.failedCount += await copyFiles({
      files,
      sourceOrgId: state.sourceOrgId,
      targetOrgId: state.targetOrgId,
      remapper: state.remapper,
      deps,
      report: state.files,
      errors: state.errors,
      waitIfPaused: () => this.waitIfPaused(),
      onProgress: state.onProgress,
    });
  }

  /**
   * Read one node from the source org: describe its fields, resolve its
   * scope, query its rows, and seed the scope cache with what they point at.
   *
   * Returns true when the node has rows the write stage should carry. The
   * branches that finish here — out of scope, reference data resolved by
   * name, a dry run — return false having already reported themselves.
   *
   * `prefetchTargetDescribe` starts the target-org describe alongside the
   * source query, which saves a round-trip when the write follows straight
   * away. A two-phase run leaves it off: every node would describe at once,
   * against an org that has not been asked for a single row yet.
   */
  private async readNode(
    node: ForgeGraphNode,
    state: ExecutionState,
    allowDefer: boolean,
    prefetchTargetDescribe: boolean,
  ): Promise<boolean> {
    const { config, sourceOrgId, targetOrgId, onProgress, remapper } = state;
    try {
      // Step 1: Scanning — describe fields to build SOQL and filter sets
      onProgress({
        objectName: node.objectApiName,
        status: 'scanning',
        progress: 0,
        message: `Querying ${node.objectApiName} records...`,
      });

      const fieldInfos = await this.deps.describeFields(sourceOrgId, node.objectApiName);
      const createableSet = new Set(fieldInfos.filter((f) => f.createable).map((f) => f.name));

      const query = buildNodeQuery({
        node,
        edges: state.graph.edges,
        fieldInfos,
        scopedBuilder: state.scopedBuilder,
        scopeCache: state.scopeCache,
        rootObjectApiName: config.rootObjectApiName,
        rootRecordId: config.rootRecordId,
        extraWhere: config.objectSoqlFilters?.[node.objectApiName],
        maxRecordsPerObject: config.maxRecordsPerObject,
        readObjects: state.readObjects,
        catalog: CATALOG_OBJECTS,
      });
      if (allowDefer && this.waitsForWhatPointsAtIt(node, query, state)) {
        state.catalogNodes.push(node);
        return false;
      }
      if (query.kind === 'skip') {
        if (allowDefer && query.reason === UNSCOPED_NO_PARENT_REASON) {
          state.deferredNodes.push(node);
          return false;
        }
        state.skippedCount++;
        state.errors.push({
          objectApiName: node.objectApiName,
          stage: 'scope',
          failedCount: 0,
          attemptedCount: 0,
          samples: [{ recordSummary: '(no record queried)', messages: [query.reason] }],
        });
        onProgress({
          objectName: node.objectApiName,
          status: 'skipped',
          progress: 100,
          message: `Skipped ${node.objectApiName} (out of scope: ${query.reason})`,
        });
        return false;
      }

      // The target describe does not depend on the source rows, so it runs
      // while they are read instead of after: one round-trip less of waiting
      // per node. It is settled into a value here and read below, so a failed
      // describe cannot surface as an unhandled rejection when the query fails
      // first. Only started on the path that writes.
      const writes =
        prefetchTargetDescribe &&
        !config.dryRun &&
        !config.referenceDataObjects.has(node.objectApiName);
      const targetSetsPending = writes
        ? describeTargetFieldSets(this.deps.describeFields, targetOrgId, node.objectApiName).then(
            (sets) => ({ ok: true as const, sets }),
            (error: unknown) => ({ ok: false as const, error }),
          )
        : null;

      const reached = state.scopeCache ? new Set<string>() : undefined;
      const records = await queryNodeRecords(
        query,
        (soql) =>
          this.deps.queryRecords(sourceOrgId, soql, () =>
            state.truncatedObjects.add(node.objectApiName),
          ),
        reached,
      );
      if (reached) state.scopeCache?.addReached(node.objectApiName, reached);

      // Reference-data branch: resolve source IDs against target rows by
      // Name/DeveloperName instead of cloning. Adds entries to the IdRemapper
      // so downstream FKs pick up the correct target IDs naturally. A dry run
      // takes it too: it only reads the target, and skipped, the dry run
      // listed as "would be inserted" rows a real run links.
      if (config.referenceDataObjects.has(node.objectApiName)) {
        const refResolve = await state.referenceDataMapper.resolve(
          node.objectApiName,
          records,
          targetOrgId,
        );
        // Records the target already held, found by name: linked, never
        // created. Counted as created, they inflated what the run said it wrote.
        for (const m of refResolve.mappings) {
          remapper.addExisting(m.sourceId, m.targetId);
        }
        if (refResolve.unmatched.length > 0) {
          state.errors.push({
            objectApiName: node.objectApiName,
            stage: 'scope',
            failedCount: refResolve.unmatched.length,
            attemptedCount: records.length,
            samples: refResolve.unmatched.slice(0, 3).map((u) => ({
              recordSummary: `Id=${u.sourceId} matchValue=${u.matchValue ?? 'null'}`,
              messages: [`Reference-data row not found on target org`],
            })),
          });
        }
        // Still seed the scope cache so FK propagation works.
        if (state.scopeCache) {
          seedOwnIds(state.scopeCache, node.objectApiName, records);
        }
        state.linkedCount += refResolve.mappings.length;
        onProgress({
          objectName: node.objectApiName,
          status: 'done',
          progress: 100,
          message: `Mapped ${node.objectApiName} via reference-data lookup: ${refResolve.mappings.length} resolved, ${refResolve.unmatched.length} unmatched`,
        });
        return false;
      }

      // The standard price book is matched, never cloned: every org has
      // exactly one, it cannot be created, and the two were registered with
      // each other before anything was read. Left in, it was inserted like
      // any other book — a second "Standard Price Book" in the target on
      // every run, and a remapper entry that overwrote the match, so the
      // standard entries went to the copy and the platform refused them.
      if (node.objectApiName === PRICEBOOK_OBJECT && state.standardPricebookId) {
        const standardId = state.standardPricebookId;
        const kept = records.filter((r) => r['Id'] !== standardId);
        if (kept.length !== records.length) {
          records.length = 0;
          records.push(...kept);
        }
      }

      // A price book entry is usually read by id — the line items that point
      // at it put it in scope — so the standard entry of the same product is
      // never among the rows, and the platform will not take the custom price
      // without it. Ask for them by name, for exactly the products in hand.
      if (isPricebookEntry(node.objectApiName) && state.standardPricebookId) {
        await this.addStandardPricebookEntries(node, state, records, fieldInfos);
        // A book holds one entry per product — per product and selling model
        // when the run keeps them — and the target enforces that on insert
        // whatever `IsActive` says. The source can still hold two.
        const deduped = dedupePricebookEntries(records, { sellingModel: state.sellingModels });
        if (deduped.length !== records.length) {
          records.length = 0;
          records.push(...deduped);
        }
      }

      if (state.scopeCache) {
        seedScopeCache(state.scopeCache, node.objectApiName, records, fieldInfos);
      }

      // The records whose files the run copies: the ones it read to clone,
      // never those of an object mapped by name or of the standard book.
      if (config.files) {
        const ids = records.flatMap((r) => (typeof r['Id'] === 'string' ? [r['Id']] : []));
        state.fileScope.set(node.objectApiName, ids);
      }

      if (config.dryRun) {
        onProgress({
          objectName: node.objectApiName,
          status: 'done',
          progress: 100,
          message: `[dry-run] ${node.objectApiName}: ${records.length} record(s) would be inserted`,
        });
        // Counted under their own name: a dry run creates nothing.
        state.wouldInsertCount += records.length;
        return false;
      }

      state.preread.set(node.objectApiName, {
        fieldInfos,
        createableSet,
        records,
        targetSetsPending,
      });
      return true;
    } catch (err) {
      // An abort is a control-flow signal, not a node failure. Recording it as
      // one and continuing is what let a cancelled run carry on writing.
      if (err instanceof ForgeAbortedError) {
        throw err;
      }
      state.failedObjects.add(node.objectApiName);
      state.failedCount += node.recordCount;
      state.errors.push({
        objectApiName: node.objectApiName,
        stage: 'query',
        failedCount: node.recordCount,
        attemptedCount: node.recordCount,
        samples: [
          { recordSummary: '(stage failed before insert)', messages: [extractErrorMessage(err)] },
        ],
      });
      onProgress({
        objectName: node.objectApiName,
        status: 'error',
        progress: 100,
        message: `Error on ${node.objectApiName}: ${extractErrorMessage(err)}`,
      });
      return false;
    }
  }

  /**
   * Whether a node of the catalog waits until the rest of the graph has been
   * read, to be read by what the records point at (`CATALOG_READ_ORDER`).
   *
   * It waits when nothing reaches it from above: it is not the root, and no
   * parent in scope brings any of its rows. Its turn in parents-first order
   * comes before the line items that say which prices they use, so read then
   * it could only go by the rows named so far, and miss the ones named after.
   * Reached from above — the prices of the book a clone is rooted at — it is
   * read at its turn as before.
   */
  private waitsForWhatPointsAtIt(
    node: ForgeGraphNode,
    query: NodeQueryResult,
    state: ExecutionState,
  ): boolean {
    if (!state.scopeCache || !CATALOG_OBJECTS.has(node.objectApiName)) return false;
    return query.kind === 'skip' || !readsFromAbove(query);
  }

  /**
   * Add the standard price book entries for the products these rows price.
   *
   * Salesforce refuses a custom price for a product with no standard one, and
   * nothing in the graph says so: `PricebookEntry` is an ordinary child of
   * two parents, and the refusal arrives at the insert as
   * `STANDARD_PRICE_NOT_DEFINED`. The rows already in hand are the ones some
   * line item points at, all of them in custom books, so the standard entries
   * have to be asked for on their own.
   *
   * Mutates `records` in place — the caller has already settled what it read,
   * and these belong to the same node. Rows already present are not fetched
   * twice, and a failure here leaves the run as it was: the custom prices
   * will be refused, which is what happened before this existed.
   *
   * A run that keeps selling models takes, of a product's standard prices,
   * the ones of the selling models its custom prices are sold under: that is
   * the standard price each needs. A real org held two per product — the
   * price from before selling models, deactivated, and the one-time one.
   */
  private async addStandardPricebookEntries(
    node: ForgeGraphNode,
    state: ExecutionState,
    records: Record<string, unknown>[],
    fieldInfos: FieldInfo[],
  ): Promise<void> {
    const standardId = state.standardPricebookId;
    if (!standardId) return;
    const pairOf = (row: Record<string, unknown>): string =>
      `${String(row[PRICEBOOK_ENTRY_PRODUCT_FIELD])}|${String(row[PRICEBOOK_ENTRY_SELLING_MODEL_FIELD] ?? '')}`;
    const productIds = new Set<string>();
    const pricedPairs = new Set<string>();
    const seen = new Set<string>();
    for (const record of records) {
      const id = record['Id'];
      if (typeof id === 'string') seen.add(id);
      if (record[PRICEBOOK_ENTRY_BOOK_FIELD] === standardId) continue;
      const productId = record[PRICEBOOK_ENTRY_PRODUCT_FIELD];
      if (typeof productId === 'string' && productId) {
        productIds.add(productId);
        pricedPairs.add(pairOf(record));
      }
    }
    if (productIds.size === 0) return;

    const fields = fieldInfos.filter((f) => f.queryable).map((f) => f.name);
    const selectList = (fields.length > 0 ? fields : ['Id'])
      .map((f) => assertSoqlIdentifier(f))
      .join(', ');
    const inList = [...productIds].map((id) => `'${sanitizeSoqlValue(id)}'`).join(', ');
    const soql =
      `SELECT ${selectList} FROM ${assertSoqlIdentifier(node.objectApiName)} ` +
      `WHERE ${PRICEBOOK_ENTRY_BOOK_FIELD} = '${sanitizeSoqlValue(standardId)}' ` +
      `AND Product2Id IN (${inList})`;

    try {
      const standardRows = await this.deps.queryRecords(state.sourceOrgId, soql);
      let added = 0;
      for (const row of standardRows) {
        const id = row['Id'];
        if (typeof id === 'string' && seen.has(id)) continue;
        if (state.sellingModels && !pricedPairs.has(pairOf(row))) continue;
        records.push(row);
        added++;
      }
      if (added > 0) {
        state.onProgress({
          objectName: node.objectApiName,
          status: 'scanning',
          progress: 50,
          message: `Added ${added} standard price book entr${added === 1 ? 'y' : 'ies'} the custom prices depend on`,
        });
      }
    } catch (err) {
      state.errors.push({
        objectApiName: node.objectApiName,
        stage: 'scope',
        failedCount: 0,
        attemptedCount: 0,
        samples: [
          {
            recordSummary: '(standard price book entries)',
            messages: [extractErrorMessage(err)],
          },
        ],
      });
    }
  }

  /**
   * The key prefix and record types of the node's object in the target org,
   * or `null` when the run has no way to read them. Best effort: a describe
   * that failed has already been reported by the field-set check.
   */
  private async describeTargetObject(
    targetOrgId: string,
    objectApiName: string,
  ): Promise<TargetObjectInfo | null> {
    if (!this.deps.describeObject) return null;
    try {
      return await this.deps.describeObject(targetOrgId, objectApiName);
    } catch {
      return null;
    }
  }

  /**
   * The record types among those the node's records will be sent with that
   * the running user may not use in the target org.
   *
   * Read from the values as they will be sent — translated by the record
   * type mapping — and only when `RecordTypeId` is sent at all: a field
   * neither org lets the user write is dropped, and excluding or renaming it
   * is how a user hands the choice to the platform, which then gives the
   * running user's default.
   */
  private recordTypesHeldBack(
    node: ForgeGraphNode,
    records: Record<string, unknown>[],
    target: TargetObjectInfo | null,
    creatable: ReadonlySet<string>,
    state: ExecutionState,
  ): UnavailableRecordTypeUse[] {
    const { config } = state;
    if (!target || target.recordTypes.length === 0) return [];
    if (!creatable.has('RecordTypeId')) return [];
    if ((config.fieldExclusions[node.objectApiName] ?? []).includes('RecordTypeId')) return [];
    if (config.fieldMappings[node.objectApiName]?.['RecordTypeId']) return [];
    let sent: Record<string, unknown>[] = records.map((r) => ({ RecordTypeId: r['RecordTypeId'] }));
    if (state.recordTypeMapper && config.recordTypeMappings) {
      sent = state.recordTypeMapper.apply(sent, config.recordTypeMappings);
    }
    return findUnavailableRecordTypes(node.objectApiName, sent, target.recordTypes);
  }

  /**
   * Write one node the read stage has already pulled: describe the target
   * org, hold the node back when its record types are closed to the running
   * user, expand orphan parents, clean, translate record types, anonymize
   * and insert.
   */
  private async writeNode(node: ForgeGraphNode, state: ExecutionState): Promise<void> {
    const { config, sourceOrgId, targetOrgId, onProgress, remapper } = state;
    const read = state.preread.get(node.objectApiName);
    if (!read) return;
    const { fieldInfos, createableSet, records, targetSetsPending } = read;
    try {
      // Step 2: describe the *target* org (schema-drift defense) — the only
      // way to detect missing fields/picklist drift before insert.
      let targetCreatableSet: Set<string> | null = null;
      let targetPicklistValuesByField: Map<string, Set<string>> | null = null;
      const targetSets = await (targetSetsPending ??
        describeTargetFieldSets(this.deps.describeFields, targetOrgId, node.objectApiName).then(
          (sets) => ({ ok: true as const, sets }),
          (error: unknown) => ({ ok: false as const, error }),
        ));
      if (targetSets.ok) {
        targetCreatableSet = targetSets.sets.creatable;
        targetPicklistValuesByField = targetSets.sets.picklistValuesByField;
      } else {
        // Surface schema-drift defense failure: target describe is the
        // *only* way to detect missing fields/picklist drift before
        // insert. Without this signal the user sees cryptic INVALID_FIELD
        // and can't tell if it's drift or auth.
        const err = targetSets.error;
        state.errors.push({
          objectApiName: node.objectApiName,
          stage: 'scope',
          failedCount: 0,
          attemptedCount: 0,
          samples: [
            {
              recordSummary: '(target describe failed — falling back to source schema)',
              messages: [err instanceof Error ? err.message : String(err)],
            },
          ],
        });
      }
      const effectiveCreatableSet = targetCreatableSet
        ? intersect(createableSet, targetCreatableSet)
        : createableSet;

      // Read from the describe the field sets came from: no second request.
      const targetObject = await this.describeTargetObject(targetOrgId, node.objectApiName);

      // A record type can be active in the target and still be closed to the
      // user the run writes as. Found out at the insert, every record of it
      // was refused with an INVALID_CROSS_REFERENCE_KEY that names the id and
      // not the reason, and the objects under it were written against parents
      // that were not there. Held back here instead, whole, before anything
      // is written for it — orphan parents included — with the change to make
      // in the target. Forge maps record types and never drops one, so there
      // is no default to fall back to without the user choosing it: excluding
      // `RecordTypeId` for the object is that choice.
      const heldBack = this.recordTypesHeldBack(
        node,
        records,
        targetObject,
        effectiveCreatableSet,
        state,
      );
      if (heldBack.length > 0) {
        state.failedObjects.add(node.objectApiName);
        state.failedCount += records.length;
        state.errors.push({
          objectApiName: node.objectApiName,
          stage: 'scope',
          failedCount: records.length,
          attemptedCount: 0,
          // One sample per record type: an object has few, and each needs its
          // own change in the target.
          samples: heldBack.map((use) => ({
            recordSummary: `RecordType=${use.developerName} (${use.recordCount} record${use.recordCount === 1 ? '' : 's'})`,
            messages: [recordTypeBlockedMessage(use)],
          })),
        });
        onProgress({
          objectName: node.objectApiName,
          status: 'error',
          progress: 100,
          message:
            `Held back ${node.objectApiName}, nothing written: ` +
            heldBack.map(recordTypeBlockedReason).join(' ') +
            ' Objects that cannot be written without it will be skipped.',
        });
        return;
      }

      // Single-hop orphan parent expansion. Runs before the
      // clean stage so expanded parents land in the remapper and children
      // pick up the new target ID instead of orphan-nullifying.
      await state.orphanExpander.expandForNode({
        node,
        fieldInfos,
        records,
        sourceOrgId,
        targetOrgId,
        remapper,
        scopeCache: state.scopeCache,
        recordTypeMappings: config.recordTypeMappings,
        recordTypeMapper: state.recordTypeMapper,
        enabled: config.expandOrphanParents,
        maxExpansions: config.maxOrphanParentExpansions,
        anonymize: state.anonymize
          ? (objectApiName, payload, sourceId, parentFields) =>
              this.anonymizeRows(state, objectApiName, [payload], [sourceId], parentFields, {})[0]
          : undefined,
      });

      const cleanedRecords = cleanNodeRecords({
        objectApiName: node.objectApiName,
        records,
        fieldInfos,
        remapper,
        referenceFallback: config.referenceFallback,
        ownerMappings: config.ownerMappings,
        // Per-node field exclusions and renames are record-invariant —
        // resolved once per node rather than per record.
        excludedFields: new Set(config.fieldExclusions[node.objectApiName] ?? []),
        fieldRename: config.fieldMappings[node.objectApiName] ?? {},
        creatableFields: effectiveCreatableSet,
        picklistValuesByField: targetPicklistValuesByField,
      });
      let recordsToInsert = cleanedRecords.map((b) => b.cleaned);
      if (state.recordTypeMapper && config.recordTypeMappings) {
        recordsToInsert = state.recordTypeMapper.apply(
          recordsToInsert,
          config.recordTypeMappings,
          (recordTypeId) => warnUnmappedRecordType(node.objectApiName, recordTypeId),
        );
      }

      // Step 2b: anonymize the fields selected on the node, each with the
      // method Review holds for its category. After the rename, under the
      // name the field is written by.
      recordsToInsert = this.anonymizeRows(
        state,
        node.objectApiName,
        recordsToInsert,
        cleanedRecords.map((c) => String(c.source['Id'] ?? '')),
        fieldInfos,
        config.fieldMappings[node.objectApiName] ?? {},
      );

      // Step 3: Running — batch and insert into target.
      //
      // Price book entries go in two rounds, standard book first: Salesforce
      // refuses a custom price for a product that has no standard one, and
      // one request cannot be relied on to settle its own rows in order. The
      // two arrays are index-aligned all the way from `cleanNodeRecords`
      // (record-type translation and anonymization both map in place), so the
      // split is made on positions and applied to both.
      const rounds: Array<{ records: Record<string, unknown>[]; cleaned: typeof cleanedRecords }> =
        [];
      if (isPricebookEntry(node.objectApiName) && state.standardPricebookId) {
        const positions = cleanedRecords.map((_, index) => index);
        const { standard, custom } = splitStandardPricebookEntries(
          positions.map((index) => ({
            index,
            [PRICEBOOK_ENTRY_BOOK_FIELD]: cleanedRecords[index].source[
              PRICEBOOK_ENTRY_BOOK_FIELD
            ] as unknown,
          })),
          state.standardPricebookId,
        );
        for (const group of [standard, custom]) {
          if (group.length === 0) continue;
          rounds.push({
            records: group.map((g) => recordsToInsert[g.index as number]),
            cleaned: group.map((g) => cleanedRecords[g.index as number]),
          });
        }
      }
      if (rounds.length === 0) {
        rounds.push({ records: recordsToInsert, cleaned: cleanedRecords });
      }

      const writeResult = {
        successCount: 0,
        updatedCount: 0,
        linkedExistingCount: 0,
        failureCount: 0,
        alreadyExistsCount: 0,
        unidentifiedExistingCount: 0,
        errorSamples: [] as ExecutionErrorSample[],
        pendingFkUpdates: [] as PendingFkUpdate[],
      };
      for (const round of rounds) {
        const partial = await state.batchWriter.writeNode({
          node,
          records: round.records,
          cleanedRecords: round.cleaned,
          fieldInfos,
          creatableFields: effectiveCreatableSet,
          upsertMode: config.upsertMode,
          targetOrgId,
          targetKeyPrefix: targetObject?.keyPrefix,
          remapper,
          waitIfPaused: () => this.waitIfPaused(),
          onProgress,
        });
        writeResult.successCount += partial.successCount;
        writeResult.updatedCount += partial.updatedCount;
        writeResult.linkedExistingCount += partial.linkedExistingCount;
        writeResult.failureCount += partial.failureCount;
        writeResult.alreadyExistsCount += partial.alreadyExistsCount;
        writeResult.unidentifiedExistingCount += partial.unidentifiedExistingCount;
        writeResult.pendingFkUpdates.push(...partial.pendingFkUpdates);
        for (const sample of partial.errorSamples) {
          if (writeResult.errorSamples.length < 3) writeResult.errorSamples.push(sample);
        }
      }
      const nodeSuccess = writeResult.successCount;
      const nodeUpdated = writeResult.updatedCount;
      const nodeLinked = writeResult.linkedExistingCount;
      const nodeFailure = writeResult.failureCount;
      const nodeUnidentified = writeResult.unidentifiedExistingCount;
      state.successCount += nodeSuccess;
      state.updatedCount += nodeUpdated;
      state.linkedCount += nodeLinked;
      state.failedCount += nodeFailure;
      state.pendingFkUpdates.push(...writeResult.pendingFkUpdates);
      if (nodeLinked > 0 || nodeUnidentified > 0) {
        state.existingRecords.push({
          objectApiName: node.objectApiName,
          linked: nodeLinked,
          unidentified: nodeUnidentified,
        });
      }

      if (nodeFailure > 0) {
        state.errors.push({
          objectApiName: node.objectApiName,
          stage: 'insert',
          failedCount: nodeFailure,
          attemptedCount: nodeSuccess + nodeUpdated + nodeLinked + nodeFailure,
          samples: writeResult.errorSamples,
        });
      }

      // Fail-fast on partial-but-mostly-failure: if >50% of records
      // failed, mark the node as failed so downstream children skip
      // (their FKs would orphan-nullify and silently corrupt the clone).
      // A row linked to the record the target already held is not a failure:
      // its children have a parent to point at.
      const settled = nodeSuccess + nodeUpdated + nodeLinked;
      const total = settled + nodeFailure;
      const failureRate = total > 0 ? nodeFailure / total : 0;
      // A node whose every failure was the target already holding the row has
      // not orphaned anything: what its children point at is there, it simply
      // was not this run that put it there. Marking it failed took whole
      // subtrees down for nothing — a `ProductSellingModel` the target
      // already had cost every price book entry and every line item behind
      // them. Reported as failed, because the rows were not written; not
      // counted as a failed parent, because nothing is missing.
      const onlyAlreadyExists = nodeFailure > 0 && writeResult.alreadyExistsCount === nodeFailure;
      if (nodeFailure > 0 && !onlyAlreadyExists && (settled === 0 || failureRate > 0.5)) {
        state.failedObjects.add(node.objectApiName);
        onProgress({
          objectName: node.objectApiName,
          status: 'error',
          progress: 100,
          message:
            settled === 0
              ? `Failed all ${node.objectApiName} records`
              : `${nodeFailure}/${total} ${node.objectApiName} records failed (>50%) — children will be skipped`,
        });
      } else {
        // The rows the target already held are named apart: linked is neither
        // written nor failed, and a duplicate the run could not identify is a
        // failure whose children lose their lookup — worth saying on its own.
        const linked =
          nodeLinked > 0 ? `, ${nodeLinked} linked to records already in the target` : '';
        const updated = nodeUpdated > 0 ? `, ${nodeUpdated} updated through their external id` : '';
        const unidentified =
          nodeUnidentified > 0
            ? ` (${nodeUnidentified} already in the target without Salesforce naming the record — their children lose the link)`
            : '';
        onProgress({
          objectName: node.objectApiName,
          status: 'done',
          progress: 100,
          message: `Completed ${node.objectApiName}: ${nodeSuccess} succeeded${updated}${linked}, ${nodeFailure} failed${unidentified}`,
        });
      }
    } catch (err) {
      // An abort is a control-flow signal, not a node failure. Recording it as
      // one and continuing is what let a cancelled run carry on writing.
      if (err instanceof ForgeAbortedError) {
        throw err;
      }
      state.failedObjects.add(node.objectApiName);
      state.failedCount += node.recordCount;
      state.errors.push({
        objectApiName: node.objectApiName,
        stage: 'query',
        failedCount: node.recordCount,
        attemptedCount: node.recordCount,
        samples: [
          { recordSummary: '(stage failed before insert)', messages: [extractErrorMessage(err)] },
        ],
      });
      onProgress({
        objectName: node.objectApiName,
        status: 'error',
        progress: 100,
        message: `Error on ${node.objectApiName}: ${extractErrorMessage(err)}`,
      });
    }
  }
}
