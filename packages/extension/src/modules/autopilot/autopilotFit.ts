/**
 * The records an Autopilot plan keeps to fit what its target has left of its
 * data storage: chosen only when asked (`--fit`, the panel's Fit to storage),
 * said object by object, and held to the run's gate again as any plan.
 *
 * A plan of a client sandbox's accounts and contacts came to 64.5 MB for
 * 22 MB left, and was refused with "leave objects out, lower the records per
 * object": neither is something a person can do to a table copied whole. A
 * seed's counts can be scaled; a copy has to say which records it keeps, and
 * two tables each thinned on their own keep contacts of accounts they cut.
 *
 * Objects are taken in the order the run writes them, one rule at a time:
 *
 * - A lookup holds a record to a parent when the parent is written first: an
 *   object of an earlier wave, or the one that goes first in their cycle
 *   (`writeOrderOf`, the run's own order). A lookup a record cannot be written
 *   without holds it whatever the order. A record whose holding lookup names
 *   a record that was cut is cut with it, counted by lookup.
 * - A record no filled lookup holds is a root: a share of the roots is kept,
 *   spread over the order of the ids (`evenlyKept`), at least one. What follows
 *   a kept parent is kept whole: an account comes with all of its contacts.
 * - Caps come first: a share is taken of what its cap leaves of an object's
 *   roots, and what is kept past the cap, followers too, is thinned at the
 *   same even step.
 * - A self-reference (`ParentId`) and the lookup of a cycle a run fills in
 *   after the wave (`Account`'s key contact) do not hold: cutting along them
 *   would run through a whole hierarchy, or round a cycle for good. They stay
 *   empty and are named, as a lookup out of the plan is.
 * - A parent read by id is never cut: it follows the records that name it.
 *   Its record is read again from the rows kept (`SchemaScanner.walkFrom`);
 *   one that cannot be written without a selected record brings that record
 *   back in, or the parent would be refused and its children with it.
 *
 * The share is the largest that fits, one root at a time: the records, and
 * what the target's automation that still runs creates under them, within the
 * budget (`fitBudgetOf`), their writes within the day's API requests and the
 * run's bound on records. Parents past the first level are estimated at the
 * rate the first falls while the share is sought; the walk then reads them,
 * and when they weigh more than estimated the share falls by that much, three
 * walks at most. The same source gives the same records: a plan and its run
 * agree, where a random draw would not.
 *
 * This file reads no org itself: its caller hands it the rows and the walk.
 * The rows stay in memory for the time of the fit; what remains is the ids
 * kept.
 */

import {
  BYTES_PER_MB,
  PRICEBOOK_OBJECT,
  stillRunningOf,
  type ApiName,
  type AutopilotCannotFit,
  type AutopilotFitEmptied,
  type AutopilotFitHeldBy,
  type AutopilotFitMode,
  type AutopilotFitObject,
  type AutopilotFitOver,
  type AutopilotFitReport,
  type ForgeAutomationWrite,
  type ForgeTargetAutomation,
  type MutePlan,
} from '@sandforge/shared';
import { ACCOUNT, CONTACT, STATUS_LIFECYCLES } from '../../core/common/platformRecords.js';
import {
  automationRoomOf,
  evenlyKept,
  largestFitting,
  roomBytesOf,
  storageFitBudgetOf,
  type AutomationRoom,
  type FitBudget,
} from '../forge/fitBudget.js';
import { countedStorageBytes, formatMBPast, runRequestsEstimate } from '../forge/ForgeRunGate.js';
import {
  PERSON_ACCOUNT_FLAG,
  STANDARD_PRICEBOOK_FLAG,
  lookupsOf,
  type FitRow,
  type FitWalk,
  type ObjectDescribeResult,
  type SchemaScanResult,
} from './SchemaScanner.js';

/** Walks of the parents a fit makes at most before it says so. */
export const FIT_WALKS = 3;

/** What a fit answers when the source no longer holds what the plan said. */
export const SOURCE_CHANGED = 'the source changed since the plan: plan again';

/**
 * A lookup of an object of the plan at a selected object, and what a value
 * of it does to the record that holds it: `holds`, cut with the record it
 * names; `selfReference` or `owed`, left empty when that record is cut.
 */
export interface FitLink {
  objectApiName: ApiName;
  field: string;
  parent: ApiName;
  kind: 'holds' | 'selfReference' | 'owed';
  /**
   * What an id of `parent` begins with, set on a lookup that may point at
   * several objects: only such an id is one of its records. Null for an object
   * with no prefix, whose records such a lookup never says it names.
   */
  prefix?: string | null;
}

/** A lookup of a selected object at an object read by id, whose record follows the row. */
export interface FitOutward {
  objectApiName: ApiName;
  field: string;
  parent: ApiName;
  /** The record cannot be written without it. */
  required: boolean;
  prefix?: string | null;
}

