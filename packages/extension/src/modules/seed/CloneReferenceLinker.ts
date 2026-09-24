/**
 * CloneReferenceLinker resolves the insert order of a Clone from the lookups
 * between its objects, and the lookups its second pass fills in.
 */

import type { AutopilotEdge, RelationshipType } from '@sandforge/shared';
import { isRequiredLookup } from '@sandforge/shared';
import { insertionGroups, orderWithinGroup } from '../../core/common/insertionOrder.js';
import { EMAIL_MESSAGE, emailWriteEdges } from '../../core/common/platformRecords.js';

/** Describe field shape for buildEdgesFromDescribe. */
interface DescribeField {
  name: string;
  type: string;
  referenceTo?: string[];
  /** Whether a record may leave it empty; unknown reads as nullable. */
  nillable?: boolean;
  /** Whether a record can be created with it set; unknown reads as createable. */
  createable?: boolean;
  /** Whether an update can set it; unknown reads as updateable. */
  updateable?: boolean;
}

/** Describe result shape for buildEdgesFromDescribe. */
export interface DescribeSObjectResultLike {
  fields: DescribeField[];
}

/**
 * Resolves the insertion order of objects during a Clone operation, and which
 * lookups go in empty for the second pass to fill.
 *
 * The objects are ordered the way Frozen Dataset and Autopilot order their
 * loads (`insertionOrder`): each cycle a group, written after the groups it
 * points at. Inside a cycle, an object goes after those its records cannot be
 * created without, and the emails before the tasks; the other lookups of the
 * cycle that point forward, and a lookup at the object itself, are written
 * empty and filled in once the record they name is in the target.
 */
export class CloneReferenceLinker {
  /**
   * Resolve the insert order for a set of objects based on their edges.
   * Objects with no dependencies (no parents) are placed first; ties go
   * alphabetically. Self-referential edges (where from === to) are ignored
   * for ordering: {@link lookupsFilledAfter} leaves them to the second pass.
   *
   * Any cycle used to stop the clone. An account's key contact — a custom
   * lookup the record may leave empty — against a contact's account, and a
   * real preview of the two stopped on "Cycle detected among objects:
   * Account, Contact" before reading a row, although writing the accounts
   * without their key contact and filling it in once the contacts are in
   * breaks it, as Forge's second pass does. Only a cycle of lookups that
   * have to hold their value when the record is created is refused: no
   * order writes one of its objects first.
   *
   * @param objects - List of object API names to sort.
   * @param edges - Lookup relationships between objects, `required` when the
   *   lookup has to be set when the record is created, and the edge that puts
   *   the emails before the tasks.
   * @returns The objects in the order to write them.
   * @throws Error when a cycle is made only of lookups that must be set when
   *   the record is created, naming its objects and those lookups.
   */
  resolveInsertOrder(objects: string[], edges: AutopilotEdge[]): string[] {
    if (objects.length === 0) {
      return [];
    }

    const members = new Set(objects);
    const between = edges.filter(
      (e) => e.from !== e.to && members.has(e.from) && members.has(e.to),
    );
    // Edge semantics: e.to (child) has a lookup to e.from (parent). Per
    // object, what its records point at, what they cannot be created
    // without, and what they go after for the order alone (`ordersOnly`).
    const pointsAt = new Map(objects.map((name) => [name, new Set<string>()]));
    const setAtInsert = new Map(objects.map((name) => [name, new Set<string>()]));
    const orderedAfter = new Map(objects.map((name) => [name, new Set<string>()]));
    for (const edge of between) {
      pointsAt.get(edge.to)?.add(edge.from);
      if (!edge.required) continue;
      (ordersOnly(edge) ? orderedAfter : setAtInsert).get(edge.to)?.add(edge.from);
    }

    const unbreakable = insertionGroups(setAtInsert).filter((group) => group.length > 1);
    if (unbreakable.length > 0) {
      throw new Error(
        unbreakableCycleMessage(
          unbreakable,
          between.filter((edge) => !ordersOnly(edge)),
        ),
      );
    }
    // Inside a cycle the emails still go before the tasks, unless a lookup
    // that has to be set at insert says otherwise: the lookup is the
    // platform's rule, the order the clone's choice.
    const withOrder = new Map(
      objects.map((name) => [
        name,
        new Set([...(setAtInsert.get(name) ?? []), ...(orderedAfter.get(name) ?? [])]),
      ]),
    );
    const inside = insertionGroups(withOrder).some((group) => group.length > 1)
      ? setAtInsert
      : withOrder;
    return insertionGroups(pointsAt).flatMap((group) =>
      group.length > 1 ? orderWithinGroup(group, inside) : group,
    );
  }

