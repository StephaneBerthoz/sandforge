import type { AnonymizationMethod } from './common.types.js';

/** Mode used to specify the input for a Forge operation */
export type ForgeInputMode = 'record' | 'soql' | 'template' | 'ai';

/** Depth of relationship traversal during graph construction */
export type ForgeDepth = 'direct' | 'full' | 'custom';

/**
 * Status of a single node within the Forge dependency graph.
 *
 * `stopped` is a node a cancel stopped while it was being written: some of
 * its rows may be in the target, the others were never sent. It ended with
 * `done` before, and the graph drew it as finished beside the nodes that were.
 * One whose calls mostly failed ends `error`, as a failed node does. A node
 * the cancel reached before its write began keeps the status it had.
 */
export type ForgeNodeStatus =
  'idle' | 'scanning' | 'running' | 'done' | 'error' | 'skipped' | 'stopped';

/**
 * How the discovery, Review and execution screens show a graph's objects, as
 * the `sandforge.forge.graphView` setting says: drawn as a graph up to a
 * number of objects and as a table past it (`auto`), or always one way.
 */
export type ForgeGraphView = 'auto' | 'graph' | 'table';

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
   * Write email addresses and phone numbers as the source holds them.
   *
   * Absent or false — the default — every row the run writes has them
   * neutralized first, whether it anonymizes or not: an email field's address
   * goes in under `.invalid`, as Salesforce does to the users of a refreshed
   * sandbox, and a phone field's number as a fictional one, in a range no
   * line is ever given; so does a text field whose API name gives it to
   * either. Run into a client's sandbox, a clone met record-triggered flows
   * that email and text the contacts they are created for.
   */
  keepContactPoints?: boolean;

  /**
   * Whether the target's active assignment rules apply to the Cases, Leads
   * and Accounts the run creates or writes again.
   *
   * Forge sets each record's owner itself. Its writes go through REST, where
   * a request that says nothing has the target apply its active assignment
   * rules, which hand the records to whoever they route to and can mail the
   * new owner. Absent or false, every write says `Sforce-Auto-Assign: FALSE`;
   * true says `TRUE`.
   */
  applyAssignmentRules?: boolean;
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
  /**
   * Run as a simulation: the run reads, cleans and checks every row as a real
   * run would, through the write stage, and writes nothing. Its result lists
   * the gaps the target holds against the rows (`ForgeExecutionResult.gaps`).
   */
  dryRun?: boolean;
  /**
   * A picklist value the target refuses, written as another: `to: null`
   * leaves the field out of the rows that hold it. Scoped to one record type
   * of the target (its DeveloperName) when set, to every row of the object
   * otherwise. Decided on Review's Gaps tab, kept in templates.
   */
  picklistValueMappings?: ForgePicklistValueMapping[];
  /** A source record type written as a target one (DeveloperName), or as the object's default (`to: null`). */
  recordTypeMappings?: ForgeRecordTypeMapping[];
  /** A value given to a field the target requires and the rows leave empty. */
  defaultValues?: ForgeDefaultValue[];
  /** Text fields cut to the length the target holds, rather than refused. */
  truncateFields?: ForgeFieldRef[];
  /** Objects of the graph the run does not write, kept with the run and its template. */
  excludedObjects?: string[];
  /** Gaps (`ForgeGap.id`) the user chose to leave as they are. */
  ignoredGaps?: string[];
  /**
   * Gaps whose rows the run holds back rather than writes: the rows of the
   * object that hold the value the gap names in its field — for the record
   * type it names, when it names one. Offered only on the gaps where those
   * rows are exactly the ones the gap is about (`skip_rows`).
   */
  skippedRows?: ForgeSkippedRows[];
}

/** See `ForgeConfig.skippedRows`. */
export interface ForgeSkippedRows {
  object: string;
  /** The gap (`ForgeGap.id`) whose rows are held back. */
  gapId: string;
}

/** A field of an object, by API names. */
export interface ForgeFieldRef {
  object: string;
  field: string;
}

/** See `ForgeConfig.picklistValueMappings`. */
export interface ForgePicklistValueMapping extends ForgeFieldRef {
  /** The target record type's DeveloperName the mapping holds for; every one when absent. */
  recordType?: string;
  from: string;
  /** The value written instead; `null` leaves the field out of those rows. */
  to: string | null;
}

/** See `ForgeConfig.recordTypeMappings`. */
export interface ForgeRecordTypeMapping {
  object: string;
  /** The source record type's DeveloperName. */
  from: string;
  /** The target record type's DeveloperName; `null` for the object's default. */
  to: string | null;
}

/** See `ForgeConfig.defaultValues`. */
export interface ForgeDefaultValue extends ForgeFieldRef {
  value: string | number | boolean;
}

/**
 * What the target holds against the rows a run is about to write, that would
 * refuse a row, change it, or say nothing and surprise the user:
 * - read from its metadata before the run (validation and duplicate rules,
 *   fields only the target requires, lookup filters, the API budget);
 * - found by a simulation, row by row (a picklist value a record type
 *   refuses, a text longer than the field, a unique value already there);
 * - or the platform's own verdict, from a rehearsal it rolled back.
 */
export type ForgeGapKind =
  | 'picklist_value_refused'
  | 'dependent_value_invalid'
  | 'picklist_value_absent'
  | 'required_field_missing'
  | 'value_too_long'
  | 'number_out_of_range'
  | 'record_type_unmapped'
  | 'record_type_unavailable'
  | 'currency_inactive'
  | 'unique_value_collision'
  | 'lookup_filter'
  | 'validation_rule'
  | 'duplicate_rule'
  | 'api_budget'
  | 'rehearsal_refusal'
  /**
   * The platform refused, in a rehearsal, an update the run makes after its
   * inserts — a lookup a second pass fills in, a status given back — of a
   * record it created there: the record goes in, without what the update
   * gives it.
   */
  | 'rehearsal_update_refusal';