/** The lookups of a plan as a fit reads them: {@link fitLookupsOf}. */
export interface FitLookups {
  /** Between two selected objects. */
  links: FitLink[];
  /** Of the selected objects, at the objects read by id. */
  outward: FitOutward[];
  /** Of the objects read by id, the ones they cannot be written without, at selected objects. */
  requiredOfParents: FitLink[];
}

/** A lookup that holds a record to another of a fitted plan, as a run reads it. */
export type FitHold = Pick<FitLink, 'objectApiName' | 'field' | 'parent' | 'prefix'>;

/**
 * What a fitted run is held to as it reads: a record read that a holding
 * lookup ties to a record outside the plan, since the source moved after the
 * fit, stays out with that record (`AutopilotExecutor`'s `cutSinceFit`).
 */
export interface AutopilotRunFit {
  /** The lookups that hold a record to another of the plan. */
  holds: readonly FitHold[];
  /** Of each object read by id, the fitted ones too, the ids the plan holds. */
  kept: ReadonlyMap<ApiName, readonly string[]>;
}

/**
 * What a run is held to on a plan fitted so: the lookups that hold a record
 * between selected objects, those a record read by id cannot be written
 * without, and those a selected record cannot be written without at one read
 * by id, which stays out if that record does.
 *
 * @param readById - The fitted scan's `parentIds`: every list the run reads.
 */
export function runFitOf(
  lookups: FitLookups,
  readById: ReadonlyMap<ApiName, readonly string[]>,
): AutopilotRunFit {
  return {
    holds: [
      ...lookups.links.filter((link) => link.kind === 'holds'),
      ...lookups.requiredOfParents,
      ...lookups.outward.filter((link) => link.required),
    ],
    kept: readById,
  };
}

export type { AutopilotFitHeldBy };

/** What a fit is given to choose from: see {@link chooseFitRecords}. */
export interface FitRecordsInput {
  /** The selected objects, in the order the run writes them. */
  order: readonly ApiName[];
  /** Of each, what {@link SchemaScanner.readFitRows} read, by id. */
  rows: ReadonlyMap<ApiName, readonly FitRow[]>;
  /** Of each, the records the plan counted: a fit only takes away. */
  planned: ReadonlyMap<ApiName, number>;
  lookups: FitLookups;
  /** Of each object read by id, the plan's ids and the person accounts among them. */
  parents: ReadonlyMap<ApiName, { ids: readonly string[]; personAccounts?: number }>;
  budget: FitBudget;
  room: Pick<AutomationRoom, 'perRecord' | 'notCounted'>;
  mode: AutopilotFitMode;
  /** The most records the run may write (`--max-total`); absent when no bound holds it. */
  maxRecords?: number;
  /** Reads the parents the rows kept name. Not asked of a plan that has none. */
  walk: (kept: ReadonlyMap<ApiName, readonly FitRow[]>) => Promise<FitWalk>;
}

/** What a fit chose, in the words of its report, and what is left to read from it. */
export interface FitRecordsChosen {
  heldBy: AutopilotFitHeldBy;
  /** Why nothing is proposed: the source moved, or no share of it fits. */
  cannotFit?: string;
  report: Omit<AutopilotFitReport, 'requestsRead'>;
  /** Of each selected object, the rows kept. */
  kept: Map<ApiName, FitRow[]>;
  /** The parents of those rows, once walked; absent when the plan holds none or was not cut. */
  walk?: FitWalk;
}

/** The records of an object as a fit weighs them, read once. */
interface FitTable {
  name: ApiName;
  rows: readonly FitRow[];
  at: ReadonlyMap<string, number>;
  /** Per row: what holds it to a record of an object written before it. */
  heldBefore: FitRef[][];
  /** Per row: what holds it to a record decided after it: its own object's, or one written later. */
  heldAfter: FitRef[][];
  /** Per row: the lookups a cut record leaves empty. */
  loose: FitRef[][];
  /** Per row: the records read by id it names. */
  named: Array<Array<{ parent: ApiName; id: string }>>;
  /** Positions of the rows held by no record of an object written before. */
  roots: number[];
  /** Positions of the others. */
  followers: number[];
  /** Positions of the person accounts, or the contacts of person accounts. */
  persons: ReadonlySet<number>;
}

/** A lookup filled on a row: which, and the record it names. */
interface FitRef {
  link: FitLink;
  id: string;
}

/** The records kept at a share. */
interface FitChoice {
  kept: Map<ApiName, Set<number>>;
  ids: Map<ApiName, Set<string>>;
  /** Of each object, the rows cut with a parent, and the lookup that cut them. */
  cut: Map<ApiName, Map<number, FitLink>>;
}

/** What a choice comes to, as a fit holds it to its bounds. */
interface FitMeasure {
  records: number;
  /** The records' own bytes. */
  bytes: number;
  /** What the target's automation creates under them. */
  roomBytes: number;
  requests: number;
}

/** Whether `value` names a record of the lookup's parent. */
function namesParent(value: unknown, prefix: string | null | undefined): value is string {
  if (typeof value !== 'string' || value === '') return false;
  return prefix === undefined || (prefix !== null && value.startsWith(prefix));
}

