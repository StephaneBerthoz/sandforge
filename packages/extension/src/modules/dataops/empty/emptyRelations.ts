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
      const child = names(relationship.childSObject);
      const field = describes.get(child)
        ? fieldOf(describes, child, relationship.field)
        : undefined;
      if (namesAnotherObject(field, parent)) continue;
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
 * Routes of more than one lookup read into one object at most. Its direct
 * lookups to emptied objects are read whatever their number, and first: an
 * object that many emptied ones take along by that many longer paths is
 * counted by the first of those, the count then saying it may count less than
 * goes, and through which objects the routes it left were.
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
  /**
   * Objects some of whose routes were not read — past {@link MOST_ROUTES}, or
   * up an object whose routes were not all read — each with the objects those
   * routes went through, in code-unit order: a count of it may count less.
   */
  routesCut: ReadonlyMap<string, readonly string[]>;
  /**
   * Objects going along that were not described: what goes along with them
   * is not read until they are.
   */
  undescribed: string[];
}

/**
 * Whether a lookup a parent lists among its children names other objects
 * alone: with person accounts, an account's describe lists its person
 * contact's children (`PersonOpportunityContactRoles`, on a role's
 * ContactId), whose lookup names a contact, never an account. A route up it
 * compared contact ids to account ids, and a role under an account what
 * blocks keeps was counted as going (13/11). The route through the contact,
 * which goes with its account, reads those roles. A lookup not described is
 * kept, as before.
 */
function namesAnotherObject(
  field: { referenceTo?: readonly string[] | null; polymorphicForeignKey?: boolean } | undefined,
  parent: string,
): boolean {
  // A lookup that may point at several objects names one where it names
  // more (an operation log's related record lists an asset alone): kept.
  if (field?.polymorphicForeignKey === true) return false;
  const to = field?.referenceTo ?? [];
  return to.length > 0 && !to.some((name) => name.toLowerCase() === parent.toLowerCase());
}

/** Whether `field` of `objectApiName`, as described, may point at several objects. */
function pointsAtSeveral(
  describes: ReadonlyMap<string, EmptyDescribe>,
  objectApiName: string,
  field: string,
): boolean {
  const described = fieldOf(describes, objectApiName, field);
  return (described?.referenceTo?.length ?? 0) > 1 || described?.polymorphicForeignKey === true;
}

