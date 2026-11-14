import type {
  UUID,
  ISODateString,
  ApiName,
  ComplianceFrameworkType,
  BaseAnonymizationRule,
} from './common.types.js';

/** Backup status */
export type BackupStatus = 'pending' | 'running' | 'completed' | 'failed' | 'expired';

/** Backup configuration */
export interface BackupConfig {
  id: UUID;
  name: string;
  orgId: UUID;
  objects: ApiName[];
  includeAttachments: boolean;
  includeFiles: boolean;
  compression: boolean;
  encryption: boolean;
  schedule?: BackupSchedule;
  retentionDays: number;
  createdAt: ISODateString;
}

/** Backup schedule */
export interface BackupSchedule {
  enabled: boolean;
  cron: string;
  timezone: string;
  maxRetries: number;
}

/** Backup execution result */
export interface BackupResult {
  configId: UUID;
  operationId: UUID;
  status: BackupStatus;
  objectResults: BackupObjectResult[];
  totalRecords: number;
  totalSize: number;
  filePath: string;
  checksum: string;
  startTime: ISODateString;
  endTime: ISODateString;
  duration: number;
}

/** Per-object backup result */
export interface BackupObjectResult {
  objectApiName: ApiName;
  recordCount: number;
  size: number;
  status: 'success' | 'failure';
  error?: string;
}

/** Anonymization template */
export interface AnonymizationTemplate {
  id: UUID;
  name: string;
  description: string;
  rules: DataOpsAnonymizationRule[];
  complianceFramework?: ComplianceFrameworkType;
  tags: string[];
  createdAt: ISODateString;
}

/** Anonymization rule for DataOps templates */
export interface DataOpsAnonymizationRule extends BaseAnonymizationRule {
  /** Additional configuration for the anonymization */
  config: AnonymizationRuleConfig;
}

/** Anonymization rule configuration */
export interface AnonymizationRuleConfig {
  maskChar?: string;
  maskStart?: number;
  maskEnd?: number;
  /**
   * How many characters at the end of the value a `mask` rule leaves, where
   * no `maskEnd` says where the mask stops: a phone number's last four. A
   * value no longer than that is masked whole.
   */
  maskKeepLast?: number;
  hashAlgorithm?: 'sha256' | 'md5';
  hashSalt?: string;
  fakerMethod?: string;
  fakerLocale?: string;
  constantValue?: string;
  /** How many characters a `truncate` rule keeps. Unset, it keeps none. */
  truncateLength?: number;
  /**
   * Which end of the value those characters are kept from: the last ones
   * unless the rule says `first`, as a postal code cut to its region does.
   */
  truncateKeep?: 'first' | 'last';
  preserveLength?: boolean;
}

/**
 * The settings a masking template itself gives a rule: the value a constant
 * writes, how much a truncation keeps. Never a salt — a salt written into a
 * template is readable by anyone who can read the template, and is then no
 * key at all; the run that applies the template supplies one.
 */
export type AnonymizationTemplateRuleConfig = Omit<AnonymizationRuleConfig, 'hashSalt'>;

/** One object a data-quality scan is asked to read. */
export interface DataQualityScanTarget {
  objectApiName: ApiName;
  /** Field to look for duplicates by; without one the scan takes `Email`, else the record's name. */
  duplicateKey?: string;
}

/**
 * Why a field has no fill count in a data-quality scan.
 *
 * - `not-countable`: the org will neither aggregate nor filter it — a long or
 *   rich text area, an encrypted field — so only reading the records would
 *   tell, and the scan reads none.
 * - `query-budget`: the org filters it but will not aggregate it — a
 *   multi-select picklist — so it takes a query of its own, and the object had
 *   already spent the scan's allowance of those.
 * - `refused`: the org answered the query that counts it with an error, which
 *   the object's `errors` carry.
 */
export type DataQualityUnmeasuredReason = 'not-countable' | 'query-budget' | 'refused';

/** How many records hold a value in one field, as the org counted them. */
export interface DataQualityFieldFill {
  fieldApiName: string;
  label: string;
  /** Records where the field is not empty. */
  filled: number;
  /**
   * A new record is refused without it: the describe requires it at insert
   * (createable, not nillable, no default), or the platform does whatever the
   * describe says.
   */
  required: boolean;
}

/** A field the scan could not count, and why. */
export interface DataQualityUnmeasuredField {
  fieldApiName: string;
  label: string;
  reason: DataQualityUnmeasuredReason;
}

