import type { SeedRelation } from '@sandforge/shared';

/** A lookup rule of one object of the run that takes its ids from another. */
export interface RunLookup {
  objectApiName: string;
  fieldApiName: string;
  /** The object of the run the rule takes its ids from. */
  target: string;
  /** Whether the org requires the field: such a rule is sent whatever it closes. */
  required: boolean;
}

/** A custom field, managed or not: its API name ends in `__c`. */
function isCustom(fieldApiName: string): boolean {
  return fieldApiName.endsWith('__c');
}

/**
 * The optional lookups a run leaves for the org to fill, as `Object.Field`:
 * each would make two of the run's objects wait on each other, and the run
 * refuses such a template whole, as a circular dependency. A sandbox whose
 * accounts carry a custom lookup to a contact refused every run holding
 * Account and Contact, the contacts pointing at their accounts.
 *
 * What the run cannot do without is kept first: the parents a relation draws
 * from this run, and every required lookup — one of those that closes a loop
 * is still sent, so the run is refused before it writes anything rather than
 * failing every record. Then the optional lookups, a standard one before a
 * custom one and, between two of a kind, the one pointing at an object picked
 * earlier: each is kept unless its target already waits on its object.
 */
export function lookupsClosingACycle(
  selectedObjects: readonly string[],
  lookups: readonly RunLookup[],
  relations: readonly SeedRelation[],
): Set<string> {
  const waitsOn = new Map<string, Set<string>>();
  const keep = (from: string, to: string): void => {
    const targets = waitsOn.get(from) ?? new Set<string>();
    targets.add(to);
    waitsOn.set(from, targets);
  };
  /** Whether `from` waits on `to`, directly or through other objects. */
  const reaches = (from: string, to: string): boolean => {
    const seen = new Set<string>();
    const stack = [from];
    while (stack.length > 0) {
      const at = stack.pop() as string;
      if (at === to) return true;
      if (seen.has(at)) continue;
      seen.add(at);
      stack.push(...(waitsOn.get(at) ?? []));
    }
    return false;
  };

  for (const relation of relations) {
    if (relation.parents.kind === 'generated') keep(relation.childObject, relation.parentObject);
  }
  for (const lookup of lookups) {
    if (lookup.required) keep(lookup.objectApiName, lookup.target);
  }

  const picked = (name: string): number => selectedObjects.indexOf(name);
  const rank = (lookup: RunLookup): number =>
    (isCustom(lookup.fieldApiName) ? 2 : 0) +
    (picked(lookup.target) < picked(lookup.objectApiName) ? 0 : 1);
  const optional = lookups
    .map((lookup, order) => ({ lookup, order }))
    .filter(({ lookup }) => !lookup.required)
    .sort((a, b) => rank(a.lookup) - rank(b.lookup) || a.order - b.order);

  const leftOut = new Set<string>();
  for (const { lookup } of optional) {
    if (reaches(lookup.target, lookup.objectApiName)) {
      leftOut.add(`${lookup.objectApiName}.${lookup.fieldApiName}`);
    } else {
      keep(lookup.objectApiName, lookup.target);
    }
  }
  return leftOut;
}
