import type { AutopilotEdge, ApiName } from '@sandforge/shared';

/**
 * Maps source record IDs to target record IDs after insertion.
 * Used to remap lookup fields in dependent objects before their insertion.
 */
export class RecordIdRemapper {
  /** Map of objectApiName -> Map of sourceId -> targetId */
  private readonly idMaps = new Map<ApiName, Map<string, string>>();

  /**
   * Register a batch of ID mappings for an object.
   * Called after successfully inserting records on the target org.
   * @param objectApiName The object whose records were inserted
   * @param mappings Array of [sourceId, targetId] pairs
   */
  registerMappings(objectApiName: ApiName, mappings: Array<[string, string]>): void {
    let objectMap = this.idMaps.get(objectApiName);
    if (!objectMap) {
      objectMap = new Map<string, string>();
      this.idMaps.set(objectApiName, objectMap);
    }
    for (const [sourceId, targetId] of mappings) {
      objectMap.set(sourceId, targetId);
    }
  }

  /**
   * Remap lookup fields in a batch of records based on registered ID mappings.
   * Records are mutated in place.
   * @param records Records to remap (mutated in place)
   * @param edges Edges describing which fields are lookups to which objects
   * @param objectApiName The object being remapped (child object with lookup fields)
   * @returns Object with stats: remapped, missing, skipped
   */
  remapRecords(
    records: Record<string, unknown>[],
    edges: readonly AutopilotEdge[],
    objectApiName: ApiName,
  ): RemapResult {
    const relevantEdges = edges.filter((e) => e.to === objectApiName);

    let remapped = 0;
    let missing = 0;
    let skipped = 0;

    for (const record of records) {
      for (const edge of relevantEdges) {
        const sourceId = record[edge.fieldApiName];

        if (sourceId === null || sourceId === undefined || sourceId === '') {
          skipped++;
          continue;
        }

        if (typeof sourceId !== 'string') {
          skipped++;
          continue;
        }

        const parentMap = this.idMaps.get(edge.from);
        const targetId = parentMap?.get(sourceId);

        if (targetId !== undefined) {
          record[edge.fieldApiName] = targetId;
          remapped++;
        } else {
          missing++;
        }
      }
    }

    return { remapped, missing, skipped };
  }

  /**
   * Get the target ID for a source ID on a specific object.
   * @param objectApiName The object API name
   * @param sourceId The source record ID
   * @returns The target record ID, or undefined if not found
   */
  getTargetId(objectApiName: ApiName, sourceId: string): string | undefined {
    return this.idMaps.get(objectApiName)?.get(sourceId);
  }

  /**
   * Check if mappings exist for an object.
   * @param objectApiName The object API name
   * @returns True if mappings exist for this object
   */
  hasObject(objectApiName: ApiName): boolean {
    return this.idMaps.has(objectApiName);
  }

  /**
   * Get count of mappings for an object.
   * @param objectApiName The object API name
   * @returns Number of mappings registered for this object
   */
  getMappingCount(objectApiName: ApiName): number {
    return this.idMaps.get(objectApiName)?.size ?? 0;
  }

  /** Get total mappings across all objects */
  get totalMappings(): number {
    let total = 0;
    for (const m of this.idMaps.values()) {
      total += m.size;
    }
    return total;
  }

  /** Clear all mappings */
  clear(): void {
    this.idMaps.clear();
  }
}

/** Result of a remap operation */
export interface RemapResult {
  /** Number of fields successfully remapped */
  remapped: number;
  /** Number of required fields with missing target ID */
  missing: number;
  /** Number of null/empty fields skipped */
  skipped: number;
}