/** Values of one field that more than one record carries. */
export interface DataQualityDuplicates {
  /** The field the records were grouped by. */
  keyField: string;
  keyLabel: string;
  /** The most repeated values first, at most `bounds.duplicateSample` of them. */
  groups: Array<{ value: string; count: number }>;
  /** Values carried by two records or more. A floor when `truncated`. */
  groupCount: number;
  /** Records carrying one of those values. A floor when `truncated`. */
  recordCount: number;
  /** The search stopped at `bounds.duplicateGroupLimit` values: there may be more. */
  truncated: boolean;
}

/** Records nobody has modified for a while. */
export interface DataQualityStaleness {
  /** The threshold, in days. */
  days: number;
  /** Records whose `LastModifiedDate` is older than the threshold. */
  records: number;
}

/** A check the org answered with an error. The object's other checks stand. */
export interface DataQualityCheckError {
  check: 'fill' | 'duplicates' | 'stale';
  message: string;
}

/** One object a data-quality scan read. */
export interface DataQualityObjectScan {
  status: 'scanned';
  objectApiName: ApiName;
  label: string;
  /** `SELECT COUNT()`: every other figure is out of this many records. */
  totalRecords: number;
  /** The fields a person or an integration fills in, emptiest first. */
  fields: DataQualityFieldFill[];
  /** Such fields the scan could not count, named so their absence is not read as full. */
  unmeasured: DataQualityUnmeasuredField[];
  /** Null when there was no key the org can group records by. */
  duplicates: DataQualityDuplicates | null;
  /** Null when the object has no `LastModifiedDate` to filter on. */
  stale: DataQualityStaleness | null;
  /** Fields the org can group records by: what a duplicate search may be keyed on. */
  keyFields: Array<{ fieldApiName: string; label: string }>;
  errors: DataQualityCheckError[];
}

/** An object the scan could not read at all: not described, or not counted. */
export interface DataQualityObjectFailure {
  status: 'failed';
  objectApiName: ApiName;
  message: string;
}

/** One object of a data-quality scan, read or not. */
export type DataQualityObjectResult = DataQualityObjectScan | DataQualityObjectFailure;

/** The bounds a scan worked within, so a result that met one can say which. */
export interface DataQualityScanBounds {
  /** Repeated values one duplicate search reads at most. */
  duplicateGroupLimit: number;
  /** Repeated values handed back per object. */
  duplicateSample: number;
  /** Fields counted with a query of their own, per object. */
  singleFieldQueries: number;
}

/**
 * What `dataops:quality-scan` answers: for each object asked for, how often
 * its fields are filled, which values repeat, and how many records nobody has
 * modified for `staleDays` — every figure a count the org made, none of them
 * taken from records read by the extension.
 */
export interface DataQualityScanResult {
  orgId: string;
  staleDays: number;
  scannedAt: ISODateString;
  bounds: DataQualityScanBounds;
  objects: DataQualityObjectResult[];
}

/** How the PII detector classes a field it names. */
export type PiiClassification = 'PII' | 'PHI' | 'PCI' | 'Confidential';

/**
 * How the detector came to name a field: its API name or label, its type
 * (`email`, `phone`), or the values the inventory's sample holds in it.
 */
export type PiiDetectionMethod = 'name' | 'type' | 'content';

/** The identifier a subject search looks for in a field. */
export type SubjectIdentifierKind = 'email' | 'phone' | 'name';

/** One field of an object that holds personal data, as an inventory found it. */
export interface PiiInventoryField {
  fieldApiName: string;
  label: string;
  classification: PiiClassification;
  detectedBy: PiiDetectionMethod;
  /** The detector's pattern: `email`, `phone_type`, `email_content`… */
  pattern: string;
  /** Sampled records holding a value in the field. Zero: the detector named it, the sample left it empty. */
  filled: number;
  /** Found from its values: how many sampled values match the detector's pattern. */
  matched?: number;
  /** A subject search looks here for an address or a number; absent when it does not. */
  searchedFor?: Exclude<SubjectIdentifierKind, 'name'>;
}

/** One object an inventory read. */
export interface PiiInventoryObjectScan {
  status: 'scanned';
  objectApiName: ApiName;
  label: string;
  /** Records the sample read: at most the inventory's `sampleSize`. */
  sampled: number;
  /** The fields that hold personal data, the ones the sample confirms first. */
  fields: PiiInventoryField[];
  /** The record's name, which a subject search looks in for a person's name. */
  nameField: { fieldApiName: string; label: string } | null;
  /** The org refused the sample: the fields named from their names and types stand unconfirmed. */
  sampleError?: string;
}

