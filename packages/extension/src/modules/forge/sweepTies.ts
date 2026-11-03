/**
 * What ties a record a sweep found to the run it sweeps after, and so which
 * class it falls in: computed from what the sweep read, reading nothing.
 *
 * A sweep once took everything the run's user created in the run's window,
 * tied to the run or not. Two runs of the same user then swept each other's
 * records — on an org every session writes to as one user, and in a client
 * sandbox SandForge signs in to as the admin or the integration user — and a
 * two-hour load took the work done by hand meanwhile. The other way round,
 * one asset made by hand refused the whole sweep, though the target's flow had
 * hung the client's 66 assets under the run's cases. What the run's user
 * created is not enough either: a quote line the platform copied from an
 * opportunity line the run inserted carries the run's user as its creator, as
 * the run's own lines do. A record is the run's when it is tied to what the
 * run wrote, and when it came soon enough after it.
 *
 * Tied, one of three ways:
 * - under: one of its lookups points at a record of the run (a task's
 *   `WhatId` at the case the run created);
 * - pointed at: a record of the run points at it (`Case.AssetId` at the
 *   asset the case's flow created);
 * - in a chain: it points at a record already tied, {@link TIE_DEPTH} links
 *   at most (a feed comment on the feed item of a case: two).
 *
 * The records of the run a record is tied to: those it created, and those it
 * only wrote over (a Sync run's updates and matched upserts), which tie no
 * more than `madeOver`. Never those it only linked to — the standard price
 * book, an account it matched, a user: a task made under an account the run
 * pointed at is not the run's.
 *
 * Then by when it was created, against the record of the run it is tied to
 * (in a chain, the record at its end):
 * - from {@link TIE_LEAD_MS} before to {@link MADE_WITHIN_MS} after: `made`,
 *   and of them `sameSave` within {@link SAME_SAVE_MS} — the same save, what
 *   a flow running in the transaction creates;
 * - past that, up to {@link LATE_WITHIN_MS}, and before the removal began:
 *   `late`, what a queued job, a scheduled path or a platform event's
 *   subscriber made, listed and kept unless asked for;
 * - created by the org's Automated Process user, tied, within the same
 *   fifteen minutes: `late` too — that user creates for much else than a run,
 *   and is never taken unasked;
 * - later still, it is no longer told from hand work: tied to nothing.
 *
 * What the run's user created in the run's window tied to nothing is
 * `untied`: listed, kept unless asked for. Anything else found — tied to
 * nothing outside the window, or by Automated Process — is in no class.
 */

/**
 * How long before the record of the run it is tied to a record may have been
 * created and still be its: the org dates a record to the second, and a
 * child saved in the same transaction as its parent can be dated a second
 * before it. Kept from the design until P2-2 (a tour 0 probe deferred: the
 * gap a flow's record shows to its parent, on an insert of 200) measures it.
 */
export const TIE_LEAD_MS = 2_000;

/**
 * Within this of the record of the run it is tied to, a record is of the same
 * save (`sameSave`): what a flow running in the transaction creates. Kept
 * from the design until P2-2 measures the gap on an insert of 200.
 */
export const SAME_SAVE_MS = 2_000;

/**
 * At most this after the record of the run it is tied to, a record is `made`
 * for the run: what an asynchronous path writes seconds after the save. Kept
 * from the design until P2-2 (an immediate path, a "Run Asynchronously" path,
 * a scheduled path, a platform event's flow and a trigger's Queueable, each
 * creating a task under the contacts of an insert) times each of them.
 */
export const MADE_WITHIN_MS = 60_000;

/**
 * At most this after the record of the run it is tied to, a record is `late`:
 * tied, but later than an asynchronous path writes. Past it, a record is not
 * told from what a person made by hand under the run's records. Kept from the
 * design until P2-2 times a scheduled path and a queued job.
 */
export const LATE_WITHIN_MS = 15 * 60_000;

/**
 * Links a chain follows at most, from a record found to the record of the
 * run it ends at: a feed comment on a feed item of a case is two.
 */
export const TIE_DEPTH = 3;

/**
 * The most ids of what the sweeps of a run found made for it kept for the
 * next one, per object: what a sweep reads at most of one (`SWEEP_OBJECT_BOUND`).
 */
export const MADE_KEPT_PER_OBJECT = 10_000;

/**
 * What the sweeps of a run found made for it, to keep beside the run for the
 * next one (`SweepTies.madeEarlier`): those kept, then those this sweep
 * found, each once by the first fifteen characters of its id,
 * {@link MADE_KEPT_PER_OBJECT} per object at most — an object by the first
 * three characters of its ids. What does not read as an id is left out: every
 * id kept ends up in a delete.
 */
