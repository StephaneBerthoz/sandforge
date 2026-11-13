/**
 * How a sample of the whole org reads the objects of the run and the lookups
 * between them: which objects it copies whole, which it draws, and what each
 * lookup does to the record that holds it.
 *
 * Objects copied whole draw nothing and carry no draw down: every record of
 * theirs is in, and a lookup to one leaves the record that holds it a root.
 * Taken for a way down, a lookup to a reference object of thirty regions
 * made the accounts that name a region come only under the few regions
 * drawn, a hundred at most each; and a table copied whole that carried the
 * draw down let every record that names it in. Copied whole are:
 *
 * - the reference data the run matches by name and never writes;
 * - the price catalog, when it all fits a quarter of the room and each of
 *   its objects the records an object may be read whole in. Otherwise it is
 *   never drawn: its records come as the records the sample keeps name them;
 * - the small parents: an object that drawn objects name, of few records,
 *   that needs no drawn record to be written. The smallest first, as long as
 *   they all fit a quarter of the room;
 * - the objects asked whole (`--fit-whole`).
 *
 * The room these are chosen against is the target's, never the bound asked
 * of the run: a smaller `--fit-within` or `--max-total` then copies the same
 * objects whole, and keeps a part of what a larger one keeps.
 *
 * A lookup of a drawn object at another is a way down (it carries the draw)
 * when the record cannot be written without it, or when its parent is
 * written first: an account's contacts come under it. One at its own object,
 * or at an object written after it, is filled by the second pass, and owed.
 * A lookup that may name several objects is told value by value, by the key
 * prefix of the id it holds. A lookup at an object outside the run changes
 * nothing, but one a record cannot be written without at an object the user
 * left out: that record is left out with it. A lookup no write can set is the
 * platform's to fill, and read as none.
 */

import {
  isInsertOnlyField,
  isRequiredLookup,
  isSettableField,
  type WholeOrgSampleWhole,
  type WholeOrgSampleWholeReason,
} from '@sandforge/shared';
import { insertionGroups, orderWithinGroup } from '../../../core/common/insertionOrder.js';
import type { FieldDescribe } from '../GraphDiscoveryService.js';
import { CATALOG_OBJECTS } from '../stages/ScopeResolver.js';

/** A field of an object of the run, as the source describes it. */
export type SampleField = Pick<
  FieldDescribe,
  'name' | 'referenceTo' | 'isMasterDetail' | 'nillable' | 'createable' | 'updateable'
>;

/** An object of the run, as a sample reads it. */
export interface SampleObjectInput {
  objectApiName: string;
  /** The records the source holds, as discovery counted them; undefined when nobody could. */
  rows: number | undefined;
  /**
   * What every id of its records begins with: how a lookup that may name
   * several objects tells which it names. Null when unknown: such a lookup
   * then never names it.
   */
  keyPrefix?: string | null;
  fields: readonly SampleField[];
}

/** What the objects copied whole are chosen against, and the objects asked. */
export interface SampleLinksInput {
  objects: readonly SampleObjectInput[];
  /**
   * The objects in the order the run writes them. Absent, the order is the
   * one parents-first gives, each cycle in the order its lookups a record
   * cannot be written without leave it.
   */
  order?: readonly string[];
  /** The objects the user left out by name, with their key prefix when known. */
  excluded?: ReadonlyMap<string, string | null>;
  /** The objects the run matches by name in the target and never writes. */
  referenceData?: ReadonlySet<string>;
  /** The objects asked whole (`--fit-whole`). */
  whole?: readonly string[];
  /**
   * The bytes of the target's room: what the target has left that a sample
   * may take, the bound asked of the run left out. The objects copied whole
   * are chosen against it, and so are the roots set aside as too heavy.
   */
  roomBytes: number;
  /** The most records an object is read whole in (`maxRecordsPerObject`); absent when unbounded. */
  maxRecordsPerObject?: number;
  /** The bytes every record of an object takes, copied whole. */
  wholeBytes: (objectApiName: string, rows: number) => number;
}

/**
 * How a sample takes an object: whole, every record of it; or drawn, its
 * records kept by the draw — from its roots (`rooted`), or, of a catalog
 * too big to copy whole, only as the records kept name them.
 */
