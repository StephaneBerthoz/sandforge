/**
 * Cycle FK patcher stage (pass 2) of the Forge execution pipeline.
 *
 * Records inserted with `Foo.BarId = null` because Bar had not been cloned
 * yet at insert time would stay disconnected without this pass. Pending
 * updates are grouped by (objectApiName, newId) so multiple FK fields on
 * the same record collapse to a single UPDATE call, then dispatched
 * through `deps.updateRecords` in per-object batches.
 *
 * Those batches are bounded by the same REST limit as pass 1.
 * `deps.updateRecords` is wired onto `conn.sobject(name).update(records)`,
 * and jsforce only splits an oversized array when `options.allowRecursive`
 * is set, which that call site did not pass — so the whole array went out
 * as one request. Pass 1 was bounded and pass 2, which it feeds, was not:
 * a cyclic clone (Account.ParentId, Contact.ReportsToId) of more than 200
 * records still failed entirely, one stage later. The call site passes it
 * now, with the duplicate-rule header, and this stage still bounds its own
 * batches.
 *
 * A run that writes through the Bulk API (`bulkUpdate`) sends an object's
 * updates as Bulk API jobs from `FORGE_BULK_MIN_ROWS` of them, ten thousand a
 * job: a clone of a whole org owes its second pass by the million. An object
 * an active duplicate rule watches (`restOnly`) is updated by REST all the
 * same — a rule refuses an update as it refuses an insert, and only the REST
 * call's header waives it. An update a job's chunk was refused for a limit
 * goes again by REST as one a call of 200 was refused for, out of the same
 * allowance.
 *
 * An update the target's automation refuses for a Salesforce limit — a
 * trigger on the object that runs a query per record, past the 100 a call
 * allows — is the call's refusal, not the record's: the updates it refused go
 * again, a record on its own first, then in calls half as large, down to one,
 * and the object's later calls go at the size that went through
 * (`sendSplittingOnLimits`). Updates are idempotent and keep no journal line
 * per call, so an update sent again never writes twice. The sizes and the
 * smaller calls are the run's (`splitting`), shared with its first pass. A
 * pass handed none — Seed's — splits nothing: its updates go in calls of 200,
 * and one refused for a limit fails as the org refused it.
 */

import type {
  ExecutionErrorSample,
  ExecutionObjectError,
  ForgeExecutorDeps,
  ForgeProgressEvent,
  UpdateResult,
} from '../ForgeExecutor.js';
import { limitCauseOf, type GovernorLimitCause } from '@sandforge/shared';
import { extractErrorMessage } from '../../../core/common/extractErrorMessage.js';
import {
  BULK_CHUNK,
  FULL_CALL_SIZE,
  allowedFor,
  limitNoteText,
  limitSplitting,
  sendSplittingOnLimits,
  type CallKey,
  type LimitNote,
  type LimitSplitting,
  type SmallerCalls,
  type SplitRun,
} from '../../../core/common/governorLimit.js';
import { LookupPatchSet } from '../../../core/common/lookupPatches.js';
import { LOOKUP_FILTER_REFUSAL } from '../../../core/common/refusedFields.js';
import { RetryStrategy } from '../../../core/engine/RetryStrategy.js';
import type { IdRemapper } from '../IdRemapper.js';
import { logger } from '../../../logger.js';
import { FORGE_BULK_MIN_ROWS } from '../ForgeBatchStrategy.js';
import { BulkJobLostError, FORGE_BULK_JOB_ROWS, type BulkWriteAnswer } from '../forgeBulkWrite.js';
import {
  WRITE_API_MAX_BATCH,
  summarizeRecordForError,
  type PendingFkUpdate,
} from './BatchWriter.js';

