/**
 * Clone types for the Clone backend pipeline.
 * Used to clone records from a source org to a target org with
 * relationship-ordered insertion and ID remapping.
 */

/**
 * Configuration for a single object to clone.
 * Specifies the object API name and an optional SOQL WHERE filter.
 */
export interface CloneObjectConfig {
  /** Salesforce object API name (e.g. "Account", "Contact") */
  objectApiName: string;
  /** Optional SOQL WHERE clause to filter source records */
  whereClause?: string;
}

/**
 * Full clone configuration specifying source org, target org,
 * and the list of objects to clone.
 */
export interface CloneConfig {
  /** Source org ID to clone records from */
  sourceOrgId: string;
  /** Target org ID to clone records into */
  targetOrgId: string;
  /** Objects to clone with optional filters */
  objects: CloneObjectConfig[];
}

/**
 * Result for a single cloned object, including counts and ID mappings.
 */
export interface CloneObjectResult {
  /** Salesforce object API name */
  objectApiName: string;
  /** Number of records found in source org */
  sourceCount: number;
  /** Number of records successfully inserted in target org */
  insertedCount: number;
  /** Number of records that failed to insert */
  failedCount: number;
  /** Mapping of source record IDs to target record IDs */
  idMappings: Array<{ sourceId: string; targetId: string }>;
  /** Errors encountered during insertion */
  errors: Array<{ sourceId: string; message: string }>;
}

/**
 * Overall result of a clone execution across all objects.
 */
export interface CloneExecutionResult {
  /** Overall status: success if all inserted, partial if some failed, failure if none inserted */
  status: 'success' | 'partial' | 'failure';
  /** Per-object results */
  objectResults: CloneObjectResult[];
  /** Total records found in source org */
  totalSourceRecords: number;
  /** Total records successfully inserted in target org */
  totalInserted: number;
  /** Total records that failed to insert */
  totalFailed: number;
  /** Total duration in milliseconds */
  durationMs: number;
}

/**
 * Preview result before executing a clone.
 * Shows record counts, sample data, relationships, and planned insert order.
 */
export interface ClonePreviewResult {
  /** Per-object preview information */
  objects: Array<{
    /** Salesforce object API name */
    objectApiName: string;
    /** Number of records matching the filter */
    recordCount: number;
    /** Sample records from the source org */
    sampleRecords: Record<string, unknown>[];
    /** Lookup relationships to other objects in the clone set */
    relationships: Array<{ field: string; referenceTo: string }>;
  }>;
  /** Topologically sorted insert order */
  insertOrder: string[];
}
