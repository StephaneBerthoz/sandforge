import type {
  ForgeCreatedRecords,
  ForgeFieldsLeftOut,
  ForgeFilesReport,
  ForgeGraph,
  ForgeGraphEdge,
  ForgeGraphNode,
  ForgeNodeStatus,
  ForgeRemapObjectCounts,
  ForgeWrittenBetween,
} from '@sandforge/shared';
import { fileCopyRefusal, isFileContentField } from '@sandforge/shared';
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
  sortNodesForExecution,
  sortNodesForWriting,
  type NodeQueryInput,
  type NodeQueryResult,
} from './stages/ScopeResolver.js';
import { OrphanExpander } from './stages/OrphanExpander.js';
import {
  cleanNodeRecords,
  describeTargetFieldSets,
  intersect,
  type TargetFieldSets,
} from './stages/RecordCleaner.js';
import {
  BatchWriter,
  WRITE_API_MAX_BATCH,
  emptyBatchWriteResult,
  type BatchWriteResult,
  type PendingFkUpdate,
} from './stages/BatchWriter.js';
import {
  STATUS_LIFECYCLES,
  draftStartOf,
  statusCategories,
  type StatusCategories,
} from '../../core/common/platformRecords.js';
import { UNSCOPED_NO_PARENT_REASON } from './ScopedSoqlBuilder.js';
import { assertSoqlIdentifier } from '../../core/common/soqlValidator.js';
import { idLists } from '../dataops/RecordRemoval.js';
import {
  PRICEBOOK_ENTRY_OBJECT,
  PRICEBOOK_OBJECT,
  STANDARD_PRICEBOOK_SOQL,
  PRICEBOOK_ENTRY_BOOK_FIELD,
  PRICEBOOK_ENTRY_PRODUCT_FIELD,
  PRICEBOOK_ENTRY_SELLING_MODEL_FIELD,
  PRICEBOOK_ENTRY_CURRENCY_FIELD,
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
  lookupFailure,
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
   * Either way, a reference to an object that failed in the run is emptied
   * and reported by the second pass: see `cleanNodeRecords`.
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
   * rather than failing record-by-record at runtime — with an error when
   * the clone holds records of them, which it then cannot write.
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
  /**
   * Per object with records to write, the fields left out because they hold a
   * file's content: read, each gave its file's address, which written back
   * would have stood where the content belongs. Absent when there were none.
   */
  fileContentFieldsLeftOut?: ForgeFieldsLeftOut[];
  /**
   * When the target dated the run's writes, read from the records it created
   * once it had written them. Absent when it created nothing, or on a dry run.
   */
  writtenBetween?: ForgeWrittenBetween;
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
  /**
   * Objects the target refuses inserts on: read for whether the clone holds
   * any record of them, never written. Empty on a dry run, which asks nothing.
   */
  readonly notCreatable: Set<string>;
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
   * Catalog nodes read once the rest of the graph has been read, so their
   * scope is what the records read point at: those put off, and those read
   * at their turn for what they reached. See `CATALOG_READ_ORDER`.
   */
  readonly catalogNodes: ForgeGraphNode[];
  /** Rows read from the source, keyed by object, awaiting their write. */
  readonly preread: Map<string, PrereadNode>;
  /** Per object, the key prefix of its ids in the source org, once the run has told it. */
  readonly sourceKeyPrefixes: Map<string, string>;
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
  /** Per lifecycle object, the target's statuses and their categories, read once. */
  readonly lifecycles: Map<string, Promise<StatusCategories | undefined>>;
  /**
   * Records written as drafts, and the status each is still owed: given back
   * at the end of the run, or reported when the run stops before it.
   */
  readonly deferredStatuses: Array<{ objectApiName: string; id: string; status: string }>;
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
  /** Per object, the fields left out of its records because they hold a file's content. */
  readonly fileContentFieldsLeftOut: Map<string, Set<string>>;
  /** When the target dated the run's writes, once read back at its end. */
  writtenBetween?: ForgeWrittenBetween;
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
 * lookup its fields say it may not leave empty. Discovery marks the edges of
 * every lookup it walked, but not every object had its lookups walked: one at
 * the edge of the graph was described and no further, a starter template's
 * graph has no edges at all, and the run adds the selling model options itself.
 *
 * A lookup that can point at several objects names none of them: the object a
 * row needs is the one its own parent belongs to, and the rows are held back
 * one by one (`rowsWithoutTheirParent`). Its edges go too, once the fields say
 * nothing else joins the two objects. Discovery draws one per object such a
 * lookup can name, required when the lookup is, and master-detail when the
 * parent's side of it deletes its children with it: a feed item's parent can
 * be any of 216 objects, and is both.
 */
function requiredParentsOf(
  objectApiName: string,
  graph: ForgeGraph,
  fieldInfos: readonly FieldInfo[],
): string[] {
  const lookups = fieldInfos.filter((f) => f.isReference);
  const onlyAmongOthers = (parent: string): boolean => {
    const naming = lookups.filter((f) => (f.referenceTo ?? []).includes(parent));
    return naming.length > 0 && naming.every((f) => (f.referenceTo ?? []).length > 1);
  };
  const parents = new Set(
    graph.edges
      .filter(
        (e) =>
          e.targetObject === objectApiName &&
          (e.required === true || e.type === 'master-detail') &&
          !onlyAmongOthers(e.sourceObject),
      )
      .map((e) => e.sourceObject),
  );
  for (const field of lookups) {
    const targets = field.referenceTo ?? [];
    if (targets.length !== 1 || !isRequiredLookup(objectApiName, field.name, field.nillable))
      continue;
    parents.add(targets[0]);
  }
  parents.delete(objectApiName);
  return [...parents];
}

/** A row held back for want of its parent: the lookup, and the object its parent belongs to. */
interface ParentNotWritten {
  field: string;
  parentObject: string;
}

/**
 * Why the rows held back for want of their parent were not written: one
 * sample per lookup and parent object, the largest first.
 */
function parentNotWrittenSamples(
  held: ReadonlyMap<number, ParentNotWritten>,
  failedObjects: ReadonlySet<string>,
): ExecutionErrorSample[] {
  const groups = new Map<string, ParentNotWritten & { count: number }>();
  for (const { field, parentObject } of held.values()) {
    const key = `${field}|${parentObject}`;
    const group = groups.get(key) ?? { field, parentObject, count: 0 };
    group.count++;
    groups.set(key, group);
  }
  return [...groups.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, 3)
    .map(({ field, parentObject, count }) => ({
      recordSummary: `${field} → ${parentObject} (${count} record${count === 1 ? '' : 's'})`,
      messages: [
        `Not written: ${field} may not be left empty, and the ${parentObject} it points at ` +
          (failedObjects.has(parentObject)
            ? 'failed in this run.'
            : 'was not written by this run.'),
      ],
    }));
}

/** Statuses owed to records written as drafts, by object, in the order they were written. */
function statusesByObject(
  owed: ExecutionState['deferredStatuses'],
): Map<string, Array<{ id: string; status: string }>> {
  const byObject = new Map<string, Array<{ id: string; status: string }>>();
  for (const { objectApiName, id, status } of owed) {
    const entries = byObject.get(objectApiName) ?? [];
    entries.push({ id, status });
    byObject.set(objectApiName, entries);
  }
  return byObject;
}

/**
 * The columns the dates of the run's records are read back by, tried in
 * turn: when each was created and last modified, and its system stamp; or,
 * for an object that keeps no `LastModifiedDate` — a relation of an email
 * message — the system stamp alone.
 */
const WRITTEN_DATE_COLUMNS: readonly (readonly string[])[] = [
  ['CreatedDate', 'LastModifiedDate', 'SystemModstamp'],
  ['SystemModstamp'],
];

/** The audit dates an org may let a user set on the records they create. */
const AUDIT_DATE_FIELDS: ReadonlySet<string> = new Set(['CreatedDate', 'LastModifiedDate']);

/** A date the org wrote, in epoch milliseconds; NaN when there is none to read. */
function epochOf(value: unknown): number {
  return typeof value === 'string' ? Date.parse(value) : Number.NaN;
}

/**
 * Executes a Forge plan by processing graph nodes in topological order.
 *
 * Thin orchestrator over the stage pipeline in `./stages/`:
 * ScopeResolver (ordering + SOQL) → OrphanExpander (single-hop parents) →
 * RecordCleaner (remap/nullify/strip) → BatchWriter (insert/upsert) →
 * CycleFkPatcher (pass-2 cycle FK UPDATE). For each included node the
 * executor queries records from the source org, lets the stages transform
 * and write them, and tracks new ID mappings. A parent that fails skips the
 * children that cannot be written without it; the others lose their lookup at
 * it, and the second pass reports each one.
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
      notCreatable: new Set<string>(),
      errors: [],
      truncatedObjects: new Set<string>(),
      pendingFkUpdates: [],
      deferredNodes: [],
      catalogNodes: [],
      preread: new Map<string, PrereadNode>(),
      sourceKeyPrefixes: new Map<string, string>(),
      readObjects: new Set(runGraph.nodes.filter((n) => n.included).map((n) => n.objectApiName)),
      sellingModels: runGraph.nodes.some(
        (n) => n.included && n.objectApiName === SELLING_MODEL_OBJECT,
      ),
      standardPricebookId: null,
      existingRecords: [],
      lifecycles: new Map(),
      deferredStatuses: [],
      anonymize: config.anonymization ? this.anonymizerForRun() : null,
      detectedPersonalFields: new Map<string, string[]>(),
      fileScope: new Map<string, string[]>(),
      files: null,
      fileContentFieldsLeftOut: new Map<string, Set<string>>(),
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
      // Dated by the target first: removing what it created goes by those dates.
      await this.readWrittenBetween(state);
      this.reportDraftsLeft(state);
      keepPartialSummary(err, this.summaryOf(state));
      throw err;
    }
  }

  /**
   * Keep, for an object whose records the run writes, the fields of `described`
   * that hold a file's content, and hand back the others: the only ones read.
   *
   * Read, such a field gives the address of its file, never the file, and a
   * clone that wrote the value back sent that address where the file's content
   * belongs — a quote's generated document is one. The files stage reads a
   * Salesforce File's version and an attachment's body from their own address;
   * every other field of the kind is left empty, and said so.
   *
   * @param writes - Whether the run writes records of the object; a field left
   *   out of an object it writes nothing of is not worth saying.
   */
  private withoutFileContent(
    state: ExecutionState,
    objectApiName: string,
    described: FieldInfo[],
    writes: boolean,
  ): FieldInfo[] {
    const leftOut = described.filter((f) => isFileContentField(f) && f.createable);
    if (writes && leftOut.length > 0) {
      const known = state.fileContentFieldsLeftOut.get(objectApiName) ?? new Set<string>();
      for (const field of leftOut) known.add(field.name);
      state.fileContentFieldsLeftOut.set(objectApiName, known);
    }
    return described.filter((f) => !isFileContentField(f));
  }

  /**
   * Read back when the target dated the run's writes: the earliest
   * `CreatedDate` of the records it created and the latest `LastModifiedDate`
   * it left on them, by the org's own clock.
   *
   * Removing the run's records goes by these, not by this machine's clock: a
   * record the org stamped after the run ended is one changed since, and a
   * clock a second behind the org's made every record the run wrote last read
   * that way. Where both orgs let the run's user set audit fields, the clone
   * wrote the source's creation and modification dates, years before the
   * run, and a removal took what was created in the target since for the
   * run's own: those records are dated by their system stamp, which no one
   * sets.
   *
   * Best effort — a read refused leaves the run undated, and the removal then
   * dates it from the records themselves and from when the run was recorded.
   * Dated by the objects it could read, the run ended before the writes it
   * could not, and a removal read those as changes made since the run.
   */
  private async readWrittenBetween(state: ExecutionState): Promise<void> {
    if (state.config.dryRun || state.writtenBetween) return;
    let first = Number.POSITIVE_INFINITY;
    let last = Number.NEGATIVE_INFINITY;
    for (const { objectApiName, sourceIds } of state.remapper.createdByObject()) {
      const ids = sourceIds.flatMap((id) => {
        const target = state.remapper.get(id);
        return target ? [target] : [];
      });
      if (ids.length === 0) continue;
      const stampOnly = await this.auditDatesCopied(state, objectApiName);
      for (const list of idLists(ids)) {
        const rows = await this.writtenDatesOf(state.targetOrgId, objectApiName, list);
        if (!rows) return;
        for (const row of rows) {
          // A record whose own date is not the org's, or that keeps none, is
          // dated by its system stamp.
          const stamp = epochOf(row['SystemModstamp']);
          const dated = (field: string): number => {
            const date = stampOnly ? Number.NaN : epochOf(row[field]);
            return Number.isFinite(date) ? date : stamp;
          };
          const created = dated('CreatedDate');
          const modified = dated('LastModifiedDate');
          if (Number.isFinite(created)) first = Math.min(first, created);
          if (Number.isFinite(modified)) last = Math.max(last, modified);
        }
      }
    }
    if (Number.isFinite(first) && Number.isFinite(last)) {
      state.writtenBetween = {
        first: new Date(first).toISOString(),
        last: new Date(Math.max(first, last)).toISOString(),
      };
    }
  }

  /**
   * The dates of some records the run created, read by the first set of
   * {@link WRITTEN_DATE_COLUMNS} their object keeps; undefined when none could
   * be read.
   *
   * @param list - The records' ids, quoted for an `IN (…)`.
   */
  private async writtenDatesOf(
    orgId: string,
    objectApiName: string,
    list: string,
  ): Promise<Record<string, unknown>[] | undefined> {
    const object = assertSoqlIdentifier(objectApiName);
    for (const columns of WRITTEN_DATE_COLUMNS) {
      try {
        return await this.deps.queryRecords(
          orgId,
          `SELECT Id, ${columns.join(', ')} FROM ${object} WHERE Id IN (${list})`,
        );
      } catch {
        // The next set of columns, or none.
      }
    }
    return undefined;
  }

  /**
   * Whether the run may have written the source's audit dates into its
   * records of an object: both orgs let its user set them, and a clone writes
   * every field both let it write. An object either org will not describe may
   * have them too.
   */
  private async auditDatesCopied(state: ExecutionState, objectApiName: string): Promise<boolean> {
    const settable = (fields: readonly FieldInfo[]): boolean =>
      fields.some((f) => AUDIT_DATE_FIELDS.has(f.name) && f.createable);
    try {
      const [source, target] = await Promise.all([
        this.deps.describeFields(state.sourceOrgId, objectApiName),
        this.deps.describeFields(state.targetOrgId, objectApiName),
      ]);
      return settable(source) && settable(target);
    } catch {
      return true;
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
    const runOrder = twoPhase ? sortedNodes : await this.singlePassOrder(state);

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

      // What the graph says the rows cannot do without is known before they
      // are read; what their own fields say, once `readNode` has them.
      if (await this.skipForFailedParent(node, state)) continue;

      const creatableCheck = creatableChecks.get(node.objectApiName);
      if (creatableCheck) {
        if (creatableCheck.status === 'fulfilled') {
          // Still read, for whether the clone holds a record of it: see
          // `reportNotCreatable`.
          if (!creatableCheck.value) state.notCreatable.add(node.objectApiName);
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
    // The catalog goes first, the nodes put off and those read at their turn
    // alike, prices before products and books: a price names its product and
    // its book, and what the catalog points at in turn — a selling model — is
    // among the nodes asked again after it.
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
      // The retry does not relax the rule the first pass applied: a node a
      // failed parent cannot be written without is still skipped, or the run
      // writes children of records that were never created.
      if (await this.skipForFailedParent(node, state)) continue;
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
        // Parents failed while being written are known only now.
        if (await this.skipForFailedParent(node, state, read.fieldInfos)) continue;
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

    // Statuses come back last, once everything the records carry is written.
    await this.restoreStatuses(state);

    const orphanExpansionError = state.orphanExpander.buildErrorReport();
    if (orphanExpansionError) {
      state.errors.push(orphanExpansionError);
    }

    // Every write is done: the target's dates of them are final.
    await this.readWrittenBetween(state);
    return this.summaryOf(state);
  }

  /**
   * Put records of an object with a status lifecycle — an order, a contract —
   * whose status is past Draft in at the target's Draft status, and keep the
   * status each had, by payload index.
   *
   * Run between two sandboxes, an activated order was refused — "for a new or
   * cloned order, choose Draft" — and its items, its actions and its item
   * group after it, for want of the order. An order takes its products only
   * as a draft, so the status goes back once every node is written. Frozen
   * and Autopilot learnt the rule first; the target's own categories say
   * which statuses are drafts. A run that cannot read them, or cannot write
   * the status back, or writes nothing, leaves the records as they are.
   */
  private async startAsDrafts(
    state: ExecutionState,
    objectApiName: string,
    records: Record<string, unknown>[],
  ): Promise<Map<number, string>> {
    const drafts = new Map<number, string>();
    const lifecycle = STATUS_LIFECYCLES[objectApiName];
    if (!lifecycle || state.config.dryRun || !this.deps.updateRecords) return drafts;
    let categories = state.lifecycles.get(objectApiName);
    if (!categories) {
      categories = statusCategories(
        (soql) => this.deps.queryRecords(state.targetOrgId, soql),
        lifecycle,
      );
      state.lifecycles.set(objectApiName, categories);
    }
    const known = await categories;
    if (!known) return drafts;
    records.forEach((record, index) => {
      const draft = draftStartOf(record['Status'], known);
      if (!draft) return;
      drafts.set(index, String(record['Status']));
      record['Status'] = draft;
    });
    return drafts;
  }

  /**
   * Give the records born a draft the status they had in the source, now that
   * every node — and so every item they take — is written. One the target
   * will not take back is reported with its reason, and stays a draft.
   */
  private async restoreStatuses(state: ExecutionState): Promise<void> {
    const update = this.deps.updateRecords;
    if (!update || state.deferredStatuses.length === 0) return;
    // Taken off the list: a run that stops from here on owes none of them.
    const owed = state.deferredStatuses.splice(0, state.deferredStatuses.length);
    for (const [objectApiName, entries] of statusesByObject(owed)) {
      let failed = 0;
      const samples: ExecutionErrorSample[] = [];
      for (let at = 0; at < entries.length; at += WRITE_API_MAX_BATCH.rest) {
        const batch = entries.slice(at, at + WRITE_API_MAX_BATCH.rest);
        let results: UpdateResult[];
        try {
          results = await update(
            state.targetOrgId,
            objectApiName,
            batch.map(({ id, status }) => ({ Id: id, Status: status })),
          );
        } catch (err) {
          results = batch.map(({ id }) => ({
            id,
            success: false,
            errors: [extractErrorMessage(err)],
          }));
        }
        batch.forEach(({ id, status }, index) => {
          const result = results[index];
          if (result?.success) return;
          failed++;
          if (samples.length < 3) {
            samples.push({
              recordSummary: `${objectApiName} ${id} Status=${status}`,
              messages: result?.errors ?? ['No result returned for the status update'],
            });
          }
        });
      }
      state.onProgress({
        objectName: objectApiName,
        status: failed > 0 ? 'error' : 'done',
        progress: 100,
        message:
          `Restored the status of ${entries.length - failed}/${entries.length} ` +
          `${objectApiName} records written as drafts`,
      });
      if (failed > 0) {
        state.errors.push({
          objectApiName,
          stage: 'insert',
          failedCount: failed,
          attemptedCount: entries.length,
          samples,
        });
      }
    }
  }

  /**
   * Say, of a run that stopped before its end, which records it wrote as
   * drafts and never gave their status back.
   *
   * The statuses go back once every node is written, and a cancel, or a
   * failure that ends the run, can come first: during a later node, or during
   * the file copy. A stopped run writes nothing more, so the records stay the
   * drafts the target holds — reported here as a refused restore is, with the
   * status each had in the source, which its errors did not say and which was
   * kept nowhere else.
   */
  private reportDraftsLeft(state: ExecutionState): void {
    const owed = state.deferredStatuses.splice(0, state.deferredStatuses.length);
    for (const [objectApiName, entries] of statusesByObject(owed)) {
      state.errors.push({
        objectApiName,
        stage: 'insert',
        failedCount: entries.length,
        attemptedCount: entries.length,
        samples: entries.slice(0, 3).map(({ id, status }) => ({
          recordSummary: `${objectApiName} ${id} Status=${status}`,
          messages: [
            'Written as a draft, and the run stopped before giving it this status back: it stays a draft.',
          ],
        })),
      });
    }
  }

  /**
   * Skip a node, and say so, when a parent its rows cannot be written without
   * failed in this run. Returns whether it was skipped.
   *
   * Only such a parent takes a node down. Any failed parent used to: the
   * quote synced to an opportunity, held back for its record type in a real
   * org, took the opportunity down with it and every line behind it, when the
   * opportunity could have gone in with that one lookup left empty. It now
   * does, and the second pass reports the lookup it could not fill in.
   *
   * @param fieldInfos - The node's source fields, once read: a lookup they say
   *   may not be left empty makes its object one the rows cannot do without,
   *   whatever the graph says. Before, the graph's edges decide — and when
   *   they would skip the node, its fields are asked first: an edge cannot say
   *   whether its lookup names one object or several, and one that names
   *   several leaves the rows to decide (`requiredParentsOf`).
   */
  private async skipForFailedParent(
    node: ForgeGraphNode,
    state: ExecutionState,
    fieldInfos?: readonly FieldInfo[],
  ): Promise<boolean> {
    const failedParent = (fields: readonly FieldInfo[]): boolean =>
      requiredParentsOf(node.objectApiName, state.graph, fields).some((parent) =>
        state.failedObjects.has(parent),
      );
    if (!failedParent(fieldInfos ?? [])) return false;
    if (!fieldInfos) {
      try {
        // The describe `readNode` starts with, asked a step earlier.
        if (!failedParent(await this.deps.describeFields(state.sourceOrgId, node.objectApiName))) {
          return false;
        }
      } catch {
        // Not described, the node is skipped on the graph's word, as it was
        // before its fields were asked.
      }
    }
    state.skippedCount++;
    state.failedObjects.add(node.objectApiName);
    state.onProgress({
      objectName: node.objectApiName,
      status: 'skipped',
      progress: 100,
      message: `Skipped ${node.objectApiName} (parent failed)`,
    });
    return true;
  }

  /**
   * The rows of a node that cannot be written for want of their parent, by
   * index: through a lookup they may not leave empty and that can name
   * several objects, each points at a record of an object this run writes,
   * and the run has nothing in the target for that record — its object
   * failed, or the record did not go in.
   *
   * Such a lookup takes no node down whole. A feed item's parent can be any
   * of 216 objects: run for real, the target refused every quote of an
   * opportunity for its record type, and the clone wrote no feed item at all,
   * the opportunity's own among them, though the opportunity was written. The
   * rows are held back one by one instead, before anything is written for
   * them: sent, each would be refused for want of its parent. A row whose
   * parent belongs to an object the run does not write goes on as every
   * lookup does.
   *
   * The object a parent belongs to is told by its id's key prefix: see
   * `sourceKeyPrefixes`.
   */
  private async rowsWithoutTheirParent(
    node: ForgeGraphNode,
    state: ExecutionState,
    fieldInfos: readonly FieldInfo[],
    records: readonly Record<string, unknown>[],
  ): Promise<Map<number, ParentNotWritten>> {
    const held = new Map<number, ParentNotWritten>();
    const lookups = fieldInfos.filter(
      (f) =>
        f.isReference &&
        (f.referenceTo ?? []).length > 1 &&
        isRequiredLookup(node.objectApiName, f.name, f.nillable),
    );
    const unwritten: Array<{ index: number; field: string; id: string }> = [];
    records.forEach((record, index) => {
      for (const field of lookups) {
        const id = record[field.name];
        if (typeof id === 'string' && id && !state.remapper.get(id)) {
          unwritten.push({ index, field: field.name, id });
        }
      }
    });
    if (unwritten.length === 0) return held;
    const written = new Set(
      state.graph.nodes.filter((n) => n.included).map((n) => n.objectApiName),
    );
    written.delete(node.objectApiName);
    const objectOf = await this.sourceKeyPrefixes(
      state,
      new Set(lookups.flatMap((f) => (f.referenceTo ?? []).filter((o) => written.has(o)))),
    );
    for (const { index, field, id } of unwritten) {
      const parentObject = objectOf.get(id.slice(0, 3));
      if (parentObject && !held.has(index)) held.set(index, { field, parentObject });
    }
    return held;
  }

  /**
   * The object each source key prefix stands for, among `objects`: the prefix
   * the ids of the rows the run read of an object begin with, or, for an
   * object it read nothing of, the one the describe it holds gives, as
   * `describeObject` answers. Kept for the run once told.
   */
  private async sourceKeyPrefixes(
    state: ExecutionState,
    objects: ReadonlySet<string>,
  ): Promise<Map<string, string>> {
    const unread: string[] = [];
    for (const objectApiName of objects) {
      if (state.sourceKeyPrefixes.has(objectApiName)) continue;
      const row = state.preread
        .get(objectApiName)
        ?.records.find((r) => typeof r['Id'] === 'string');
      if (row) state.sourceKeyPrefixes.set(objectApiName, String(row['Id']).slice(0, 3));
      else unread.push(objectApiName);
    }
    for (let i = 0; i < unread.length; i += CONCURRENT_DESCRIBE_LIMIT) {
      const wave = unread.slice(i, i + CONCURRENT_DESCRIBE_LIMIT);
      const described = await Promise.all(
        wave.map((objectApiName) => this.objectInfoOf(state.sourceOrgId, objectApiName)),
      );
      wave.forEach((objectApiName, j) => {
        const prefix = described[j]?.keyPrefix;
        if (prefix) state.sourceKeyPrefixes.set(objectApiName, prefix);
      });
    }
    const objectOf = new Map<string, string>();
    for (const objectApiName of objects) {
      const prefix = state.sourceKeyPrefixes.get(objectApiName);
      if (prefix && !objectOf.has(prefix)) objectOf.set(prefix, objectApiName);
    }
    return objectOf;
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
   * The graph keeps one edge per pair of objects, and until discovery kept
   * the flag of every sighting of a pair, the one it met first — a parent's
   * list of its children — said nothing of a required lookup: in a real graph
   * the opportunity's line items, the quote's lines and the order's items all
   * read as optional. With optional parents breaking ties, an opportunity that
   * points at a quote pointing back at it waited for it, and its line went
   * first — refused for want of the opportunity. The fields a run described
   * say it plainly, and they still say it of what discovery never walked:
   * the lookups of an object at the edge of the graph, of a starter
   * template's objects, of the selling model options the run adds.
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
   * in. Anything else is written in the order the graph's required lookups
   * set, which is the parents-first order wherever no cycle stands in the way.
   *
   * A full-table run writes each node as soon as it has read it, so the order
   * is settled before anything is read — from the fields of every node,
   * described first, as a record-scoped run settles it from what it read.
   * Taken from the graph alone, a line at the edge of discovery, whose
   * lookups were never walked, went before the prices it could not be
   * written without, as it did in a record-scoped run. A node whose describe
   * fails is ordered as one with no lookup: its own read reports why.
   *
   * Without prices the parents-first order was all there was, and it cannot
   * order a cycle: a quote met before the opportunity it cannot be written
   * without, which points back at it, went first, and the platform refuses
   * it there. The plan reads its cycles in this order too.
   */
  private async singlePassOrder(state: ExecutionState): Promise<ForgeGraphNode[]> {
    const included = state.graph.nodes.filter((n) => n.included);
    if (!included.some((n) => isPricebookEntry(n.objectApiName))) {
      return sortNodesForWriting(state.graph);
    }
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
      ...(state.fileContentFieldsLeftOut.size > 0
        ? {
            fileContentFieldsLeftOut: [...state.fileContentFieldsLeftOut].map(
              ([objectApiName, fields]) => ({ objectApiName, fields: [...fields].sort() }),
            ),
          }
        : {}),
      ...(state.writtenBetween ? { writtenBetween: { ...state.writtenBetween } } : {}),
    };
  }

  /**
   * Choose the files of the records read and measure them against the
   * target, before anything is written.
   *
   * A file over the run's cap, or kept outside Salesforce, is left out and
   * listed. The rest are checked against the file storage the target has
   * left: a real run that would not fit stops here with nothing written, and
   * a dry run says so and lists what it would copy. A real run whose files
   * could not all be looked up stops here too.
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
    // Written, the records would reach the target without the files a
    // failed lookup hid, and the run would read as complete.
    const unread = lookupFailure(selection);
    if (unread && !config.dryRun) {
      throw new ForgeFilesRefusedError(`${unread} Nothing was written.`);
    }
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
    // Only a dry run comes this far past a lookup that failed. Its report
    // says so beside the files it found, which are then not all there are:
    // without it, a dry run whose every lookup failed said of its files that
    // there was none to copy.
    if (unread) state.files.lookupFailure = unread;

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
   * branches that finish here — out of scope, refused by the target,
   * reference data resolved by name, a dry run — return false having already
   * reported themselves; a node put off, or read to be read again, returns
   * false as well.
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

      const described = await this.deps.describeFields(sourceOrgId, node.objectApiName);
      // Never read, so never written: see `withoutFileContent`. Said once the
      // rows are in, of an object with rows to write.
      const fieldInfos = described.filter((f) => !isFileContentField(f));
      const createableSet = new Set(fieldInfos.filter((f) => f.createable).map((f) => f.name));
      // A lookup the rows may not leave empty, at an object that failed: none
      // of them could be written, so none is read.
      if (await this.skipForFailedParent(node, state, fieldInfos)) return false;

      const queryInput: NodeQueryInput = {
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
        // The root's object is read after the first pass only as the catalog
        // object it is, for the second time: see below.
        rootReadAgain: !allowDefer && node.objectApiName === config.rootObjectApiName,
      };
      const query = buildNodeQuery(queryInput);
      if (allowDefer && this.waitsForWhatPointsAtIt(node, query, state)) {
        state.catalogNodes.push(node);
        return false;
      }
      if (query.kind === 'skip') {
        if (allowDefer && query.reason === UNSCOPED_NO_PARENT_REASON) {
          state.deferredNodes.push(node);
          return false;
        }
        // Nothing the run read points at it or sits above it, so the clone
        // holds no record of it: skipped, with nothing wrong. Listed among the
        // errors as well, as 0 of 0, such objects were all six errors of a
        // real dry run.
        state.skippedCount++;
        onProgress({
          objectName: node.objectApiName,
          status: 'skipped',
          progress: 100,
          message: `Skipped ${node.objectApiName} (out of scope: ${query.reason})`,
        });
        return false;
      }
      // One row of an object the target refuses says whether the clone holds
      // any: no more is read, and what is read goes into no scope.
      if (state.notCreatable.has(node.objectApiName)) {
        const probe = buildNodeQuery({ ...queryInput, maxRecordsPerObject: 1 });
        const held =
          probe.kind === 'query'
            ? await queryNodeRecords(probe, (soql) => this.deps.queryRecords(sourceOrgId, soql))
            : [];
        this.reportNotCreatable(node, state, held.length > 0);
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

      // A node of the catalog reached from above is read at its turn for what
      // it brings — the objects read after it are read under the rows it
      // reached — and read again with the rest of the catalog, for the rows
      // the records read since name. Read only here, a product naming the
      // opportunity's account as its supplier made the clone's products the
      // account's alone, none of those its lines sold, and every price went
      // to the target without its product. Until that read its scope stays
      // open: a lookup a row may not leave empty holds nothing back at it, as
      // at any catalog object still to be read.
      //
      // The root's object as well, read again by the ids named since, the
      // root's among them. Left as it was, a clone rooted at a price book read
      // no other book: a quote of the book's opportunity priced from another
      // one went to the target without its book, and the price its line used
      // was sent without one, which the platform refuses. Between two
      // sandboxes, the quotes and orders a book's clone read named two other
      // books, and it read one book.
      const scopeCache = state.scopeCache;
      if (allowDefer && scopeCache && CATALOG_OBJECTS.has(node.objectApiName)) {
        seedScopeCache(scopeCache, node.objectApiName, records, fieldInfos, { settle: false });
        state.catalogNodes.push(node);
        return false;
      }

      // A price book entry is usually read by id — the line items that point
      // at it put it in scope — so the standard entry of the same product is
      // never among the rows, and the platform will not take the custom price
      // without it. Ask for them by name, for exactly the products in hand.
      if (isPricebookEntry(node.objectApiName) && state.standardPricebookId) {
        await this.addStandardPricebookEntries(node, state, records, fieldInfos);
        // A book holds one entry per product — per product and selling model
        // when the run keeps them, and per currency in an org with several —
        // and the target enforces that on insert whatever `IsActive` says.
        // The source can still hold two.
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
      this.withoutFileContent(state, node.objectApiName, described, records.length > 0);

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
      // Never going to be written, it is read only to know whether the clone
      // holds a record of it: a read that failed leaves that unknown, which
      // is not a failure of its records.
      if (state.notCreatable.has(node.objectApiName)) {
        this.reportNotCreatable(node, state, true);
        return false;
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
   * Say that a node the target refuses inserts on was skipped: as an error
   * when the clone holds records of it, or may — its read failed.
   *
   * A record the clone holds of such an object cannot be written, and that is
   * an error. An object the clone holds none of has lost nothing, and the run
   * listed it among its errors all the same, as 0 of 0: run against two
   * sandboxes, the clone of one opportunity listed thirteen such objects, and
   * held a record of one of them. The row read to know goes into no scope:
   * never written, it brings nothing under it into the clone, as when the
   * object was not read at all.
   */
  private reportNotCreatable(
    node: ForgeGraphNode,
    state: ExecutionState,
    holdsRecords: boolean,
  ): void {
    state.skippedCount++;
    if (holdsRecords) {
      state.errors.push({
        objectApiName: node.objectApiName,
        stage: 'scope',
        failedCount: 0,
        attemptedCount: 0,
        samples: [
          {
            recordSummary: '(node-level skip)',
            messages: ['Object is not createable on target org'],
          },
        ],
      });
    }
    state.onProgress({
      objectName: node.objectApiName,
      status: 'skipped',
      progress: 100,
      message: holdsRecords
        ? `Skipped ${node.objectApiName} (target org rejects inserts on this entity)`
        : `Skipped ${node.objectApiName} (target org rejects inserts on this entity; ` +
          'the clone holds none of its records)',
    });
  }

  /**
   * Whether a node of the catalog waits until the rest of the graph has been
   * read, to be read by what the records point at (`CATALOG_READ_ORDER`).
   *
   * It waits when nothing reaches it from above: it is not the root, and no
   * statement of its read is under a parent in scope. Its turn in
   * parents-first order comes before the line items that say which prices
   * they use, so read then it could only go by the rows named so far, and
   * miss the ones named after. Reached from above — the prices of the book a
   * clone is rooted at — it is read at its turn as well, for the rows under
   * what it reached, and again with the rest of the catalog: see `readNode`.
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
   *
   * In an org with several currencies it takes the ones of the currencies
   * its custom prices are in. A book prices a product once per currency the
   * org holds, and taken by product, a line in euros brought the product's
   * standard prices in every other currency too, which no price the clone
   * writes needs.
   */
  private async addStandardPricebookEntries(
    node: ForgeGraphNode,
    state: ExecutionState,
    records: Record<string, unknown>[],
    fieldInfos: FieldInfo[],
  ): Promise<void> {
    const standardId = state.standardPricebookId;
    if (!standardId) return;
    // The standard price a custom price needs: of its product, in its currency
    // — absent from an org with one — and under its selling model when the
    // run keeps them.
    const pairOf = (row: Record<string, unknown>): string =>
      [
        row[PRICEBOOK_ENTRY_PRODUCT_FIELD],
        state.sellingModels ? row[PRICEBOOK_ENTRY_SELLING_MODEL_FIELD] : '',
        row[PRICEBOOK_ENTRY_CURRENCY_FIELD],
      ]
        .map((value) => String(value ?? ''))
        .join('|');
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

    try {
      // The products laid over as many statements as a request URI holds:
      // named in one, six hundred or so make a query longer than the org
      // takes, and not one standard price was read.
      const statements = new ScopedSoqlBuilder().buildJoining({
        objectApiName: node.objectApiName,
        selectFields: fieldInfos.filter((f) => f.queryable).map((f) => f.name),
        split: { field: PRICEBOOK_ENTRY_PRODUCT_FIELD, ids: productIds },
        whole: { field: PRICEBOOK_ENTRY_BOOK_FIELD, ids: new Set([standardId]) },
      });
      let added = 0;
      for (const soql of statements) {
        for (const row of await this.deps.queryRecords(state.sourceOrgId, soql)) {
          const id = row['Id'];
          if (typeof id === 'string' && seen.has(id)) continue;
          if (!pricedPairs.has(pairOf(row))) continue;
          records.push(row);
          added++;
        }
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
   * The key prefix and record types of an object in an org, or `null` when the
   * run has no way to read them. Best effort: a describe of the target that
   * failed has already been reported by the field-set check, and one of the
   * source by the read of the object.
   */
  private async objectInfoOf(
    orgId: string,
    objectApiName: string,
  ): Promise<TargetObjectInfo | null> {
    if (!this.deps.describeObject) return null;
    try {
      return await this.deps.describeObject(orgId, objectApiName);
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
   * Add to the run what the calls of one node did: the rows created, updated,
   * linked and refused, the lookups owed to the second pass, the rows the
   * target already held, and the refusals with their samples.
   */
  private countWrites(
    state: ExecutionState,
    objectApiName: string,
    written: BatchWriteResult,
  ): void {
    state.successCount += written.successCount;
    state.updatedCount += written.updatedCount;
    state.linkedCount += written.linkedExistingCount;
    state.failedCount += written.failureCount;
    state.pendingFkUpdates.push(...written.pendingFkUpdates);
    if (written.linkedExistingCount > 0 || written.unidentifiedExistingCount > 0) {
      state.existingRecords.push({
        objectApiName,
        linked: written.linkedExistingCount,
        unidentified: written.unidentifiedExistingCount,
      });
    }
    if (written.failureCount > 0) {
      state.errors.push({
        objectApiName,
        stage: 'insert',
        failedCount: written.failureCount,
        attemptedCount:
          written.successCount +
          written.updatedCount +
          written.linkedExistingCount +
          written.failureCount,
        samples: written.errorSamples,
      });
    }
  }

  /**
   * Write one node the read stage has already pulled: describe the target
   * org, hold the node back when its record types are closed to the running
   * user, and the rows whose parent it did not write, expand orphan parents,
   * clean, translate record types, anonymize and insert.
   */
  private async writeNode(node: ForgeGraphNode, state: ExecutionState): Promise<void> {
    const { config, sourceOrgId, targetOrgId, onProgress, remapper } = state;
    const read = state.preread.get(node.objectApiName);
    if (!read) return;
    const { fieldInfos, createableSet, records, targetSetsPending } = read;
    // The rows read, less those held back for want of their parent.
    let toWrite = records;
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
      const targetObject = await this.objectInfoOf(targetOrgId, node.objectApiName);

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

      // A lookup the rows may not leave empty and that can name several
      // objects decides row by row: see `rowsWithoutTheirParent`. Counted as
      // failed, as the rows of a record type held back are — the run read
      // them to clone them — and said why, per lookup and parent object.
      const withoutParent = await this.rowsWithoutTheirParent(node, state, fieldInfos, records);
      if (withoutParent.size > 0) {
        toWrite = records.filter((_, index) => !withoutParent.has(index));
        state.failedCount += withoutParent.size;
        state.errors.push({
          objectApiName: node.objectApiName,
          stage: 'scope',
          failedCount: withoutParent.size,
          attemptedCount: 0,
          samples: parentNotWrittenSamples(withoutParent, state.failedObjects),
        });
        if (toWrite.length === 0) {
          state.failedObjects.add(node.objectApiName);
          onProgress({
            objectName: node.objectApiName,
            status: 'error',
            progress: 100,
            message:
              `Held back ${node.objectApiName}, nothing written: every record points at a ` +
              'parent this run did not write. Objects that cannot be written without it will be skipped.',
          });
          return;
        }
      }

      // Single-hop orphan parent expansion. Runs before the
      // clean stage so expanded parents land in the remapper and children
      // pick up the new target ID instead of orphan-nullifying.
      await state.orphanExpander.expandForNode({
        node,
        fieldInfos,
        records: toWrite,
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
        withoutFileContent: (objectApiName, parentFields) =>
          this.withoutFileContent(state, objectApiName, parentFields, true),
        // A parent order or contract past Draft takes the path the node's own
        // records do: in as a draft, its status given back — or reported —
        // with theirs.
        startAsDraft: async (objectApiName, payload) =>
          (await this.startAsDrafts(state, objectApiName, [payload])).get(0),
        oweStatus: (objectApiName, id, status) =>
          state.deferredStatuses.push({ objectApiName, id, status }),
      });

      const cleanedRecords = cleanNodeRecords({
        objectApiName: node.objectApiName,
        records: toWrite,
        fieldInfos,
        remapper,
        referenceFallback: config.referenceFallback,
        failedObjects: state.failedObjects,
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

      // An order past Draft goes in as a draft, and gets its status back once
      // every node is written: see `restoreStatuses`.
      const startedAsDrafts = await this.startAsDrafts(state, node.objectApiName, recordsToInsert);

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

      // One tally for every round, filled as each call is answered.
      const writeResult = emptyBatchWriteResult();
      try {
        for (const round of rounds) {
          await state.batchWriter.writeNode(
            {
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
            },
            writeResult,
          );
        }
      } finally {
        // Noted however the node ends: a call that throws, or a cancel between
        // two, stops it after the calls before had written drafts, and those
        // are owed their status like the rest. Every record the run wrote gets
        // it back. One linked to was never written and keeps its own; one an
        // upsert matched by its external id went over as a draft all the same,
        // and gets back the status the upsert would have written.
        for (const [index, status] of startedAsDrafts) {
          const sourceId = cleanedRecords[index]?.source['Id'];
          if (typeof sourceId !== 'string') continue;
          const targetId = remapper.get(sourceId);
          if (!targetId || remapper.isExisting(sourceId)) continue;
          state.deferredStatuses.push({ objectApiName: node.objectApiName, id: targetId, status });
        }
        // Counted however the node ends, for the same reason. Counted only
        // once it was through, a node a cancel stopped between two calls left
        // what the calls before had created in the remap table — the removal
        // takes them back — and out of what the run said it created, with
        // the rows they had refused out of what it said it lost.
        this.countWrites(state, node.objectApiName, writeResult);
      }

      const nodeSuccess = writeResult.successCount;
      const nodeUpdated = writeResult.updatedCount;
      const nodeLinked = writeResult.linkedExistingCount;
      const nodeFailure = writeResult.failureCount;
      const nodeUnidentified = writeResult.unidentifiedExistingCount;

      // Fail-fast on partial-but-mostly-failure: if >50% of records
      // failed, mark the node as failed so the objects that cannot be
      // written without it skip, and a lookup at it elsewhere is left empty
      // and reported rather than written as if its rows were there.
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
              : `${nodeFailure}/${total} ${node.objectApiName} records failed (>50%) — objects that cannot be written without it will be skipped`,
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
        const withoutTheirParent =
          withoutParent.size > 0
            ? `, ${withoutParent.size} not written for want of their parent`
            : '';
        onProgress({
          objectName: node.objectApiName,
          status: 'done',
          progress: 100,
          message: `Completed ${node.objectApiName}: ${nodeSuccess} succeeded${updated}${linked}, ${nodeFailure} failed${unidentified}${withoutTheirParent}`,
        });
      }
    } catch (err) {
      // An abort is a control-flow signal, not a node failure. Recording it as
      // one and continuing is what let a cancelled run carry on writing.
      if (err instanceof ForgeAbortedError) {
        throw err;
      }
      // A call that throws is settled by the batch writer, which keeps what
      // the calls before it wrote; what reaches here stopped the node before
      // any of its rows went out. Those are the rows read, not the graph's
      // count, which is discovery's: zero on a template, and the whole table
      // for an object a scoped clone reads a few rows of — less the rows held
      // back for want of their parent, already counted.
      state.failedObjects.add(node.objectApiName);
      state.failedCount += toWrite.length;
      state.errors.push({
        objectApiName: node.objectApiName,
        stage: 'query',
        failedCount: toWrite.length,
        attemptedCount: toWrite.length,
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
