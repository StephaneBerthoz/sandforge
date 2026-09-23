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
   * @returns Object with stats: remapped, missing, skipped, and the lookups cleared
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
    const unresolved: UnresolvedLookup[] = [];

    for (const [index, record] of records.entries()) {
      // A polymorphic lookup carries one edge per possible parent — `WhatId`
      // has one for Account and one for Opportunity — and only one of them
      // can match. Clearing on the first miss would wipe the value the other
      // edge had just resolved, so the decision waits until every edge of the
      // field has been tried.
      const resolvedFields = new Set<string>();
      const unresolvedFields = new Map<string, { sourceId: string; parents: ApiName[] }>();

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
          resolvedFields.add(edge.fieldApiName);
          remapped++;
        } else {
          const known = unresolvedFields.get(edge.fieldApiName);
          if (known) known.parents.push(edge.from);
          else unresolvedFields.set(edge.fieldApiName, { sourceId, parents: [edge.from] });
          missing++;
        }
      }

      // Left in place, a source id is written into the target org where it
      // means nothing: Salesforce answers `insufficient access rights on
      // cross-reference id` and the whole record is lost over one field.
      // Cleared, the record lands with the lookup empty — which is what Forge
      // does with an unresolvable foreign key, and what a wave of mutually
      // referencing objects makes unavoidable: `Account` and `Contact`
      // reference each other, so they share a wave, so one of them is written
      // before the other exists.
      //
      // The id it held is handed back with the field: a parent written after
      // this record — later in its cycle, or further down the same object —
      // has a target id by the end of the wave, and the lookup is filled then.
      for (const [fieldApiName, { sourceId, parents }] of unresolvedFields) {
        if (resolvedFields.has(fieldApiName)) continue;
        record[fieldApiName] = null;
        unresolved.push({ index, fieldApiName, sourceId, parents });
      }
    }

    return { remapped, missing, skipped, unresolved };
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

/** A lookup cleared because the record it points at had no target id yet. */
export interface UnresolvedLookup {
  /** Position of the record in the records remapped. */
  index: number;
  /** The lookup, now empty. */
  fieldApiName: string;
  /** The source id it held. */
  sourceId: string;
  /** Every object it may point at, one per edge of the field. */
  parents: ApiName[];
}

/** Result of a remap operation */
export interface RemapResult {
  /** Number of fields successfully remapped */
  remapped: number;
  /** Number of required fields with missing target ID */
  missing: number;
  /** Number of null/empty fields skipped */
  skipped: number;
  /** The lookups cleared, with the id each held. */
  unresolved: UnresolvedLookup[];
}
