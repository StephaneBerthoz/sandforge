/**
 * SchemaScanner — Scans source and target org schemas for the Autopilot module.
 * Discovers selected objects + their lookup dependencies recursively,
 * verifies target org compatibility, and counts source records.
 */

import type { ApiName } from '@sandforge/shared';
import { assertSoqlIdentifier } from '../../core/common/soqlValidator.js';
import { extractErrorMessage } from '../../core/common/extractErrorMessage.js';
import { excludedByDescribe, isNeverCopied } from '../forge/excludedObjects.js';
import { logger } from '../../logger.js';

/** Abstraction over Salesforce describe API for testability. */
export interface AutopilotConnection {
  /** Describe a single object by API name. */
  describe(objectName: string): Promise<ObjectDescribeResult>;
  /** Describe all objects available in the org. */
  describeGlobal(): Promise<GlobalDescribeResult>;
  /** Execute a SOQL query. */
  query(soql: string): Promise<QueryResult>;
  /**
   * The org's Tooling API, when the connection has one — a jsforce
   * connection does. The objects it serves are metadata, deployed rather
   * than copied as data.
   */
  tooling?: ToolingDescribe;
}

/** What the scan asks of the Tooling API: which objects it serves. */
export interface ToolingDescribe {
  describeGlobal(): Promise<{ sobjects: ReadonlyArray<{ name: string }> }>;
}

/** Subset of Salesforce global describe result. */
export interface GlobalDescribeResult {
  sobjects: GlobalSObjectDescribe[];
}

/** Metadata for a single SObject from global describe. */
export interface GlobalSObjectDescribe {
  name: string;
  label: string;
  custom: boolean;
  queryable: boolean;
  createable: boolean;
  deletable: boolean;
  updateable: boolean;
}

/** Full describe result for a single object. */
export interface ObjectDescribeResult {
  name: string;
  label: string;
  custom: boolean;
  keyPrefix: string | null;
  fields: FieldDescribeResult[];
  recordTypeInfos: RecordTypeInfo[];
}

/** Describe metadata for a single field. */
export interface FieldDescribeResult {
  name: string;
  label: string;
  type: string;
  nillable: boolean;
  createable: boolean;
  updateable: boolean;
  unique: boolean;
  externalId: boolean;
  referenceTo: string[];
  relationshipName: string | null;
  length?: number;
  precision?: number;
  scale?: number;
  defaultValue: unknown;
  picklistValues?: Array<{ value: string; active: boolean; label: string }>;
}

/** Record type information. */
export interface RecordTypeInfo {
  recordTypeId: string;
  name: string;
  active: boolean;
  defaultRecordTypeMapping: boolean;
}

/** SOQL query result. */
export interface QueryResult {
  totalSize: number;
  done: boolean;
  records: Record<string, unknown>[];
}

/** Result of scanning both source and target orgs. */
export interface SchemaScanResult {
  /** Describe results for all selected objects + auto-discovered dependencies. */
  objectDescribes: Map<ApiName, ObjectDescribeResult>;
  /** Objects that were auto-discovered as dependencies. */
  autoDiscoveredObjects: ApiName[];
  /** Objects that exist in source but not in target. */
  missingInTarget: ApiName[];
  /** Record counts per object (source org). */
  recordCounts: Map<ApiName, number>;
  /** Total objects scanned. */
  totalObjectsScanned: number;
}

/**
 * Scans source and target org schemas for the Autopilot module.
 * Discovers all selected objects + their lookup dependencies recursively.
 * Checks target org compatibility and counts records.
 */
export class SchemaScanner {
  private readonly maxConcurrent: number;

  /**
   * @param maxConcurrent - Maximum number of parallel describe calls.
   */
  constructor(maxConcurrent: number = 10) {
    this.maxConcurrent = maxConcurrent;
  }