/** `blocking`: rows will be refused; `warning`: rows may be, or change; `info`: nothing is refused. */
export type ForgeGapSeverity = 'blocking' | 'warning' | 'info';

/** What the user may decide about a gap, each recorded in `ForgeConfig`. */
export type ForgeGapDecisionKind =
  | 'map_value'
  | 'leave_empty'
  | 'set_default'
  | 'truncate'
  | 'map_record_type'
  | 'exclude_object'
  | 'skip_rows'
  | 'ignore';

/** Where a gap was found. */
export type ForgeGapSource = 'metadata' | 'simulation' | 'rehearsal';

/** One gap. Never a record's data: a picklist value at most, or lengths and counts. */
export interface ForgeGap {
  /** Stable across reads: `forgeGapId(kind, object, field, recordType, value)`. */
  id: string;
  kind: ForgeGapKind;
  severity: ForgeGapSeverity;
  source: ForgeGapSource;
  objectApiName: string;
  field?: string;
  /** The target record type's DeveloperName, when the gap holds for one. */
  recordType?: string;
  /** A picklist value, or a status code for a rehearsal refusal; never a text value. */
  value?: string;
  /** How many rows of the run it touches (0 when read from metadata alone). */
  rows: number;
  /** What the gap is about: allowed values, a length, a rule's name and message… */
  detail?: Record<string, string | number | boolean | string[]>;
  /** The decisions the user can make about it, in the order they are offered. */
  decisions: ForgeGapDecisionKind[];
  /** What the run does about it when the user decides nothing. */
  defaultDecision?: ForgeGapDecisionKind;
}

/**
 * Why a row sent to a rehearsal got no verdict:
 * - `parent_refused`: a record it names, which the run creates, was refused;
 * - `beyond_a_call`: the records it needs before it are more, or deeper, than
 *   one transaction holds;
 * - `call_budget`: the rehearsal used the calls it said it might before the
 *   row's turn came.
 */
export type ForgeRehearsalNotJudgedReason = 'parent_refused' | 'beyond_a_call' | 'call_budget';

/**
 * The platform's own verdict on the rows a run would write, from a rehearsal:
 * a sample of them created in the target inside one transaction per call,
 * which the call then fails on purpose, so that every write is rolled back.
 */
export interface ForgeRehearsal {
  /** Each refusal, as a gap (`source: 'rehearsal'`): the status code, the field, how many rows. */
  gaps: ForgeGap[];
  /** Rows the run would create. */
  rows: number;
  /** Rows sent: the sample, with the records the run creates that its rows name. */
  sampled: number;
  /** Rows sent that got a verdict. */
  judged: number;
  /** Rows judged that would save. */
  passed: number;
  /** Rows sent that got no verdict. */
  notJudged: number;
  /** Per object, the rows that got no verdict and why. */
  notJudgedWhy: Array<{
    objectApiName: string;
    rows: number;
    reason: ForgeRehearsalNotJudgedReason;
  }>;
  /**
   * Updates the run makes after its inserts — the lookups a second pass fills
   * in, the statuses it gives back — each of one record.
   */
  updates: number;
  /**
   * Updates sent that got a verdict: in the call that created their record,
   * after its inserts and before the step that rolls it back. Up to 19, every
   * update is sent; past that, one per object and set of fields.
   */
  updatesJudged: number;
  /** Updates judged that would save. */
  updatesPassed: number;
  /**
   * Updates of the run no judged update stands for: one of a record the
   * target already held, which a rehearsal never writes; one whose record was
   * refused, or that no call could hold; and those of its shape.
   */
  updatesNotRehearsed: number;
  /** Composite calls sent. */
  calls: number;
  /** Composite calls planned before the first was sent. */
  plannedCalls: number;
}

/** How far a rehearsal has got, for the line Review shows under its action. */
export interface ForgeRehearsalProgress {
  /**
   * `reading`: reading and preparing the rows as the run would, nothing sent
   * to the target; `confirming`: waiting on the user's answer; `rehearsing`:
   * sending the calls.
   */
  phase: 'reading' | 'confirming' | 'rehearsing';
  /** The object being read, while reading. */
  objectApiName?: string;
  /** The call under way, and the calls planned, while rehearsing. */
  call?: number;
  calls?: number;
}

/** What a read of the target's gaps found, and what it could not read. */
export interface ForgeTargetGaps {
  gaps: ForgeGap[];
  unread: Array<{ part: string; reason: string }>;
  requests: number;
}

/**
 * A decision of the run's config, as the run applied it: what it changed, and
 * on how many rows. A value, at most a picklist value or a record type's name,
 * or the default the user gave; never a record's own data.
 */