/**
 * The lookups a fit reads, from the plan's describes and the order the run
 * writes in:
 *
 * - between two selected objects, a required lookup holds; so does one whose
 *   parent is written first; a self-reference and one whose parent is written
 *   after do not;
 * - of a selected object at an object read by id, none holds: the parent
 *   follows the record;
 * - of an object read by id, only a required one at a selected object
 *   matters: its record is what the parent cannot be written without.
 *
 * @param order - The objects of the plan, in the order the run writes them.
 */
export function fitLookupsOf(
  describes: ReadonlyMap<ApiName, Pick<ObjectDescribeResult, 'fields' | 'keyPrefix'>>,
  selected: readonly ApiName[],
  order: readonly ApiName[],
): FitLookups {
  const rank = new Map(order.map((name, index) => [name, index]));
  const chosen = new Set(selected);
  const lookups: FitLookups = { links: [], outward: [], requiredOfParents: [] };
  for (const [objectApiName, describe] of describes) {
    for (const lookup of lookupsOf(objectApiName, describe)) {
      for (const parent of lookup.targets.filter((target) => describes.has(target))) {
        const prefix = lookup.polymorphic
          ? { prefix: describes.get(parent)?.keyPrefix ?? null }
          : {};
        const place = { objectApiName, field: lookup.field, parent, ...prefix };
        if (!chosen.has(objectApiName)) {
          if (chosen.has(parent) && lookup.required) {
            lookups.requiredOfParents.push({ ...place, kind: 'holds' });
          }
        } else if (!chosen.has(parent)) {
          lookups.outward.push({ ...place, required: lookup.required });
        } else if (lookup.required) {
          lookups.links.push({ ...place, kind: 'holds' });
        } else if (parent === objectApiName) {
          lookups.links.push({ ...place, kind: 'selfReference' });
        } else {
          const before = (rank.get(parent) ?? 0) < (rank.get(objectApiName) ?? 0);
          lookups.links.push({ ...place, kind: before ? 'holds' : 'owed' });
        }
      }
    }
  }
  return lookups;
}

/**
 * The acts a run makes of the objects of its plan, as what fires on them is
 * read: it inserts them all, and writes a second time those whose lookups it
 * fills after the wave and those born a draft.
 */
export function fitWritesOf(
  objects: readonly ApiName[],
  lookups: Pick<FitLookups, 'links'>,
): (objectApiName: string, write: ForgeAutomationWrite) => boolean {
  const written = new Set<string>(objects);
  const rewritten = new Set<string>(
    lookups.links.filter((link) => link.kind !== 'holds').map((link) => link.objectApiName),
  );
  return (objectApiName, write) =>
    written.has(objectApiName) &&
    (write === 'insert' ||
      (write === 'update' &&
        (rewritten.has(objectApiName) || STATUS_LIFECYCLES[objectApiName] !== undefined)));
}

/**
 * The room a fitted run keeps for what the target's automation still creates
 * under its records, once its mute's plan holds, nothing assigned; and why
 * none is kept when that automation could not be read.
 *
 * @param plan - The sets the mute is to hold; absent for a run that does not mute.
 */
export function fitRoomOf(
  read: ForgeTargetAutomation | { unread: string },
  plan: Pick<MutePlan, 'assign'> | undefined,
  writes: (objectApiName: string, write: ForgeAutomationWrite) => boolean,
): AutomationRoom & { unread?: string } {
  if (typeof read.unread === 'string') {
    return { perRecord: [], notCounted: [], unread: read.unread };
  }
  return automationRoomOf(stillRunningOf(read as ForgeTargetAutomation, plan, writes), writes);
}

/** The rows of the selected objects, each with what its lookups name. */
function tablesOf(input: FitRecordsInput): FitTable[] {
  const rank = new Map(input.order.map((name, index) => [name, index]));
  return input.order.map((name) => {
    const rows = input.rows.get(name) ?? [];
    const links = input.lookups.links.filter((link) => link.objectApiName === name);
    const outward = input.lookups.outward.filter((link) => link.objectApiName === name);
    const table: FitTable = {
      name,
      rows,
      at: new Map(rows.map((row, index) => [row.Id, index])),
      heldBefore: [],
      heldAfter: [],
      loose: [],
      named: [],
      roots: [],
      followers: [],
      persons: new Set(
        name === ACCOUNT || name === CONTACT
          ? rows.flatMap((row, index) => (row[PERSON_ACCOUNT_FLAG] === true ? [index] : []))
          : [],
      ),
    };
    rows.forEach((row, index) => {
      const before: FitRef[] = [];
      const after: FitRef[] = [];
      const loose: FitRef[] = [];
      for (const link of links) {
        const value = row[link.field];
        if (!namesParent(value, link.prefix)) continue;
        const ref = { link, id: value };
        if (link.kind !== 'holds') loose.push(ref);
        else if ((rank.get(link.parent) ?? 0) < (rank.get(name) ?? 0)) before.push(ref);
        else after.push(ref);
      }
      table.heldBefore.push(before);
      table.heldAfter.push(after);
      table.loose.push(loose);
      table.named.push(
        outward.flatMap((link) => {
          const value = row[link.field];
          return namesParent(value, link.prefix) ? [{ parent: link.parent, id: value }] : [];
        }),
      );
      (before.length > 0 ? table.followers : table.roots).push(index);
    });
    return table;
  });
}

