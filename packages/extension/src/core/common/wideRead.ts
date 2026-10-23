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
 *
 * Two groups are two reads, and a record written between them comes back
 * with columns of two writes, merged into one row as if one write had left
 * them; one deleted between them keeps the columns the first read gave. A
 * read that must hold each row as one write left it — a checkpoint's, whose
 * rewind compares every value it holds with the org's — carries the record's
 * stamp in every group, reads again the rows whose stamps disagree, and drops
 * those a later group no longer finds ({@link readOtherColumnsAtOneStamp}).
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

/**
 * The columns every group of a read names first: the id, which the rows of
 * the groups are merged by, then each of `carried` once.
 */
function headOf(carried: readonly string[]): string[] {
  const head = ['Id'];
  const named = new Set(['id']);
  for (const column of carried) {
    if (named.has(column.toLowerCase())) continue;
    named.add(column.toLowerCase());
    head.push(column);
  }
  return head;
}

/**
 * The groups a read names `fields` in: `fields` itself when its select list
 * fits {@link MAX_SELECT_URI_CHARS}, otherwise groups that each fit, the id
 * first in every one of them — it is what their rows are merged by — and
 * the `carried` columns after it.
 *
 * @param carried - The columns every group names, the id unless given: a
 *   read that holds each row to one write carries the record's stamp too.
 */
export function columnGroups(
  fields: readonly string[],
  carried: readonly string[] = ['Id'],
): string[][] {
  if (uriLength(fields.join(', ')) <= MAX_SELECT_URI_CHARS) return [[...fields]];
  const head = headOf(carried);
  const inHead = new Set(head.map((column) => column.toLowerCase()));
  const separator = uriLength(', ');
  const headLength = uriLength(head.join(', '));
  const groups: string[][] = [];
  let group = [...head];
  let length = headLength;
  for (const field of fields) {
    if (inHead.has(field.toLowerCase())) continue;
    const cost = separator + uriLength(field);
    if (group.length > head.length && length + cost > MAX_SELECT_URI_CHARS) {
      groups.push(group);
      group = [...head];
      length = headLength;
    }
    group.push(field);
    length += cost;
  }
  if (group.length > head.length || groups.length === 0) groups.push(group);
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
  /** The columns of the first group: what a row read again by its id names first. */
  firstGroup: string[];
  /** The other groups, each read by the ids the first returned. */
  others: string[][];
}

/**
 * The statement `soql` is read as when its fields do not fit one query, or
 * `undefined` when it is sent as written: its select list fits, or it is not
 * a list of field names — a `FIELDS()`, a `COUNT()`, a function or a
 * sub-query is never split.
 *
 * @param carried - The columns every group names (`columnGroups`).
 */