export type SampleObjectClass =
  { kind: 'whole'; why: WholeOrgSampleWholeReason } | { kind: 'drawn'; rooted: boolean };

/**
 * A lookup of an object of the run (`objectApiName.field`) at one object it
 * may name (`parent`), and what it does in a sample:
 *
 * - `carries`: the draw goes down it — a record of the parent drawn or
 *   reached from above brings the records that name it, and a record that
 *   holds it filled is no root;
 * - `owed`: the second pass fills it — a lookup at its own object, or at an
 *   object written after;
 * - `required`: the record cannot be written without it, as the platform has
 *   it (`isRequiredLookup`), or as a master-detail.
 *
 * `target` says what the parent is: `drawn`, its records read as they are
 * named; `whole`, all in; `excluded`, an object the user left out — set only
 * on a required lookup, whose record goes with it.
 */
export interface SampleLink {
  objectApiName: string;
  field: string;
  parent: string;
  target: 'drawn' | 'whole' | 'excluded';
  carries: boolean;
  owed: boolean;
  required: boolean;
  masterDetail: boolean;
  /**
   * Of a lookup that may name several objects, what an id of `parent`
   * begins with; null when unknown, and such a value then names none.
   * Absent on a lookup that names one object: any value names it.
   */
  prefix?: string | null;
}

/** The objects and lookups of a sample: see {@link sampleLinksOf}. */
export interface SampleLinks {
  classes: ReadonlyMap<string, SampleObjectClass>;
  /** The objects copied whole, and why, by name. */
  whole: WholeOrgSampleWhole[];
  /** Per object, its own lookups, by field then parent. */
  linksOf: ReadonlyMap<string, readonly SampleLink[]>;
  /** Per object, the lookups that carry the draw down to it from its records: its relations as a parent. */
  carriersInto: ReadonlyMap<string, readonly SampleLink[]>;
  /** The objects in the order the run writes them. */
  order: readonly string[];
}

/** A small parent is no bigger than this, or a hundredth of the records the room holds when that is more. */
export const SMALL_PARENT_RECORDS = 100;

/** The share of the room the catalog may take copied whole, and the small parents together. */
export const WHOLE_SHARE = 0.25;

/** The size of a typical record, which the records the room holds are counted at: 2 KB. */
const TYPICAL_RECORD_BYTES = 2048;

/** Whether `value` names a record of the lookup's parent. */
export function namesParent(value: unknown, link: Pick<SampleLink, 'prefix'>): value is string {
  if (typeof value !== 'string' || value === '') return false;
  return link.prefix === undefined || (link.prefix !== null && value.startsWith(link.prefix));
}

/**
 * The order parents-first gives the objects, each cycle in the order the
 * lookups its records cannot be written without, or that only an insert sets,
 * leave it: `insertionOrder.ts`, as the other modules order their writes.
 */
function parentsFirst(objects: readonly SampleObjectInput[]): string[] {
  const names = new Set(objects.map((o) => o.objectApiName));
  const deps = new Map<string, Set<string>>();
  const atInsert = new Map<string, Set<string>>();
  for (const object of objects) {
    const parents = new Set<string>();
    const first = new Set<string>();
    for (const field of object.fields) {
      if (field.referenceTo.length === 0 || !isSettableField(field)) continue;
      const before =
        field.isMasterDetail ||
        isRequiredLookup(object.objectApiName, field.name, field.nillable) ||
        isInsertOnlyField(field);
      for (const parent of field.referenceTo) {
        if (parent === object.objectApiName || !names.has(parent)) continue;
        parents.add(parent);
        if (before) first.add(parent);
      }
    }
    deps.set(object.objectApiName, parents);
    atInsert.set(object.objectApiName, first);
  }
  return insertionGroups(deps).flatMap((group) =>
    group.length > 1 ? orderWithinGroup(group, atInsert) : group,
  );
}

/** Whether the field holds a lookup a record cannot be written without. */
function requiredOf(objectApiName: string, field: SampleField): boolean {
  return field.isMasterDetail || isRequiredLookup(objectApiName, field.name, field.nillable);
}

