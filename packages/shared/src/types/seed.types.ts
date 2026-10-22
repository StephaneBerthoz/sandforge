import type { UUID, ISODateString, ApiName } from './common.types.js';
import type {
  ForgeEmailLimit,
  ForgeSweepResult,
  ForgeTargetAutomationUnread,
  ForgeUndoMark,
  ForgeUndoObjectResult,
  ForgeUndoStatus,
} from './forge.types.js';

/** Seed generation strategy */
export type SeedStrategy = 'ai' | 'faker' | 'template' | 'csv_import' | 'clone';

/** Field generation rule type */
export type FieldRuleType =
  | 'static'
  | 'random'
  | 'sequence'
  | 'formula'
  | 'reference'
  | 'picklist_random'
  | 'ai_generate'
  | 'faker'
  | 'regex'
  | 'from_csv';

/** Seed template — full configuration for a seed operation */
export interface SeedTemplate {
  id: UUID;
  name: string;
  description: string;
  version: number;
  strategy: SeedStrategy;
  objects: SeedObjectConfig[];
  /**
   * Lookups filled from a parent object's records, at most one per child
   * object. Without one, a lookup to an object of the run takes a random
   * record of it through its `reference` rule.
   */
  relations?: SeedRelation[];
  aiPersona?: string;
  tags: string[];
  createdAt: ISODateString;
  updatedAt: ISODateString;
}

/**
 * A lookup of a generated object, filled from a parent object's records.
 *
 * The relation also decides how many records the child object gets: each
 * parent receives what `distribution` gives it. The child's `recordCount` is
 * the most the run writes for it — the figure the plan and the production
 * guard counted — so a relation never writes more than was confirmed.
 */
export interface SeedRelation {
  /** The generated object whose lookup is filled. */
  childObject: ApiName;
  /** The lookup field of the child, e.g. `AccountId`. */
  lookupField: string;
  /** The object the lookup points at. */
  parentObject: ApiName;
  /** Where the parent records come from. */
  parents: SeedRelationParents;
  /** How many children each parent receives. */
  distribution: SeedRelationDistribution;
}

/**
 * Where a relation's parents come from: the records this run writes for the
 * parent object, or records the org already holds, picked by a SOQL filter.
 */
export type SeedRelationParents =
  | { kind: 'generated' }
  | {
      kind: 'existing';
      /** A SOQL WHERE condition, without the keyword. Absent, any record will do. */
      where?: string;
      /** The most parent records read from the org. */
      limit: number;
    };

/**
 * How many children each parent receives: exactly `count`; a whole number
 * drawn between `min` and `max`; or `ratio` on average, spread evenly — 0.5
 * gives a child to every other parent, 1.5 alternates one and two.
 */
export type SeedRelationDistribution =
  | { mode: 'perParent'; count: number }
  | { mode: 'range'; min: number; max: number }
  | { mode: 'ratio'; ratio: number };

/** Per-object seed configuration */
export interface SeedObjectConfig {
  objectApiName: ApiName;
  recordCount: number;
  recordTypeId?: string;
  fieldRules: FieldRule[];
  excludedFields: string[];
  insertOrder: number;
  batchSize: number;
}

/**
 * A record type a seed can give an object's records, as the target offers it
 * to the running user: active, open to them, never the master.
 */
export interface SeedRecordTypeOption {
  recordTypeId: string;
  developerName: string;
  /** Its label, in the org's language. */
  label: string;
  /** A person account's record type: accounts of it are written as person accounts. */
  person: boolean;
  /** The running user's default: the records' type when none is chosen. */
  isDefault: boolean;
}

/** Field generation rule */
export interface FieldRule {
  fieldApiName: string;
  /** Describe type of the field (e.g. 'string', 'currency'), when the author knew it. */
  fieldType?: string;
  ruleType: FieldRuleType;
  config: FieldRuleConfig;
}

/** Field rule configuration — varies by rule type */
export interface FieldRuleConfig {
  staticValue?: string | number | boolean;
  fakerMethod?: string;
  fakerLocale?: string;
  sequenceStart?: number;
  sequenceStep?: number;
  sequencePrefix?: string;
  formula?: string;
  referenceObject?: string;
  referenceField?: string;
  picklistValues?: string[];
  regexPattern?: string;
  csvColumn?: string;
  minValue?: number;
  maxValue?: number;
  minLength?: number;
  maxLength?: number;
  aiPrompt?: string;
}

