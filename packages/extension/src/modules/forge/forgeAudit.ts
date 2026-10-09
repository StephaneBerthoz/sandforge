/**
 * What a Forge run's entry in the audit trail says it did: per object, the
 * rows it created, updated, lost and carried, how a run a cancel stopped is
 * recorded, and the counts of the email addresses and phone numbers it
 * neutralized.
 *
 * Shared by the panel's handler and the command-line clone (`--audit`), so an
 * entry the command writes reads as one the panel writes, and both go through
 * the same export. The command-line clone left no entry at all: a CI job's
 * clone was in no trail, where the Frozen and backup commands, which drive the
 * panel's own handlers, left theirs.
 */

import type {
  AuditObjectCounts,
  AuditOutcome,
  ForgeContactPointsReport,
  ForgeExecutionResult,
} from '@sandforge/shared';

import { emptyCounts } from '../audit/auditTrail.js';
import type { ExecutionSummary } from './ForgeExecutor.js';
import { finishedRunStatus } from './runResult.js';

/** Why a run a cancel stopped once the executor had it, before it wrote anything, was stopped. */
export const RUN_CANCELLED = 'RUN_CANCELLED';

/**
 * What {@link forgeAuditObjects} and {@link forgeCarried} read of a run the
 * executor reported, ended or stopped part way: its tallies under the names
 * a run's history entry gives them.
 */
export function auditTalliesOf(
  summary: Pick<
    ExecutionSummary,
    'remapByObject' | 'errors' | 'notSentByObject' | 'writtenWithoutFields' | 'mayHaveBeenWritten'
  >,
): Parameters<typeof forgeAuditObjects>[0] {
  return {
    idRemapByObject: summary.remapByObject,
    errors: summary.errors,
    notSentByObject: summary.notSentByObject,
    writtenWithoutFields: summary.writtenWithoutFields,
    mayHaveBeenWritten: summary.mayHaveBeenWritten,
  };
}

/**
 * What a run did per object, for the audit trail: the rows it created,
 * counted from its remap table, the rows the run lost at read or at write,
 * and the rows a stop kept from the target — a cancel as the object was
 * written, or the failure the run ended on before the emails that waited for
 * their task — as the object's line says them. Of the rows written, those a
 * validation rule or a restricted picklist refused that went in without the
 * fields it named are counted again apart.
 *
 * A row linked to one the target already held was never written and is
 * neither. Of the `scope` reports, the rows the run held back before sending
 * them — for want of their parent, for a record type the running user cannot
 * use in the target, for an object the user excluded — are failed, as the run
 * counts them. Reference data unmatched by name is left out: it was never
 * going to be written. So is a note, which counts no row, and so are the
 * reports that name a pass rather than an object (`__pass2__`,
 * `__expandOrphanParents__`). An object skipped whole — a parent it cannot be
 * written without failed, or the target takes no insert of it while the clone
 * holds records of it — is named and marked skipped, whether or not it counts
 * a row: its rows read before the skip are failed, as the run counts them,
 * and one it never learned the rows of is marked uncounted, for the page to
 * say so rather than show nothing.
 */
