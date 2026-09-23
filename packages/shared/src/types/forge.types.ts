import type { AnonymizationMethod } from './common.types.js';

/** Mode used to specify the input for a Forge operation */
export type ForgeInputMode = 'record' | 'soql' | 'template' | 'ai';

/** Depth of relationship traversal during graph construction */
export type ForgeDepth = 'direct' | 'full' | 'custom';

/** Status of a single node within the Forge dependency graph */
export type ForgeNodeStatus = 'idle' | 'scanning' | 'running' | 'done' | 'error' | 'skipped';

/**
 * Configuration for a Forge operation.
 *
 * Describes the input source, traversal depth, source/target orgs,
 * and data-handling options such as PII anonymization and batch sizing.
 */
export interface ForgeConfig {
  /** How input records are specified */
  inputMode: ForgeInputMode;
  /** Salesforce record ID when inputMode is 'record' */
  recordId?: string;
  /** SOQL query string when inputMode is 'soql' */
  soqlQuery?: string;
  /** Template identifier when inputMode is 'template' */
  templateId?: string;
  /** Natural-language AI prompt when inputMode is 'ai' */
  aiPrompt?: string;
  /** How deep to traverse relationships */
  depth: ForgeDepth;
  /** Maximum traversal levels when depth is 'custom' */
  customDepth?: number;
  /**
   * How many objects discovery may reach before it stops.
   *
   * Depth says how far from the root to walk; this says how much. A CRM graph
   * is wide as well as deep, and the default of fifty is reached long before
   * a real org runs out of objects a write depends on — the preview says so,
   * and until this existed it said so with nothing to do about it. The CLI
   * has had `--max-nodes` since 1.26.0; this is the same dial.
   */
  maxNodes?: number;
  /** Alias or ID of the source Salesforce org */
  sourceOrgId: string;
  /** Alias or ID of the target Salesforce org */
  targetOrgId: string;
  /** Whether to anonymize personally identifiable information */
  anonymizePII: boolean;
  /** Whether to skip objects with zero matching records */
  skipEmpty: boolean;
  /** Batch size for bulk operations — 'auto' lets the engine decide */
  batchSize: 'auto' | number;
  /**
   * When `true`, the executor performs single-hop fetch+insert of any
   * required reference field whose target wasn't in the discovery graph.
   * Defaults to `false`. See `ForgeExecutor.ExecuteOptions`
   * for the cap and the underlying mechanism.
   */
  expandOrphanParents?: boolean;
  /**
   * Per-object record cap applied during execution. Translates into a
   * `LIMIT N` on each scoped SOQL query. `undefined` = no cap (full clone).
   * Used as a safety knob for big orgs / sample-only runs.
   */
  maxRecordsPerObject?: number;
  /**
   * Per-object field exclusions. Field names listed are stripped from
   * every record before insert. Common BA use case: clone Accounts but
   * skip `Description` (long-text PII) or `NumberOfEmployees`
   * (org-specific calculated value).
   */
  fieldExclusions?: Record<string, string[]>;
  /**
   * Map source-org user IDs to target-org user IDs for OwnerId remap.
   * Without this, records authored by users that don't exist on the
   * target sandbox (e.g. ex-employees) reject with INVALID_OWNER.
   */
  ownerMappings?: Record<string, string>;
  /**
   * Per-object SOQL WHERE filter, wrapped in parens.
   * Example: `{ Case: "Status = 'Open' AND CreatedDate > LAST_N_DAYS:30" }`.
   * In record-scoped mode it is AND-joined to the scope clause; in the other
   * modes it is the object's whole WHERE clause. SOQL mode fills it with the
   * query's WHERE clause, under the object after FROM.
   */
  objectSoqlFilters?: Record<string, string>;
  /**
   * Per-object source→target field rename. Handles schema drift when the
   * target sandbox uses different API names for the same logical field
   * (managed-package re-key, namespace change, Person Account `__c`/`__pc`
   * variant, etc.).
   *
   * Example: `{ Account: { 'Region__c': 'Region__pc' } }` writes the
   * source `Region__c` value into `Region__pc` on the target Account.
   * The source key is dropped from the cleaned record.
   */
  fieldMappings?: Record<string, Record<string, string>>;
}

