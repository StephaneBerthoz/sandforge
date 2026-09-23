import type { SeedRelation } from '@sandforge/shared';
import { SEED_RELATION_LIMITS, plannedChildCount } from '@sandforge/shared';
import type { SeedRelationDraft, SeedRelationDraftPatch } from '../../stores/useSeedWizardStore';
import type { ObjectFieldConfig } from './Step3_ConfigureFields';

/** Records an object is seeded with when its count was never set, as the run reads it. */
export const DEFAULT_RECORD_COUNT = 100;

/** Records already in the org a new relation reads, until told otherwise. */
export const DEFAULT_PARENT_LIMIT = 10;

/** Per-object volumes, as the wizard keeps them. */
export type SeedVolumes = Record<string, { count: number; batchSize: number }>;

/** A lookup of a selected object that a relation can fill. */
export interface RelationLookup {
  childObject: string;
  lookupField: string;
  /** The field's label, as the org describes it. */
  label: string;
  /** The objects the lookup may point at; more than one for a polymorphic lookup. */
  parents: string[];
}

/** Why a relation row cannot be sent as it stands. */
export type RelationProblem =
  | 'incomplete'
  | 'duplicate'
  | 'generatedParent'
  | 'numbers'
  | 'noChildren';

/** A relation row checked against the rest of the wizard. */
export interface CheckedRelation {
  /** The relation to send; null while the row has a problem. */
  relation: SeedRelation | null;
  /** The parents the plan counts on: the parent object's records, or the bound on the org's. */
  parents: number;
  /** The most children the relation writes: the child's record count. */
  children: number;
  problem: RelationProblem | null;
}

/** The records the run plans for an object whose count no relation decides. */
export function recordCountOf(volumes: SeedVolumes, objectApiName: string): number {
  return volumes[objectApiName]?.count ?? DEFAULT_RECORD_COUNT;
}

/**
 * The lookups of the selected objects, in selection then field order. A field
 * is a lookup when the org says what it points at, whatever rule it carries
 * now.
 */
export function relationLookups(
  fieldConfigs: readonly ObjectFieldConfig[],
  selectedObjects: readonly string[],
): RelationLookup[] {
  const lookups: RelationLookup[] = [];
  for (const childObject of selectedObjects) {
    const config = fieldConfigs.find((c) => c.objectApiName === childObject);
    for (const field of config?.fields ?? []) {
      const described = field.referenceTo ?? [];
      const ruled = field.config['referenceObject'];
      const parents =
        described.length > 0 ? described : typeof ruled === 'string' && ruled ? [ruled] : [];
      if (parents.length === 0) continue;
      lookups.push({ childObject, lookupField: field.fieldApiName, label: field.label, parents });
    }
  }
  return lookups;
}

/**
 * Whether the records this run writes for `parentObject` can be the parents of
 * `childObject`: the run seeds the parent, and writes it before the child — an
 * insert cannot point at records it is writing itself.
 */
export function canDrawFromRun(
  childObject: string,
  parentObject: string,
  selectedObjects: readonly string[],
): boolean {
  return parentObject !== childObject && selectedObjects.includes(parentObject);
}

/**
 * What a row takes on when one of its lookups is chosen: the lookup's first
 * parent unless another is named, drawn from this run when the run seeds it.
 */
export function draftForLookup(
  lookup: RelationLookup,
  selectedObjects: readonly string[],
  parentObject: string = lookup.parents[0],
): SeedRelationDraftPatch {
  return {
    childObject: lookup.childObject,
    lookupField: lookup.lookupField,
    parentObject,
    source: canDrawFromRun(lookup.childObject, parentObject, selectedObjects)
      ? 'generated'
      : 'existing',
  };
}

/**
 * A new relation row, on the first lookup of an object no row fills yet —
 * one whose parents the run creates if there is one. Null when no selected
 * object has a lookup.
 */
export function newRelationDraft(
  lookups: readonly RelationLookup[],
  selectedObjects: readonly string[],
  rows: readonly SeedRelationDraft[],
  key: string,
): SeedRelationDraft | null {
  const free = lookups.filter((l) => !rows.some((r) => r.childObject === l.childObject));
  const lookup =
    free.find((l) => canDrawFromRun(l.childObject, l.parents[0], selectedObjects)) ??
    free[0] ??
    lookups[0];
  if (!lookup) return null;
  return {
    key,
    childObject: '',
    lookupField: '',
    parentObject: '',
    source: 'existing',
    ...draftForLookup(lookup, selectedObjects),
    where: '',
    limit: DEFAULT_PARENT_LIMIT,
    mode: 'perParent',
    count: 3,
    min: 1,
    max: 3,
    ratio: 0.5,
  };
}

