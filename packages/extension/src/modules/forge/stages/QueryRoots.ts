/**
 * The records a clone from a query takes as its roots, and what refuses it
 * for them: the clone of each record the query returns, a shared one read
 * and written once (`ForgeConfig.queryScope: 'records'`).
 *
 * The roots are read by a statement of the run's own, before anything else,
 * never by the query as typed: `SELECT Id FROM <object> WHERE (<where>)
 * [AND (<filter of the object>)] ORDER BY <order | Id> LIMIT <n>`, `n` being
 * the query's LIMIT when the run takes that many, one past the most it takes
 * otherwise. A row past that most says the query chooses more than the run
 * takes, and the run is refused (`ROOTS_EXCEEDED`) rather than cut at an
 * order nobody chose. With no ORDER BY, `Id`: a LIMIT with no order is no
 * choice a dry run and its run make alike.
 *
 * Read once, the roots are fixed: a run that takes up its dry run's plan, or
 * resumes, writes those ids and reads no query again. What it then reads is
 * held to two bounds, checked before each object's statements go and once
 * each object is read: the records it holds in all (`FORGE_ROOTS_READ_TOTAL`)
 * — a clone from records reads everything before it writes, and holds it —
 * and the requests it sends the source, a tenth of what the source has left
 * today, 2 000 when it would not say.
 *
 * No I/O here: the executor reads, this says what and why not.
 */

import { createHash } from 'node:crypto';
import {
  FORGE_ROOTS_MAX,
  FORGE_ROOTS_READ_TOTAL,
  SOQL_NEWEST_FIRST,
  soqlOrderBySchema,
  soqlRootIssueWords,
  soqlRootQuery,
  soqlRootQueryIssue,
  soqlWhereFragmentSchema,
  type ForgeRootsFrom,
  type ForgeRootsQuery,
  type RootsGatePlanRefusal,
  type SoqlRootIssue,
} from '@sandforge/shared';
import { assertSoqlIdentifier } from '../../../core/common/soqlValidator.js';
import { compareIds, idKey } from '../sample/sampleRank.js';
import {
  formatMB,
  storageCountedOf,
  storageCountedWords,
  storageRoomMB,
  storageTakesWords,
  type ForgeGateStop,
  type StorageCheck,
} from '../ForgeRunGate.js';
import type { RootPlan } from '../roots/rootPlanStore.js';

/**
 * How a run clones the records a query chose, or records named one by one
 * (`ExecuteOptions.roots`): their object, the query that chooses them or
 * their ids, a plan a dry run kept of them, the most it takes, and its
 * bounds.
 */
export interface ForgeRootsOptions {
  /** The object the roots are records of: the query's, after FROM. */
  objectApiName: string;
  /**
   * The query choosing them, its WHERE, ORDER BY and LIMIT as
   * `soqlRootQuery` reads them. Absent when the roots are given by id.
   */
  query?: ForgeRootsQuery;
  /** The roots named one by one (the command line's repeated `--record`): no query is read. */
  ids?: readonly string[];
  /**
   * The ids `query` chose, read by the run's own statement
   * (`rootsStatement`) before anything else of the run, and when: taken as
   * the query's, the query not sent again. The command line reads them
   * before discovery, so that a query choosing none, or more than the run
   * takes, is refused before the source is asked for its describes: read by
   * the executor alone, after discovery, the target's automation, its gaps
   * and the preflight, the refusal came 403 requests to the source and 74
   * to the target late, and said "refused before anything else was read".
   */
  chosen?: { ids: readonly string[]; readAt: string };
  /**
   * The roots a dry run read and kept (`roots/rootPlanStore.ts`): written
   * rather than the query read again, when they were read of this source,
   * by this query, less than a day before. Older, the query is read again,
   * and the result says so (`ForgeRunRoots.readAgain`).
   */
  plan?: RootPlan;
  /**
   * Set when `plan` holds the roots of the run this one retries, as that
   * run's journal or its entry in the history kept them: written whatever
   * their age — the run retried wrote under them, and its query read again
   * may choose other records — and said so (`ForgeRunRoots.ofTheRunRetried`).
   */
  planOfTheRunRetried?: true;
  /** The most roots the run takes (`maxRoots`), 1 to `FORGE_ROOTS_MAX`. */
  cap: number;
  /** The most records the run reads in all: `FORGE_ROOTS_READ_TOTAL` when absent. */
  readTotal?: number;
  /**
   * The requests the source has left today, read of it once before the run
   * (`readApiBudget`): its read is held to a tenth of them. Absent when the
   * source would not say, 2 000.
   */
  sourceRequestsLeft?: number;
  /**
   * Where to keep the roots the run reads, as a plan its run, or a run
   * after it, takes up: the file the command line's `--roots-plan` names,
   * the panel's `forge-roots/<fingerprint>.json`. Absent, none is kept.
   */
  keepAt?: string;
  /** The fingerprint of the setup, kept in the plan (`forgeRunFingerprint`). */
  fingerprint?: string;
}

