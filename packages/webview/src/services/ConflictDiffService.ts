import diff from 'microdiff';

/**
 * Represents a single field-level difference between two record snapshots.
 */
export interface ConflictFieldDiff {
  /** The field API name that differs */
  field: string;
  /** Value in the source record */
  sourceValue: unknown;
  /** Value in the target record */
  targetValue: unknown;
  /** Value in the base record (populated in 3-way diffs) */
  baseValue?: unknown;
  /** Type of change detected */
  type: 'changed' | 'added' | 'removed';
}

/**
 * Result of a three-way diff operation.
 */
export interface ThreeWayDiffResult {
  /** Fields that were automatically resolved (no overlap) */
  autoResolved: Record<string, unknown>;
  /** Fields where both source and target diverged from base */
  conflicts: ConflictFieldDiff[];
}

/**
 * Provides structured field-level diffing for Salesforce records.
 * Uses microdiff under the hood for efficient change detection.
 * All methods are static -- the service is stateless.
 */
export class ConflictDiffService {
  /**
   * Compare two flat records and return one ConflictFieldDiff per differing top-level field.
   * Salesforce records are flat key-value objects, so nested paths from microdiff
   * are collapsed to top-level field names only.
   *
   * @param source - The source record values
   * @param target - The target record values
   * @returns An array of ConflictFieldDiff entries for every field that differs
   */
  static diffFields(
    source: Record<string, unknown>,
    target: Record<string, unknown>,
  ): ConflictFieldDiff[] {
    const changes = diff(source, target);
    const seen = new Set<string>();
    const result: ConflictFieldDiff[] = [];

    for (const change of changes) {
      const field = String(change.path[0]);
      if (seen.has(field)) {
        continue;
      }
      seen.add(field);

      const sourceValue = source[field];
      const targetValue = target[field];

      let type: ConflictFieldDiff['type'];
      if (change.type === 'CREATE') {
        type = 'added';
      } else if (change.type === 'REMOVE') {
        type = 'removed';
      } else {
        type = 'changed';
      }

      result.push({ field, sourceValue, targetValue, type });
    }

    return result;
  }

  /**
   * Perform a three-way diff using a common base record.
   * Fields changed only in source or only in target are auto-resolved.
   * Fields changed in both source and target (relative to base) are conflicts.
   *
   * @param base - The common ancestor record
   * @param source - The source (local) record
   * @param target - The target (remote) record
   * @returns An object with auto-resolved values and remaining conflicts
   */
  static diffThreeWay(
    base: Record<string, unknown>,
    source: Record<string, unknown>,
    target: Record<string, unknown>,
  ): ThreeWayDiffResult {
    const sourceChanges = new Map<string, unknown>();
    const targetChanges = new Map<string, unknown>();

    for (const change of diff(base, source)) {
      const field = String(change.path[0]);
      if (!sourceChanges.has(field)) {
        sourceChanges.set(field, source[field]);
      }
    }

    for (const change of diff(base, target)) {
      const field = String(change.path[0]);
      if (!targetChanges.has(field)) {
        targetChanges.set(field, target[field]);
      }
    }

    const autoResolved: Record<string, unknown> = {};
    const conflicts: ConflictFieldDiff[] = [];

    // Fields changed only in source
    for (const [field, value] of sourceChanges) {
      if (!targetChanges.has(field)) {
        autoResolved[field] = value;
      }
    }

    // Fields changed only in target
    for (const [field, value] of targetChanges) {
      if (!sourceChanges.has(field)) {
        autoResolved[field] = value;
      }
    }

    // Fields changed in both -- check if same value
    for (const [field, sourceValue] of sourceChanges) {
      if (!targetChanges.has(field)) {
        continue;
      }
      const targetValue = targetChanges.get(field);
      if (JSON.stringify(sourceValue) === JSON.stringify(targetValue)) {
        // Both sides made the same change -- auto-resolve
        autoResolved[field] = sourceValue;
      } else {
        conflicts.push({
          field,
          sourceValue,
          targetValue,
          baseValue: base[field],
          type: 'changed',
        });
      }
    }

    return { autoResolved, conflicts };
  }
}
