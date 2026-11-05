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
 * Kinds of gap whose `value` names a source record type, `ns__Retail` for a
 * package's: the id of one of a package's had its bare name there before.
 */
const RECORD_TYPE_VALUE_KINDS: ReadonlySet<string> = new Set<ForgeGapKind>([
  'record_type_unmapped',
]);

/**
 * A gap as the entries answering it are looked up by: its id, and its detail
 * where the read gave it ({@link sameDeveloperNameOf}), or its id alone.
 */
type GapLookedUp = string | Pick<ForgeGap, 'id' | 'detail'>;

/** The id of a gap looked up. */
function idOf(gap: GapLookedUp): string {
  return typeof gap === 'string' ? gap : gap.id;
}

/**
 * The other record types that carry the DeveloperName of the package's record
 * type a gap is of, in its org, by their names — `Retail`, the org's own,
 * beside `ns__Retail` — as the simulation that found the gap read them
 * (`detail.sameDeveloperName`): the target's for the record type rows go in
 * with, the source's for one unmapped. None when the read did not say.
 *
 * Where one does, a bare `Retail` names it there and not the package's, as
 * the run reads a bare name (`findRecordTypeByName`): an entry kept under the
 * bare name is not the package's gap's, whether or not the other has a gap of
 * its own in the same read.
 */
function sameDeveloperNameOf(gap: GapLookedUp): readonly string[] {
  if (typeof gap === 'string') return [];
  const names = gap.detail?.['sameDeveloperName'];
  return Array.isArray(names) ? names : [];
}

/**
 * The entry of `ignored` that says to leave the gap as it is, or undefined
 * when none does: its id, or the one it had before a package's record type
 * was named with its namespace. A template and a saved run keep the old one,
 * `…|Type|…` for `…|ns__Type|…`, and the decision taken was asked again.
 *
 * The old one answers only a gap it can be no other gap's of the same read
 * (`read`, the ids of the gaps it found): on a target with the org's own
 * Support and a package's ns__Support, ignoring the first wrote the id the
 * second had before its namespace, and the second, which nobody decided, read
 * "left as it is" and Execute no longer asked. Nor does it answer a gap whose
 * detail says the org's own, or another package's, carries its record type's
 * DeveloperName too ({@link sameDeveloperNameOf}): the org's own having no gap
 * in the read, the package's read decided all the same.
 *
 * @param gap - The gap, or its id where the read gave nothing else of it.
 */
export function ignoredGapEntry(
  ignored: Iterable<string> | undefined,
  gap: GapLookedUp,
  read: Iterable<string>,
): string | undefined {
  const entries = new Set(ignored ?? []);
  const id = idOf(gap);
  if (entries.has(id)) return id;
  const before = oldIdOfTheGap(gap, read);
  return before !== undefined && entries.has(before) ? before : undefined;
}

/** The id `id` had before its package's record type was named so, or undefined for no such id. */
function idBeforeNamespace(id: string): string | undefined {
  const parts = forgeGapParts(id);
  if (parts === null) return undefined;
  const kind = parts.kind as ForgeGapKind;
  const bareType = PACKAGED_NAME.exec(parts.recordType ?? '')?.[1];
  if (bareType !== undefined) {
    return forgeGapId(kind, parts.objectApiName, parts.field, bareType, parts.value);
  }
  const bareValue = RECORD_TYPE_VALUE_KINDS.has(kind)
    ? PACKAGED_NAME.exec(parts.value ?? '')?.[1]
    : undefined;
  if (bareValue === undefined) return undefined;
  return forgeGapId(kind, parts.objectApiName, parts.field, parts.recordType, bareValue);
}

/**
 * The id the gap had before its namespace, when an entry under it can be the
 * gap's alone: its detail names no other record type of its org carrying its
 * DeveloperName ({@link sameDeveloperNameOf}), and no other gap of `read` is
 * that id, as the org's own record type's is, nor had it before a namespace of
 * its own, as another package's of the same DeveloperName did.
 */
function oldIdOfTheGap(gap: GapLookedUp, read: Iterable<string>): string | undefined {
  const id = idOf(gap);
  const before = idBeforeNamespace(id);
  if (before === undefined || sameDeveloperNameOf(gap).length > 0) return undefined;
  for (const other of read) {
    if (other !== id && (other === before || idBeforeNamespace(other) === before)) {
      return undefined;
    }
  }
  return before;
}