/**
 * The requests a clone from records may send the source reading what its
 * roots reach, when the source would not say what it has left today.
 */
export const ROOTS_READING_FALLBACK = 2_000;

/** A record id, 15 or 18 letters and digits. */
const RECORD_ID = /^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/;

/** The most records a run takes as its roots, held to 1 … `FORGE_ROOTS_MAX`. */
export function rootsCapOf(cap: number | undefined, fallback: number): number {
  const value = cap !== undefined && Number.isFinite(cap) ? Math.floor(cap) : fallback;
  return Math.min(FORGE_ROOTS_MAX, Math.max(1, value));
}

/**
 * The requests the read of what the roots reach may send the source: a tenth
 * of what it has left today, one at least, or {@link ROOTS_READING_FALLBACK}
 * when it would not say.
 */
export function rootsReadingBound(sourceRequestsLeft: number | undefined): number {
  if (sourceRequestsLeft === undefined || !Number.isFinite(sourceRequestsLeft)) {
    return ROOTS_READING_FALLBACK;
  }
  return Math.max(1, Math.floor(sourceRequestsLeft / 10));
}

/** The most records a run from roots reads in all, as asked or by default. */
export function rootsReadTotalOf(readTotal: number | undefined): number {
  return readTotal !== undefined && Number.isFinite(readTotal) && readTotal >= 1
    ? Math.floor(readTotal)
    : FORGE_ROOTS_READ_TOTAL;
}

/**
 * The roots' query of a SOQL query, as the run reads it: its object and its
 * WHERE, ORDER BY and LIMIT, the aliases written out — or why it cannot
 * choose the records a clone takes.
 */
export function rootsQueryOf(
  soql: string,
): { objectApiName: string; query: ForgeRootsQuery } | { issue: SoqlRootIssue } {
  const issue = soqlRootQueryIssue(soql);
  if (issue !== undefined) return { issue };
  const read = soqlRootQuery(soql);
  if (!read) return { issue: { kind: 'noObject' } };
  return {
    objectApiName: read.objectApiName,
    query: {
      ...(read.where !== null ? { where: read.where } : {}),
      ...(read.orderBy !== null ? { orderBy: read.orderBy } : {}),
      ...(read.limit !== null ? { limit: read.limit } : {}),
    },
  };
}

/**
 * Why a roots' query cannot be sent in the run's statement, or nothing: its
 * parts held to the rules `soqlRootQueryIssue` holds a typed query to,
 * whoever built it — the command line, a plan read back, the panel.
 */
export function rootsQueryIssue(query: ForgeRootsQuery): SoqlRootIssue | undefined {
  if (query.where !== undefined && !soqlWhereFragmentSchema.safeParse(query.where).success) {
    return { kind: 'where' };
  }
  if (query.orderBy !== undefined && !soqlOrderBySchema.safeParse(query.orderBy).success) {
    return { kind: 'orderBy' };
  }
  if (
    query.limit !== undefined &&
    !(Number.isInteger(query.limit) && query.limit >= 1 && query.limit <= FORGE_ROOTS_MAX)
  ) {
    return { kind: 'limit' };
  }
  return undefined;
}

/**
 * The statement that reads the roots: their ids alone, under the query's
 * WHERE and the object's own filter (`objectSoqlFilters`), in the query's
 * order or by `Id`, to the query's LIMIT when the run takes that many and
 * to one past the most it takes otherwise.
 */
export function rootsStatement(
  objectApiName: string,
  query: ForgeRootsQuery,
  filter: string | undefined,
  cap: number,
): string {
  const object = assertSoqlIdentifier(objectApiName);
  const terms = [
    ...(query.where !== undefined ? [`(${query.where})`] : []),
    ...(filter !== undefined && filter !== '' ? [`(${filter})`] : []),
  ];
  const where = terms.length > 0 ? ` WHERE ${terms.join(' AND ')}` : '';
  const take = query.limit !== undefined && query.limit <= cap ? query.limit : cap + 1;
  return `SELECT Id FROM ${object}${where} ORDER BY ${query.orderBy ?? 'Id'} LIMIT ${take}`;
}

