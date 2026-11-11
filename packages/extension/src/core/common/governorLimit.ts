/**
 * Calls the target's automation refuses for a Salesforce limit, sent again
 * smaller.
 *
 * A removal sent its 116 `Provenance__c` in one call, and the org refused
 * every one of them: "SSC_TRG_Provenance: execution of BeforeDelete caused by:
 * System.LimitException: Too many SOQL queries: 101". The trigger ran a query
 * per record, once for the whole call, and Salesforce rolled the call back.
 * Nothing was wrong with the records: in two calls of 58 they all go. Such a
 * refusal (told by `limitIn` in `@sandforge/shared`) is the call's, so the
 * rows it refused go again in calls half as large, down to one record, and
 * the size the limit called for is kept for the rest of the run on that
 * object and that operation (`CallSizes`): the next calls go at it at once,
 * by REST rather than as a Bulk job, whose 200-record chunks no one sets.
 *
 * Splitting costs API requests, and is bounded (`SplitAllowance`): every call
 * more than the rows would have taken otherwise costs one, paid as it is
 * queued — each call that sends again rows a limit refused, each call more
 * than calls of 200 would have taken, each call of a Bulk job sent by REST
 * instead — within 500 per object and an allowance per run or removal —
 * 2 000 at most. An allowance short of what an object asks pays for the
 * first of its calls, then the object is not split any more: it goes back to
 * calls of 200, still by REST — a Bulk job queued for it, which no smaller
 * call was paid to replace, stays a job — and the rows refused for a limit
 * stay refused as the org refused them, with
 * a note that says the allowance was spent. A row refused for a limit sent on
 * its own stays refused too, with a note that says what to fix.
 *
 * Forge's batch writer, its second pass on lookups and the sweep of what a
 * run left send through {@link sendSplittingOnLimits}. Forge's removal keeps
 * its own queue, which mixes jobs, files and progress, with the same sizes,
 * the same allowance and the same reading of the refusal.
 */

import type { GovernorLimitCause } from '@sandforge/shared';

/** The size of a call no limit cut: the REST API's 200 records. */
export const FULL_CALL_SIZE = 200;

/** The records a Bulk job hands a trigger at a time, which no one sets. */
export const BULK_CHUNK = 200;

/** The size the rows a job refused for a limit go again at by REST: half a job's chunk. */
export const LIMITED_JOB_REST_SIZE = BULK_CHUNK / 2;

/** The smaller calls a run or a removal allows itself at most. */
export const RUN_SPLIT_CALLS = 2000;

/** The smaller calls one object is allowed in a run or a removal, whatever is left of the run's. */
export const OBJECT_SPLIT_CALLS = 500;

/** An operation, each of which fires its own triggers: no size is shared between two. */
export type CallOp = 'insert' | 'upsert' | 'update' | 'delete';

/** What a size is kept for: one object, one operation. */
export interface CallKey {
  readonly objectApiName: string;
  readonly op: CallOp;
}

/** How an object was sent in smaller calls, for the notes of a run or a removal. */
export interface SmallerCalls {
  objectApiName: string;
  op: CallOp;
  /** The size of the first call refused for a limit; absent when the size was handed from an earlier removal and nothing was refused since. */
  from?: number;
  /** The size the object went down to. */
  to: number;
  /** The rows settled in calls smaller than 200. */
  rows: number;
  /** The smaller calls paid for. */
  extraCalls: number;
  /** The limit of the first refusal, as `limitIn` gives it. */
  limit?: string;
  /** The trigger the first refusal named. */
  automation?: string;
  /** The event it ran on: `before delete`… */
  event?: string;
  /** The rows refused for a limit and not sent smaller, the allowance spent. */
  notSplit: number;
  /** Whether the allowance ran out for the object: it is sent at 200 again, by REST. */
  spent: boolean;
}

interface SizeEntry {
  size: number;
  spent: boolean;
  from?: number;
  rows: number;
  extraCalls: number;
  limit?: string;
  automation?: string;
  event?: string;
  notSplit: number;
}

function keyOf(key: CallKey): string {
  return `${key.op}\u0000${key.objectApiName}`;
}

/** A size handed from elsewhere, as a size: a whole number from 1 to 200. */
function sizeFrom(value: number): number | undefined {
  if (!Number.isFinite(value)) return undefined;
  const size = Math.floor(value);
  return size >= 1 && size < FULL_CALL_SIZE ? size : undefined;
}

