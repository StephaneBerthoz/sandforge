/**
 * The CSV a Bulk API 2.0 ingest job is sent, and how each of its rows is found
 * again in the job's results.
 *
 * Handed records, jsforce writes the CSV header from the FIRST record's fields
 * alone (csv-stringify infers its columns from the first object). A Frozen
 * load leaves the empty values out of its rows, so its rows do not carry the
 * same fields. Run on a real target with 250 products whose first row named
 * two fields: the target created all 250, without the description, product
 * code, quantity, date and checkboxes the other rows carried, and 249 of them
 * came back "No result returned by Bulk API job" — the results echo the
 * header's columns, and a row whose fields differed from it matched none of
 * them — so their ids were lost: never mapped, never removable. Sync and Seed
 * write through the same path, and an update lost its fields the same way.
 *
 * Built here, the header names every field any row carries, and a row that
 * does not carry one leaves its cell empty. Salesforce reads an empty cell as
 * no value at all: "Empty field values are ignored when you update records. To
 * set a field value to null, use a field value of #N/A" (Bulk API 2.0 and Bulk
 * API Developer Guide, "Prepare CSV Files", which both APIs share), and an
 * insert gives the field its default, as when the field is not sent. Run on
 * the same target: a checkbox left empty was created with its default, as the
 * rows without the column were, and an update whose rows carried different
 * fields left every field a row did not carry as it was. No batch has to be
 * split by the fields its rows carry.
 */

import { canonicalRecordId } from '../common/existingRecordMatch.js';
import type { BulkOperation } from './BulkApiExecutor.js';

/** The cell that sets a field to null, as jsforce sends a null value. */
export const BULK_NULL_CELL = '#N/A';

/** What an ingest job is sent: its CSV, and the cells each row went with. */
export interface BulkCsv {
  /** The CSV: the header, then one line per row, each ended by LF, the job's default. */
  readonly text: string;
  /** The header's fields, in the order the rows first named them. */
  readonly columns: readonly string[];
  /** Per input record, in order, its cell under each column: '' where it carries no value. */
  readonly rows: readonly (readonly string[])[];
  /** The columns whose cells identify a row in the job's results: see {@link buildBulkCsv}. */
  readonly identity: readonly number[];
}

/**
 * The CSV of one ingest job: a header naming every field any record carries,
 * then each record's cells.
 *
 * Shaped as jsforce shaped a job's records: `attributes` and `type` are left
 * out, an insert sends no `Id`, a delete sends nothing but it, a null is
 * `#N/A`, a related record's fields are columns of their own
 * (`Account.External__c`). A field named in two cases is one column — the
 * platform reads field names without case, and a header naming one field
 * twice is refused, job and all — named as the first row named it.
 *
 * `identity` is the column a row is found by in the results: the `Id` of an
 * update or a delete, the external id of an upsert, every column of an insert.
 *
 * @param operation - The job's operation.
 * @param records - The records, in the order their outcomes are expected.
 * @param externalIdField - The external id an upsert matches records on.
 */
export function buildBulkCsv(
  operation: BulkOperation,
  records: readonly Record<string, unknown>[],
  externalIdField?: string,
): BulkCsv {
  const columns: string[] = [];
  const columnOf = new Map<string, number>();
  const sent = records.map((record) => {
    const cells = new Map<number, string>();
    for (const [field, value] of fieldsOf(operation, record)) {
      const name = field.toLowerCase();
      let column = columnOf.get(name);
      if (column === undefined) {
        column = columns.push(field) - 1;
        columnOf.set(name, column);
      }
      cells.set(column, cellOf(value));
    }
    return cells;
  });
  const rows = sent.map((cells) => columns.map((_, column) => cells.get(column) ?? ''));
  const lines = [columns.map(csvField).join(',')];
  for (const row of rows) {
    // A line with nothing on it is no row: the one empty cell is quoted.
    lines.push(row.length === 1 && row[0] === '' ? '""' : row.map(csvField).join(','));
  }
  return {
    text: `${lines.join('\n')}\n`,
    columns,
    rows,
    identity: identityOf(operation, columns, externalIdField),
  };
}

/**
 * How a cell is compared with what the results echo of it: as sent, or in
 * the form the platform may write it back in.
 */
export type CellMatch = 'exact' | 'canonical';

/**
 * The key a row is found by in the job's results: its identifying cells,
 * compared as `match` says. Computed alike for an uploaded row
 * ({@link BulkCsv.rows}) and for a result row ({@link resultCells}).
 */