/**
 * How many of a clone's `roots` fit in `room`, at what each takes on average
 * of `taken` — records against --max-total, bytes against the data storage —,
 * fewer than `roots`: none when one of them alone takes more than `room`.
 * What a dry run counted under them, divided by them, as the way through a
 * refusal names it: a LIMIT of that many keeps each root with what its clone
 * copies, where a cap on each object kept every root and some of its records,
 * taken by an order nobody chose.
 */
export function rootsThatFit(roots: number, taken: number, room: number): number {
  if (!Number.isFinite(roots) || roots < 1 || !Number.isFinite(taken) || taken <= 0) return 0;
  if (!Number.isFinite(room) || room <= 0) return 0;
  return Math.max(0, Math.min(Math.floor(roots) - 1, Math.floor((room * roots) / taken)));
}

/**
 * The query that clones `limit` of the records `query` chooses of
 * `objectApiName`: its WHERE, in its own order, or the newest first
 * (`SOQL_NEWEST_FIRST`, an order the ids make total), to `limit`. Written out
 * whole, to be given to `--query` as it is.
 */
export function rootsQueryWithLimit(
  objectApiName: string,
  query: ForgeRootsQuery,
  limit: number,
): string {
  const where = query.where !== undefined ? ` WHERE ${query.where}` : '';
  return (
    `SELECT Id FROM ${assertSoqlIdentifier(objectApiName)}${where} ` +
    `ORDER BY ${query.orderBy ?? SOQL_NEWEST_FIRST} LIMIT ${Math.max(1, Math.floor(limit))}`
  );
}

/**
 * The stop of a clone from the records a query chose refused for the data
 * storage its records take, what the target's automation creates under them
 * counted (`STORAGE_EXCEEDED`), as the panel's gate raises it: how many of
 * its roots fit, at what each takes on average with what its clone copies,
 * the LIMIT that takes them — never fewer records per object, which kept
 * every root and some of its records, taken by an order nobody chose —, or,
 * when one of them alone takes more, the objects it writes. Nothing when the
 * records fit, or the storage could not be read.
 *
 * @param roots - The roots as the gate was told them: their object and how many.
 */
export function rootsStorageStop(
  check: StorageCheck,
  target: string,
  roots: { objectApiName: string; count: number },
): ForgeGateStop | undefined {
  if (check.verdict !== 'exceeds') return undefined;
  const fits = rootsThatFit(roots.count, check.estimateMB, storageRoomMB(check));
  const counted = storageCountedOf(check);
  const chosen = `the ${roots.count} ${roots.objectApiName} records the query chooses`;
  const through =
    fits >= 1
      ? `about ${fits} of ${chosen} fit, each with what its clone copies: a LIMIT of ${fits} ` +
        `in the query clones that many — after ORDER BY ${SOQL_NEWEST_FIRST}, the newest —, or ` +
        `narrow its WHERE; or leave objects out, or free data storage in ${target}.`
      : `one of ${chosen} takes more than that by itself, with what its clone copies: leave ` +
        `objects out, clone less deep, or free data storage in ${target}.`;
  return {
    code: 'STORAGE_EXCEEDED',
    message:
      `The records to write take ${storageTakesWords(check)}, and ${target} has ` +
      `${check.remainingMB} MB left of ${check.maxMB} MB${storageCountedWords(counted, target)}: ` +
      `${through} ${NOTHING_WRITTEN}`,
    storage: {
      estimateMB: Number(formatMB(check.estimateMB)),
      remainingMB: check.remainingMB,
      ...counted,
    },
    ...(rootsOf(roots.objectApiName).roots
      ? { roots: { objectApiName: roots.objectApiName, ...(fits >= 1 ? { fits } : {}) } }
      : {}),
  };
}

/** The ids of `ids` once each, by the record they name, in the order a plan keeps them. */
export function sortedRootIds(ids: Iterable<string>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ids) {
    const key = idKey(id);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(id);
  }
  return out.sort(compareIds);
}

/** The SHA-256 of roots: of their ids, once each, sorted, one a line. */
export function rootsSha256(ids: Iterable<string>): string {
  return createHash('sha256').update(sortedRootIds(ids).join('\n')).digest('hex');
}

/** Whether `id` reads as a record id. */
export function isRootId(id: string): boolean {
  return RECORD_ID.test(id);
}

/**
 * Whether two queries choose the roots alike: the same WHERE, ORDER BY and
 * LIMIT, their spaces aside.
 */
