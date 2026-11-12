/**
 * Calls the target's automation refuses for a Salesforce limit, sent again
 * smaller.
 *
 * A removal sent the 116 records of a custom object in one call, and the org
 * refused every one of them: its trigger ran a query per record, once for the
 * whole call, past the 100 a transaction allows, and Salesforce rolled the
 * call back. Nothing was wrong with the records: in two calls of 58 they all
 * go. On a trap org the same trigger refused an insert of 200 row by row,
 * nothing written, and took 100 in one call. Such a refusal (told by
 * `limitIn` in `@sandforge/shared`) is the call's, so the rows it refused go
 * again in calls half as large, down to one record, and the size the limit
 * called for is kept for the rest of the run on that object and that
 * operation (`CallSizes`): the next calls go at it at once.
 *
 * Not every such refusal is the call's. A record whose own trigger work
 * passes a limit — a loop past the CPU time allowed, live — is refused sent on
 * its own too, and halving a call of 200 such records down to one record each
 * costs some 400 calls for nothing. So the first time a key is refused, a
 * record of it goes alone before anything is halved, and a second one when
 * the first is refused: refused both, the key is left whole — its calls go at
 * 200 and what they are refused for a limit stays refused, with a note that
 * says why — and either one taken, the rest is halved, the record refused
 * alone settled as such ({@link ALONE_PROBES}).
 *
 * Splitting costs API requests, and is bounded (`SplitAllowance`): every call
 * more than the rows would have taken in calls of 200 costs one, paid as it
 * is queued — each record sent on its own to probe the key, each call that
 * sends again rows a limit refused, each call more than calls of 200 would
 * have taken — within 500 per object and an allowance per run or removal: half
 * of what the target's daily requests leave past what the run itself takes,
 * as its gate read them, 2 000 at most ({@link splitAllowanceOf}); 2 000 where
 * no budget was read. An allowance short of what an object asks is spent: the
 * object goes back to calls of 200, and the rows refused for a limit stay
 * refused as the org refused them, with a note that says the allowance was
 * spent.
 *
 * A call that threw, which may have written, is never sent again: whatever it
 * holds is settled by its caller as such, and no row of it goes twice.
 *
 * A Bulk API job hands a trigger its rows {@link BULK_CHUNK} at a time, a size
 * no one sets: the rows a job's chunk was refused for a limit are those of a
 * call of 200 refused, and go again by REST as such (`SplitRun.refusedIn`) —
 * probed, then halved, never sent again at the size that refused them — out
 * of the same allowance. Rows a job was planned for that go by REST once a
 * limit cut their object are priced against the job (`SplitRun.pricedAs`):
 * every one of their calls is one more than it.
 *
 * Forge's batch writer, its second pass on lookups, the removal of a run's
 * records and the sweep of what a run left send through
 * {@link sendSplittingOnLimits}.
 */

import type { GovernorLimitCause } from '@sandforge/shared';

/** The size of a call no limit cut: the REST API's 200 records. */
export const FULL_CALL_SIZE = 200;

/**
 * The records a Bulk API job hands a trigger at a time, which no one sets:
 * one of its chunks refused for a limit is a call of 200 refused.
 */
export const BULK_CHUNK = 200;

/** The smaller calls a run or a removal allows itself at most. */
export const RUN_SPLIT_CALLS = 2000;

/** The smaller calls one object is allowed in a run or a removal, whatever is left of the run's. */
export const OBJECT_SPLIT_CALLS = 500;

/**
 * Records of a key sent on their own, one after the other, the first time a
 * call of it is refused for a limit, before anything is halved: refused
 * every one, the key is left whole. Two, not one: a trap org refused a record
 * whose trigger looped past the CPU limit sent on its own, and took the one
 * sent beside it; one record refused alone says nothing of the others.
 */
export const ALONE_PROBES = 2;

/** An operation, each of which fires its own triggers: no size is shared between two. */
export type CallOp = 'insert' | 'upsert' | 'update' | 'delete';

/** What a size is kept for: one object, one operation. */
export interface CallKey {
  readonly objectApiName: string;
  readonly op: CallOp;
}

