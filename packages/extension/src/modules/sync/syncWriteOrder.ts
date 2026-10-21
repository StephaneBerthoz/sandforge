/**
 * The order a Sync run writes its objects in: every parent a lookup names
 * before the object that holds the lookup, read from the target's describe of
 * each object, and the configuration's own order wherever no lookup decides.
 *
 * A run wrote its objects in the order the admin had added them, and no
 * screen could change it. A Case added before the Contact it names was
 * written first: its `ContactId` held an id from the source, which the target
 * refused, and the case was written again without it — or, between two
 * sandboxes copied from one production, where the target holds a record of
 * that id, the case pointed at the target's own contact, and nothing said so.
 * The run, a re-run, a saved, scheduled or pipeline run, a Quick Sync and a
 * simulation now all write in this order, and Review shows it.
 *
 * Objects whose lookups name each other (an account's contact, a contact's
 * account) form a cycle no order breaks: they keep the configuration's order
 * among themselves, and the lookup at the one written later goes as before,
 * left out once the target refuses the source's id. A lookup of an object at
 * itself is set by the write's own second pass (`prepareSyncRows`).
 */

import type { SyncObjectConfig, SyncWriteOrder, SyncWriteOrderMove } from '@sandforge/shared';
import type { TargetWriteFields } from './targetWriteFields.js';

/** One lookup a write of an object carries, and the objects it may name. */
export interface WriteLookup {
  field: string;
  referenceTo: readonly string[];
}

/**
 * The lookups a write of `objectConfig` carries, from the target's describe:
 * the lookups the running user may write there, those its mappings or
 * add-ons set when it has any — a write with mappings sends their fields
 * alone. A delete carries none.
 */
export function lookupsOf(
  objectConfig: Pick<SyncObjectConfig, 'operation' | 'fieldMappings' | 'addOnFields'>,
  target: Pick<TargetWriteFields, 'fields'>,
): WriteLookup[] {
  if (objectConfig.operation === 'delete') return [];
  const sent =
    objectConfig.fieldMappings.length > 0
      ? new Set([
          ...objectConfig.fieldMappings
            .filter((mapping) => mapping.type !== 'exclude')
            .map((mapping) => mapping.targetField),
          ...objectConfig.addOnFields.map((addOn) => addOn.fieldApiName),
        ])
      : undefined;
  return (target.fields ?? []).flatMap((field) =>
    field.isReference &&
    field.createable &&
    field.name !== 'RecordTypeId' &&
    (field.referenceTo?.length ?? 0) > 0 &&
    (sent === undefined || sent.has(field.name))
      ? [{ field: field.name, referenceTo: field.referenceTo ?? [] }]
      : [],
  );
}

/** A parent an object's lookup names among the run's objects. */
interface Edge {
  parent: string;
  child: string;
  field: string;
}

/**
 * The run's objects in the order it writes them, and what that order changed.
 *
 * Parents first, by the lookups each object's write carries (`lookups`, by
 * object): the objects a cycle of lookups ties together are written as one
 * group, in the configuration's order, and the groups in the order their
 * lookups ask, the one the configuration lists first going first wherever
 * none does. An object with no lookup keeps its place.
 *
 * @param objects - The run's objects, in any order: their `insertOrder` is the configuration's order.
 * @param lookups - Per object, the lookups its write carries ({@link lookupsOf}); an object absent has none.
 */