export function sameRootsQuery(
  a: ForgeRootsQuery | undefined,
  b: ForgeRootsQuery | undefined,
): boolean {
  const flat = (text: string | undefined): string | undefined =>
    text === undefined ? undefined : text.replace(/\s+/g, ' ').trim();
  return (
    flat(a?.where) === flat(b?.where) &&
    flat(a?.orderBy ?? 'Id') === flat(b?.orderBy ?? 'Id') &&
    a?.limit === b?.limit
  );
}

/**
 * Why a plan's roots are not the run's, or nothing when they are: read of
 * another source (`otherOrg`), of another object or by another query, or
 * other ids than those named (`otherQuery`), or no longer the ids its
 * SHA-256 was taken of (`changed`).
 */
export function rootPlanRefusal(
  plan: RootPlan,
  run: {
    sourceOrgId: string;
    objectApiName: string;
    query?: ForgeRootsQuery;
    ids?: readonly string[];
  },
): Exclude<RootsGatePlanRefusal, 'gone'> | undefined {
  if (plan.sourceOrgId !== run.sourceOrgId) return 'otherOrg';
  if (plan.objectApiName.toLowerCase() !== run.objectApiName.toLowerCase()) return 'otherQuery';
  if (run.query !== undefined && !sameRootsQuery(plan.query, run.query)) return 'otherQuery';
  if (run.ids !== undefined && rootsSha256(run.ids) !== plan.sha256) return 'otherQuery';
  if (rootsSha256(plan.ids) !== plan.sha256) return 'changed';
  return undefined;
}

/** How the roots of a run came, as its result says it: see `ForgeRunRoots.from`. */
export type RootsSource = ForgeRootsFrom;

// ─── Refusals ────────────────────────────────────────────────────────────────

/** What each run of these refusals ends on. */
const NOTHING_WRITTEN = 'Nothing was written.';

/** An object as a stop names it, when it names one. */
function rootsOf(objectApiName: string | undefined, more: { cap?: number } = {}) {
  return objectApiName !== undefined && /^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(objectApiName)
    ? { roots: { objectApiName, ...more } }
    : {};
}

/** The stop of a query that cannot choose the records a clone takes. */
export function rootsQueryRefusedStop(
  issue: SoqlRootIssue,
  objectApiName: string | undefined,
): ForgeGateStop {
  return {
    code: 'ROOTS_QUERY_REFUSED',
    message: `${soqlRootIssueWords(issue)}. Nothing was read or written.`,
    ...rootsOf(objectApiName),
  };
}

/** The stop of a query that chooses no record of the source. */
export function noRootsStop(
  objectApiName: string,
  query: ForgeRootsQuery | undefined,
  cap: number,
): ForgeGateStop {
  const where = query?.where !== undefined ? ` WHERE ${query.where}` : '';
  return {
    code: 'NO_ROOTS',
    message:
      query === undefined
        ? `None of the ${objectApiName} records named is in the source org: there is nothing to ` +
          `clone. ${NOTHING_WRITTEN}`
        : `The query chooses no ${objectApiName} record of the source org: there is nothing to ` +
          `clone. Count what it chooses there with sf data query -q "SELECT COUNT() FROM ` +
          `${objectApiName}${where}", and check its WHERE. ${NOTHING_WRITTEN}`,
    ...rootsOf(objectApiName, { cap }),
  };
}

/**
 * The stop of a query that chooses more records than the run takes, with
 * the ways through: the first of them in its order — the newest, of a query
 * that orders them by nothing —, a narrower WHERE, a higher bound, and past
 * the most of all, a sample of the whole org. What the query has already is
 * never proposed: run for real, a query that read ORDER BY CreatedDate DESC,
 * Id DESC was told to add ORDER BY CreatedDate DESC, Id DESC LIMIT 10.
 */
export function rootsExceededStop(
  objectApiName: string,
  cap: number,
  given: 'query' | 'records',
  query?: ForgeRootsQuery,
): ForgeGateStop {
  const most = FORGE_ROOTS_MAX.toLocaleString('en-US');
  const ordered = given === 'query' && query?.orderBy !== undefined;
  const clause = `${ordered ? '' : `ORDER BY ${SOQL_NEWEST_FIRST} `}LIMIT ${cap}`;
  const through =
    given === 'query'
      ? `Give the query ${clause}` +
        (query?.limit !== undefined ? ` in place of its LIMIT ${query.limit}` : '') +
        ` to clone the first ${cap} of its order, narrow its WHERE, or raise --max-roots (the ` +
        `sandforge.forge.maxRoots setting) up to ${most}; past that, copy a sample of the whole ` +
        'org with a filter on its roots.'
      : `Name ${cap} at most, or raise --max-roots up to ${most}.`;
  return {
    code: 'ROOTS_EXCEEDED',
    message:
      `The ${given === 'query' ? 'query chooses' : 'records named are'} more than the ${cap} ` +
      `${objectApiName} records a run clones, and nothing holds ${given === 'query' ? 'it' : 'them'} ` +
      'to that: refused before anything else was read, rather than cut at an order nobody ' +
      `chose. ${through} ${NOTHING_WRITTEN}`,
    ...rootsOf(objectApiName, { cap, ...(ordered ? { ordered: true as const } : {}) }),
  };
}