/**
 * What deleting `emptied` takes along, among the objects people work in
 * (`worked`): every object one of whose lookups takes its records along from
 * an emptied object, or from one going along already, up to
 * {@link MOST_ROUTE_STEPS} lookups from an emptied object. An emptied object
 * met on the way ends the route: what hangs from it goes with it, read from
 * it.
 *
 * The routes are read a level at a time, every emptied object's direct
 * lookups before any longer path: read down each lookup in turn, a contact's
 * asset, its fourth, and the assets' own children filled the routes of a
 * task and an event before their own lookups to the contact were reached, the
 * 26th and the 38th, and the count missed the one task and the one event
 * that went with their contacts. Past {@link MOST_ROUTES}, the longer routes
 * are left, and said: so is an object read up one whose routes were not all
 * read, unless its own lookup to that one may point at several objects —
 * then it is read by the type of what it names, whichever way that goes.
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
  const routesCut = new Map<string, Set<string>>();
  const undescribed = new Set<string>();
  const cut = (object: string, through: string): void => {
    const known = routesCut.get(object) ?? new Set<string>();
    known.add(through);
    routesCut.set(object, known);
  };

  let level: Array<{ top: string; from: string; above: readonly RouteStep[] }> = emptied.map(
    (name) => ({ top: name, from: name, above: [] }),
  );
  while (level.length > 0) {
    const next: typeof level = [];
    for (const { top, from, above } of level) {
      const described = describeOf(from);
      if (!described) {
        undescribed.add(from);
        continue;
      }
      for (const relationship of described.childRelationships ?? []) {
        if (relationKindOf(relationship, from) !== 'cascade') continue;
        const child = nameOf(relationship.childSObject);
        const childDescribed = describeOf(child);
        const field = childDescribed?.fields.find(
          (candidate) => candidate.name.toLowerCase() === relationship.field.toLowerCase(),
        );
        if (namesAnotherObject(field, from)) continue;
        const key = child.toLowerCase();
        if (!isWorked.has(key) || key === from.toLowerCase()) continue;
        if (above.some((step) => step.object.toLowerCase() === key)) continue;
        const steps = [{ object: child, field: relationship.field, parent: from }, ...above];
        const known = routes.get(child) ?? [];
        if (steps.length > 1 && known.length >= MOST_ROUTES) {
          cut(child, from);
          continue;
        }
        routes.set(child, [...known, { object: child, steps, emptied: top }]);
        if (isEmptied.has(key) || steps.length >= MOST_ROUTE_STEPS) continue;
        next.push({ top, from: child, above: steps });
      }
    }
    level = next;
  }

  // An object read up one whose routes were not all read misses what came
  // that way, unless a lookup below it reads by type, whichever way it goes.
  for (let changed = true; changed;) {
    changed = false;
    for (const [object, its] of routes) {
      for (const route of its) {
        for (const [at, step] of route.steps.entries()) {
          if (at === 0 || !routesCut.has(step.object)) continue;
          const byType = route.steps
            .slice(0, at)
            .some((below) => pointsAtSeveral(describes, below.object, below.field));
          if (byType || routesCut.get(object)?.has(step.object)) continue;
          cut(object, step.object);
          changed = true;
        }
      }
    }
  }

  const along = [...routes.keys()].filter((name) => !isEmptied.has(name.toLowerCase())).sort();
  return {
    emptied: new Set(emptied),
    routes,
    along,
    routesCut: new Map(
      [...routesCut].map(([object, through]) => [object, [...through].sort()] as const),
    ),
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

/**
 * Of an emptied object, the records what blocks keeps — an account a case
 * names —, as a count reads around them: their ids, when few enough to name
 * in a statement, or `'unnamed'` when they are more, and a count through them
 * then says it may count more than goes. Its delete refused, such a record
 * stays, and so does everything that hangs from it.
 */
export type KeptRecords = readonly string[] | 'unnamed';

/**
 * `condition`, read up to the lookup `lookup` of a record of an emptied
 * object, less what names a record of it that `keeps` says stays: the lookup
 * named apart from their ids. A semi-join (`NOT IN (SELECT …)`) would read
 * them without ids, but the org takes no path of lookups on its left and
 * none of it beside an OR, and a route of two lookups or more — an order
 * product, through its order, to an account — needs both.
 */