/** The objects a sample copies whole, and why: see the file's header. */
function wholeObjectsOf(input: SampleLinksInput): Map<string, WholeOrgSampleWholeReason> {
  const nodes = new Map(input.objects.map((o) => [o.objectApiName, o]));
  const whole = new Map<string, WholeOrgSampleWholeReason>();
  for (const name of nodes.keys()) {
    if (input.referenceData?.has(name)) whole.set(name, 'referenceData');
  }
  for (const name of input.whole ?? []) {
    if (nodes.has(name) && !whole.has(name)) whole.set(name, 'asked');
  }
  const quarter = WHOLE_SHARE * Math.max(0, input.roomBytes);
  const sizeOf = (object: SampleObjectInput): number | undefined =>
    object.rows === undefined ? undefined : input.wholeBytes(object.objectApiName, object.rows);

  const catalog = [...nodes.values()].filter(
    (o) => CATALOG_OBJECTS.has(o.objectApiName) && !whole.has(o.objectApiName),
  );
  const catalogBytes = catalog.reduce<number | undefined>((sum, object) => {
    const size = sizeOf(object);
    return sum === undefined || size === undefined ? undefined : sum + size;
  }, 0);
  const catalogFits =
    catalog.length > 0 &&
    catalogBytes !== undefined &&
    catalogBytes <= quarter &&
    catalog.every(
      (o) => input.maxRecordsPerObject === undefined || (o.rows ?? 0) <= input.maxRecordsPerObject,
    );
  if (catalogFits) for (const object of catalog) whole.set(object.objectApiName, 'catalog');

  const smallest = Math.max(
    SMALL_PARENT_RECORDS,
    Math.floor((0.01 * Math.max(0, input.roomBytes)) / TYPICAL_RECORD_BYTES),
  );
  const drawn = (name: string): boolean => nodes.has(name) && !whole.has(name);
  const hasDrawnChild = new Set<string>();
  for (const object of nodes.values()) {
    if (!drawn(object.objectApiName)) continue;
    for (const field of object.fields) {
      if (!isSettableField(field)) continue;
      for (const parent of field.referenceTo) {
        if (parent !== object.objectApiName) hasDrawnChild.add(parent);
      }
    }
  }
  const candidates = [...nodes.values()]
    .filter(
      (o) =>
        !whole.has(o.objectApiName) &&
        !CATALOG_OBJECTS.has(o.objectApiName) &&
        o.rows !== undefined &&
        o.rows > 0 &&
        o.rows <= smallest &&
        (input.maxRecordsPerObject === undefined || o.rows <= input.maxRecordsPerObject) &&
        hasDrawnChild.has(o.objectApiName),
    )
    .map((o) => ({ object: o, bytes: sizeOf(o) ?? Infinity }))
    .sort(
      (a, b) => a.bytes - b.bytes || (a.object.objectApiName < b.object.objectApiName ? -1 : 1),
    );
  let taken = 0;
  for (const { object, bytes } of candidates) {
    if (taken + bytes > quarter) break;
    const needsADrawnRecord = object.fields.some(
      (field) =>
        isSettableField(field) &&
        requiredOf(object.objectApiName, field) &&
        field.referenceTo.some((parent) => drawn(parent)),
    );
    if (needsADrawnRecord) continue;
    whole.set(object.objectApiName, 'smallParent');
    taken += bytes;
  }
  return whole;
}

/**
 * The objects of a sample and its lookups: which objects are copied whole,
 * which drawn, and what each lookup of a record does in it ({@link SampleLink}).
 */
