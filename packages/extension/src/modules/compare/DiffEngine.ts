import type {
  CompareContentCoverage,
  CompareItem,
  CompareSeverity,
  CompareSummary,
  DiffStatus,
  FieldDiff,
  MetadataComponentType,
  NotComparedReason,
} from '@sandforge/shared';

/**
 * Critical component types: taking one out of the target, or replacing what
 * the target holds, breaks what depends on it there.
 */
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
   *
   * A component both maps hold and `notCompared` names is `not_compared`,
   * whatever its two values: they are not its content, so they prove nothing.
   */
  diff(
    source: Map<string, string>,
    target: Map<string, string>,
    componentType: MetadataComponentType,
    notCompared: ReadonlyMap<string, NotComparedReason> = new Map(),
  ): CompareItem[] {
    const items: CompareItem[] = [];
    const allKeys = new Set([...source.keys(), ...target.keys()]);

    for (const key of allKeys) {
      const sourceValue = source.get(key);
      const targetValue = target.get(key);
      const reason = notCompared.get(key);

      if (sourceValue !== undefined && targetValue === undefined) {
        items.push(DiffEngine.createItem(componentType, key, 'removed', sourceValue, undefined));
      } else if (sourceValue === undefined && targetValue !== undefined) {
        items.push(DiffEngine.createItem(componentType, key, 'added', undefined, targetValue));
      } else if (reason !== undefined) {
        items.push({
          ...DiffEngine.createItem(componentType, key, 'not_compared', undefined, undefined),
          notComparedReason: reason,
        });
      } else if (sourceValue !== targetValue) {
        items.push(DiffEngine.createItem(componentType, key, 'modified', sourceValue, targetValue));
      } else {
        items.push(
          DiffEngine.createItem(componentType, key, 'unchanged', sourceValue, targetValue),
        );
      }
    }

    return items;
  }

  /**
   * Compare two flat objects field-by-field to produce field-level diffs.
   * Useful for comparing individual component properties.
   */
  diffFields(sourceObj: Record<string, string>, targetObj: Record<string, string>): FieldDiff[] {
    const diffs: FieldDiff[] = [];
    const allFields = new Set([...Object.keys(sourceObj), ...Object.keys(targetObj)]);

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
    let notCompared = 0;
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
        case 'not_compared':
          notCompared++;
          break;
      }

      if (DiffEngine.isChange(item.status)) {
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
      notCompared,
      byType,
    };
  }

  /**
   * What the items say was compared by content, and what was not and why,
   * beside the budget the reading kept within and, when the run left them out,
   * how many components a managed package installed.
   */
  computeCoverage(
    items: readonly CompareItem[],
    budget: CompareContentCoverage['budget'],
    managedLeftOut = 0,
  ): CompareContentCoverage {
    const notCompared: Record<NotComparedReason, number> = {
      unreadable: 0,
      read_failed: 0,
      over_budget: 0,
    };
    let compared = 0;
    for (const item of items) {
      if (item.status === 'modified' || item.status === 'unchanged') {
        compared++;
      } else if (item.status === 'not_compared' && item.notComparedReason !== undefined) {
        notCompared[item.notComparedReason]++;
      }
    }
    return {
      compared,
      notCompared,
      ...(managedLeftOut > 0 ? { managedLeftOut } : {}),
      budget: { ...budget },
    };
  }

  /** Whether a status is a difference between the orgs: not a match, nor a component left unread. */
  static isChange(status: DiffStatus): boolean {
    return status === 'added' || status === 'removed' || status === 'modified';
  }

  /**
   * Determine the severity of a diff based on status and component type.
   *
   * `removed` is a component only the source holds: a deployment creates it,
   * and nothing in the target depends on it yet. `added` is one only the
   * target holds, which taking out to match the source would lose. This read
   * them the other way round, and rated the component a deployment creates
   * as the breaking one.
   */
  static determineSeverity(
    status: DiffStatus,
    componentType: MetadataComponentType,
  ): CompareSeverity {
    if (!DiffEngine.isChange(status) || status === 'removed') {
      return 'info';
    }
    if (CRITICAL_TYPES.has(componentType)) {
      return 'breaking';
    }
    return 'warning';
  }

  /** Determine if a diff item is deployable: only a difference is. */
  static isDeployable(status: DiffStatus): boolean {
    return DiffEngine.isChange(status);
  }

  private static createItem(
    componentType: MetadataComponentType,
    fullName: string,
    status: DiffStatus,
    sourceValue: string | undefined,
    targetValue: string | undefined,
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
