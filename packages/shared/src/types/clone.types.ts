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
  /**
   * Records the target refused because it already holds them, and named: the
   * clone links the children to that record and never writes to it. Neither
   * inserted nor failed. Optional for results produced before it existed.
   */
  linkedCount?: number;
  /**
   * Records found and never sent: the platform writes them itself and refuses
   * one from a copy — a tracked change — or they cannot go in without one it
   * does. Neither inserted nor failed. Optional for results produced before it
   * existed.
   */
  leftToThePlatform?: number;
  /**
   * Fields the clone read and left out of every record because the target's
   * describe of the object does not have them: sent, the org refuses the whole
   * record. Absent when there are none.
   */
  fieldsNotInTarget?: string[];
  /** Mapping of source record IDs to target record IDs, linked records included */
  idMappings: Array<{ sourceId: string; targetId: string }>;
  /** Errors encountered during insertion */
  errors: Array<{ sourceId: string; message: string }>;
}

/**
 * A lookup of the clone's objects: the field of `objectApiName` that points at
 * a record of `referenceTo`.
 */
export interface CloneLookup {
  /** The object whose records carry the lookup. */
  objectApiName: string;
  /** The lookup field's API name. */
  field: string;
  /** The object the lookup points at. */
  referenceTo: string;
}

/**
 * What a clone's second pass did: the lookups it wrote empty at insert —
 * one of a cycle, whose record went in before the one it names, or one at a
 * record of the same object — and filled once the record they name was in.
 */
export interface CloneSecondPass {
  /** Lookups the insert left empty for the second pass to fill. */
  owed: number;
  /** Of those, the ones it filled. */
  filled: number;
  /**
   * Up to three of the others, each with why: the record it names was never
   * cloned, or the target refused the update.
   */
  samples: Array<{ record: string; messages: string[] }>;
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
  /** Total records linked to one the target already held. Optional for older results. */
  totalLinked?: number;
  /** Total records left to the platform, never sent. Optional for older results. */
  totalLeftToThePlatform?: number;
  /** Total records that failed to insert */
  totalFailed: number;
  /**
   * The lookups written empty and filled after the insert. Absent when the
   * clone left none for a second pass.
   */
  secondPass?: CloneSecondPass;
  /** Total duration in milliseconds */
  durationMs: number;
  /**
   * Set when a cancel stopped the clone before it had written every object.
   * The objects listed are the ones it reached; its status is never `success`.
   */
  cancelled?: boolean;
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
    /** Number of records matching the filter that the clone will send */
    recordCount: number;
    /**
     * Records matching the filter the clone will leave to the platform, never
     * sending them: the platform writes them itself — a tracked change — or
     * they cannot go in without one it does. Counted in neither `recordCount`
     * nor the samples. Absent when there are none.
     */
    leftToThePlatform?: number;
    /** Sample records from the source org, of those the clone will send */
    sampleRecords: Record<string, unknown>[];
    /** Lookup relationships to other objects in the clone set */
    relationships: Array<{ field: string; referenceTo: string }>;
  }>;
  /** Topologically sorted insert order */
  insertOrder: string[];
  /**
   * The lookups the clone writes empty and fills in a second pass once the
   * record they point at is in the target: one of a cycle, whose record goes
   * in before the one it names, and one at a record of its own object, which
   * the insert writing both cannot fill. Absent when there are none.
   */
  filledAfterInsert?: CloneLookup[];
}