/** Whether `value` is a whole number from `min` to `max`. */
function isWholeIn(value: number, min: number, max: number): boolean {
  return Number.isInteger(value) && value >= min && value <= max;
}

/** The spread a row describes, or null while one of its numbers is out of bounds. */
function distributionOf(draft: SeedRelationDraft): SeedRelation['distribution'] | null {
  const most = SEED_RELATION_LIMITS.maxPerParent;
  switch (draft.mode) {
    case 'perParent':
      return isWholeIn(draft.count, 1, most) ? { mode: 'perParent', count: draft.count } : null;
    case 'range':
      return isWholeIn(draft.min, 0, most) &&
        isWholeIn(draft.max, 1, most) &&
        draft.min <= draft.max
        ? { mode: 'range', min: draft.min, max: draft.max }
        : null;
    case 'ratio':
      return Number.isFinite(draft.ratio) &&
        draft.ratio >= SEED_RELATION_LIMITS.minRatio &&
        draft.ratio <= most
        ? { mode: 'ratio', ratio: draft.ratio }
        : null;
  }
}

/**
 * Each row checked against the wizard, in row order, with what it plans.
 *
 * Parents this run creates are counted as the run will write them: the
 * parent's own record count, or — when the parent is itself the child of a
 * relation — the children that relation plans. Two relations drawing from
 * each other's records would each wait for the other; the row that closes
 * the loop says so.
 */
export function checkRelations(
  rows: readonly SeedRelationDraft[],
  context: {
    selectedObjects: readonly string[];
    volumes: SeedVolumes;
    lookups: readonly RelationLookup[];
  },
): CheckedRelation[] {
  const { selectedObjects, volumes, lookups } = context;
  const checked: Array<CheckedRelation | undefined> = [];
  const inProgress = new Set<number>();
  const failed = (problem: RelationProblem): CheckedRelation => ({
    relation: null,
    parents: 0,
    children: 0,
    problem,
  });

  /** Records the run plans for an object; null when the question loops back. */
  const recordsOf = (objectApiName: string): number | null => {
    const index = rows.findIndex((r) => r.childObject === objectApiName);
    if (index < 0) return recordCountOf(volumes, objectApiName);
    if (inProgress.has(index)) return null;
    const parentRow = check(index);
    return parentRow.problem === null ? parentRow.children : recordCountOf(volumes, objectApiName);
  };

  const checkOne = (index: number): CheckedRelation => {
    const row = rows[index];
    const lookup = lookups.find(
      (l) => l.childObject === row.childObject && l.lookupField === row.lookupField,
    );
    if (!lookup || !lookup.parents.includes(row.parentObject)) return failed('incomplete');
    if (rows.findIndex((r) => r.childObject === row.childObject) !== index) {
      return failed('duplicate');
    }
    const distribution = distributionOf(row);
    if (!distribution) return failed('numbers');

    let parents: number;
    let from: SeedRelation['parents'];
    if (row.source === 'generated') {
      if (!canDrawFromRun(row.childObject, row.parentObject, selectedObjects)) {
        return failed('generatedParent');
      }
      const planned = recordsOf(row.parentObject);
      if (planned === null) return failed('generatedParent');
      parents = planned;
      from = { kind: 'generated' };
    } else {
      if (!isWholeIn(row.limit, 1, SEED_RELATION_LIMITS.maxExistingParents)) {
        return failed('numbers');
      }
      parents = row.limit;
      const where = row.where.trim();
      from = { kind: 'existing', limit: row.limit, ...(where ? { where } : {}) };
    }

    const children = plannedChildCount(distribution, parents);
    if (children < 1) return { relation: null, parents, children, problem: 'noChildren' };
    return {
      relation: {
        childObject: row.childObject,
        lookupField: row.lookupField,
        parentObject: row.parentObject,
        parents: from,
        distribution,
      },
      parents,
      children,
      problem: null,
    };
  };

  function check(index: number): CheckedRelation {
    const done = checked[index];
    if (done) return done;
    inProgress.add(index);
    const result = checkOne(index);
    inProgress.delete(index);
    checked[index] = result;
    return result;
  }

  return rows.map((_, index) => check(index));
}

/** The number a field holds while it is typed in: NaN while it holds none. */
export function typedNumber(value: string): number {
  return value.trim() === '' ? Number.NaN : Number(value);
}

/**
 * A number field's value once it is left: brought within its bounds, the
 * lowest when it holds none, whole or to the hundredth.
 */
export function settledNumber(value: number, min: number, max: number, whole = true): number {
  if (!Number.isFinite(value)) return min;
  const inside = Math.min(max, Math.max(min, value));
  return whole ? Math.round(inside) : Math.round(inside * 100) / 100;
}
