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

import type { MutedAutomation } from '../utils/automation-mute.js';
import type {
  ForgeFieldRefusal,
  ForgeRefusedField,
  ForgeSweepResult,
  ForgeUndoMark,
  ForgeUndoObjectResult,
  ForgeUndoStatus,
} from './forge.types.js';
import type { SyncValidationRule } from './sync.types.js';

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
  /**
   * Identity keys per object for reload-without-refresh reuse. An object the
   * platform never deletes has one by default, matched on every load: business
   * hours by `Name`; keys given here replace it.
   */
  identityKeys?: Record<string, string[]>;
  /** Undeletable objects: `ObjectApiName → deactivation field`. */
  undeletableObjects?: Record<string, string>;
  /** Placeholder specs keyed `Object.field` for required lookups missing from the dataset. */
  requiredLookupPlaceholders?: Record<string, FrozenPlaceholderConfig>;
  /**
   * Declared default values keyed `Object.field` for required scalar fields.
   * A text value may carry `{n}` — the record's rank among its object's
   * records in the dataset — or `{referenceId}`; one without either, given for
   * a field the target keeps unique or for the object's name, gets the rank
   * appended, so that each record has a value of its own.
   */
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
 * Where the graph of a selection or an extraction came from: the one an
 * earlier step discovered, kept in the sas and reused — its source's schema
 * unchanged since — or a discovery of its own, and why the kept one would not
 * do.
 */
export type FrozenDiscoveryOrigin =
  | {
      /** The step that discovered the graph reused. */
      reusedFrom: 'select' | 'extract';
      /** When that step discovered it, ISO 8601. */
      discoveredAt: string;
    }
  | {
      /** Why the graph was discovered again: no graph kept, another org, the schema changed… */
      rediscovered: string;
    };

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
  /**
   * The fields, as `Object.Field`, the source requires and the rules leave
   * empty: each a value a load of the dataset will ask for. Absent when none is.
   */
  requiredLeftEmpty?: string[];
  /**
   * The fields, as `Object.Field`, kept in clear text though the rules declare
   * no generator for them: the platform's own words. Absent when none is.
   */
  keptWithoutARule?: string[];
  /**
   * The fields, as `Object.Field`, not kept: classic encrypted fields the user
   * the source was read as reads masked, lacking View Encrypted Data, which
   * the dataset would have held as their masks. Empty when none is. Absent
   * from manifests written before it was recorded, and from those of 1.66.0
   * that named none: a load of such a dataset leaves out the fields the
   * target encrypts unless told to write them.
   */
  encryptedNotKept?: string[];
}

/**
 * Where a selection was when it stopped short of its end — its time ran out,
 * or it was cancelled — and what it had not reached. What it had decided is
 * kept.
 */
export interface FrozenSelectionStop {
  reason: 'timeout' | 'cancelled';
  /** What it was doing: listing the axis values, probing a combination, or measuring what it kept. */
  during: 'axes' | 'combination' | 'measure';
  /** The combination, or `edge:<name>`, it was probing, when it was. */
  combinationKey?: string;
  /** The candidate of that combination it was judging, from 1. */
  candidate?: number;
  /** The candidates it would have probed for it at most. */
  candidates?: number;
  /** The combinations and edge cases it never reached. */
  notProbed: string[];
}

/** One step of a selection, said to the panel and printed by the command line. */
export interface FrozenSelectProgress {
  /**
   * `discovery`: the root object's graph, `objects` reached so far;
   * `axis`: an axis's observed values listed; `combination`: a combination,
   * `index` of `of`, being probed; `candidate`: one of its candidates judged
   * on its own records; `measure`: the kept roots measured together.
   */
  phase: 'discovery' | 'axis' | 'combination' | 'candidate' | 'measure';
  objects?: number;
  axis?: string;
  combinationKey?: string;
  index?: number;
  of?: number;
  candidate?: number;
  candidates?: number;
  roots?: number;
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
    /**
     * Set when the kept roots were not measured together — the selection
     * stopped first — and the figures are each root's own measure added up:
     * a record two roots share is counted twice.
     */
    summed?: true;
  };
  /** Set when the selection stopped short: where, and what it had not reached. */
  stopped?: FrozenSelectionStop;
  /** ISO timestamp of the selection (decision date for the manifest). */
  selectedAt: string;
  /** Sas path of the persisted selection.json. */
  selectionPath: string;
  /** How far discovery reached while the dossiers were measured. */
  graph?: FrozenGraphCoverage;
  /** Where that graph came from: kept in the sas by an earlier step, or discovered again. */
  discovery?: FrozenDiscoveryOrigin;
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

