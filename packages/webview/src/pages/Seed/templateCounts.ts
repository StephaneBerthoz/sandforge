import type { SeedTemplate } from '@sandforge/shared';
import { plannedChildCount, seedDependencies } from '@sandforge/shared';

/** Record counts by object API name. */
export type TemplateCounts = Record<string, number>;

/** A count as typed: a whole number, 0 or more; anything else is 0. */
export function typedCount(typed: string): number {
  const value = Number.parseInt(typed, 10);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * The counts once `objectApiName` is set to `count`, the objects a relation
 * places under it following it: three contacts per account stay three per
 * account when the accounts change, and none are left when there are none.
 * A relation's child took the count the template gave it whatever its
 * parents were set to, and a run with fewer parents was cut short with a note
 * on every child object.
 */
export function withCount(
  template: Pick<SeedTemplate, 'objects' | 'relations'>,
  counts: TemplateCounts,
  objectApiName: string,
  count: number,
): TemplateCounts {
  const next: TemplateCounts = { ...counts, [objectApiName]: count };
  const changed = [objectApiName];
  while (changed.length > 0) {
    const parent = changed.shift() as string;
    for (const relation of template.relations ?? []) {
      if (relation.parents.kind !== 'generated' || relation.parentObject !== parent) continue;
      // Placed by key, the children are the child's rows, however many parents there are.
      if (relation.distribution.mode === 'byKey') continue;
      const planned = plannedChildCount(relation.distribution, next[parent] ?? 0);
      if (next[relation.childObject] === planned) continue;
      next[relation.childObject] = planned;
      changed.push(relation.childObject);
    }
  }
  return next;
}

/**
 * The template a seed runs with these counts: an object set to 0 is left
 * out, and with it what cannot be written without it — a relation's child, a
 * line item whose prices are left out — since a seed refuses an object whose
 * parent it does not write, and the org a record pointing at nothing.
 */
export function templateWithCounts(template: SeedTemplate, counts: TemplateCounts): SeedTemplate {
  const left = new Set(
    template.objects
      .filter((o) => (counts[o.objectApiName] ?? o.recordCount) <= 0)
      .map((o) => o.objectApiName),
  );
  let grew = left.size > 0;
  while (grew) {
    grew = false;
    for (const object of template.objects) {
      if (left.has(object.objectApiName)) continue;
      if (seedDependencies(object, template.relations).some((name) => left.has(name))) {
        left.add(object.objectApiName);
        grew = true;
      }
    }
  }
  if (left.size === 0) return template;
  return {
    ...template,
    objects: template.objects.filter((o) => !left.has(o.objectApiName)),
    ...(template.relations
      ? {
          relations: template.relations.filter(
            (r) =>
              !left.has(r.childObject) &&
              !(r.parents.kind === 'generated' && left.has(r.parentObject)),
          ),
        }
      : {}),
  };
}
