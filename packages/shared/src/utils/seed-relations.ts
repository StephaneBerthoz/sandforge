import type {
  SeedObjectConfig,
  SeedRelation,
  SeedRelationDistribution,
} from '../types/seed.types.js';

/**
 * Bounds of a seed relation, shared by the schema that admits one, the editor
 * that builds one and the run that honours one.
 */
export const SEED_RELATION_LIMITS = {
  /** Most children one parent receives, whatever the mode. */
  maxPerParent: 1_000,
  /** Most parent records a relation reads from the org. */
  maxExistingParents: 2_000,
  /** Smallest average: one child for every hundred parents. */
  minRatio: 0.01,
} as const;

/**
 * A ratio in hundredths, the precision it is spread at. Counted in whole
 * hundredths so that 100 parents at 0.29 get 29 children, not the 28 that
 * `Math.floor(100 * 0.29)` gives in floating point.
 */
function ratioInHundredths(ratio: number): number {
  return Math.round(ratio * 100);
}

/**
 * How many children each of `parentCount` parents receives, in parent order.
 *
 * A ratio is spread evenly: the i-th parent receives what brings the running
 * total to `floor((i + 1) * ratio)`, so no parent has two more than another,
 * and 0.5 gives a child to every other parent rather than to the first half.
 *
 * @param random - draws the range; `Math.random` unless a caller fixes it.
 */
export function childrenPerParent(
  distribution: SeedRelationDistribution,
  parentCount: number,
  random: () => number = Math.random,
): number[] {
  const parents = Math.max(0, Math.floor(parentCount));
  switch (distribution.mode) {
    case 'perParent':
      return Array.from({ length: parents }, () => distribution.count);
    case 'range': {
      const span = distribution.max - distribution.min + 1;
      return Array.from(
        { length: parents },
        () => distribution.min + Math.min(span - 1, Math.floor(random() * span)),
      );
    }
    case 'ratio': {
      const hundredths = ratioInHundredths(distribution.ratio);
      return Array.from(
        { length: parents },
        (_, i) => Math.floor(((i + 1) * hundredths) / 100) - Math.floor((i * hundredths) / 100),
      );
    }
  }
}

/**
 * The most children `distribution` gives `parentCount` parents: exact for a
 * fixed count and for a ratio, the ceiling of a range. It is the child
 * object's record count, the figure a run is planned and confirmed on.
 */
export function plannedChildCount(
  distribution: SeedRelationDistribution,
  parentCount: number,
): number {
  const parents = Math.max(0, Math.floor(parentCount));
  switch (distribution.mode) {
    case 'perParent':
      return parents * distribution.count;
    case 'range':
      return parents * distribution.max;
    case 'ratio':
      return Math.floor((parents * ratioInHundredths(distribution.ratio)) / 100);
  }
}

/** The relation that fills a lookup of `objectApiName`, if any. */
export function relationFor(
  objectApiName: string,
  relations: readonly SeedRelation[] | undefined,
): SeedRelation | undefined {
  return relations?.find((relation) => relation.childObject === objectApiName);
}

/**
 * The objects `obj` has to be written after: the targets of its `reference`
 * rules, and the parent of its relation when that parent is written by the
 * same run. A rule on the lookup a relation fills is the relation's to
 * answer, so its target is no dependency: a relation to records already in
 * the org depends on nothing the run writes.
 */
export function seedDependencies(
  obj: Pick<SeedObjectConfig, 'objectApiName' | 'fieldRules'>,
  relations: readonly SeedRelation[] | undefined,
): string[] {
  const relation = relationFor(obj.objectApiName, relations);
  const names = new Set<string>();
  for (const rule of obj.fieldRules) {
    if (rule.ruleType !== 'reference') continue;
    if (relation && rule.fieldApiName === relation.lookupField) continue;
    const target = rule.config.referenceObject;
    if (typeof target === 'string' && target) names.add(target);
  }
  if (relation?.parents.kind === 'generated') names.add(relation.parentObject);
  return [...names];
}