/** Seed execution result */
export interface SeedExecutionResult {
  templateId: UUID;
  operationId: UUID;
  status: 'success' | 'partial' | 'failure';
  objectResults: SeedObjectResult[];
  totalRecordsCreated: number;
  totalRecordsFailed: number;
  duration: number;
  timestamp: ISODateString;
  /**
   * Set when a cancel stopped the run before it had written every object. The
   * objects listed are the ones it reached, and the records they created stay
   * in the org; its status is never `success`.
   */
  cancelled?: boolean;
}

/** Per-object seed result */
export interface SeedObjectResult {
  objectApiName: ApiName;
  recordsCreated: number;
  recordsFailed: number;
  createdIds: string[];
  errors: string[];
  /**
   * Set on the result posted to the webview when createdIds or errors hold
   * only their first entries. recordsCreated and recordsFailed stay whole.
   */
  truncated?: boolean;
  /**
   * AI fields of this object that received a generated sentence instead of
   * an AI value for at least one record. Absent when every AI field got one.
   */
  aiFallback?: SeedAiFallback;
}

/**
 * Why AI fields received generated sentences: the AI call answered nothing
 * (AI is off or the call was refused), or its answer left values out.
 */
export interface SeedAiFallback {
  fields: string[];
  reason: 'no-answer' | 'short-answer';
}

/** Seed data plan — preview of what will be created */
export interface SeedDataPlan {
  objects: SeedDataPlanObject[];
  totalRecords: number;
  estimatedApiCalls: number;
  estimatedDuration: number;
  grappeRecommended: boolean;
}

/** Per-object preview in the seed data plan */
export interface SeedDataPlanObject {
  objectApiName: ApiName;
  recordCount: number;
  sampleRecords: Record<string, unknown>[];
  dependsOn: string[];
}

// ── Schema Analysis (ERD) ────────────────────────────────

/** Salesforce field metadata from describe */
export interface SeedFieldInfo {
  apiName: string;
  label: string;
  type: string;
  required: boolean;
  defaultValue: unknown;
  picklistValues?: string[];
  referenceTo?: string;
  unique: boolean;
  externalId: boolean;
  maxLength?: number;
}

/** Relationship between two objects */
export interface SeedRelationship {
  fieldName: string;
  targetObject: string;
  type: 'Lookup' | 'MasterDetail';
  required: boolean;
}

/** Object node in the ERD graph */
export interface ObjectNode {
  apiName: string;
  label: string;
  recordCount: number;
  fields: SeedFieldInfo[];
  relationships: SeedRelationship[];
}

/** ERD data: the objects of a seed, their links and the order to insert them in */
export interface ERDData {
  nodes: ObjectNode[];
  edges: ERDEdge[];
  insertionOrder: string[];
  circularDeps: string[][];
  warnings: string[];
}

/** Edge in the ERD graph */
export interface ERDEdge {
  source: string;
  target: string;
  field: string;
  type: 'Lookup' | 'MasterDetail';
}

// ── Smart Field Generation ───────────────────────────────

/** Field generation mode carried by a {@link FieldGenerationConfig}. */
export type FieldGenerationMode =
  'auto' | 'faker' | 'fixed' | 'sequence' | 'null' | 'picklist_random';

/** Configuration for generating a single field */
export interface FieldGenerationConfig {
  fieldName: string;
  fieldType: string;
  generationMode: FieldGenerationMode;
  fakerMethod?: string;
  fixedValue?: unknown;
  sequencePattern?: string;
  constraints: FieldGenerationConstraints;
}

/** Constraints on generated field values */
export interface FieldGenerationConstraints {
  required: boolean;
  unique: boolean;
  maxLength?: number;
  minLength?: number;
  picklistValues?: string[];
  min?: number;
  max?: number;
  /** Whether this field is a multipicklist (values separated by semicolons) */
  multipicklist?: boolean;
}

// ── Validation Rule Pre-Check ────────────────────────────