/** An object an inventory could not read at all. */
export interface PiiInventoryObjectFailure {
  status: 'failed';
  objectApiName: ApiName;
  message: string;
}

/** One object of an inventory, read or not. */
export type PiiInventoryObjectResult = PiiInventoryObjectScan | PiiInventoryObjectFailure;

/**
 * What `dataops:pii-inventory` answers: for each object asked for, the fields
 * the pre-flight PII detector names, confirmed on a sample of at most
 * `sampleSize` records. Counts only: no value read leaves the extension.
 */
export interface PiiInventoryResult {
  orgId: string;
  scannedAt: ISODateString;
  /** Records read per object, at most. */
  sampleSize: number;
  objects: PiiInventoryObjectResult[];
}

/** What a subject search looks for: one person's address, name or number. At least one. */
export interface SubjectIdentifiers {
  email?: string;
  name?: string;
  phone?: string;
}

/** One record a subject search found. */
export interface SubjectRecord {
  /** The record's Id. */
  id: string;
  /** Its name as the org shows it, when the object has a name field. */
  name: string | null;
  /** The fields whose value matched. */
  matchedBy: string[];
}

/** A field a subject search looked in. */
export interface SubjectSearchedField {
  fieldApiName: string;
  label: string;
  kind: SubjectIdentifierKind;
}

/** One object a subject search read. */
export interface SubjectSearchObjectResult {
  status: 'searched';
  objectApiName: ApiName;
  label: string;
  /**
   * What the org counted (`SELECT COUNT()`), before a phone number is
   * compared digit by digit: at least as many as `records`.
   */
  counted: number;
  /** The records found, at most the search's `limit`. */
  records: SubjectRecord[];
  /** More records matched than are listed; only the listed ones can be exported or erased. */
  truncated: boolean;
  searched: SubjectSearchedField[];
}

/** An object that has no field to look in for any identifier the search was given. */
export interface SubjectSearchObjectSkipped {
  status: 'skipped';
  objectApiName: ApiName;
  label: string;
}

/** An object the org would not describe or search. */
export interface SubjectSearchObjectFailure {
  status: 'failed';
  objectApiName: ApiName;
  message: string;
}

export type SubjectSearchObject =
  SubjectSearchObjectResult | SubjectSearchObjectSkipped | SubjectSearchObjectFailure;

/**
 * What `dataops:dsr:search` answers. The identifiers searched are not echoed:
 * the page has them, and nothing downstream of it keeps them.
 */
export interface SubjectSearchResult {
  /** The request the search belongs to, in the local log. */
  requestId: string;
  orgId: string;
  searchedAt: ISODateString;
  /** Records listed per object, at most. */
  limit: number;
  objects: SubjectSearchObject[];
}

/** How a subject's records are erased: overwritten in place, or deleted. */
export type SubjectEraseMode = 'anonymize' | 'delete';

/** How an erasure overwrites one field: with a made-up value, or with nothing. */
export type ErasureMethod = 'fake' | 'nullify';

/** Records of another object the org deletes along with the ones deleted. */
export interface RelatedRecordCount {
  objectApiName: ApiName;
  label: string;
  /** Records that point at one of the records deleted, as the org counted them. */
  records: number;
}

/** What an erasure or a delete will do to one object, before it does it. */
export interface RemovalPlanObject {
  objectApiName: ApiName;
  label: string;
  /** Records it acts on. */
  records: number;
  /** Anonymize: each field overwritten, and how. */
  fields?: Array<{ fieldApiName: string; label: string; method: ErasureMethod }>;
  /** Anonymize: fields holding personal data the connected user may not write, left as they are. */
  kept?: Array<{ fieldApiName: string; label: string }>;
  /** Delete: what the org deletes along with these records. */
  related?: RelatedRecordCount[];
  /** Delete: related objects the org would not count. */
  uncounted?: string[];
  /** Why nothing can be done to this object: the connected user may not update or delete it. */
  refused?: string;
}

/** What one erasure or delete wrote, or was refused, per object. */
export interface RemovalOutcome {
  status: 'success' | 'partial' | 'failure';
  /** Records overwritten or deleted. */
  done: number;
  /** Records the org refused. */
  failed: number;
  objects: Array<{ objectApiName: ApiName; done: number; failed: number }>;
  /** A bounded sample of what the org said about a refused record. */
  errors: Array<{ objectApiName: ApiName; message: string }>;
}

