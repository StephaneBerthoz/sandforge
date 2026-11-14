/**
 * The roots of an object of a sample of the whole org drawn by strata
 * (`--fit-strata`): each value of one of its fields — a picklist's, a
 * checkbox's, a lookup's, or none — is a stratum, and the sample keeps the
 * same share of the roots of each.
 *
 * - **Rank.** A root's rank is its place i in its stratum, in the order of
 *   the draw — its rank spread over the org and then its id (`uniform`), or
 *   the date it was made (`recent`, `oldest`) —, over the N roots the
 *   stratum holds: (i + ½)/N. At a share p a stratum keeps the roots ranked
 *   p at most, round(p·N) of them: exactly its part. With ½ rather than 0, a
 *   stratum of one root is ranked ½, not 0: drawn with no floor
 *   (`--fit-floor 0`), two thousand owners of one account each would
 *   otherwise all enter at the least share.
 * - **Floor.** Each stratum keeps its own (`RootDraw`, by object and
 *   stratum): a record type of thirty accounts among two million has its
 *   account in the sample, where a tenth of a percent would give it none
 *   nine times in ten.
 * - **Read.** No more roots of a stratum are read than can enter the
 *   sample: the budget holds `most` roots ({@link rootsTheBudgetHolds}), so
 *   of an object of ΣN roots in S strata it keeps at most most + S/2 of them
 *   at the share it reaches — each stratum keeps round(p·N) ≥ p·N − ½ —, and
 *   a stratum of N at most ⌈(most + S)·N/ΣN⌉ + 1, its floor besides
 *   ({@link strataTakesOf}). Drawn spread over the org, every root is
 *   scanned and each stratum keeps that many of its smallest in a heap; by
 *   date, a statement per value reads that many.
 * - **Guard.** Whatever was read, the rank of the first root of a stratum
 *   left unread bounds the share ({@link StratifiedRoots.firstUnread}): a
 *   share past it would say it holds a root the draw never read.
 *
 * Nothing here reads an org: the reader counts the strata (`GROUP BY`) and
 * hands each root in with its value.
 */

import type { ForgeSampleDraw, WholeOrgSampleRoots } from '@sandforge/shared';
import { LastFirstHeap, compareRoots, rankOf } from './sampleRank.js';
import type { StratumValue } from './sampleReader.js';

/** The values of a stratified object its report lists, those of the most roots first; the others are counted. */
export const STRATA_VALUES_LISTED = 50;

/**
 * The stratum a value is in, as a key, the value as the reader hands it in
 * (`StratumValue`): a checkbox apart from a text of the same words, and none
 * apart from both.
 */
export function stratumKeyOf(value: StratumValue): string {
  if (value === null) return 'none';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return `=${value}`;
}

/**
 * The rank of the root at `position` of its stratum, in the order of the
 * draw, from 0, among the `roots` the stratum holds: (i + ½)/N. A stratum
 * that gained roots since it was counted keeps the rank below 1.
 */
export function stratumRankOf(position: number, roots: number): number {
  return (position + 0.5) / Math.max(roots, position + 1);
}

/**
 * How many roots of each stratum of one object a draw reads, by the roots
 * each holds: min(N, ⌈(most + S)·N/ΣN⌉ + 1 + floor), `most` the roots the
 * budget holds and S the strata. Past it no root can enter: see the
 * module's comment. None of a stratum counted empty.
 */
export function strataTakesOf(roots: readonly number[], most: number, floor: number): number[] {
  const total = roots.reduce((sum, n) => sum + Math.max(0, n), 0);
  const room = Math.max(0, most) + roots.length;
  return roots.map((n) =>
    n <= 0 ? 0 : Math.min(n, Math.ceil((room * n) / total) + 1 + Math.max(0, floor)),
  );
}

/**
 * One value of a stratified object, as the count gave it (`RootCount.strata`,
 * its `rows` the roots here), and the roots of it the draw reads.
 */
