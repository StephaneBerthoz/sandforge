/**
 * The order a copy writes objects in, when some of them point at each other.
 *
 * A parent has to be in the target before its children are written, or the
 * children lose the lookup: the id they carry is the source's, and the copy
 * clears what it cannot translate. Frozen Dataset learnt to order its load
 * this way; Autopilot, which wrote the objects of one wave all at once, lost
 * the account of every contact and opportunity of a real run for want of it.
 * One copy of the ordering, so both write in the same order.
 */

import { isInsertOnlyField, isPlatformRequiredField } from '@sandforge/shared';

/**
 * Insertion groups: the strongly connected components of the dependency
 * graph — each cycle one group, every other object a group of its own —
 * ordered so that a group comes after every group it depends on. Ties go
 * alphabetically, so an acyclic set keeps the plain topological order.
 * Inside a group, members are alphabetical; their mutual lookups are filled
 * by a second pass, and {@link orderWithinGroup} settles the required ones.
 *
 * The first version ran Kahn's algorithm and, at the first cycle, appended
 * everything left alphabetically. Real data has cycles — an Account pointing
 * at its key Contact, an Opportunity at its synced Quote — so everything
 * downstream of one went in alphabetically: AccountContactRelation before
 * Contact, line items before their quote. Run for real, that alone refused
 * most of a dataset.
 *
 * @param deps - Object → the objects its records point at. An object named
 *   only as a dependency, and never as a key, is outside the set and ignored.
 */
export function insertionGroups(deps: ReadonlyMap<string, ReadonlySet<string>>): string[][] {
  // Tarjan's strongly connected components, iterated in name order so the
  // grouping is deterministic.
  let counter = 0;
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const componentOf = new Map<string, number>();
  const components: string[][] = [];
  const visit = (name: string): void => {
    index.set(name, counter);
    low.set(name, counter);
    counter++;
    stack.push(name);
    onStack.add(name);
    for (const next of [...(deps.get(name) ?? [])].sort()) {
      if (!deps.has(next)) continue;
      if (!index.has(next)) {
        visit(next);
        low.set(name, Math.min(low.get(name) ?? 0, low.get(next) ?? 0));
      } else if (onStack.has(next)) {
        low.set(name, Math.min(low.get(name) ?? 0, index.get(next) ?? 0));
      }
    }
    if (low.get(name) === index.get(name)) {
      const component: string[] = [];
      let member: string | undefined;
      do {
        member = stack.pop();
        if (member === undefined) break;
        onStack.delete(member);
        componentOf.set(member, components.length);
        component.push(member);
      } while (member !== name);
      components.push(component.sort());
    }
  };
  for (const name of [...deps.keys()].sort()) {
    if (!index.has(name)) visit(name);
  }

  // Kahn over the components, ready ones taken in name order.
  const waitingOn = components.map((component, i) => {
    const needs = new Set<number>();
    for (const member of component) {
      for (const dep of deps.get(member) ?? []) {
        const target = componentOf.get(dep);
        if (target !== undefined && target !== i) needs.add(target);
      }
    }
    return needs;
  });
  const placed = new Set<number>();
  const ordered: string[][] = [];
  while (placed.size < components.length) {
    const ready = components
      .map((component, i) => ({ component, i }))
      .filter(({ i }) => !placed.has(i) && [...waitingOn[i]].every((d) => placed.has(d)))
      .sort((a, b) => a.component[0].localeCompare(b.component[0]));
    // The condensation of a graph has no cycle, so something is always ready.
    for (const { component, i } of ready) {
      placed.add(i);
      ordered.push(component);
    }
  }
  return ordered;
}

/**
 * Order the members of one cycle so that each goes after the members its
 * required lookups point at. A cycle made only of required lookups cannot be
 * written in any order; its remainder goes alphabetically, and the insert says
 * which records the target refused.
 *
 * @param group - The members of one cycle, as {@link insertionGroups} gives it.
 * @param requiredDeps - Object → the objects it cannot be written without.
 */
