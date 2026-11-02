/**
 * The two CSV files SFDMU reads beside an export.json: `FieldMapping.csv`, for
 * an object with `useFieldMapping`, and `ValueMapping.csv`, for one with
 * `useValuesMapping`. A long mapping lives in them rather than in the export,
 * so reading the export alone dropped it, with no word.
 */

/** What SFDMU calls the file of field mappings. */
export const FIELD_MAPPING_FILE = 'FieldMapping.csv';

/** What SFDMU calls the file of value mappings. */
export const VALUE_MAPPING_FILE = 'ValueMapping.csv';

/** A row of `FieldMapping.csv`: no field, and `target` is the object it goes to. */
export interface FieldMappingRow {
  object: string;
  field: string;
  target: string;
}

/** A row of `ValueMapping.csv`. */
export interface ValueMappingRow {
  object: string;
  field: string;
  rawValue: string;
  value: string;
}

/**
 * The rows of a CSV text, each a list of cells: fields may be quoted, a quote
 * doubled inside them, line ends LF or CRLF, and an empty line is no row.
 */
function csvRows(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  const endCell = (): void => {
    row.push(cell);
    cell = '';
  };
  const endRow = (): void => {
    endCell();
    if (row.some((value) => value !== '')) rows.push(row);
    row = [];
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch !== '"') cell += ch;
      else if (text[i + 1] === '"') cell += text[++i];
      else quoted = false;
    } else if (ch === '"' && cell === '') {
      quoted = true;
    } else if (text.startsWith(delimiter, i)) {
      endCell();
      i += delimiter.length - 1;
    } else if (ch === '\n') {
      endRow();
    } else if (ch !== '\r') {
      cell += ch;
    }
  }
  endRow();
  return rows;
}

/**
 * The rows of a CSV text by the columns of its header.
 *
 * @returns Each row's value of each of `columns`, trimmed as SFDMU trims them,
 *   or `undefined` when the header lacks one of `required`.
 */
function rowsByColumn(
  text: string,
  delimiter: string,
  columns: readonly string[],
  required: readonly string[],
): Array<Record<string, string>> | undefined {
  const [header, ...rows] = csvRows(text.replace(/^\uFEFF/, ''), delimiter);
  const names = (header ?? []).map((name) => name.trim());
  if (required.some((name) => !names.includes(name))) return undefined;
  return rows.map((row) =>
    Object.fromEntries(
      columns.map((column) => [column, (row[names.indexOf(column)] ?? '').trim()]),
    ),
  );
}

/**
 * The mappings of a `FieldMapping.csv`, without the rows SFDMU skips, those
 * that name no object or no target.
 *
 * @param text - The file's content.
 * @param delimiter - The delimiter the export sets for its CSV files.
 * @returns The rows, or `undefined` when these are not that file's columns.
 */
export function readFieldMappingRows(
  text: string,
  delimiter: string,
): FieldMappingRow[] | undefined {
  const rows = rowsByColumn(
    text,
    delimiter,
    ['ObjectName', 'FieldName', 'Target'],
    ['ObjectName', 'Target'],
  );
  return rows
    ?.filter((row) => row.ObjectName !== '' && row.Target !== '')
    .map((row) => ({ object: row.ObjectName, field: row.FieldName, target: row.Target }));
}

/**
 * The mappings of a `ValueMapping.csv`, without the rows SFDMU skips, those
 * that name no object or no field.
 *
 * @param text - The file's content.
 * @param delimiter - The delimiter the export sets for its CSV files.
 * @returns The rows, or `undefined` when these are not that file's columns.
 */
export function readValueMappingRows(
  text: string,
  delimiter: string,
): ValueMappingRow[] | undefined {
  const columns = ['ObjectName', 'FieldName', 'RawValue', 'Value'];
  const rows = rowsByColumn(text, delimiter, columns, columns);
  return rows
    ?.filter((row) => row.ObjectName !== '' && row.FieldName !== '')
    .map((row) => ({
      object: row.ObjectName,
      field: row.FieldName,
      rawValue: row.RawValue,
      value: row.Value,
    }));
}
