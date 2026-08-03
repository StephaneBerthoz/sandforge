/**
 * Frozen Reference Dataset — shared DTOs for the `frozen:*` bridge contract.
 *
 * These types mirror the extension-side engine types
 * (`packages/extension/src/modules/frozendataset`) as plain JSON shapes so the
 * webview never imports extension code. Two deliberate divergences from the
 * engine shapes:
 *
 *  - The selection summary is REDACTED: source-org record IDs stay in the sas
 *    and never cross the bridge (a real↔anonymized correspondence table must
 *    not leak into the UI layer either).
 *  - Control violation details may be truncated/redacted by the handler
 *    (a `clear-empty` residual can embed the offending value).
 *
 * Nothing here is client-specific: coverage axes, budgets, protected
 * environments, identity keys, undeletable objects and picklist rules are all
 * per-project configuration.
 */

/** One configurable coverage axis (aggregate SOQL enumerating observed values). */
export interface FrozenCoverageAxisConfig {
  /** Stable axis name (used in combination keys). */
  name: string;
  /** Human label (UI/reporting). */
  label: string;
  /** Field on the root object filtered by this axis' values when probing combinations. */
  filterField: string;
  /** Aggregate SOQL; rows must expose the value under the `axisValue` alias. `{{TOKEN}}` allowed. */
  valuesSoql: string;
}

/** A declared edge case: one extra root retained per data marker. */
export interface FrozenEdgeCaseConfig {
  /** Stable edge-case name. */
  name: string;
  /** Human label. */
  label: string;
  /** WHERE fragment selecting the marker in data (e.g. `Flag_Litige__c = true`). */
  whereFragment: string;
}

/** Declared rule applied when a picklist value is rejected by the target. */
export type FrozenPicklistRule = { action: 'clear' } | { action: 'replace'; value: string };

/** Placeholder spec for a required lookup absent from the dataset. */
export interface FrozenPlaceholderConfig {
  /** Technical record name — explicit and greppable in the org. */
  name: string;
  /** RecordType DeveloperName of the placeholder record (never a label). */
  recordTypeDeveloperName?: string;
  /** Placeholder object override (defaults to the lookup's first referenceTo). */
  targetObjectApiName?: string;
}

/** Injectable unmocked-callout detection via a custom metadata flag. */
export interface FrozenMockDetectionConfig {
  /** Custom metadata type API name carrying the mock flag (e.g. `Callout_Mock__mdt`). */
  metadataTypeApiName: string;
  /** Boolean field: true means callouts are mocked (e.g. `IsMocked__c`). */
  isMockedFieldApiName: string;
}

/**
 * Per-project frozen-dataset configuration, persisted by the extension
 * (ConfigStore, category `frozen`). Every list is client configuration —
 * nothing is hard-coded in the engine.
 */
export interface FrozenProjectConfig {
  /** API name of the root ("dossier") object. */
  rootObject: string;
  /** Coverage axes of the selection matrix. */
  axes: FrozenCoverageAxisConfig[];
  /** Declared edge cases (one extra root per marker). */
  edgeCases: FrozenEdgeCaseConfig[];
  /** Volumetry ceiling, records (default 2 500 — verified mechanically). */
  budgetMaxRecords?: number;
  /** Candidates probed per combination before declaring it uncovered. */
  candidatesPerCombination?: number;
  /** Objects that MUST appear in a dossier graph for it to be healthy. */
  expectedObjects?: string[];
  /** Per-object fields excluded from the extraction SELECT clause. */
  excludedFields?: Record<string, string[]>;
  /** Sas directory override (default: `~/.sandforge-sas/<workspace>`). Must be outside the repo. */
  sasDir?: string;
  /** Frozen dataset output directory (default: `<sasDir>/dataset`). */
  datasetDir?: string;
  /** Path of the pseudonymization rules file (source of truth). */
  rulesFilePath?: string;
  /** Semver stamped on the next frozen dataset version. */
  datasetVersion?: string;
  /** Protected environment org IDs — the load refuses them outright. */
  protectedOrgIds?: string[];
  /** Identity keys per object for reload-without-refresh reuse. */
  identityKeys?: Record<string, string[]>;
  /** Undeletable objects: `ObjectApiName → deactivation field`. */
  undeletableObjects?: Record<string, string>;
  /** Placeholder specs keyed `Object.field` for required lookups missing from the dataset. */
  requiredLookupPlaceholders?: Record<string, FrozenPlaceholderConfig>;
  /** Declared default values keyed `Object.field` for required scalar fields. */
  requiredFieldDefaults?: Record<string, unknown>;
  /** Picklist rules keyed `Object.field` for values rejected by the target. */
  picklistRules?: Record<string, FrozenPicklistRule>;
  /** Fallback picklist rule when no field-specific rule is declared (default: clear). */
  defaultPicklistRule?: FrozenPicklistRule;
  /** Substrings marking a native duplicate-rejection error of the target. */
  duplicateErrorPatterns?: string[];
  /** Unmocked-callout detection (custom metadata flag). */
  mockDetection?: FrozenMockDetectionConfig;
  /** Mandatory lookups of the graph for the post-load orphan check. */
  mandatoryLookups?: Record<string, string[]>;
  /** Presence-by-key check: `ObjectApiName → key field` (e.g. ExternalId). */
  presenceKeys?: Record<string, string>;
}