/** The records a kept one cannot go without, those it is held to included. */
function withWhatTheyNeed(
  tables: readonly FitTable[],
  asked: ReadonlyMap<ApiName, ReadonlySet<string>>,
): Map<ApiName, Set<number>> {
  const byName = new Map(tables.map((table) => [table.name, table]));
  const needed = new Map<ApiName, Set<number>>();
  const waiting = [...asked].flatMap(([name, ids]) => [...ids].map((id) => ({ name, id })));
  for (let next = waiting.pop(); next; next = waiting.pop()) {
    const table = byName.get(next.name);
    const at = table?.at.get(next.id);
    if (!table || at === undefined) continue;
    const own = needed.get(next.name) ?? new Set<number>();
    needed.set(next.name, own);
    if (own.has(at)) continue;
    own.add(at);
    for (const ref of [...table.heldBefore[at], ...table.heldAfter[at]]) {
      waiting.push({ name: ref.link.parent, id: ref.id });
    }
  }
  return needed;
}

/** Records, as a sentence counts them. */
function recordsWords(n: number): string {
  return `${n} record${n === 1 ? '' : 's'}`;
}

/** Whether every id a walk reached is one the plan held: a parent only falls as a plan does. */
function withinThePlan(walk: FitWalk, parents: FitRecordsInput['parents']): boolean {
  return [...walk.parentIds].every(([name, ids]) => {
    const planned = new Set(parents.get(name)?.ids ?? []);
    return ids.every((id) => planned.has(id));
  });
}

/**
 * Choose the records a plan keeps, by the rules of this file: the largest
 * share that fits, after the caps when asked, the parents walked and measured.
 *
 * What cannot fit is said in `cannotFit`, with what the records take and
 * nothing proposed: caps alone past the budget; one root of each object and
 * what follows them past it; three walks that kept coming back over it; a
 * source that holds records the plan did not, read again.
 */