/** Constraint extracted from a validation rule formula */
export interface VRFieldConstraint {
  /** Field API name referenced in the formula */
  fieldName: string;
  /** Type of constraint detected */
  constraintType: 'required' | 'picklist_value' | 'length' | 'regex' | 'cross_field';
  /** Expected picklist value (for picklist_value constraints) */
  expectedValue?: string;
  /** Minimum length (for length constraints) */
  minLength?: number;
  /** Maximum length (for length constraints) */
  maxLength?: number;
  /** Regex pattern (for regex constraints) */
  regexPattern?: string;
  /** Related field name (for cross_field constraints) */
  relatedField?: string;
}

// ── CSV Import ──────────────────────────────────────────────

/** Mapping between a CSV column header and a Salesforce field. */
export interface CsvColumnMapping {
  csvHeader: string;
  sfFieldApiName: string;
  sfFieldType: string;
  sfFieldLength: number | null;
}

/** Full payload for a CSV import execution request. */
export interface CsvImportConfig {
  orgId: string;
  objectApiName: string;
  records: Record<string, string>[];
  columnMappings: CsvColumnMapping[];
  externalIdField?: string;
}

/** Single validation error found in CSV data. */
export interface CsvValidationError {
  row: number;
  column: string;
  field: string;
  errorType:
    | 'type_mismatch'
    | 'missing_required'
    | 'length_exceeded'
    | 'duplicate_external_id'
    | 'invalid_picklist';
  message: string;
  value: string;
}

/** Result of validating CSV data against Salesforce metadata. */
export interface CsvValidationResult {
  valid: boolean;
  errors: CsvValidationError[];
  warningCount: number;
}

/** Validation rule analysis result */
export interface VRCheckResult {
  ruleName: string;
  objectName: string;
  formula: string;
  errorMessage: string;
  potentialConflicts: string[];
  risk: 'low' | 'medium' | 'high';
  /** Structured constraints extracted from the formula */
  fieldConstraints: VRFieldConstraint[];
}

/** Why no removal of a Seed run can run now. */
export type SeedRemovalRefusalCode = 'GUARD_BLOCKED' | 'NO_GUARD' | 'ORG_GONE' | 'RUNNING';

/**
 * What a Seed run created, as the extension keeps it, and what a removal of
 * it takes: read from what the run kept, nothing asked of the org but the
 * Bulk API job a run whose window closed left under way.
 */
export interface SeedRunRemovalInfo {
  /** The run, by its result's `operationId`, or the id a CSV import or a clone answered with. */
  runId: string;
  /** The org it wrote to. */
  targetOrgId: string;
  /**
   * Which of the Seed page's ways wrote it, when not the generator: a CSV
   * import, or a clone from another org. Absent for a seed.
   */
  origin?: 'csv' | 'clone';
  /** The org a clone read from. */
  sourceOrgId?: string;
  /** When the run started, by this machine's clock. */
  startedAt: ISODateString;
  /**
   * When it ended, by this machine's clock; for a run that did not end, when
   * it last wrote.
   */
  endedAt: ISODateString;
  /**
   * Set for a run kept with no end: it stopped part way — its window closed,
   * or the extension stopped under it — and what is kept is what it had
   * written until then, removable as any run's.
   */
  unfinished?: true;
  /**
   * Set for a run still writing in this window: it has no end yet because it
   * has not ended, not because its window closed. Its removal is refused
   * until it ends, as a Sync run's is.
   */
  running?: true;
  /**
   * Set for a run another window is writing now — the process its file names
   * is alive — read as one that stopped, it was listed as partial, and its
   * open Bulk API job aborted. Its removal is refused until it ends.
   */
  runningElsewhere?: true;
  /** Records it created, in all. */
  created: number;
  /**
   * What a removal takes now, per object, the last object written first.
   * Empty once removals took them all.
   */
  left: Array<{ objectApiName: string; count: number }>;
  /** What the removals of it did, once one took some. */
  removed?: ForgeUndoMark;
  /** Why no removal can run now; absent when one can. */
  refusal?: { code: SeedRemovalRefusalCode; message: string };
}

/** What removing what a Seed run created did, object by object, the last written first. */
export interface SeedRemovalResult {
  runId: string;
  status: ForgeUndoStatus;
  /** Whether records modified since the run, and what was added to them since, went too. */
  includeChanged: boolean;
  objects: ForgeUndoObjectResult[];
  /** When the removal ended, ISO 8601. */
  finishedAt: ISODateString;
  /** Set on a removal of what an earlier one left: when that one ended, ISO 8601. */
  leftBy?: ISODateString;
  /**
   * What the sweep asked with the removal took, before the run's records went:
   * what the target's automation created during the run, as its user.
   */
  sweep?: ForgeSweepResult;
}

