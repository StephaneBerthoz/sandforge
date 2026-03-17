import type {
  CompareItem,
  CompareSeverity,
  CompareSummary,
  DiffStatus,
  FieldDiff,
  MetadataComponentType,
} from '@sandforge/shared';

/** Critical component types whose removal or modification is breaking */
const CRITICAL_TYPES: ReadonlySet<MetadataComponentType> = new Set([
  'ApexClass',
  'ApexTrigger',
  'Flow',
  'ValidationRule',
  'CustomObject',
  'CustomField',
]);

/**
 * Core diffing engine that compares two maps of component content
 * and produces structured CompareItem results with severity assessment.
 */
export class DiffEngine {
  /**
   * Compare source and target component maps to produce a list of diffs.
   * Each key represents a component fullName, and the value is its serialized content.
   */
  diff(
    source: Map<string, string>,
    target: Map<string, string>,
    componentType: MetadataComponentType
  ): CompareItem[] {
    const items: CompareItem[] = [];
    const allKeys = new Set([...source.keys(), ...target.keys()]);

    for (const key of allKeys) {
      const sourceValue = source.get(key);
      const targetValue = target.get(key);

      if (sourceValue !== undefined && targetValue === undefined) {
        items.push(
          DiffEngine.createItem(componentType, key, 'removed', sourceValue, undefined)
        );
      } else if (sourceValue === undefined && targetValue !== undefined) {
        items.push(
          DiffEngine.createItem(componentType, key, 'added', undefined, targetValue)
        );
      } else if (sourceValue !== targetValue) {
        items.push(
          DiffEngine.createItem(componentType, key, 'modified', sourceValue, targetValue)
        );
      } else {
        items.push(
          DiffEngine.createItem(componentType, key, 'unchanged', sourceValue, targetValue)
        );
      }
    }

    return items;
  }

  /**
   * Compare two flat objects field-by-field to produce field-level diffs.
   * Useful for comparing individual component properties.
   */
  diffFields(
    sourceObj: Record<string, string>,
    targetObj: Record<string, string>
  ): FieldDiff[] {
    const diffs: FieldDiff[] = [];
    const allFields = new Set([
      ...Object.keys(sourceObj),
      ...Object.keys(targetObj),
    ]);

    for (const fieldPath of allFields) {
      const sourceValue = sourceObj[fieldPath] ?? '';
      const targetValue = targetObj[fieldPath] ?? '';

      if (!(fieldPath in sourceObj)) {
        diffs.push({ fieldPath, sourceValue: '', targetValue, status: 'added' });
      } else if (!(fieldPath in targetObj)) {
        diffs.push({ fieldPath, sourceValue, targetValue: '', status: 'removed' });
      } else if (sourceValue !== targetValue) {
        diffs.push({ fieldPath, sourceValue, targetValue, status: 'modified' });
      }
    }

    return diffs;
  }

  /** Compute a summary from a list of CompareItems */
  computeSummary(items: CompareItem[]): CompareSummary {
    let added = 0;
    let removed = 0;
    let modified = 0;
    let unchanged = 0;
    const byType: Record<string, { added: number; removed: number; modified: number }> = {};

    for (const item of items) {
      switch (item.status) {
        case 'added':
          added++;
          break;
        case 'removed':
          removed++;
          break;
        case 'modified':
          modified++;
          break;
        case 'unchanged':
          unchanged++;
          break;
      }

      if (item.status !== 'unchanged') {
        if (!byType[item.componentType]) {
          byType[item.componentType] = { added: 0, removed: 0, modified: 0 };
        }
        const typeEntry = byType[item.componentType];
        if (item.status === 'added') {
          typeEntry.added++;
        } else if (item.status === 'removed') {
          typeEntry.removed++;
        } else if (item.status === 'modified') {
          typeEntry.modified++;
        }
      }
    }

    return {
      totalItems: items.length,
      added,
      removed,
      modified,
      unchanged,
      byType,
    };
  }

  /** Determine the severity of a diff based on status and component type */
  static determineSeverity(
    status: DiffStatus,
    componentType: MetadataComponentType
  ): CompareSeverity {
    if (status === 'unchanged' || status === 'added') {
      return 'info';
    }
    if (CRITICAL_TYPES.has(componentType)) {
      return 'breaking';
    }
    return 'warning';
  }

  /** Determine if a diff item is deployable */
  static isDeployable(status: DiffStatus): boolean {
    return status !== 'unchanged';
  }

  private static createItem(
    componentType: MetadataComponentType,
    fullName: string,
    status: DiffStatus,
    sourceValue: string | undefined,
    targetValue: string | undefined
  ): CompareItem {
    return {
      componentType,
      fullName,
      status,
      sourceValue,
      targetValue,
      severity: DiffEngine.determineSeverity(status, componentType),
      deployable: DiffEngine.isDeployable(status),
    };
  }
}