export async function chooseFitRecords(input: FitRecordsInput): Promise<FitRecordsChosen> {
  const { budget, room, mode, parents, maxRecords } = input;
  const tables = tablesOf(input);
  const capOf = (name: ApiName): number | undefined => {
    const cap = mode.caps?.[name] ?? mode.all;
    return cap === undefined ? undefined : Math.max(1, Math.floor(cap));
  };
  const hasForward = tables.some((table) => table.heldAfter.some((refs) => refs.length > 0));
  // The standard price book is matched in the target, never written, and
  // every price of a product stands on it: cut, a custom price would be
  // refused STANDARD_PRICE_NOT_DEFINED.
  const asked = new Map<ApiName, Set<string>>();
  for (const table of tables) {
    if (table.name !== PRICEBOOK_OBJECT) continue;
    const standard = table.rows.filter((row) => row[STANDARD_PRICEBOOK_FLAG] === true);
    if (standard.length > 0) asked.set(table.name, new Set(standard.map((row) => row.Id)));
  }
  let needed = withWhatTheyNeed(tables, asked);

  const chooseAt = (share: number): FitChoice => {
    const choice: FitChoice = { kept: new Map(), ids: new Map(), cut: new Map() };
    const none = new Set<number>();
    for (const table of tables) {
      const need = needed.get(table.name) ?? none;
      const cap = capOf(table.name);
      const roots = table.roots.filter((index) => !need.has(index));
      const take =
        roots.length === 0
          ? 0
          : Math.max(1, Math.round(share * Math.min(roots.length, cap ?? Infinity)));
      const chosen = evenlyKept(roots.length, take).map((position) => roots[position]);
      const cut = new Map<number, FitLink>();
      for (const index of table.followers) {
        if (need.has(index)) continue;
        const broken = table.heldBefore[index].find(
          (ref) => !choice.ids.get(ref.link.parent)?.has(ref.id),
        );
        if (broken) cut.set(index, broken.link);
        else chosen.push(index);
      }
      chosen.sort((a, b) => a - b);
      // The org makes a person account's contact with its account: cut here,
      // it would be in the target all the same, past the cap and the plan.
      const madeWithAccount =
        table.name === CONTACT ? chosen.filter((index) => table.persons.has(index)) : [];
      const thinnable =
        madeWithAccount.length > 0 ? chosen.filter((index) => !table.persons.has(index)) : chosen;
      const left =
        cap === undefined
          ? thinnable.length
          : Math.max(0, cap - need.size - madeWithAccount.length);
      const thinned =
        thinnable.length > left
          ? evenlyKept(thinnable.length, left).map((at) => thinnable[at])
          : thinnable;
      const kept = new Set([...need, ...madeWithAccount, ...thinned]);
      choice.kept.set(table.name, kept);
      choice.ids.set(table.name, new Set([...kept].map((index) => table.rows[index].Id)));
      choice.cut.set(table.name, cut);
    }
    if (!hasForward) return choice;
    // A required lookup at a record decided after its row, which the walk in
    // write order could not hold it to: settled once all are.
    for (let changed = true; changed;) {
      changed = false;
      for (const table of tables) {
        const need = needed.get(table.name) ?? none;
        const kept = choice.kept.get(table.name) ?? new Set<number>();
        for (const index of [...kept]) {
          if (need.has(index)) continue;
          const broken = [...table.heldAfter[index], ...table.heldBefore[index]].find(
            (ref) => !choice.ids.get(ref.link.parent)?.has(ref.id),
          );
          if (!broken) continue;
          kept.delete(index);
          choice.ids.get(table.name)?.delete(table.rows[index].Id);
          choice.cut.get(table.name)?.set(index, broken.link);
          changed = true;
        }
      }
    }
    return choice;
  };

  /** The rows a run writes again, once its lookups are filled: those naming a kept record. */
  const rewrittenOf = (choice: FitChoice): Map<ApiName, number> => {
    const rewritten = new Map<ApiName, number>();
    for (const table of tables) {
      let count = 0;
      for (const index of choice.kept.get(table.name) ?? []) {
        const filled = table.loose[index].some((ref) =>
          choice.ids.get(ref.link.parent)?.has(ref.id),
        );
        if (filled) count++;
      }
      if (count > 0) rewritten.set(table.name, count);
    }
    return rewritten;
  };

  /** What a choice comes to, its parents as given. */
  const measureOf = (
    choice: FitChoice,
    readById: ReadonlyMap<ApiName, { records: number; personAccounts?: number }>,
  ): FitMeasure => {
    const rows = new Map<ApiName, number>();
    let bytes = 0;
    for (const table of tables) {
      const kept = choice.kept.get(table.name) ?? new Set<number>();
      let personAccounts = 0;
      for (const index of kept) if (table.persons.has(index)) personAccounts++;
      rows.set(table.name, kept.size);
      bytes += countedStorageBytes(table.name, { rows: kept.size, personAccounts });
    }
    for (const [name, { records, personAccounts }] of readById) {
      rows.set(name, (rows.get(name) ?? 0) + records);
      bytes += countedStorageBytes(name, {
        rows: records,
        ...(personAccounts !== undefined ? { personAccounts } : {}),
      });
    }
    const rewritten = rewrittenOf(choice);
    const roomBytes = roomBytesOf(room, (objectApiName, act) => {
      const written = rows.get(objectApiName) ?? 0;
      if (act === 'insert') return written;
      return STATUS_LIFECYCLES[objectApiName] !== undefined
        ? written
        : (rewritten.get(objectApiName) ?? 0);
    });
    return {
      records: [...rows.values()].reduce((sum, n) => sum + n, 0),
      bytes,
      roomBytes,
      requests: runRequestsEstimate([...rows.values()].map((count) => ({ rows: count }))),
    };
  };

  /** Of each object read by id, the ids every selected row names. */
  const namedByAll = new Map<ApiName, Set<string>>();
  for (const table of tables) {
    for (const refs of table.named) {
      for (const { parent, id } of refs) {
        const ids = namedByAll.get(parent) ?? new Set<string>();
        namedByAll.set(parent, ids);
        ids.add(id);
      }
    }
  }
  const totalNamed = [...namedByAll.values()].reduce((sum, ids) => sum + ids.size, 0);

  /**
   * The parents a choice reads, estimated: the first level exact, from the
   * rows kept; what those parents reach in turn at the rate the first level
   * fell, which the walk then replaces with what it reads.
   */
  const parentsEstimated = (
    choice: FitChoice,
  ): Map<ApiName, { records: number; personAccounts?: number }> => {
    const named = new Map<ApiName, Set<string>>();
    let seen = 0;
    for (const table of tables) {
      for (const index of choice.kept.get(table.name) ?? []) {
        for (const { parent, id } of table.named[index]) {
          const ids = named.get(parent) ?? new Set<string>();
          named.set(parent, ids);
          if (!ids.has(id)) seen++;
          ids.add(id);
        }
      }
    }
    const rate = totalNamed > 0 ? seen / totalNamed : 0;
    const estimated = new Map<ApiName, { records: number; personAccounts?: number }>();
    for (const [name, { ids, personAccounts }] of parents) {
      const deeper = Math.max(0, ids.length - (namedByAll.get(name)?.size ?? 0));
      const records = Math.min(ids.length, (named.get(name)?.size ?? 0) + Math.ceil(deeper * rate));
      if (records === 0) continue;
      estimated.set(name, {
        records,
        ...(personAccounts !== undefined
          ? { personAccounts: Math.ceil((personAccounts * records) / ids.length) }
          : {}),
      });
    }
    return estimated;
  };

  const parentsWalked = (
    walk: FitWalk,
  ): Map<ApiName, { records: number; personAccounts?: number }> =>
    new Map(
      walk.added.map((name) => {
        const personAccounts = walk.personAccounts.get(name);
        return [
          name,
          {
            records: walk.parentIds.get(name)?.length ?? 0,
            ...(personAccounts !== undefined ? { personAccounts } : {}),
          },
        ];
      }),
    );

  const inStorage = (m: FitMeasure): boolean => m.bytes + m.roomBytes <= budget.bytes;
  const inRequests = (m: FitMeasure): boolean =>
    budget.runRequests === undefined || m.requests <= budget.runRequests;
  const inRecords = (m: FitMeasure): boolean => maxRecords === undefined || m.records <= maxRecords;
  const fits = (m: FitMeasure): boolean => inStorage(m) && inRequests(m) && inRecords(m);
  /** What holds `m` past its bounds. */
  const overBy = (m: FitMeasure): AutopilotFitHeldBy =>
    !inStorage(m) ? budget.terms.limitedBy : !inRequests(m) ? 'apiRequests' : 'maxTotal';
  /** Why `m` is past its bounds, in figures. */
  const overOf = (m: FitMeasure): AutopilotFitOver => {
    if (!inStorage(m)) {
      return {
        bound: 'storage',
        takesMB: (m.bytes + m.roomBytes) / BYTES_PER_MB,
        fitsMB: budget.bytes / BYTES_PER_MB,
      };
    }
    return inRequests(m)
      ? { bound: 'maxTotal', records: m.records, allowed: maxRecords ?? 0 }
      : { bound: 'apiRequests', requests: m.requests, allowed: budget.runRequests ?? 0 };
  };
  /** Why `m` is past its bounds, in words. */
  const overWords = (m: FitMeasure): string => {
    if (!inStorage(m)) {
      const said = formatMBPast(
        (m.bytes + m.roomBytes) / BYTES_PER_MB,
        budget.bytes / BYTES_PER_MB,
      );
      return (
        `${said.over} MB` +
        (m.roomBytes > 0
          ? ", room for what the org's automation creates under them included"
          : '') +
        `, past the ${said.bound} MB that fit`
      );
    }
    return inRequests(m)
      ? `${recordsWords(m.records)}, past the ${maxRecords ?? 0} the run may write`
      : `about ${m.requests} API requests, past the ${budget.runRequests ?? 0} that leave the ` +
          'org a tenth of its daily requests';
  };

  /** Of each object, the rows a choice keeps, in the order of the ids. */
  const rowsKept = (choice: FitChoice): Map<ApiName, FitRow[]> =>
    new Map(
      tables.map((table) => [
        table.name,
        [...(choice.kept.get(table.name) ?? [])]
          .sort((a, b) => a - b)
          .map((index) => table.rows[index]),
      ]),
    );

  /** The report of a choice, as its budget, objects and lookups say it. */
  const outcomeOf = (
    share: number | undefined,
    choice: FitChoice,
    measure: FitMeasure,
    heldBy: AutopilotFitHeldBy,
    walk: FitWalk | undefined,
    refused?: { words: string; said: AutopilotCannotFit },
  ): FitRecordsChosen => {
    const objects: AutopilotFitObject[] = tables.map((table) => {
      const cut = choice.cut.get(table.name) ?? new Map<number, FitLink>();
      const byLink = new Map<string, { field: string; parent: ApiName; count: number }>();
      for (const link of cut.values()) {
        const key = `${link.field}\n${link.parent}`;
        const known = byLink.get(key) ?? { field: link.field, parent: link.parent, count: 0 };
        byLink.set(key, { ...known, count: known.count + 1 });
      }
      const kept = choice.kept.get(table.name)?.size ?? 0;
      return {
        objectApiName: table.name,
        inSource: table.rows.length,
        kept,
        cutSpread: table.rows.length - kept - cut.size,
        cutWithParent: [...byLink.values()].sort((a, b) => b.count - a.count),
      };
    });
    const emptied = new Map<string, AutopilotFitEmptied>();
    const left = (objectApiName: ApiName, field: string, why: AutopilotFitEmptied['why']): void => {
      const key = `${objectApiName}\n${field}\n${why}`;
      const count = (emptied.get(key)?.count ?? 0) + 1;
      emptied.set(key, { objectApiName, field, count, why });
    };
    for (const table of tables) {
      for (const index of choice.kept.get(table.name) ?? []) {
        for (const ref of table.loose[index]) {
          if (choice.ids.get(ref.link.parent)?.has(ref.id)) continue;
          left(table.name, ref.link.field, ref.link.kind === 'owed' ? 'owed' : 'selfReference');
        }
      }
    }
    // A record read by id takes its lookup of a cut record empty too: the run
    // owes it a record that never comes.
    for (const naming of walk?.namingSelected ?? []) {
      if (naming.required || choice.ids.get(naming.target)?.has(naming.id)) continue;
      left(naming.objectApiName, naming.field, 'onParent');
    }
    return {
      heldBy,
      ...(refused ? { cannotFit: refused.words } : {}),
      kept: rowsKept(choice),
      ...(walk ? { walk } : {}),
      report: {
        mode,
        heldBy,
        ...(refused ? { cannotFit: refused.said } : {}),
        budget: {
          ...storageFitBudgetOf(budget, measure.roomBytes, room),
          ...(heldBy === 'apiRequests' ? { limitedBy: 'apiRequests' as const } : {}),
        },
        ...(share !== undefined ? { share } : {}),
        objects,
        emptied: [...emptied.values()],
        parents: walk
          ? walk.added.map((objectApiName) => ({
              objectApiName,
              records: walk.parentIds.get(objectApiName)?.length ?? 0,
            }))
          : [...parents].map(([objectApiName, { ids }]) => ({
              objectApiName,
              records: ids.length,
            })),
        records: measure.records,
        estimateMB: measure.bytes / BYTES_PER_MB,
      },
    };
  };

  const sourceChanged = { words: SOURCE_CHANGED, said: { why: 'sourceChanged' as const } };
  /** With the caps asked, the plan stays past a bound. */
  const overCaps = (m: FitMeasure): { words: string; said: AutopilotCannotFit } => ({
    words: `with these caps the plan takes ${overWords(m)}: lower them, or fit by share`,
    said: { why: 'caps', over: overOf(m) },
  });
  const unknownCap = Object.keys(mode.caps ?? {}).find(
    (name) => !tables.some((table) => table.name === name),
  );
  const top = tables.reduce(
    (most, table) => Math.max(most, Math.min(table.roots.length, capOf(table.name) ?? Infinity)),
    0,
  );
  const wholeChoice = chooseAt(1);
  const wholeMeasure = measureOf(wholeChoice, parentsEstimated(wholeChoice));
  if (unknownCap !== undefined) {
    return outcomeOf(undefined, wholeChoice, wholeMeasure, 'caps', undefined, {
      words: `the plan selects no ${unknownCap}: a cap holds an object it selects`,
      said: { why: 'capNotSelected', object: unknownCap },
    });
  }
  if (tables.some((table) => table.rows.length > (input.planned.get(table.name) ?? 0))) {
    return outcomeOf(
      undefined,
      wholeChoice,
      wholeMeasure,
      budget.terms.limitedBy,
      undefined,
      sourceChanged,
    );
  }
  const capped = mode.all !== undefined || Object.keys(mode.caps ?? {}).length > 0;
  const byShare = mode.share === true || !capped;
  const estimateAt = (k: number): FitMeasure => {
    const choice = chooseAt(k / top);
    return measureOf(choice, parentsEstimated(choice));
  };

  const nothingCut = tables.every(
    (table) => wholeChoice.kept.get(table.name)?.size === table.rows.length,
  );
  if (nothingCut && fits(wholeMeasure)) {
    return outcomeOf(byShare ? 1 : undefined, wholeChoice, wholeMeasure, 'whole', undefined);
  }
  // Every record held by a record that was not read: no root to start from.
  if (top === 0) {
    return outcomeOf(
      undefined,
      wholeChoice,
      wholeMeasure,
      budget.terms.limitedBy,
      undefined,
      sourceChanged,
    );
  }
  let k = top;
  if (!fits(wholeMeasure)) {
    if (!byShare) {
      return outcomeOf(
        undefined,
        wholeChoice,
        wholeMeasure,
        overBy(wholeMeasure),
        undefined,
        overCaps(wholeMeasure),
      );
    }
    k = largestFitting(top, (n) => fits(estimateAt(n)));
    if (k === 0) {
      const least = chooseAt(1 / top);
      const measure = measureOf(least, parentsEstimated(least));
      return outcomeOf(1 / top, least, measure, overBy(measure), undefined, {
        words:
          `the least it can be cut to — one record of each object with none to follow, and ` +
          `what follows them, ${recordsWords(measure.records)} — takes ${overWords(measure)}`,
        said: { why: 'least', over: overOf(measure) },
      });
    }
  }
  /** What held the share: what the next root would go past, or the caps when no root was cut. */
  let heldBy: AutopilotFitHeldBy =
    k < top ? overBy(estimateAt(k + 1)) : capped ? 'caps' : budget.terms.limitedBy;
  const shareAt = (at: number): number | undefined => (byShare ? at / top : undefined);

  // With no parent to read, what the share was sought on is what it comes to.
  if (parents.size === 0) {
    const choice = chooseAt(k / top);
    return outcomeOf(shareAt(k), choice, measureOf(choice, new Map()), heldBy, undefined);
  }
  for (let round = 1; round <= FIT_WALKS; round++) {
    const choice = chooseAt(k / top);
    const walk = await input.walk(rowsKept(choice));
    if (!withinThePlan(walk, parents)) {
      const measure = measureOf(choice, parentsWalked(walk));
      return outcomeOf(shareAt(k), choice, measure, heldBy, undefined, sourceChanged);
    }
    // A record read by id that cannot be written without a selected one
    // brings it back, and what holds it: the parent would be refused, and
    // what follows it, for a record the fit chose to cut.
    const missing = walk.namingSelected.filter(
      (naming) =>
        naming.required &&
        tables.find((table) => table.name === naming.target)?.at.has(naming.id) === true &&
        !choice.ids.get(naming.target)?.has(naming.id),
    );
    if (missing.length > 0) {
      for (const { target, id } of missing) {
        const ids = asked.get(target) ?? new Set<string>();
        asked.set(target, ids);
        ids.add(id);
      }
      needed = withWhatTheyNeed(tables, asked);
      continue;
    }
    const measure = measureOf(choice, parentsWalked(walk));
    if (fits(measure)) return outcomeOf(shareAt(k), choice, measure, heldBy, walk);
    heldBy = overBy(measure);
    if (!byShare) {
      return outcomeOf(undefined, choice, measure, heldBy, walk, overCaps(measure));
    }
    if (k === 1) {
      return outcomeOf(shareAt(k), choice, measure, heldBy, walk, {
        words:
          'the least it can be cut to, with the parents its records name, takes ' +
          overWords(measure),
        said: { why: 'least', over: overOf(measure) },
      });
    }
    // Down by what the walk came back over, and always by a root.
    const over = Math.max(
      (measure.bytes + measure.roomBytes) / Math.max(1, budget.bytes),
      budget.runRequests !== undefined ? measure.requests / Math.max(1, budget.runRequests) : 0,
      maxRecords !== undefined ? measure.records / Math.max(1, maxRecords) : 0,
    );
    k = Math.max(1, Math.min(k - 1, Math.floor(k / over)));
  }
  const last = chooseAt(k / top);
  const measure = measureOf(last, parentsEstimated(last));
  return outcomeOf(shareAt(k), last, measure, heldBy, undefined, {
    words: `could not fit in ${FIT_WALKS} rounds: fit by caps`,
    said: { why: 'rounds' },
  });
}

