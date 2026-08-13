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
   * required reference field whose target wasn't in the discovery graph
   * (Wave 2 v4). Defaults to `false`. See `ForgeExecutor.ExecuteOptions`
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
   * Per-object SOQL WHERE filter appended to scoped queries.
   * Example: `{ Case: "Status = 'Open' AND CreatedDate > LAST_N_DAYS:30" }`.
   * Only applied in record-scoped mode. The fragment is wrapped in parens
   * before being AND-joined to the scope clause.
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
  /** Per-object error reports — populated when at least one record or
   *  object failed. Empty when the run was fully successful. */
  errors?: ForgeExecutionError[];
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
