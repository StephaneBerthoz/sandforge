/** Record type information from a Salesforce org */
export interface RecordTypeInfo {
  id: string;
  name: string;
  developerName: string;
}

/** Mapping between source and target record type IDs */
export interface RecordTypeMapping {
  sourceId: string;
  targetId: string;
  developerName: string;
}

/**
 * Maps record types between source and target Salesforce orgs.
 * Record type IDs differ between orgs, so this service builds a mapping
 * based on developerName (which is consistent) and applies it to records.
 */
export class RecordTypeMapper {
  /**
   * Build a mapping between source and target record types.
   * Matches by developerName, which is consistent across orgs.
   * Only includes types that exist in both source and target.
   */
  buildMapping(sourceTypes: RecordTypeInfo[], targetTypes: RecordTypeInfo[]): RecordTypeMapping[] {
    const targetByDevName = new Map<string, RecordTypeInfo>();
    for (const t of targetTypes) {
      targetByDevName.set(t.developerName, t);
    }

    const mappings: RecordTypeMapping[] = [];

    for (const source of sourceTypes) {
      const target = targetByDevName.get(source.developerName);
      if (target) {
        mappings.push({
          sourceId: source.id,
          targetId: target.id,
          developerName: source.developerName,
        });
      }
    }

    return mappings;
  }

  /**
   * Apply record type mappings to a set of records.
   * Replaces RecordTypeId values with the corresponding target org ID.
   * Records with unmapped RecordTypeId values are left unchanged.
   */
  apply(
    records: Record<string, unknown>[],
    mappings: RecordTypeMapping[],
  ): Record<string, unknown>[] {
    const mappingBySourceId = new Map<string, string>();
    for (const m of mappings) {
      mappingBySourceId.set(m.sourceId, m.targetId);
    }

    return records.map((record) => {
      const recordTypeId = record.RecordTypeId;
      if (typeof recordTypeId !== 'string') {
        return { ...record };
      }

      const targetId = mappingBySourceId.get(recordTypeId);
      if (!targetId) {
        return { ...record };
      }

      return {
        ...record,
        RecordTypeId: targetId,
      };
    });
  }
}