export interface ForgeDecisionApplied {
  kind: Extract<
    ForgeGapDecisionKind,
    'map_value' | 'leave_empty' | 'set_default' | 'truncate' | 'map_record_type' | 'skip_rows'
  >;
  objectApiName: string;
  field?: string;
  /** The target record type a picklist mapping is scoped to. */
  recordType?: string;
  /** The value or record type read; absent for a default and a cut. For rows held back, the value they hold. */
  from?: string;
  /** What the rows got instead; absent when the field was left out, or cut. */
  to?: string;
  rows: number;
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
  /**
   * Whether nobody counted this node's records, so its `recordCount` is a
   * placeholder zero rather than an empty table.
   *
   * Discovery counts every table it reaches. A starter template's graph skips
   * discovery and starts each count at zero, and Review read those zeros as
   * counted: "Will clone 0 objects", every object of the template "Skipped
   * (empty)", before a run that clones them all. The run counts what it
   * reads. Absent on every node discovery counted.
   */
  recordCountUnknown?: boolean;
  /** Number of fields included in the operation */
  fieldCount: number;
  /** Current processing status of this node */
  status: ForgeNodeStatus;
  /** Processing progress from 0 to 100 */
  progress: number;
  /** Whether this node is included in the current operation */
  included: boolean;
  /**
   * Whether the user took this node out of the run on the Forge page.
   *
   * Discovery leaves nodes out too — the empty tables, the objects it could
   * not describe or count — and never marks them. A run treats a node the user
   * left out as an object excluded by name: it holds back the rows that cannot
   * be written without one of its records, and says so. Unmarked, those rows
   * were sent, and the target refused each. Absent on a graph built before
   * the page marked them, and on every node the user did not take out.
   */
  leftOutByUser?: boolean;
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
  /**
   * Whether a row of the child can be written with this lookup set, at insert
   * or by the second pass's update: false when no field of the child that
   * names the parent can be set by either — a person account's
   * `PersonContactId`, a quote's `AccountId`. The platform fills such a field
   * itself, so the edge orders nothing: neither the write order nor the plan
   * waits on it, and a parent that fails takes nothing down through it. It
   * stays in the graph for what it reaches: a scoped read follows it to the
   * rows under a parent in scope. Optional: an edge that does not say is one
   * a row can set.
   */
  settable?: boolean;
  /**
   * Whether a field of the child that names the parent is one only an insert
   * sets: createable, not updateable — an email's case. The second pass
   * fills in a lookup by an update, which the platform refuses for it, so a
   * row written before its parent keeps it empty for good: the parent goes
   * first wherever the required edges leave the order free. Not a parent the
   * child cannot be written without, unless `required` says so too. Optional:
   * an edge that does not say is one an update can set.
   */
  insertOnly?: boolean;
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
  /**
   * Set on the report of reference data rows the target holds no match for by
   * name. Matched, never written, they are neither created nor failed, and
   * the run counts them among neither. The other `'scope'` reports that count
   * rows count the ones the run held back before sending them, which it
   * counts as failed. Absent from every other report.
   */
  referenceData?: boolean;
  /**
   * Set on the report of an object skipped whole: a record its rows cannot be
   * written without failed in this run, or the target takes no insert of it
   * and the clone holds records of it. `failedCount` counts the rows the run
   * had read of it, which it counts as failed; skipped before its read, or
   * read only to know whether the clone holds any, it counts none, the run
   * never having learned how many there were. The object is named either
   * way, where a `'scope'` report that counts no row is otherwise a note.
   * Absent from every other report.
   */
  skipped?: boolean;
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
 * The rows of one object a Forge run read from the source to clone: the
 * records of it the clone held, whatever each came to — created, updated,
 * linked to one the target already held, failed or held back.
 */
export interface ForgeReadRecords {
  /** API name of the object. */
  objectApiName: string;
  /** Rows read. */
  read: number;
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
 * Files a removal leaves in the org: attached to records it deleted, and not
 * created by what it took back.
 */
export interface ForgeRemovalFilesLeft {
  /** How many. */
  count: number;
  /**
   * The first few by their title, as the org has it — by their id where the
   * title could not be read.
   */
  names: string[];
}

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
   * with them — one from before the run, one of the run's own the removal keeps
   * or the org refused to delete, and, unless the request included what changed
   * since the run, one added or changed since — or would have the org refuse
   * their delete: a record pointing at them through a lookup the org restricts
   * the delete by, a custom price holding its product's standard one, an
   * active price its selling model option, an order past Draft that stays
   * the items and actions the platform locks under it, and an activated
   * contract that stays its item prices.
   */
  keptDependents: number;
  /** Records the org refused to delete. */
  refused: number;
  /**
   * Records no query found when the removal began, and that are not in the
   * org's recycle bin either: out of the sight of the user the removal ran as
   * — sharing, an owner whose records it does not reach — or deleted for good,
   * which some objects always are. Never counted as removed: they may still
   * be in the org. Absent when there were none.
   */
  notVisible?: number;
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
   * and a status the removal set to Draft for a delete and gave back, or could
   * not: each reason once, and a few at most.
   */
  reasons: string[];
  /**
   * The files attached to the records the removal deleted, which the run did
   * not create — a PDF the org generated as an order was activated. The org
   * keeps a file when the record it was attached to goes, linked to whoever
   * owns it; the removal names them and leaves them there. Absent when there
   * were none.
   */
  filesLeft?: ForgeRemovalFilesLeft;
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
  /**
   * Set on a removal of what an earlier removal of the run left in the org:
   * when that one ended, ISO 8601. It set out to take only those records.
   */
  leftBy?: string;
  /**
   * Rows of the run a call may have written before its answer was lost
   * (`ForgeExecutionResult.mayHaveBeenWritten`): they may sit in the org, and
   * the removal, which knows no id of theirs, cannot reach them. Absent when
   * there were none.
   */
  mayHaveBeenWritten?: number;
}

/**
 * What a history entry remembers of the removals of the records its run
 * created, once one deleted some or found some gone, whether it ended or was
 * cancelled: when the last such removal ended, the records deleted and found
 * gone by all of them, and what the last one left in the org — kept, refused,
 * or not reached before a cancel. One that left none in the org took the run
 * back, and is not offered again; one that left some is offered again, for
 * those.
 */
export interface ForgeUndoMark {
  /** ISO 8601 timestamp of when the last removal ended. */
  removedAt: string;
  /** Records deleted, by every removal that marked the run. */
  deleted: number;
  /** Records no longer in the org when a removal that marked the run reached them. */
  alreadyGone: number;
  /** Records the last removal kept: modified since the run, or holding records that stay. */
  kept: number;
  /** Records the org refused the last removal. */
  refused: number;
  /**
   * Records the last removal did not reach, cancelled before their turn: the
   * next removal takes them. Absent when it reached every record it set out
   * to take, and from marks kept before cancelled removals marked the run.
   */
  notReached?: number;
  /**
   * Records the last removal could not see, and found in no recycle bin
   * (`ForgeUndoObjectResult.notVisible`): a removal run by a user who sees
   * them takes them. Absent when there were none.
   */
  notVisible?: number;
}

/**
 * What removing a run's records needs, kept apart from the run's history
 * entry so the run stays removable once the history has dropped it: ids and
 * dates only, never a value of a record.
 */
export interface ForgeRemovalPlan {
  /** The run, by its `forgeId`. */
  forgeId: string;
  /** The org it wrote to, by its id in this machine's org registry. */
  targetOrgId: string;
  /** When the run was recorded, ISO 8601, right after its last write. */
  timestamp: string;
  /** How long the run took, in milliseconds. */
  duration: number;
  /** How the run ended. */
  status: ForgeExecutionResult['status'];
  /** Set when a cancel stopped the run. */
  cancelled?: true;
  /** When the target dated the run's writes, when it could tell. */
  writtenBetween?: ForgeWrittenBetween;
  /**
   * The records the run created, per object, by their target ids, in the
   * order a removal takes them (`forgeRunCreatedRecords`).
   */
  objects: Array<{ objectApiName: string; ids: string[] }>;
  /** Records the run linked to, which a removal leaves where they are. */
  linked: number;
  /** Rows a call of the run may have written under ids it never learned. */
  mayHaveBeenWritten?: number;
  /** What the removals of the run's records did, once one took some. */
  undo?: ForgeUndoMark;
  /** See `ForgeExecutionResult.removalStamps`. */
  removalStamps?: Record<string, string>;
  /** See `ForgeExecutionResult.removalSpans`. */
  removalSpans?: ForgeRemovalSpan[];
  /** See `ForgeExecutionResult.removalLeft`. */
  removalLeft?: string[];
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
  /**
   * On a dry run, why the files of its records could not all be looked up in
   * the source: the refusal a real run stops on before writing anything. The
   * files it lists are then only those the lookups that answered found.
   * Absent when every lookup answered, and from a run that wrote, which
   * never gets past it.
   */
  lookupFailure?: string;
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
 * What refused a field rows went in without: a validation rule of the target
 * (`FIELD_CUSTOM_VALIDATION_EXCEPTION`), a restricted picklist of the target
 * that refused its value (`INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST`), or the
 * lookup filter of a lookup the target lets be empty, which refused the record
 * it names (`FIELD_FILTER_VALIDATION_EXCEPTION`). The picklist's refusal gets
 * past the check made before the write when the record type the row goes in
 * with was never given values of the field: it takes none of them, while the
 * target's UI API answers the field's every value for it.
 */
export type ForgeFieldRefusal = 'validation-rule' | 'restricted-picklist' | 'lookup-filter';

/** A field the target refused rows on, left out as they were written again. */
export interface ForgeRefusedField {
  /** The field, by the API name the run writes it under. */
  field: string;
  /**
   * What refused it. Absent from runs recorded before a restricted picklist's
   * refusal was written again: a validation rule's was the only one then.
   */
  refusedBy?: ForgeFieldRefusal;
  /**
   * What the target refused the rows with, `STATUS_CODE: message`: the rule's
   * own words, the picklist's, which name the value it refused, or the
   * lookup filter's.
   */
  reason: string;
  /**
   * Rows written without it: sent again without it once refused, or, its
   * value refused under the same record type earlier in the run, sent without
   * it from the start.
   */
  rows: number;
}

/**
 * The rows of one object the target refused on fields it named — a validation
 * rule, a restricted picklist refusing their value, or the lookup filter of a
 * lookup the target lets be empty — written again without those fields and
 * taken that time. A row refused without a field named, or refused again with
 * nothing more it could go without, is a failure instead.
 */
export interface ForgeWrittenWithoutFields {
  /** API name of the object. */
  objectApiName: string;
  /** Rows written so: among the records the run created, or wrote over by an upsert. */
  rows: number;
  /** Each field left out of them, with the refusal that named it. */
  fields: ForgeRefusedField[];
}

/**
 * Why a run did not write a picklist value as it read it: the target has no
 * such value for the field, the record type the row goes in with does not keep
 * it, or the value of the field it depends on does not allow it.
 */
export type ForgePicklistRefusal = 'not-in-target' | 'record-type' | 'controlling-value';

/**
 * Picklist values of one field of one object that a run did not write as it
 * read them, for one reason, and what the rows were written with instead.
 */
export interface ForgePicklistValuesChanged {
  /** API name of the object. */
  objectApiName: string;
  /** API name of the field. */
  field: string;
  /** Why the target would have refused them. */
  reason: ForgePicklistRefusal;
  /** The values read that it would have refused, each once. */
  values: string[];
  /** The rows that carried one of them. */
  rows: number;
  /** The record type the rows went in with, by API name, when the run read what it allows. */
  recordType?: string;
  /** For `controlling-value`, the field whose value decides. */
  controllingField?: string;
  /** What the rows were written with instead; absent when the value was left out. */
  replacedBy?: string;
  /**
   * How `replacedBy` was chosen: `default`, the record type's default for the
   * field; `first`, the first value the record type allows, for a field the
   * target requires that the record type sets no default for.
   */
  replacement?: 'default' | 'first';
}

/** What a contact point field holds: email addresses, or phone numbers. */
export type ForgeContactPointKind = 'email' | 'phone';

/** One field whose values a run neutralized, and how many of them. */
export interface ForgeContactPointField {
  /** API name of the object. */
  objectApiName: string;
  /** The field, by the API name the run writes it under. */
  field: string;
  /** What it holds. */
  kind: ForgeContactPointKind;
  /** The values neutralized, in the rows the run sent. */
  values: number;
}

/**
 * What a run did with the email addresses and phone numbers of the rows it
 * wrote: neutralized them, unless it was told to keep them as they are
 * (`ForgeConfig.keepContactPoints`). A dry run counts what it would neutralize.
 */
export interface ForgeContactPointsReport {
  /**
   * Whether the run neutralized them: every address under `.invalid`, every
   * phone number a fictional one. False when it kept them as the source holds
   * them, and then nothing is counted.
   */
  neutralized: boolean;
  /** Each field that had a value neutralized, objects in the order the run wrote them. */
  fields: ForgeContactPointField[];
  /** The values neutralized, every field together. */
  values: number;
  /**
   * The phone numbers left out, their field empty, because every fictional
   * number of the range was already given to another number of the run: the
   * range holds 10 000. Absent when none was.
   */
  numbersExhausted?: number;
}

/**
 * When the target org dated a run's writes, by its own clock: what removing
 * the run's records tells a change made since the run by.
 */
export interface ForgeWrittenBetween {
  /**
   * The earliest `CreatedDate` of the records the run created, ISO 8601 — the
   * system stamp of a record whose audit dates the run may have copied from
   * the source, both orgs letting its user set them.
   */
  first: string;
  /**
   * The latest `LastModifiedDate` the run left on them, read as it ended —
   * the system stamp, likewise: a record modified after it was changed since
   * the run. ISO 8601.
   */
  last: string;
}

/**
 * What a verification of a run's records concluded: `verified` when every
 * record it read back is in the target and every lookup it checked points at
 * the record the run set it to; `partial` when a record is gone, deleted or
 * out of the user's sight, a lookup points elsewhere or is empty, or a part
 * could not be checked; `unstable` when no two readings of the target agreed
 * within the attempts, the target still being written to.
 */
export type ForgeVerificationVerdict = 'verified' | 'partial' | 'unstable';

/** A lookup of a record the run created that no longer points where the run set it. */
export interface ForgeVerificationLink {
  /** The record, by its id in the target. */
  recordId: string;
  /** The lookup, by its API name in the target. */
  field: string;
  /** The id the record's parent got in the target: what the run set the lookup to. */
  expected: string;
  /** What the target holds in it now; null when it is empty. */
  found: string | null;
}

/** A record the run created that was modified after the run ended. */
export interface ForgeVerificationChange {
  /** The record, by its id in the target. */
  recordId: string;
  /** When the target last modified it, as the org wrote the date. */
  modifiedAt: string;
  /** The user who did, by id, when the object keeps who modified it. */
  modifiedById?: string;
}

/** What a verification found of one object's records the run created. */
export interface ForgeVerificationObject {
  /** API name of the object. */
  objectApiName: string;
  /** The records of the object the verification set out to read back. */
  expected: number;
  /** Read back from the target. */
  present: number;
  /** In the target's recycle bin. */
  deleted: number;
  /**
   * Neither read back nor in the recycle bin: emptied from the bin, or out of
   * the sight of the user the target is read as. Never taken for deleted.
   */
  notVisible: number;
  /**
   * Of the present, the records modified after the run ended, by someone or by
   * automation: a removal keeps them unless it is told to take them too.
   */
  changed: number;
  /** The first few of them. */
  changedRecords: ForgeVerificationChange[];
  /** The first few deleted, by id. */
  deletedIds: string[];
  /** The first few not visible, by id. */
  notVisibleIds: string[];
  /** The lookups checked on the sample of the object's records. */
  linksChecked: number;
  /** Of those, the ones that point elsewhere than the run set them, or are empty. */
  linksBroken: number;
  /** The first few of them. */
  brokenLinks: ForgeVerificationLink[];
  /** Why the object could not be read; nothing of it was judged then. */
  error?: string;
  /** Why its lookups could not be checked, when they could not. */
  linksUnchecked?: string;
  /** Why the recycle bin could not be read for the records not read back. */
  recycleBinUnread?: string;
}

/**
 * A verification of what a run created, once the target has settled: every
 * record read back, a sample of each object's lookups checked against the
 * ids the run's parents got, and the records changed since the run, read
 * until two readings agree.
 */
export interface ForgeRunVerification {
  /** What it concluded. */
  verdict: ForgeVerificationVerdict;
  /** When it ended, ISO 8601. */
  verifiedAt: string;
  /** How many times the target was read: two that agree end it early. */
  attempts: number;
  /** Per object, in the order the run's records are listed. */
  objects: ForgeVerificationObject[];
  /**
   * Why no lookup was checked: the run did not keep the org it read from, or
   * that org could not be read. Absent when they were checked.
   */
  linksUnchecked?: string;
}

/**
 * When one removal of a run's records ran, by the target org's clock, and as
 * which user: what that user created in the org meanwhile is the org's answer
 * to the removal, not a record added since the run.
 */
export interface ForgeRemovalSpan {
  /** When it started, ISO 8601, to the second. */
  first: string;
  /** The latest the org can have dated what it made the org write, ISO 8601. */
  last: string;
  /** The id of the user it ran as. */
  userId: string;
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
   * Of `idRemapExisting`, the records the platform wrote with one this run
   * created, and deletes with it: the run never wrote them, so a removal
   * neither keeps them nor deletes them on their own. The contact of a person
   * account ("You can modify a person contact but you can't create or delete
   * a person contact … Instead, delete or modify the account": SOAP API
   * Developer Guide, "Person Account Record Types"); a contact's direct
   * relation to its account ("To remove a direct relationship between a
   * contact and an account, change the contact's primary account or delete
   * the contact": Salesforce Help, "Considerations for Relating a Contact to
   * Multiple Accounts"); the task of an email on no case ("Deleting an
   * EmailMessage record automatically deletes the associated Task":
   * Salesforce Help, knowledge article 000384885). Absent when there were
   * none, and from runs recorded before it was kept.
   */
  idRemapWithTheirRecord?: string[];
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
   * Per object, the rows the run read from the source to clone, objects in
   * the order it read them: what the run set out to write.
   *
   * The graph's counts are discovery's, a count of each whole table. That is
   * what a run that reads whole tables reads; a record-scoped clone of a few
   * hundred records was measured against the tables they were cut from, tens
   * of thousands of rows. An object the run did not read — left out, skipped
   * before its read, or whose read failed — is not listed. Optional for runs
   * recorded before it.
   */
  readByObject?: ForgeReadRecords[];
  /**
   * Objects whose read from the source failed, in the order they failed:
   * nothing of them was cloned, and `readByObject` leaves them out, so what
   * it adds up to is not all the run set out to clone. A record-scoped run
   * never learned how many rows its scope held of them; each is a failure of
   * the run all the same. Optional for runs recorded before it.
   */
  failedReads?: string[];
  /**
   * The org the run wrote to, by its id in this machine's org registry.
   *
   * Kept beside `config`, which stays free of orgs so a re-run never replays
   * against yesterday's pair: removing what a run created has to go to the
   * org it wrote to, and to no other. Set on history entries only; optional
   * for runs recorded before it.
   */
  targetOrgId?: string;
  /**
   * The org the run read from, by its id in this machine's org registry, kept
   * beside `config` as `targetOrgId` is: a verification reads there what each
   * record pointed at, to check its lookups in the target. Set on history
   * entries only; absent from runs recorded before it was kept.
   */
  sourceOrgId?: string;
  /**
   * The last verification of the records this run created, once one ran.
   * Absent until then, and from a simulation, which wrote nothing.
   */
  verification?: ForgeRunVerification;
  /**
   * Set once a removal of the records this run created deleted some, or found
   * some gone, cancelled or not: see {@link ForgeUndoMark}.
   */
  undo?: ForgeUndoMark;
  /**
   * The run this one retried, by its `forgeId`: the rows that run had written
   * were linked to and never written again, and this run's `idRemapTable`
   * holds them among the records the target already held. Absent from a run
   * started from Review.
   */
  retryOf?: string;
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
   * Per object and field, the picklist values the run did not write as it read
   * them, the target being bound to refuse them — replaced or left out — and
   * why. Absent when there were none, and from runs recorded before it was kept.
   */
  picklistValuesChanged?: ForgePicklistValuesChanged[];
  /**
   * Per object, the rows written again without the fields the target refused
   * them on: a validation rule's, a restricted picklist's refusing their
   * value, or a lookup filter's refusing the record a lookup names. Absent
   * when there were none, and from runs recorded before a refused row was
   * written again.
   */
  writtenWithoutFields?: ForgeWrittenWithoutFields[];
  /**
   * Whether the run neutralized the email addresses and phone numbers it
   * wrote, and how many fields and values. Absent from runs recorded before it
   * was kept, which wrote them as the source held them unless they anonymized.
   */
  contactPoints?: ForgeContactPointsReport;
  /** The gaps a simulation found, row by row; set by a run with `dryRun`. */
  gaps?: ForgeGap[];
  /**
   * Set on a simulation (`ForgeConfig.dryRun`): it read, cleaned and checked
   * every row through the write stage and wrote nothing. Its `createdCount` is
   * 0, and `wouldInsertCount` says what a real run would have created.
   */
  dryRun?: true;
  /** The records a simulation would have created; absent from a real run. */
  wouldInsertCount?: number;
  /**
   * The decisions of the run's config it applied, each with the rows it
   * changed: a picklist value written as another or left out, a record type
   * mapped, a default given, a text cut to the target's length. Absent when
   * none changed a row.
   */
  decisionsApplied?: ForgeDecisionApplied[];
  /**
   * Per object, the rows of a call whose answer never came back, by source id:
   * the target may hold any of them under an id the run never learned. Counted
   * as failed, left out of what the run created, and out of reach of the
   * removal of its records. Absent when every call was answered.
   */
  mayHaveBeenWritten?: Array<{ objectApiName: string; sourceIds: string[] }>;
  /**
   * When the target dated the run's writes. Absent from a run that created
   * nothing, one whose dates could not all be read back, and runs recorded
   * before it was kept: removing their records dates them from the records
   * and from `timestamp` instead.
   */
  writtenBetween?: ForgeWrittenBetween;
  /**
   * The calls to Salesforce the run made, as it counted them: the record
   * types it read from both orgs before it started, its reads and each
   * further page of them, the describes and the record types' picklist values
   * it needed, its writes, the second pass and the files it copied — up to
   * where it ended or stopped.
   *
   * The graph's `estimatedApiCalls` are discovery's guess at the writes of
   * each whole table, 0 on a starter template's graph, and the results added
   * them up as the calls the run consumed. Absent from runs recorded before
   * the calls were counted, whose results can give that estimate alone.
   */
  apiCalls?: number;
  /**
   * What removals of the run's records left on records they did not delete —
   * an order set to Draft for a delete that did not happen, then given its
   * status back; an opportunity whose amount changed as its line items went —
   * by record id: the `LastModifiedDate` the org left on each. A later removal
   * reads a record modified no later than that as unchanged since the run.
   * Absent until a removal left one.
   */
  removalStamps?: Record<string, string>;
  /**
   * When the removals of the run's records that wrote to the org ran, and as
   * which user: what the org created in answer to one of them — a tracked
   * change in an opportunity's feed, as its amount changed with its line
   * items — a later removal takes for that removal's doing, not for a record
   * added since the run. Absent until a removal wrote.
   */
  removalSpans?: ForgeRemovalSpan[];
  /**
   * The records the run created that its removals have not deleted or found
   * gone, by target id: what the next removal sets out to take. A removal
   * that kept a few for a change since, or had them refused, left those, and
   * one cancelled left what it had not reached. Absent until a removal took
   * a record: the next one takes what the run created.
   */
  removalLeft?: string[];
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
  /**
   * The personal fields anonymized on each object, as Review left them: every
   * object that holds one, with the fields chosen on it, none included. Put
   * back on the graph a discovery of the template answers with, after its
   * preset, and only among the personal fields that discovery finds.
   */
  fields?: Array<{ objectApiName: string; fieldNames: string[] }>;
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
  /**
   * The choice to copy the files of the cloned records, and the largest file
   * copied; absent when the run copied none. Never the acceptance that files
   * go as they are: each run asks for it again.
   */
  files?: { maxFileSizeMB: number };
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
  'email' | 'phone' | 'name' | 'address' | 'ssn_id' | 'financial' | 'other';

/** Batch strategy for an object during execution. */
export type ForgeBatchStrategy = 'rest' | 'bulk' | 'auto';

/**
 * Cycle resolution strategy. `unbreakable`: a lookup the record may not leave
 * empty points at a record no order writes first, so the run cannot get
 * through the cycle and those records are refused.
 */
export type ForgeCycleStrategy =
  'two_pass' | 'upsert_external_id' | 'nullable_lookup' | 'unbreakable';

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

/**
 * When a record-triggered flow of the target runs in the save of a record, as
 * `FlowDefinitionView.TriggerType` says it: `RecordBeforeSave`,
 * `RecordAfterSave`, `RecordBeforeDelete`.
 */
export type ForgeFlowTiming = 'beforeSave' | 'afterSave' | 'beforeDelete';

/**
 * The writes of a record that start a flow of the target, as
 * `FlowDefinitionView.RecordTriggerType` says them.
 */
export type ForgeFlowStart = 'create' | 'update' | 'createAndUpdate' | 'delete';

/** An event an Apex trigger of the target runs on, as its `Usage…` flags say. */
export type ForgeTriggerEvent =
  | 'beforeInsert'
  | 'afterInsert'
  | 'beforeUpdate'
  | 'afterUpdate'
  | 'beforeDelete'
  | 'afterDelete'
  | 'afterUndelete';

/**
 * A custom permission a flow's start condition names — or the Decision it
 * starts with, or a workflow rule's criteria.
 */
export interface ForgeFlowPermission {
  /** API name of the custom permission, as `$Permission.<name>` names it. */
  name: string;
  /**
   * Whether the condition keeps the flow from starting for a user who holds
   * the permission: `NOT({!$Permission.X})`, or the permission compared with
   * false. A permission named any other way may as well be what starts the
   * flow, and assigning it would not keep the flow quiet.
   */
  bypass: boolean;
  /**
   * `decision` when one of the flow's Decisions tests it rather than its start
   * condition: a bypass only when the Decision every path of the flow starts
   * with ends the flow on it, before it does anything. Absent for the start
   * condition.
   */
  where?: 'decision';
  /**
   * Whether the user the read ran as — the user the run writes as — holds the
   * permission, from the custom permissions that user is given
   * (`UserSetupEntityAccess`). Absent when it could not be read.
   */
  held?: boolean;
}

/**
 * Something other than a custom permission that a flow tests of the user who
 * writes or of the org's settings: a hierarchy custom setting (`$Setup`), a
 * field of the user (`$User`), the user's profile (`$Profile`), or a custom
 * metadata record (`$CustomMetadata`). Orgs keep their flows quiet for loads
 * with these as often as with a permission.
 */
export interface ForgeFlowSwitch {
  /**
   * The global as the flow writes it, without braces:
   * `$Setup.Bypass__c.Flows__c`, `$User.Bypass_Flows__c`, `$Profile.Name`,
   * `$CustomMetadata.Switch__mdt.Default.Off__c`.
   */
  reference: string;
  /**
   * The value that keeps the flow quiet when the global holds it, as the flow
   * writes it; absent for a checkbox that keeps it quiet when true.
   */
  value?: string;
  /**
   * Where the flow tests it: its start condition — a workflow rule's
   * criteria — or one of its Decisions.
   */
  where: 'start' | 'decision';
  /**
   * Whether that value keeps the flow from doing anything; false when the flow
   * only tests the global in one of its Decisions, which may or may not be a
   * way out of it.
   */
  bypass: boolean;
}

/**
 * A path of a record-triggered flow that runs once the save is committed: its
 * asynchronous path, or a scheduled path. What it does is out of the reach of
 * a rollback, and an email or a text message it sends is sent all the same.
 * Also what a workflow rule's time-dependent actions are.
 */
export interface ForgeFlowPath {
  /** `async`: as soon as the save is committed; `scheduled`: at a time set from it. */
  kind: 'async' | 'scheduled';
  /** Its label, when the flow's metadata was read. */
  label?: string;
  /** For a scheduled path, how far from its time source it runs; negative, before it. */
  offset?: number;
  /** For a scheduled path, the unit of the offset: `Minutes`, `Hours`, `Days` or `Months`. */
  unit?: string;
  /** For a scheduled path timed from a field of the record, that field; absent when timed from the save. */
  field?: string;
}

/** A daily email limit of an org, as its `/limits` name it. */
export type ForgeEmailLimit = 'SingleEmail' | 'DailyWorkflowEmails';

/**
 * An action of the target's automation that reaches someone outside the org:
 * an email alert or a Send Email, a custom notification, an outbound message,
 * or a text message.
 */
export interface ForgeMessageAction {
  /** What it sends. */
  kind: 'email' | 'notification' | 'outbound' | 'sms';
  /** The action's label, or its name. */
  name: string;
  /**
   * For an email, the daily limit it counts against, as the org's `/limits`
   * name it: a Send Email action's are single emails, an email alert's are
   * workflow emails. Past what is left of it, the action fails, and a flow
   * that fails in the save refuses its record.
   */
  limit?: ForgeEmailLimit;
  /**
   * True for a text message told from the name of an Apex action alone: the
   * platform has no action of its own for one, and what the class does is not
   * read.
   */
  guessed?: boolean;
}

/**
 * An active record-triggered flow of the target, on an object a run writes.
 * A Process Builder process and a workflow rule are read into the same shape,
 * as what runs after the save.
 */
export interface ForgeTargetFlow {
  /** Its API name. */
  apiName: string;
  /** Its label, as Setup shows it. */
  label: string;
  /** When it runs in the save. */
  timing: ForgeFlowTiming;
  /** The writes that start it. */
  startsOn: ForgeFlowStart;
  /**
   * Whether its start condition was read — for a process or a workflow rule,
   * its definition: `notRead` past the bound the read keeps to, one request
   * each; `unreadable` when the org refused it.
   */
  condition: 'read' | 'notRead' | 'unreadable';
  /** The custom permissions its start condition names; empty when none, or not read. */
  permissions: ForgeFlowPermission[];
  /**
   * What runs of it once the save is committed. A flow's asynchronous path is
   * known before its metadata is read; its scheduled paths only from it.
   */
  paths?: ForgeFlowPath[];
  /** Its actions that send something out of the org, as its metadata names them. */
  messages?: ForgeMessageAction[];
  /** The custom settings, user fields, profiles and custom metadata it tests. */
  switches?: ForgeFlowSwitch[];
}

/** An active Apex trigger of the target, on an object a run writes. */
export interface ForgeTargetTrigger {
  /** Its name, after its namespace when a package installed it. */
  name: string;
  /** The events it runs on. */
  events: ForgeTriggerEvent[];
}

/** An active assignment rule of the target, on the Cases or the Leads a run writes. */
export interface ForgeTargetAssignmentRule {
  /** Its name, as Setup shows it. */
  name: string;
}

/**
 * An active duplicate rule of the target, on an object a run writes. Whether
 * it alerts or blocks is in its metadata alone, which the read does not take.
 */
export interface ForgeTargetDuplicateRule {
  /** Its label, as Setup shows it. */
  name: string;
  /** Its API name. */
  developerName: string;
}

/**
 * What the target runs on one object a run writes. Every list the read made
 * is there, empty when it found nothing; one written before that part was
 * read leaves it out.
 */
export interface ForgeTargetObjectAutomation {
  objectApiName: string;
  flows: ForgeTargetFlow[];
  triggers: ForgeTargetTrigger[];
  /** Its active Process Builder processes, read into the shape of a flow that runs after the save. */
  processes?: ForgeTargetFlow[];
  /**
   * Its workflow rules, read into the shape of a flow that runs after the
   * save. A rule whose definition was read is active; one left unread may not
   * be, and is kept rather than left unsaid.
   */
  workflowRules?: ForgeTargetFlow[];
  /** Its active assignment rule: Case and Lead have one at most. */
  assignmentRules?: ForgeTargetAssignmentRule[];
  /** Its active duplicate rules. */
  duplicateRules?: ForgeTargetDuplicateRule[];
}

/** A part of the target's automation the read could not read, and why. */
export interface ForgeTargetAutomationUnread {
  /**
   * `flows`, `triggers`, `conditions` — the start conditions of flows —,
   * `processes`, `workflowRules`, `definitions` — those of processes and
   * workflow rules —, `assignmentRules`, `duplicateRules`,
   * `userPermissions` — the custom permissions of the user the read ran as —
   * or `permissionSets`: the permission sets that hold a bypass that user
   * does not.
   */
  part:
    | 'flows'
    | 'triggers'
    | 'conditions'
    | 'processes'
    | 'workflowRules'
    | 'definitions'
    | 'assignmentRules'
    | 'duplicateRules'
    | 'userPermissions'
    | 'permissionSets';
  /** The org's answer, or what kept the read from it. */
  reason: string;
}

/**
 * A permission set of the target that includes a custom permission
 * (`SetupEntityAccess` joined to `PermissionSet`): one a user can be
 * assigned, neither a profile's own nor a permission set group's.
 */
export interface ForgePermissionSetGrant {
  /**
   * Its API name, as `sf org assign permset --name` takes it: after its
   * namespace's prefix and two underscores when a package installed it.
   */
  name: string;
  /** Its label, as Setup shows it. */
  label: string;
  /**
   * How much it grants: the custom permissions, Apex classes, pages, tabs
   * and other setup entities it gives access to, and the objects it gives
   * permissions on. The smallest gives the least beside the bypass.
   */
  grants: number;
}

/**
 * A custom permission that keeps a flow quiet for the user who holds it, and
 * the permission sets of the target that include it, the smallest first;
 * none when no permission set a user can be assigned holds it.
 */
export interface ForgeBypassGrant {
  /** The custom permission, as `$Permission.<name>` names it. */
  permission: string;
  permissionSets: ForgePermissionSetGrant[];
}

/**
 * What the target org runs on the objects a Forge run writes, read before the
 * run: its active record-triggered flows, Apex triggers, Process Builder
 * processes, workflow rules, assignment rules and duplicate rules, what of
 * them runs after the save is committed or sends messages, and what keeps a
 * flow quiet for the user the run writes as. A read that fails on one part
 * says so in `unread`, and never stops the run.
 */
export interface ForgeTargetAutomation {
  /** The objects the read looked at: those the run writes. */
  objectsRead: string[];
  /** The objects that run something, in the order the run's objects were given. */
  objects: ForgeTargetObjectAutomation[];
  /** What could not be read, and why; empty when everything was. */
  unread: ForgeTargetAutomationUnread[];
  /** Start conditions left unread past the bound. */
  conditionsNotRead: number;
  /** The most start conditions the read reads, one request each. */
  conditionsBound: number;
  /** Definitions of processes and workflow rules left unread past their bound. */
  definitionsNotRead?: number;
  /** The most definitions of processes and workflow rules the read reads, one request each. */
  definitionsBound?: number;
  /**
   * For each bypass the user the run writes as does not hold, the permission
   * sets that include it: what to assign to keep its flows quiet. Absent
   * when no such bypass was named, or the permission sets could not be read.
   */
  bypassGrants?: ForgeBypassGrant[];
  /** The requests the read sent to the target. */
  requests: number;
}

/**
 * What may refuse the removal of a run's records on one object it writes,
 * said before the run: a record-triggered flow that runs before a delete, an
 * Apex trigger on a delete — one a managed package installed, which no one in
 * the org can change, apart — or records that lock past Draft.
 */
export interface ForgeRemovalRisk {
  objectApiName: string;
  kind: 'flow' | 'trigger' | 'packageTrigger' | 'lock';
  /** The flow's label or the trigger's name; absent for a lock. */
  name?: string;
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
