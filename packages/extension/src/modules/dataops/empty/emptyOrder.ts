/**
 * The order an emptying deletes its objects in: one pass per emptied
 * object, read from what the org does as records go — the order that keeps
 * an undo possible wherever the platform leaves the choice.
 *
 * - **A parent goes first whenever its records take others along.** An
 *   account's delete takes its contacts and opportunities to the recycle bin
 *   with it, and they come back with it, the whole tree; a record deleted on
 *   its own, and then the record it hangs from, stays in the bin for good,
 *   its undelete refused "Entity is not in the recycle bin" (a case under an
 *   account, live). So a pass comes after every emptied object whose records
 *   take its own along, and what is left of it — a contact under no account —
 *   is all it sends.
 * - **Records go before the one they name only where the platform requires
 *   it**: a lookup that refuses its parent's delete while it names it. Cases
 *   go before their accounts and contacts; opportunities, quotes, orders and
 *   contracts before their price book; order products, quote lines and assets
 *   before their product; the custom prices of a product before its standard
 *   one, which the org refuses to delete while a custom price is left — so
 *   price books go before products. Records going along with another
 *   object's count for it: a price book goes after the accounts whose
 *   opportunities name it. Each such pair is said (`beforeParent`): what goes
 *   before the record it names cannot come back once that record has gone
 *   too, alone (a case before its account) or with its own parent (an
 *   opportunity with its account, before its price book: seen live, it did
 *   not come back with its account). A refusing lookup between records one
 *   delete takes together — an order and the contact it bills, both under
 *   one account — orders nothing: putting the order first would send every
 *   order alone, beyond any undo, for the few that bill another account's
 *   contact, which the org refuses and the run's rounds of tries take once
 *   that account has gone.
 * - **Any other lookup** orders its records before the record it names, as a
 *   removal deletes them: the org would otherwise empty the lookup of every
 *   record it keeps for a moment before deleting it.
 *
 * Where objects point at each other these constraints may not all hold: a
 * plain lookup gives way first, then one that takes records along; a refused
 * delete never gives way while another constraint can. What gives way is said
 * (`unordered`), and the run's rounds of tries take what the org refuses for
 * it once the rest is gone.
 *
 * The order is the removal's own, `childrenFirst`, told how each tie places
 * the two objects: no third orderer.
 */

import { childrenFirst, type DescribedRelationship } from '../../checkpoint/checkpointScope.js';
import type { CheckpointDescribe } from '../../checkpoint/checkpointFields.js';
import { setBackToDraftOf } from '../../../core/removal/recordsToDraft.js';
import { carriersOf, type Affected, type Relation, type Route } from './emptyRelations.js';

/** Why one pass goes before another. */
export type OrderReason =
  /** The first one's deletes take records of the second along. */
  | 'cascade'
  /** A record of the first names one of the second through a lookup that refuses its delete. */
  | 'restricted'
  /** The custom prices go before the standard ones. */
  | 'customPrices'
  /** A record of the first names one of the second through a plain lookup. */
  | 'lookup';

/** How firmly each reason holds where objects point at each other: the lowest gives way first. */
const FIRMNESS: Readonly<Record<OrderReason, number>> = {
  lookup: 0,
  cascade: 1,
  restricted: 2,
  customPrices: 2,
};

/** That `first` goes before `then`, and why. */
export interface OrderConstraint {
  first: string;
  then: string;
  reason: OrderReason;
}

/**
 * Records that go before a record they name, as the platform requires: a
 * record of `objectApiName`, through `field`, names one of `parent`.
 */
export interface BeforeParent {
  objectApiName: string;
  field: string;
  parent: string;
  reason: 'restricted' | 'customPrices';
}

/** One object's pass, in the order of the passes. */
export interface EmptyPass {
  objectApiName: string;
  /**
   * The routes by which its records go with an emptied object whose pass
   * came before: what is left for its own pass is the rest.
   */
  goneBefore: Route[];
  /**
   * The routes by which its records would go with an emptied object whose
   * pass comes after: a constraint that gave way, its records sent on their
   * own before the record they hang from.
   */
  sentBeforeTheirParent: Route[];
}

/** The passes of an emptying, and what their order says. */
export interface EmptyOrder {
  passes: EmptyPass[];
  /** Pairs whose records go before the record they name: see {@link BeforeParent}. */
  beforeParent: BeforeParent[];
  /** Constraints that gave way where objects point at each other. */
  unordered: OrderConstraint[];
  /**
   * Objects whose records past Draft are set back to Draft before any
   * delete, the one way the platform deletes them: an activated order.
   */
  toDraft: string[];
}

/** The price book whose custom prices go before its product's standard one. */
const PRICE_BOOK = 'Pricebook2';
/** The product whose standard price goes once its custom ones have. */
const PRODUCT = 'Product2';
/** The price, which goes with its price book and with its product. */
const PRICE = 'PricebookEntry';

