/**
 * What deleting whole tables does beyond them, read from the objects'
 * describes: which records go along with an emptied object's, by which
 * lookups and from which emptied object at the top, and how a count reads
 * them without a list of ids.
 *
 * A parent's describe lists, for each lookup that points at it, whether its
 * delete takes the records along (`cascadeDelete`) or is refused while one
 * lives (`restrictedDelete`); the field describe of a standard lookup such as
 * a contact's account says neither. Both flags may be set: an order's
 * account, an entitlement's, a price's product. The org then takes the
 * records along unless one of them stands in the way — an activated order
 * refuses its account's delete — so such a lookup is read as one that takes
 * them along, as the removal and the checkpoint read it (`ForgeRunRemoval`,
 * `restrictParentsOf`), save where the org was seen to refuse the parent's
 * delete whatever the records are: an entitlement's account
 * (`REFUSING_CASCADES`, which the checkpoint reads too). Seen on real
 * describes:
 *
 * - an account takes its contacts, opportunities, orders, contracts, assets,
 *   activities, notes and attachments along, and refuses its delete while a
 *   case names it;
 * - a contact refuses its delete while a case, an order's bill-to or ship-to
 *   contact, a contract's signer, a consent or a portal user names it;
 * - a price book takes its prices along, and refuses its delete while an
 *   opportunity, a quote, an order or a contract names it;
 * - a product takes its prices along, and refuses its delete while an order
 *   product, a quote line or an asset names it.
 *
 * A count of what goes along is one statement per relationship, whatever the
 * table holds: a lookup filled, or a path of lookups up to the emptied object
 * (`Contact.AccountId != null` for a campaign member whose contact goes with
 * its account), never a list of ids. A path the org cannot read — through a
 * lookup that may point at several objects, past five levels, through a field
 * the user cannot see — is cut where it stops being readable, and the count
 * says it may count more than goes.
 *
 * A lookup may point at several objects though its describe names one: an
 * operation log's related record lists an asset alone, and the org read a
 * path through it as through its `Name` entity, refusing an asset's columns
 * ("No such column 'AccountId' on entity 'Name'"). Its describe flags it
 * (`polymorphicForeignKey`), and it is read as the other lookups to several
 * objects are.
 */

import * as z from 'zod';
import { alwaysRefused } from '../../../core/removal/refusingCascades.js';
import { ARCHIVED_ACTIVITIES } from '../../../core/removal/tableIds.js';
import {
  checkpointDescribeSchema,
  checkpointFieldSchema,
} from '../../checkpoint/checkpointFields.js';

/** A field as an emptying reads it: what a count's path through it needs too. */
const emptyFieldSchema = checkpointFieldSchema.extend({
  /** The name a path through the lookup takes: `Account` of `AccountId`, `What` of `WhatId`. */
  relationshipName: z.string().nullish(),
  /** Whether the lookup may point at several objects, whatever `referenceTo` lists. */
  polymorphicForeignKey: z.boolean().optional(),
});

/** An object's describe, as far as an emptying reads it. */
export const emptyDescribeSchema = checkpointDescribeSchema.extend({
  /** Whether the user may delete its records, as the object's own describe says. */
  deletable: z.boolean().optional(),
  fields: z.array(emptyFieldSchema),
});

/** A described object, checked. */
export type EmptyDescribe = z.infer<typeof emptyDescribeSchema>;

/**
 * Whether `objectApiName`'s records are counted through `queryAll`, archived
 * ones included, the recycle bin left out by the statement: a task or an
 * event, as the run reads their ids (`tableIdsQuery`).
 */
export function countedWithArchived(objectApiName: string): boolean {
  return ARCHIVED_ACTIVITIES.has(objectApiName);
}

/**
 * Rows an emptying never deletes, of the objects that have any: the standard
 * price book, found by `IsStandard` and never by its name, which the org
 * gives in the user's language. Every price of every product hangs from it,
 * and a copy matches it in the target rather than makes it.
 */
const KEPT_ROWS: Readonly<Record<string, { field: string; value: boolean }>> = {
  pricebook2: { field: 'IsStandard', value: true },
};

/** The rows of `objectApiName` an emptying keeps, as a condition: nothing when it keeps none. */
export function keptRowsOf(objectApiName: string): string | undefined {
  const kept = KEPT_ROWS[objectApiName.toLowerCase()];
  return kept ? `${kept.field} = ${String(kept.value)}` : undefined;
}

