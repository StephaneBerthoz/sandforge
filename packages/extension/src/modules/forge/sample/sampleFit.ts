/**
 * The cut of a sample of the whole org to its budget, and the draw that reads
 * no more of the source than the cut needs.
 *
 * The roots are closed in batches, the smallest ranks first, each twice the
 * last (256, 512…), as long as the sample at the last rank of a batch fits.
 * The batch that does not is closed whole, so every record whose threshold is
 * within the share kept has been read. The records are then weighed in the
 * order of their thresholds, and the share kept is the largest that fits
 * every bound: the bytes the target has room for (`storage`, or `within` when
 * `--fit-within` is less), the records asked (`maxTotal`), and the bounds on
 * requests the caller prices from the records kept per object. The first
 * bound the next share breaks is the one said to hold the sample. The weight
 * of a share is exact: each record at its documented size, an email at its
 * own, what the target's automation creates under each record written, and
 * one record for each the platform writes with a record of the sample — the
 * direct relation of a contact written with its account, the role of an
 * opportunity written with its contact — once, whether the plan holds it or
 * not.
 *
 * A root that would bring in more than a tenth of the room by itself — the
 * records whose threshold is its own — is set aside, named by its id and by
 * the relation that swells it, and the thresholds are found again without it.
 * The room is the target's, as for the objects copied whole, so that a
 * smaller bound sets aside the same roots and keeps a part of what a larger
 * one keeps. Never the root an object keeps as its floor, nor the first root
 * of the draw: set aside, a room smaller than any root's tenth let every
 * root go, and the run wrote nothing and said it had succeeded. Every other
 * root kept, the roots set aside are what held the sample (`heavyRoots`),
 * never the whole org said to fit beside them.
 *
 * Nothing is cut, and the sample cannot fit, the heaviest named, when the
 * objects copied whole and the floor of each object do not fit alone; and,
 * without floors, when not even the first root fits with what it brings: a
 * sample that keeps no record drawn is no sample, and is never said done.
 */

import {
  type WholeOrgSample,
  type WholeOrgSampleDropReason,
  type WholeOrgSampleLimit,
  type WholeOrgSampleObject,
} from '@sandforge/shared';
import { ACCOUNT, CONTACT } from '../../../core/common/platformRecords.js';
import { largestFitting } from '../fitBudget.js';
import { countedStorageBytes, rowStorageBytes } from '../ForgeRunGate.js';
import {
  SampleClosure,
  type SampleClosureOptions,
  type SampleReader,
  type SampleRow,
  type SampleThresholds,
} from './sampleClosure.js';
import { linkNamed, namesParent, type SampleLinks } from './sampleLinks.js';
import { compareIds, idKey, type DrawnRoot } from './sampleRank.js';

/** What a record of a sample weighs, as the gate weighs what a run writes. */
export interface SampleMeasure {
  /** The data storage one record read of the object takes once written. */
  bytes(objectApiName: string, row: SampleRow): number;
  /** The data storage every record of an object copied whole, and not read, takes. */
  wholeBytes(objectApiName: string, rows: number): number;
  /** What the target's automation that still runs creates under each record of the object the run inserts. */
  roomBytes?(objectApiName: string): number;
}

/**
 * The documented sizes the gate weighs a run by (`rowStorageBytes`,
 * `countedStorageBytes`): 2 KB a record, 4 KB a person account and nothing
 * for its contact, 8 KB a campaign, 1 KB a campaign member, an email the size
 * the reader read of it (`SampleRow.bytes`).
 */
export const documentedMeasure: SampleMeasure = {
  bytes: (objectApiName, row) =>
    row.bytes ?? rowStorageBytes(objectApiName, row.personAccount ? { IsPersonAccount: true } : {}),
  wholeBytes: (objectApiName, rows) => countedStorageBytes(objectApiName, { rows }),
};

/**
 * A record the platform writes itself as the run writes a record of
 * `objectApiName` with its lookup `field` filled: a record of `writes` whose
 * `ownField` names the first and `pairField` the record the lookup names.
 */
export interface PlatformPair {
  objectApiName: string;
  field: string;
  writes: string;
  ownField: string;
  pairField: string;
}

