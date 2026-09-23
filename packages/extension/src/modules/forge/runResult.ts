/**
 * The result a Forge run is recorded under, from what its executor reported.
 *
 * One shape for a run that finished and for one that stopped part way — a
 * failure, or a cancel — so the history keeps both the same way, and removing
 * what a run created works on either. Kept apart from the executor, as its
 * interrupted tallies are (`interruptedRun.ts`), so the handler builds the
 * result of a run that threw without loading the executor.
 */
import type { ForgeExecutionResult, ForgeGraph } from '@sandforge/shared';

import type { ExecutionSummary } from './ForgeExecutor.js';

/** How a run ended, as its result says it. */
export type ForgeRunStatus = ForgeExecutionResult['status'];

/**
 * The status of a run the executor saw through to its end.
 *
 * A run with no failure succeeded. One that failed some records and settled
 * others — created them, wrote over a match by external id, or linked them
 * to the record the target already held — did part of its job, not none of it.
 */
export function finishedRunStatus(
  summary: Pick<ExecutionSummary, 'successCount' | 'updatedCount' | 'linkedCount' | 'failedCount'>,
): ForgeRunStatus {
  if (summary.failedCount === 0) return 'success';
  const settled = summary.successCount + summary.updatedCount + summary.linkedCount;
  return settled > 0 ? 'partial' : 'failure';
}

/**
 * The result of a run, from its executor's summary.
 *
 * @param summary - What the executor did: what it returned, or the tallies it
 *   kept with the error it threw.
 * @param graph - The graph the run executed.
 * @param run - When the run started, and how it ended.
 */
export function forgeRunResult(
  summary: ExecutionSummary,
  graph: ForgeGraph,
  run: { startedAt: number; status: ForgeRunStatus },
): ForgeExecutionResult {
  return {
    forgeId: `forge-${Date.now()}`,
    status: run.status,
    graph,
    duration: Date.now() - run.startedAt,
    timestamp: new Date().toISOString(),
    idRemapCount: summary.remapCount,
    // The executor has always returned this table; projecting only its
    // count is what left a finished run unable to say where anything went.
    idRemapTable: summary.remapTable,
    // Which of those entries point at a record the target already held:
    // the table alone reads them as records this run created.
    idRemapExisting: summary.existingSourceIds,
    createdCount: summary.successCount,
    // Only a run that upserted says how many records it wrote over.
    ...(summary.updatedCount > 0 ? { updatedCount: summary.updatedCount } : {}),
    linkedExistingCount: summary.linkedCount,
    existingRecords: summary.existingRecords,
    idRemapByObject: summary.remapByObject,
    // The table alone cannot say which of its rows the run created: it
    // maps the standard price book and reference data matched by name too.
    idRemapCreated: summary.createdByObject,
    errors: summary.errors,
    // A read cut short by a bound is not an error and not a success: the
    // clone is short by an unknown number of rows, and only the summary
    // can say which objects.
    truncatedObjects: summary.truncatedObjects,
    // Only a run asked to copy files says what became of them.
    ...(summary.files ? { files: summary.files } : {}),
    ...(summary.fileContentFieldsLeftOut
      ? { fileContentFieldsLeftOut: summary.fileContentFieldsLeftOut }
      : {}),
    // The target's own dates of the run's writes, which removing its records
    // tells a later change by.
    ...(summary.writtenBetween ? { writtenBetween: summary.writtenBetween } : {}),
  };
}