/**
 * The scan of the plan a fit chose: the selected objects read by the ids
 * kept, beside the parents those rows name; counts, person accounts and scope
 * those of the records kept; objects no kept record reaches gone. Everything
 * in it is what the plan held, or less. No table is copied to a bound any
 * more, so none is said to be cut short.
 */
export function fittedScanOf(
  scan: SchemaScanResult,
  chosen: Pick<FitRecordsChosen, 'kept' | 'walk'>,
  report: AutopilotFitReport,
): SchemaScanResult {
  const { selected } = scan.scope;
  const parents = chosen.walk?.added ?? [];
  const inPlan = new Set<ApiName>([...selected, ...parents]);
  const parentIds = new Map<ApiName, string[]>(chosen.walk?.parentIds ?? []);
  const recordCounts = new Map<ApiName, number>();
  const personAccounts = new Map<ApiName, number>();
  for (const name of selected) {
    const rows = chosen.kept.get(name) ?? [];
    parentIds.set(
      name,
      rows.map((row) => row.Id),
    );
    recordCounts.set(name, rows.length);
    if (scan.personAccounts.has(name)) {
      personAccounts.set(name, rows.filter((row) => row[PERSON_ACCOUNT_FLAG] === true).length);
    }
  }
  for (const name of parents) {
    recordCounts.set(name, chosen.walk?.parentIds.get(name)?.length ?? 0);
    if (scan.personAccounts.has(name)) {
      personAccounts.set(name, chosen.walk?.personAccounts.get(name) ?? 0);
    }
  }
  const leftEmpty = new Map(
    [...scan.scope.leftEmpty, ...(chosen.walk?.leftEmpty ?? [])]
      .filter((lookup) => inPlan.has(lookup.objectApiName) && !inPlan.has(lookup.target))
      .map((lookup) => [`${lookup.objectApiName}.${lookup.fieldApiName}>${lookup.target}`, lookup]),
  );
  const { maxDepth, maxObjects, followedByDefault, currencies } = scan.scope;
  const followed = followedByDefault?.filter((entry) => inPlan.has(entry.objectApiName));
  const carrying = currencies?.objects.filter((name) => inPlan.has(name));
  return {
    ...scan,
    objectDescribes: new Map([...scan.objectDescribes].filter(([name]) => inPlan.has(name))),
    autoDiscoveredObjects: parents,
    missingInTarget: scan.missingInTarget.filter((name) => inPlan.has(name)),
    recordCounts,
    totalObjectsScanned: inPlan.size,
    parentIds,
    personAccounts,
    scope: {
      maxDepth,
      maxObjects,
      selected,
      parents: parents.map((objectApiName) => ({
        objectApiName,
        records: recordCounts.get(objectApiName) ?? 0,
      })),
      leftEmpty: [...leftEmpty.values()],
      standardNeeded: scan.scope.standardNeeded.filter((entry) => inPlan.has(entry.objectApiName)),
      ...(followed !== undefined && followed.length > 0 ? { followedByDefault: followed } : {}),
      ...(currencies && carrying !== undefined && carrying.length > 0
        ? { currencies: { ...currencies, objects: carrying } }
        : {}),
      fitted: report,
    },
  };
}
