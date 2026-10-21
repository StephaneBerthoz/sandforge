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

/**
 * The copy the run created of the record it was asked to clone, `recordId`:
 * its id in the target and its object. For a run from a query, which names no
 * record, the first record it created of the root object. Nothing when the
 * run created none of them, linked to one the target held, or keeps its ids
 * in its journal. A record id typed with 15 characters finds the 18 the run
 * read it by.
 */
export function rootCopyOf(
  result: Pick<ForgeExecutionResult, 'idRemapTable' | 'idRemapExisting' | 'idRemapCreated'> & {
    graph: Pick<ForgeExecutionResult['graph'], 'nodes'>;
  },
  recordId: string | undefined,
): { targetId: string; objectApiName: string; label?: string } | undefined {
  const table = result.idRemapTable ?? {};
  let sourceId: string | undefined;
  if (recordId) {
    const prefix = recordId.slice(0, 15);
    sourceId = Object.keys(table).find((id) => id.slice(0, 15) === prefix);
  } else {
    const root = result.graph.nodes.find((node) => node.level === 0)?.objectApiName;
    sourceId = result.idRemapCreated?.find((o) => o.objectApiName === root)?.sourceIds[0];
  }
  const targetId = sourceId === undefined ? undefined : table[sourceId];
  const objectApiName = targetId === undefined ? undefined : createdTargets(result).get(targetId);
  if (targetId === undefined || objectApiName === undefined) return undefined;
  // The object's label, which discovery's describe gave its node: the
  // results name the copy by it ("Open the Invoice cloned in …").
  const label = result.graph.nodes.find((node) => node.objectApiName === objectApiName)?.label;
  return label ? { targetId, objectApiName, label } : { targetId, objectApiName };
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