/**
 * The size calls go at, per object and operation, and how each was cut. A
 * size only goes down for the life of the instance: a timeout that passed
 * once costs calls to the end of the run, never an oscillation.
 */
export class CallSizes {
  private readonly entries = new Map<string, SizeEntry>();
  private readonly keys = new Map<string, CallKey>();

  /**
   * Sizes a removal kept for its objects (`ForgeRemovalPlan.deleteSizes`),
   * for `op`. A value that is not a size under 200 is dropped.
   */
  static from(seed: Readonly<Record<string, number>> | undefined, op: CallOp): CallSizes {
    const sizes = new CallSizes();
    for (const [objectApiName, value] of Object.entries(seed ?? {})) {
      const size = sizeFrom(value);
      if (size !== undefined) sizes.entry({ objectApiName, op }).size = size;
    }
    return sizes;
  }

  /** The size a call of the key goes at: 200 until a limit cut it, and again once its allowance is spent. */
  of(key: CallKey): number {
    const entry = this.entries.get(keyOf(key));
    return !entry || entry.spent ? FULL_CALL_SIZE : entry.size;
  }

  /**
   * A call of `sentIn` rows was refused for a limit: the key goes at half of
   * it from now on, never above what it went at, never under one record.
   * The first refusal's limit and trigger are kept for the notes. Gives the
   * new size.
   */
  refusedAt(key: CallKey, sentIn: number, cause?: GovernorLimitCause): number {
    const entry = this.entry(key);
    const size = Math.min(entry.size, Math.max(1, Math.ceil(sentIn / 2)));
    entry.size = size;
    if (entry.from === undefined) {
      entry.from = sentIn;
      entry.limit = cause?.limit;
      entry.automation = cause?.automation;
      entry.event = cause?.event;
    }
    return this.of(key);
  }

  /**
   * Whether the key went through a limit — cut in this run, or handed a size
   * by an earlier removal: it goes by REST rather than by a Bulk job, its
   * allowance spent or not, since a job's chunk of 200 is the call that was
   * refused. A removal still sends as the job it was queued as what a spent
   * allowance no longer pays to send by REST, as its estimate priced it.
   */
  wasShrunk(key: CallKey): boolean {
    const entry = this.entries.get(keyOf(key));
    return entry !== undefined && (entry.spent || entry.size < FULL_CALL_SIZE);
  }

  /** The key ran out of smaller calls: it goes at 200 again, by REST, and is not split any more. */
  spend(key: CallKey): void {
    this.entry(key).spent = true;
  }

  /** Whether {@link spend} was called for the key. */
  isSpent(key: CallKey): boolean {
    return this.entries.get(keyOf(key))?.spent === true;
  }

  /** Counts smaller calls paid for the key. */
  countExtraCalls(key: CallKey, calls: number): void {
    if (calls > 0) this.entry(key).extraCalls += calls;
  }

  /** Counts rows settled in calls smaller than 200. */
  countSmallCallRows(key: CallKey, rows: number): void {
    if (rows > 0) this.entry(key).rows += rows;
  }

  /** Counts rows refused for a limit and not sent smaller, the allowance spent. */
  countNotSplit(key: CallKey, rows: number): void {
    if (rows > 0) this.entry(key).notSplit += rows;
  }

  /**
   * The sizes kept for `op`, by object: each under 200, spent or not, for a
   * removal to hand on. The size a limit called for, not one a call is known
   * to have gone through at: a size the allowance kept from use is listed.
   */
  list(op: CallOp): Record<string, number> {
    const listed: Record<string, number> = {};
    for (const [id, entry] of this.entries) {
      const key = this.keys.get(id);
      if (key?.op === op && entry.size < FULL_CALL_SIZE) listed[key.objectApiName] = entry.size;
    }
    return listed;
  }

