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
 */

import type {
  ExecutionErrorSample,
  ExecutionObjectError,
  ForgeExecutorDeps,
  ForgeProgressEvent,
} from '../ForgeExecutor.js';
import { extractErrorMessage } from '../../../core/common/extractErrorMessage.js';
import { LookupPatchSet } from '../../../core/common/lookupPatches.js';
import type { IdRemapper } from '../IdRemapper.js';
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

/**
 * The second pass over lookups handed to it in parts — a page of what a
 * run's journal owes at a time — and counted as one: one `__pass2__` event
 * and one error entry once every part is through (`finish`). A record owing
 * two lookups in two parts takes two updates; what each fills in is the same.
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

  constructor(private readonly input: Omit<CycleFkPatchInput, 'pendingFkUpdates'>) {}

  /** Patch one part of the lookups owed. */
  async patch(pendingFkUpdates: readonly PendingFkUpdate[]): Promise<void> {
    const { input } = this;
    const { remapper, targetOrgId } = input;
    const updateRecords = input.updateRecords;
    if (!input.enabled || !updateRecords || pendingFkUpdates.length === 0) return;
    this.handed += pendingFkUpdates.length;
    const owed = new LookupPatchSet();
    for (const upd of pendingFkUpdates) {
      const newRefId = remapper.get(upd.sourceRefId);
      if (!newRefId) {
        if (input.deferUnresolved) {
          input.stillPending?.push(upd);
          continue;
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
        continue;
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
        continue;
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
        continue;
      }
      this.resolvedCount++;
    }
    const maxPerCall = WRITE_API_MAX_BATCH['rest'];
    for (const [objectApiName, recordsToUpdate] of owed.updates()) {
      for (let offset = 0; offset < recordsToUpdate.length; offset += maxPerCall) {
        const batch = recordsToUpdate.slice(offset, offset + maxPerCall);
        if (!this.cancelled) this.cancelled = input.stopped?.() === true;
        if (this.cancelled) {
          for (const record of batch) this.notSent += lookupsIn(record);
          this.notSentObjects.add(objectApiName);
          continue;
        }
        try {
          const updateResults = await updateRecords(targetOrgId, objectApiName, batch);
          for (let i = 0; i < updateResults.length; i++) {
            const r = updateResults[i];
            if (!r.success) {
              this.pass2Failed += lookupsIn(batch[i]);
              if (this.pass2Samples.length < 3) {
                this.pass2Samples.push({
                  recordSummary: summarizeRecordForError(batch[i]),
                  messages: r.errors,
                });
              }
            }
          }
          // An answer shorter than its batch says nothing of the records past
          // its end, and nothing is not success: left uncounted, their lookups
          // read as resolved. Counted as left empty, as the insert of a batch
          // counts the rows its answer leaves out.
          for (let i = updateResults.length; i < batch.length; i++) {
            this.pass2Failed += lookupsIn(batch[i]);
            if (this.pass2Samples.length < 3) {
              this.pass2Samples.push({
                recordSummary: summarizeRecordForError(batch[i]),
                messages: [
                  `No result returned for record (API truncated batch: ${updateResults.length}/${batch.length})`,
                ],
              });
            }
          }
        } catch (err) {
          // One rejected batch does not abandon the rest: the records in the
          // other batches are independent FK patches.
          for (const record of batch) this.pass2Failed += lookupsIn(record);
          if (this.pass2Samples.length < 3) {
            this.pass2Samples.push({
              recordSummary: `${objectApiName} batch failed`,
              messages: [extractErrorMessage(err)],
            });
          }
        }
      }
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