/** The rows of `objectApiName` an emptying deletes, as a condition: nothing when it deletes all. */
export function deletedRowsOf(objectApiName: string): string | undefined {
  const kept = KEPT_ROWS[objectApiName.toLowerCase()];
  return kept ? `${kept.field} = ${String(!kept.value)}` : undefined;
}

/**
 * The parents a lookup was seen to name though the org holds no such record:
 * a price's book and its product — of the 38 prices of a scratch org, 34
 * named neither a book nor a product it could read (`Pricebook2.Id = null`,
 * `Product2.Id = null`: 34 each). A lookup to one of these is read with its
 * parent there (`Product2.Id != null`), never filled alone: filled alone, it
 * counted the 34 as going with the book an emptying deleted, and 38 prices as
 * going with the products emptied, where 4 did.
 */
const READ_PRESENT: ReadonlySet<string> = new Set(['pricebook2', 'product2']);

/**
 * How a lookup ties its records to the record it names when that one is
 * deleted: they go along, the delete is refused while they live, or the
 * lookup is emptied.
 */
export type RelationKind = 'cascade' | 'restricted' | 'lookup';

/** A lookup between two objects, as the parent's describe lists it. */
export interface Relation {
  /** The object the lookup points at. */
  parent: string;
  /** The object holding the lookup. */
  child: string;
  field: string;
  kind: RelationKind;
}

/**
 * How `relationship` ties its records to the parent's: see the module's
 * comment. Given the parent, a lookup the org refuses its delete for whatever
 * the describe says (`REFUSING_CASCADES`, `always`) is read as one that
 * refuses it.
 */
export function relationKindOf(
  relationship: {
    childSObject?: string;
    field?: string;
    cascadeDelete?: boolean;
    restrictedDelete?: boolean;
  },
  parent?: string,
): RelationKind {
  if (
    parent !== undefined &&
    relationship.childSObject !== undefined &&
    relationship.field !== undefined &&
    alwaysRefused(relationship.childSObject, relationship.field, parent)
  ) {
    return 'restricted';
  }
  if (relationship.cascadeDelete === true) return 'cascade';
  if (relationship.restrictedDelete === true) return 'restricted';
  return 'lookup';
}

/**
 * Every lookup the described objects list as their children's, each named
 * by the names `names` gives where it knows the object: what the org lists
 * of a child and what its global describe calls it may differ in case.
 */
export function relationsOf(
  describes: ReadonlyMap<string, EmptyDescribe>,
  names: (objectApiName: string) => string = (name) => name,
): Relation[] {
  const relations: Relation[] = [];
  for (const [parent, described] of describes) {
    for (const relationship of described.childRelationships ?? []) {
      relations.push({
        parent,
        child: names(relationship.childSObject),
        field: relationship.field,
        kind: relationKindOf(relationship, parent),
      });
    }
  }
  return relations;
}

/** One lookup a route goes up: a field of `object`, pointing at `parent`. */
export interface RouteStep {
  object: string;
  field: string;
  parent: string;
}

/**
 * A way records of `object` go with those of an emptied object: up its
 * lookups that take them along, `steps` from `object` to `emptied`.
 */
export interface Route {
  object: string;
  steps: readonly RouteStep[];
  emptied: string;
}

/**
 * Lookups a path of a count goes up at most: the org reads five levels of
 * parents in a statement.
 */
export const MOST_ROUTE_STEPS = 5;

/**
 * Routes read into one object at most. An object that many emptied ones take
 * along by that many paths is counted by the first, the count then saying it
 * may count less than goes.
 */
export const MOST_ROUTES = 8;

/** What deleting the emptied objects' records takes with them. */
export interface Affected {
  /** The objects emptied. */
  emptied: ReadonlySet<string>;
  /**
   * Per object whose records go with an emptied object's, emptied or not, the
   * routes they go by, from the emptied objects at their tops: an emptied
   * object's routes come from other emptied objects.
   */
  routes: ReadonlyMap<string, readonly Route[]>;
  /** The objects not emptied whose records go along, in code-unit order. */
  along: string[];
  /** Objects some of whose routes were not read: past {@link MOST_ROUTES}. */
  routesCut: ReadonlySet<string>;
  /**
   * Objects going along that were not described: what goes along with them
   * is not read until they are.
   */
  undescribed: string[];
}