  /** How the key was sent smaller, or `undefined` when it never was. */
  report(key: CallKey): SmallerCalls | undefined {
    const entry = this.entries.get(keyOf(key));
    if (!entry || entry.size >= FULL_CALL_SIZE) return undefined;
    return {
      objectApiName: key.objectApiName,
      op: key.op,
      ...(entry.from !== undefined ? { from: entry.from } : {}),
      to: entry.size,
      rows: entry.rows,
      extraCalls: entry.extraCalls,
      ...(entry.limit !== undefined ? { limit: entry.limit } : {}),
      ...(entry.automation !== undefined ? { automation: entry.automation } : {}),
      ...(entry.event !== undefined ? { event: entry.event } : {}),
      notSplit: entry.notSplit,
      spent: entry.spent,
    };
  }

  /** {@link report} of every key sent smaller, of `op` when given, in the order they were first cut. */
  reports(op?: CallOp): SmallerCalls[] {
    const reports: SmallerCalls[] = [];
    for (const key of this.keys.values()) {
      if (op !== undefined && key.op !== op) continue;
      const report = this.report(key);
      if (report) reports.push(report);
    }
    return reports;
  }

  private entry(key: CallKey): SizeEntry {
    const id = keyOf(key);
    let entry = this.entries.get(id);
    if (!entry) {
      entry = { size: FULL_CALL_SIZE, spent: false, rows: 0, extraCalls: 0, notSplit: 0 };
      this.entries.set(id, entry);
      this.keys.set(id, { objectApiName: key.objectApiName, op: key.op });
    }
    return entry;
  }
}

/**
 * The smaller calls a run or a removal may still make: what it was granted,
 * and {@link OBJECT_SPLIT_CALLS} per object, whatever its operations.
 */
export class SplitAllowance {
  /** The smaller calls granted to the run or the removal. */
  readonly granted: number;
  /** The smaller calls one object may make. */
  readonly perObject: number;
  private takenInAll = 0;
  private readonly byObject = new Map<string, number>();

  constructor(granted: number = RUN_SPLIT_CALLS, perObject: number = OBJECT_SPLIT_CALLS) {
    this.granted = Math.max(0, Math.floor(Number.isFinite(granted) ? granted : 0));
    this.perObject = Math.max(0, Math.floor(Number.isFinite(perObject) ? perObject : 0));
  }

  /** The smaller calls the key's object may still make. */
  left(key: CallKey): number {
    const object = this.byObject.get(key.objectApiName) ?? 0;
    return Math.max(0, Math.min(this.granted - this.takenInAll, this.perObject - object));
  }

  /**
   * Takes up to `n` smaller calls for the key and gives how many were
   * granted: all of them, part of them when the run's allowance or the
   * object's does not cover them all, or none.
   */
  take(key: CallKey, n: number): number {
    const granted = Math.max(0, Math.min(Math.floor(n), this.left(key)));
    if (granted > 0) {
      this.takenInAll += granted;
      this.byObject.set(key.objectApiName, (this.byObject.get(key.objectApiName) ?? 0) + granted);
    }
    return granted;
  }

  /** The smaller calls taken in all. */
  get spent(): number {
    return this.takenInAll;
  }

  /** The smaller calls the key's object took. */
  taken(key: CallKey): number {
    return this.byObject.get(key.objectApiName) ?? 0;
  }
}

/**
 * Pays `n` smaller calls for the key, as every call sent under 200 is paid
 * when it is queued, and gives how many were granted. A key already spent is
 * granted none; a key granted fewer than it asked is spent, for good, and its
 * calls go at 200 again. The calls granted are counted for its notes.
 */
export function takeSmallerCalls(
  sizes: CallSizes,
  allowance: SplitAllowance,
  key: CallKey,
  n: number,
): number {
  if (n <= 0) return 0;
  if (sizes.isSpent(key)) return 0;
  const granted = allowance.take(key, n);
  sizes.countExtraCalls(key, granted);
  if (granted < n) sizes.spend(key);
  return granted;
}

/** A row refused for a limit sent on its own: its refusal is final. */
export const ALONE = 'alone';

/** A row refused for a limit and not sent smaller: the allowance was spent. */
export const NOT_SPLIT = 'notSplit';

/** Why a row refused for a limit was settled rather than sent again. */
export type LimitNote = typeof ALONE | typeof NOT_SPLIT;

/** Who allows itself the smaller calls, as a note names it. */
export type SplitSpender = 'run' | 'removal';

/** What a row refused for a limit sent on its own is told, after the org's message. */
export const GOVERNOR_LIMIT_ALONE =
  "Sent on its own, the record still made the target's automation hit a Salesforce limit: the automation runs a query or a write per record — fix it, or have it honour the bypass Forge's automation mute sets.";

