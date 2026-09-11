/**
 * Load-phase types: configuration, org-access abstractions,
 * progress events and reports for the FrozenDatasetLoader / PostLoadVerifier.
 *
 * Nothing here is client-specific: protected environments, identity keys,
 * undeletable objects, picklist rules, placeholders and mock detection are
 * ALL configuration injected by the caller (the bridge wires them from
 * settings). Org access goes through narrow interfaces so tests mock them
 * exactly like the forge/sync dep functions.
 */

import type { OperationOutcome } from '../sync/DataSync.js';
import type { SafetyTier } from '../../core/precheck/ProductionGuard.js';
import type { PersonContactLink } from './types.js';

export type { SafetyTier };

/** Minimal target-org field describe consumed by the load phase. */
export interface TargetFieldDescribe {
  name: string;
  type: string;
  /** Non-createable fields (formulas, system fields) are stripped at insert. */
  createable: boolean;
  nillable: boolean;
  /** Required-at-insert detection: createable && !nillable && !defaultedOnCreate. */
  defaultedOnCreate: boolean;
  /** Lookup targets — first entry is the placeholder object. */
  referenceTo?: string[];
  /** Restricted picklist: values outside the active set are rejected at insert. */
  restrictedPicklist?: boolean;
  picklistValues?: Array<{ value: string; active: boolean }>;
}

/** Minimal target-org object describe consumed by the load phase. */
export interface TargetObjectDescribe {
  name: string;
  fields: TargetFieldDescribe[];
}

/**
 * Read access to the target org. Production wiring wraps a jsforce
 * `Connection` (query / describe / `connection.request` for the UI API);
 * tests inject `vi.fn()` mocks like the forge/sync suites do.
 */
export interface TargetOrgAccess {
  /** Run a SOQL query and return its records. */
  query(orgId: string, soql: string): Promise<Array<Record<string, unknown>>>;
  /** Describe a target object. Rejects when the object is absent. */
  describe(orgId: string, objectApiName: string): Promise<TargetObjectDescribe>;
  /**
   * UI API `picklist-values/{recordTypeId}/{field}`: the ONLY source that
   * sees RecordType assignment gaps — a value active globally may not be
   * assigned to the record's RecordType, invisible to describe. Returns
   * the active values for that (RT, field) pair.
   */
  picklistValues(
    orgId: string,
    objectApiName: string,
    recordTypeId: string,
    fieldApiName: string,
  ): Promise<string[]>;
}

/**
 * DML sink for the load phase. `BulkDataWriter` (modules/sync) adapts to
 * this interface — see BulkDmlWriterAdapter. Outcomes are input-aligned.
 */
export interface FrozenDmlWriter {
  insert(
    orgId: string,
    objectApiName: string,
    records: Array<Record<string, unknown>>,
  ): Promise<OperationOutcome[]>;
  update(
    orgId: string,
    objectApiName: string,
    records: Array<Record<string, unknown>>,
  ): Promise<OperationOutcome[]>;
  delete(orgId: string, objectApiName: string, recordIds: string[]): Promise<OperationOutcome[]>;
}

/**
 * Injectable detection of unmocked callouts in the target org.
 * The default implementation is {@link CustomMetadataCalloutMockDetector}
 * (see LoadGuards.ts): a custom metadata record flagging `IsMocked`.
 */
export interface CalloutMockDetector {
  /** True when every callout in the target org is mocked. */
  areCalloutsMocked(orgId: string): Promise<boolean>;
}

/** Declared rule applied when a picklist value is rejected by the target. */
export type PicklistRule = { action: 'clear' } | { action: 'replace'; value: string };

/**
 * Placeholder spec for a required lookup absent from the dataset (a
 * lookup turned required AFTER the source data was created). The loader creates ONE technical record, named and correctly
 * record-typed, and points every record lacking the lookup at it. Records
 * are never silently excluded.
 */
export interface RequiredLookupPlaceholder {
  /** Technical record name — explicit and greppable in the org. */
  name: string;
  /** RecordType DeveloperName of the placeholder record (never a label). */
  recordTypeDeveloperName?: string;
  /** Placeholder object override (defaults to the lookup's first referenceTo). */
  targetObjectApiName?: string;
}

/**
 * Frozen-dataset load configuration. Every list is client configuration,
 * never hard-coded.
 */
export interface FrozenLoadConfig {
  /**
   * Protected environment org IDs — the load refuses them outright (the
   * source is never a target). The manifest source org is refused too.
   */
  protectedOrgIds?: string[];
  /**
   * Identity keys per object for reload-without-refresh reuse:
   * `ObjectApiName → [field, ...]` — ExternalId, Name, or composite pairs.
   * A target record matching every key field is reused, not re-inserted.
   */
  identityKeys?: Record<string, string[]>;
  /**
   * Undeletable objects (e.g. FSL ServiceResource):
   * `ObjectApiName → deactivation field` — residuals are DEACTIVATED
   * instead of deleted.
   */
  undeletableObjects?: Record<string, string>;
  /** Placeholder specs keyed `Object.field` for required lookups missing from the dataset. */
  requiredLookupPlaceholders?: Record<string, RequiredLookupPlaceholder>;
  /** Declared default values keyed `Object.field` for required scalar fields missing from the dataset. */
  requiredFieldDefaults?: Record<string, unknown>;
  /** Picklist rules keyed `Object.field` for values rejected by the target. */
  picklistRules?: Record<string, PicklistRule>;
  /** Fallback picklist rule when no field-specific rule is declared (default: clear). */
  defaultPicklistRule?: PicklistRule;
  /**
   * Substrings marking a native duplicate-rejection error (target
   * anti-duplicate rules). Matching records are SKIPPED AND LISTED
   * (explicit degraded mode), never an opaque error.
   */
  duplicateErrorPatterns?: string[];
  /** Root object of a business folder — required for pilot mode. */
  rootObjectApiName?: string;
}