/**
 * The records the platform writes with a record of the run: the direct
 * relation of a contact inserted with its account, and the role of an
 * opportunity inserted with its contact. The run links each it finds rather
 * than send it, and the target holds it all the same: it is counted once.
 */
export const PLATFORM_PAIRS: readonly PlatformPair[] = [
  {
    objectApiName: CONTACT,
    field: 'AccountId',
    writes: 'AccountContactRelation',
    ownField: 'ContactId',
    pairField: 'AccountId',
  },
  {
    objectApiName: 'Opportunity',
    field: 'ContactId',
    writes: 'OpportunityContactRole',
    ownField: 'OpportunityId',
    pairField: 'ContactId',
  },
];

/** The bounds a sample is cut to. */
export interface SampleBounds {
  /** The bytes the records of the sample, and what the automation creates under them, may take. */
  bytes: number;
  /** What gives `bytes`: what the target has left, or the MB asked. */
  bytesLimit: 'storage' | 'within';
  /** The most records the run may write (`--max-total`). */
  maxTotal?: number;
  /**
   * The bounds on requests at the records the run writes per object: the
   * first broken, or nothing when they all hold.
   */
  requests?: (
    written: ReadonlyMap<string, number>,
  ) =>
    Extract<WholeOrgSampleLimit, 'targetRequests' | 'bulkBatches' | 'sourceRequests'> | undefined;
}

/** The roots a draw kept, and how far it read. */
export interface SampleDraw {
  /** The roots, in the draw's order (`compareRoots`). */
  roots: readonly DrawnRoot[];
  /** The smallest rank a root was let go at for want of room (`RootDraw.beyond`). */
  beyond: number;
  /** What bounded the roots kept: the bytes' bound, or `--max-total`. */
  heldBy: 'storage' | 'within' | 'maxTotal';
  /** The roots of each object kept whatever the share (`--fit-floor`): those at rank 0. */
  floor: number;
}

/** What drawing a sample is given: see {@link drawTheSample}. */
export interface DrawSampleInput {
  links: SampleLinks;
  reader: SampleReader;
  draw: SampleDraw;
  /** Per object of the run, the records the source holds, as discovery counted them. */
  sourceRows: ReadonlyMap<string, number>;
  options: SampleClosureOptions;
  measure: SampleMeasure;
  bounds: SampleBounds;
  /** The bytes of the target's room the objects copied whole were chosen against (`SampleLinksInput.roomBytes`). */
  roomBytes: number;
  /** The records the platform writes with the run's; {@link PLATFORM_PAIRS} when left out. */
  platformPairs?: readonly PlatformPair[];
  /** Told where the drawing is, and the records read. */
  onStep?: (step: 'closing' | 'fitting', rows: number) => void;
}

/** A root set aside: see {@link WholeOrgSample.heavyRoots}. */
export type SampleHeavyRoot = WholeOrgSample['heavyRoots'][number];

/** What a sample keeps, said and to be written. */
export interface SampleCut {
  kind: 'sample';
  /** The share of each object's roots kept: the rank the cut stands at, 0 to 1. */
  share: number;
  limitedBy: WholeOrgSampleLimit;
  /** Every record of the whole org would fit the bounds: copying all of it is the better run. */
  wholeOrgFits: boolean;
  /** The records it keeps in all, those of the objects copied whole included, and the data storage the sample takes in the target. */
  rows: number;
  storageBytes: number;
  /** Of its records, those the run sends: none it links, none the platform writes; what `--max-total` counts. */
  written: number;
  objects: WholeOrgSampleObject[];
  heavyRoots: SampleHeavyRoot[];
  dropped: WholeOrgSample['dropped'];
  leftEmpty: WholeOrgSample['leftEmpty'];
  noRecordDrawn: WholeOrgSample['noRecordDrawn'];
  /** Per object, the ids of the plan in our order (`compareIds`); none for an object copied whole and not read. */
  ids: ReadonlyMap<string, readonly string[]>;
  /** Per object, the person accounts among its records, and their contacts. */
  personAccounts: ReadonlyMap<string, number>;
  /**
   * Per object the platform writes records of with the run's, those it
   * writes: of them, the plan's records (`inPlan`), which the run links
   * rather than sends, and the others, which it never reads.
   */
  byThePlatform: Array<{ objectApiName: string; inPlan: number; beyond: number }>;
}