/**
 * One flow, Apex trigger, Process Builder process or workflow rule of an org
 * that runs as a seed creates the records of an object, as the confirmation
 * says it before anything is written.
 */
export interface SeedAutomationEntry {
  kind: 'flow' | 'trigger' | 'process' | 'workflowRule';
  /** The flow's, process's or rule's label, or the trigger's name. */
  name: string;
  /** Before the record is saved, after it, or both. */
  when: 'before' | 'after' | 'beforeAndAfter';
  /** Its email actions: each sends one email a record created, whatever path it is on. */
  emails: number;
  /** What else it sends out of the org. */
  messages: Array<'notification' | 'outbound' | 'sms'>;
  /** The objects its record-create elements create. */
  creates: string[];
  /** Whether part of it runs once the save is committed, out of reach of any rollback. */
  afterCommit: boolean;
  /**
   * The custom permissions that keep it from doing anything for the user who
   * holds them, and whether the user the seed writes as does; `held` is
   * absent when that could not be read.
   */
  bypasses: Array<{ name: string; held?: boolean }>;
  /** True when the user the seed writes as holds one of them: it does nothing for this seed. */
  keptQuiet: boolean;
  /** Its start condition, or its definition, could not be read: what it does is not known. */
  unread: boolean;
}

/** What runs as a seed creates the records of one object. */
export interface SeedAutomationObject {
  objectApiName: string;
  entries: SeedAutomationEntry[];
}

/** The emails one record of an object makes an org send against one daily limit. */
export interface SeedEmailsPerRecord {
  objectApiName: string;
  limit: ForgeEmailLimit;
  perRecord: number;
  /** The flows, processes and rules that send them, by label. */
  sentBy: string[];
}

/**
 * A custom permission that keeps quiet what fires as the records are
 * created, which the user the seed writes as does not hold, and the smallest
 * permission set of the org that includes it; absent when none does or the
 * permission sets could not be read.
 */
export interface SeedBypassWay {
  permission: string;
  permissionSet?: string;
}

/**
 * What an org runs as a seed creates its records, read before the first is
 * written: what the confirmation shows, and what the seed's email gate holds
 * the record counts to.
 */
export interface SeedAutomationPreview {
  /** The org, as the panel names it. */
  org: string;
  /** The objects the read looked at. */
  objectsRead: string[];
  /** The objects on which something runs as their records are created, in the order asked. */
  objects: SeedAutomationObject[];
  /** The emails one record of each object makes the org send, per daily limit. */
  emailsPerRecord: SeedEmailsPerRecord[];
  /**
   * What the org has left today of its daily email limits; absent when no
   * record sends any, or when they could not be read (`limitsUnread`).
   */
  limits?: Partial<Record<ForgeEmailLimit, { max: number; remaining: number }>>;
  /** Why the org's email limits could not be read. */
  limitsUnread?: string;
  /**
   * Whether the email alerts of the org count against its single emails too,
   * as they do on an org held to the fifteen a day of a Developer Edition.
   */
  alertsAsSingle: boolean;
  /** The bypasses the user the seed writes as does not hold, and how each is had. */
  bypasses: SeedBypassWay[];
  /** The bypasses the user the seed writes as holds: what they keep quiet stays quiet. */
  bypassesHeld: string[];
  /** The parts of the read the org refused, and why. */
  unread: Array<{ part: ForgeTargetAutomationUnread['part']; reason: string }>;
  /** Whether a part read whole was refused: "nothing runs" cannot then be said. */
  blinded: boolean;
  /** Start conditions left unread past the most the read takes. */
  conditionsNotRead: number;
}

/** The emails a seed's records make an org send against one daily limit, and what is left of it. */
export interface SeedEmailEstimate {
  limit: ForgeEmailLimit;
  emails: number;
  /** The objects that send them: the records created, and the emails each sends. */
  objects: Array<{ objectApiName: string; records: number; perRecord: number; sentBy: string[] }>;
  /**
   * `exceeds` past what the org has left today: the seed is refused before it
   * writes. `unread` when the org did not say what it has left.
   */
  verdict: 'fits' | 'exceeds' | 'unread';
  remaining?: number;
  max?: number;
}