/** Why rows were not sent smaller: the allowance spent, or none to spend. */
function notSplitWhy(allowed: number, spender: SplitSpender): string {
  return allowed > 0
    ? `the ${spender} had spent the ${allowed} smaller calls it allows itself`
    : `what the org has left today allowed the ${spender} none`;
}

/** What a row refused for a limit and not sent smaller is told, after the org's message. */
export function governorLimitNotSplit(allowed: number, spender: SplitSpender = 'run'): string {
  return `Not sent in smaller calls: ${notSplitWhy(allowed, spender)}.`;
}

/** The sentence a {@link LimitNote} stands for. */
export function limitNoteText(
  note: LimitNote,
  allowed: number,
  spender: SplitSpender = 'run',
): string {
  return note === ALONE ? GOVERNOR_LIMIT_ALONE : governorLimitNotSplit(allowed, spender);
}

function callsMore(calls: number): string {
  return `${calls} ${calls === 1 ? 'call' : 'calls'} more`;
}

/**
 * The note of an object sent smaller: "SSC_TRG_Provenance (before delete) hit
 * Too many SOQL queries on a call of 116: sent 58 at a time, 2 calls more."
 * The target's automation when no trigger was named.
 */
export function smallerCallsNote(report: SmallerCalls): string {
  const who =
    report.automation === undefined
      ? "The target's automation"
      : report.event === undefined
        ? report.automation
        : `${report.automation} (${report.event})`;
  if (report.from === undefined) {
    return `Sent ${report.to} at a time, the size a limit called for in an earlier removal, ${callsMore(report.extraCalls)}.`;
  }
  const limit = report.limit ?? 'a Salesforce limit';
  return `${who} hit ${limit} on a call of ${report.from}: sent ${report.to} at a time, ${callsMore(report.extraCalls)}.`;
}

/** The note of an object some of whose rows were not sent smaller. */
export function notSplitNote(rows: number, allowed: number, spender: SplitSpender = 'run'): string {
  return `${rows} not sent in smaller calls: ${notSplitWhy(allowed, spender)}.`;
}

/**
 * The smaller calls the key's object was allowed, for a note of rows not
 * sent smaller: its own share when that is what ran out first, what the run
 * or the removal was granted otherwise.
 */
export function allowedFor(allowance: SplitAllowance, key: CallKey): number {
  const objectLeft = allowance.perObject - allowance.taken(key);
  const runLeft = allowance.granted - allowance.spent;
  return objectLeft < runLeft ? allowance.perObject : allowance.granted;
}

/**
 * Whether a call of `size` taken off `remaining` rows is one more than calls
 * of `cap` would have taken: what the rows cost in calls of `size`, past what
 * they cost in calls of `cap`, goes down by one with it. Paid call by call,
 * the calls of a run of rows cost what they take more than calls of `cap`,
 * as {@link extraCallsOf} counts it at once.
 */
export function isExtraCall(
  remaining: number,
  size: number,
  cap: number = FULL_CALL_SIZE,
): boolean {
  if (remaining <= size) return false;
  return Math.ceil(remaining / cap) === Math.ceil((remaining - size) / cap);
}

/** The calls `rows` take in calls of `size` more than in calls of `cap`. */
export function extraCallsOf(rows: number, size: number, cap: number = FULL_CALL_SIZE): number {
  if (rows <= 0) return 0;
  return Math.max(0, Math.ceil(rows / Math.max(1, size)) - Math.ceil(rows / cap));
}

/** What one call answered, or that it may have written and must not be sent again. */
export type SplitReply<A> = { answers: readonly (A | undefined)[] } | 'stop';

/**
 * What the rows would have gone as without a limit, against which their
 * calls cut smaller are paid: calls of 200 (`'calls'`), a call paid when it
 * is one more than they would have taken, or a Bulk job (`'job'`), which
 * sends a few requests whatever it holds, and whose every call sent by REST
 * instead is one more.
 */
export type SplitPricedAs = 'calls' | 'job';

