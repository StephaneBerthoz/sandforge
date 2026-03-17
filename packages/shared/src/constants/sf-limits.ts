/** Salesforce API and governor limits */
export const SF_LIMITS = {
  /** Maximum records per REST API call */
  REST_API_BATCH_SIZE: 200,
  /** Maximum records per Composite API subrequest */
  COMPOSITE_BATCH_SIZE: 25,
  /** Maximum subrequests in a single Composite API call */
  COMPOSITE_MAX_SUBREQUESTS: 25,
  /** Maximum records per Bulk API 2.0 job */
  BULK_API_MAX_RECORDS: 150_000_000,
  /** Maximum concurrent Bulk API 2.0 jobs */
  BULK_API_MAX_CONCURRENT_JOBS: 100,
  /** Maximum size of a single Bulk API batch (10MB) */
  BULK_API_MAX_BATCH_SIZE_BYTES: 10 * 1024 * 1024,
  /** Maximum daily API calls (varies by edition, this is Enterprise default) */
  DAILY_API_CALLS_ENTERPRISE: 100_000,
  /** Maximum SOQL query length */
  SOQL_MAX_LENGTH: 100_000,
  /** Maximum records returned by a SOQL query */
  SOQL_MAX_RECORDS: 50_000,
  /** Maximum WHERE clause IN values */
  SOQL_MAX_IN_VALUES: 4000,
  /** Maximum fields per object */
  MAX_FIELDS_PER_OBJECT: 800,
  /** Maximum relationship depth in SOQL */
  MAX_RELATIONSHIP_DEPTH: 5,
  /** Maximum offset for SOQL OFFSET */
  SOQL_MAX_OFFSET: 2000,
  /** Data storage per record (KB, approximate) */
  AVG_RECORD_SIZE_KB: 2,
  /** Maximum records in Composite Graph API */
  COMPOSITE_GRAPH_MAX_NODES: 500,
  /** Default API version */
  DEFAULT_API_VERSION: '62.0',
} as const;

export type SfLimitKey = keyof typeof SF_LIMITS;

/** Current Salesforce REST API version used for direct API calls (with `v` prefix). */
export const SF_API_VERSION = `v${SF_LIMITS.DEFAULT_API_VERSION}` as const;
