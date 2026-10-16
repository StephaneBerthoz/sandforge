/**
 * Autopilot types for zero-config sandbox seeding.
 * Covers dependency graph, execution plan, PII detection, and anonymization.
 */

import type {
  ISODateString,
  ApiName,
  ComplianceFrameworkType,
  AnonymizationMethod,
  BaseAnonymizationRule,
} from './common.types.js';

/** Status of an autopilot node during execution */
export type AutopilotNodeStatus =
  | 'pending'
  | 'queued'
  | 'extracting'
  | 'anonymizing'
  | 'loading'
  | 'completed'
  | 'failed'
  | 'skipped';

/** Relationship type between Salesforce objects */
export type RelationshipType = 'lookup' | 'master_detail' | 'hierarchical' | 'polymorphic';

/** A node in the autopilot dependency graph representing a Salesforce object */
export interface AutopilotNode {
  /** Salesforce object API name */
  readonly objectApiName: ApiName;
  /** Number of records to transfer */
  recordCount: number;
  /** Estimated API calls for this object */
  estimatedApiCalls: number;
  /** PII fields detected by AI scan */
  piiFields: PIIFieldDetection[];
  /** Anonymization rules to apply */
  anonymizationRules: AutopilotAnonymizationRule[];
  /** Current execution status */
  status: AutopilotNodeStatus;
  /** Execution progress (0-100) */
  progress: number;
  /** Topological insertion order */
  insertOrder: number;
  /** Depth level in the dependency graph (for layout) */
  level: number;
  /** Number of successfully inserted records */
  successCount: number;
  /** Number of failed records */
  failureCount: number;
  /** Errors encountered during execution */
  errors: string[];
  /** Elapsed time in milliseconds */
  elapsedMs: number;
  /** API calls consumed */
  apiCallsUsed: number;
  /** Records the target already held, linked to instead of written. */
  linkedCount?: number;
  /** Why the target refused records, by status code and fields. */
  refusals?: AutopilotRefusal[];
  /**
   * Records born a draft that were given back their status once their
   * children were in — an order is inserted as a draft and activated after
   * its products.
   */
  statusesApplied?: number;
  /** Why a status could not be given back: those records stay drafts. */
  statusRefusals?: AutopilotRefusal[];
  /**
   * Records read and never sent: the platform writes them itself and refuses
   * one from a copy — a tracked change — or they cannot go in without one it
   * does. Neither written nor failed.
   */
  leftToThePlatform?: number;
}

/**
 * Why the target refused records of one object: one entry per status code and
 * set of fields, with how many records it covers.
 *
 * The code is what a decision reads. The message comes in the running user's
 * language — a French org answers "valeur en double trouvée" where an English
 * one says "duplicate value found" — so it is kept to be shown, never matched.
 */
export interface AutopilotRefusal {
  /** Salesforce's status code, e.g. `REQUIRED_FIELD_MISSING`. */
  readonly statusCode: string;
  /** The fields the refusal named; empty when it named none. */
  readonly fields: string[];
  /** Records refused with this code on these fields. */
  readonly count: number;
  /** The first of their messages, as the target wrote it. */
  readonly message: string;
}

/** An edge in the dependency graph representing a lookup relationship */
export interface AutopilotEdge {
  /** Parent object API name */
  readonly from: ApiName;
  /** Child object API name */
  readonly to: ApiName;
  /** The lookup field API name on the child object */
  readonly fieldApiName: string;
  /** Type of relationship */
  readonly relationshipType: RelationshipType;
  /** Whether the relationship is required (master-detail) */
  readonly required: boolean;
}

/** Strategy to resolve a dependency cycle */
export type CycleResolutionStrategy = 'two_pass' | 'upsert_external_id' | 'nullable_lookup';

/** Resolution plan for a detected dependency cycle */
export interface CycleResolution {
  /** Objects involved in the cycle */
  readonly objects: ApiName[];
  /** Strategy chosen to break the cycle */
  readonly strategy: CycleResolutionStrategy;
  /** Human-readable description of the resolution */
  readonly description: string;
}

/** Statistics about the dependency graph */
export interface GraphStats {
  /** Total number of objects */
  readonly totalObjects: number;
  /** Total number of relationships */
  readonly totalRelationships: number;
  /** Number of dependency cycles detected */
  readonly cycleCount: number;
  /** Maximum depth of the graph */
  readonly maxDepth: number;
  /** Total records across all objects */
  readonly totalRecords: number;
  /** Total estimated API calls */
  readonly totalEstimatedApiCalls: number;
}

/** The complete autopilot dependency graph */
export interface AutopilotGraph {
  /** Object nodes */
  readonly nodes: AutopilotNode[];
  /** Relationship edges */
  readonly edges: AutopilotEdge[];
  /** Detected and resolved cycles */
  readonly cycles: CycleResolution[];
  /** Graph statistics */
  readonly stats: GraphStats;
}