/** Why no sample can be cut: the objects copied whole and the floors alone pass the bounds. */
export interface SampleCannotFit {
  kind: 'cannotFit';
  limitedBy: WholeOrgSampleLimit;
  /** What they take, records and bytes. */
  rows: number;
  storageBytes: number;
  /** The heaviest objects of what they take, the heaviest first. */
  heaviest: Array<{ objectApiName: string; rows: number; storageBytes: number; whole?: true }>;
  /**
   * Set when, without floors, not one root fits: `rows` and `storageBytes`
   * are then the smallest sample that keeps a record drawn, the objects
   * copied whole and the first root with what it brings.
   */
  noRoot?: true;
}

/** The share of the room a root may bring in by itself before it is set aside. */
export const HEAVY_ROOT_SHARE = 0.1;

/** The roots of the first batch; each next is twice the last. */
export const FIRST_BATCH = 256;

/** The most heaviest objects a sample that cannot fit names. */
const HEAVIEST_NAMED = 5;

/** The rank of a threshold: -1 is an object copied whole, before any root. */
function rankOfThreshold(roots: readonly DrawnRoot[], threshold: number): number {
  if (threshold < 0) return -Infinity;
  if (threshold === Infinity) return Infinity;
  return roots[threshold].rank;
}

/** A weighed record of the sample, or one the platform writes, at the rank it enters at. */
interface Item {
  rank: number;
  bytes: number;
  records: number;
  objectApiName: string;
}

/** The records of a closure weighed, at their thresholds. */
interface Weighed {
  items: Item[];
  /** Per row, its bytes once written, the automation's room under it besides. */
  rowBytes: Float64Array;
  /** Per root index, the bytes of the records whose threshold is its own. */
  parts: Map<number, number>;
  /** Per pair of the platform, keyed `writes\nfirst\nsecond`: its threshold, and the rows of the plan that are it. */
  pairs: Map<string, { objectApiName: string; threshold: number; rows: number[] }>;
}

/** What a record of the closure counts for: the records the run sends of it. */
function recordsOf(closure: SampleClosure, row: number): number {
  const read = closure.rows[row];
  if (read.matched) return 0;
  // The platform writes a person account's contact with its account.
  return closure.objectOf[row] === CONTACT && read.personAccount === true ? 0 : 1;
}

/**
 * The pairs the platform writes a record for, by the rows that make them:
 * a living record of the pair's object whose lookup names a living record.
 * Its threshold is the later of the two: the platform writes it only when
 * both are in. A person account's contact is written by the platform with
 * its account, and has none.
 */
function pairsOf(
  closure: SampleClosure,
  thresholds: SampleThresholds,
  pairs: readonly PlatformPair[],
): Weighed['pairs'] {
  const found: Weighed['pairs'] = new Map();
  const { links } = closure;
  const active = pairs.filter(
    (pair) =>
      links.classes.has(pair.writes) &&
      (links.linksOf.get(pair.objectApiName) ?? []).some((link) => link.field === pair.field),
  );
  if (active.length === 0) return found;
  for (let row = 0; row < closure.rows.length; row++) {
    if (!closure.alive(row)) continue;
    for (const pair of active) {
      if (closure.objectOf[row] !== pair.objectApiName) continue;
      const read = closure.rows[row];
      if (pair.objectApiName === CONTACT && read.personAccount) continue;
      const value = read.refs[pair.field];
      const link = linkNamed(links, pair.objectApiName, pair.field, value);
      if (!link || typeof value !== 'string') continue;
      const other = closure.rowOf(link.parent, value);
      if (other === undefined || !closure.alive(other)) continue;
      const threshold = Math.max(thresholds.threshold[row], thresholds.threshold[other]);
      if (threshold === Infinity) continue;
      found.set(`${pair.writes}\n${idKey(read.id)}\n${idKey(value)}`, {
        objectApiName: pair.writes,
        threshold,
        rows: [],
      });
    }
  }
  // The plan's records of each pair: the one that enters first is the
  // platform's; the others, if any, are records of their own.
  for (let row = 0; row < closure.rows.length; row++) {
    if (!closure.alive(row)) continue;
    for (const pair of active) {
      if (closure.objectOf[row] !== pair.writes) continue;
      const { refs } = closure.rows[row];
      const own = refs[pair.ownField];
      const with_ = refs[pair.pairField];
      if (typeof own !== 'string' || typeof with_ !== 'string') continue;
      const entry = found.get(`${pair.writes}\n${idKey(own)}\n${idKey(with_)}`);
      if (entry) entry.rows.push(row);
    }
  }
  for (const entry of found.values()) {
    entry.rows.sort(
      (a, b) =>
        thresholds.threshold[a] - thresholds.threshold[b] ||
        compareIds(closure.rows[a].id, closure.rows[b].id),
    );
  }
  return found;
}