  /**
   * The lookups the insert leaves empty and the second pass fills, for
   * objects written in `order`: a lookup of a cycle whose record goes in
   * before the object it points at, and a lookup at the object itself, which
   * the insert writing both records cannot fill. One that has to be set when
   * the record is created is never among them: the order writes what it
   * points at first, or a self-reference goes as it was read.
   *
   * @param order - The insert order, as {@link resolveInsertOrder} gives it.
   * @param edges - The edges the order was resolved from.
   * @returns The edges of those lookups, self-references included.
   */
  lookupsFilledAfter(order: string[], edges: AutopilotEdge[]): AutopilotEdge[] {
    const position = new Map(order.map((name, index) => [name, index]));
    return edges.filter((edge) => {
      const child = position.get(edge.to);
      const parent = position.get(edge.from);
      return !edge.required && child !== undefined && parent !== undefined && parent >= child;
    });
  }

  /**
   * Detect self-referential edges (where the lookup points to the same object).
   * These require two-pass insert logic (insert with NULL, then UPDATE).
   *
   * @param edges - All edges to inspect.
   * @returns Array of self-referential edges.
   */
  detectSelfReferentialEdges(edges: AutopilotEdge[]): AutopilotEdge[] {
    return edges.filter((e) => e.from === e.to);
  }

  /**
   * Build AutopilotEdge array from describe results.
   * For each object, inspects reference-type fields and creates edges
   * for fields whose referenceTo includes another object in the clone set.
   *
   * A lookup no record can be created with orders nothing: the clone cannot
   * set it, so its record goes in whether or not the one it names is there.
   * Counted, a feed item's best comment — which the platform sets itself —
   * made a feed item wait for its comments, which cannot go in before it,
   * and a clone of a feed with its comments stopped on "Cycle detected among
   * objects: FeedItem, FeedComment" before reading a row. Forge orders its
   * writes by the lookups a record may not leave empty, and a best comment is
   * not one.
   *
   * Nor does an email's task: the emails go before the tasks, as the edge
   * `emailWriteEdges` gives. The platform writes the task of an email that is
   * not on a case as it takes the email, and refuses its id from a copy; an
   * email on a case waits for its task as the clone writes it.
   *
   * An edge is `required` when its lookup has to hold its value when the
   * record is created: the record may not leave it empty — the describe says
   * so, or the platform does (`isRequiredLookup`) — or an update cannot set
   * it, so the second pass could not fill it in afterwards. The edge that puts
   * the emails before the tasks is `required` too, for the order, though no
   * record carries it: see `ordersOnly`.
   *
   * @param objectApiNames - Object API names in the clone set.
   * @param describeResults - Map of object API name to describe result.
   * @returns Array of AutopilotEdge objects.
   */
  buildEdgesFromDescribe(
    objectApiNames: string[],
    describeResults: Map<string, DescribeSObjectResultLike>,
  ): AutopilotEdge[] {
    const objectSet = new Set(objectApiNames);
    const edges: AutopilotEdge[] = [];

    for (const objectApiName of objectApiNames) {
      const describe = describeResults.get(objectApiName);
      if (!describe) continue;

      for (const field of describe.fields) {
        if (field.createable === false) continue;
        if (objectApiName === EMAIL_MESSAGE && field.name === 'ActivityId') continue;
        if (field.type === 'reference' && field.referenceTo) {
          const required =
            isRequiredLookup(objectApiName, field.name, field.nillable) ||
            field.updateable === false;
          for (const refTarget of field.referenceTo) {
            if (objectSet.has(refTarget)) {
              edges.push({
                from: refTarget,
                to: objectApiName,
                fieldApiName: field.name,
                relationshipType: 'lookup' as RelationshipType,
                required,
              });
            }
          }
        }
      }
    }
    for (const edge of emailWriteEdges(objectSet)) {
      edges.push({
        from: edge.sourceObject,
        to: edge.targetObject,
        fieldApiName: edge.relationshipName,
        relationshipType: 'lookup' as RelationshipType,
        required: true,
      });
    }

    return edges;
  }
}

/**
 * Whether an edge orders two objects without being a lookup of either: the
 * emails before the tasks, as `emailWriteEdges` gives it. No record carries
 * it, so no second pass fills it, and it never makes a cycle one no order
 * breaks: a lookup that has to be set when the record is created goes first,
 * and the order gives way.
 */
function ordersOnly(edge: AutopilotEdge): boolean {
  return emailWriteEdges(new Set([edge.from, edge.to])).some(
    (order) =>
      order.sourceObject === edge.from &&
      order.targetObject === edge.to &&
      order.relationshipName === edge.fieldApiName,
  );
}

/**
 * Why a cycle cannot be written: its objects, and the lookups closing it that
 * have to be set when the record is created.
 */
function unbreakableCycleMessage(
  cycles: readonly string[][],
  edges: readonly AutopilotEdge[],
): string {
  const lookups = cycles.flatMap((cycle) => {
    const members = new Set(cycle);
    return edges
      .filter((e) => e.required && members.has(e.from) && members.has(e.to))
      .map((e) => `${e.to}.${e.fieldApiName}`);
  });
  return (
    `Cycle detected among objects: ${cycles.flat().join(', ')}. ` +
    `${listed(lookups)} must be set when the record is created, so no object of the ` +
    'cycle can be written first.'
  );
}

/** Items joined as a sentence lists them: "a", "a and b", "a, b and c". */
function listed(items: readonly string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}