/** A wave of objects that can be processed in parallel */
export interface ExecutionWave {
  /** Wave order (0-based) */
  readonly order: number;
  /** Objects that can be processed in parallel in this wave */
  readonly objects: ApiName[];
  /** Wave indices this wave depends on */
  readonly dependsOn: number[];
}

/** Complete execution plan generated by the autopilot */
export interface ExecutionPlan {
  /** Ordered waves of parallel-executable objects */
  readonly waves: ExecutionWave[];
  /** Total records to transfer */
  readonly totalRecords: number;
  /** Estimated duration in seconds */
  readonly estimatedDurationSec: number;
  /** Estimated total API calls */
  readonly estimatedApiCalls: number;
  /** Compliance profile applied */
  readonly complianceFramework: ComplianceFrameworkType;
  /** Summary of anonymization actions */
  readonly anonymizationSummary: AnonymizationSummary;
  /** Cycle resolutions */
  readonly cycleResolutions: CycleResolution[];
  /**
   * What the plan copies of the objects it reached and what it leaves out:
   * see {@link AutopilotPlanScope}. Absent from a plan built without a scan
   * that says.
   */
  readonly scope?: AutopilotPlanScope;
}

/**
 * Why a lookup the plan reached is left empty: the object it points at is
 * further than the walk goes (`depth`), past the most objects a plan holds
 * (`objects`), or a standard object the run was not asked to take
 * (`standard`).
 */
export type AutopilotLeftOutReason = 'depth' | 'objects' | 'standard';

/** A lookup of a planned object whose parents the plan does not copy. */
export interface AutopilotLookupLeftEmpty {
  /** The object holding the lookup. */
  readonly objectApiName: ApiName;
  /** The lookup. */
  readonly fieldApiName: string;
  /** The object it points at, which the plan leaves out. */
  readonly target: ApiName;
  readonly reason: AutopilotLeftOutReason;
  /**
   * Set when a record cannot be written without it: the platform refuses
   * those records, where an optional lookup is only left empty.
   */
  readonly required?: true;
}

/**
 * What a selection means: the selected objects' records, and of every other
 * object only the records they reference, read by id, as far as the bounds
 * go.
 *
 * Run for real, a plan for two objects walked every lookup of every object it
 * reached and counted their whole tables: six hundred objects, 2.6 million
 * records, a postcode table of sixty thousand rows among them — through a
 * lead's converted account, into the whole org.
 */
export interface AutopilotPlanScope {
  /** Lookups followed from a selected object, at most. */
  readonly maxDepth: number;
  /** Objects a plan holds, the selected ones included; a required parent raises it, to twice. */
  readonly maxObjects: number;
  /** The objects asked for: their records are copied whole. */
  readonly selected: ApiName[];
  /** The other objects: only the records the selection references, read by id. */
  readonly parents: Array<{ readonly objectApiName: ApiName; readonly records: number }>;
  /** Lookups left empty, and why. */
  readonly leftEmpty: AutopilotLookupLeftEmpty[];
  /**
   * Standard objects taken although standard objects were not asked for: a
   * record cannot be written without them. Each with the lookup that needs it.
   */
  readonly standardNeeded: Array<{ readonly objectApiName: ApiName; readonly neededBy: string }>;
}

/** What a compliance framework expects anonymized on a person's record. */
export type ExpectedPersonalData = 'name' | 'email' | 'phone';

/** Summary of anonymization to be performed */
export interface AnonymizationSummary {
  /** Total PII fields detected */
  readonly totalPiiFields: number;
  /** Total fields to anonymize */
  readonly totalFieldsToAnonymize: number;
  /** Breakdown by anonymization method */
  readonly methodBreakdown: Record<AnonymizationMethod, number>;
  /** Objects with PII */
  readonly objectsWithPii: ApiName[];
  /**
   * The person objects of the plan — contacts, leads — on which a framework
   * that anonymizes found no rule for what it expects there: their names,
   * emails or phones would be copied as they are. Absent when none is.
   */
  readonly notCovered?: Array<{
    readonly objectApiName: ApiName;
    readonly missing: ExpectedPersonalData[];
  }>;
}

/** Autopilot configuration provided by the user */
export interface AutopilotConfig {
  /** Source org ID */
  readonly sourceOrgId: string;
  /** Target org ID */
  readonly targetOrgId: string;
  /** Root objects selected (empty = auto-detect all) */
  readonly selectedObjects: ApiName[];
  /** Compliance framework */
  readonly complianceFramework: ComplianceFrameworkType;
  /** Maximum records per object (0 = unlimited) */
  readonly maxRecordsPerObject: number;
  /** WHERE clause filters per object */
  readonly objectFilters: Record<ApiName, string>;
  /** Whether to include standard objects */
  readonly includeStandardObjects: boolean;
  /** Grappe parallel threshold */
  readonly grappeThreshold: number;
  /** Lookups followed from a selected object, at most: see {@link AutopilotPlanScope}. */
  readonly maxDepth?: number;
  /** Objects a plan holds, at most: see {@link AutopilotPlanScope}. */
  readonly maxObjects?: number;
}