/** One retained combination — REDACTED (no source record ID crosses the bridge). */
export interface FrozenSelectedCombination {
  /** Combination key, e.g. `prestation=RC|logiciel=Kairos`, or edge-case name. */
  combinationKey: string;
  /** Axis values of the combination (empty for edge cases). */
  axisValues: Record<string, string | null>;
  /** Set when this root was retained for an edge case. */
  edgeCase?: string;
}

/** A combination observed but without any healthy candidate. */
export interface FrozenUncoveredCombination {
  combinationKey: string;
  reason: string;
}

/** Selection summary returned to the webview (sas IDs redacted). */
export interface FrozenSelectionSummary {
  /** Retained combinations — exactly one root per combination / edge case. */
  combinations: FrozenSelectedCombination[];
  /** Combinations observed but without any healthy candidate. */
  uncovered: FrozenUncoveredCombination[];
  volumetry: {
    measured: Record<string, number>;
    total: number;
    budgetMax: number;
  };
  /** ISO timestamp of the selection (decision date for the manifest). */
  selectedAt: string;
  /** Sas path of the persisted selection.json. */
  selectionPath: string;
}

/** The four non-reidentification check names. */
export type FrozenControlCheckName = 'substitution' | 'clear-empty' | 'formats' | 'no-residual-id';

/** One concrete violation found by a check (detail may be redacted by the handler). */
export interface FrozenControlViolation {
  check: FrozenControlCheckName;
  objectApiName: string;
  referenceId: string;
  field?: string;
  detail: string;
}

/** Outcome of one of the four checks. */
export interface FrozenControlCheck {
  name: FrozenControlCheckName;
  passed: boolean;
  violations: FrozenControlViolation[];
}

/** Full four-point gate report, consigned in the manifest. */
export interface FrozenControlReport {
  passed: boolean;
  checks: FrozenControlCheck[];
  author: string;
  checkedAt: string;
}

/** Source-org identity recorded in the manifest. */
export interface FrozenManifestSource {
  orgId: string;
  orgAlias?: string;
  decisionDate: string;
}

/** Volumetry section: the ceiling plus what was actually measured. */
export interface FrozenManifestVolumetry {
  budgetMax: number;
  measured: Record<string, number>;
  measuredAt: string;
}

/** Dry-run load outcome consigned by the post-load verification. */
export interface FrozenDryRunLoadControl {
  status: 'pending' | 'passed' | 'failed';
  at?: string;
  detail?: string;
}

/** The frozen dataset manifest (identity card — no source data). */
export interface FrozenManifestInfo {
  version: string;
  status: 'frozen';
  frozenAt: string;
  source: FrozenManifestSource;
  /** SHA-256 fingerprint (12 hex) of the salt — never the salt itself. */
  saltFingerprint: string;
  rulesVersion: string;
  volumetry: FrozenManifestVolumetry;
  controls: {
    nonReidentification: FrozenControlReport;
    dryRunLoad: FrozenDryRunLoadControl | null;
    author: string;
    date: string;
  };
}

/** A field removed during schema alignment — always listed, never silent. */
export interface FrozenFieldRemoval {
  objectApiName: string;
  field: string;
  reason: 'not-in-target' | 'not-createable';
  affectedRecords: number;
}