export interface StratumCount {
  value: StratumValue;
  /** The roots of that value the count selected. */
  roots: number;
  /** The roots of it the draw reads: see {@link strataTakesOf}. */
  take: number;
}

/** What drawing the roots of one stratified object is given: see {@link StratifiedRoots}. */
export interface StratifiedRootsInput {
  objectApiName: string;
  field: string;
  /** Each value the count gave, with its roots and those read of it. */
  strata: readonly StratumCount[];
  draw: ForgeSampleDraw;
  seed: number;
  /**
   * The roots of each stratum kept whatever the share: of a value the count
   * did not give, which a scan spread over the org may meet, that many and
   * two besides are kept — as many as a counted stratum of one root.
   */
  floor: number;
}

/** A root read, ranked in its stratum. */
export interface StratifiedRoot {
  id: string;
  rank: number;
  /** The key of its stratum ({@link stratumKeyOf}): what its floor is kept by. */
  stratum: string;
}

/** One stratum, as the draw reads it. */
interface Stratum {
  key: string;
  value: StratumValue;
  /** The roots the count gave; none of a value it did not give. */
  counted: number;
  /** Spread over the org, the roots scanned: the stratum's exact roots once the scan is done. */
  scanned: number;
  take: number;
  /** Spread over the org, the `take` smallest roots scanned, by rank then id. */
  heap: LastFirstHeap;
  /** By date, the ids read, in the order of the draw. */
  read: string[];
}

/**
 * The roots of one object drawn by strata: see the module's comment. A draw
 * spread over the org hands in every root it scans ({@link scanned}); one by
 * date, the roots of each value in its order ({@link read}). Then
 * {@link ranked} gives each root read with its rank and stratum, which
 * `RootDraw.offer` takes, and {@link firstUnread} the rank past which the
 * share holds roots not read.
 */
export class StratifiedRoots {
  private readonly strata = new Map<string, Stratum>();

  constructor(private readonly input: StratifiedRootsInput) {
    for (const count of input.strata) {
      const key = stratumKeyOf(count.value);
      const known = this.strata.get(key);
      if (known) {
        known.counted += Math.max(0, count.roots);
        known.take += Math.max(0, count.take);
        continue;
      }
      this.strata.set(key, {
        key,
        value: count.value,
        counted: Math.max(0, count.roots),
        scanned: 0,
        take: Math.max(0, count.take),
        heap: new LastFirstHeap(),
        read: [],
      });
    }
  }

  get objectApiName(): string {
    return this.input.objectApiName;
  }

  get field(): string {
    return this.input.field;
  }

  /**
   * The values a draw by date reads, each with the roots it reads of it, in
   * the order of their keys: a statement each, `<field> = <value>`.
   */
  reads(): Array<{ value: StratumValue; key: string; roots: number; take: number }> {
    return [...this.strata.values()]
      .filter((stratum) => stratum.take > 0)
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
      .map((stratum) => ({
        value: stratum.value,
        key: stratum.key,
        roots: stratum.counted,
        take: stratum.take,
      }));
  }

  /**
   * A root scanned by a draw spread over the org, with its value of the
   * field. Its stratum keeps it while it is among its `take` smallest, by
   * its rank spread over the org and then its id, whatever order the scan
   * hands it in.
   */
  scanned(id: string, value: StratumValue): void {
    const key = stratumKeyOf(value);
    let stratum = this.strata.get(key);
    if (!stratum) {
      // A value the count did not give: rows written between the count and
      // the scan. Read as a stratum of one root would be.
      stratum = {
        key,
        value,
        counted: 0,
        scanned: 0,
        take: Math.max(0, this.input.floor) + 2,
        heap: new LastFirstHeap(),
        read: [],
      };
      this.strata.set(key, stratum);
    }
    stratum.scanned++;
    stratum.heap.push({
      objectApiName: this.input.objectApiName,
      id,
      rank: rankOf(this.input.seed, id),
    });
    if (stratum.heap.size > stratum.take) stratum.heap.pop();
  }