export function forgeAuditObjects(
  result: Pick<
    ForgeExecutionResult,
    'idRemapByObject' | 'errors' | 'writtenWithoutFields' | 'mayHaveBeenWritten'
  > &
    Pick<ExecutionSummary, 'notSentByObject'>,
): AuditObjectCounts[] {
  const byObject = new Map<string, AuditObjectCounts>();
  const countsOf = (objectApiName: string): AuditObjectCounts => {
    const counts = byObject.get(objectApiName) ?? emptyCounts(objectApiName);
    byObject.set(objectApiName, counts);
    return counts;
  };
  for (const row of result.idRemapByObject ?? []) {
    const counts = countsOf(row.objectApiName);
    counts.created += row.created;
    // Written over by an upsert that matched them: updated, never created.
    counts.updated += row.updated ?? 0;
  }
  for (const error of result.errors ?? []) {
    if (error.objectApiName.startsWith('__') || error.referenceData === true) continue;
    // Left out with the notes, the rows held back were in no count: a run
    // that held back an object for its record type recorded no object at
    // all, and one that held back rows for an object left out read as a run
    // that wrote all it read. A note still names no object; an object skipped
    // whole does, counting no row when the run never learned how many it
    // held: left out, the entry of a run that lost a whole object read as one
    // that never met it.
    if (error.stage === 'scope' && error.failedCount === 0 && error.skipped !== true) continue;
    const counts = countsOf(error.objectApiName);
    counts.failed += error.failedCount;
    if (error.skipped === true) counts.skipped = error.failedCount > 0 ? 'counted' : 'uncounted';
  }
  // Neither written nor failed. Said on the object's line alone, the entry of
  // a run a cancel cut short read as if it had written whole each object it
  // began, and one the cancel stopped before its first call was not in it.
  for (const row of result.notSentByObject ?? []) {
    const counts = countsOf(row.objectApiName);
    counts.notSent = (counts.notSent ?? 0) + row.notSent;
  }
  // Written, and counted so above, but short of the fields a validation rule
  // or a restricted picklist of the target refused: how many, never which
  // values.
  for (const row of result.writtenWithoutFields ?? []) {
    const counts = countsOf(row.objectApiName);
    counts.writtenWithoutFields = (counts.writtenWithoutFields ?? 0) + row.rows;
  }
  // Failed, and counted so above, but maybe in the target all the same: the
  // call that carried them never answered, and no removal reaches them.
  for (const { objectApiName, sourceIds } of result.mayHaveBeenWritten ?? []) {
    const counts = countsOf(objectApiName);
    counts.mayHaveBeenWritten = (counts.mayHaveBeenWritten ?? 0) + sourceIds.length;
  }
  return [...byObject.values()];
}

/**
 * How the audit trail records a run a cancel stopped once the executor had
 * it. Recorded as failed, it read as a run that went wrong, where the history
 * keeps it as partial (`keepStoppedRun`) and Seed records a cancel so. Partial
 * once it wrote a record — created one, or wrote over one an upsert matched;
 * stopped when it wrote none, as a run stopped before it started is. What its
 * tallies say otherwise stands, as for a run that finished with them: one
 * whose rows the target refused, or whose read failed, with nothing settled,
 * failed.
 *
 * @param summary - What the executor held when the cancel stopped it; absent
 *   when it held nothing yet.
 * @param objects - What the run's entry says it did, per object.
 */
export function cancelledRunOutcome(
  summary: ExecutionSummary | undefined,
  objects: readonly AuditObjectCounts[],
): AuditOutcome {
  if (objects.some((object) => object.created + object.updated > 0)) return 'partial';
  const reached = summary ? finishedRunStatus(summary) : 'success';
  return reached === 'success' ? 'stopped' : reached;
}

/**
 * What the audit trail keeps of a run's email addresses and phone numbers:
 * whether it neutralized them or kept them as read, and how many fields and
 * values it neutralized — counts, never an address or a number. Nothing for a
 * run that reported none.
 */
export function contactPointsAudit(
  report: ForgeContactPointsReport | undefined,
): { details: Record<string, string | number> } | Record<string, never> {
  if (!report) return {};
  return {
    details: {
      contactPoints: report.neutralized ? 'neutralized' : 'kept',
      contactPointFields: report.fields.length,
      contactPointValues: report.values,
    },
  };
}

/**
 * Per object, the source rows the run gave a counterpart in the target —
 * created, or linked to the record the target already held — as its remap
 * table counts them.
 */
export function forgeCarried(
  result: Pick<ForgeExecutionResult, 'idRemapByObject'>,
): Record<string, number> {
  return Object.fromEntries(
    (result.idRemapByObject ?? []).map((row) => [
      row.objectApiName,
      row.created + row.linked + (row.updated ?? 0),
    ]),
  );
}