/** Weigh every living record of a closure, and the records the platform writes with them. */
function weigh(
  closure: SampleClosure,
  thresholds: SampleThresholds,
  input: Pick<DrawSampleInput, 'measure' | 'draw' | 'sourceRows' | 'platformPairs'>,
): Weighed {
  const { measure, draw } = input;
  const items: Item[] = [];
  const rowBytes = new Float64Array(closure.rows.length);
  const parts = new Map<number, number>();
  const addPart = (threshold: number, bytes: number): void => {
    if (threshold >= 0 && threshold !== Infinity) {
      parts.set(threshold, (parts.get(threshold) ?? 0) + bytes);
    }
  };
  const pairs = pairsOf(closure, thresholds, input.platformPairs ?? PLATFORM_PAIRS);
  const platformRows = new Set<number>();
  for (const entry of pairs.values()) if (entry.rows.length > 0) platformRows.add(entry.rows[0]);

  for (let row = 0; row < closure.rows.length; row++) {
    if (!closure.alive(row)) continue;
    const objectApiName = closure.objectOf[row];
    const read = closure.rows[row];
    const records = platformRows.has(row) ? 0 : recordsOf(closure, row);
    const own = read.matched || platformRows.has(row) ? 0 : measure.bytes(objectApiName, read);
    const bytes = own + records * (measure.roomBytes?.(objectApiName) ?? 0);
    rowBytes[row] = bytes;
    const threshold = thresholds.threshold[row];
    if (threshold === Infinity) continue;
    items.push({ rank: rankOfThreshold(draw.roots, threshold), bytes, records, objectApiName });
    addPart(threshold, bytes);
  }
  for (const entry of pairs.values()) {
    const bytes = measure.bytes(entry.objectApiName, { id: '', refs: {} });
    items.push({
      rank: rankOfThreshold(draw.roots, entry.threshold),
      bytes,
      records: 0,
      objectApiName: entry.objectApiName,
    });
    addPart(entry.threshold, bytes);
  }
  for (const [objectApiName, kind] of closure.links.classes) {
    if (kind.kind !== 'whole' || closure.wasReadWhole(objectApiName)) continue;
    const rows = input.sourceRows.get(objectApiName) ?? 0;
    const referenceData = kind.why === 'referenceData';
    const records = referenceData ? 0 : rows;
    items.push({
      rank: -Infinity,
      bytes:
        (referenceData ? 0 : measure.wholeBytes(objectApiName, rows)) +
        records * (measure.roomBytes?.(objectApiName) ?? 0),
      records,
      objectApiName,
    });
  }
  items.sort((a, b) => a.rank - b.rank);
  return { items, rowBytes, parts, pairs };
}

/** The bytes and records of the items within `rank`, and per object the records. */
function totalsAt(items: readonly Item[], rank: number, perObject: boolean) {
  let bytes = 0;
  let records = 0;
  const written = new Map<string, number>();
  for (const item of items) {
    if (item.rank > rank) break;
    bytes += item.bytes;
    records += item.records;
    if (perObject && item.records > 0) {
      written.set(item.objectApiName, (written.get(item.objectApiName) ?? 0) + item.records);
    }
  }
  return { bytes, records, written };
}

/** The first bound the items within `rank` break; nothing when they fit. */
function brokenAt(
  items: readonly Item[],
  rank: number,
  bounds: SampleBounds,
): WholeOrgSampleLimit | undefined {
  const totals = totalsAt(items, rank, bounds.requests !== undefined);
  if (totals.bytes > bounds.bytes) return bounds.bytesLimit;
  if (bounds.maxTotal !== undefined && totals.records > bounds.maxTotal) return 'maxTotal';
  return bounds.requests?.(totals.written);
}

