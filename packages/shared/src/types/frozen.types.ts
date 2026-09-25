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

import type { ForgeUndoMark, ForgeUndoObjectResult, ForgeUndoStatus } from './forge.types.js';

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
  /** Objects every retained dossier must hold at least one record of. */
  expectedObjects?: string[];
  /**
   * How many objects discovery may reach from the root (10–500, default 50).
   * Past it, objects further out are not read — the selection and the
   * manifest say so when it happens.
   */
  maxNodes?: number;
  /**
   * Objects the dataset leaves out even when the graph reaches them — one
   * whose required content the rules clear, say, and which the target then
   * refuses.
   */
  excludedObjects?: string[];
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

/** How far discovery reached — so a dataset cut short says so. */
export interface FrozenGraphCoverage {
  /** Objects discovery reached. */
  objects: number;
  /** Discovery stopped at its object cap: objects further out were never read. */
  truncated: boolean;
  /** The object cap discovery ran with. */
  maxNodes: number;
}

/**
 * Records of one object a frozen dataset leaves out because the platform
 * writes them itself and refuses one from a copy — a tracked change — or they
 * cannot go in without one it does.
 */
export interface FrozenLeftToThePlatform {
  /** The object of the records. */
  objectApiName: string;
  /** How many were left out. */
  count: number;
  /** Why, in words: `1 tracked change left out: the platform writes them itself`. */
  note: string;
}

/**
 * Records of one object a frozen dataset holds that cannot be loaded as they
 * are, for an object `excludedObjects` leaves out: the record a lookup they
 * may not leave empty names, or — for an order past Draft — the items it is
 * activated with.
 */
export interface FrozenExclusionCost {
  /** The object of the records. */
  objectApiName: string;
  /** The object left out that they need. */
  excludedObject: string;
  /** How many. */
  count: number;
  /** What leaving it out costs them, in words. */
  note: string;
}

/** Manifest coverage: the graph, plus what was read without the time bound. */
export interface FrozenManifestCoverage extends FrozenGraphCoverage {
  /** Objects read without `CreatedDate <= asOf`, having no such field. */
  unboundedObjects: string[];
  /** Objects left out because they carry files the rules do not keep. */
  filesLeftOut: string[];
  /**
   * Records left out because the platform writes them, or what they depend
   * on, itself. Absent when none was, and from manifests written before it
   * was recorded.
   */
  leftToThePlatform?: FrozenLeftToThePlatform[];
  /**
   * Records held that cannot be loaded as they are, for an object
   * `excludedObjects` leaves out. Absent when none is, and from manifests
   * written before it was recorded.
   */
  exclusionCosts?: FrozenExclusionCost[];
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
  /** How far discovery reached while the dossiers were measured. */
  graph?: FrozenGraphCoverage;
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
  /** What the extraction reached; absent from manifests written before 1.32.0. */
  coverage?: FrozenManifestCoverage;
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

/**
 * Why a link a load owed after its inserts was not made: the record holding
 * the lookup was not loaded, the record it points at was not, or the target
 * refused the update that set it. Only the first leaves no lookup empty on a
 * record the load wrote: the record went, and the link with it.
 */
export type FrozenUnresolvedLinkCause =
  'record-not-loaded' | 'target-not-loaded' | 'update-refused';

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
      /** The lookup; the lookups, comma-separated, of a refused update of several. */
      field: string;
      cause: FrozenUnresolvedLinkCause;
      detail: string;
    }>;
  };
  personContact: {
    restored: number;
    /** A person account's link to its contact: `Account.PersonContactId`. */
    unresolved: Array<{
      accountReferenceId: string;
      contactReferenceId: string;
      cause: FrozenUnresolvedLinkCause;
      detail: string;
    }>;
  };
  /** Statuses applied after insert: an activated order is created as a draft. */
  statuses?: {
    restored: number;
    refused: Array<{ objectApiName: string; referenceId: string; status: string; detail: string }>;
  };
  purge: {
    deleted: Record<string, number>;
    deactivated: Record<string, number>;
    failures: Array<{ objectApiName: string; recordId: string; errors: string[] }>;
    /**
     * Per object, records of a load whose mapping does not say what it
     * created, which the reload left in place: that load may have linked
     * them. Absent when none was left.
     */
    leftUnrecorded?: Record<string, number>;
  };
  /**
   * Records the dataset carries and the load left out, by object: the
   * platform writes them, or what they depend on, itself. Absent when none was.
   */
  leftToThePlatform?: FrozenLeftToThePlatform[];
  /**
   * Records the dataset carries and the load left out, by object, because the
   * dataset does not carry a feed item's type, or they depend on such a feed
   * item: a tracked change cannot be told from a post. Extracted again, the
   * dataset loads them. Absent when none was.
   */
  untypedFeedItems?: FrozenLeftToThePlatform[];
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
  /**
   * `stopped` ends an object a cancel stopped while it was written: some of
   * its rows may be in the target, the others were never sent, and its line
   * says how many. It ended `done` before, and read as written whole beside
   * the objects that were. One the target refused a row of ends `error`. It
   * ends a reload's purge, the placeholders, or a pass after the inserts,
   * that the cancel cut short too, their line saying what the cancel kept
   * back of them. `error` ends a purge the target refused records of, and an
   * object, a purge, the placeholders or a pass a write of its own threw at,
   * its line saying what the failure kept back of it, and why; and a check
   * before the first write — the entry guards, the alignment, the required
   * fields — that refused the load or threw, saying why.
   */
  status: 'started' | 'done' | 'error' | 'stopped';
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

/**
 * What the sas mapping says of the records of the load that wrote it, for
 * their removal: counts only — the ids stay in the sas.
 */
export interface FrozenLoadRecordsInfo {
  /** The registered org the load wrote to. */
  orgId: string;
  /** When the load wrote its last record, ISO 8601: which load this is. */
  loadedAt: string;
  /**
   * Per object, the records the load created — inserted, or a technical
   * placeholder — the object it wrote last first. Empty when it created none,
   * or when the mapping does not say.
   */
  created: Array<{ objectApiName: string; count: number }>;
  /**
   * Records the load linked to or reused — the standard price book, a selling
   * model the target held, a record a reload found by its identity keys —
   * which a removal leaves where they are.
   */
  linked: number;
  /**
   * Whether the mapping says which records the load created. One written
   * before loads kept it cannot tell them from the records the load linked,
   * and its records cannot be removed from here.
   */
  recorded: boolean;
  /** Set once the records the load created were removed. */
  removed?: ForgeUndoMark;
  /**
   * Set when this is a load before the last one, whose records the loads
   * after it left in the org — a load without Reload purges nothing, and the
   * target can refuse part of a purge — once the last load's records went,
   * or when it created none: its removal comes next.
   */
  earlier?: true;
}

/**
 * What removing the records a load created did, object by object — Forge's
 * removal, run on the records the load's mapping names.
 */
export interface FrozenRemovalResult {
  /** How the removal ended. */
  status: ForgeUndoStatus;
  /** Whether records modified since the load, and what was added to them since, went too. */
  includeChanged: boolean;
  /** Per object, in the order they were removed: children before their parents. */
  objects: ForgeUndoObjectResult[];
  /** ISO 8601 timestamp of when the removal ended. */
  finishedAt: string;
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
  /**
   * The records of the load whose mapping the sas holds — from this window or
   * from the command line — for their removal: the last load, or, once its
   * records went, the newest load before it whose records are still there.
   * Absent when no load wrote one.
   */
  lastLoadRecords?: FrozenLoadRecordsInfo;
}