export function madeKept(
  earlier: readonly string[] | undefined,
  found: Iterable<string>,
): string[] {
  const seen = new Set<string>();
  const perObject = new Map<string, number>();
  const kept: string[] = [];
  for (const id of [...(earlier ?? []), ...found]) {
    const key = id.slice(0, 15);
    if (!/^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/.test(id) || seen.has(key)) continue;
    const object = key.slice(0, 3);
    const count = perObject.get(object) ?? 0;
    if (count >= MADE_KEPT_PER_OBJECT) continue;
    seen.add(key);
    perObject.set(object, count + 1);
    kept.push(id);
  }
  return kept;
}

/** The class a record a sweep found falls in (`ForgeSweepClasses`). */
export type SweepClass = 'made' | 'madeOver' | 'late' | 'untied';

/**
 * When a record a sweep takes goes, against the run's own records:
 * - `before`: deleted by the sweep before the run's records, as ever;
 * - `with`: under a record the run created by a chain of lookups the org
 *   deletes along with what they point at — it goes in cascade with it;
 * - `after`: a record of the run points at it by a lookup the org refuses
 *   its delete for (`Case.AssetId`): it can go only once that record is gone.
 */
export type SweepTurn = 'before' | 'with' | 'after';

/** A record of the run's, as a sweep ties records to it. */
export interface SweepAnchor {
  /** `created`: the run created it, and its removal deletes it. `overwritten`: the run only wrote over it. */
  kind: 'created' | 'overwritten';
  /**
   * When the run wrote it, in epoch milliseconds on the org's clock: a
   * created record's `CreatedDate`, both ends; a record written over, the
   * span of the writes. NaN when it could not be read: the run's span is
   * taken then ({@link SweepTieInput.runSpan}).
   */
  from: number;
  to: number;
}

/** A lookup of a record found, to a record a sweep knows. */
export interface SweepReference {
  /** The record it points at, by its first fifteen characters. */
  key: string;
  /** Whether the org deletes the record found along with the one it points at (`cascadeDelete`). */
  cascade: boolean;
}

/** A record a sweep found, as its ties are told. */
export interface SweepCandidate {
  /** Its id, by its first fifteen characters. */
  key: string;
  /** When it was created, in epoch milliseconds on the org's clock. */
  created: number;
  /** Created by the org's Automated Process user rather than the run's. */
  automatedProcess: boolean;
  /** Its lookups to records the sweep knows: the run's, and the others found. */
  references: readonly SweepReference[];
}

/** A lookup of a record of the run to a record found. */
export interface SweepPointer {
  /** The record of the run, by key. */
  from: string;
  /** The record found it points at, by key. */
  to: string;
  /** Whether the org refuses the found record's delete while the lookup names it (`restrictedDelete`). */
  restricted: boolean;
}

/** What the ties are told from. */
export interface SweepTieInput {
  /** The records of the run's, by key. */
  anchors: ReadonlyMap<string, SweepAnchor>;
  candidates: readonly SweepCandidate[];
  pointers: readonly SweepPointer[];
  /** The span of the run's writes on the org's clock, epoch milliseconds: the time of a record of the run that could not be read. */
  runSpan: { from: number; to: number };
  /** The run's window, epoch milliseconds: what the run's user created in it tied to nothing is `untied`. */
  window: { from: number; to: number };
  /** When the removal began, epoch milliseconds: a record created since is its doing, in no class. */
  removalBegan: number;
  /** Keys an earlier sweep found `made`, whose tie a removal since may have cleared: `made` still. */
  madeEarlier?: ReadonlySet<string>;
  /**
   * Keys an earlier sweep found `late` and left, whose tie a removal or a
   * reload's purge since may have cleared: `late` still, taken only when
   * what came late is asked for.
   */
  lateEarlier?: ReadonlySet<string>;
}

/** What a sweep tells of one record it found. */
export interface SweepTie {
  class: SweepClass;
  /** Of `made`, created within {@link SAME_SAVE_MS} of its record. */
  sameSave: boolean;
  turn: SweepTurn;
}

/** The rank of a class among those a record's ties give it: the best wins. */
const RANK: Readonly<Record<Exclude<SweepClass, 'untied'>, number>> = {
  made: 3,
  madeOver: 2,
  late: 1,
};

/**
 * How far `at` stands from a span: 0 inside it, negative before it, positive
 * after it.
 */
function gapTo(at: number, from: number, to: number): number {
  if (at < from) return at - from;
  if (at > to) return at - to;
  return 0;
}

/**
 * The class a record created at `created` takes from one record of the run,
 * or undefined when that tie is too far apart in time to tell it.
 */
