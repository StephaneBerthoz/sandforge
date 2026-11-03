import type { ForgeGap, ForgeGapKind, ForgeGapSeverity } from '../types/forge.types.js';
import type { MutedAutomationAlsoLifted } from './automation-mute.js';

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

/** A record type of a package, `ns__Type`: a developer name holds no two underscores in a row. */
const PACKAGED_NAME = /^[A-Za-z][A-Za-z0-9]*__(.+)$/;

/**
 * The entry of `ignored` that says to leave the gap `id` as it is, or undefined
 * when none does: the id itself, or the one it had before a package's record
 * type was named with its namespace. A template and a saved run keep the old
 * one, `…|Type|…` for `…|ns__Type|…`, and the decision taken was asked again.
 */
export function ignoredGapEntry(
  ignored: Iterable<string> | undefined,
  id: string,
): string | undefined {
  const entries = new Set(ignored ?? []);
  if (entries.has(id)) return id;
  const before = idBeforeNamespace(id);
  return before !== undefined && entries.has(before) ? before : undefined;
}

/** The id `id` had before its package's record type was named so, or undefined for no such id. */
function idBeforeNamespace(id: string): string | undefined {
  const parts = forgeGapParts(id);
  const bare = PACKAGED_NAME.exec(parts?.recordType ?? '')?.[1];
  if (parts === null || bare === undefined) return undefined;
  return forgeGapId(
    parts.kind as ForgeGapKind,
    parts.objectApiName,
    parts.field,
    bare,
    parts.value,
  );
}

/**
 * The entry of `skipped` that holds back the rows of the gap `id`, or undefined
 * when none does: by the id, or the one it had before a package's record type
 * was named with its namespace, as {@link ignoredGapEntry} reads it. The run
 * holds those rows back (`holdsForRecordType`): Review and the command said
 * the gap undecided.
 */
export function skippedRowsEntry<T extends { gapId: string }>(
  skipped: readonly T[],
  id: string,
): T | undefined {
  const before = idBeforeNamespace(id);
  return (
    skipped.find((entry) => entry.gapId === id) ?? skipped.find((entry) => entry.gapId === before)
  );
}

/**
 * Of the mappings of one value of one field, the one that answers a gap of
 * `recordType`: for that record type; for it as it was named before its
 * package's namespace, as the run applies it (`holdsForRecordType`); then for
 * every record type.
 */
export function picklistMappingEntry<T extends { recordType?: string }>(
  mappings: readonly T[],
  recordType: string | undefined,
): T | undefined {
  const bare = PACKAGED_NAME.exec(recordType ?? '')?.[1];
  return (
    mappings.find((mapping) => mapping.recordType === recordType) ??
    (bare !== undefined ? mappings.find((mapping) => mapping.recordType === bare) : undefined) ??
    mappings.find((mapping) => mapping.recordType === undefined)
  );
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

/**
 * What would keep a validation rule from refusing a row, as a gap's
 * `detail.assign` holds it: a custom permission the rule excludes and the
 * user the run writes as does not hold, and the permission sets of the target
 * that include it, the smallest first; none when no permission set a user can
 * be assigned holds it, and an admin creates one.
 */
export interface ForgeGapAssignment {
  /** The custom permission, as `$Permission.<name>` names it. */
  permission: string;
  /** The smallest permission set that includes it; absent when none does. */
  permissionSet?: { name: string };
  /** The other permission sets that include it, the smallest first. */
  others: Array<{ name: string }>;
}

/**
 * One entry of a gap's `detail.assign`: `<permission>=<set>,<set>…`, the
 * smallest set first, nothing after `=` when no set holds it. A gap's detail
 * holds texts and lists of texts only, so that the detail of every read of
 * the same gap merges into one ({@link mergeGaps}); an API name never holds
 * `=` or `,`.
 */
export function gapAssignEntry(grant: {
  permission: string;
  permissionSets: ReadonlyArray<{ name: string }>;
}): string {
  return `${grant.permission}=${grant.permissionSets.map((set) => set.name).join(',')}`;
}

/**
 * The assignments a gap's `detail.assign` holds ({@link gapAssignEntry}), in
 * its order; none when it holds none.
 */
export function gapAssignments(gap: Pick<ForgeGap, 'detail'>): ForgeGapAssignment[] {
  const entries = gap.detail?.['assign'];
  if (!Array.isArray(entries)) return [];
  return entries.flatMap((entry) => {
    const at = entry.indexOf('=');
    if (at <= 0) return [];
    const [smallest, ...others] = entry
      .slice(at + 1)
      .split(',')
      .filter((name) => name !== '')
      .map((name) => ({ name }));
    return [
      {
        permission: entry.slice(0, at),
        ...(smallest ? { permissionSet: smallest } : {}),
        others,
      },
    ];
  });
}

/**
 * What a run's mute lifts of the validation rule `gap` is, if anything: the
 * entry of the mute's plan (`MutePlan.alsoLifts`) that names the rule on its
 * object. A rule it lifts refuses no row of the run, whose rows go in whole
 * rather than again without the rule's field: the clone's lines and Review's
 * Gaps tab say it lifted from this one match. On the trap org, the lines said
 * the rule's rows would go again without Email while the mute let them
 * through whole, and the panel said nothing of it.
 */
export function gapLiftedBy(
  gap: Pick<ForgeGap, 'kind' | 'objectApiName' | 'detail'>,
  lifted: readonly MutedAutomationAlsoLifted[] | undefined,
): MutedAutomationAlsoLifted | undefined {
  if (gap.kind !== 'validation_rule' || !lifted) return undefined;
  const rule = gap.detail?.['rule'];
  if (typeof rule !== 'string') return undefined;
  return lifted.find(
    (entry) =>
      entry.kind === 'validationRule' &&
      entry.name === rule &&
      entry.objectApiName.toLowerCase() === gap.objectApiName.toLowerCase(),
  );
}