/** How the calls {@link sendSplittingOnLimits} cuts smaller are paid, and what it does once they no longer are. */
export interface SplitPricing<T> {
  /** What the rows would have gone as: `'calls'` when absent. */
  pricedAs?: SplitPricedAs;
  /**
   * Smaller calls the caller paid for before handing the rows, shared by
   * every send of them: a call cut smaller takes one of them before it asks
   * the allowance for one.
   */
  paid?: { calls: number };
  /**
   * The rows that go in smaller calls or not at all — refused already by a
   * call of 200, they would be refused again: once the key is spent, those
   * not sent yet are handed here, unsent and counted as not sent smaller,
   * for the caller to settle as the org refused them. Absent, they go at 200.
   */
  unpaid?(rows: readonly T[]): void | Promise<void>;
}

/** How {@link sendSplittingOnLimits} sends, reads and settles the rows of one object and operation. */
export interface SplitRun<T, A> extends SplitPricing<T> {
  key: CallKey;
  sizes: CallSizes;
  allowance: SplitAllowance;
  /**
   * The size of the first call, paid by the caller when it is under 200;
   * the first call is cut like the others when absent.
   */
  firstSize?: number;
  /** The most a call holds, whatever the size kept: 200 when absent. */
  maxSize?: number;
  /**
   * Before every call but the first, whose own check stays with the caller:
   * a pause waited out, a cancellation thrown, or `'stop'` to send no more.
   */
  beforeEachSend?(): void | 'stop' | Promise<void | 'stop'>;
  /** Sends one call; `'stop'` when it may have written, and nothing is sent again. */
  send(part: readonly T[]): Promise<SplitReply<A>>;
  /** The limit a row's answer was refused for, or `undefined` when it went in or was refused otherwise. */
  limited(answer: A | undefined, item: T): GovernorLimitCause | undefined;
  /**
   * Settles one call's rows, those of `again` excepted: they go again in
   * smaller calls and are settled with them. `notes` says, by index, why a
   * row refused for a limit is settled rather than sent again.
   */
  settle(
    part: readonly T[],
    answers: readonly (A | undefined)[],
    again: ReadonlySet<number>,
    notes: ReadonlyMap<number, LimitNote>,
  ): void | Promise<void>;
  /** Hands on what was not settled when a call, its check or its settling threw; the error is thrown again. */
  onThrow?(unsettled: readonly T[], error: unknown): void;
  /** Once, the first time the key is cut: a log line. */
  onFirstRefusal?(report: SmallerCalls): void;
}

/** How {@link sendSplittingOnLimits} ended: every row settled, or stopped. */
export interface SplitOutcome<T> {
  /**
   * The call it stopped on and the rows after it, unsent: `sent` when the
   * call may have written, and not when `beforeEachSend` stopped it.
   */
  stopped?: { part: T[]; rest: T[]; sent: boolean };
}

interface QueuedPart<T> {
  items: T[];
  /** Sent under 200 because of a limit: its rows count in the notes. */
  reduced: boolean;
}

/**
 * Sends `items` in calls of the size kept for the key, read again before
 * every call, and sends again, in calls half as large, the rows a call of
 * more than one was refused for a limit, at the head of the queue, in their
 * order. Every call more than what the rows were priced at would have taken
 * (`pricedAs`) is paid as it is queued, and so is every call that sends
 * refused rows again; past the allowance the rows are settled with
 * {@link NOT_SPLIT} — those a call of 200 refused already handed unsent to
 * `unpaid` — and a row refused sent on its own with {@link ALONE}. Each row
 * is settled once.
 */