/** How an object was sent after a limit refused one of its calls, for the notes of a run or a removal. */
export interface SmallerCalls {
  objectApiName: string;
  op: CallOp;
  /** The size of the first call refused for a limit. */
  from: number;
  /** The size the object went down to: 200 when it was never cut. */
  to: number;
  /** The rows settled in calls smaller than 200, the records sent on their own among them. */
  rows: number;
  /** The smaller calls paid for. */
  extraCalls: number;
  /** The limit of the first refusal, as `limitIn` gives it. */
  limit?: string;
  /** The trigger the first refusal named. */
  automation?: string;
  /** The event it ran on, when the refusal said: `before delete`… */
  event?: string;
  /** The rows refused for a limit sent on their own. */
  alone: number;
  /** The rows refused for a limit and not sent smaller, the allowance spent. */
  notSplit: number;
  /**
   * The rows refused for a limit and not sent smaller because the records
   * of the object sent on their own were refused too: the key left whole.
   */
  keptWhole: number;
  /** Whether every record sent on its own to probe the key was refused: it is not split. */
  wholeAlone: boolean;
  /** Whether the allowance ran out for the object: it goes at 200 again. */
  spent: boolean;
}

interface SizeEntry {
  size: number;
  from: number;
  spent: boolean;
  wholeAlone: boolean;
  /** Probes sent so far: the key is probed once, at its first refusal. */
  probes: number;
  rows: number;
  extraCalls: number;
  limit?: string;
  automation?: string;
  event?: string;
  alone: number;
  notSplit: number;
  keptWhole: number;
}

function keyOf(key: CallKey): string {
  return `${key.op}\u0000${key.objectApiName}`;
}

/**
 * The size calls go at, per object and operation, and how each was sent once
 * a limit refused one of its calls. A size only goes down for the life of the
 * instance: a limit met once costs calls to the end of the run, never an
 * oscillation.
 */
export class CallSizes {
  private readonly entries = new Map<string, SizeEntry>();
  private readonly keys = new Map<string, CallKey>();

  /** The size a call of the key goes at: 200 until a limit cut it, and again once its allowance is spent. */
  of(key: CallKey): number {
    const entry = this.entries.get(keyOf(key));
    return !entry || entry.spent ? FULL_CALL_SIZE : entry.size;
  }

  /** Whether a limit has refused a call of the key yet. */
  wasRefused(key: CallKey): boolean {
    return this.entries.has(keyOf(key));
  }

  /** Whether a limit cut the key's calls under 200, its allowance spent since or not. */
  wasCut(key: CallKey): boolean {
    const entry = this.entries.get(keyOf(key));
    return entry !== undefined && entry.size < FULL_CALL_SIZE;
  }

  /**
   * A call of `sentIn` rows of the key was refused for a limit for the first
   * time: its size, limit and trigger are kept for the notes. Its size does
   * not change: nothing is cut before the key is probed.
   */
  firstRefusal(key: CallKey, sentIn: number, cause?: GovernorLimitCause): void {
    if (this.entries.has(keyOf(key))) return;
    const entry = this.entry(key, sentIn);
    entry.limit = cause?.limit;
    entry.automation = cause?.automation;
    entry.event = cause?.event;
  }

  /**
   * A call of `sentIn` rows was refused for a limit: the key goes at half of
   * it from now on, never above what it went at, never under one record.
   * Gives the new size.
   */
  refusedAt(key: CallKey, sentIn: number, cause?: GovernorLimitCause): number {
    this.firstRefusal(key, sentIn, cause);
    const entry = this.entry(key, sentIn);
    entry.size = Math.min(entry.size, Math.max(1, Math.ceil(sentIn / 2)));
    return this.of(key);
  }

  /** Probes the key had: see {@link ALONE_PROBES}. */
  probes(key: CallKey): number {
    return this.entries.get(keyOf(key))?.probes ?? 0;
  }

  /** One more record of the key sent on its own to probe it. */
  probed(key: CallKey): void {
    const entry = this.entries.get(keyOf(key));
    if (entry) entry.probes++;
  }

  /** Every record sent on its own to probe the key was refused: it is not split any more. */
  keepWhole(key: CallKey): void {
    const entry = this.entries.get(keyOf(key));
    if (entry) entry.wholeAlone = true;
  }