/**
 * What deleting `emptied` takes along, among the objects people work in
 * (`worked`): every object one of whose lookups takes its records along from
 * an emptied object, or from one going along already, up to
 * {@link MOST_ROUTE_STEPS} lookups from an emptied object. An emptied object
 * met on the way ends the route: what hangs from it goes with it, read from
 * it.
 *
 * @param describes - The objects described, emptied ones and those going along.
 */
export function affectedBy(
  emptied: readonly string[],
  worked: readonly string[],
  describes: ReadonlyMap<string, EmptyDescribe>,
): Affected {
  const canonical = new Map<string, string>();
  for (const name of [...worked, ...emptied, ...describes.keys()]) {
    canonical.set(name.toLowerCase(), name);
  }
  const nameOf = (name: string): string => canonical.get(name.toLowerCase()) ?? name;
  const describeOf = (name: string): EmptyDescribe | undefined =>
    describes.get(name) ?? describes.get(nameOf(name));
  const isEmptied = new Set(emptied.map((name) => name.toLowerCase()));
  const isWorked = new Set([...worked, ...emptied].map((name) => name.toLowerCase()));
  const routes = new Map<string, Route[]>();
  const routesCut = new Set<string>();
  const undescribed = new Set<string>();

  const walk = (top: string, from: string, above: readonly RouteStep[]): void => {
    const described = describeOf(from);
    if (!described) {
      undescribed.add(from);
      return;
    }
    for (const relationship of described.childRelationships ?? []) {
      if (relationKindOf(relationship, from) !== 'cascade') continue;
      const child = nameOf(relationship.childSObject);
      const key = child.toLowerCase();
      if (!isWorked.has(key) || key === from.toLowerCase()) continue;
      if (above.some((step) => step.object.toLowerCase() === key)) continue;
      const steps = [{ object: child, field: relationship.field, parent: from }, ...above];
      const known = routes.get(child) ?? [];
      if (known.length >= MOST_ROUTES) {
        routesCut.add(child);
        continue;
      }
      routes.set(child, [...known, { object: child, steps, emptied: top }]);
      if (isEmptied.has(key) || steps.length >= MOST_ROUTE_STEPS) continue;
      walk(top, child, steps);
    }
  };
  for (const name of emptied) walk(name, name, []);

  const along = [...routes.keys()].filter((name) => !isEmptied.has(name.toLowerCase())).sort();
  return {
    emptied: new Set(emptied),
    routes,
    along,
    routesCut,
    undescribed: [...undescribed].filter((name) => !isEmptied.has(name.toLowerCase())).sort(),
  };
}

/**
 * The emptied objects whose deletes take records of `objectApiName` away,
 * itself among them when it is emptied: the tops of its routes, and theirs
 * up the lookups that take records along. What it holds goes at the first of
 * them the order reaches.
 */
export function carriersOf(objectApiName: string, affected: Affected): Set<string> {
  const carriers = new Set<string>();
  const seen = new Set<string>();
  const visit = (name: string): void => {
    if (seen.has(name)) return;
    seen.add(name);
    if (affected.emptied.has(name)) carriers.add(name);
    for (const route of affected.routes.get(name) ?? []) visit(route.emptied);
  };
  visit(objectApiName);
  return carriers;
}

/** A condition of a count, and whether it counts exactly what it names. */
export interface Condition {
  soql: string;
  /** False when the path was cut where the org could not read it: it may count more. */
  exact: boolean;
}

/** A field of `objectApiName` as described, when it is. */
function fieldOf(
  describes: ReadonlyMap<string, EmptyDescribe>,
  objectApiName: string,
  field: string,
): z.infer<typeof emptyFieldSchema> | undefined {
  const key = field.toLowerCase();
  return describes
    .get(objectApiName)
    ?.fields.find((candidate) => candidate.name.toLowerCase() === key);
}

