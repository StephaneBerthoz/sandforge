/**
 * The rank of a root of a sample of the whole org, and the roots a draw keeps.
 *
 * A record no lookup of its own ties to a record above it is a root: an
 * account, a contact without an account, a task on nothing. A sample keeps a
 * share of each object's roots, and everything under them, so which roots it
 * keeps is decided once, here, by a number of each root's own: its rank.
 *
 * - Drawn spread over the org (`uniform`, the default), the rank is the first
 *   53 bits of SHA-256 of the seed and the id's fifteen characters, read as a
 *   number in [0, 1). The same seed ranks the same id the same way whatever
 *   order the org answers in, a plan and its run keep the same records, and a
 *   share p keeps about p of each object's roots, the old with the new.
 * - Drawn by recency (`recent`), the rank is the root's place in the order
 *   the reader reads them in, the most recently created first, over the roots
 *   its object holds: only those kept are read. That order is the reader's
 *   (by creation date, then id), never the order of ids: an org's ids follow
 *   creation within one load, and not from one load to the next, where
 *   records made hours apart pass each other.
 *
 * The draw keeps the roots of the smallest ranks across every object: no more
 * than the budget could hold, each root being a record of at least the
 * smallest documented size. A root past that could never enter the sample, as
 * those of smaller rank fill the budget before it. Besides, the roots of the
 * smallest rank of each object (its floor, one by default, as Autopilot keeps
 * one) take the rank 0: an object that holds roots has one in the sample,
 * whatever the share.
 *
 * Nothing here reads an org: the reader of the source hands each root id in.
 */

import { createHash } from 'node:crypto';

/**
 * The record an id names, as fifteen case-sensitive characters: the API
 * answers eighteen, a lookup may hold either, and both name the same record.
 */
export function idKey(id: string): string {
  return id.slice(0, 15);
}

/**
 * The order of ids a plan keeps its records in, a resume reads them in, and
 * a draw breaks its ties by: the fifteen characters, code unit by code unit.
 * Ours, so that a plan does not hang on how an org answers; it is the order
 * of `ORDER BY Id` all the same — an org writes an id's characters from
 * `0-9A-Za-z`, and a scratch org sorted 74 238 ids in the order of their
 * bytes —, which a run that reads a plan's object through its cursor, and
 * resumes it after `Id > :last`, relies on.
 */