/**
 * A node in the Forge dependency graph representing a single SObject.
 *
 * Tracks record/field counts, processing status, PII fields, and errors.
 */
export interface ForgeGraphNode {
  /** Salesforce API name of the object (e.g. 'Account') */
  objectApiName: string;
  /** Number of records to be processed for this object */
  recordCount: number;
  /** Number of fields included in the operation */
  fieldCount: number;
  /** Current processing status of this node */
  status: ForgeNodeStatus;
  /** Processing progress from 0 to 100 */
  progress: number;
  /** Whether this node is included in the current operation */
  included: boolean;
  /** API names of fields detected as containing PII */
  piiFields: string[];
  /** API names of fields selected for anonymization */
  anonymizeFields: string[];
  /** Topological level in the dependency graph (0 = root). Set during discovery. */
  level: number;
  /** Number of successfully processed records. Updated during execution. */
  successCount: number;
  /** Number of failed records. Updated during execution. */
  failureCount: number;
  /** Error messages accumulated during processing */
  errors: string[];
  /** Number of createable fields (can be set on insert). */
  createableFieldCount: number;
  /** Estimated data size in MB for this object. */
  estimatedSizeMB: number;
  /** Estimated API calls for this object. */
  estimatedApiCalls: number;
  /** Batch strategy override (default: 'auto'). */
  batchStrategy: ForgeBatchStrategy;
}

/**
 * An edge in the Forge dependency graph representing a relationship
 * between two SObjects.
 */
export interface ForgeGraphEdge {
  /** API name of the parent (source) object */
  sourceObject: string;
  /** API name of the child (target) object */
  targetObject: string;
  /** Salesforce relationship name (e.g. 'Contacts') */
  relationshipName: string;
  /** Type of the Salesforce relationship */
  type: 'master-detail' | 'lookup';
  /**
   * Whether the child cannot be written without this parent.
   *
   * A lookup that may be left null can be nullified at insert and repaired by
   * the second pass, so the order of the two objects does not matter much.
   * One that may not has to be written first or the child is refused outright
   * and there is nothing left for the second pass to repair. Optional: an
   * edge that does not say is treated as the forgiving kind.
   */
  required?: boolean;
}

/**
 * Complete dependency graph for a Forge operation.
 *
 * Contains all objects (nodes), their relationships (edges),
 * and aggregated size/duration estimates.
 */
export interface ForgeGraph {
  /** All SObject nodes in the graph */
  nodes: ForgeGraphNode[];
  /** All relationship edges between nodes */
  edges: ForgeGraphEdge[];
  /** Total number of records across all nodes */
  totalRecords: number;
  /** Estimated total data size in megabytes */
  estimatedSizeMB: number;
  /** Estimated total duration of the operation in seconds */
  estimatedDurationSeconds: number;
  /** True when BFS hit the node cap and the graph is incomplete. */
  truncated?: boolean;
}

/** Sample of a record that failed insertion, with the platform errors. */
export interface ForgeExecutionErrorSample {
  /** Compact key=value summary of up to 4 fields, used for UI display. */
  recordSummary: string;
  /** Error messages returned by Salesforce — `STATUS_CODE: message` form. */
  messages: string[];
}

/** Aggregated error report for a single object during execution. */
export interface ForgeExecutionError {
  /** API name of the object. */
  objectApiName: string;
  /** Stage where the failure happened. */
  stage: 'query' | 'insert' | 'scope';
  /** Number of records that failed at this stage. */
  failedCount: number;
  /** Total records attempted at this stage (0 for `'scope'` stage skips). */
  attemptedCount: number;
  /** Up to 3 sample failures, kept small enough to render in the wizard. */
  samples: ForgeExecutionErrorSample[];
}

/**
 * The rows of one object the target org refused because it already held them.
 *
 * Salesforce names the record a row collided with — a unique index in its
 * message, a duplicate rule in its match list — and a run that reads it links
 * the row's children to that record instead of leaving them pointing at
 * nothing. Neither created nor failed, so reported on its own.
 */