/**
 * The thresholds with the heavy roots set aside: each root that brings in
 * more than a tenth of the room by itself goes, and the thresholds are found
 * again, until none does. A record the root brought in may then enter by
 * another root, whose share grows: it may go in turn.
 */
function settle(
  closure: SampleClosure,
  input: DrawSampleInput,
  setAside: Set<number>,
): { thresholds: SampleThresholds; weighed: Weighed } {
  const most = HEAVY_ROOT_SHARE * Math.max(0, input.roomBytes);
  // The floors, at rank 0, and the first root of the draw that lives: never
  // set aside, whatever they bring. Each goes in, or the sample is refused.
  const kept = new Set<number>();
  if (input.draw.floor > 0) {
    input.draw.roots.forEach((root, index) => {
      if (root.rank === 0) kept.add(index);
    });
  }
  const first = firstLivingRoot(closure);
  if (first !== undefined) kept.add(first);
  for (;;) {
    const thresholds = closure.thresholds(setAside);
    const weighed = weigh(closure, thresholds, input);
    const heavy = [...weighed.parts]
      .filter(([root, bytes]) => bytes > most && !setAside.has(root) && !kept.has(root))
      .map(([root]) => root);
    if (heavy.length === 0) return { thresholds, weighed };
    for (const root of heavy) setAside.add(root);
  }
}

/** The index in the draw of the first root read that lives; none when none does. */
function firstLivingRoot(closure: SampleClosure): number | undefined {
  let first: number | undefined;
  for (let row = 0; row < closure.rows.length; row++) {
    const root = closure.rootOf[row];
    if (root >= 0 && closure.alive(row) && (first === undefined || root < first)) first = root;
  }
  return first;
}

/** Why no sample fits at `at`: what the items within it take, and the heaviest of them. */
function cannotFitAt(
  closure: SampleClosure,
  items: readonly Item[],
  at: number,
  bounds: SampleBounds,
): SampleCannotFit {
  const totals = totalsAt(items, at, false);
  const byObject = new Map<string, { rows: number; storageBytes: number }>();
  for (const item of items) {
    if (item.rank > at) break;
    const entry = byObject.get(item.objectApiName) ?? { rows: 0, storageBytes: 0 };
    entry.rows += item.records;
    entry.storageBytes += item.bytes;
    byObject.set(item.objectApiName, entry);
  }
  return {
    kind: 'cannotFit',
    limitedBy: brokenAt(items, at, bounds) ?? bounds.bytesLimit,
    rows: totals.records,
    storageBytes: totals.bytes,
    heaviest: [...byObject]
      .sort(([a, x], [b, y]) => y.storageBytes - x.storageBytes || (a < b ? -1 : a > b ? 1 : 0))
      .slice(0, HEAVIEST_NAMED)
      .map(([objectApiName, entry]) => ({
        objectApiName,
        ...entry,
        ...(closure.links.classes.get(objectApiName)?.kind === 'whole'
          ? { whole: true as const }
          : {}),
      })),
  };
}

/**
 * Draw a sample: close the roots batch by batch, cut it to the bounds, and
 * say what it keeps. Reads the source through `input.reader` only.
 */
export async function drawTheSample(asked: DrawSampleInput): Promise<SampleCut | SampleCannotFit> {
  // The roots at or past the rank a root was let go at are not all there:
  // a share holding them would hold one the draw does not.
  const roots = asked.draw.roots.filter((root) => root.rank < asked.draw.beyond);
  const input: DrawSampleInput = { ...asked, draw: { ...asked.draw, roots } };
  const { bounds } = input;
  const closure = new SampleClosure(input.links, input.reader, {
    ...input.options,
    onRows: (rows) => {
      input.options.onRows?.(rows);
      input.onStep?.('closing', rows);
    },
  });
  await closure.openWhole();
  const setAside = new Set<number>();
  let read = 0;
  let size = FIRST_BATCH;
  let state = settle(closure, input, setAside);
  while (read < roots.length) {
    let end = Math.min(roots.length, read + size);
    // A batch ends between two ranks: a share holds every root of its rank.
    while (end < roots.length && roots[end].rank === roots[end - 1].rank) end++;
    await closure.addRoots(roots.slice(read, end), read);
    read = end;
    size *= 2;
    state = settle(closure, input, setAside);
    if (brokenAt(state.weighed.items, roots[read - 1].rank, bounds) !== undefined) break;
  }
  input.onStep?.('fitting', closure.rows.length);
  return cutOf(closure, state, setAside, input, roots.slice(0, read), read === roots.length);
}