/** Default duplicate-error markers (Salesforce native duplicate management). */
export const DEFAULT_DUPLICATE_ERROR_PATTERNS: readonly string[] = [
  'DUPLICATE_VALUE',
  'DUPLICATES_DETECTED',
  'duplicate value found',
];

/** Load-phase progress event — the bridge consumes these callbacks. */
export interface FrozenLoadProgressEvent {
  phase:
    | 'guards'
    | 'reload'
    | 'align'
    | 'placeholders'
    | 'insert'
    | 'pass2'
    | 'personcontact'
    | 'persist'
    | 'done'
    | 'verify';
  /** Object concerned, when applicable. */
  objectName?: string;
  status: 'started' | 'done' | 'error';
  /** Progress percentage (0-100) within the load. */
  progress: number;
  /** Human-readable status message. */
  message: string;
}

/** A field removed during schema alignment — always listed, never silent. */
export interface FieldRemoval {
  objectApiName: string;
  field: string;
  reason: 'not-in-target' | 'not-createable';
  /** Number of records that carried the field. */
  affectedRecords: number;
}

/** A picklist value adjusted during schema alignment — always listed. */
export interface PicklistAdjustment {
  objectApiName: string;
  field: string;
  referenceId: string;
  /** The rejected value (dataset side). */
  value: string;
  /** Rule applied, as declared in the configuration. */
  rule: PicklistRule;
  /** 'global': inactive in describe; 'record-type': active globally but not assigned to the RT (UI API). */
  scope: 'global' | 'record-type';
}

/** A required field absent from every record of the dataset. */
export interface MissingRequiredField {
  objectApiName: string;
  field: string;
  isLookup: boolean;
  referenceTo: string[];
}

/** Per-object alignment outcome. */
export interface SchemaAlignObjectResult {
  objectApiName: string;
  alignedRecords: Array<Record<string, unknown>>;
  removals: FieldRemoval[];
  adjustments: PicklistAdjustment[];
  missingRequired: MissingRequiredField[];
  /** Non-fatal UI API read problems (RT-gap check skipped for the field). */
  uiApiWarnings: string[];
}

/** A RecordType reference that could not be resolved in the target org. */
export interface RecordTypeIssue {
  objectApiName: string;
  referenceId: string;
  /** RecordType Name carried by the dataset. */
  recordTypeName: string;
  detail: string;
}

/** Whole-dataset alignment report. */
export interface SchemaAlignmentReport {
  objectResults: SchemaAlignObjectResult[];
  /** Objects absent from the target org — excluded and listed. */
  excludedObjects: Array<{ objectApiName: string; reason: string }>;
  removals: FieldRemoval[];
  adjustments: PicklistAdjustment[];
  /** RecordTypes dropped because they are unresolvable in the target. */
  recordTypeIssues: RecordTypeIssue[];
}

/** A placeholder record created for a required lookup. */
export interface PlaceholderCreation {
  objectApiName: string;
  field: string;
  placeholderObjectApiName: string;
  placeholderName: string;
  placeholderId: string;
  /** Number of records pointed at the placeholder. */
  affectedRecords: number;
}

/** A record skipped by the native anti-duplicate rules of the target. */
export interface SkippedDuplicate {
  objectApiName: string;
  referenceId: string;
  errors: string[];
}

/** A record whose insert/update failed for a non-duplicate reason. */
export interface FailedRecord {
  objectApiName: string;
  referenceId: string;
  errors: string[];
}

/** Per-object load accounting (feeds the counting contract). */
export interface PerObjectLoadResult {
  objectApiName: string;
  /** Records considered for load (dataset files, pilot scope applied). */
  fromFiles: number;
  inserted: number;
  reused: number;
  skippedDuplicates: SkippedDuplicate[];
  failed: FailedRecord[];
}

/** Purge accounting for reload mode (children before parents). */
export interface PurgeReport {
  /** Deleted record count per object. */
  deleted: Record<string, number>;
  /** Deactivated record count per undeletable object. */
  deactivated: Record<string, number>;
  failures: Array<{ objectApiName: string; recordId: string; errors: string[] }>;
}

/** Final load report — every exclusion/adjustment is listed here. */
export interface FrozenLoadReport {
  status: 'completed' | 'completed-with-errors';
  orgId: string;
  mode: { pilot: boolean; reload: boolean };
  startedAt: string;
  durationMs: number;
  alignment: SchemaAlignmentReport;
  placeholders: PlaceholderCreation[];
  /** Declared scalar defaults applied to required fields missing from the dataset. */
  requiredDefaults: Array<{
    objectApiName: string;
    field: string;
    value: unknown;
    affectedRecords: number;
  }>;
  perObject: PerObjectLoadResult[];
  /** Cycle-FK pass 2: resolved vs unresolved targeted updates. `referenceId`
   *  carries the child referenceId, or the real ID when the update failed. */
  pass2: {
    resolved: number;
    unresolved: Array<{
      objectApiName: string;
      referenceId: string;
      field: string;
      detail: string;
    }>;
  };
  /** PersonContact post-load: sidecar links restored as targeted updates. */
  personContact: { restored: number; unresolved: PersonContactLink[] };
  purge: PurgeReport;
  /** Sas path of the persisted referenceId→Id mapping. */
  mappingPath: string;
  /** Sas path of the counting contract consumed by the PostLoadVerifier. */
  contractPath: string;
}