export interface ForgeExistingRecords {
  /** API name of the object. */
  objectApiName: string;
  /** Rows linked to the record the target already held; their children point at it. */
  linked: number;
  /**
   * Rows refused as duplicates without one record the run could trust. Counted
   * as failed, and their children lost the lookup to them.
   */
  unidentified: number;
}

/**
 * Per object, the rows a Forge run mapped from the source to the target: the
 * ones it created, and the ones it linked to a record the target already held.
 * Counts only — the ids stay in `idRemapTable`.
 */
export interface ForgeRemapObjectCounts {
  /** API name of the object. */
  objectApiName: string;
  /** Rows the run created in the target. */
  created: number;
  /** Rows linked to a record the target already held, never written to. */
  linked: number;
  /**
   * Rows an upsert matched by their external id and wrote over: records the
   * target held before the run. Absent when the run upserted none.
   */
  updated?: number;
}

/**
 * The rows of one object a Forge run created, by their source ids — the keys
 * `idRemapTable` maps to the records written in the target.
 */
export interface ForgeCreatedRecords {
  /** API name of the object. */
  objectApiName: string;
  /** Source ids of the rows created, in the order the run wrote them. */
  sourceIds: string[];
}

/** How a removal of a run's records ended. */
export type ForgeUndoStatus = 'success' | 'partial' | 'failure' | 'cancelled';

/**
 * What removing the records a Forge run created did to one object.
 *
 * Every record the run created of the object is in exactly one of the counts
 * past `planned`, unless the removal was stopped before it was done with the
 * object.
 */
export interface ForgeUndoObjectResult {
  /** API name of the object. */
  objectApiName: string;
  /** Records of this object the run created: what the removal set out to delete. */
  planned: number;
  /** Records deleted — sent to the org's recycle bin. */
  deleted: number;
  /** Records no longer in the org when the removal reached them. */
  alreadyGone: number;
  /** Records kept because they were modified after the run ended. */
  keptChanged: number;
  /**
   * Records kept because records that stay in the org would be deleted along
   * with them: one from before the run, one of the run's own the removal keeps
   * or the org refused to delete, and — unless the request included what
   * changed since the run — one added or changed since.
   */
  keptDependents: number;
  /** Records the org refused to delete. */
  refused: number;
  /**
   * The objects whose records, staying in the org, hold the ones counted in
   * `keptDependents`, by API name.
   */
  heldBy: string[];
  /**
   * The objects the org deletes along with this one's records that cannot be
   * read by the record they depend on, by API name: whether a record of theirs
   * stays was not checked, and it goes with its parent.
   */
  unchecked: string[];
  /**
   * Why records were refused, or could not be checked, in the org's words,
   * each reason once and a few at most.
   */
  reasons: string[];
}

/** What removing the records a Forge run created did, object by object. */
export interface ForgeUndoResult {
  /** The run whose records were removed. */
  forgeId: string;
  /** How the removal ended. */
  status: ForgeUndoStatus;
  /** Whether records modified since the run, and what was added to them since, went too. */
  includeChanged: boolean;
  /** Per object, in the order they were removed: children before their parents. */
  objects: ForgeUndoObjectResult[];
  /** ISO 8601 timestamp of when the removal ended. */
  finishedAt: string;
}

/**
 * What a history entry remembers once the records its run created were
 * removed, so the removal is not offered again.
 */
export interface ForgeUndoMark {
  /** ISO 8601 timestamp of when the removal ended. */
  removedAt: string;
  /** Records deleted. */
  deleted: number;
  /** Records no longer in the org when the removal reached them. */
  alreadyGone: number;
  /** Records kept: modified since the run, or holding records that stay. */
  kept: number;
  /** Records the org refused to delete. */
  refused: number;
}

/**
 * A run's choice to copy the files of the records it clones, as Review makes
 * it. A run that copies no file carries none.
 */
export interface ForgeFileCopyOption {
  /** Largest file copied, in MB: a larger one is left out and listed, never cut. */
  maxFileSizeMB: number;
  /**
   * Whether the user accepted, in a confirmation of its own, that files are
   * copied as they are: the content of a file cannot be anonymized. A run that
   * anonymizes its records copies no file without it.
   */
  acceptedAsIs: boolean;
}

