import type { ForgeGap, ForgeGapKind, ForgeGapSeverity } from '../types/forge.types.js';

/**
 * The id of a gap, the same however often the target is read: the Gaps tab
 * keeps the user's decisions by it, and a template keeps the gaps the user
 * chose to ignore by it. Built from what the gap is about, never from what a
 * read happened to count.
 */
export function forgeGapId(
  kind: ForgeGapKind,
  objectApiName: string,
  field?: string,
  recordType?: string,
  value?: string,
): string {
  return [kind, objectApiName, field ?? '', recordType ?? '', value ?? ''].join('|');
}

/** What a gap's id says it is about, read back from it: see {@link forgeGapId}. */
export interface ForgeGapParts {
  kind: string;
  objectApiName: string;
  field?: string;
  recordType?: string;
  value?: string;
}

/**
 * What `id` says its gap is about, or null for a text no gap id is. The kind,
 * the object, the field and the record type are API names, which never hold a
 * `|`: whatever follows the fourth is the value, `|` and all.
 */
export function forgeGapParts(id: string): ForgeGapParts | null {
  const parts = id.split('|');
  if (parts.length < 5 || parts[0] === '' || parts[1] === '') return null;
  const [kind, objectApiName, field, recordType, ...rest] = parts;
  const value = rest.join('|');
  return {
    kind,
    objectApiName,
    ...(field !== '' ? { field } : {}),
    ...(recordType !== '' ? { recordType } : {}),
    ...(value !== '' ? { value } : {}),
  };
}

const SEVERITY_RANK: Readonly<Record<ForgeGapSeverity, number>> = {
  info: 0,
  warning: 1,
  blocking: 2,
};

/**
 * Every gap once, whichever reads found it. The same gap read from metadata,
 * found by a simulation and confirmed by a rehearsal is one line: it keeps the
 * gravest severity and the most rows any read gave it, the source that gave
 * that severity, and the decisions of every read.
 */
export function mergeGaps(...lists: ReadonlyArray<readonly ForgeGap[]>): ForgeGap[] {
  const byId = new Map<string, ForgeGap>();
  for (const gap of lists.flat()) {
    const seen = byId.get(gap.id);
    if (!seen) {
      byId.set(gap.id, { ...gap, decisions: [...gap.decisions] });
      continue;
    }
    const graver = SEVERITY_RANK[gap.severity] > SEVERITY_RANK[seen.severity];
    byId.set(gap.id, {
      ...seen,
      ...(graver ? { severity: gap.severity, source: gap.source } : {}),
      rows: Math.max(seen.rows, gap.rows),
      detail: { ...gap.detail, ...seen.detail },
      decisions: [...new Set([...seen.decisions, ...gap.decisions])],
    });
  }
  return [...byId.values()].sort(
    (a, b) =>
      SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] ||
      a.objectApiName.localeCompare(b.objectApiName) ||
      a.id.localeCompare(b.id),
  );
}