function classFrom(
  candidate: SweepCandidate,
  anchor: SweepAnchor,
  input: SweepTieInput,
): { class: Exclude<SweepClass, 'untied'>; sameSave: boolean } | undefined {
  const known = Number.isFinite(anchor.from) && Number.isFinite(anchor.to);
  const from = known ? anchor.from : input.runSpan.from;
  const to = known ? anchor.to : input.runSpan.to;
  const gap = gapTo(candidate.created, from, to);
  if (!(gap >= -TIE_LEAD_MS)) return undefined;
  if (gap > LATE_WITHIN_MS) return undefined;
  if (candidate.automatedProcess || gap > MADE_WITHIN_MS) return { class: 'late', sameSave: false };
  if (anchor.kind === 'overwritten') return { class: 'madeOver', sameSave: false };
  return { class: 'made', sameSave: Math.abs(gap) <= SAME_SAVE_MS };
}

/**
 * The tie of each record found that has one, by key: its class, whether it
 * is of the same save, and when it goes against the run's own records. A
 * record in no class is absent.
 */
export function sweepTiesOf(input: SweepTieInput): Map<string, SweepTie> {
  const candidates = new Map(input.candidates.map((candidate) => [candidate.key, candidate]));
  // Per record found, the records of the run its ties end at, each with the
  // fewest links it took to get there.
  const roots = new Map<string, Map<string, number>>();
  const reach = (key: string, anchor: string, links: number): boolean => {
    const held = roots.get(key) ?? new Map<string, number>();
    const known = held.get(anchor);
    if (known !== undefined && known <= links) return false;
    held.set(anchor, links);
    roots.set(key, held);
    return true;
  };

  // One link: under a record of the run, or pointed at by one.
  for (const candidate of input.candidates) {
    for (const reference of candidate.references) {
      if (input.anchors.has(reference.key)) reach(candidate.key, reference.key, 1);
    }
  }
  for (const pointer of input.pointers) {
    if (input.anchors.has(pointer.from) && candidates.has(pointer.to)) {
      reach(pointer.to, pointer.from, 1);
    }
  }
  // A chain: pointing at a record found that is tied, a link further. A
  // cycle ends as nothing more is reached, and no chain is longer than
  // TIE_DEPTH links.
  for (let pass = 2; pass <= TIE_DEPTH; pass++) {
    let grew = false;
    for (const candidate of input.candidates) {
      for (const reference of candidate.references) {
        for (const [anchor, links] of roots.get(reference.key) ?? []) {
          if (reference.key === candidate.key || links + 1 > TIE_DEPTH) continue;
          if (reach(candidate.key, anchor, links + 1)) grew = true;
        }
      }
    }
    if (!grew) break;
  }

  // Whether the org takes a record found along with a record the run created:
  // a cascading lookup to it, or to a record found that goes so.
  // Told once per record from its own place: a record reached deeper in a
  // chain has fewer links left, and is told again from there.
  const goesWith = new Map<string, boolean>();
  const withCreated = (key: string, links: number, seen: Set<string>): boolean => {
    const known = links === 1 ? goesWith.get(key) : undefined;
    if (known !== undefined) return known;
    const candidate = candidates.get(key);
    if (!candidate || links > TIE_DEPTH || seen.has(key)) return false;
    seen.add(key);
    const goes = candidate.references.some(
      (reference) =>
        reference.cascade &&
        (input.anchors.get(reference.key)?.kind === 'created' ||
          withCreated(reference.key, links + 1, seen)),
    );
    seen.delete(key);
    if (links === 1) goesWith.set(key, goes);
    return goes;
  };
  const restricted = new Set(
    input.pointers
      .filter((pointer) => pointer.restricted && input.anchors.has(pointer.from))
      .map((pointer) => pointer.to),
  );

  const ties = new Map<string, SweepTie>();
  for (const candidate of input.candidates) {
    // A record created once the removal was under way is its doing.
    if (!(candidate.created < input.removalBegan)) continue;
    let best: { class: Exclude<SweepClass, 'untied'>; sameSave: boolean } | undefined;
    for (const root of roots.get(candidate.key)?.keys() ?? []) {
      const anchor = input.anchors.get(root);
      if (!anchor) continue;
      const told = classFrom(candidate, anchor, input);
      if (!told) continue;
      if (!best || RANK[told.class] > RANK[best.class]) best = told;
      else if (told.class === best.class && told.sameSave) best = told;
    }
    if (!best && input.madeEarlier?.has(candidate.key) && !candidate.automatedProcess) {
      best = { class: 'made', sameSave: false };
    }
    if (!best && input.lateEarlier?.has(candidate.key)) best = { class: 'late', sameSave: false };
    const turn: SweepTurn = restricted.has(candidate.key)
      ? 'after'
      : withCreated(candidate.key, 1, new Set())
        ? 'with'
        : 'before';
    if (best) {
      ties.set(candidate.key, { ...best, turn });
      continue;
    }
    const inWindow = candidate.created >= input.window.from && candidate.created <= input.window.to;
    if (!candidate.automatedProcess && inWindow) {
      ties.set(candidate.key, { class: 'untied', sameSave: false, turn });
    }
  }
  return ties;
}
