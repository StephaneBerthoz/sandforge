/**
 * SchemaScanner — Scans source and target org schemas for the Autopilot module.
 * Discovers selected objects + their lookup dependencies recursively,
 * verifies target org compatibility, and counts source records.
 */

import type { ApiName } from '@sandforge/shared';
import { assertSoqlIdentifier } from '../../core/common/soqlValidator.js';

/** Abstraction over Salesforce describe API for testability. */
export interface AutopilotConnection {
  /** Describe a single object by API name. */
  describe(objectName: string): Promise<ObjectDescribeResult>;
  /** Describe all objects available in the org. */
  describeGlobal(): Promise<GlobalDescribeResult>;
  /** Execute a SOQL query. */
  query(soql: string): Promise<QueryResult>;
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
        .filter((s) => includeStandardObjects || s.custom)
        .map((s) => s.name);
    } else {
      rootObjects = [...selectedObjects];
    }

    // Step 2: Describe all root objects on source
    const objectDescribes = await this.describeAll(sourceConn, rootObjects);

    // Step 3: Recursively discover lookup dependencies
    const autoDiscoveredObjects: ApiName[] = [];
    const visited = new Set<ApiName>(objectDescribes.keys());
    let newReferences = this.findNewReferences(objectDescribes, visited);

    while (newReferences.length > 0) {
      const newDescribes = await this.describeAll(sourceConn, newReferences);
      for (const [name, desc] of newDescribes) {
        objectDescribes.set(name, desc);
        autoDiscoveredObjects.push(name);
        visited.add(name);
      }
      newReferences = this.findNewReferences(objectDescribes, visited);
    }

    // Step 4: Verify objects exist on target org
    const targetGlobal = await targetConn.describeGlobal();
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
   * Find referenced objects that have not yet been described.
   *
   * @param describes - Already-described objects.
   * @param visited - Set of already-visited object names.
   * @returns Array of new object names to describe.
   */
  private findNewReferences(
    describes: Map<ApiName, ObjectDescribeResult>,
    visited: Set<ApiName>,
  ): ApiName[] {
    const newRefs = new Set<ApiName>();
    for (const desc of describes.values()) {
      for (const ref of this.extractReferences(desc)) {
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