  /**
   * The roots of one value read by a draw by date, in its order — the next
   * after those read before. The value is one {@link reads} gave.
   *
   * @throws For a value the count did not give: nothing reads it.
   */
  read(value: StratumValue, ids: readonly string[]): void {
    const stratum = this.strata.get(stratumKeyOf(value));
    if (!stratum) {
      throw new Error(
        `${this.input.objectApiName}.${this.input.field} was not counted with that value: ` +
          'its roots are not read.',
      );
    }
    stratum.read.push(...ids);
  }

  /** The roots a stratum holds, as its ranks are counted over: those scanned, or those counted. */
  private rootsOf(stratum: Stratum): number {
    return this.input.draw === 'uniform' ? stratum.scanned : stratum.counted;
  }

  /** The ids of a stratum's roots read, in the order of the draw. */
  private orderOf(stratum: Stratum): string[] {
    if (this.input.draw !== 'uniform') return stratum.read;
    return [...stratum.heap.values()].sort(compareRoots).map((root) => root.id);
  }

  /**
   * Every root read, with its rank in its stratum and the stratum's key:
   * (i + ½)/N, N the roots scanned of a draw spread over the org, the roots
   * counted of a draw by date.
   */
  ranked(): StratifiedRoot[] {
    const ranked: StratifiedRoot[] = [];
    for (const stratum of this.strata.values()) {
      const roots = this.rootsOf(stratum);
      this.orderOf(stratum).forEach((id, position) => {
        ranked.push({ id, rank: stratumRankOf(position, roots), stratum: stratum.key });
      });
    }
    return ranked;
  }

  /**
   * The smallest rank of a root of a stratum left unread; Infinity when
   * every root was. Spread over the org, those past a stratum's heap; by
   * date, the next after a read that stopped at its `take` short of the
   * roots counted. The share is held below it.
   */
  get firstUnread(): number {
    let first = Infinity;
    for (const stratum of this.strata.values()) {
      const scan = this.input.draw === 'uniform';
      const unread = scan
        ? stratum.scanned > stratum.take
        : stratum.read.length >= stratum.take && stratum.take < stratum.counted;
      if (!unread) continue;
      const at = scan ? stratum.take : stratum.read.length;
      first = Math.min(first, stratumRankOf(at, this.rootsOf(stratum)));
    }
    return first;
  }

  /**
   * The strata as a sample's report says them: per value, the roots it
   * holds and those `kept`, the values of the most roots first, the fifty
   * first listed and the others counted (`more`). `labelOf` names a value —
   * a record type by its DeveloperName —; a picklist is said by its value, a
   * lookup by its id.
   */
  report(
    kept: (id: string) => boolean,
    labelOf?: (value: StratumValue) => string | undefined,
  ): NonNullable<WholeOrgSampleRoots['strata']>[number] {
    const values = [...this.strata.values()]
      .map((stratum) => {
        const label = labelOf?.(stratum.value);
        return {
          key: stratum.key,
          entry: {
            value: stratum.value,
            ...(label !== undefined ? { label } : {}),
            roots: this.rootsOf(stratum),
            kept: this.orderOf(stratum).filter((id) => kept(id)).length,
          },
        };
      })
      .sort((a, b) =>
        a.entry.roots !== b.entry.roots
          ? b.entry.roots - a.entry.roots
          : a.key < b.key
            ? -1
            : a.key > b.key
              ? 1
              : 0,
      );
    const more = values.length - STRATA_VALUES_LISTED;
    return {
      objectApiName: this.input.objectApiName,
      field: this.input.field,
      values: values.slice(0, STRATA_VALUES_LISTED).map((value) => value.entry),
      ...(more > 0 ? { more } : {}),
    };
  }
}