function withoutKept(
  condition: Condition,
  lookup: string,
  keeps: KeptRecords | undefined,
): Condition {
  if (keeps === undefined) return condition;
  if (keeps === 'unnamed') return { ...condition, exact: false };
  if (keeps.length === 0) return condition;
  const listed = keeps.map((id) => `'${id}'`).join(', ');
  return { soql: `${condition.soql} AND ${lookup} NOT IN (${listed})`, exact: condition.exact };
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
 * @param kept - Of the object a lookup names where the path ends — the
 *   emptied one at its top, or the one going along where it stops short —,
 *   the records that stay ({@link KeptRecords}): what names one of them by
 *   that lookup is left out, as it stays with them.
 */
export function stepsCondition(
  steps: readonly RouteStep[],
  describes: ReadonlyMap<string, EmptyDescribe>,
  deletedRows: (objectApiName: string) => string | undefined = deletedRowsOf,
  kept: (objectApiName: string) => KeptRecords | undefined = () => undefined,
): Condition | undefined {
  const path: string[] = [];
  /** The path ending at `lookup`, which names a record of `parent`: filled, and naming none that stays. */
  const endsAt = (soql: string, exact: boolean, lookup: string, parent: string): Condition =>
    withoutKept({ soql, exact }, lookup, kept(parent));
  for (const [at, step] of steps.entries()) {
    if (!describes.has(step.object)) {
      const lookup = [...path, step.field].join('.');
      return endsAt(`${lookup} != null`, false, lookup, step.parent);
    }
    const field = fieldOf(describes, step.object, step.field);
    if (!field) {
      if (at === 0) return undefined;
      const previous = steps[at - 1];
      const lookup = [...path.slice(0, -1), previous.field].join('.');
      return endsAt(`${lookup} != null`, false, lookup, previous.parent);
    }
    const polymorphic =
      (field.referenceTo?.length ?? 0) > 1 || field.polymorphicForeignKey === true;
    const relationship = field.relationshipName ?? undefined;
    const last = at === steps.length - 1;
    const through = relationship ? [...path, relationship].join('.') : undefined;
    const lookup = [...path, field.name].join('.');
    if (polymorphic) {
      if (!through) return endsAt(`${lookup} != null`, false, lookup, step.parent);
      return endsAt(`${through}.Type = '${step.parent}'`, last, lookup, step.parent);
    }
    if (last) {
      const deleted = deletedRows(step.parent);
      if (deleted === undefined && !READ_PRESENT.has(step.parent.toLowerCase()))
        return endsAt(`${lookup} != null`, true, lookup, step.parent);
      if (!through) return endsAt(`${lookup} != null`, false, lookup, step.parent);
      const rows = deleted !== undefined ? ` AND ${through}.${deleted}` : '';
      return endsAt(`${through}.Id != null${rows}`, true, lookup, step.parent);
    }
    if (!relationship || at + 1 >= MOST_ROUTE_STEPS) {
      return endsAt(`${lookup} != null`, false, lookup, step.parent);
    }
    path.push(relationship);
  }
  return undefined;
}

/**
 * The condition that a record of `steps[0].object` hangs, up `steps`, from
 * one of `ids`, records of the object at the top: its last lookup naming one
 * of them. Nothing when the path stops short of that lookup — through one
 * that may point at several objects, past five levels, through a field the
 * user cannot see —: no statement then reads which records hang from them.
 */
export function hangsFromCondition(
  steps: readonly RouteStep[],
  describes: ReadonlyMap<string, EmptyDescribe>,
  ids: readonly string[],
): string | undefined {
  const path: string[] = [];
  for (const [at, step] of steps.entries()) {
    const field = describes.has(step.object)
      ? fieldOf(describes, step.object, step.field)
      : undefined;
    if (!field) return undefined;
    const lookup = [...path, field.name].join('.');
    if (at === steps.length - 1) return `${lookup} IN (${ids.map((id) => `'${id}'`).join(', ')})`;
    const polymorphic =
      (field.referenceTo?.length ?? 0) > 1 || field.polymorphicForeignKey === true;
    if (polymorphic || !field.relationshipName || at + 1 >= MOST_ROUTE_STEPS) return undefined;
    path.push(field.relationshipName);
  }
  return undefined;
}

/**
 * The condition that a record goes by any of `routes`, each route's own in
 * parentheses, joined by OR, each once: routes up a lookup that reads by type
 * read alike past it, and an attachment's count named an event's type three
 * times. Nothing when no route reads.
 */
export function anyRouteCondition(
  routes: readonly Route[],
  describes: ReadonlyMap<string, EmptyDescribe>,
  deletedRows: (objectApiName: string) => string | undefined = deletedRowsOf,
  kept?: (objectApiName: string) => KeptRecords | undefined,
): Condition | undefined {
  const read = routes
    .map((route) => stepsCondition(route.steps, describes, deletedRows, kept))
    .filter((condition): condition is Condition => condition !== undefined);
  if (read.length === 0) return undefined;
  if (read.length === 1) return read[0];
  const exact = read.every((condition) => condition.exact) && read.length === routes.length;
  const conditions = [...new Set(read.map((condition) => condition.soql))];
  if (conditions.length === 1) return { soql: conditions[0], exact };
  return { soql: conditions.map((soql) => `(${soql})`).join(' OR '), exact };
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
  kept?: (objectApiName: string) => KeptRecords | undefined,
): Condition | undefined {
  const first: RouteStep = { object: child, field, parent };
  if (affected.emptied.has(parent)) return stepsCondition([first], describes, deletedRows, kept);
  const routes = (affected.routes.get(parent) ?? []).map((route) => ({
    object: child,
    steps: [first, ...route.steps],
    emptied: route.emptied,
  }));
  return anyRouteCondition(routes, describes, deletedRows, kept);
}