/** Events emitted during autopilot execution */
export type AutopilotEventType =
  | 'scan-started'
  | 'scan-completed'
  | 'plan-generated'
  | 'execution-started'
  | 'node-progress'
  | 'node-completed'
  | 'node-failed'
  | 'node-skipped'
  | 'wave-completed'
  | 'execution-completed'
  | 'execution-failed'
  | 'paused'
  | 'resumed';

/** Base event for autopilot */
export interface AutopilotEvent {
  /** Event type */
  readonly type: AutopilotEventType;
  /** ISO timestamp of the event */
  readonly timestamp: ISODateString;
}

/** Progress event for a specific node */
export interface AutopilotNodeProgressEvent extends AutopilotEvent {
  /** Event type discriminator */
  readonly type: 'node-progress';
  /** Object API name being processed */
  readonly objectApiName: ApiName;
  /** Completion percentage (0-100) */
  readonly progress: number;
  /** Records processed so far */
  readonly recordsProcessed: number;
  /** Total records to process */
  readonly recordsTotal: number;
  /** API calls consumed */
  readonly apiCallsUsed: number;
}

/** Completion event for a specific node */
export interface AutopilotNodeCompletedEvent extends AutopilotEvent {
  /** Event type discriminator */
  readonly type: 'node-completed';
  /** Object API name completed */
  readonly objectApiName: ApiName;
  /** Number of successfully inserted records */
  readonly successCount: number;
  /** Number of failed records */
  readonly failureCount: number;
  /** Records the target already held and named: linked to, never written */
  readonly linkedCount: number;
  /** Why the failed records were refused */
  readonly refusals: AutopilotRefusal[];
  /** Elapsed time in milliseconds */
  readonly elapsedMs: number;
  /** API calls consumed */
  readonly apiCallsUsed: number;
}

/** Failure event for a specific node */
export interface AutopilotNodeFailedEvent extends AutopilotEvent {
  /** Event type discriminator */
  readonly type: 'node-failed';
  /** Object API name that failed */
  readonly objectApiName: ApiName;
  /** One line per refusal, `STATUS_CODE: message` whenever the target gave a code */
  readonly errors: string[];
  /** Records inserted before failure */
  readonly partialSuccessCount: number;
  /** Records refused */
  readonly failureCount: number;
  /** Records the target already held and named: linked to, never written */
  readonly linkedCount: number;
  /** Why the records were refused */
  readonly refusals: AutopilotRefusal[];
}

// ─── Compliance & Anonymization Types ────────────────────────────────────────

/** A rule for anonymizing a specific field during autopilot execution */
export interface AutopilotAnonymizationRule extends BaseAnonymizationRule {
  /** PII category of the field */
  readonly piiCategory: PIICategory;
  /** AI confidence score (0-1) */
  readonly aiConfidence: number;
  /** Whether the user manually overrode the AI suggestion */
  readonly userOverridden: boolean;
  /**
   * The field's Salesforce type, as the scan described it: what a value
   * invented for it has to be — an address for an email field, a number for a
   * phone. Absent, the value is a token.
   */
  readonly fieldType?: string;
}

/** User override for an anonymization rule */
export interface AnonymizationOverride {
  /** Object containing the field */
  readonly objectApiName: ApiName;
  /** Field to override */
  readonly fieldApiName: string;
  /** New method or skip */
  readonly method: AnonymizationMethod | 'skip';
}

/** PII category classification */
export type PIICategory = 'PII' | 'PHI' | 'PCI' | 'SENSITIVE' | 'NONE';

/** Detection result for a single field */
export interface PIIFieldDetection {
  /** Object containing the field */
  readonly objectApiName: ApiName;
  /** Field API name */
  readonly fieldApiName: string;
  /** Field label in the UI */
  readonly fieldLabel: string;
  /** Salesforce field type */
  readonly fieldType: string;
  /** PII category detected */
  readonly piiCategory: PIICategory;
  /** How the PII was detected */
  readonly detectionMethod: 'field_name' | 'regex' | 'content_sampling' | 'ai';
  /** Confidence score (0-1) */
  readonly confidence: number;
  /** Suggested anonymization method */
  readonly suggestedMethod: AnonymizationMethod;
}

/** Coherent fictional persona for cross-object anonymization */
export interface AnonymizedPersona {
  /** Original Salesforce record ID */
  readonly sourceRecordId: string;
  /** Fake first name */
  readonly firstName: string;
  /** Fake last name */
  readonly lastName: string;
  /** Fake email */
  readonly email: string;
  /** Fake phone */
  readonly phone: string;
  /** Fake address */
  readonly address: string;
  /** Fake city */
  readonly city: string;
  /** Fake postal code */
  readonly postalCode: string;
  /** Fake company name */
  readonly company: string;
}