  /**
   * Scan schemas on source and target orgs.
   *
   * 1. If selectedObjects is empty, auto-detect all queryable+creatable custom objects.
   * 2. Recursively discover lookup dependencies.
   * 3. Verify objects exist on target org.
   * 4. Count records on source org.
   *
   * @param sourceConn - Connection to the source org.
   * @param targetConn - Connection to the target org.
   * @param selectedObjects - Objects explicitly selected by the user (empty = auto-detect).
   * @param includeStandardObjects - Whether to include standard objects in auto-detection.
   * @returns Schema scan result with describes, dependencies, and record counts.
   */
  async scan(
    sourceConn: AutopilotConnection,
    targetConn: AutopilotConnection,
    selectedObjects: ApiName[],
    includeStandardObjects: boolean,
  ): Promise<SchemaScanResult> {
    // Step 1: Determine which objects to scan
    let rootObjects: ApiName[];
    if (selectedObjects.length === 0) {
      const globalResult = await sourceConn.describeGlobal();
      rootObjects = globalResult.sobjects
        .filter((s) => s.queryable && s.createable)
        /*
         * `createable` is the platform's answer to "can the API create one",
         * and for `User` it is yes — at the cost of a licence and a globally
         * unique username. A run put 39 of them in its first wave and called
         * insert on each. `RecordType`, `Profile` and the sharing groups are
         * metadata, deployed rather than inserted. None of them can be copied,
         * and a node that fails in wave one leaves every later wave remapping
         * foreign keys onto records that were never created.
         */
        .filter((s) => includeStandardObjects || s.custom)
        .map((s) => s.name);
    } else {
      rootObjects = [...selectedObjects];
    }

    /*
     * What the target itself says no copy writes: the objects its Tooling API
     * serves, which are metadata, and those its data API will not create.
     * Read before the walk, because the walk is where they came in: from a
     * product to the external data source it may name, to that source's auth
     * provider and the Apex class behind it, and from a location's logo into
     * the Content objects — a real run copied those whole tables.
     */
    const targetGlobal = await targetConn.describeGlobal();
    const described = excludedByDescribe(
      targetGlobal.sobjects,
      await this.toolingObjects(targetConn),
    );
    const leftOut = (name: ApiName): boolean => isNeverCopied(name, described);

    /*
     * Applied to a selection as well as to a discovery, because the rule is
     * about what a copy can do and not about how the name got into the list.
     * A saved configuration, a template, or a picker written before this
     * existed can all carry one, and filtering only the discovered half would
     * have left the run that started this — 39 `User` records in wave one —
     * reachable from a saved config.
     *
     * `createable` is the platform's answer to "can the API create one", and
     * for `User` it is yes: at the cost of a licence and a globally unique
     * username. `RecordType`, `Profile` and the sharing groups are metadata,
     * deployed rather than inserted. A node that fails in wave one leaves every
     * later wave remapping foreign keys onto records that were never created.
     */
    rootObjects = rootObjects.filter((name) => !leftOut(name));

    // Step 2: Describe all root objects on source
    const objectDescribes = await this.describeAll(sourceConn, rootObjects);

    // Step 3: Recursively discover lookup dependencies
    const autoDiscoveredObjects: ApiName[] = [];
    const visited = new Set<ApiName>(objectDescribes.keys());
    let newReferences = this.findNewReferences(objectDescribes, visited, leftOut);

    while (newReferences.length > 0) {
      const newDescribes = await this.describeAll(sourceConn, newReferences);
      for (const [name, desc] of newDescribes) {
        objectDescribes.set(name, desc);
        autoDiscoveredObjects.push(name);
        visited.add(name);
      }
      newReferences = this.findNewReferences(objectDescribes, visited, leftOut);
    }

    // Step 4: Verify objects exist on target org
    const targetObjectNames = new Set(targetGlobal.sobjects.map((s) => s.name));
    const missingInTarget = [...objectDescribes.keys()].filter(
      (name) => !targetObjectNames.has(name),
    );

    // Step 5: Count records on source org
    const recordCounts = await this.countRecords(sourceConn, [...objectDescribes.keys()]);

    return {
      objectDescribes,
      autoDiscoveredObjects,
      missingInTarget,
      recordCounts,
      totalObjectsScanned: objectDescribes.size,
    };
  }