/**
 * A field removed during schema alignment — always listed, never silent.
 * `may-hold-masks`: a field the target encrypts, of a dataset whose manifest
 * does not say its extraction left out the encrypted fields it read masked
 * (`FrozenManifestCoverage.encryptedNotKept`) — its values may be masks, such
 * as `****1234`; left out unless the load is told to write them.
 */
export interface FrozenFieldRemoval {
  objectApiName: string;
  field: string;
  reason: 'not-in-target' | 'not-createable' | 'may-hold-masks';
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

/**
 * A field the target refused records of one object on at their insert — a
 * validation rule, or a restricted picklist refusing their value — and that
 * they went in without once written again: left out, or, for a picklist whose
 * declared rule replaces a rejected value, with that value instead.
 */
export interface FrozenRefusedField extends ForgeRefusedField {
  refusedBy: ForgeFieldRefusal;
  /**
   * The value the declared picklist rule gave the field in place of the one
   * the target refused. Absent when the records went without the field.
   */
  replacedWith?: string;
}

/**
 * The records of one object the target refused on fields it named, that went
 * in once written again without their values: counted among the inserted. A
 * record refused without a field named, or refused again, is a failure
 * instead.
 */
export interface FrozenWrittenWithoutFields {
  /** Records written so. */
  rows: number;
  /** Each field they went without, with the refusal that named it. */
  fields: FrozenRefusedField[];
}

/** Per-object load accounting. */
export interface FrozenPerObjectLoadResult {
  objectApiName: string;
  fromFiles: number;
  inserted: number;
  reused: number;
  skippedDuplicates: FrozenSkippedRecord[];
  failed: FrozenSkippedRecord[];
  /**
   * Of the records inserted, those the target refused on fields it named and
   * took once written again without their values. Absent when there were
   * none, and from reports written before a refused record was written again.
   */
  writtenWithoutFields?: FrozenWrittenWithoutFields;
}

/** Final load report — every exclusion/adjustment is listed. */
export interface FrozenLoadReportInfo {
  status: 'completed' | 'completed-with-errors';
  /**
   * What the run muted of the target's automation, when it was asked to
   * (`muteAutomation`): the permission sets assigned to the user it wrote as
   * for its duration, what they silenced, what still ran, and whether they
   * were taken back. Absent when it was not asked.
   */
  mutedAutomation?: MutedAutomation;
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
    /** The value declared: each record's own, when `perRecord` says so, is built from it. */
    value: unknown;
    affectedRecords: number;
    /** How each record got a value of its own. Absent when each got the value declared. */
    perRecord?: FrozenDefaultPerRecord;
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
  /**
   * Each person account's contact: `restored` counts the ones linked to the
   * contact the platform wrote with their account; `sent` names the ones sent
   * as contacts of their own, the target holding their account as a business
   * account, and why; `unresolved` says why each other one is in the target
   * neither way.
   */
  personContact: {
    restored: number;
    /** Absent from a report written before loads sent any so. */
    sent?: Array<{ accountReferenceId: string; contactReferenceId: string; detail: string }>;
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
    /**
     * Per object, records earlier loads created that the reload did not find
     * again and left in place: the platform does not delete them — business
     * hours. Absent when none was.
     */
    keptByThePlatform?: Record<string, number>;
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
  /**
   * Records the dataset carries and the load left out, by object: a lookup
   * the target will not take empty names an object `excludedObjects` leaves
   * out, and no placeholder is declared for it — or they cannot go in without
   * such a record. Absent when none was.
   */
  heldForExcludedParents?: FrozenLeftToThePlatform[];
  mappingPath: string;
  contractPath: string;
}

/**
 * What a load would do with one object, read from the target and the sas
 * before anything is written.
 */
export interface FrozenLoadPlanObject {
  objectApiName: string;
  /** Records the dataset holds of it: of a pilot's root folder only, for a pilot. */
  fromFiles: number;
  /**
   * Records the load would send to be inserted. The target may still refuse
   * some, or skip one as a duplicate; and a contact's direct relation or an
   * email's task counted here is linked instead to the one the platform
   * writes, once its contact or email is in.
   */
  toInsert: number;
  /** Records a reload would find in the target by their identity keys, and link. */
  reusedByKeys: number;
  /**
   * Records found in what the target holds of the catalog — the standard
   * price book, a selling model or option by its natural key — and linked.
   */
  reusedFromCatalog: number;
  /** Fields of its records the target lacks or takes no value of: dropped from them. */
  fieldsDropped: number;
  /** Picklist values of its records the target refuses: cleared, or replaced as the rules declare. */
  picklistsRewritten: number;
  /**
   * Records the load would not send: the platform writes them itself, the
   * dataset does not carry a feed item's type, the target lacks the object or
   * takes no insert of it, or a lookup they may not leave empty names one of
   * those. A person account's contact is counted apart: see
   * `FrozenLoadPlanInfo.personContacts`.
   */
  notSent: number;
  /** On a reload, records earlier loads created that its purge would delete. */
  toPurge: number;
  /** On a reload, records earlier loads created that its purge would deactivate, undeletable. */
  toDeactivate: number;
  /**
   * The target's active validation rules on the object, which a preview
   * cannot evaluate: a record one of them refuses is counted to insert.
   * Listed for an object the load inserts records of; absent when it has none,
   * or when they could not be read (`FrozenLoadPlanInfo.validationRulesUnread`).
   * A rule whose formula holds only on a change of a record is not listed
   * here: see `validationRulesOnChange`.
   */
  validationRules?: SyncValidationRule[];
  /**
   * The names of the target's active rules on the object that a preview
   * leaves out of what may refuse its inserts: their formula holds only on a
   * change of a record (`ISCHANGED`, `PRIORVALUE`, a `NOT(ISNEW())` guard),
   * which an insert never is. Absent when none is.
   */
  validationRulesOnChange?: string[];
}

/**
 * What a load would do, read from the target and the sas before anything is
 * written (`frozen:load:preview`): counts and names only — no record id.
 */
export interface FrozenLoadPlanInfo {
  /** The registered org the load would write to. */
  orgId: string;
  mode: { pilot: boolean; reload: boolean };
  /** When it was read, ISO 8601. */
  plannedAt: string;
  /** Per object, in the order the load writes them, then the objects only a reload's purge reaches. */
  perObject: FrozenLoadPlanObject[];
  /** Each object the load would not send, and why. */
  excludedObjects: Array<{ objectApiName: string; reason: string }>;
  /** Each field dropped at alignment, and how many records hold a value of it. */
  removals: FrozenFieldRemoval[];
  /** The technical placeholders the load would create for required lookups, and the records each fills. */
  placeholders: Array<{
    objectApiName: string;
    field: string;
    placeholderObjectApiName: string;
    placeholderName: string;
    affectedRecords: number;
    /**
     * The target's active validation rules on the placeholder's object, which
     * may refuse it — a placeholder goes in with its name alone, and a refused
     * one stops the load. Listed here when the object's line in `perObject`
     * does not list them: when the load inserts no other record of it. Absent
     * when it has none, or when they could not be read.
     */
    validationRules?: SyncValidationRule[];
  }>;
  /** The declared defaults the load would give required fields, and the records each fills. */
  requiredDefaults: Array<{
    objectApiName: string;
    field: string;
    affectedRecords: number;
    /** How each record would get a value of its own. Absent when each would get the value declared. */
    perRecord?: FrozenDefaultPerRecord;
    /** The value the first record it fills would get, when each gets its own. */
    example?: string;
  }>;
  /** Record type references the target does not resolve. */
  recordTypeIssues: number;
  /**
   * The person accounts' contacts: the platform writes one with each person
   * account, and the load links it once the account is in — or sends it as a
   * contact of its own, where the target holds the account as a business
   * account. Counted apart from the contacts it would insert.
   */
  personContacts: number;
  /** How many loads into the target the sas mapping records: what a reload judges. */
  earlierLoads: number;
  /**
   * The records the load would leave out because a lookup the target will
   * not take empty names an object `excludedObjects` leaves out, with what
   * cannot go in without them: per object and reason, counted among the
   * records not sent. Absent when none would be.
   */
  heldForExcludedParents?: FrozenLeftToThePlatform[];
  /**
   * On a reload, per object, records of a load recorded before loads kept
   * what they created that the purge would leave in place: that load may have
   * linked them. Absent when none would be.
   */
  leftUnrecorded?: Record<string, number>;
  /**
   * On a reload, per object, records earlier loads created that the purge
   * would leave in place, the platform deleting none of them — business
   * hours the reload does not find again. Absent when none would be.
   */
  keptByThePlatform?: Record<string, number>;
  /**
   * Why the target's active validation rules could not be listed, when it
   * refused to say: any of them may still refuse a record counted to insert.
   */
  validationRulesUnread?: string;
}

/**
 * How each record a declared default fills gets a value of its own: `token`,
 * the value carries `{n}` or `{referenceId}`, replaced per record; `unique`,
 * the target keeps the field unique, and the record's rank is appended;
 * `name`, the field is the object's name — which the target, or a package of
 * its, may hold unique where its describe does not say so — and the rank is
 * appended.
 */
export type FrozenDefaultPerRecord = 'token' | 'unique' | 'name';

/**
 * Load/verify phases surfaced in progress events. `mapping` reads what earlier
 * loads wrote, from the sas, and `pilot` selects a pilot's root folder, both
 * between the entry guards and what the load reuses. `catalog` looks up what
 * the target already holds of the catalog — the standard price book, the
 * selling models and their options — after what a reload reuses and before
 * the alignment.
 */
export type FrozenLoadPhase =
  | 'guards'
  | 'mapping'
  | 'pilot'
  | 'reload'
  | 'catalog'
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
   * before the first write — the entry guards, the mapping, the root folder,
   * what a reload reuses, the catalog, the alignment, the required fields —
   * that refused the load or threw, saying why.
   */
  status: 'started' | 'done' | 'error' | 'stopped';
  /** Progress percentage (0-100). */
  progress: number;
  message: string;
}

/** One post-load verification check outcome. */
export interface FrozenPostLoadCheck {
  name: 'stability' | 'counts' | 'load' | 'orphans' | 'personcontact' | 'presence';
  passed: boolean;
  detail: string;
}

/**
 * Final post-load verdict: `partial` when the load wrote part of the dataset —
 * records of an object refused or held back, none of an object whole, or
 * lookups left empty for a parent it did not load — and nothing else is amiss.
 */
export interface FrozenVerifyVerdict {
  status: 'passed' | 'partial' | 'failed' | 'unstable';
  checks: FrozenPostLoadCheck[];
  /** Measurements taken (2 identical snapshots stop the loop early). */
  attempts: number;
  measuredAt: string;
  manifestPath?: string;
  /**
   * Per object of the counting contract, what the verification found of it.
   * Absent from verdicts given before they were kept per object.
   */
  objects?: FrozenObjectVerdict[];
}

/**
 * What a verification found of one object, among the records the load wrote:
 * `passed` when the org holds every record of it the load says it wrote, the
 * load wrote every record of it it had to, and none of them is an orphan on a
 * mandatory lookup or misses its presence key.
 */
export interface FrozenObjectVerdict {
  objectApiName: string;
  status: 'passed' | 'failed';
  /** Records the counting contract says the load wrote. */
  expected: number;
  /** Of those, the records the org holds. */
  found: number;
  /** Records the load had to write and did not: refused, or held back for a parent refused. */
  notLoaded: number;
  /** Orphans found on its mandatory lookups, at most the sample each lookup reads. */
  orphans: number;
  /** Presence keys of its records the org does not hold. */
  missingKeys: number;
  /** Person accounts not holding the contact the load linked: Account only. */
  personContactsUnlinked?: number;
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
   * placeholder — that a removal would take, the object it wrote last first:
   * once a removal left some in the org, those. Empty when it created none,
   * when the mapping does not say, and once a removal took them all.
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
  /**
   * Set once a removal of the load's records deleted some, or found some
   * gone, cancelled or not. `created` then counts what it left in the org, if
   * any.
   */
  removed?: ForgeUndoMark;
  /**
   * Set when this is a load before the last one, whose records the loads
   * after it left in the org — a load without Reload purges nothing, and the
   * target can refuse part of a purge — once the last load's records all went,
   * or when it created none: its removal comes next.
   */
  earlier?: true;
  /**
   * Per object, records the load created that no removal takes: the platform
   * does not delete them — business hours. Not in `created`; absent when the
   * load created none.
   */
  keptByThePlatform?: Array<{ objectApiName: string; count: number }>;
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
  /**
   * Set on a removal of what an earlier removal of the load left in the org:
   * when that one ended, ISO 8601. It set out to take only those records.
   */
  leftBy?: string;
  /**
   * What the sweep asked with the removal did, before the load's records
   * went: what the target's automation created during the load, as its user.
   * Absent when none was asked.
   */
  sweep?: ForgeSweepResult;
  /**
   * Per object, records the load created that the removal kept, never sent to
   * be deleted: the platform does not delete them — business hours. Absent
   * when the load created none.
   */
  keptByThePlatform?: Array<{ objectApiName: string; count: number }>;
}

/**
 * What a removal would do with one object's records, read before its first
 * write: Forge's removal preview (`RunRemovalOptions.previewOnly`). `toDelete`,
 * `alreadyGone`, `keptChanged`, `undeletable`, `notVisible` and `unread` add up
 * to `planned`.
 */
export interface FrozenRemovalPreviewObject {
  objectApiName: string;
  /** The load's records of the object a removal sets out to take. */
  planned: number;
  /** In the org, and sent: the org may still refuse some, or a removal keep some for records that stay. */
  toDelete: number;
  /** Found deleted: gone, as a removal counts them. */
  alreadyGone: number;
  /** In the org and modified since the load, by anyone. */
  changedSince: number;
  /** Of those, the ones a removal keeps: all of them, unless changed records are included. */
  keptChanged: number;
  /** Who last modified the records changed since, by user Id: how many each. */
  changedBy: Record<string, number>;
  /** Of an object the user the removal runs as may not delete: left, never sent. */
  undeletable: number;
  /** Found neither in the org nor in its recycle bin: never counted as removed. */
  notVisible: number;
  /** Of an object the removal could not read: none of them would be sent. */
  unread: number;
  /** Why records stay, or could not be told, in the org's words where it gave them. */
  reasons: string[];
}

/**
 * What a removal of the load would do, read before its first write and
 * nothing written (`frozen:remove:preview`): counts and names only — no
 * record id but the users' who changed records since.
 */
export interface FrozenRemovalPreview {
  /** When the load wrote its last record: which load. */
  loadedAt: string;
  /** Whether records modified since the load would go too. */
  includeChanged: boolean;
  /** The load's records a removal sets out to take. */
  planned: number;
  /** Per object, in the order a removal takes them: children before their parents. */
  objects: FrozenRemovalPreviewObject[];
  /** The names of the users `changedBy` counts, by user Id, where the org said them. */
  userNames: Record<string, string>;
  /** Set when an earlier removal left these records: when it ended. */
  leftBy?: string;
  /** Records the load created that no removal takes: the platform deletes none of them. */
  keptByThePlatform?: Array<{ objectApiName: string; count: number }>;
  /** What a removal run now would be refused for, each in its own words. */
  refusals: string[];
}

/** The verdict of the last verification of a load into a target org. */
export interface FrozenLastVerifyInfo {
  /** The registered org the verified load wrote to. */
  orgId: string;
  status: FrozenVerifyVerdict['status'];
  /** When the verification measured the org, ISO 8601. */
  measuredAt: string;
}

/**
 * The pseudonymization rules file an extraction reads, as `frozen:status`
 * finds it where the saved configuration points (`rulesFilePath`), else
 * `rules.json` in the sas. An extraction is refused without it, and nothing
 * on the page said where it goes or what it holds.
 */
export interface FrozenRulesFileInfo {
  /** The absolute path the extraction reads. */
  path: string;
  /** Whether a file is there. */
  found: boolean;
  /** Its `rulesVersion`, when it is a valid rules file. */
  rulesVersion?: string;
  /** How many fields it gives a rule, when it is a valid rules file. */
  ruleCount?: number;
  /** Why the file there is no valid rules file: it cannot be read, or is no JSON rules file. */
  invalid?: string;
}

/** Module status snapshot returned by `frozen:status`. */
export interface FrozenStatusInfo {
  /** True when a project config is persisted. */
  configured: boolean;
  /** Resolved sas directory (outside the repo). */
  sasDir: string;
  /** Resolved dataset directory. */
  datasetDir: string;
  /**
   * Salt presence + fingerprint (never the salt itself), and where it is kept:
   * VS Code's secret storage, made on the first extraction; the
   * `SANDFORGE_FROZEN_SALT` environment variable, which wins where it is set;
   * a file, on the command line. Absent before the first extraction.
   */
  salt: {
    present: boolean;
    fingerprint?: string;
    source?: 'environment' | 'secretStorage' | 'file';
  };
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
  /**
   * Per target org, by its registered id, the last load recorded into it:
   * the one a verification of that org checks. An org no load went into is
   * not listed. Told only the last load, whatever its org, the page offered
   * to verify an org no load went into, and the click ended in `NO_LOAD`.
   */
  lastLoads: Array<{ status: string; orgId: string; at: string }>;
  /**
   * Per target org, by its registered id, the verdict of the last
   * verification of a load into it; an org never verified is not listed.
   * Kept as one verdict whichever org was verified, the page showed one
   * org's beside another selected as the target.
   */
  lastVerifies: FrozenLastVerifyInfo[];
  /**
   * Per target org the sas holds a mapping of, the records of the load a
   * removal takes next there — from this window or from the command line —
   * for their removal: the last load into that org, or, once its records
   * went, the newest load before it whose records are still there. Each org's
   * loads are kept apart: a load into one org leaves the loads into another
   * named. Absent when no load wrote a mapping.
   */
  loadRecords?: FrozenLoadRecordsInfo[];
  /** The rules file an extraction would read: where it is, and what it holds. */
  rules?: FrozenRulesFileInfo;
}
