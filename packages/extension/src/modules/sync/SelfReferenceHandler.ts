/**
 * Handles self-referencing fields (e.g., ParentId on Account) during sync.
 * Provides topological sorting so parent records are inserted before children,
 * and ID remapping to update self-reference fields with new target IDs.
 */
export class SelfReferenceHandler {
  /**
   * Sort records so that parent records appear before their children.
   * Uses topological ordering based on the self-referencing field.
   * Records with no parent reference come first.
   */
  sortForInsert(
    records: Record<string, unknown>[],
    selfRefField: string,
  ): Record<string, unknown>[] {
    const idField = 'Id';
    const recordById = new Map<string, Record<string, unknown>>();
    const childrenOf = new Map<string, string[]>();
    const roots: string[] = [];

    for (const record of records) {
      const id = String(record[idField] ?? '');
      if (!id) {
        continue;
      }
      recordById.set(id, record);

      const parentId = record[selfRefField];
      if (!parentId || typeof parentId !== 'string') {
        roots.push(id);
      } else {
        const children = childrenOf.get(parentId) ?? [];
        children.push(id);
        childrenOf.set(parentId, children);
      }
    }

    const sorted: Record<string, unknown>[] = [];
    const visited = new Set<string>();

    function visit(id: string): void {
      if (visited.has(id)) {
        return;
      }
      visited.add(id);

      const record = recordById.get(id);
      if (record) {
        sorted.push(record);
      }

      const children = childrenOf.get(id) ?? [];
      for (const childId of children) {
        visit(childId);
      }
    }

    for (const rootId of roots) {
      visit(rootId);
    }

    for (const record of records) {
      const id = String(record[idField] ?? '');
      if (id && !visited.has(id)) {
        visited.add(id);
        sorted.push(record);
      }
    }

    return sorted;
  }

  /**
   * Remap self-reference field values using an old-to-new ID mapping.
   * After inserting records in the target org, the source IDs are replaced
   * with their corresponding target IDs.
   */
  remapIds(
    records: Record<string, unknown>[],
    selfRefField: string,
    idMap: Map<string, string>,
  ): Record<string, unknown>[] {
    return records.map((record) => {
      const parentId = record[selfRefField];
      if (typeof parentId !== 'string') {
        return { ...record };
      }

      const newId = idMap.get(parentId);
      if (!newId) {
        return { ...record };
      }

      return {
        ...record,
        [selfRefField]: newId,
      };
    });
  }
}
