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

/**
 * How the currency rows were written in was chosen, their own being one the
 * target does not hold active: `record-type-default`, the default the record
 * type they go in with gives the currency field; `corporate`, the target's
 * corporate currency; `decision`, the value the user mapped theirs to;
 * `parent`, the currency of the record they belong to — an opportunity's
 * products take their opportunity's — which went in another currency;
 * `lines`, for prices, the currency of the records their lines belong to,
 * which the platform refuses a line's price to differ from.
 */
export type CurrencyChosenBy =
  'record-type-default' | 'corporate' | 'decision' | 'parent' | 'lines';

/**
 * Rows of one object written in another currency than the one they were read
 * in, and what became of their amounts: converted at the source's rates, or
 * written as read when no rate converts one currency into the other.
 */
export interface CurrencyReplaced {
  /** API name of the object. */
  objectApiName: ApiName;
  /** The currency the rows were read in. */
  from: string;
  /** The currency they were written in. */
  to: string;
  /** How `to` was chosen. */
  chosenBy: CurrencyChosenBy;
  /** How many rows. */
  rows: number;
  /** The currency fields whose amounts were converted, sorted; empty when no row held one. */
  fields: string[];
  /**
   * Set when the amounts were written as read: the source holds no rate for
   * `from`, or neither org a rate between their corporate currencies.
   */
  notConverted?: true;
  /**
   * Set when `to` is not the target's corporate currency: the amounts went
   * into it at the target's rate, after the source's rate of `from` gave
   * their worth in the corporate currency.
   */
  atTargetRate?: true;
  /**
   * The field whose date chose the rates, when an org converts the object at
   * dated rates (advanced currency management) and they converted the
   * amounts: `CloseDate`. Absent, the rates of `CurrencyType` did.
   */
  datedBy?: string;
  /**
   * The field whose date an org converts the object on at dated rates, when
   * either org could not say whether it has advanced currency management on —
   * its currency settings could not be read, and the user may not create
   * dated rates — or its dated rates could not be read: the rates of
   * `CurrencyType` converted the amounts, which may not be the ones it
   * applies.
   */
  datedUnconfirmed?: string;
}

/**
 * How prices read in one currency went, where they were wanted in another: a
 * book prices a product once per currency, and the platform refuses a line
 * whose price is in another currency than its record.
 *
 * - `replaced`: by the source's own price of the same product, price book and
 *   selling model in `to`, which is written; they are linked to its copy.
 * - `converted`: the source holds no such price, and they are written in `to`
 *   themselves, at their amount converted.
 * - `none`: neither — they go in another currency for other lines, and the
 *   target refuses the lines of a record in `to`.
 */
export interface PriceCurrencySettled {
  /** The currency the prices were read in. */
  from: string;
  /** The currency they were wanted in. */
  to: string;
  how: 'replaced' | 'converted' | 'none';
  /**
   * Whether `to` is the currency of the records their lines belong to, rather
   * than the one they would go in alone: the target does not hold `from`
   * active, and `to` is its corporate currency or the one `from` is mapped to.
   */
  forLines: boolean;
  /** How many prices. */
  prices: number;
}