  /** Whether {@link keepWhole} was called for the key. */
  isKeptWhole(key: CallKey): boolean {
    return this.entries.get(keyOf(key))?.wholeAlone === true;
  }

  /** The key ran out of smaller calls: it goes at 200 again, and is not split any more. */
  spend(key: CallKey): void {
    const entry = this.entries.get(keyOf(key));
    if (entry) entry.spent = true;
  }

  /** Whether {@link spend} was called for the key. */
  isSpent(key: CallKey): boolean {
    return this.entries.get(keyOf(key))?.spent === true;
  }

  /** Counts smaller calls paid for the key. */
  countExtraCalls(key: CallKey, calls: number): void {
    const entry = this.entries.get(keyOf(key));
    if (entry && calls > 0) entry.extraCalls += calls;
  }

  /** Counts rows settled in calls smaller than 200. */
  countSmallCallRows(key: CallKey, rows: number): void {
    const entry = this.entries.get(keyOf(key));
    if (entry && rows > 0) entry.rows += rows;
  }

  /** Counts rows settled as {@link note} says. */
  countNoted(key: CallKey, note: LimitNote, rows = 1): void {
    const entry = this.entries.get(keyOf(key));
    if (!entry || rows <= 0) return;
    if (note === ALONE) entry.alone += rows;
    else if (note === NOT_SPLIT) entry.notSplit += rows;
    else entry.keptWhole += rows;
  }

  /** How the key was sent once a limit refused one of its calls, or `undefined` when none did. */
  report(key: CallKey): SmallerCalls | undefined {
    const entry = this.entries.get(keyOf(key));
    if (!entry) return undefined;
    return {
      objectApiName: key.objectApiName,
      op: key.op,
      from: entry.from,
      to: entry.size,
      rows: entry.rows,
      extraCalls: entry.extraCalls,
      ...(entry.limit !== undefined ? { limit: entry.limit } : {}),
      ...(entry.automation !== undefined ? { automation: entry.automation } : {}),
      ...(entry.event !== undefined ? { event: entry.event } : {}),
      alone: entry.alone,
      notSplit: entry.notSplit,
      keptWhole: entry.keptWhole,
      wholeAlone: entry.wholeAlone,
      spent: entry.spent,
    };
  }

  /** {@link report} of every key a limit refused, of `op` when given, in the order they were first refused. */
  reports(op?: CallOp): SmallerCalls[] {
    const reports: SmallerCalls[] = [];
    for (const key of this.keys.values()) {
      if (op !== undefined && key.op !== op) continue;
      const report = this.report(key);
      if (report) reports.push(report);
    }
    return reports;
  }

  private entry(key: CallKey, from: number): SizeEntry {
    const id = keyOf(key);
    let entry = this.entries.get(id);
    if (!entry) {
      entry = {
        size: FULL_CALL_SIZE,
        from,
        spent: false,
        wholeAlone: false,
        probes: 0,
        rows: 0,
        extraCalls: 0,
        alone: 0,
        notSplit: 0,
        keptWhole: 0,
      };
      this.entries.set(id, entry);
      this.keys.set(id, { objectApiName: key.objectApiName, op: key.op });
    }
    return entry;
  }
}

/** A count of calls, as a number of whole calls from 0 up. */
function callsFrom(value: number): number {
  return Math.max(0, Math.floor(Number.isFinite(value) ? value : 0));
}

/**
 * The smaller calls a run or a removal may still make: what it was granted,
 * and {@link OBJECT_SPLIT_CALLS} per object, whatever its operations.
 */
export class SplitAllowance {
  private grantedCalls: number;
  /** The smaller calls one object may make. */
  readonly perObject: number;
  private takenInAll = 0;
  private readonly byObject = new Map<string, number>();

  constructor(granted: number = RUN_SPLIT_CALLS, perObject: number = OBJECT_SPLIT_CALLS) {
    this.grantedCalls = callsFrom(granted);
    this.perObject = callsFrom(perObject);
  }

  /** The smaller calls granted to the run or the removal. */
  get granted(): number {
    return this.grantedCalls;
  }