export function compareIds(a: string, b: string): number {
  const x = idKey(a);
  const y = idKey(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

/** 2^21: the low 21 bits of the rank, after its high 32. */
const LOW_BITS_SPAN = 2 ** 21;

/** 2^53: every integer below it is exact in a number, so a rank is too. */
const RANK_SPAN = 2 ** 53;

/**
 * The rank of a root drawn spread over the org: the first 53 bits of
 * SHA-256(`${seed}:${id15}`), over 2^53, in [0, 1).
 */
export function rankOf(seed: number, id: string): number {
  const digest = createHash('sha256')
    .update(`${seed}:${idKey(id)}`)
    .digest();
  const high = digest.readUInt32BE(0);
  const low = digest.readUInt32BE(4) >>> 11;
  return (high * LOW_BITS_SPAN + low) / RANK_SPAN;
}

/**
 * The rank of a root drawn by recency: its place in the reader's order, the
 * most recently created first, 0 for the first, over the roots its object
 * holds. A source that gained roots since they were counted keeps the rank
 * below 1.
 *
 * @param position - The root's place in the read, by recency, from 0.
 * @param roots - The roots its object holds, as they were counted.
 */
export function recentRankOf(position: number, roots: number): number {
  return position / Math.max(roots, position + 1);
}

/**
 * The smallest data storage a record takes, as Salesforce documents it: a
 * campaign member's 1 KB. An email takes its own size, and is not counted on.
 */
export const SMALLEST_RECORD_BYTES = 1024;

/**
 * The most roots a sample could hold: a root is a record of the sample, of at
 * least {@link SMALLEST_RECORD_BYTES}, and the sample holds no more records
 * than `--max-total` asks. None when the budget holds none.
 */
export function rootsTheBudgetHolds(bytes: number, maxTotal?: number): number {
  const byBytes = Math.floor(Math.max(0, bytes) / SMALLEST_RECORD_BYTES);
  return Math.max(0, Math.min(byBytes, maxTotal ?? Infinity));
}

/** A root a draw keeps: its object, its id and its rank. */
export interface DrawnRoot {
  objectApiName: string;
  id: string;
  rank: number;
}

/**
 * Whether root `a` comes before root `b`: the smaller rank first, then the
 * object, then the id. The order of the roots of a sample, which no reading
 * order changes.
 */
export function compareRoots(a: DrawnRoot, b: DrawnRoot): number {
  if (a.rank !== b.rank) return a.rank < b.rank ? -1 : 1;
  if (a.objectApiName !== b.objectApiName) return a.objectApiName < b.objectApiName ? -1 : 1;
  return compareIds(a.id, b.id);
}

/** A heap of roots whose top is the root that comes last ({@link compareRoots}). */
class LastFirstHeap {
  private readonly items: DrawnRoot[] = [];

  get size(): number {
    return this.items.length;
  }

  /** The root that comes last; none when empty. */
  peek(): DrawnRoot | undefined {
    return this.items[0];
  }

  push(root: DrawnRoot): void {
    const items = this.items;
    items.push(root);
    let at = items.length - 1;
    while (at > 0) {
      const up = (at - 1) >> 1;
      if (compareRoots(items[at], items[up]) <= 0) break;
      [items[at], items[up]] = [items[up], items[at]];
      at = up;
    }
  }

  /** Take the root that comes last out, and give it back. */
  pop(): DrawnRoot | undefined {
    const items = this.items;
    const top = items[0];
    const last = items.pop();
    if (items.length === 0 || last === undefined) return top;
    items[0] = last;
    let at = 0;
    for (;;) {
      const left = 2 * at + 1;
      const right = left + 1;
      let largest = at;
      if (left < items.length && compareRoots(items[left], items[largest]) > 0) largest = left;
      if (right < items.length && compareRoots(items[right], items[largest]) > 0) largest = right;
      if (largest === at) break;
      [items[at], items[largest]] = [items[largest], items[at]];
      at = largest;
    }
    return top;
  }

  values(): readonly DrawnRoot[] {
    return this.items;
  }
}

/** A root by its object and the record its id names. */
function keyOf(root: DrawnRoot): string {
  return `${root.objectApiName}\n${idKey(root.id)}`;
}

/**
 * The roots a draw keeps, offered one at a time as the source is read: the
 * `most` of smallest rank across every object, and of each object its `floor`
 * of smallest rank, which take the rank 0.
 */
export class RootDraw {
  private readonly kept = new LastFirstHeap();
  private readonly floors = new Map<string, LastFirstHeap>();
  /** The roots in `kept`, and those in a floor, by object and id key. */
  private readonly inKept = new Set<string>();
  private readonly inFloor = new Set<string>();
  /** The smallest rank a root was let go at for want of room, kept by neither. */
  private letGo = Infinity;

  /**
   * @param most - The most roots kept by rank ({@link rootsTheBudgetHolds}).
   * @param floor - The roots of each object kept whatever their rank (`--fit-floor`).
   */
  constructor(
    private readonly most: number,
    private readonly floor: number,
  ) {}

  /** Offer a root of `objectApiName`, ranked `rank`. */
  offer(objectApiName: string, id: string, rank: number): void {
    const root: DrawnRoot = { objectApiName, id, rank };
    const out: DrawnRoot[] = [];
    if (this.floor > 0) {
      let floor = this.floors.get(objectApiName);
      if (!floor) {
        floor = new LastFirstHeap();
        this.floors.set(objectApiName, floor);
      }
      floor.push(root);
      this.inFloor.add(keyOf(root));
      if (floor.size > this.floor) {
        const last = floor.pop();
        if (last) {
          this.inFloor.delete(keyOf(last));
          out.push(last);
        }
      }
    }
    if (this.most > 0) {
      this.kept.push(root);
      this.inKept.add(keyOf(root));
      if (this.kept.size > this.most) {
        const last = this.kept.pop();
        if (last) {
          this.inKept.delete(keyOf(last));
          out.push(last);
        }
      }
    } else {
      out.push(root);
    }
    // Let go is a root neither keeps: one its object keeps as its floor goes
    // in at rank 0, and one the budget keeps goes in at its own.
    for (const last of out) {
      const key = keyOf(last);
      if (!this.inKept.has(key) && !this.inFloor.has(key))
        this.letGo = Math.min(this.letGo, last.rank);
    }
  }

  /**
   * Whether a root of `objectApiName` ranked `rank` would still be kept: a
   * draw by recency reads an object's roots the most recent first, and stops
   * once its next could not be — its floor filled, and the roots kept all of
   * smaller rank.
   */
  keeps(objectApiName: string, rank: number): boolean {
    if (this.floor > 0 && (this.floors.get(objectApiName)?.size ?? 0) < this.floor) return true;
    if (this.kept.size < this.most) return true;
    const last = this.kept.peek();
    return last !== undefined && rank < last.rank;
  }

  /**
   * The smallest rank a root was let go at for want of room; Infinity when
   * none was. A share at or past it would hold roots the draw does not.
   */
  get beyond(): number {
    return this.letGo;
  }

  /**
   * The roots kept, each once: those of each object's floor at rank 0, then
   * every one in the order {@link compareRoots} gives.
   */
  drawn(): DrawnRoot[] {
    const byKey = new Map<string, DrawnRoot>();
    for (const root of this.kept.values()) byKey.set(keyOf(root), root);
    for (const floor of this.floors.values()) {
      for (const root of floor.values()) byKey.set(keyOf(root), { ...root, rank: 0 });
    }
    return [...byKey.values()].sort(compareRoots);
  }
}