export function sampleLinksOf(input: SampleLinksInput): SampleLinks {
  const nodes = new Map(input.objects.map((o) => [o.objectApiName, o]));
  const wholeOf = wholeObjectsOf(input);
  const catalogWhole = [...wholeOf.values()].includes('catalog');
  const classes = new Map<string, SampleObjectClass>();
  for (const name of nodes.keys()) {
    const why = wholeOf.get(name);
    classes.set(
      name,
      why !== undefined
        ? { kind: 'whole', why }
        : { kind: 'drawn', rooted: !(CATALOG_OBJECTS.has(name) && !catalogWhole) },
    );
  }
  const order = input.order ? [...input.order] : parentsFirst(input.objects);
  const place = new Map(order.map((name, index) => [name, index]));
  const before = (parent: string, child: string): boolean =>
    (place.get(parent) ?? Infinity) < (place.get(child) ?? Infinity);
  const rooted = (name: string): boolean => {
    const kind = classes.get(name);
    return kind?.kind === 'drawn' && kind.rooted;
  };

  const linksOf = new Map<string, SampleLink[]>();
  const carriersInto = new Map<string, SampleLink[]>();
  for (const object of [...nodes.values()].sort((a, b) =>
    a.objectApiName < b.objectApiName ? -1 : 1,
  )) {
    const child = object.objectApiName;
    const own: SampleLink[] = [];
    for (const field of [...object.fields].sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (field.referenceTo.length === 0 || !isSettableField(field)) continue;
      const required = requiredOf(child, field);
      const polymorphic = field.referenceTo.length > 1;
      for (const parent of [...field.referenceTo].sort()) {
        const kind = classes.get(parent);
        const excludedPrefix = input.excluded?.get(parent);
        const prefixOf = (prefix: string | null | undefined): { prefix?: string | null } =>
          polymorphic ? { prefix: prefix ?? null } : {};
        if (!kind) {
          if (required && input.excluded?.has(parent)) {
            own.push({
              objectApiName: child,
              field: field.name,
              parent,
              target: 'excluded',
              carries: false,
              owed: false,
              required,
              masterDetail: field.isMasterDetail,
              ...prefixOf(excludedPrefix),
            });
          }
          continue;
        }
        const self = parent === child;
        const owed = self || !before(parent, child);
        const link: SampleLink = {
          objectApiName: child,
          field: field.name,
          parent,
          target: kind.kind === 'whole' ? 'whole' : 'drawn',
          carries: !self && rooted(parent) && rooted(child) && (required || !owed),
          owed,
          required,
          masterDetail: field.isMasterDetail,
          ...prefixOf(nodes.get(parent)?.keyPrefix),
        };
        own.push(link);
        if (link.carries) {
          const into = carriersInto.get(parent) ?? [];
          into.push(link);
          carriersInto.set(parent, into);
        }
      }
    }
    linksOf.set(child, own);
  }
  return {
    classes,
    whole: [...wholeOf.entries()]
      .map(([objectApiName, why]) => ({ objectApiName, why }))
      .sort((a, b) => (a.objectApiName < b.objectApiName ? -1 : 1)),
    linksOf,
    carriersInto,
    order,
  };
}

/** The lookups of `objectApiName` a sample reads of each of its records, by name. */
export function fieldsToRead(links: SampleLinks, objectApiName: string): string[] {
  return [...new Set((links.linksOf.get(objectApiName) ?? []).map((link) => link.field))].sort();
}

/**
 * What a read of the roots of `objectApiName` asks: the lookups that carry
 * the draw and name one object, to be empty in the statement (`empty`), and
 * those that may name several, whose values are read and told by
 * {@link isRootRow} (`told`): one empty there names nothing, and one that
 * names an object the draw does not reach names nothing either.
 */
export function rootFilterOf(
  links: SampleLinks,
  objectApiName: string,
): { empty: string[]; told: string[] } {
  const carriers = (links.linksOf.get(objectApiName) ?? []).filter((link) => link.carries);
  const empty = new Set<string>();
  const told = new Set<string>();
  for (const link of carriers) (link.prefix === undefined ? empty : told).add(link.field);
  return { empty: [...empty].sort(), told: [...told].sort() };
}

/**
 * Whether a record of `objectApiName` is a root: no lookup that carries the
 * draw names a record, by the values it holds.
 */
export function isRootRow(
  links: SampleLinks,
  objectApiName: string,
  refs: Readonly<Record<string, unknown>>,
): boolean {
  return !(links.linksOf.get(objectApiName) ?? []).some(
    (link) => link.carries && namesParent(refs[link.field], link),
  );
}

/**
 * The link of `objectApiName.field` whose parent `value` names: the one
 * object a lookup names, or the one whose key prefix the value begins with.
 */
export function linkNamed(
  links: SampleLinks,
  objectApiName: string,
  field: string,
  value: unknown,
): SampleLink | undefined {
  return (links.linksOf.get(objectApiName) ?? []).find(
    (link) => link.field === field && namesParent(value, link),
  );
}
