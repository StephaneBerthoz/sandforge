import type {
  UUID,
  ISODateString,
  ApiName,
  ComplianceFrameworkType,
  BaseAnonymizationRule,
} from './common.types.js';

/** Backup status */
export type BackupStatus = 'pending' | 'running' | 'completed' | 'failed' | 'expired';

/** Data quality rule type */
export type DataQualityRuleType =
  | 'completeness'
  | 'uniqueness'
  | 'format'
  | 'range'
  | 'referential'
  | 'consistency'
  | 'freshness';

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

/** Data quality scan result */
export interface DataQualityScanResult {
  orgId: UUID;
  objectApiName: ApiName;
  totalRecords: number;
  score: number;
  rules: DataQualityRuleResult[];
  timestamp: ISODateString;
}

/** Per-rule quality scan result */
export interface DataQualityRuleResult {
  ruleType: DataQualityRuleType;
  fieldApiName: string;
  passed: number;
  failed: number;
  passRate: number;
  sampleFailures: string[];
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