/** The cut of a closure, its roots read: see the file's header. */
function cutOf(
  closure: SampleClosure,
  state: { thresholds: SampleThresholds; weighed: Weighed },
  setAside: ReadonlySet<number>,
  input: DrawSampleInput,
  roots: readonly DrawnRoot[],
  allRead: boolean,
): SampleCut | SampleCannotFit {
  const { bounds, draw } = input;
  const { items } = state.weighed;
  const ranks = [...new Set(roots.map((root) => root.rank))].sort((a, b) => a - b);
  // With floors, the least share holds them all, at rank 0. Without, it may
  // hold no root, the first of a draw by recency, at rank 0, included.
  const candidates = draw.floor > 0 && ranks[0] === 0 ? ranks : [-Infinity, ...ranks];
  const fitting = largestFitting(
    candidates.length,
    (k) => brokenAt(items, candidates[k - 1], bounds) === undefined,
  );
  if (fitting === 0) return cannotFitAt(closure, items, candidates[0], bounds);
  const cut = candidates[fitting - 1];
  // A root lives, and the cut keeps none: the first, never set aside, does
  // not fit with what it brings. The run would write no record drawn.
  const first = firstLivingRoot(closure);
  if (first !== undefined && roots[first].rank > cut) {
    return { ...cannotFitAt(closure, items, roots[first].rank, bounds), noRoot: true };
  }
  const report = reportAt(closure, state, setAside, input, cut);
  // Every root fits: the whole org, but where roots were set aside, which
  // alone keep the sample from it — said so, never that every record fits.
  const limitedBy: WholeOrgSampleLimit =
    fitting < candidates.length
      ? (brokenAt(items, candidates[fitting], bounds) ?? bounds.bytesLimit)
      : !allRead || draw.beyond !== Infinity
        ? draw.heldBy
        : report.heavyRoots.length > 0
          ? 'heavyRoots'
          : 'whole';
  return {
    kind: 'sample',
    // Every root drawn, those set aside apart.
    share: limitedBy === 'whole' || limitedBy === 'heavyRoots' ? 1 : Math.max(0, cut),
    limitedBy,
    wholeOrgFits: wholeOrgFits(closure, input),
    ...report,
  };
}

/** Whether every record of the run, as discovery counted it, fits the bounds. */
function wholeOrgFits(closure: SampleClosure, input: DrawSampleInput): boolean {
  let bytes = 0;
  let records = 0;
  const written = new Map<string, number>();
  for (const [objectApiName, kind] of closure.links.classes) {
    const rows = input.sourceRows.get(objectApiName) ?? 0;
    if (kind.kind === 'whole' && kind.why === 'referenceData') continue;
    bytes += input.measure.wholeBytes(objectApiName, rows);
    records += rows;
    written.set(objectApiName, rows);
  }
  const { bounds } = input;
  return (
    bytes <= bounds.bytes &&
    (bounds.maxTotal === undefined || records <= bounds.maxTotal) &&
    bounds.requests?.(written) === undefined
  );
}

/** How a record kept came in, at the cut. */
type Origin = 'whole' | 'root' | 'below' | 'parent';