/** One step of a subject request, as the local log keeps it: counts, never a value or an Id. */
export type SubjectRequestEvent =
  | {
      kind: 'searched';
      at: ISODateString;
      /** The kinds of identifier searched for, not the identifiers. */
      searchedBy: SubjectIdentifierKind[];
      objects: Array<{ objectApiName: ApiName; found: number; truncated: boolean }>;
    }
  | { kind: 'exported'; at: ISODateString; records: number }
  | {
      kind: 'erased';
      at: ISODateString;
      mode: SubjectEraseMode;
      outcome: 'success' | 'partial' | 'failure' | 'stopped';
      /** The run's id in the audit trail. */
      operationId: string;
      objects: Array<{ objectApiName: ApiName; done: number; failed: number }>;
    };

/**
 * One subject request in the local log: when it was opened, on which org, and
 * what was found, exported and erased. No identifier, record Id, name or
 * value: the log is evidence the request was handled, not a copy of it.
 */
export interface SubjectRequestLogEntry {
  requestId: string;
  orgId: string;
  openedAt: ISODateString;
  events: SubjectRequestEvent[];
}

/** A cleanup recommendation: which records of an object it names. */
export type CleanupRecommendation =
  | { kind: 'stale'; days: number }
  | { kind: 'orphans'; fieldApiName: string }
  | { kind: 'duplicates'; keyField: string };

/** A lookup nearly every record fills, and the records that leave it empty. */
export interface CleanupOrphans {
  fieldApiName: string;
  label: string;
  /** The object the lookup points at. */
  referenceTo: ApiName;
  /** Records that fill it. */
  filled: number;
  /** Records that leave it empty: the orphans. */
  empty: number;
}

/** One object a cleanup scan read. */
export interface CleanupObjectScan {
  status: 'scanned';
  objectApiName: ApiName;
  label: string;
  totalRecords: number;
  /** Null when the object has no `LastModifiedDate` to filter on. */
  stale: DataQualityStaleness | null;
  /** Lookups the business relies on that some records leave empty. */
  orphans: CleanupOrphans[];
  /** Null when there was no key the org can group records by. */
  duplicates: DataQualityDuplicates | null;
  keyFields: Array<{ fieldApiName: string; label: string }>;
  errors: DataQualityCheckError[];
  /**
   * Whether the connected user may delete its records, as the describe says:
   * false, the page offers the export and holds Delete back, with the reason.
   * Absent from a scan that did not say, which offers Delete as before.
   */
  deletable?: boolean;
}

/** One object of a cleanup scan, read or not. */
export type CleanupObjectResult = CleanupObjectScan | DataQualityObjectFailure;

/**
 * What `dataops:cleanup:scan` answers: per object, the records nobody has
 * modified for `staleDays`, the orphans of each lookup the business relies
 * on, and the values of a key more than one record carries. Counts only.
 */
export interface CleanupScanResult {
  orgId: string;
  staleDays: number;
  scannedAt: ISODateString;
  /** Share of records that must fill a lookup for its empty ones to count as orphans. */
  orphanThreshold: number;
  bounds: DataQualityScanBounds;
  objects: CleanupObjectResult[];
}

/** Mass delete configuration */
export interface MassDeleteConfig {
  objectApiName: ApiName;
  query: string;
  hardDelete: boolean;
  batchSize: number;
  dryRun: boolean;
}

/** Storage optimization recommendation */
export interface StorageRecommendation {
  objectApiName: ApiName;
  currentRecords: number;
  currentSize: number;
  recommendation: 'archive' | 'delete' | 'compress' | 'optimize';
  estimatedSaving: number;
  reason: string;
}

// ─── Masking and backing up in slices ────────────────────────────────────────

/**
 * Where a set of slices stands: `open` while slices are left to take or to
 * mask, a run stopped part way included; `done` once every row it was for is
 * in a slice, masked or backed up; `abandoned` when the person gave it up,
 * its slices kept until they expire.
 */
export type SliceSetState = 'open' | 'done' | 'abandoned';

/**
 * Where one slice stands: `pending` before its snapshot, `masking` once its
 * snapshot holds it and its rows are written over, `masked` once each of its
 * rows was, `snapshotted` for a slice of a backup, which masks nothing, and
 * `restored` once a restore wrote its values back.
 */
export type SliceState = 'pending' | 'snapshotted' | 'masking' | 'masked' | 'restored';