export async function sendSplittingOnLimits<T, A>(
  items: readonly T[],
  run: SplitRun<T, A>,
): Promise<SplitOutcome<T>> {
  const { key, sizes, allowance } = run;
  const cap = Math.min(run.maxSize ?? FULL_CALL_SIZE, FULL_CALL_SIZE);
  const front: QueuedPart<T>[] = [];
  let cursor = 0;

  const unsent = (): T[] => [...front.flatMap((part) => part.items), ...items.slice(cursor)];
  const reducedNow = (): boolean => sizes.wasShrunk(key) && sizes.of(key) < cap;

  const cutFirst = (size: number): QueuedPart<T> => {
    const part = items.slice(0, Math.max(1, size));
    cursor = part.length;
    return { items: part, reduced: reducedNow() };
  };
  /** Hands the rows not sent yet to `run.unpaid`, the key spent: none of them is sent. */
  const leaveUnpaid = async (): Promise<undefined> => {
    const rest = items.slice(cursor);
    cursor = items.length;
    sizes.countNotSplit(key, rest.length);
    try {
      await run.unpaid?.(rest);
    } catch (error) {
      run.onThrow?.(unsent(), error);
      throw error;
    }
    return undefined;
  };
  const cutNext = async (): Promise<QueuedPart<T> | undefined> => {
    if (run.unpaid && sizes.isSpent(key)) return leaveUnpaid();
    let size = Math.min(cap, sizes.of(key));
    let reduced = size < cap && sizes.wasShrunk(key);
    // A call cut under what it would otherwise hold is paid as it is queued
    // when it is one more than what the rows were priced at would have
    // taken — 400 rows at 100 pay two of their four calls against calls of
    // 200, as the removal pays them, and all four against a job. A call the
    // caller paid for already is not paid twice; refused, the key is spent,
    // and goes at full size again, or not at all (`unpaid`).
    const paysOne = run.pricedAs === 'job' || isExtraCall(items.length - cursor, size, cap);
    if (reduced && paysOne) {
      if (run.paid && run.paid.calls > 0) run.paid.calls--;
      else if (takeSmallerCalls(sizes, allowance, key, 1) === 0) {
        if (run.unpaid) return leaveUnpaid();
        size = Math.min(cap, sizes.of(key));
        reduced = false;
      }
    }
    const part = items.slice(cursor, cursor + size);
    cursor += part.length;
    return { items: part, reduced };
  };

  let first = true;
  for (;;) {
    let part: QueuedPart<T> | undefined;
    if (first) {
      if (items.length === 0) return {};
      part = run.firstSize !== undefined ? cutFirst(run.firstSize) : await cutNext();
      if (!part) return {};
    } else {
      part = front.shift() ?? (cursor < items.length ? await cutNext() : undefined);
      if (!part) return {};
      try {
        if ((await run.beforeEachSend?.()) === 'stop') {
          return { stopped: { part: part.items, rest: unsent(), sent: false } };
        }
      } catch (error) {
        run.onThrow?.([...part.items, ...unsent()], error);
        throw error;
      }
    }
    first = false;

    let reply: SplitReply<A>;
    try {
      reply = await run.send(part.items);
    } catch (error) {
      run.onThrow?.([...part.items, ...unsent()], error);
      throw error;
    }
    if (reply === 'stop') return { stopped: { part: part.items, rest: unsent(), sent: true } };

    const { answers } = reply;
    const sent = part.items;
    const limited: number[] = [];
    let cause: GovernorLimitCause | undefined;
    for (let index = 0; index < sent.length; index++) {
      const found = run.limited(answers[index], sent[index]);
      if (found) {
        limited.push(index);
        cause ??= found;
      }
    }

    const again = new Set<number>();
    const notes = new Map<number, LimitNote>();
    if (limited.length > 0) {
      if (sent.length === 1) {
        notes.set(0, ALONE);
      } else if (sizes.isSpent(key)) {
        for (const index of limited) notes.set(index, NOT_SPLIT);
      } else {
        const wasShrunk = sizes.wasShrunk(key);
        const size = sizes.refusedAt(key, sent.length, cause);
        const report = sizes.report(key);
        if (!wasShrunk && report) run.onFirstRefusal?.(report);
        const granted = takeSmallerCalls(sizes, allowance, key, Math.ceil(limited.length / size));
        const covered = limited.slice(0, granted * size);
        for (const index of covered) again.add(index);
        for (const index of limited.slice(covered.length)) notes.set(index, NOT_SPLIT);
        const pieces: QueuedPart<T>[] = [];
        for (let at = 0; at < covered.length; at += size) {
          pieces.push({
            items: covered.slice(at, at + size).map((index) => sent[index]),
            reduced: true,
          });
        }
        front.unshift(...pieces);
      }
      let notSplit = 0;
      for (const note of notes.values()) if (note === NOT_SPLIT) notSplit++;
      sizes.countNotSplit(key, notSplit);
    }
    if (part.reduced) sizes.countSmallCallRows(key, sent.length - again.size);

    try {
      await run.settle(sent, answers, again, notes);
    } catch (error) {
      run.onThrow?.(unsent(), error);
      throw error;
    }
  }
}