/** What a refusal of a plan of roots says of it, by why. */
const PLAN_WORDS: Record<Exclude<RootsGatePlanRefusal, 'gone'>, string> = {
  otherOrg: 'were read of another org than this run reads',
  otherQuery: 'were chosen by another query, of another object, or are other records',
  changed: 'are no longer the ids it was kept with',
};

/** The stop of a run given the roots of another org, query or ids. */
export function rootsPlanMismatchStop(
  objectApiName: string,
  refusal: Exclude<RootsGatePlanRefusal, 'gone'>,
): ForgeGateStop {
  return {
    code: 'ROOTS_PLAN_MISMATCH',
    message:
      `The records the dry run chose ${PLAN_WORDS[refusal]}: run the dry run again with this ` +
      `query, and give the run the plan it keeps. ${NOTHING_WRITTEN}`,
    ...(rootsOf(objectApiName).roots ? { roots: { objectApiName, plan: refusal } } : {}),
  };
}

/** The stop of a run that resumes one whose journal does not name its roots. */
export function rootsPlanGoneStop(objectApiName: string): ForgeGateStop {
  return {
    code: 'ROOTS_PLAN_GONE',
    message:
      'The run this one resumes cloned the records a query chose, and its journal does not name ' +
      'them: reading the query again could choose others. Remove what it wrote, then run the ' +
      `clone again. ${NOTHING_WRITTEN}`,
    ...(rootsOf(objectApiName).roots ? { roots: { objectApiName, plan: 'gone' as const } } : {}),
  };
}

/**
 * The stop of a run whose roots reach more records than it may hold before
 * it writes: the objects it had read, with their rows.
 */
export function rootsReadBoundStop(
  roots: number,
  bound: number,
  objects: ReadonlyArray<{ objectApiName: string; rows: number }>,
): ForgeGateStop {
  const last = objects[objects.length - 1];
  const past = last
    ? ` (${last.objectApiName} came to ${last.rows.toLocaleString('en-US')} after ` +
      `${objects.length} object${objects.length === 1 ? '' : 's'})`
    : '';
  return {
    code: 'READ_BOUND_EXCEEDED',
    message:
      `The ${roots} roots reach more than ${bound.toLocaleString('en-US')} records${past}, and a ` +
      'clone from records holds all it reads before it writes. Take fewer records (a LIMIT), ' +
      'clone less deep (--depth direct), leave objects out, or raise --max-read-total. ' +
      NOTHING_WRITTEN,
    readBound: { bound, objects: objects.slice(0, 200).map((o) => ({ ...o })), of: 'roots' },
  };
}

/**
 * The stop of a run whose read of what its roots reach would send the source
 * more requests than it may: those sent, and the statements of the next object.
 */
export function rootsReadingStop(input: {
  roots: number;
  bound: number;
  sent: number;
  next: number;
  objectApiName: string;
  sourceRequestsLeft: number | undefined;
}): ForgeGateStop {
  const { bound, sent, next, objectApiName, sourceRequestsLeft } = input;
  const of =
    sourceRequestsLeft === undefined
      ? 'the source would not say what it has left today'
      : `a tenth of the ${sourceRequestsLeft.toLocaleString('en-US')} it has left today`;
  return {
    code: 'API_BUDGET_EXCEEDED',
    message:
      `Reading what the ${input.roots} roots reach would send the source more than ` +
      `${bound.toLocaleString('en-US')} requests (${of}): ${sent} sent, ${next} more for ` +
      `${objectApiName}. Take fewer records, clone less deep (--depth direct), or leave objects ` +
      `out. ${NOTHING_WRITTEN}`,
    api: {
      kind: 'requests',
      org: 'source',
      estimate: sent + next,
      remaining: sourceRequestsLeft ?? bound,
      reading: { bound },
    },
  };
}
