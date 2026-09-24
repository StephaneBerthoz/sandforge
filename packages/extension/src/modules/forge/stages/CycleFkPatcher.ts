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
 * is set, which that call site does not pass — so the whole array went out
 * as one request. Pass 1 was bounded and pass 2, which it feeds, was not:
 * a cyclic clone (Account.ParentId, Contact.ReportsToId) of more than 200
 * records still failed entirely, one stage later.
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
  /** Source→target ID mappings accumulated during the full execution. */
  remapper: IdRemapper;
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
  const { pendingFkUpdates, remapper, targetOrgId, onProgress } = input;
  if (!input.enabled || !input.updateRecords || pendingFkUpdates.length === 0) {
    return null;
  }
  const updateRecords = input.updateRecords;

  const owed = new LookupPatchSet();
  let resolvedCount = 0;
  // Counted apart from the samples, which are a few: counted by them, a run
  // that left twelve lookups empty reported three.
  let unresolvedCount = 0;
  const unresolved: ExecutionErrorSample[] = [];
  for (const upd of pendingFkUpdates) {
    const newRefId = remapper.get(upd.sourceRefId);
    if (!newRefId) {
      if (input.deferUnresolved) {
        input.stillPending?.push(upd);
        continue;
      }
      unresolvedCount++;
      if (unresolved.length < 3) {
        unresolved.push({
          recordSummary: `${upd.objectApiName} source=${upd.sourceId ?? '?'} target=${upd.newId} ${upd.fieldName}=<source ${upd.sourceRefId}>`,
          messages: [
            `Cycle FK '${upd.fieldName}' could not be resolved — referenced parent (source ${upd.sourceRefId}) was not cloned`,
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
      unresolvedCount++;
      if (unresolved.length < 3) {
        unresolved.push({
          recordSummary: `${upd.objectApiName} source=${upd.sourceId ?? '?'} target=${upd.newId} ${upd.fieldName}`,
          messages: [
            `Conflicting cycle FK update for ${upd.fieldName}: ${String(patched.kept)} vs ${newRefId}`,
          ],
        });
      }
      continue;
    }
    resolvedCount++;
  }
  // Counted by lookup, as the resolved ones are: a record owing two goes in
  // one update, and counted once when that update was refused, it read as one
  // lookup of two resolved when neither was written.
  let pass2Failed = 0;
  const pass2Samples: ExecutionErrorSample[] = [];
  const maxPerCall = WRITE_API_MAX_BATCH['rest'];
  for (const [objectApiName, recordsToUpdate] of owed.updates()) {
    for (let offset = 0; offset < recordsToUpdate.length; offset += maxPerCall) {
      const batch = recordsToUpdate.slice(offset, offset + maxPerCall);
      try {
        const updateResults = await updateRecords(targetOrgId, objectApiName, batch);
        for (let i = 0; i < updateResults.length; i++) {
          const r = updateResults[i];
          if (!r.success) {
            pass2Failed += lookupsIn(batch[i]);
            if (pass2Samples.length < 3) {
              pass2Samples.push({
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
          pass2Failed += lookupsIn(batch[i]);
          if (pass2Samples.length < 3) {
            pass2Samples.push({
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
        for (const record of batch) pass2Failed += lookupsIn(record);
        if (pass2Samples.length < 3) {
          pass2Samples.push({
            recordSummary: `${objectApiName} batch failed`,
            messages: [extractErrorMessage(err)],
          });
        }
      }
    }
  }
  const totalAttempted = resolvedCount + unresolvedCount;
  if (input.deferUnresolved && resolvedCount === 0 && pass2Failed === 0) {
    // Nothing was owed yet; saying so on every node would be noise.
    return null;
  }
  onProgress({
    objectName: '__pass2__',
    status: pass2Failed + unresolvedCount > 0 ? 'error' : 'done',
    progress: 100,
    message: `Pass 2 (cycle FK update): ${resolvedCount - pass2Failed}/${totalAttempted} resolved`,
  });
  if (pass2Failed > 0 || unresolvedCount > 0) {
    return {
      objectApiName: '__pass2__',
      stage: 'insert',
      failedCount: pass2Failed + unresolvedCount,
      attemptedCount: totalAttempted,
      samples: [...pass2Samples, ...unresolved].slice(0, 3),
    };
  }
  return null;
}
