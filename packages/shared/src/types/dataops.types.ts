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
  hashAlgorithm?: 'sha256' | 'md5';
  hashSalt?: string;
  fakerMethod?: string;
  fakerLocale?: string;
  constantValue?: string;
  preserveLength?: boolean;
}

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