export function wideStatement(
  soql: string,
  carried?: readonly string[],
): WideStatement | undefined {
  const parts = /^\s*SELECT\s+([\s\S]+?)\s+FROM\s+([A-Za-z][A-Za-z0-9_]*)(\s[\s\S]*)?$/i.exec(soql);
  if (!parts) return undefined;
  const [, select, objectApiName, rest = ''] = parts;
  const fields = select.split(',').map((field) => field.trim());
  if (!fields.every((field) => FIELD_PATH.test(field))) return undefined;
  const groups = columnGroups(fields, carried);
  if (groups.length < 2) return undefined;
  const [first, ...others] = groups;
  return {
    objectApiName,
    first: `SELECT ${first.join(', ')} FROM ${objectApiName}${rest}`,
    firstGroup: first,
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
 *
 * @param where - A term each statement holds its rows to beside their ids.
 */
function byIdStatements(
  objectApiName: string,
  group: readonly string[],
  ids: string[],
  where?: string,
): string[] {
  const held = where === undefined ? '' : `${where} AND `;
  const prefix = `SELECT ${group.join(', ')} FROM ${objectApiName} WHERE ${held}Id IN (`;
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

/** A record id as the API writes every one, eighteen characters: what a statement's room is measured with. */
const SAMPLE_ID = '001000000000000AAA';

/**
 * The most ids one statement reading `group` of `objectApiName` by id names,
 * as {@link readOtherColumns} writes it: {@link IDS_PER_STATEMENT}, or fewer
 * when the group's columns leave less of the URI to them. What an estimate
 * counts the reads of a wide object's other groups with.
 *
 * @param where - A term each statement holds its rows to beside their ids.
 */
export function idsPerStatement(
  objectApiName: string,
  group: readonly string[],
  where?: string,
): number {
  const ids = Array.from({ length: IDS_PER_STATEMENT }, () => SAMPLE_ID);
  const [first = ''] = byIdStatements(objectApiName, group, ids, where);
  return first.split(`'${SAMPLE_ID}'`).length - 1;
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

/** How {@link readOtherColumnsAtOneStamp} holds each row to one write. */
export interface OneStamp {
  /**
   * The column every group carries, which every write to a record moves:
   * `SystemModstamp`. The statement the groups were split from must carry it
   * ({@link wideStatement}'s `carried`).
   */
  stamp: string;
  /**
   * A term each read by id adds to its filter: `IsDeleted = false` for a read
   * that goes through the recycle bin and keeps to the live rows, where a
   * record deleted between two groups would otherwise be found in the bin.
   */
  idsWhere?: string;
  /**
   * How many times the rows a write moved between two groups are read again
   * before the read gives up: {@link REREADS} unless given.
   */
  rereads?: number;
}

/**
 * Times the rows written between two groups are read again. A row that a
 * write moves between its groups on every read, this many times in a row, is
 * one some process keeps writing: the read fails rather than hold it as no
 * write left it.
 */
const REREADS = 3;

/**
 * Read the other groups of `pending` by their ids, and merge each into its
 * row while its stamp is the one the first group read. A row the org no
 * longer answers for is taken out of `pending`: it was deleted since.
 *
 * @returns The ids of the rows a later group answered with another stamp:
 *   written since the first group was read, their columns left unmerged.
 */
async function mergeAtOneStamp(
  pending: Map<string, Record<string, unknown>>,
  wide: WideStatement,
  read: (statement: string) => Promise<Array<Record<string, unknown>>>,
  oneStamp: OneStamp,
): Promise<Set<string>> {
  const moved = new Set<string>();
  for (const group of wide.others) {
    const ids = [...pending.keys()].filter((id) => !moved.has(id));
    if (ids.length === 0) break;
    const found = new Set<string>();
    for (const statement of byIdStatements(wide.objectApiName, group, ids, oneStamp.idsWhere)) {
      for (const more of await read(statement)) {
        const id = more['Id'];
        const row = typeof id === 'string' ? pending.get(id) : undefined;
        if (typeof id !== 'string' || !row || found.has(id)) continue;
        found.add(id);
        if (more[oneStamp.stamp] !== row[oneStamp.stamp]) moved.add(id);
        else mergeInto(row, more);
      }
    }
    for (const id of ids) if (!found.has(id)) pending.delete(id);
  }
  return moved;
}

/**
 * {@link readOtherColumns}, each row held to one write. Every group carries
 * the record's stamp, and a row a later group answers with another stamp —
 * written between the two reads — is read again, every group of it, until
 * its groups agree: merged as it was, it would hold the values of two writes,
 * which the org never held together. A row the org no longer answers for, in
 * a later group or when it is read again, is dropped: it was deleted while it
 * was read, and kept with the columns of the first group alone it would hold
 * none of the others.
 *
 * Rows without a record id are kept as the first read gave them, as
 * {@link readOtherColumns} keeps them.
 *
 * @param rows - The rows the first statement of `wide` returned.
 * @param read - Runs one statement and answers with its rows.
 * @returns The rows kept, in the order of `rows`, a row read again in the
 *   place of the one first read.
 * @throws When rows were still written between two reads of their groups
 *   after being read again {@link OneStamp.rereads} times.
 */
export async function readOtherColumnsAtOneStamp<T extends Record<string, unknown>>(
  rows: T[],
  wide: WideStatement,
  read: (statement: string) => Promise<Array<Record<string, unknown>>>,
  oneStamp: OneStamp,
): Promise<T[]> {
  const rereads = oneStamp.rereads ?? REREADS;
  let pending = new Map<string, Record<string, unknown>>();
  for (const row of rows) {
    const id = row['Id'];
    if (typeof id === 'string' && RECORD_ID.test(id) && !pending.has(id)) pending.set(id, row);
  }
  const kept = new Map<string, Record<string, unknown>>();
  for (let reread = 0; pending.size > 0; reread++) {
    const moved = await mergeAtOneStamp(pending, wide, read, oneStamp);
    for (const [id, row] of pending) if (!moved.has(id)) kept.set(id, row);
    if (moved.size === 0) break;
    if (reread >= rereads) {
      throw new Error(
        `${moved.size} record(s) of ${wide.objectApiName} were written between two reads of ` +
          `their columns ${rereads + 1} times in a row: they could not be read as one write left them.`,
      );
    }
    const again = new Map<string, Record<string, unknown>>();
    for (const statement of byIdStatements(
      wide.objectApiName,
      wide.firstGroup,
      [...moved],
      oneStamp.idsWhere,
    )) {
      for (const row of await read(statement)) {
        const id = row['Id'];
        if (typeof id === 'string' && moved.has(id) && !again.has(id)) again.set(id, row);
      }
    }
    pending = again;
  }
  const held: T[] = [];
  for (const row of rows) {
    const id = row['Id'];
    if (typeof id !== 'string' || !RECORD_ID.test(id)) held.push(row);
    else {
      const whole = kept.get(id);
      if (whole) held.push(whole as T);
    }
  }
  return held;
}

/**
 * Every row `soql` selects, with every field it names: as written when its
 * fields fit one query, otherwise in column groups (see the file header).
 *
 * @param read - Runs one statement and answers with its rows: the first
 *   statement with the caller's bounds, those by id with at most
 *   {@link IDS_PER_STATEMENT} rows each.
 * @param oneStamp - Holds each row to one write
 *   ({@link readOtherColumnsAtOneStamp}): its stamp carried in every group,
 *   a row whose groups disagree read again, one a later group no longer
 *   finds dropped. Absent, the groups are merged as they were read.
 */
export async function readColumnsApart<T extends Record<string, unknown>>(
  soql: string,
  read: (statement: string) => Promise<T[]>,
  oneStamp?: OneStamp,
): Promise<T[]> {
  const wide = wideStatement(soql, oneStamp === undefined ? undefined : ['Id', oneStamp.stamp]);
  if (!wide) return read(soql);
  const first = await read(wide.first);
  return oneStamp === undefined
    ? readOtherColumns(first, wide, read)
    : readOtherColumnsAtOneStamp(first, wide, read, oneStamp);
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