/**
 * The object a copied file is counted under: a Salesforce File by its
 * document, whose removal takes its versions and links with it, and a legacy
 * attachment by itself.
 */
export type ForgeFileObject = 'ContentDocument' | 'Attachment';

/**
 * Why a file attached to a record in scope was not copied: larger than the
 * run's cap, kept outside Salesforce, or hanging only on records the run did
 * not create — linked to what the target already held, or refused.
 */
export type ForgeFileLeftOutReason = 'too-large' | 'external' | 'record-not-created';

/** One file attached to a record in scope. */
export interface ForgeFileEntry {
  /** The object the file is counted under. */
  objectApiName: ForgeFileObject;
  /** Its id in the source: the document, or the attachment. */
  sourceId: string;
  /** Its title or name, as the source holds it. */
  name: string;
  /** Its size in bytes. */
  bytes: number;
}

/** A file a run left out, and why. */
export interface ForgeFileLeftOut extends ForgeFileEntry {
  /** Why it was not copied. */
  reason: ForgeFileLeftOutReason;
}

/** What a run did with the files of one object. */
export interface ForgeFileObjectReport {
  /** The object the files are counted under. */
  objectApiName: ForgeFileObject;
  /** Files within the cap attached to records in scope: what the run set out to copy. */
  planned: number;
  /** Their size, in bytes. */
  plannedBytes: number;
  /** Files written to the target. None on a dry run. */
  copied: number;
  /** Files whose content could not be read, or that the target refused. */
  failed: number;
}

/**
 * What a run did with the files attached to the records it cloned: Salesforce
 * Files, the latest version of each, and legacy attachments.
 */
export interface ForgeFilesReport {
  /** Largest file the run copied, in bytes. */
  maxFileBytes: number;
  /** Per object, what the run copied — or, on a dry run, would copy. */
  objects: ForgeFileObjectReport[];
  /** Links written to the other records in scope a copied file was linked to. */
  links: number;
  /** The files left out, each with why. */
  leftOut: ForgeFileLeftOut[];
  /** On a dry run, every file it would copy. Absent from a run that wrote. */
  wouldCopy?: ForgeFileEntry[];
  /**
   * The target's file storage left, in bytes, as read before anything was
   * written. Absent when there was no file to copy, so none was read.
   */
  remainingStorageBytes?: number;
}

/**
 * The fields of one object a run left out because they hold a file's content:
 * read through the API, each gave the address of its file, never the file.
 */
export interface ForgeFieldsLeftOut {
  /** API name of the object. */
  objectApiName: string;
  /** The fields left empty in every record of it the run wrote. */
  fields: string[];
}

/**
 * When the target org dated a run's writes, by its own clock: what removing
 * the run's records tells a change made since the run by.
 */
export interface ForgeWrittenBetween {
  /** The earliest `CreatedDate` of the records the run created, ISO 8601. */
  first: string;
  /**
   * The latest `LastModifiedDate` the run left on them, read as it ended:
   * a record modified after it was changed since the run. ISO 8601.
   */
  last: string;
}

/**
 * Result returned after a Forge operation completes.
 *
 * Includes the final graph state, timing information, and the
 * count of remapped Salesforce IDs.
 */
