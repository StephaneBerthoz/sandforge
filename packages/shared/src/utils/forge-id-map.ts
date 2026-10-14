import type { ForgeExecutionResult } from '../types/forge.types.js';

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
 *
 * The results page writes the file of a run its history entry holds the ids
 * of; the extension writes the file of a run whose ids are in its journal,
 * read from there. One function, so the two files read the same.
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

/** The first line of the Id map's file. */
const ID_MAP_HEADER = ['Object', 'Source Id', 'Target Id', 'Outcome'];

/**
 * Rows of the Id map as lines of its file, without the header: what a file
 * written a piece at a time adds after it.
 */
export function idMapCsvLines(rows: readonly IdMapRow[]): string {
  return rows
    .map((row) =>
      [row.objectApiName, row.sourceId, row.targetId, row.outcome].map(csvCell).join(','),
    )
    .join('\n');
}

/** The Id map as a CSV file: object, source id, target id, outcome. */
export function idMapCsv(rows: readonly IdMapRow[]): string {
  const header = ID_MAP_HEADER.map(csvCell).join(',');
  return rows.length > 0 ? `${header}\n${idMapCsvLines(rows)}` : header;
}
