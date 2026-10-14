import type { ForgeExecutionResult, ForgeNodeStatus } from '@sandforge/shared';
import { csvCell, forgeRunCreatedRecords } from '@sandforge/shared';

/** Rows of cells as CSV text, a line per row. */
function csv(rows: ReadonlyArray<ReadonlyArray<string | number | undefined>>): string {
  return rows.map((row) => row.map(csvCell).join(',')).join('\n');
}

/**
 * The records of a run's target ids that it created, by target id, with the
 * object each belongs to: what the Id map can open in the target org.
 */
export function createdTargets(
  result: Pick<ForgeExecutionResult, 'idRemapTable' | 'idRemapExisting' | 'idRemapCreated'>,
): Map<string, string> {
  const created = new Map<string, string>();
  for (const { objectApiName, ids } of forgeRunCreatedRecords(result)) {
    for (const id of ids) created.set(id, objectApiName);
  }
  return created;
}

/** One object of the results table, as the file takes it. */
export interface ObjectResultRow {
  objectApiName: string;
  /** What the run read of it; nothing for an object it did not read. */
  records: number | undefined;
  status: ForgeNodeStatus;
  /** What went wrong with it as discovery described or counted it. */
  errors: readonly string[];
}

/**
 * The per-object results as a CSV file: the rows the results table lists,
 * each status by its code as the copied report gives it, with what the run
 * created, linked and counted as failed of each object.
 */
export function objectResultsCsv(
  rows: readonly ObjectResultRow[],
  result: Pick<ForgeExecutionResult, 'idRemapByObject' | 'errors'> | null,
): string {
  const remapped = new Map(
    (result?.idRemapByObject ?? []).map((counts) => [counts.objectApiName, counts]),
  );
  // Reference data the target holds no match for is neither written nor
  // failed, whatever its report counts: the run's totals count it in neither.
  const failed = new Map<string, number>();
  for (const report of result?.errors ?? []) {
    if (report.referenceData === true) continue;
    failed.set(report.objectApiName, (failed.get(report.objectApiName) ?? 0) + report.failedCount);
  }
  return csv([
    ['Object', 'Records read', 'Status', 'Created', 'Linked', 'Failed', 'Errors'],
    ...rows.map((row) => [
      row.objectApiName,
      row.records,
      row.status,
      remapped.get(row.objectApiName)?.created ?? 0,
      remapped.get(row.objectApiName)?.linked ?? 0,
      failed.get(row.objectApiName) ?? 0,
      row.errors.join('; '),
    ]),
  ]);
}