/** Inputs for {@link patchCycleFkUpdates}. */
export interface CycleFkPatchInput {
  /** Nullified cycle FKs collected during pass-1 inserts. */
  pendingFkUpdates: readonly PendingFkUpdate[];
  /**
   * Source→target ID mappings accumulated during the full execution: Forge's
   * remapper, or the map a Seed clone keeps, which runs this pass too.
   */
  remapper: Pick<IdRemapper, 'get'>;
  /** Update dep — when omitted, pass 2 is skipped entirely. */
  updateRecords: ForgeExecutorDeps['updateRecords'];
  /** ID of the target Salesforce org. */
  targetOrgId: string;
  /** Master toggle — `false` in dry-run mode (no target writes allowed). */
  enabled: boolean;
  /** Progress sink for the synthetic `__pass2__` event. */
  onProgress: (event: ForgeProgressEvent) => void;
  /**
   * Patch what can be patched now and hand the rest back, silently.
   *
   * The pass runs once at the end of a clone, which is too late for a field a
   * *sibling* insert reads: an opportunity's price book is nullified at
   * insert, and its line items are refused because the opportunity has no
   * price book yet. Called this way after each node, it settles what the run
   * has learned so far and says nothing about the rest, which is still owed
   * and may well resolve later.
   */
  deferUnresolved?: boolean;
  /** Collects the updates that could not be resolved, when deferring. */
  stillPending?: PendingFkUpdate[];
  /**
   * Whether the run was cancelled, asked before each call. Once it says so,
   * no call more is sent: the lookups of the calls left are counted as left
   * empty, and said so. Without it, a clone cancelled during the pass went
   * on writing to the target until its last lookup.
   */
  stopped?: () => boolean;
  /**
   * Told of each update the target took, with what it filled in: a run that
   * keeps its journal and fills in its lookups node by node keeps there what
   * it filled in, for a run that takes it up to owe again only the rest.
   */
  onPatched?: (objectApiName: string, update: Readonly<Record<string, unknown>>) => void;
  /**
   * Told once the target has answered a call, and what it took has been told
   * to `onPatched`, before the pass sends anything else: what a run keeps in
   * its journal of that call goes to disk then. Held to the next turn, the
   * marks of the call would be lost to a process killed meanwhile, and the
   * part taking the run up would send its lookups again.
   */
  onAnswered?: () => void;
  /**
   * Told of each lookup of an update a lookup filter of the target refused,
   * which stays empty: the record, by its id in the target, and the field.
   * A verification of the run tells it from a lookup that broke.
   */
  onRefusedByFilter?: (objectApiName: string, field: string, recordId: string) => void;
  /**
   * The size each object's updates go at once a limit of the target's
   * automation refused one of its calls, and the smaller calls the run allows
   * itself: the run's, shared with its first pass, so that what one node's
   * pass learned holds for the passes after it. Absent, the pass splits
   * nothing.
   */
  splitting?: LimitSplitting;
  /**
   * Send one object's updates as one Bulk API job and answer each
   * (`forgeBulkWrite`): what a run that writes through the Bulk API sends an
   * object's updates as, from `FORGE_BULK_MIN_ROWS` of them. Throws only once
   * the job was closed and could not be read back. Absent, every update goes
   * by REST, as it always did.
   */
  bulkUpdate?: (
    objectApiName: string,
    records: Record<string, unknown>[],
  ) => Promise<BulkWriteAnswer>;
  /**
   * Objects whose updates go by REST whatever their number: those an active
   * duplicate rule of the target watches, which only the REST call's header
   * waives. Read only with `bulkUpdate`.
   */
  restOnly?: ReadonlySet<string>;
  /**
   * Objects the org said the Bulk API does not write, in the run: the run's
   * own (`BulkTransport.bulkUnsupported`), so an object its first write or an
   * earlier node's pass learned that of is not sent as a job again, and one
   * this pass learns it of is not sent so by the passes after. Absent, the
   * pass keeps its own. Read only with `bulkUpdate`.
   */
  bulkUnsupported?: Set<string>;
  /** Waits out the delay before updates a job refused for a lock go again by REST. */
  wait?: (ms: number) => Promise<void>;
}

/** The code the target refuses a row with when it could not lock a record the write needed. */
const LOCK_REFUSAL = 'UNABLE_TO_LOCK_ROW';

/** The code a duplicate rule refuses a row with: a job carries no header that waives it. */
const DUPLICATE_RULE_REFUSAL = 'DUPLICATES_DETECTED';

/**
 * Times an update a job refused for a record it could not lock is sent again
 * by REST, after a wait that doubles each time: the job's chunks run side by
 * side, and two of them updating children of one record wait on its lock.
 */
const RESENDS_OF_A_LOCKED_UPDATE = 3;

/** The wait before the first of those sends: doubled before each next one. */
const RESEND_DELAY_MS = 2_000;

/** Wait `ms` milliseconds. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Whether every error an update was refused with is a lock the target could not get. */
function refusedForALock(result: UpdateResult): boolean {
  const details = result.errorDetails ?? [];
  if (details.length > 0 && details.length === result.errors.length) {
    return details.every((detail) => detail.statusCode === LOCK_REFUSAL);
  }
  return result.errors.length > 0 && result.errors.every((error) => error.startsWith(LOCK_REFUSAL));
}

/**
 * Whether an update a job refused goes once more by REST: refused for a lock,
 * by a duplicate rule the REST call's header waives, or with an error that
 * did not read as exactly one (`forgeBulkWrite` reads one into `errorDetails`).
 */
function goesAgainByRest(result: UpdateResult): boolean {
  const details = result.errorDetails;
  return (
    details?.length !== 1 ||
    details[0].statusCode === DUPLICATE_RULE_REFUSAL ||
    details[0].statusCode === LOCK_REFUSAL
  );
}