/**
 * The entry of `skipped` that holds back the rows of the gap, or undefined
 * when none does: by its id, or the one it had before a package's record type
 * was named with its namespace, as {@link ignoredGapEntry} reads it — and
 * reads not an entry of another gap of the same read (`read`), nor one the run
 * applies to the org's own record type of the same name.
 *
 * @param gap - The gap, or its id where the read gave nothing else of it.
 */
export function skippedRowsEntry<T extends { gapId: string }>(
  skipped: readonly T[],
  gap: GapLookedUp,
  read: Iterable<string>,
): T | undefined {
  const exact = skipped.find((entry) => entry.gapId === idOf(gap));
  if (exact) return exact;
  const before = oldIdOfTheGap(gap, read);
  return before === undefined ? undefined : skipped.find((entry) => entry.gapId === before);
}

/**
 * Of the mappings of one value of one field, the one that answers `gap`, of
 * that value on one record type: for that record type; for it as it was named
 * before its package's namespace, when the run applies it to the gap's rows
 * (`holdsForRecordType`) — no other record type of the target carries the
 * name ({@link sameDeveloperNameOf}), nor is another gap of the same read
 * (`read`) of that value on one of that name; then for every record type.
 *
 * On a target with the org's own Support and a package's ns__Support, the
 * mapping taken on the first answered the second: the run writes it to the
 * org's own rows alone, and the package's went as read with nobody asked.
 */
export function picklistMappingEntry<T extends { recordType?: string }>(
  mappings: readonly T[],
  gap: Pick<ForgeGap, 'id' | 'recordType' | 'detail'>,
  read: Iterable<string>,
): T | undefined {
  const bare = bareRecordTypeOfTheGap(gap, read);
  return (
    mappings.find((mapping) => mapping.recordType === gap.recordType) ??
    (bare !== undefined ? mappings.find((mapping) => mapping.recordType === bare) : undefined) ??
    mappings.find((mapping) => mapping.recordType === undefined)
  );
}

/**
 * The name the package's record type of the gap had before its namespace,
 * when a mapping of its value under that name can be the gap's alone: the
 * gap's detail names no other record type of the target carrying it, and no
 * other gap of `read`, of whatever kind, is of the same value on the org's
 * own record type of that name, or on another package's.
 */
function bareRecordTypeOfTheGap(
  gap: Pick<ForgeGap, 'id' | 'detail'>,
  read: Iterable<string>,
): string | undefined {
  const parts = forgeGapParts(gap.id);
  const bare = PACKAGED_NAME.exec(parts?.recordType ?? '')?.[1];
  if (parts === null || bare === undefined || sameDeveloperNameOf(gap).length > 0) {
    return undefined;
  }
  for (const other of read) {
    const theirs = forgeGapParts(other);
    if (
      theirs === null ||
      theirs.recordType === parts.recordType ||
      theirs.objectApiName !== parts.objectApiName ||
      theirs.field !== parts.field ||
      theirs.value !== parts.value
    ) {
      continue;
    }
    const name = theirs.recordType ?? '';
    if (name === bare || PACKAGED_NAME.exec(name)?.[1] === bare) return undefined;
  }
  return bare;
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
 *
 * A rehearsal's refusal by a validation rule it names (`detail.rule`) is
 * matched the same way: a rehearsal takes no mute, and the rule refused a
 * row the run under the mute writes whole.
 */
export function gapLiftedBy(
  gap: Pick<ForgeGap, 'kind' | 'objectApiName' | 'detail'>,
  lifted: readonly MutedAutomationAlsoLifted[] | undefined,
): MutedAutomationAlsoLifted | undefined {
  const ofARule =
    gap.kind === 'validation_rule' ||
    (gap.kind === 'rehearsal_refusal' &&
      gap.detail?.['statusCode'] === 'FIELD_CUSTOM_VALIDATION_EXCEPTION');
  if (!ofARule || !lifted) return undefined;
  const rule = gap.detail?.['rule'];
  if (typeof rule !== 'string') return undefined;
  return lifted.find(
    (entry) =>
      entry.kind === 'validationRule' &&
      entry.name === rule &&
      entry.objectApiName.toLowerCase() === gap.objectApiName.toLowerCase(),
  );
}