/** What the sample at `cut` keeps, and what it says of it. */
function reportAt(
  closure: SampleClosure,
  state: { thresholds: SampleThresholds; weighed: Weighed },
  setAside: ReadonlySet<number>,
  input: DrawSampleInput,
  cut: number,
): Omit<SampleCut, 'kind' | 'share' | 'limitedBy' | 'wholeOrgFits'> {
  const { links } = closure;
  const { thresholds, weighed } = state;
  const roots = input.draw.roots;
  const rankOf = (threshold: number): number => rankOfThreshold(roots, threshold);
  const inSample = (row: number): boolean =>
    closure.alive(row) && rankOf(thresholds.threshold[row]) <= cut;
  const originOf = (row: number): Origin => {
    if (closure.whole[row]) return 'whole';
    const root = closure.rootOf[row];
    if (root >= 0 && !setAside.has(root) && rankOf(root) <= cut) return 'root';
    if (rankOf(thresholds.above[row]) <= cut) return 'below';
    return 'parent';
  };

  const stats = new Map<string, WholeOrgSampleObject>();
  const statOf = (objectApiName: string): WholeOrgSampleObject => {
    let stat = stats.get(objectApiName);
    if (!stat) {
      stat = {
        objectApiName,
        sourceRows: input.sourceRows.get(objectApiName) ?? 0,
        kept: 0,
        roots: 0,
        below: 0,
        asParents: 0,
      };
      if (links.classes.get(objectApiName)?.kind === 'whole') stat.whole = true;
      stats.set(objectApiName, stat);
    }
    return stat;
  };
  const ids = new Map<string, string[]>();
  const persons = new Map<string, number>();
  const dropped = new Map<
    string,
    { objectApiName: string; rows: number; reason: WholeOrgSampleDropReason }
  >();
  const leftEmpty = new Map<string, { objectApiName: string; field: string; rows: number }>();
  const platformRows = new Set<number>();
  for (const entry of weighed.pairs.values())
    if (entry.rows.length > 0) platformRows.add(entry.rows[0]);
  let written = 0;
  let storageBytes = 0;

  for (let row = 0; row < closure.rows.length; row++) {
    const objectApiName = closure.objectOf[row];
    if (!closure.alive(row)) {
      const reason = closure.dead[row];
      if (closure.out[row] || reason === undefined) continue;
      if (rankOf(thresholds.threshold[row]) > cut) continue;
      const key = `${objectApiName}\n${reason}`;
      const entry = dropped.get(key) ?? { objectApiName, rows: 0, reason };
      entry.rows++;
      dropped.set(key, entry);
      continue;
    }
    if (!inSample(row)) continue;
    const read = closure.rows[row];
    const list = ids.get(objectApiName) ?? [];
    list.push(read.id);
    ids.set(objectApiName, list);
    storageBytes += weighed.rowBytes[row];
    written += platformRows.has(row) ? 0 : recordsOf(closure, row);
    if (read.personAccount && (objectApiName === ACCOUNT || objectApiName === CONTACT)) {
      persons.set(objectApiName, (persons.get(objectApiName) ?? 0) + 1);
    }
    if (!read.matched) {
      const stat = statOf(objectApiName);
      stat.kept++;
      const origin = originOf(row);
      if (origin === 'root') stat.roots++;
      else if (origin === 'below') stat.below++;
      else if (origin === 'parent') stat.asParents++;
    }
    for (const link of links.linksOf.get(objectApiName) ?? []) {
      if (link.target === 'excluded') continue;
      if (link.target === 'whole' && !closure.wasReadWhole(link.parent)) continue;
      const value = read.refs[link.field];
      if (!namesParent(value, link)) continue;
      const target = closure.rowOf(link.parent, value);
      if (target !== undefined && inSample(target)) continue;
      const key = `${objectApiName}\n${link.field}`;
      const entry = leftEmpty.get(key) ?? { objectApiName, field: link.field, rows: 0 };
      entry.rows++;
      leftEmpty.set(key, entry);
    }
  }

  // The objects copied whole and not read: every record, at the count discovery gave.
  for (const [objectApiName, kind] of links.classes) {
    if (kind.kind !== 'whole' || closure.wasReadWhole(objectApiName)) continue;
    const count = input.sourceRows.get(objectApiName) ?? 0;
    const stat = statOf(objectApiName);
    stat.kept = count;
    if (kind.why !== 'referenceData') {
      written += count;
      storageBytes +=
        input.measure.wholeBytes(objectApiName, count) +
        count * (input.measure.roomBytes?.(objectApiName) ?? 0);
    }
  }
  const byThePlatform = new Map<
    string,
    { objectApiName: string; inPlan: number; beyond: number }
  >();
  for (const entry of weighed.pairs.values()) {
    if (rankOf(entry.threshold) > cut) continue;
    const said = byThePlatform.get(entry.objectApiName) ?? {
      objectApiName: entry.objectApiName,
      inPlan: 0,
      beyond: 0,
    };
    // The plan's record of the pair weighs nothing of its own: the pair
    // weighs one record, held in the plan or not.
    if (entry.rows.length > 0 && inSample(entry.rows[0])) said.inPlan++;
    else said.beyond++;
    storageBytes += input.measure.bytes(entry.objectApiName, { id: '', refs: {} });
    byThePlatform.set(entry.objectApiName, said);
  }

  // The children the cap left out, of the records the sample went down from.
  for (const [relation, parents] of closure.cut) {
    let left = 0;
    for (const [parent, count] of parents) {
      if (inSample(parent) && rankOf(thresholds.above[parent]) <= cut) left += count;
    }
    if (left === 0) continue;
    const dot = relation.indexOf('.');
    const stat = statOf(relation.slice(0, dot));
    stat.childrenCut = [
      ...(stat.childrenCut ?? []),
      { field: relation.slice(dot + 1), rows: left },
    ];
  }

  const objects = [...stats.values()]
    .filter((stat) => stat.kept > 0)
    .sort((a, b) => b.kept - a.kept || (a.objectApiName < b.objectApiName ? -1 : 1));
  const noRecordDrawn = [...links.classes]
    .filter(([objectApiName, kind]) => {
      const sourceRows = input.sourceRows.get(objectApiName) ?? 0;
      return kind.kind === 'drawn' && sourceRows > 0 && (stats.get(objectApiName)?.kept ?? 0) === 0;
    })
    .map(([objectApiName]) => ({
      objectApiName,
      sourceRows: input.sourceRows.get(objectApiName) ?? 0,
    }))
    .sort((a, b) => (a.objectApiName < b.objectApiName ? -1 : 1));

  return {
    rows: objects.reduce((sum, stat) => sum + stat.kept, 0),
    storageBytes,
    written,
    objects,
    heavyRoots: heavyRootsOf(closure, state, setAside, roots, cut),
    dropped: [...dropped.values()].sort(byObjectThen((d) => d.reason)),
    leftEmpty: [...leftEmpty.values()].sort(byObjectThen((e) => e.field)),
    noRecordDrawn,
    ids: new Map([...ids].map(([objectApiName, list]) => [objectApiName, list.sort(compareIds)])),
    personAccounts: persons,
    byThePlatform: [...byThePlatform.values()].sort((a, b) =>
      a.objectApiName < b.objectApiName ? -1 : 1,
    ),
  };
}

