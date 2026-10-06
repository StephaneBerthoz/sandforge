import type { ForgeExecutionResult, ForgeNodeStatus } from '@sandforge/shared';
import { forgeRunCreatedRecords } from '@sandforge/shared';

/**
 * A cell as a spreadsheet reads it back: quoted, its quotes doubled, so a
 * comma, a quote or a line break in a refusal's message stays in its cell.
 * One that begins as a formula would — `=`, `+`, `-`, `@`, a tab or a
 * carriage return — is written after a quote mark, read as text: the
 * messages come from the target org's validation rules and flows, and a cell
 * opened in a spreadsheet runs what it starts with.
 */
export function csvCell(value: string | number | undefined): string {
  const text = value === undefined ? '' : String(value);
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return `"${safe.replace(/"/g, '""')}"`;
}

/** Rows of cells as CSV text, a line per row. */
function csv(rows: ReadonlyArray<ReadonlyArray<string | number | undefined>>): string {
  return rows.map((row) => row.map(csvCell).join(',')).join('\n');
}

/**
 * What became of a row of the Id map, in the file's words, English as the
 * copied report is: created by the run, linked to a record the target already
 * held, written by the platform with a record the run created, or mapped to
 * one the run found there (the standard price book, reference data matched by
 * name).
 */
export type IdMapOutcome = 'created' | 'linked to existing' | 'written with its record' | 'mapped';

/** One row of the Id map: its object when the run recorded it, its ids, what became of it. */
export interface IdMapRow {
  objectApiName: string | undefined;
  sourceId: string;
  targetId: string;
  outcome: IdMapOutcome;
}

/**
 * The rows of a run's Id map, in the order the run produced them, each with
 * its object and what became of it.
 *
 * The run records the object of the rows it created only. A source id's first
 * three characters name its object within the org it comes from, and every
 * source id of a run comes from one org: a row the run linked to takes the
 * object of the created rows its id shares them with. One no created row
 * shares them with keeps no object, rather than a guess.
 */
export function idMapRows(
  result: Pick<
    ForgeExecutionResult,
    'idRemapTable' | 'idRemapExisting' | 'idRemapCreated' | 'idRemapWithTheirRecord'
  >,
): IdMapRow[] {
  const objectOf = new Map<string, string>();
  const objectOfPrefix = new Map<string, string>();
  for (const { objectApiName, sourceIds } of result.idRemapCreated ?? []) {
    for (const sourceId of sourceIds) {
      objectOf.set(sourceId, objectApiName);
      objectOfPrefix.set(sourceId.slice(0, 3), objectApiName);
    }
  }
  const existing = new Set(result.idRemapExisting ?? []);
  const withTheirRecord = new Set(result.idRemapWithTheirRecord ?? []);
  return Object.entries(result.idRemapTable ?? {}).map(([sourceId, targetId]): IdMapRow => {
    const outcome: IdMapOutcome = withTheirRecord.has(sourceId)
      ? 'written with its record'
      : existing.has(sourceId)
        ? 'linked to existing'
        : objectOf.has(sourceId)
          ? 'created'
          : 'mapped';
    return {
      objectApiName: objectOf.get(sourceId) ?? objectOfPrefix.get(sourceId.slice(0, 3)),
      sourceId,
      targetId,
      outcome,
    };
  });
}

/** The Id map as a CSV file: object, source id, target id, outcome. */
export function idMapCsv(rows: readonly IdMapRow[]): string {
  return csv([
    ['Object', 'Source Id', 'Target Id', 'Outcome'],
    ...rows.map((row) => [row.objectApiName, row.sourceId, row.targetId, row.outcome]),
  ]);
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