/**
 * The value an update sets first, which the updates of a job are sorted by:
 * those that point at one record go together, in one of the job's chunks,
 * rather than wait on its lock from two.
 */
function valueSet(update: Readonly<Record<string, unknown>>): string {
  const field = Object.keys(update).find((name) => name !== 'Id');
  const value = field === undefined ? undefined : update[field];
  return typeof value === 'string' ? value : '';
}

/**
 * How a run of updates sent by REST is priced, and whether a job's chunk
 * refused them for a limit already: see `SplitRun`.
 */
type SplitHow = Pick<
  SplitRun<Record<string, unknown>, UpdateResult>,
  'pricedAs' | 'paid' | 'refusedIn'
>;

/** What the sizes of an object's updates are kept under. */
function updateKey(objectApiName: string): CallKey {
  return { objectApiName, op: 'update' };
}

/** The log line of an object whose updates a limit first refused. */
function logFirstRefusal(report: SmallerCalls): void {
  const who = report.automation ?? "the target's automation";
  logger.warn(
    `[forge] ${report.objectApiName}: ${who} hit ${report.limit ?? 'a Salesforce limit'} on an ` +
      `update of ${report.from} records — sending a record on its own, then smaller calls.`,
  );
}

/** The lookups one update fills in: every field it carries but the record's Id. */
function lookupsIn(update: Record<string, unknown>): number {
  return Object.keys(update).filter((field) => field !== 'Id').length;
}

/**
 * Patch nullified cycle FKs whose targets are now cloned. Emits the
 * synthetic `__pass2__` progress event and returns the error entry for
 * the execution summary — `null` when pass 2 did not run or ran clean.
 */
export async function patchCycleFkUpdates(
  input: CycleFkPatchInput,
): Promise<ExecutionObjectError | null> {
  if (!input.enabled || !input.updateRecords || input.pendingFkUpdates.length === 0) {
    return null;
  }
  const pass = new CycleFkPass(input);
  await pass.patch(input.pendingFkUpdates);
  return pass.finish();
}

/** Records the index below holds before it doubles. */
const INITIAL_RECORDS = 1024;
/** Fullness of the index past which it doubles. */
const RECORDS_LOAD = 0.6;