export interface ForgeExecutionResult {
  /** Unique identifier for this Forge execution */
  forgeId: string;
  /** Overall outcome of the operation */
  status: 'success' | 'partial' | 'failure';
  /** Final state of the dependency graph */
  graph: ForgeGraph;
  /** Total wall-clock duration in milliseconds */
  duration: number;
  /** ISO 8601 timestamp of when the operation completed */
  timestamp: string;
  /** Number of Salesforce IDs remapped from source to target */
  idRemapCount: number;
  /**
   * Source record Id -> target record Id for everything the run created.
   *
   * The executor has always built and returned this (`IdRemapper.toJSON()`),
   * and the orchestrator kept only its length — so a finished clone could
   * report "312 records" without being able to tell you where any single one
   * of them landed. Answering "where did this Account go in the new sandbox?"
   * needs the map, not the count.
   *
   * Optional because runs recorded before this field existed do not carry it.
   */
  idRemapTable?: Record<string, string>;
  /**
   * Source ids whose `idRemapTable` entry is a record the target already held,
   * linked to rather than created. Optional for runs recorded before it.
   */
  idRemapExisting?: string[];
  /**
   * Records this run created. The graph's per-node counts are never filled
   * in by a run, so without this the results read zero whatever was written.
   * Optional for runs recorded before it.
   */
  createdCount?: number;
  /**
   * Records an upsert matched by their external id and wrote over — the
   * target held them before the run. Absent when the run upserted none; the
   * wizard only ever inserts.
   */
  updatedCount?: number;
  /**
   * Records the target already held and named when it refused them: linked
   * to, never written, and counted in neither the created nor the failed
   * rows. Optional for runs recorded before it.
   */
  linkedExistingCount?: number;
  /**
   * Set when a cancel stopped the run before it was through. The result says
   * what it had done by then; its status is never `success`.
   */
  cancelled?: boolean;
  /**
   * Per object, the rows the target refused because it already held them.
   * Optional for runs recorded before it; empty when the target held none.
   */
  existingRecords?: ForgeExistingRecords[];
  /**
   * `idRemapTable` counted per object. The table alone cannot say which
   * object a row belongs to — a custom object's key prefix is the org's own —
   * so a run's lineage could not be drawn from it. Reference data matched by
   * name and the standard price book are mapped but never written, and are
   * left out. Optional for runs recorded before it.
   */
  idRemapByObject?: ForgeRemapObjectCounts[];
  /**
   * Per object, the rows this run created, objects in the order the run first
   * wrote one of them.
   *
   * `idRemapTable` minus `idRemapExisting` is not what a run created: the
   * table also maps rows the run only found — the standard price book,
   * reference data matched by name — and removing the run's records by it
   * would delete those. Optional for runs recorded before it; such a run
   * cannot have its records removed from the history.
   */
  idRemapCreated?: ForgeCreatedRecords[];
  /**
   * The org the run wrote to, by its id in this machine's org registry.
   *
   * Kept beside `config`, which stays free of orgs so a re-run never replays
   * against yesterday's pair: removing what a run created has to go to the
   * org it wrote to, and to no other. Set on history entries only; optional
   * for runs recorded before it.
   */
  targetOrgId?: string;
  /** Set once the records this run created were removed from its target. */
  undo?: ForgeUndoMark;
  /** Per-object error reports — populated when at least one record or
   *  object failed. Empty when the run was fully successful. */
  errors?: ForgeExecutionError[];
  /**
   * Objects whose source read stopped on a bound (50 000 records or 500
   * pages) instead of at the end of the cursor: the rows past the bound were
   * never read and never cloned, and the run is otherwise a success.
   *
   * Optional because runs recorded before this field existed do not carry it.
   */
  truncatedObjects?: string[];
  /**
   * What the run did with the files of the records it cloned. Absent from a
   * run that was not asked to copy them. The files it created are counted
   * among its objects too, and removing its records removes them.
   */
  files?: ForgeFilesReport;
  /**
   * Per object, the fields left out because they hold a file's content. Absent
   * when the run left none out, and from runs recorded before it was kept.
   */
  fileContentFieldsLeftOut?: ForgeFieldsLeftOut[];
  /**
   * When the target dated the run's writes. Absent from a run that created
   * nothing, one whose dates could not be read back, and runs recorded before
   * it was kept: removing their records dates them from the records instead.
   */
  writtenBetween?: ForgeWrittenBetween;
  /**
   * The configuration that produced this run, minus the org ids.
   *
   * History used to store graph + timings + remap table and nothing you could
   * re-run from: a past clone could be inspected and never repeated. Same
   * shape as {@link ForgeTemplate.config} — the org pair is deliberately
   * dropped, a re-run must re-pick source and target explicitly rather than
   * silently replay against whatever the last run touched.
   *
   * Optional because runs recorded before this field existed do not carry it;
   * a history entry without it simply cannot offer a re-run.
   */
  config?: Omit<ForgeConfig, 'sourceOrgId' | 'targetOrgId'>;
}

