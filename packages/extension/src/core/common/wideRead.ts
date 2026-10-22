/**
 * A read of an object too wide to name its every field in one query.
 *
 * jsforce sends a query over GET, with the statement percent-encoded into
 * `?q=`, and Salesforce refuses a request whose URI is too long: 414, URI Too
 * Long, or — run against a scratch org — 431, Request Header Fields Too Large,
 * for a statement of 15 487 characters where one of 15 271 was answered. A
 * field costs its name and the `%2C%20` between two names: at some twenty
 * characters a name, a statement naming more than about five hundred and
 * fifty fields cannot be sent at all, and an Account of an Unlimited Edition
 * org takes up to eight hundred custom fields. A read that named them all was
 * refused before it read a row — Forge's root read with the status, its reads
 * by id with an error that told the user to exclude fields it read all the
 * same, Sync's and DataOps' with the status again.
 *
 * Past a budget, the fields are read in column groups instead: the statement
 * as written, with its WHERE, its order and its LIMIT, naming the first group;
 * then each other group by the ids that read returned, merged by id into its
 * rows. The rows are the statement's, in its order, with every field it names.
 * A statement whose fields fit is sent as it is written.
 */

/**
 * Longest statement, measured as it travels in the request URI, that a read
 * sends. A scratch org refused one of 15 487 characters, and answered one of
 * 15 271, the headers of the request counted in what it takes: the budget was
 * 15 800, which a scoped read of hundreds of ids reached. Encoding is what
 * makes a list expensive: `'001...AAA', ` is 22 characters in the statement
 * and 26 in the URI, where the comma and the space are encoded and the quotes
 * are not. The budget leaves room for the API path in front of the query, the
 * request's headers and the ` LIMIT N` a per-object cap appends after it.
 */
export const MAX_STATEMENT_URI_CHARS = 14_000;

/**
 * Longest select list, URI-encoded, one statement names: past it, a read
 * names its fields in groups of at most this many characters. Half the
 * budget: a statement naming them keeps 7 000 characters for its WHERE — some
 * two hundred and sixty ids — and the other groups, read by id, as many.
 */
export const MAX_SELECT_URI_CHARS = 7_000;

/** Most ids one statement reading a group of columns by id names. */
const IDS_PER_STATEMENT = 500;

/** A field of a select list: a name, or a path through relationships to one. */
const FIELD_PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;

/** A record id, 15 or 18 letters and digits. */
const RECORD_ID = /^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/;

/** Characters `text` occupies once percent-encoded into a query URI. */
export function uriLength(text: string): number {
  return encodeURIComponent(text).length;
}

/** Whether `field` is the id, however it is cased. */
function isId(field: string): boolean {
  return field.toLowerCase() === 'id';
}

/**
 * The groups a read names `fields` in: `fields` itself when its select list
 * fits {@link MAX_SELECT_URI_CHARS}, otherwise groups that each fit, the id
 * first in every one of them — it is what their rows are merged by.
 */
export function columnGroups(fields: readonly string[]): string[][] {
  if (uriLength(fields.join(', ')) <= MAX_SELECT_URI_CHARS) return [[...fields]];
  const separator = uriLength(', ');
  const idOnly = uriLength('Id');
  const groups: string[][] = [];
  let group = ['Id'];
  let length = idOnly;
  for (const field of fields) {
    if (isId(field)) continue;
    const cost = separator + uriLength(field);
    if (group.length > 1 && length + cost > MAX_SELECT_URI_CHARS) {
      groups.push(group);
      group = ['Id'];
      length = idOnly;
    }
    group.push(field);
    length += cost;
  }
  if (group.length > 1 || groups.length === 0) groups.push(group);
  return groups;
}

/**
 * The fields the first statement of a read of `fields` names: what a builder
 * measures a statement's WHERE against, so that the statement sent fits the
 * URI whatever the width of the object.
 */
export function firstColumns(fields: readonly string[]): string[] {
  return columnGroups(fields)[0] ?? [];
}

/** A statement read in column groups: see {@link wideStatement}. */
export interface WideStatement {
  /** The object read. */
  objectApiName: string;
  /** The statement as written, naming the first group of its fields. */
  first: string;
  /** The other groups, each read by the ids the first returned. */
  others: string[][];
}

/**
 * The statement `soql` is read as when its fields do not fit one query, or
 * `undefined` when it is sent as written: its select list fits, or it is not
 * a list of field names — a `FIELDS()`, a `COUNT()`, a function or a
 * sub-query is never split.
 */