  /**
   * Grant no more than `calls` in all: what a gate that read the target's
   * daily requests allows (`splitAllowanceOf`), once it has read them. Never
   * raises the allowance.
   */
  limitTo(calls: number): void {
    this.grantedCalls = Math.min(this.grantedCalls, callsFrom(calls));
  }

  /** The smaller calls the key's object may still make. */
  left(key: CallKey): number {
    const object = this.byObject.get(key.objectApiName) ?? 0;
    return Math.max(0, Math.min(this.grantedCalls - this.takenInAll, this.perObject - object));
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

/** The sizes and the allowance a run or a removal shares between everything it sends. */
export interface LimitSplitting {
  readonly sizes: CallSizes;
  readonly allowance: SplitAllowance;
}

/** Sizes of their own and an allowance of `granted` smaller calls: {@link RUN_SPLIT_CALLS} when absent. */
export function limitSplitting(granted: number = RUN_SPLIT_CALLS): LimitSplitting {
  return { sizes: new CallSizes(), allowance: new SplitAllowance(granted) };
}

/**
 * The smaller calls a run, a removal or a rewind may make, from the daily API
 * requests the target had left as its gate read them and what the act itself
 * takes: half of what is left past that, so that splitting never takes the
 * org's last requests, and {@link RUN_SPLIT_CALLS} at most. Splitting is not
 * estimated — no estimate can tell which trigger will refuse a call of 200 —
 * but bounded by it.
 *
 * @param remaining - The requests the target had left today.
 * @param estimate - What the act takes of them, as its gate counted it.
 */
export function splitAllowanceOf(remaining: number, estimate: number): number {
  const spare = Math.floor((remaining - estimate) / 2);
  return Number.isFinite(spare) ? Math.min(RUN_SPLIT_CALLS, Math.max(0, spare)) : 0;
}

/**
 * {@link splitAllowanceOf} the check a gate made of the target's requests
 * (`apiBudgetCheckOf`), as its answer hands it to the run; nothing when the
 * gate could not read them, and the run keeps its {@link RUN_SPLIT_CALLS}.
 */
export function splitAllowanceAnswerOf(check: {
  readonly estimate: number;
  readonly remaining?: number;
}): { splitAllowance?: number } {
  return check.remaining === undefined
    ? {}
    : { splitAllowance: splitAllowanceOf(check.remaining, check.estimate) };
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

/**
 * A row refused for a limit and not sent smaller: records of its object sent
 * on their own were refused for a limit too, and the key is left whole.
 */
export const KEPT_WHOLE = 'keptWhole';

/** Why a row refused for a limit was settled rather than sent again. */
export type LimitNote = typeof ALONE | typeof NOT_SPLIT | typeof KEPT_WHOLE;

/** Who allows itself the smaller calls, as a note names it. */
export type SplitSpender = 'run' | 'removal';

/** What a row refused for a limit sent on its own is told, after the org's message. */
export const GOVERNOR_LIMIT_ALONE =
  "Sent on its own, the record still made the target's automation hit a Salesforce limit: the automation does too much for this record alone — fix it, or have it honour the bypass Forge's automation mute sets.";

/** What a row refused for a limit is told when the key was left whole, after the org's message. */
export const GOVERNOR_LIMIT_KEPT_WHOLE =
  "Not sent in smaller calls: records of the same object sent on their own were refused for a Salesforce limit too, so a smaller call would not take it — fix the target's automation, or have it honour the bypass Forge's automation mute sets.";

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
  if (note === ALONE) return GOVERNOR_LIMIT_ALONE;
  if (note === KEPT_WHOLE) return GOVERNOR_LIMIT_KEPT_WHOLE;
  return governorLimitNotSplit(allowed, spender);
}

function callsMore(calls: number): string {
  return `${calls} ${calls === 1 ? 'call' : 'calls'} more`;
}

function records(count: number): string {
  return `${count} ${count === 1 ? 'record' : 'records'}`;
}

/** The automation a report names: its trigger and event, or the target's automation. */
function whoOf(report: SmallerCalls): string {
  if (report.automation === undefined) return "The target's automation";
  return report.event === undefined ? report.automation : `${report.automation} (${report.event})`;
}

/**
 * The note of an object a limit refused a call of: "Ledger_Trigger hit Too
 * many SOQL queries on a call of 116: sent 58 at a time, 3 calls more." — or,
 * when the records sent on their own were refused too, that it was not split.
 * The target's automation when no trigger was named.
 */
export function smallerCallsNote(report: SmallerCalls): string {
  const hit = `${whoOf(report)} hit ${report.limit ?? 'a Salesforce limit'} on a call of ${report.from}`;
  if (report.wholeAlone) {
    return (
      `${hit}, and ${records(report.alone)} sent on ${report.alone === 1 ? 'its' : 'their'} own ` +
      `were refused too: not sent in smaller calls, ${callsMore(report.extraCalls)}.`
    );
  }
  if (report.to < FULL_CALL_SIZE && report.rows > 0) {
    return `${hit}: sent ${report.to} at a time, ${callsMore(report.extraCalls)}.`;
  }
  return report.extraCalls > 0 ? `${hit}: ${callsMore(report.extraCalls)}.` : `${hit}.`;
}

/** The note of an object some of whose rows were not sent smaller for want of calls. */
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
 * What the rows would have gone as without a limit, against which their calls
 * cut smaller are paid: calls of 200 (`'calls'`), a call paid when it is one
 * more than they would have taken, or a Bulk API job (`'job'`), which sends a
 * few requests whatever it holds, and whose every call sent by REST instead
 * is one more.
 */
export type SplitPricedAs = 'calls' | 'job';

/** How {@link sendSplittingOnLimits} sends, reads and settles the rows of one object and operation. */
export interface SplitRun<T, A> {
  key: CallKey;
  sizes: CallSizes;
  allowance: SplitAllowance;
  /** The most a call holds, whatever the size kept: 200 when absent. */
  maxSize?: number;
  /** What the rows would have gone as: `'calls'` when absent. */
  pricedAs?: SplitPricedAs;
  /**
   * Smaller calls the caller paid for before handing the rows: a call cut
   * smaller takes one of them before it asks the allowance for one. A caller
   * that pays a job's rows up front spends the key only once they went: a
   * spent key's calls go at 200, and these at the size paid for.
   */
  paid?: { calls: number };
  /**
   * Set when every row was refused for a limit already, by a call that was
   * not this one's: a Bulk API job's chunk of {@link BULK_CHUNK} (`from`).
   * The rows are held with what it answered (`answers`, one per row) and go
   * as the rows of a call refused here do: a record on its own first, then
   * in calls half as large, every call paid — or settled as the org refused
   * them, the key left whole or spent. None is sent at the size that refused it.
   */
  refusedIn?: {
    readonly from: number;
    readonly answers: readonly (A | undefined)[];
    readonly cause?: GovernorLimitCause;
  };
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
   * Settles rows with what their call answered, those of `again` excepted:
   * they go again in smaller calls and are settled with them. `notes` says,
   * by index, why a row refused for a limit is settled rather than sent
   * again. `held` is set for rows a call answered earlier, held while the
   * key was probed and settled now with that call's answers: no call of
   * theirs is still open.
   */
  settle(
    part: readonly T[],
    answers: readonly (A | undefined)[],
    again: ReadonlySet<number>,
    notes: ReadonlyMap<number, LimitNote>,
    held?: true,
  ): void | Promise<void>;
  /** Hands on what was not settled when a call, its check or its settling threw; the error is thrown again. */
  onThrow?(unsettled: readonly T[], error: unknown): void;
  /** Once, the first time a limit refuses a call of the key: a log line. */
  onFirstRefusal?(report: SmallerCalls): void;
}

/** How {@link sendSplittingOnLimits} ended: every row settled, or stopped. */
export interface SplitOutcome<T> {
  /**
   * The call it stopped on and the rows after it, unsettled: `sent` when the
   * call may have written, and not when `beforeEachSend` stopped it.
   */
  stopped?: { part: T[]; rest: T[]; sent: boolean };
}

interface QueuedPart<T> {
  items: T[];
  /** Sent under 200 because of a limit: its rows count in the notes. */
  reduced: boolean;
  /** A record sent on its own to probe the key. */
  probe?: true;
}

/** Rows a call refused for a limit, held with its answers while the key is probed. */
interface Held<T, A> {
  items: T[];
  answers: Array<A | undefined>;
  /** The size of the call that refused them: what they are halved from. */
  from: number;
  cause?: GovernorLimitCause;
}

const NONE_AGAIN: ReadonlySet<number> = new Set();

/**
 * Sends `items` in calls of the size kept for the key, read again before
 * every call. The first time a call of more than one is refused for a limit,
 * a record of it goes on its own — and a second when the first is refused,
 * {@link ALONE_PROBES} in all — the other rows held with the call's answers:
 * refused every one, the key is left whole and the rows held are settled as
 * the call answered them, {@link KEPT_WHOLE}; one taken, the rows held go
 * again in calls half as large as the call refused, at the head of the queue.
 * After that, the rows a call of more than one is refused for a limit go
 * again in calls half as large, and a row refused sent on its own is settled
 * {@link ALONE}. Every record sent on its own to probe the key, every call
 * that sends refused rows again and every call more than calls of 200 would
 * have taken is paid as it is queued; past the allowance the rows are
 * settled {@link NOT_SPLIT}. Each row is settled once, and a call that may
 * have written stops it: never sent again.
 */
export async function sendSplittingOnLimits<T, A>(
  items: readonly T[],
  run: SplitRun<T, A>,
): Promise<SplitOutcome<T>> {
  const { key, sizes, allowance } = run;
  const cap = Math.min(run.maxSize ?? FULL_CALL_SIZE, FULL_CALL_SIZE);
  const front: QueuedPart<T>[] = [];
  let held: Held<T, A> | undefined;
  let cursor = 0;

  const unsent = (): T[] => [
    ...front.flatMap((part) => part.items),
    ...(held?.items ?? []),
    ...items.slice(cursor),
  ];

  const cutNext = (): QueuedPart<T> => {
    let size = Math.min(cap, sizes.of(key));
    let reduced = size < cap;
    // A call cut under what it would otherwise hold is paid as it is queued
    // when it is one more than what the rows were priced at would have taken:
    // 400 rows at 100 pay two of their four calls against calls of 200, and
    // all four against a job. A call the caller paid for already is not paid
    // twice. Refused, the key is spent, and goes at full size again.
    const paysOne = run.pricedAs === 'job' || isExtraCall(items.length - cursor, size, cap);
    if (reduced && paysOne) {
      if (run.paid && run.paid.calls > 0) run.paid.calls--;
      else if (takeSmallerCalls(sizes, allowance, key, 1) === 0) {
        size = cap;
        reduced = false;
      }
    }
    const part = items.slice(cursor, cursor + size);
    cursor += part.length;
    return { items: part, reduced };
  };

  /** Settles every row held, as the call that refused them answered, with `note`. */
  const release = async (note: LimitNote): Promise<void> => {
    const holding = held;
    held = undefined;
    if (!holding || holding.items.length === 0) return;
    sizes.countNoted(key, note, holding.items.length);
    const notes = new Map(holding.items.map((_, index): [number, LimitNote] => [index, note]));
    try {
      await run.settle(holding.items, holding.answers, NONE_AGAIN, notes, true);
    } catch (error) {
      run.onThrow?.(unsent(), error);
      throw error;
    }
  };

  /**
   * Queues at the head the rows held, in calls half as large as the one that
   * refused them, as far as the allowance pays; the rest settled
   * {@link NOT_SPLIT}.
   */
  const halveHeld = async (): Promise<void> => {
    const holding = held;
    if (!holding) return;
    if (holding.items.length === 0) {
      held = undefined;
      return;
    }
    const size = sizes.refusedAt(key, holding.from, holding.cause);
    const granted = takeSmallerCalls(sizes, allowance, key, Math.ceil(holding.items.length / size));
    const covered = Math.min(holding.items.length, granted * size);
    const pieces: QueuedPart<T>[] = [];
    for (let at = 0; at < covered; at += size) {
      pieces.push({ items: holding.items.slice(at, Math.min(covered, at + size)), reduced: true });
    }
    front.unshift(...pieces);
    held = {
      ...holding,
      items: holding.items.slice(covered),
      answers: holding.answers.slice(covered),
    };
    await release(NOT_SPLIT);
  };

  /**
   * Sends the next held row on its own to probe the key, paid as a smaller
   * call; refused the call, the key is spent and every row held settled
   * {@link NOT_SPLIT}.
   */
  const probeNext = async (): Promise<void> => {
    const holding = held;
    if (!holding || holding.items.length === 0) {
      held = undefined;
      return;
    }
    if (takeSmallerCalls(sizes, allowance, key, 1) === 0) {
      await release(NOT_SPLIT);
      return;
    }
    sizes.probed(key);
    front.unshift({ items: [holding.items[0]], reduced: true, probe: true });
    held = { ...holding, items: holding.items.slice(1), answers: holding.answers.slice(1) };
  };

  let first = true;
  const refused = run.refusedIn;
  if (refused && items.length > 0) {
    // Refused already, by a call of `from` that was not this one's: held with
    // what it answered, as the rows of a call refused below are, and nothing
    // left to cut. The first call this sends is not the caller's to check.
    cursor = items.length;
    first = false;
    if (!sizes.wasRefused(key)) {
      sizes.firstRefusal(key, refused.from, refused.cause);
      const report = sizes.report(key);
      if (report) run.onFirstRefusal?.(report);
    }
    held = {
      items: [...items],
      answers: [...refused.answers],
      from: refused.from,
      ...(refused.cause ? { cause: refused.cause } : {}),
    };
    if (sizes.isSpent(key)) await release(NOT_SPLIT);
    else if (sizes.isKeptWhole(key)) await release(KEPT_WHOLE);
    else if (!sizes.wasCut(key) && sizes.probes(key) < ALONE_PROBES) await probeNext();
    else await halveHeld();
  }
  for (;;) {
    let part: QueuedPart<T> | undefined;
    if (first) {
      if (items.length === 0) return {};
      part = cutNext();
    } else {
      part = front.shift() ?? (cursor < items.length ? cutNext() : undefined);
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
    /** What is done once the call is settled: the next probe, the halves, or the rows held settled. */
    let then: (() => Promise<void>) | undefined;
    if (part.probe) {
      if (limited.length > 0) {
        notes.set(0, ALONE);
        then =
          sizes.probes(key) < ALONE_PROBES && (held?.items.length ?? 0) > 0
            ? probeNext
            : async () => {
                // Refused every one: the key is left whole. A probe with no
                // row left to try after it says nothing more of the key.
                if (sizes.probes(key) >= ALONE_PROBES) sizes.keepWhole(key);
                await release(KEPT_WHOLE);
              };
      } else {
        // Taken on its own: the rows held go in halves.
        then = halveHeld;
      }
    } else if (limited.length > 0) {
      if (!sizes.wasRefused(key)) {
        sizes.firstRefusal(key, sent.length, cause);
        const report = sizes.report(key);
        if (report) run.onFirstRefusal?.(report);
      }
      // Probed until it is cut, kept whole, or out of probes.
      const probing =
        !sizes.wasCut(key) && !sizes.isKeptWhole(key) && sizes.probes(key) < ALONE_PROBES;
      if (sent.length === 1) {
        notes.set(0, ALONE);
        // Refused on its own before the key was cut: that was a probe of it.
        if (probing && !sizes.isSpent(key)) {
          sizes.probed(key);
          if (sizes.probes(key) >= ALONE_PROBES) sizes.keepWhole(key);
        }
      } else if (sizes.isSpent(key)) {
        for (const index of limited) notes.set(index, NOT_SPLIT);
      } else if (sizes.isKeptWhole(key)) {
        for (const index of limited) notes.set(index, KEPT_WHOLE);
      } else if (probing) {
        // A record goes on its own first, the others held with this call's
        // answers until it is answered.
        for (const index of limited) again.add(index);
        held = {
          items: limited.map((index) => sent[index]),
          answers: limited.map((index) => answers[index]),
          from: sent.length,
          ...(cause ? { cause } : {}),
        };
        then = probeNext;
      } else {
        const size = sizes.refusedAt(key, sent.length, cause);
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
    }
    for (const note of notes.values()) sizes.countNoted(key, note);
    if (part.reduced) sizes.countSmallCallRows(key, sent.length - again.size);

    try {
      await run.settle(sent, answers, again, notes);
    } catch (error) {
      run.onThrow?.(unsent(), error);
      throw error;
    }
    await then?.();
  }
}