/** Every constraint the emptied objects' deletes put on their order. */
export function orderConstraintsOf(
  affected: Affected,
  relations: readonly Relation[],
): { constraints: OrderConstraint[]; beforeParent: BeforeParent[] } {
  const constraints: OrderConstraint[] = [];
  const beforeParent: BeforeParent[] = [];
  const deleted = (name: string): boolean =>
    affected.emptied.has(name) || affected.routes.has(name);
  for (const name of affected.emptied) {
    for (const carrier of carriersOf(name, affected)) {
      if (carrier !== name) constraints.push({ first: carrier, then: name, reason: 'cascade' });
    }
  }
  for (const { parent, child, field, kind } of relations) {
    if (child === parent || !deleted(child) || !deleted(parent)) continue;
    if (kind === 'lookup') {
      if (affected.emptied.has(child) && affected.emptied.has(parent)) {
        constraints.push({ first: child, then: parent, reason: 'lookup' });
      }
      continue;
    }
    if (kind !== 'restricted') continue;
    const ownCarriers = carriersOf(child, affected);
    const firsts = affected.emptied.has(child) ? [child] : [...ownCarriers];
    let paired = false;
    for (const then of carriersOf(parent, affected)) {
      // Under one carrier both go in the same delete, the org's own cascade.
      if (ownCarriers.has(then)) continue;
      for (const first of firsts) {
        if (first === then) continue;
        constraints.push({ first, then, reason: 'restricted' });
        paired = true;
      }
    }
    if (paired) beforeParent.push({ objectApiName: child, field, parent, reason: 'restricted' });
  }
  if (affected.emptied.has(PRICE_BOOK) && affected.emptied.has(PRODUCT)) {
    constraints.push({ first: PRICE_BOOK, then: PRODUCT, reason: 'customPrices' });
    if (deleted(PRICE)) {
      beforeParent.push({
        objectApiName: PRICE,
        field: 'Product2Id',
        parent: PRODUCT,
        reason: 'customPrices',
      });
    }
  }
  return { constraints, beforeParent };
}

/** Whether `field` names one of the reasons a tie of {@link emptyOrderOf} stands for. */
function isOrderReason(field: string): field is OrderReason {
  return Object.hasOwn(FIRMNESS, field);
}

/**
 * The passes of `affected`'s emptied objects, in order, and what the order
 * says: see the module's comment.
 *
 * @param relations - The lookups the emptied objects' describes and those of
 *   the objects going along list.
 */
export function emptyOrderOf(affected: Affected, relations: readonly Relation[]): EmptyOrder {
  const { constraints, beforeParent } = orderConstraintsOf(affected, relations);
  const names = [...affected.emptied].sort();
  // Each constraint stands as a tie that places its two objects so — a
  // parent first for records that go along, a child first otherwise — the
  // reason in the tie's field, which nothing else reads.
  const ties = new Map<string, DescribedRelationship[]>(names.map((name) => [name, []]));
  for (const { first, then, reason } of constraints) {
    if (reason === 'cascade') {
      ties.get(first)?.push({ childSObject: then, field: reason, cascadeDelete: true });
    } else {
      ties.get(then)?.push({ childSObject: first, field: reason });
    }
  }
  const describes = new Map<string, CheckpointDescribe>(
    names.map((name) => [name, { name, fields: [], childRelationships: ties.get(name) ?? [] }]),
  );
  const ordered = childrenFirst(names, describes, ({ field }) => {
    const reason = isOrderReason(field) ? field : 'lookup';
    return { first: reason === 'cascade' ? 'parent' : 'child', firmness: FIRMNESS[reason] };
  });
  const place = new Map(ordered.map((name, at) => [name, at]));
  const before = (a: string, b: string): boolean => (place.get(a) ?? 0) < (place.get(b) ?? 0);
  const passes = ordered.map((objectApiName) => {
    const routes = affected.routes.get(objectApiName) ?? [];
    return {
      objectApiName,
      goneBefore: routes.filter((route) => before(route.emptied, objectApiName)),
      sentBeforeTheirParent: routes.filter((route) => !before(route.emptied, objectApiName)),
    };
  });
  return {
    passes,
    beforeParent,
    unordered: dedupe(constraints.filter(({ first, then }) => !before(first, then))),
    toDraft: setBackToDraftOf([...names, ...affected.along]),
  };
}

/** `constraints` once each, in the order first met. */
function dedupe(constraints: readonly OrderConstraint[]): OrderConstraint[] {
  const seen = new Set<string>();
  return constraints.filter(({ first, then, reason }) => {
    const key = `${first}\u0000${then}\u0000${reason}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
