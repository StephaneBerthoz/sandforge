import type { ConflictRecord, ConflictStrategy } from '@sandforge/shared';

/** A record after conflict resolution with chosen values */
export interface ResolvedRecord {
  recordId: string;
  resolvedValues: Record<string, unknown>;
  strategy: ConflictStrategy;
}

/**
 * Detects and resolves conflicts between source and target records.
 * Supports multiple conflict resolution strategies: source_wins, target_wins,
 * newest_wins, manual, and merge.
 */
export class ConflictResolver {
  /**
   * Resolve a list of conflicts using the specified strategy.
   * Returns resolved records with the chosen values for each conflict.
   */
  resolve(
    conflicts: ConflictRecord[],
    strategy: ConflictStrategy
  ): ResolvedRecord[] {
    return conflicts.map((conflict) => resolveConflict(conflict, strategy));
  }

  /**
   * Detect conflicts between source and target records by matching on a field.
   * A conflict exists when the same record (matched by matchField) has
   * differing values in source and target.
   */
  detectConflicts(
    source: Record<string, unknown>[],
    target: Record<string, unknown>[],
    matchField: string
  ): ConflictRecord[] {
    const targetMap = new Map<string, Record<string, unknown>>();
    for (const record of target) {
      const key = String(record[matchField] ?? '');
      if (key) {
        targetMap.set(key, record);
      }
    }

    const conflicts: ConflictRecord[] = [];

    for (const sourceRecord of source) {
      const key = String(sourceRecord[matchField] ?? '');
      if (!key) {
        continue;
      }

      const targetRecord = targetMap.get(key);
      if (!targetRecord) {
        continue;
      }

      const conflictFields = findConflictFields(sourceRecord, targetRecord, matchField);
      if (conflictFields.length > 0) {
        conflicts.push({
          objectApiName: '',
          recordId: key,
          sourceValues: extractValues(sourceRecord, conflictFields),
          targetValues: extractValues(targetRecord, conflictFields),
          conflictFields,
        });
      }
    }

    return conflicts;
  }
}

/**
 * Resolve a single conflict using the specified strategy.
 */
function resolveConflict(
  conflict: ConflictRecord,
  strategy: ConflictStrategy
): ResolvedRecord {
  const effectiveStrategy = conflict.resolution ?? strategy;

  switch (effectiveStrategy) {
    case 'source_wins':
      return {
        recordId: conflict.recordId,
        resolvedValues: { ...conflict.sourceValues },
        strategy: effectiveStrategy,
      };

    case 'target_wins':
      return {
        recordId: conflict.recordId,
        resolvedValues: { ...conflict.targetValues },
        strategy: effectiveStrategy,
      };

    case 'newest_wins':
      return resolveByNewest(conflict, effectiveStrategy);

    case 'merge':
      return resolveMerge(conflict, effectiveStrategy);

    case 'manual':
      return {
        recordId: conflict.recordId,
        resolvedValues: { ...conflict.sourceValues },
        strategy: effectiveStrategy,
      };
  }
}

/**
 * Resolve by choosing whichever side has the newest LastModifiedDate.
 * Falls back to source if dates are unavailable or equal.
 */
function resolveByNewest(
  conflict: ConflictRecord,
  strategy: ConflictStrategy
): ResolvedRecord {
  const sourceDate = parseDate(conflict.sourceValues.LastModifiedDate);
  const targetDate = parseDate(conflict.targetValues.LastModifiedDate);

  if (sourceDate && targetDate && targetDate > sourceDate) {
    return {
      recordId: conflict.recordId,
      resolvedValues: { ...conflict.targetValues },
      strategy,
    };
  }

  return {
    recordId: conflict.recordId,
    resolvedValues: { ...conflict.sourceValues },
    strategy,
  };
}

/**
 * Merge strategy: source values for conflicting fields, target values for non-conflicting.
 * Non-null source values take precedence over null target values.
 */
function resolveMerge(
  conflict: ConflictRecord,
  strategy: ConflictStrategy
): ResolvedRecord {
  const merged: Record<string, unknown> = { ...conflict.targetValues };

  for (const field of conflict.conflictFields) {
    const sourceVal = conflict.sourceValues[field];
    if (sourceVal !== null && sourceVal !== undefined) {
      merged[field] = sourceVal;
    }
  }

  return {
    recordId: conflict.recordId,
    resolvedValues: merged,
    strategy,
  };
}

/**
 * Parse a value as a Date, returning null if invalid.
 */
function parseDate(value: unknown): Date | null {
  if (!value) {
    return null;
  }
  const date = new Date(String(value));
  return isNaN(date.getTime()) ? null : date;
}

/**
 * Find fields that differ between source and target records.
 * Excludes the match field itself.
 */
function findConflictFields(
  source: Record<string, unknown>,
  target: Record<string, unknown>,
  matchField: string
): string[] {
  const allFields = new Set([...Object.keys(source), ...Object.keys(target)]);
  const conflicts: string[] = [];

  for (const field of allFields) {
    if (field === matchField) {
      continue;
    }

    const sourceVal = source[field];
    const targetVal = target[field];

    if (!valuesEqual(sourceVal, targetVal)) {
      conflicts.push(field);
    }
  }

  return conflicts;
}

/**
 * Check if two values are equal using JSON serialization for deep comparison.
 */
function valuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true;
  }
  if (a === null || a === undefined) {
    return b === null || b === undefined;
  }
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Extract a subset of fields from a record.
 */
function extractValues(
  record: Record<string, unknown>,
  fields: string[]
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const field of fields) {
    result[field] = record[field];
  }
  return result;
}