export function rowKey(
  cells: readonly string[],
  identity: readonly number[],
  match: CellMatch,
): string {
  const form = match === 'exact' ? exactCell : canonicalCell;
  return JSON.stringify(identity.map((column) => form(cells[column] ?? '')));
}

/**
 * A result row's cells under the uploaded columns. A job's results echo every
 * column it was sent, beside its own `sf__` ones.
 */
export function resultCells(
  columns: readonly string[],
  row: Readonly<Record<string, unknown>>,
): string[] {
  return columns.map((column) => {
    const value = row[column];
    if (typeof value === 'string') return value;
    return value === null || value === undefined ? '' : String(value);
  });
}

/** The fields a record is sent with, related records' fields flattened. */
function fieldsOf(
  operation: BulkOperation,
  record: Readonly<Record<string, unknown>>,
): Array<[string, unknown]> {
  if (operation === 'delete' || operation === 'hardDelete') return [['Id', record['Id']]];
  const fields: Array<[string, unknown]> = [];
  for (const [field, value] of Object.entries(record)) {
    if (field === 'attributes' || field === 'type') continue;
    if (operation === 'insert' && field.toLowerCase() === 'id') continue;
    flatten(field, value, fields);
  }
  return fields;
}

/** A value, or each field of a related record under `path.field`. */
function flatten(path: string, value: unknown, into: Array<[string, unknown]>): void {
  if (!isPlainObject(value)) {
    into.push([path, value]);
    return;
  }
  for (const [field, nested] of Object.entries(value)) {
    if (field !== 'attributes') flatten(`${path}.${field}`, nested, into);
  }
}

/** True for an object literal, as a related record is: not an array, not a date. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** The text of one cell: '' for no value, `#N/A` for null. */
function cellOf(value: unknown): string {
  if (value === undefined) return '';
  if (value === null) return BULK_NULL_CELL;
  if (typeof value === 'string') return value;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? '' : value.toISOString();
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/** A field as RFC 4180 writes it: quoted when it holds a comma, a quote or a line break. */
function csvField(text: string): string {
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/** The column a row is found by, or every column when the job has no key of its own. */
function identityOf(
  operation: BulkOperation,
  columns: readonly string[],
  externalIdField: string | undefined,
): number[] {
  const key = operation === 'insert' ? undefined : operation === 'upsert' ? externalIdField : 'Id';
  const column =
    key === undefined ? -1 : columns.findIndex((c) => c.toLowerCase() === key.toLowerCase());
  return column >= 0 ? [column] : columns.map((_, i) => i);
}

/**
 * A cell as the results echo it whatever its field: a null sent as `#N/A`
 * comes back empty, and a line break as LF. Run on a real target, both did.
 */
function exactCell(cell: string): string {
  return cell === BULK_NULL_CELL ? '' : cell.replace(/\r\n?/g, '\n');
}

const NUMBER_RE = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;
const DATE_TIME_RE =
  /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

/**
 * A cell in the form the platform writes it back in. The results echo a value
 * as the field read it, not as it was sent — run on a real target, a quantity
 * sent as `3` came back `3.0`, `1.50` as `1.5`, `1e2` as `100.0`, `TRUE` as
 * `true`, `2026-10-02T10:00:00Z` as `2026-10-02T10:00:00.000Z`, and a date and
 * time as a query reads it, `2026-10-02T10:00:00.000+0200`, as
 * `2026-10-02T08:00:00.000Z` — so a row carrying a number, a checkbox or a
 * date matched no result on its text. A text field is echoed as sent, spaces
 * included. Numbers are compared as numbers, checkboxes without case, dates
 * and times as instants (one without a zone as UTC, as the platform read
 * `2026-10-02T10:00:00`), and a record id in its 18-character form.
 */
function canonicalCell(cell: string): string {
  const text = exactCell(cell);
  const lower = text.toLowerCase();
  if (lower === 'true' || lower === 'false') return lower;
  if (NUMBER_RE.test(text)) return String(Number(text));
  const dateTime = DATE_TIME_RE.exec(text);
  if (dateTime) {
    const zoneless = text.includes('T') && dateTime[1] === undefined;
    const instant = Date.parse(zoneless ? `${text}Z` : text);
    if (!Number.isNaN(instant)) return `@${instant}`;
  }
  return canonicalRecordId(text) ?? text;
}