/** An order by object name, then by `then`. */
function byObjectThen<T extends { objectApiName: string }>(
  then: (entry: T) => string,
): (a: T, b: T) => number {
  return (a, b) => {
    if (a.objectApiName !== b.objectApiName) return a.objectApiName < b.objectApiName ? -1 : 1;
    const x = then(a);
    const y = then(b);
    return x < y ? -1 : x > y ? 1 : 0;
  };
}

/**
 * The roots set aside that the share kept would have held, each with the
 * records it would have brought in by itself and the relation that brought
 * most of their weight. Their records are found by the thresholds as they
 * were before they went: the thresholds once each is set aside alone.
 */
function heavyRootsOf(
  closure: SampleClosure,
  state: { thresholds: SampleThresholds; weighed: Weighed },
  setAside: ReadonlySet<number>,
  roots: readonly DrawnRoot[],
  cut: number,
): SampleHeavyRoot[] {
  const named = [...setAside].filter((root) => roots[root].rank <= cut).sort((a, b) => a - b);
  if (named.length === 0) return [];
  const heavy: SampleHeavyRoot[] = [];
  for (const root of named) {
    const without = new Set(setAside);
    without.delete(root);
    const thresholds = closure.thresholds(without);
    let rows = 0;
    const byRelation = new Map<string, number>();
    for (let row = 0; row < closure.rows.length; row++) {
      if (!closure.alive(row) || thresholds.threshold[row] !== root) continue;
      rows++;
      const via = thresholds.via[row];
      if (via !== undefined) {
        byRelation.set(via, (byRelation.get(via) ?? 0) + state.weighed.rowBytes[row]);
      }
    }
    const [relation] = [...byRelation].sort(
      ([a, x], [b, y]) => y - x || (a < b ? -1 : a > b ? 1 : 0),
    )[0] ?? [`${roots[root].objectApiName}.Id`];
    const dot = relation.indexOf('.');
    heavy.push({
      objectApiName: roots[root].objectApiName,
      id: roots[root].id,
      rows,
      relation: { objectApiName: relation.slice(0, dot), field: relation.slice(dot + 1) },
    });
  }
  return heavy;
}
