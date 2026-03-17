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
export type ForgeAnonymizationCategory = 'email' | 'phone' | 'name' | 'address' | 'ssn_id' | 'financial' | 'other';

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
