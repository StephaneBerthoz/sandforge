/** Input for the diff computation */
export interface DiffInput {
  source: Array<Record<string, unknown>>;
  target: Array<Record<string, unknown>>;
  keyField: string;
}

/** Field-level change detail */
export interface FieldChange {
  key: string;
  changes: Record<string, { old: unknown; new: unknown }>;
}

/** Result of comparing source and target datasets */
export interface DiffResult {
  added: Array<Record<string, unknown>>;
  removed: Array<Record<string, unknown>>;
  modified: FieldChange[];
  unchanged: number;
}

/**
 * Compare two datasets by a key field and produce a diff
 * identifying added, removed, modified, and unchanged records.
 */
export function computeDiff(input: DiffInput): DiffResult {
  const { source, target, keyField } = input;

  const sourceMap = buildKeyMap(source, keyField);
  const targetMap = buildKeyMap(target, keyField);

  const added: Array<Record<string, unknown>> = [];
  const removed: Array<Record<string, unknown>> = [];
  const modified: FieldChange[] = [];
  let unchanged = 0;

  for (const [key, targetRecord] of targetMap) {
    const sourceRecord = sourceMap.get(key);
    if (!sourceRecord) {
      added.push(targetRecord);
      continue;
    }

    const changes = computeFieldChanges(sourceRecord, targetRecord, keyField);
    if (Object.keys(changes).length > 0) {
      modified.push({ key, changes });
    } else {
      unchanged++;
    }
  }

  for (const [key, sourceRecord] of sourceMap) {
    if (!targetMap.has(key)) {
      removed.push(sourceRecord);
    }
  }

  return { added, removed, modified, unchanged };
}

function buildKeyMap(
  records: Array<Record<string, unknown>>,
  keyField: string,
): Map<string, Record<string, unknown>> {
  const map = new Map<string, Record<string, unknown>>();
  for (const record of records) {
    const key = String(record[keyField] ?? '');
    map.set(key, record);
  }
  return map;
}

function computeFieldChanges(
  source: Record<string, unknown>,
  target: Record<string, unknown>,
  keyField: string,
): Record<string, { old: unknown; new: unknown }> {
  const changes: Record<string, { old: unknown; new: unknown }> = {};
  const allFields = new Set([...Object.keys(source), ...Object.keys(target)]);

  for (const field of allFields) {
    if (field === keyField) continue;

    const oldVal = source[field];
    const newVal = target[field];

    if (!isEqual(oldVal, newVal)) {
      changes[field] = { old: oldVal, new: newVal };
    }
  }

  return changes;
}

function isEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (a === undefined || b === undefined) return false;
  if (typeof a !== typeof b) return false;

  if (typeof a === 'object' && typeof b === 'object') {
    return JSON.stringify(a) === JSON.stringify(b);
  }

  return false;
}