export function orderSyncObjects(
  objects: readonly SyncObjectConfig[],
  lookups: ReadonlyMap<string, readonly WriteLookup[]>,
): { ordered: SyncObjectConfig[]; order: SyncWriteOrder } {
  const listed = [...objects].sort((a, b) => a.insertOrder - b.insertOrder);
  const place = new Map(listed.map((object, at) => [object.objectApiName, at]));
  const writes = new Set(
    listed.filter((o) => o.operation !== 'delete').map((o) => o.objectApiName),
  );

  // Each parent an object's lookups name among the objects the run writes;
  // a lookup at itself is the write's own business.
  const edges: Edge[] = [];
  const seen = new Set<string>();
  for (const object of listed) {
    const child = object.objectApiName;
    if (!writes.has(child)) continue;
    for (const { field, referenceTo } of lookups.get(child) ?? []) {
      for (const parent of referenceTo) {
        if (parent === child || !writes.has(parent)) continue;
        const key = `${parent}>${child}`;
        if (seen.has(key)) continue;
        seen.add(key);
        edges.push({ parent, child, field });
      }
    }
  }

  const groups = stronglyConnected(
    listed.map((o) => o.objectApiName),
    edges,
  );
  const groupOf = new Map<string, number>();
  groups.forEach((members, at) => {
    for (const name of members) groupOf.set(name, at);
  });
  // Each group's members in the configuration's order, and where it starts there.
  const membersOf = groups.map((members) =>
    [...members].sort((a, b) => (place.get(a) ?? 0) - (place.get(b) ?? 0)),
  );
  const firstOf = membersOf.map((members) => place.get(members[0]) ?? 0);

  // The groups in the order their lookups ask, the first listed first where
  // several are free to go.
  const waitingOn = membersOf.map(() => new Set<number>());
  for (const { parent, child } of edges) {
    const from = groupOf.get(parent) ?? 0;
    const to = groupOf.get(child) ?? 0;
    if (from !== to) waitingOn[to].add(from);
  }
  const done = new Set<number>();
  const orderedNames: string[] = [];
  while (done.size < membersOf.length) {
    let next: number | undefined;
    membersOf.forEach((_, at) => {
      if (done.has(at) || [...waitingOn[at]].some((from) => !done.has(from))) return;
      if (next === undefined || firstOf[at] < firstOf[next]) next = at;
    });
    // No group is ever left waiting on another: the groups of a graph's
    // strongly connected parts form none of their own.
    if (next === undefined) break;
    done.add(next);
    orderedNames.push(...membersOf[next]);
  }

  const byName = new Map(listed.map((object) => [object.objectApiName, object]));
  const ordered = orderedNames.flatMap((name) => {
    const object = byName.get(name);
    return object ? [object] : [];
  });
  const written = new Map(orderedNames.map((name, at) => [name, at]));

  // What the order changed: an object written after a parent the
  // configuration listed after it, said once, by the last such parent.
  const moved: SyncWriteOrderMove[] = [];
  for (const object of ordered) {
    const name = object.objectApiName;
    const later = edges
      .filter(
        (edge) =>
          edge.child === name &&
          (place.get(edge.parent) ?? 0) > (place.get(name) ?? 0) &&
          (written.get(edge.parent) ?? 0) < (written.get(name) ?? 0),
      )
      .sort((a, b) => (written.get(b.parent) ?? 0) - (written.get(a.parent) ?? 0));
    if (later.length > 0) {
      moved.push({ objectApiName: name, after: later[0].parent, field: later[0].field });
    }
  }

  return {
    ordered,
    order: {
      objects: orderedNames,
      moved,
      cycles: membersOf.filter((members) => members.length > 1),
    },
  };
}

/**
 * The strongly connected parts of a graph, by Tarjan's algorithm: each set of
 * objects whose lookups lead from any one of them to every other.
 */
function stronglyConnected(nodes: readonly string[], edges: readonly Edge[]): string[][] {
  const children = new Map<string, string[]>(nodes.map((node) => [node, []]));
  for (const { parent, child } of edges) children.get(parent)?.push(child);
  let counter = 0;
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const parts: string[][] = [];

  const visit = (node: string): void => {
    index.set(node, counter);
    low.set(node, counter);
    counter++;
    stack.push(node);
    onStack.add(node);
    for (const next of children.get(node) ?? []) {
      if (!index.has(next)) {
        visit(next);
        low.set(node, Math.min(low.get(node) ?? 0, low.get(next) ?? 0));
      } else if (onStack.has(next)) {
        low.set(node, Math.min(low.get(node) ?? 0, index.get(next) ?? 0));
      }
    }
    if (low.get(node) !== index.get(node)) return;
    const part: string[] = [];
    let member: string | undefined;
    do {
      member = stack.pop();
      if (member === undefined) break;
      onStack.delete(member);
      part.push(member);
    } while (member !== node);
    parts.push(part);
  };

  for (const node of nodes) if (!index.has(node)) visit(node);
  return parts;
}