export function orderWithinGroup(
  group: readonly string[],
  requiredDeps: ReadonlyMap<string, ReadonlySet<string>>,
): string[] {
  const members = new Set(group);
  const remaining = new Map(
    group.map((name) => [
      name,
      new Set([...(requiredDeps.get(name) ?? [])].filter((d) => members.has(d))),
    ]),
  );
  const order: string[] = [];
  for (;;) {
    const ready = [...remaining.entries()]
      .filter(([, d]) => d.size === 0)
      .map(([name]) => name)
      .sort();
    if (ready.length === 0) break;
    for (const name of ready) {
      order.push(name);
      remaining.delete(name);
      for (const d of remaining.values()) d.delete(name);
    }
  }
  return [...order, ...[...remaining.keys()].sort()];
}

/** A lookup of an object at another, as the order of a write reads it. */
export interface OrderingLookup {
  /** The object it points at. */
  from: string;
  /** The object that holds it. */
  to: string;
  fieldApiName: string;
  /** The describe says a record cannot be written without it. */
  required?: boolean;
}

/** Each object's lookups as the target describes them; nothing for one it did not. */
export type DescribedLookupsOf = (
  objectApiName: string,
) => ReadonlyArray<{ name: string; createable: boolean; updateable: boolean }> | null | undefined;

/**
 * Within one cycle, what each object cannot be written without: what its
 * required lookups point at, and what its lookups the second pass cannot set
 * — the target takes them on create and not on update — point at. A run
 * orders its cycles by this, and a fit of its plan reads the same order:
 * which of two objects of a cycle goes first decides which lookup holds a
 * record to its parent, and which is filled afterwards and may stay empty.
 *
 * @param group - The members of one cycle.
 * @param edges - The plan's lookups; those outside the cycle are not read.
 * @param lookupsOf - Each member's lookups, as the target describes them.
 */
export function atInsertDeps(
  group: readonly string[],
  edges: readonly OrderingLookup[],
  lookupsOf: DescribedLookupsOf,
): Map<string, Set<string>> {
  const members = new Set(group);
  const needs = new Map<string, Set<string>>();
  for (const edge of edges) {
    if (!members.has(edge.to) || !members.has(edge.from)) continue;
    const lookup = lookupsOf(edge.to)?.find((l) => l.name === edge.fieldApiName);
    const insertOnly = lookup !== undefined && isInsertOnlyField(lookup);
    if (!edge.required && !isPlatformRequiredField(edge.to, edge.fieldApiName) && !insertOnly) {
      continue;
    }
    needs.set(edge.to, (needs.get(edge.to) ?? new Set()).add(edge.from));
  }
  return needs;
}

/** How the objects of one wave are written: {@link waveGroupsOf}. */
export interface WaveGroups<E extends OrderingLookup> {
  /** The lookups between two objects of the wave. */
  within: E[];
  /** Object → the objects of the wave it points at. */
  deps: Map<string, Set<string>>;
  /** Its insertion groups ({@link insertionGroups}), in the order they start. */
  groups: string[][];
}

/**
 * The insertion groups of one wave of a plan, from the lookups between its
 * objects: what a run writes one after the other, and what side by side.
 */
export function waveGroupsOf<E extends OrderingLookup>(
  objects: readonly string[],
  edges: readonly E[],
): WaveGroups<E> {
  const members = new Set(objects);
  const within = edges.filter(
    (edge) => edge.from !== edge.to && members.has(edge.from) && members.has(edge.to),
  );
  const deps = new Map(objects.map((name) => [name, new Set<string>()]));
  for (const edge of within) deps.get(edge.to)?.add(edge.from);
  return { within, deps, groups: insertionGroups(deps) };
}

/**
 * The order a plan writes its objects in, wave by wave: each wave's groups in
 * the order they start, each cycle in the order what its objects cannot be
 * written without leaves it ({@link orderWithinGroup}). Two groups a run
 * writes side by side point at nothing of each other: either may come first
 * here.
 *
 * @param waves - The objects of each wave of the plan, in its order.
 * @param edges - The plan's lookups.
 * @param lookupsOf - Each object's lookups, as the target describes them.
 */
export function writeOrderOf(
  waves: ReadonlyArray<readonly string[]>,
  edges: readonly OrderingLookup[],
  lookupsOf: DescribedLookupsOf,
): string[] {
  return waves.flatMap((objects) => {
    const { groups, within } = waveGroupsOf(objects, edges);
    return groups.flatMap((group) =>
      group.length > 1 ? orderWithinGroup(group, atInsertDeps(group, within, lookupsOf)) : group,
    );
  });
}