/**
 * The condition that a record of `steps[0].object` goes up `steps` to a
 * record that is deleted: the last lookup filled — with a row its object
 * deletes, for the price book — read through the relationship names of the
 * lookups below it. A lookup that may point at several objects is read by
 * the type of what it names (`What.Type = 'Account'`), and no path goes on
 * through it: the org reads only that much of such a parent. Where the path
 * stops being readable, the condition is the lookup it stopped at, filled,
 * and says it may count more; an object not described is read so too, at
 * its lookup. Nothing when the first object's describe lists no such field:
 * one field-level security hides from the user is in no statement the org
 * takes.
 *
 * A row its object deletes is read with its parent there: the org reads
 * `Pricebook2.IsStandard = false` true of a record whose price book is not
 * there at all — no lookup filled, or one naming a book gone — and counted 36
 * prices under the book an emptying deleted, where 2 hung from it (34 named
 * none it could read, `Pricebook2.Id = null`). So is a lookup to a parent
 * whose records were seen named by records it no longer holds
 * ({@link READ_PRESENT}): a price's product, `Product2.Id != null`.
 *
 * @param deletedRows - The rows of an object the emptying deletes, as a
 *   condition, nothing when it deletes all: {@link deletedRowsOf} unless the
 *   emptying says more — a person account's contact stays with its account.
 */
export function stepsCondition(
  steps: readonly RouteStep[],
  describes: ReadonlyMap<string, EmptyDescribe>,
  deletedRows: (objectApiName: string) => string | undefined = deletedRowsOf,
): Condition | undefined {
  const path: string[] = [];
  for (const [at, step] of steps.entries()) {
    if (!describes.has(step.object)) {
      return { soql: `${[...path, step.field].join('.')} != null`, exact: false };
    }
    const field = fieldOf(describes, step.object, step.field);
    if (!field) {
      if (at === 0) return undefined;
      const previous = steps[at - 1];
      return { soql: `${[...path.slice(0, -1), previous.field].join('.')} != null`, exact: false };
    }
    const polymorphic =
      (field.referenceTo?.length ?? 0) > 1 || field.polymorphicForeignKey === true;
    const relationship = field.relationshipName ?? undefined;
    const last = at === steps.length - 1;
    const through = relationship ? [...path, relationship].join('.') : undefined;
    if (polymorphic) {
      if (!through) return { soql: `${[...path, field.name].join('.')} != null`, exact: false };
      return { soql: `${through}.Type = '${step.parent}'`, exact: last };
    }
    if (last) {
      const deleted = deletedRows(step.parent);
      if (deleted === undefined && !READ_PRESENT.has(step.parent.toLowerCase()))
        return { soql: `${[...path, field.name].join('.')} != null`, exact: true };
      if (!through) return { soql: `${[...path, field.name].join('.')} != null`, exact: false };
      const rows = deleted !== undefined ? ` AND ${through}.${deleted}` : '';
      return { soql: `${through}.Id != null${rows}`, exact: true };
    }
    if (!relationship || at + 1 >= MOST_ROUTE_STEPS) {
      return { soql: `${[...path, field.name].join('.')} != null`, exact: false };
    }
    path.push(relationship);
  }
  return undefined;
}

/**
 * The condition that a record goes by any of `routes`, each route's own in
 * parentheses, joined by OR; nothing when no route reads.
 */
export function anyRouteCondition(
  routes: readonly Route[],
  describes: ReadonlyMap<string, EmptyDescribe>,
  deletedRows: (objectApiName: string) => string | undefined = deletedRowsOf,
): Condition | undefined {
  const conditions = routes
    .map((route) => stepsCondition(route.steps, describes, deletedRows))
    .filter((condition): condition is Condition => condition !== undefined);
  if (conditions.length === 0) return undefined;
  if (conditions.length === 1) return conditions[0];
  return {
    soql: conditions.map((condition) => `(${condition.soql})`).join(' OR '),
    exact: conditions.every((condition) => condition.exact) && conditions.length === routes.length,
  };
}

/**
 * The condition that a record of `child` names, through `field`, a record
 * of `parent` that is deleted: the field filled when `parent` is emptied —
 * with a row it deletes, for the price book — or, when its records go along
 * with an emptied object's, the field and then one of `parent`'s routes up.
 */
export function namesDeletedCondition(
  child: string,
  field: string,
  parent: string,
  affected: Affected,
  describes: ReadonlyMap<string, EmptyDescribe>,
  deletedRows: (objectApiName: string) => string | undefined = deletedRowsOf,
): Condition | undefined {
  const first: RouteStep = { object: child, field, parent };
  if (affected.emptied.has(parent)) return stepsCondition([first], describes, deletedRows);
  const routes = (affected.routes.get(parent) ?? []).map((route) => ({
    object: child,
    steps: [first, ...route.steps],
    emptied: route.emptied,
  }));
  return anyRouteCondition(routes, describes, deletedRows);
}