/**
 * The anonymization a run was reviewed with, as a template keeps it: the
 * method chosen for each PII category and the preset picked in Review, when
 * one was.
 */
export interface ForgeTemplateAnonymization {
  /** Id of the preset picked in Review (`FORGE_ANONYMIZATION_PRESETS`), when one was. */
  presetId?: string;
  /** Method per PII category. A category left out keeps the method the panel holds. */
  rules: Partial<Record<ForgeAnonymizationCategory, AnonymizationMethod>>;
}

/**
 * Reusable template that stores a Forge configuration along with
 * metadata such as object/record counts and usage timestamps.
 */
export interface ForgeTemplate {
  /** Unique template identifier */
  id: string;
  /** Human-readable template name */
  name: string;
  /** Description of what this template does */
  description: string;
  /** Forge configuration without org-specific fields */
  config: Omit<ForgeConfig, 'sourceOrgId' | 'targetOrgId'>;
  /**
   * The org the run wrote to, by its id in this machine's org registry.
   *
   * Kept apart from `config`, which stays free of orgs so a history entry
   * never replays against yesterday's pair. A template is a recipe someone
   * picks on purpose, and its target is part of the recipe. The id means
   * nothing on another machine: applying the template there leaves the target
   * to be picked.
   */
  targetOrgId?: string;
  /** The anonymization the run was reviewed with. Absent on templates saved before it was kept. */
  anonymization?: ForgeTemplateAnonymization;
  /** Number of objects covered by this template */
  objectCount: number;
  /** Total number of records the template was last used with */
  recordCount: number;
  /** ISO 8601 timestamp of template creation */
  createdAt: string;
  /** ISO 8601 timestamp of last usage */
  lastUsedAt: string;
}

/** PII category for anonymization UI grouping. */
export type ForgeAnonymizationCategory =
  | 'email'
  | 'phone'
  | 'name'
  | 'address'
  | 'ssn_id'
  | 'financial'
  | 'other';

/** Batch strategy for an object during execution. */
export type ForgeBatchStrategy = 'rest' | 'bulk' | 'auto';

/** Cycle resolution strategy. */
export type ForgeCycleStrategy = 'two_pass' | 'upsert_external_id' | 'nullable_lookup';

/** A group of objects that can be processed in parallel. */
export interface ForgeWave {
  /** Wave execution order (0-based). */
  order: number;
  /** Objects in this wave (no inter-dependencies). */
  objectApiNames: string[];
  /** Total records across all objects in this wave. */
  totalRecords: number;
  /** Estimated duration for this wave. */
  estimatedDurationSeconds: number;
  /** Estimated API calls for this wave. */
  estimatedApiCalls: number;
}

/** Execution plan with waves and cycle resolutions. */
export interface ForgePlan {
  /** Ordered execution waves. */
  waves: ForgeWave[];
  /** Total records across all waves. */
  totalRecords: number;
  /** Total estimated API calls. */
  totalApiCalls: number;
  /** Total estimated duration in seconds. */
  estimatedDurationSeconds: number;
  /** Detected cycles and their resolution strategies. */
  cycleResolutions: ForgeCycleResolution[];
}

/** A detected dependency cycle with resolution strategy. */
export interface ForgeCycleResolution {
  /** Objects involved in the cycle. */
  objects: string[];
  /** Resolution strategy. */
  strategy: ForgeCycleStrategy;
  /** Human-readable description. */
  description: string;
}

/** Checkpoint for crash recovery during execution. */
export interface ForgeCheckpoint {
  /** Unique execution ID. */
  forgeId: string;
  /** Forge configuration used. */
  config: ForgeConfig;
  /** Graph state at checkpoint time. */
  graph: ForgeGraph;
  /** Execution plan. */
  plan: ForgePlan;
  /** Current wave index (0-based). */
  currentWaveIndex: number;
  /** Current object index within wave. */
  currentObjectIndex: number;
  /** Current batch index within object. */
  currentBatchIndex: number;
  /** Serialized IdRemapper state (oldId -> newId). */
  remapperState: Record<string, string>;
  /** Objects already fully completed. */
  completedObjects: string[];
  /** ISO 8601 timestamp. */
  timestamp: string;
}