/** First 32-bit hash of a record id (FNV-1a). */
function idHashA(id: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Second 32-bit hash of a record id, independent of the first. */
function idHashB(id: string): number {
  let h = 0x9747b28c;
  for (let i = 0; i < id.length; i++) {
    h = Math.imul(h ^ id.charCodeAt(i), 0x5bd1e995);
    h ^= h >>> 15;
  }
  return h >>> 0;
}

/**
 * Which records owe lookups in more than one part of what the second pass is
 * handed — the pages of what a run's journal owes — told from a first read of
 * those parts (`note`), so that the pass gathers what each such record owes
 * into one update (`CycleFkPass.patch`).
 *
 * A record's lookups are owed together as its row is written, but a page of
 * the journal ends where it ends, and a run taken up where it stopped owes
 * lookups in its own part as well as the parts before it: such a record took
 * an update per page, and two values of the same lookup, one per page, went
 * one after the other with neither said. Kept under two hashes of the
 * record's id and none of the id, a few bytes a record, whatever the run
 * wrote: two records whose hashes meet are both taken for records owing in
 * several parts, which costs them a wait to the end of the pass, never a
 * lookup.
 */
export class RecordsOwingAcrossParts {
  private capacity = INITIAL_RECORDS;
  private used = 0;
  private h1 = new Uint32Array(this.capacity);
  private h2 = new Uint32Array(this.capacity);
  /** The part a record was first seen in, plus one; 0 for a free slot. */
  private firstPart = new Float64Array(this.capacity);
  /** Whether a record was seen in another part than its first. */
  private several = new Uint8Array(this.capacity);

  /** Note that the record `recordId` owes a lookup in part `part`. */
  note(part: number, recordId: string): void {
    const a = idHashA(recordId);
    const b = idHashB(recordId);
    const slot = this.find(a, b);
    if (slot >= 0) {
      if (this.firstPart[slot] !== part + 1) this.several[slot] = 1;
      return;
    }
    if (this.used + 1 > this.capacity * RECORDS_LOAD) this.grow();
    const free = this.freeSlotFor(b);
    this.h1[free] = a;
    this.h2[free] = b;
    this.firstPart[free] = part + 1;
    this.used++;
  }

  /** Whether the record `recordId` owes lookups in more than one part. */
  spans(recordId: string): boolean {
    const slot = this.find(idHashA(recordId), idHashB(recordId));
    return slot >= 0 && this.several[slot] === 1;
  }

  private find(a: number, b: number): number {
    const mask = this.capacity - 1;
    for (let slot = b & mask; ; slot = (slot + 1) & mask) {
      if (this.firstPart[slot] === 0) return -1;
      if (this.h1[slot] === a && this.h2[slot] === b) return slot;
    }
  }

  private freeSlotFor(b: number): number {
    const mask = this.capacity - 1;
    let slot = b & mask;
    while (this.firstPart[slot] !== 0) slot = (slot + 1) & mask;
    return slot;
  }

  private grow(): void {
    const { h1, h2, firstPart, several } = this;
    this.capacity *= 2;
    this.h1 = new Uint32Array(this.capacity);
    this.h2 = new Uint32Array(this.capacity);
    this.firstPart = new Float64Array(this.capacity);
    this.several = new Uint8Array(this.capacity);
    for (let i = 0; i < firstPart.length; i++) {
      if (firstPart[i] === 0) continue;
      const slot = this.freeSlotFor(h2[i]);
      this.h1[slot] = h1[i];
      this.h2[slot] = h2[i];
      this.firstPart[slot] = firstPart[i];
      this.several[slot] = several[i];
    }
  }
}

/**
 * The second pass over lookups handed to it in parts — a page of what a
 * run's journal owes at a time — and counted as one: one `__pass2__` event
 * and one error entry once every part is through (`finish`). What a record
 * owes in several parts (`RecordsOwingAcrossParts`) is held back as each
 * part goes by and gathered into one update, sent once the last part is
 * through (`sendHeld`): one update a record, whichever parts owe it, and two
 * values of one of its lookups said as a conflict, wherever they were owed.
 */
export class CycleFkPass {
  private resolvedCount = 0;
  // Counted apart from the samples, which are a few: counted by them, a run
  // that left twelve lookups empty reported three.
  private unresolvedCount = 0;
  /** Lookups only an insert sets whose record is written now, after their row: left empty for good. */
  private insertOnlyLost = 0;
  private readonly unresolved: ExecutionErrorSample[] = [];
  // Counted by lookup, as the resolved ones are: a record owing two goes in
  // one update, and counted once when that update was refused, it read as one
  // lookup of two resolved when neither was written.
  private pass2Failed = 0;
  private readonly pass2Samples: ExecutionErrorSample[] = [];
  /** The lookups of the calls a cancel kept from being sent, and their objects. */
  private notSent = 0;
  private readonly notSentObjects = new Set<string>();
  private cancelled = false;
  /** Lookups handed to the pass, in every part. */
  private handed = 0;
  /** What the records owing in several parts owe, gathered across them: see `sendHeld`. */
  private readonly held = new LookupPatchSet();
  /** The run's sizes and allowance, or the pass's own when it splits nothing: see `splits`. */
  private readonly splitting: LimitSplitting;
  /** Whether an update refused for a limit is sent again smaller: only by a pass handed the run's. */
  private readonly splits: boolean;
  /** Objects the org said the Bulk API does not update: updated by REST from then on. */
  private readonly bulkUnsupported: Set<string>;
  /** How long to wait before updates a job refused for a lock go again. */
  private readonly backoff = new RetryStrategy({ initialDelay: RESEND_DELAY_MS });

  constructor(private readonly input: Omit<CycleFkPatchInput, 'pendingFkUpdates'>) {
    this.splits = input.splitting !== undefined;
    this.splitting = input.splitting ?? limitSplitting(0);
    this.bulkUnsupported = input.bulkUnsupported ?? new Set<string>();
  }

  /** The limit an update was refused for, when the pass splits: see {@link splits}. */
  private limitOf(result: UpdateResult | undefined): GovernorLimitCause | undefined {
    return this.splits && result && !result.success ? limitCauseOf(result.errors) : undefined;
  }

  /**
   * Patch one part of the lookups owed.
   *
   * @param heldBack - Whether a record owes lookups in other parts as well:
   *   what it owes is held, and goes with what those owe (`sendHeld`).
   */
  async patch(
    pendingFkUpdates: readonly PendingFkUpdate[],
    heldBack?: (update: PendingFkUpdate) => boolean,
  ): Promise<void> {
    const { input } = this;
    if (!input.enabled || !input.updateRecords || pendingFkUpdates.length === 0) return;
    this.handed += pendingFkUpdates.length;
    const owed = new LookupPatchSet();
    for (const upd of pendingFkUpdates) {
      this.take(upd, heldBack?.(upd) === true ? this.held : owed);
    }
    await this.send(owed);
  }

  /** Send what the records owing in several parts owe, once every part is through. */
  async sendHeld(): Promise<void> {
    await this.send(this.held);
  }

  /** Count one lookup owed, and add it to the updates of `owed` when it can be filled in. */
  private take(upd: PendingFkUpdate, owed: LookupPatchSet): void {
    const { input } = this;
    const { remapper } = input;
    const newRefId = remapper.get(upd.sourceRefId);
    if (!newRefId) {
      if (input.deferUnresolved) {
        input.stillPending?.push(upd);
        return;
      }
      this.unresolvedCount++;
      if (this.unresolved.length < 3) {
        this.unresolved.push({
          recordSummary: `${upd.objectApiName} source=${upd.sourceId ?? '?'} target=${upd.newId} ${upd.fieldName}=<source ${upd.sourceRefId}>`,
          messages: [
            `Cycle FK '${upd.fieldName}' could not be resolved — referenced parent (source ${upd.sourceRefId}) was not cloned`,
          ],
        });
      }
      return;
    }
    // Only an insert sets it, and its record went in after the row: sent, the
    // update is refused — and takes the row's other lookups of that update
    // down with it. Said to be left empty instead, once, as it now is.
    if (upd.insertOnly) {
      this.insertOnlyLost++;
      if (this.unresolved.length < 3) {
        this.unresolved.push({
          recordSummary: `${upd.objectApiName} source=${upd.sourceId ?? '?'} target=${upd.newId} ${upd.fieldName}`,
          messages: [
            `Lookup '${upd.fieldName}' left empty: only an insert sets it, and the record it names ` +
              `(source ${upd.sourceRefId}) was written after this one`,
          ],
        });
      }
      return;
    }
    // Detect dup-on-same-record collisions (same record, same field,
    // different remapped target) — surface explicitly so the user
    // can investigate ambiguous polymorphic FKs (Task.WhatId etc.).
    const patched = owed.add({
      objectApiName: upd.objectApiName,
      recordId: upd.newId,
      fieldName: upd.fieldName,
      value: newRefId,
    });
    if (!patched.taken) {
      this.unresolvedCount++;
      if (this.unresolved.length < 3) {
        this.unresolved.push({
          recordSummary: `${upd.objectApiName} source=${upd.sourceId ?? '?'} target=${upd.newId} ${upd.fieldName}`,
          messages: [
            `Conflicting cycle FK update for ${upd.fieldName}: ${String(patched.kept)} vs ${newRefId}`,
          ],
        });
      }
      return;
    }
    this.resolvedCount++;
  }

  /**
   * Send the updates `owed` holds, per object: as Bulk API jobs when the run
   * sends them and the object owes enough of them (`jobsFor`), otherwise in
   * calls of the REST limit.
   */
  private async send(owed: LookupPatchSet): Promise<void> {
    for (const [objectApiName, recordsToUpdate] of owed.updates()) {
      if (this.jobsFor(objectApiName, recordsToUpdate.length)) {
        await this.sendAsJobs(objectApiName, recordsToUpdate);
        continue;
      }
      await this.sendObject(objectApiName, recordsToUpdate);
    }
  }

  /**
   * Whether `count` updates of `objectApiName` go as Bulk API jobs: the run
   * sends them, they are `FORGE_BULK_MIN_ROWS` or more, and the object is
   * neither one a duplicate rule watches nor one the org said the Bulk API
   * does not update. What a limit did to the object's updates is read job by
   * job (`sendAsJobs`).
   */
  private jobsFor(objectApiName: string, count: number): boolean {
    const { input } = this;
    return (
      input.bulkUpdate !== undefined &&
      count >= FORGE_BULK_MIN_ROWS &&
      input.restOnly?.has(objectApiName) !== true &&
      !this.bulkUnsupported.has(objectApiName)
    );
  }

  /** Count the lookups of updates a cancel kept from being sent. */
  private leaveNotSent(objectApiName: string, records: readonly Record<string, unknown>[]): void {
    for (const record of records) this.notSent += lookupsIn(record);
    if (records.length > 0) this.notSentObjects.add(objectApiName);
  }

  /**
   * Send the updates of one object in calls of the REST limit, or of the size
   * a limit cut the object's updates to, read again before each call, after
   * asking whether the run was cancelled before each. The updates a call of
   * more than one was refused for a limit go again at once, a record on its
   * own first, then in calls half as large (`sendSplittingOnLimits`); one
   * refused so on its own, kept from smaller calls because records sent on
   * their own were refused too, or past the smaller calls the run allows
   * itself, fails with a sentence that says so after the org's.
   *
   * @param locked - Where an update the target refused for a lock goes, to be
   *   sent again, when the caller sends such updates again; absent, it fails
   *   as any refused update does.
   * @param how - How the calls cut smaller are paid, and whether a job's
   *   chunk refused the updates for a limit already: see `SplitRun`.
   */
  private async sendObject(
    objectApiName: string,
    recordsToUpdate: readonly Record<string, unknown>[],
    locked?: Record<string, unknown>[],
    how?: SplitHow,
  ): Promise<void> {
    const { input } = this;
    const { targetOrgId } = input;
    const updateRecords = input.updateRecords;
    if (!updateRecords || recordsToUpdate.length === 0) return;
    const askStopped = (): boolean => {
      if (!this.cancelled) this.cancelled = input.stopped?.() === true;
      return this.cancelled;
    };
    if (askStopped()) {
      this.leaveNotSent(objectApiName, recordsToUpdate);
      return;
    }
    // What a call threw, read by the settle of that call: one rejected call
    // does not abandon the rest, whose records are independent FK patches.
    let threw: { error: unknown } | undefined;
    const outcome = await sendSplittingOnLimits<Record<string, unknown>, UpdateResult>(
      recordsToUpdate,
      {
        key: updateKey(objectApiName),
        sizes: this.splitting.sizes,
        allowance: this.splitting.allowance,
        maxSize: WRITE_API_MAX_BATCH['rest'],
        ...how,
        beforeEachSend: () => (askStopped() ? 'stop' : undefined),
        send: async (part) => {
          try {
            return { answers: await updateRecords(targetOrgId, objectApiName, [...part]) };
          } catch (error) {
            threw = { error };
            return { answers: [] };
          }
        },
        limited: (answer) => this.limitOf(answer),
        settle: (part, answers, again, notes) => {
          const thrown = threw;
          threw = undefined;
          if (thrown) this.callThrew(objectApiName, part, thrown.error);
          else this.settleAnswers(objectApiName, part, answers, again, notes, locked);
          input.onAnswered?.();
        },
        onFirstRefusal: logFirstRefusal,
      },
    );
    // Stopped before a call by a cancel: that call and every one after it
    // were never sent. No call is stopped as one that may have written.
    if (outcome.stopped) {
      this.leaveNotSent(objectApiName, [...outcome.stopped.part, ...outcome.stopped.rest]);
    }
  }

  /**
   * Settle what one call answered: the updates the target took, those it
   * refused for a lock when the caller sends them again, and the others it
   * refused — those of `again` aside, which go again in smaller calls.
   */
  private settleAnswers(
    objectApiName: string,
    batch: readonly Record<string, unknown>[],
    updateResults: readonly (UpdateResult | undefined)[],
    again: ReadonlySet<number>,
    notes: ReadonlyMap<number, LimitNote>,
    locked?: Record<string, unknown>[],
  ): void {
    const { input } = this;
    for (let i = 0; i < batch.length; i++) {
      if (again.has(i)) continue;
      const r = updateResults[i];
      if (!r) {
        // An answer shorter than its batch says nothing of the records past
        // its end, and nothing is not success: left uncounted, their lookups
        // read as resolved. Counted as left empty, as the insert of a batch
        // counts the rows its answer leaves out.
        this.pass2Failed += lookupsIn(batch[i]);
        if (this.pass2Samples.length < 3) {
          this.pass2Samples.push({
            recordSummary: summarizeRecordForError(batch[i]),
            messages: [
              `No result returned for record (API truncated batch: ${updateResults.length}/${batch.length})`,
            ],
          });
        }
      } else if (r.success) input.onPatched?.(objectApiName, batch[i]);
      else if (locked && refusedForALock(r)) locked.push(batch[i]);
      else this.refused(objectApiName, batch[i], r, notes.get(i));
    }
  }

  /**
   * Count an update the target refused: its lookups stay empty, and a filter
   * that named one is told. One refused for a limit and not sent again says
   * why after the org's words (`note`): sent on its own, kept whole, or past
   * the smaller calls the run allows itself.
   */
  private refused(
    objectApiName: string,
    update: Readonly<Record<string, unknown>>,
    result: UpdateResult,
    note?: LimitNote,
  ): void {
    this.tellRefusedByFilter(objectApiName, update, result);
    this.pass2Failed += lookupsIn(update);
    if (this.pass2Samples.length < 3) {
      this.pass2Samples.push({
        recordSummary: summarizeRecordForError(update),
        messages:
          note === undefined
            ? result.errors
            : [
                ...result.errors,
                limitNoteText(
                  note,
                  allowedFor(this.splitting.allowance, updateKey(objectApiName)),
                  'run',
                ),
              ],
      });
    }
  }

  /**
   * Count the updates of a call that threw as left empty, with what it threw.
   * One rejected batch does not abandon the rest: the records in the other
   * batches are independent FK patches.
   */
  private callThrew(
    objectApiName: string,
    batch: readonly Record<string, unknown>[],
    err: unknown,
  ): void {
    for (const record of batch) this.pass2Failed += lookupsIn(record);
    if (this.pass2Samples.length < 3) {
      this.pass2Samples.push({
        recordSummary: `${objectApiName} batch failed`,
        messages: [extractErrorMessage(err)],
      });
    }
  }

  /**
   * Send updates of one object as Bulk API jobs of `FORGE_BULK_JOB_ROWS`,
   * sorted by the value each sets, after asking whether the run was cancelled
   * before each job. What a job took is marked once its results are read; an
   * update it could not answer for itself — left unprocessed, refused for a
   * lock, by a duplicate rule, or with an error that does not read as one —
   * goes again by REST, an update refused for a lock up to three times. A job
   * that wrote nothing has its updates sent by REST, and once the org says
   * the Bulk API does not update the object, every update of it after, as
   * does a job that threw before the org held anything of it. A job lost once
   * closed leaves its lookups said as not filled in — the target may hold
   * them all the same.
   *
   * An update a job's chunk refused for a limit goes again by REST as one a
   * call of `BULK_CHUNK` refused (`SplitRun.refusedIn`), out of the run's
   * allowance; the jobs of the object still to send go by REST at the size
   * kept, as far as the allowance pays every one of their calls, each one
   * more than the job, and once it is spent a job planned stays a job.
   */
  private async sendAsJobs(
    objectApiName: string,
    recordsToUpdate: readonly Record<string, unknown>[],
  ): Promise<void> {
    const { input } = this;
    const bulkUpdate = input.bulkUpdate;
    if (!bulkUpdate) return;
    const sorted = recordsToUpdate
      .map((record, at) => ({ record, at, value: valueSet(record) }))
      .sort((a, b) => (a.value === b.value ? a.at - b.at : a.value < b.value ? -1 : 1))
      .map(({ record }) => record);
    const key = updateKey(objectApiName);
    const { sizes, allowance } = this.splitting;
    for (let offset = 0; offset < sorted.length; offset += FORGE_BULK_JOB_ROWS) {
      let job = sorted.slice(offset, offset + FORGE_BULK_JOB_ROWS);
      if (!this.cancelled) this.cancelled = input.stopped?.() === true;
      if (this.cancelled) {
        this.leaveNotSent(objectApiName, job);
        continue;
      }
      // A limit cut the object's updates: a job's chunks of 200 are the calls
      // that were refused, and the job goes by REST at the size kept, as far
      // as the allowance pays for each of its calls, before the first goes.
      // The key is spent once they went — a spent key's calls go at 200 — and
      // what it did not pay for goes as the job it was planned as, or at 200
      // under the threshold of a job.
      const size = sizes.of(key);
      if (size < FULL_CALL_SIZE) {
        const asked = Math.ceil(job.length / size);
        const granted = allowance.take(key, asked);
        sizes.countExtraCalls(key, granted);
        const byRest = job.slice(0, granted * size);
        try {
          await this.sendObject(objectApiName, byRest, undefined, {
            pricedAs: 'job',
            paid: { calls: granted },
          });
        } finally {
          if (granted < asked) sizes.spend(key);
        }
        if (granted === asked) continue;
        job = job.slice(byRest.length);
        if (this.cancelled) {
          this.leaveNotSent(objectApiName, job);
          continue;
        }
        if (job.length < FORGE_BULK_MIN_ROWS) {
          await this.sendObject(objectApiName, job);
          continue;
        }
      }
      let answer: BulkWriteAnswer;
      try {
        answer = await bulkUpdate(objectApiName, job);
      } catch (err) {
        if (!(err instanceof BulkJobLostError)) {
          // Thrown before the org held anything of it — no connection to the
          // target: nothing was updated, and an update sent twice sets the
          // same value, so the job's updates go by REST.
          await this.sendObject(objectApiName, job);
          continue;
        }
        // Closed, and what it did could not be read back.
        for (const record of job) this.pass2Failed += lookupsIn(record);
        if (this.pass2Samples.length < 3) {
          this.pass2Samples.push({
            recordSummary: `${objectApiName}: a Bulk API job of ${job.length} updates was lost`,
            messages: [
              extractErrorMessage(err),
              'The target may hold any of these lookups: they are counted as left empty.',
            ],
          });
        }
        input.onAnswered?.();
        continue;
      }
      if (answer.aborted) {
        // Cancelled while the job was open: it updated nothing.
        this.cancelled = true;
        this.leaveNotSent(objectApiName, job);
        continue;
      }
      if (answer.untouched) {
        if (answer.untouched.unsupported) this.bulkUnsupported.add(objectApiName);
        await this.sendObject(objectApiName, job);
        continue;
      }
      const again: Array<Record<string, unknown>> = [];
      const limitedRecords: Array<Record<string, unknown>> = [];
      const limitedAnswers: UpdateResult[] = [];
      let cause: GovernorLimitCause | undefined;
      job.forEach((record, i) => {
        const state = answer.rows[i] ?? 'unprocessed';
        const result = answer.answers[i];
        const limited = state === 'answered' ? this.limitOf(result) : undefined;
        if (limited && result) {
          // Refused with its chunk for a limit: by REST, as a call of 200 refused.
          cause ??= limited;
          limitedRecords.push(record);
          limitedAnswers.push(result);
        } else if (state === 'answered' && result?.success) {
          input.onPatched?.(objectApiName, record);
        } else if (state === 'may-have-written') {
          this.pass2Failed += lookupsIn(record);
          if (this.pass2Samples.length < 3) {
            this.pass2Samples.push({
              recordSummary: summarizeRecordForError(record),
              messages: ['The Bulk API job may have written this update without saying so.'],
            });
          }
        } else if (state !== 'answered' || !result || goesAgainByRest(result)) {
          again.push(record);
        } else {
          this.refused(objectApiName, record, result);
        }
      });
      // The marks of what the job took go to disk before anything else is sent.
      input.onAnswered?.();
      await this.sendAgainByRest(objectApiName, again);
      // Never sent at 200 again: a record on its own first, then halves, out
      // of the same allowance, or left refused as the org refused them.
      await this.sendObject(objectApiName, limitedRecords, undefined, {
        refusedIn: { from: BULK_CHUNK, answers: limitedAnswers, ...(cause ? { cause } : {}) },
      });
    }
  }

  /**
   * Send again by REST the updates a job could not answer for itself: once,
   * and an update refused for a lock again, after a wait that doubles each
   * time, up to three times; still refused so, it fails with that refusal.
   */
  private async sendAgainByRest(
    objectApiName: string,
    records: readonly Record<string, unknown>[],
  ): Promise<void> {
    let left = records;
    for (let resends = 0; left.length > 0; resends++) {
      if (resends > 0) await (this.input.wait ?? sleep)(this.backoff.calculateDelay(resends - 1));
      const locked: Array<Record<string, unknown>> = [];
      // The last of its sends: a refusal for a lock fails it.
      await this.sendObject(
        objectApiName,
        left,
        resends < RESENDS_OF_A_LOCKED_UPDATE - 1 ? locked : undefined,
      );
      left = locked;
    }
  }

  /**
   * Tell `onRefusedByFilter` of each lookup of a refused update that a lookup
   * filter of the target named: the update fails whole and leaves it empty.
   */
  private tellRefusedByFilter(
    objectApiName: string,
    update: Readonly<Record<string, unknown>>,
    result: UpdateResult,
  ): void {
    const told = this.input.onRefusedByFilter;
    const recordId = update['Id'];
    if (!told || typeof recordId !== 'string') return;
    const named = new Set(
      (result.errorDetails ?? [])
        .filter((detail) => detail.statusCode === LOOKUP_FILTER_REFUSAL)
        .flatMap((detail) => detail.fields),
    );
    for (const field of Object.keys(update)) {
      if (field !== 'Id' && named.has(field)) told(objectApiName, field, recordId);
    }
  }

  /**
   * Say what the pass came to, in every part: the `__pass2__` event, and the
   * error entry for the summary — `null` when it had nothing to do, ran
   * clean, or, deferring, resolved nothing yet.
   */
  finish(): ExecutionObjectError | null {
    const { resolvedCount, unresolvedCount, insertOnlyLost, pass2Failed, notSent } = this;
    if (this.handed === 0) return null;
    const totalAttempted = resolvedCount + unresolvedCount + insertOnlyLost;
    if (
      this.input.deferUnresolved &&
      resolvedCount === 0 &&
      pass2Failed === 0 &&
      insertOnlyLost === 0
    ) {
      // Nothing was owed yet; saying so on every node would be noise.
      return null;
    }
    const leftEmpty = pass2Failed + unresolvedCount + insertOnlyLost + notSent;
    this.input.onProgress({
      objectName: '__pass2__',
      status: leftEmpty > 0 ? 'error' : 'done',
      progress: 100,
      message:
        `Pass 2 (cycle FK update): ${resolvedCount - pass2Failed - notSent}/${totalAttempted} resolved` +
        (notSent > 0 ? `; cancelled with ${notSent} not sent` : ''),
    });
    if (leftEmpty > 0) {
      // What the cancel left goes first: the samples are cut at three.
      const stoppedSample: ExecutionErrorSample[] =
        notSent > 0
          ? [
              {
                recordSummary: `${[...this.notSentObjects].join(', ')}: ${notSent} lookup${notSent === 1 ? '' : 's'} not sent`,
                messages: ['The run was cancelled before they were filled in: they stay empty.'],
              },
            ]
          : [];
      return {
        objectApiName: '__pass2__',
        stage: 'insert',
        failedCount: leftEmpty,
        attemptedCount: totalAttempted,
        samples: [...stoppedSample, ...this.pass2Samples, ...this.unresolved].slice(0, 3),
      };
    }
    return null;
  }
}