/**
 * The codes a masking run, a backup or a restore in slices is refused or
 * stopped with: a set of the template left open on the org, which a new run
 * would write over; a slice deleted alone, whose set holds the way back;
 * more slices than a set holds; the disk short of what the slices take; the
 * run's key no longer the one its slices were masked with; an object the org
 * would not read a slice of, even halved; nothing open to give up; and a
 * host with no backup files, which slices are written to.
 */
export const SLICE_REFUSAL = {
  runOpen: 'SLICE_RUN_OPEN',
  deleteAlone: 'SLICE_DELETE_ALONE',
  tooMany: 'SLICES_EXCEEDED',
  diskShort: 'SLICE_DISK_SHORT',
  keyLost: 'SLICE_KEY_LOST',
  readTooHeavy: 'SLICE_READ_TOO_HEAVY',
  nothingToAbandon: 'NOTHING_TO_ABANDON',
  needsStore: 'SLICES_NEED_STORE',
} as const;

/** How a plan's requests sit against what the org has left today, as Forge's Review says it. */
export type SliceBudgetVerdict = 'fits' | 'near' | 'exceeds' | 'unread';

/** One object of a run in slices, as its plan cuts it. */
export interface SlicePlanObject {
  objectApiName: string;
  /** Rows a slice holds at most: the rows a snapshot holds of one object. */
  size: number;
  /** Slices the object's rows make, from its count. */
  slices: number;
  /** Set when the count is the org's approximate one (`/limits/recordCount`): the org gave up counting. */
  approximate?: true;
}

/**
 * What a run in slices would cost, said before it is asked: the requests it
 * sends against what the org has left today, the Bulk API batches it uses —
 * none, it writes over REST —, the disk its snapshots take, and how long it
 * takes.
 */
export interface SlicePlan {
  /** Requests the run sends, about. */
  requests: number;
  /** What of them reads the snapshots, writes the rows over, and reads anything else. */
  parts: { snapshots: number; updates: number; reads: number };
  /** Bulk API batches: always none. */
  bulkBatches: 0;
  /** Bytes the snapshots take on this machine, about. */
  diskBytes: number;
  /** Bytes free where the snapshots go; absent when the disk did not say. */
  diskFree?: number;
  /** Seconds the run takes, about. */
  seconds: number;
  /** The requests against what the org has left today. */
  apiBudget: {
    verdict: SliceBudgetVerdict;
    remaining?: number;
    max?: number;
    unread?: string;
  };
}

/** A set of slices left open on an org, as a coverage names it: what a resume carries on. */
export interface SliceSetOpen {
  setId: string;
  /** When it last moved. */
  savedAt: string;
  /** Slices masked of those it holds so far. */
  done: number;
  total: number;
  state: SliceSetState;
  /** Rows per slice. */
  size: number;
}

/** One slice as a run's result, a listing and a restore say it. */
export interface SliceSummary {
  index: number;
  objectApiName: string;
  snapshotId: string;
  /** Rows its snapshot holds. */
  rows: number;
  masked: number;
  refused: number;
  /** Rows of its snapshot deleted from the org since, which nothing masks or puts back. */
  deletedSince: number;
  nothingToMask: number;
  state: SliceState;
  /** Set on a slice of rows created during the run in a range already masked. */
  late?: true;
  /** Rows the slice was read with, when the org made it smaller than asked. */
  sizeUsed?: number;
  restoredAt?: string;
}

/** A set of slices of an org, as the backup listing gives it: one row whatever its slices. */
export interface BackupSetSummary {
  setId: string;
  orgId: string;
  kind: 'masking' | 'backup';
  state: SliceSetState;
  startedAt: string;
  lastActivityAt: string;
  /** Rows per slice. */
  size: number;
  totalRecords: number;
  /** The template a masking set was masked with. */
  templateId?: string;
  slices: SliceSummary[];
  /** Per object, the filter its rows were held to. */
  wheres?: Record<string, string>;
}

/** What a masking run, or a backup, in slices says of its set once it ends. */
export interface SliceSetResult {
  setId: string;
  size: number;
  state: SliceSetState;
  objects: Array<{ objectApiName: string; slices: SliceSummary[] }>;
  /** Rows created during the run in a range already masked, which no slice holds yet. */
  lateRecords: number;
  /** Requests the run sent. */
  requestsSpent: number;
  /** Set when the run stopped between two slices on its `maxRequests`, or on the org's day. */
  stoppedOnBudget?: true;
  /** Whether rows are left that no slice holds yet: the run stopped before its last slice. */
  slicesLeft: boolean;
}
