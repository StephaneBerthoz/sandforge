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
import { limitCauseOf } from '@sandforge/shared';
import { extractErrorMessage } from '../../../core/common/extractErrorMessage.js';
import {
  allowedFor,
  limitNoteText,
  limitSplitting,
  sendSplittingOnLimits,
  type CallKey,
  type LimitNote,
  type LimitSplitting,
  type SmallerCalls,
} from '../../../core/common/governorLimit.js';
import { LookupPatchSet } from '../../../core/common/lookupPatches.js';
import { LOOKUP_FILTER_REFUSAL } from '../../../core/common/refusedFields.js';
import type { IdRemapper } from '../IdRemapper.js';
import { logger } from '../../../logger.js';
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
}

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

  constructor(private readonly input: Omit<CycleFkPatchInput, 'pendingFkUpdates'>) {
    this.splits = input.splitting !== undefined;
    this.splitting = input.splitting ?? limitSplitting(0);
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

  /** Send the updates `owed` holds, per object, in calls of the REST limit. */
  private async send(owed: LookupPatchSet): Promise<void> {
    for (const [objectApiName, recordsToUpdate] of owed.updates()) {
      await this.sendObject(objectApiName, recordsToUpdate);
    }
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
   */
  private async sendObject(
    objectApiName: string,
    recordsToUpdate: readonly Record<string, unknown>[],
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
        beforeEachSend: () => (askStopped() ? 'stop' : undefined),
        send: async (part) => {
          try {
            return { answers: await updateRecords(targetOrgId, objectApiName, [...part]) };
          } catch (error) {
            threw = { error };
            return { answers: [] };
          }
        },
        limited: (answer) =>
          this.splits && answer && !answer.success ? limitCauseOf(answer.errors) : undefined,
        settle: (part, answers, again, notes) => {
          const thrown = threw;
          threw = undefined;
          if (thrown) this.callThrew(objectApiName, part, thrown.error);
          else this.settleAnswers(objectApiName, part, answers, again, notes);
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
   * Settle what one call answered: the updates the target took, and the
   * others it refused — those of `again` aside, which go again in smaller
   * calls.
   */
  private settleAnswers(
    objectApiName: string,
    batch: readonly Record<string, unknown>[],
    updateResults: readonly (UpdateResult | undefined)[],
    again: ReadonlySet<number>,
    notes: ReadonlyMap<number, LimitNote>,
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
      else {
        this.tellRefusedByFilter(objectApiName, batch[i], r);
        this.pass2Failed += lookupsIn(batch[i]);
        if (this.pass2Samples.length < 3) {
          const note = notes.get(i);
          this.pass2Samples.push({
            recordSummary: summarizeRecordForError(batch[i]),
            messages:
              note === undefined
                ? r.errors
                : [
                    ...r.errors,
                    limitNoteText(
                      note,
                      allowedFor(this.splitting.allowance, updateKey(objectApiName)),
                      'run',
                    ),
                  ],
          });
        }
      }
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
