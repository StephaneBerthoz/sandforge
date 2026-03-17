/** Unique identifier string (UUID v4) */
export type UUID = string;

/** ISO 8601 date string */
export type ISODateString = string;

/** Salesforce 15 or 18 character ID */
export type SalesforceId = string;

/** Salesforce API name (e.g., 'Account', 'Custom__c') */
export type ApiName = string;

/** Result of any operation */
export interface OperationResult<T = unknown> {
  success: boolean;
  data?: T;
  error?: OperationError;
  warnings: string[];
  duration: number;
  timestamp: ISODateString;
}

/** Structured error */
export interface OperationError {
  code: string;
  message: string;
  details?: Record<string, unknown>;
  retryable: boolean;
  category: ErrorCategory;
}

/** Error categories for classification */
export type ErrorCategory =
  | 'auth'
  | 'permission'
  | 'schema'
  | 'data'
  | 'validation'
  | 'limit'
  | 'network'
  | 'trigger'
  | 'reference'
  | 'unknown';

/** Pagination */
export interface PaginatedResult<T> {
  items: T[];
  totalCount: number;
  hasMore: boolean;
  nextCursor?: string;
}

/** Key-value pair */
export interface KeyValue<V = string> {
  key: string;
  value: V;
}

/** Date range */
export interface DateRange {
  start: ISODateString;
  end: ISODateString;
}

/** Supported compliance frameworks */
export type ComplianceFrameworkType = 'gdpr' | 'ccpa' | 'hipaa' | 'pci_dss' | 'custom' | 'none';

/** Anonymization methods available across all modules */
export type AnonymizationMethod =
  | 'fake'
  | 'mask'
  | 'hash'
  | 'nullify'
  | 'redact'
  | 'shuffle'
  | 'truncate'
  | 'preserve_format'
  | 'age_band'
  | 'generalize'
  | 'constant';

/** Base anonymization rule shared by all modules */
export interface BaseAnonymizationRule {
  /** Object containing the field */
  readonly objectApiName: ApiName;
  /** Field to anonymize */
  readonly fieldApiName: string;
  /** Anonymization method to apply */
  readonly method: AnonymizationMethod;
}

/** Base execution status shared across all module execution flows */
export type BaseExecutionStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

/** Base interface for graph nodes representing Salesforce objects */
export interface BaseGraphNode {
  /** Salesforce object API name */
  readonly objectApiName: ApiName;
  /** Number of records */
  recordCount: number;
  /** Topological level in the dependency graph */
  level: number;
}

/** Base interface for graph edges representing relationships between objects */
export interface BaseGraphEdge {
  /** Source object API name */
  readonly sourceObject: ApiName;
  /** Target object API name */
  readonly targetObject: ApiName;
  /** Relationship type */
  readonly type: string;
}
