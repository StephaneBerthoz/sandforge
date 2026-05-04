import type { SeedObjectConfig } from '@sandforge/shared';

/**
 * Links reference fields between seed objects and resolves
 * topological insert order based on reference dependencies.
 */
export class ReferenceLinker {
  /**
   * Assign random IDs from availableIds to the referenceField
   * on each record, linking child records to parent records.
   */
  link(
    records: Record<string, unknown>[],
    referenceField: string,
    _targetObject: string,
    availableIds: string[],
  ): Record<string, unknown>[] {
    if (availableIds.length === 0) {
      return records;
    }

    return records.map((record) => ({
      ...record,
      [referenceField]: availableIds[Math.floor(Math.random() * availableIds.length)],
    }));
  }

  /**
   * Topologically sort objects by their reference dependencies.
   * Objects that are depended upon are placed before their dependents.
   * Throws if a circular dependency is detected.
   */
  resolveInsertOrder(objects: SeedObjectConfig[]): SeedObjectConfig[] {
    const objectMap = new Map<string, SeedObjectConfig>();
    for (const obj of objects) {
      objectMap.set(obj.objectApiName, obj);
    }

    const visited = new Set<string>();
    const visiting = new Set<string>();
    const sorted: SeedObjectConfig[] = [];

    function visit(name: string): void {
      if (visited.has(name)) {
        return;
      }
      if (visiting.has(name)) {
        throw new Error(`Circular dependency detected involving: ${name}`);
      }

      visiting.add(name);

      const obj = objectMap.get(name);
      if (obj) {
        const deps = extractDependencies(obj);
        for (const dep of deps) {
          visit(dep);
        }
        sorted.push(obj);
      }

      visiting.delete(name);
      visited.add(name);
    }

    for (const obj of objects) {
      visit(obj.objectApiName);
    }

    return sorted;
  }
}

/** Extract reference dependency object names from an object config */
function extractDependencies(obj: SeedObjectConfig): string[] {
  const deps = new Set<string>();
  for (const rule of obj.fieldRules) {
    if (rule.ruleType === 'reference' && rule.config.referenceObject) {
      deps.add(rule.config.referenceObject);
    }
  }
  return Array.from(deps);
}