export function wideStatement(soql: string): WideStatement | undefined {
  const parts = /^\s*SELECT\s+([\s\S]+?)\s+FROM\s+([A-Za-z][A-Za-z0-9_]*)(\s[\s\S]*)?$/i.exec(soql);
  if (!parts) return undefined;
  const [, select, objectApiName, rest = ''] = parts;
  const fields = select.split(',').map((field) => field.trim());
  if (!fields.every((field) => FIELD_PATH.test(field))) return undefined;
  const groups = columnGroups(fields);
  if (groups.length < 2) return undefined;
  const [first, ...others] = groups;
  return {
    objectApiName,
    first: `SELECT ${first.join(', ')} FROM ${objectApiName}${rest}`,
    others,
  };
}

/** Whether `value` is an object a relationship's fields come back in, rather than a value. */
function isNested(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Lay the fields `more` read of a row over the row: a related record read
 * through two groups — `Owner.Name` in one, `Owner.Email` in the other — keeps
 * the fields of both. The answer's own `attributes` stay the first read's.
 */
function mergeInto(row: Record<string, unknown>, more: Record<string, unknown>): void {
  for (const [field, value] of Object.entries(more)) {
    if (field === 'attributes') continue;
    const held = row[field];
    if (isNested(held) && isNested(value)) mergeInto(held, value);
    else row[field] = value;
  }
}

/**
 * The statements that read `group` of `objectApiName` for `ids`, as many as
 * the URI and {@link IDS_PER_STATEMENT} take.
 */
function byIdStatements(objectApiName: string, group: readonly string[], ids: string[]): string[] {
  const prefix = `SELECT ${group.join(', ')} FROM ${objectApiName} WHERE Id IN (`;
  const frame = uriLength(`${prefix})`);
  const separator = uriLength(', ');
  const statements: string[] = [];
  let list: string[] = [];
  let length = frame;
  const flush = (): void => {
    statements.push(`${prefix}${list.join(', ')})`);
    list = [];
    length = frame;
  };
  for (const id of ids) {
    const value = `'${id}'`;
    const full =
      length + separator + uriLength(value) > MAX_STATEMENT_URI_CHARS ||
      list.length >= IDS_PER_STATEMENT;
    if (list.length > 0 && full) flush();
    length += (list.length > 0 ? separator : 0) + uriLength(value);
    list.push(value);
  }
  if (list.length > 0) flush();
  return statements;
}

/**
 * Read the groups of columns after the first for `rows`, the rows the first
 * statement of `wide` returned, by their ids, and merge them into the rows.
 * A row the org no longer answers for keeps the fields the first read gave.
 *
 * @param read - Runs one statement and answers with its rows.
 * @returns `rows`, each with every field the statement names.
 */
export async function readOtherColumns<T extends Record<string, unknown>>(
  rows: T[],
  wide: WideStatement,
  read: (statement: string) => Promise<Array<Record<string, unknown>>>,
): Promise<T[]> {
  // By the id as the org wrote it: both reads come from the same API, which
  // writes every id at eighteen characters.
  const byId = new Map<string, Record<string, unknown>>();
  for (const row of rows) {
    const id = row['Id'];
    if (typeof id === 'string' && RECORD_ID.test(id) && !byId.has(id)) byId.set(id, row);
  }
  const ids = [...byId.keys()];
  if (ids.length === 0) return rows;
  for (const group of wide.others) {
    for (const statement of byIdStatements(wide.objectApiName, group, ids)) {
      for (const more of await read(statement)) {
        const id = more['Id'];
        const row = typeof id === 'string' ? byId.get(id) : undefined;
        if (row) mergeInto(row, more);
      }
    }
  }
  return rows;
}

/**
 * Every row `soql` selects, with every field it names: as written when its
 * fields fit one query, otherwise in column groups (see the file header).
 *
 * @param read - Runs one statement and answers with its rows: the first
 *   statement with the caller's bounds, those by id with at most
 *   {@link IDS_PER_STATEMENT} rows each.
 */
export async function readColumnsApart<T extends Record<string, unknown>>(
  soql: string,
  read: (statement: string) => Promise<T[]>,
): Promise<T[]> {
  const wide = wideStatement(soql);
  if (!wide) return read(soql);
  return readOtherColumns(await read(wide.first), wide, read);
}

/**
 * The pages of `soql`, each with every field the statement names: as written
 * when its fields fit one query; otherwise its first group of columns page by
 * page, each page given the other groups by its ids before it is handed on.
 *
 * @param pages - The pages of one statement, as the org's cursor answers it.
 * @param read - Runs one statement whole: the reads of the other groups.
 */
export async function* pagesColumnsApart<T extends Record<string, unknown>>(
  soql: string,
  pages: (statement: string) => AsyncIterable<T[]>,
  read: (statement: string) => Promise<Array<Record<string, unknown>>>,
): AsyncGenerator<T[]> {
  const wide = wideStatement(soql);
  if (!wide) {
    yield* pages(soql);
    return;
  }
  for await (const page of pages(wide.first)) {
    yield await readOtherColumns(page, wide, read);
  }
}