/** A picklist value adjusted during schema alignment — always listed. */
export interface FrozenPicklistAdjustment {
  objectApiName: string;
  field: string;
  referenceId: string;
  value: string;
  rule: FrozenPicklistRule;
  scope: 'global' | 'record-type';
}

/** A RecordType reference that could not be resolved in the target org. */
export interface FrozenRecordTypeIssue {
  objectApiName: string;
  referenceId: string;
  recordTypeName: string;
  detail: string;
}

/** A placeholder record created for a required lookup. */
export interface FrozenPlaceholderCreation {
  objectApiName: string;
  field: string;
  placeholderObjectApiName: string;
  placeholderName: string;
  placeholderId: string;
  affectedRecords: number;
}

/** A record skipped by the native anti-duplicate rules of the target. */
export interface FrozenSkippedRecord {
  objectApiName: string;
  referenceId: string;
  errors: string[];
}

/** Per-object load accounting. */
export interface FrozenPerObjectLoadResult {
  objectApiName: string;
  fromFiles: number;
  inserted: number;
  reused: number;
  skippedDuplicates: FrozenSkippedRecord[];
  failed: FrozenSkippedRecord[];
}

/** Final load report — every exclusion/adjustment is listed. */
export interface FrozenLoadReportInfo {
  status: 'completed' | 'completed-with-errors';
  orgId: string;
  mode: { pilot: boolean; reload: boolean };
  startedAt: string;
  durationMs: number;
  alignment: {
    excludedObjects: Array<{ objectApiName: string; reason: string }>;
    removals: FrozenFieldRemoval[];
    adjustments: FrozenPicklistAdjustment[];
    recordTypeIssues: FrozenRecordTypeIssue[];
  };
  placeholders: FrozenPlaceholderCreation[];
  requiredDefaults: Array<{
    objectApiName: string;
    field: string;
    value: unknown;
    affectedRecords: number;
  }>;
  perObject: FrozenPerObjectLoadResult[];
  pass2: {
    resolved: number;
    unresolved: Array<{
      objectApiName: string;
      referenceId: string;
      field: string;
      detail: string;
    }>;
  };
  personContact: {
    restored: number;
    unresolved: Array<{ accountReferenceId: string; contactReferenceId: string }>;
  };
  purge: {
    deleted: Record<string, number>;
    deactivated: Record<string, number>;
    failures: Array<{ objectApiName: string; recordId: string; errors: string[] }>;
  };
  mappingPath: string;
  contractPath: string;
}

/** Load/verify phases surfaced in progress events. */
export type FrozenLoadPhase =
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

/** Progress event pushed during load and verification. */
export interface FrozenLoadProgress {
  phase: FrozenLoadPhase;
  objectName?: string;
  status: 'started' | 'done' | 'error';
  /** Progress percentage (0-100). */
  progress: number;
  message: string;
}

/** One post-load verification check outcome. */
export interface FrozenPostLoadCheck {
  name: 'stability' | 'counts' | 'orphans' | 'personcontact' | 'presence';
  passed: boolean;
  detail: string;
}

/** Final post-load verdict. */
export interface FrozenVerifyVerdict {
  status: 'passed' | 'failed' | 'unstable';
  checks: FrozenPostLoadCheck[];
  /** Measurements taken (2 identical snapshots stop the loop early). */
  attempts: number;
  measuredAt: string;
  manifestPath?: string;
}

/** Module status snapshot returned by `frozen:status`. */
export interface FrozenStatusInfo {
  /** True when a project config is persisted. */
  configured: boolean;
  /** Resolved sas directory (outside the repo). */
  sasDir: string;
  /** Resolved dataset directory. */
  datasetDir: string;
  /** Salt presence + fingerprint (never the salt itself). */
  salt: { present: boolean; fingerprint?: string };
  /** True when unmocked-callout detection is configured. */
  mockDetectionConfigured: boolean;
  /** Selection snapshot, when a selection.json exists in the sas. */
  selection: {
    selectedAt: string;
    rootCount: number;
    total: number;
    budgetMax: number;
  } | null;
  /** Frozen manifest, when a dataset has been written. */
  manifest: FrozenManifestInfo | null;
  /** Last load outcome, when a load ran in this workspace. */
  lastLoad: { status: string; orgId: string; at: string } | null;
  /** Last verification verdict, when one ran. */
  lastVerify: { status: string; measuredAt: string } | null;
}