  /**
   * The objects the org's Tooling API serves, or none when it cannot say —
   * a connection without one, or a user the org does not let read it. The
   * data API's own answer, and the list of objects every copy leaves out,
   * still apply.
   */
  private async toolingObjects(conn: AutopilotConnection): Promise<string[]> {
    if (!conn.tooling) return [];
    try {
      const answer = await conn.tooling.describeGlobal();
      return answer.sobjects.map((sobject) => sobject.name);
    } catch (err) {
      logger.warn('Autopilot could not ask the Tooling API which objects are metadata', {
        error: extractErrorMessage(err),
      });
      return [];
    }
  }

  /**
   * Find referenced objects that have not yet been described.
   *
   * @param describes - Already-described objects.
   * @param visited - Set of already-visited object names.
   * @param leftOut - Whether the copy leaves an object out.
   * @returns Array of new object names to describe.
   */
  private findNewReferences(
    describes: Map<ApiName, ObjectDescribeResult>,
    visited: Set<ApiName>,
    leftOut: (name: ApiName) => boolean,
  ): ApiName[] {
    const newRefs = new Set<ApiName>();
    for (const desc of describes.values()) {
      for (const ref of this.extractReferences(desc)) {
        // The same rule as the roots, and for the same reason: an object a
        // copy cannot create is no more copyable for having been reached
        // through a lookup than for having been asked for. Filtering only the
        // entrance let the whole set back in through the walk —
        // `Account.OwnerId` reaches `User`, `User.ProfileId` reaches
        // `Profile`, and a plan asked for two objects came back with twenty,
        // `UserLicense` first among them. The second list refuses what a copy
        // has no business walking into at all — history, feeds, shares, a
        // managed package's catalogue — which is how an `OpportunityHistory`
        // reached a plan and the platform answered "entity type cannot be
        // inserted". The third is the org's own: its metadata, and what its
        // data API will not create.
        if (leftOut(ref)) continue;
        if (!visited.has(ref)) {
          newRefs.add(ref);
        }
      }
    }
    return [...newRefs];
  }

  /**
   * Describe objects in parallel batches, respecting maxConcurrent.
   *
   * @param conn - Salesforce connection to use.
   * @param objectNames - Object API names to describe.
   * @returns Map of object name to describe result.
   */
  private async describeAll(
    conn: AutopilotConnection,
    objectNames: ApiName[],
  ): Promise<Map<ApiName, ObjectDescribeResult>> {
    const results = new Map<ApiName, ObjectDescribeResult>();
    const chunks = this.chunk(objectNames, this.maxConcurrent);

    for (const batch of chunks) {
      const settled = await Promise.allSettled(batch.map((name) => conn.describe(name)));
      for (const result of settled) {
        if (result.status === 'fulfilled') {
          results.set(result.value.name, result.value);
        }
      }
    }

    return results;
  }

  /**
   * Extract referenced object names from a describe result's fields.
   *
   * @param describe - Object describe result to extract references from.
   * @returns Array of referenced object API names.
   */
  private extractReferences(describe: ObjectDescribeResult): ApiName[] {
    return describe.fields.filter((f) => f.referenceTo.length > 0).flatMap((f) => f.referenceTo);
  }

  /**
   * Count records for each object via COUNT() SOQL queries.
   *
   * @param conn - Salesforce connection to use.
   * @param objectNames - Object API names to count.
   * @returns Map of object name to record count.
   */
  private async countRecords(
    conn: AutopilotConnection,
    objectNames: ApiName[],
  ): Promise<Map<ApiName, number>> {
    const counts = new Map<ApiName, number>();
    const chunks = this.chunk(objectNames, this.maxConcurrent);

    for (const batch of chunks) {
      const settled = await Promise.allSettled(
        batch.map(async (name) => {
          const result = await conn.query(`SELECT COUNT() FROM ${assertSoqlIdentifier(name)}`);
          return { name, count: result.totalSize };
        }),
      );
      for (const result of settled) {
        if (result.status === 'fulfilled') {
          counts.set(result.value.name, result.value.count);
        }
      }
    }

    return counts;
  }

  /**
   * Split an array into chunks of the given size.
   *
   * @param arr - Array to split.
   * @param size - Maximum chunk size.
   * @returns Array of chunks.
   */
  private chunk<T>(arr: T[], size: number): T[][] {
    const result: T[][] = [];
    for (let i = 0; i < arr.length; i += size) {
      result.push(arr.slice(i, i + size));
    }
    return result;
  }
}
