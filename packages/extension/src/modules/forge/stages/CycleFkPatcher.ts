/**
 * Cycle FK patcher stage (pass 2) of the Forge execution pipeline.
 *
 * Records inserted with `Foo.BarId = null` because Bar had not been cloned
 * yet at insert time would stay disconnected without this pass. Pending
 * updates are grouped by (objectApiName, newId) so multiple FK fields on
 * the same record collapse to a single UPDATE call, then dispatched
 * through `deps.updateRecords` in a per-object batch.
 */

import type {
  ExecutionErrorSample,
  ExecutionObjectError,
  ForgeExecutorDeps,
  ForgeProgressEvent,
} from '../ForgeExecutor.js';
import { extractErrorMessage } from '../../../core/common/extractErrorMessage.js';
import type { IdRemapper } from '../IdRemapper.js';
import { summarizeRecordForError, type PendingFkUpdate } from './BatchWriter.js';

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

  const updatesByObject = new Map<string, Map<string, Record<string, unknown>>>();
  let resolvedCount = 0;
  const unresolved: ExecutionErrorSample[] = [];
  for (const upd of pendingFkUpdates) {
    const newRefId = remapper.get(upd.sourceRefId);
    if (!newRefId) {
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
    let perObj = updatesByObject.get(upd.objectApiName);
    if (!perObj) {
      perObj = new Map();
      updatesByObject.set(upd.objectApiName, perObj);
    }
    // CR-002: explicit "read current → check conflict → build → set"
    // pattern so the mutable-by-reference semantics are obvious.
    // Previous code relied on `existing` aliasing the map entry and
    // mutating it in place — silently broken if a refactor introduces
    // defensive cloning. Now the intent is unambiguous.
    const current = perObj.get(upd.newId);
    const previousValue = current?.[upd.fieldName];
    // Detect dup-on-same-record collisions (same record, same field,
    // different remapped target) — surface explicitly so the user
    // can investigate ambiguous polymorphic FKs (Task.WhatId etc.).
    if (previousValue !== undefined && previousValue !== newRefId) {
      if (unresolved.length < 3) {
        unresolved.push({
          recordSummary: `${upd.objectApiName} source=${upd.sourceId ?? '?'} target=${upd.newId} ${upd.fieldName}`,
          messages: [
            `Conflicting cycle FK update for ${upd.fieldName}: ${String(previousValue)} vs ${newRefId}`,
          ],
        });
      }
      continue;
    }
    const updated = current ?? { Id: upd.newId };
    updated[upd.fieldName] = newRefId;
    perObj.set(upd.newId, updated);
    resolvedCount++;
  }
  let pass2Failed = 0;
  const pass2Samples: ExecutionErrorSample[] = [];
  for (const [objectApiName, perObj] of updatesByObject) {
    const recordsToUpdate = [...perObj.values()];
    try {
      const updateResults = await updateRecords(targetOrgId, objectApiName, recordsToUpdate);
      for (let i = 0; i < updateResults.length; i++) {
        const r = updateResults[i];
        if (!r.success) {
          pass2Failed++;
          if (pass2Samples.length < 3) {
            pass2Samples.push({
              recordSummary: summarizeRecordForError(recordsToUpdate[i]),
              messages: r.errors,
            });
          }
        }
      }
    } catch (err) {
      pass2Failed += recordsToUpdate.length;
      if (pass2Samples.length < 3) {
        pass2Samples.push({
          recordSummary: `${objectApiName} batch failed`,
          messages: [extractErrorMessage(err)],
        });
      }
    }
  }
  const totalAttempted = resolvedCount + unresolved.length;
  onProgress({
    objectName: '__pass2__',
    status: pass2Failed + unresolved.length > 0 ? 'error' : 'done',
    progress: 100,
    message: `Pass 2 (cycle FK update): ${resolvedCount - pass2Failed}/${totalAttempted} resolved`,
  });
  if (pass2Failed > 0 || unresolved.length > 0) {
    return {
      objectApiName: '__pass2__',
      stage: 'insert',
      failedCount: pass2Failed + unresolved.length,
      attemptedCount: totalAttempted,
      samples: [...pass2Samples, ...unresolved].slice(0, 3),
    };
  }
  return null;
}
