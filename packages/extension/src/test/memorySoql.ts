/**
 * The SOQL the memory org of the tests reads (`MemoryRemovalOrg`): one
 * object, its columns or `COUNT()`, a WHERE clause of comparisons under AND,
 * OR and parentheses, `ORDER BY` and `LIMIT`. Anything else throws, so a
 * statement it cannot read never passes for one that selects nothing.
 *
 * It compares as the org does where a checkpoint depends on it:
 *
 * - an id against an id by its first fifteen characters, as the org takes
 *   either length;
 * - a date-time literal to the second: the org drops a literal's
 *   milliseconds (`< …:04.500Z` counts what `< …:04Z` counts) and honours
 *   its offset, so `SystemModstamp < T` and `>= T` split the recycle bin
 *   exactly, as they did on a scratch org's 5,446 deleted records;
 * - `!=` keeps the rows whose field is empty, `<` and `>` never do;
 * - ascending order puts empty values first, descending last.
 *
 * Lives under `src/test/`: a helper, not a suite.
 */

/** A row as the memory org holds it, field by field. */
export type SoqlRow = Readonly<Record<string, unknown>>;

/** A statement the memory org reads. */
export interface SoqlStatement {
  /** The object it reads from. */
  readonly object: string;
  /** The columns it names, or `null` for `SELECT COUNT()`. */
  readonly columns: readonly string[] | null;
  /** Whether a row is selected. */
  readonly where: (row: SoqlRow) => boolean;
  /** The fields its rows are ordered by, the first deciding first. */
  readonly orderBy: ReadonlyArray<{ readonly field: string; readonly descending: boolean }>;
  /** The most rows it answers. */
  readonly limit?: number;
}

/** A literal of a WHERE clause, typed as the org reads it. */
type Literal =
  | { kind: 'null' }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'number'; value: number }
  | { kind: 'dateTime'; ms: number }
  | { kind: 'date'; value: string }
  | { kind: 'string'; value: string };

/** One record id or the other length of it: what the org reads as an id. */
const ID_SHAPE = /^[a-zA-Z0-9]{15}(?:[a-zA-Z0-9]{3})?$/;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const NUMBER = /^-?\d+(?:\.\d+)?$/;
const IDENTIFIER = /^[A-Za-z_]\w*$/;
const TOKENS =
  /'(?:[^'\\]|\\.)*'|\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})|\d{4}-\d{2}-\d{2}|-?\d+(?:\.\d+)?|!=|<>|<=|>=|[=<>(),]|[A-Za-z_][\w.]*|\S/g;

/** A row's value as a date-time, in ms, or NaN when it is none. */
function dateTimeOf(value: unknown): number {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value)
    ? Date.parse(value)
    : Number.NaN;
}

/**
 * How a row's value stands to a literal: below, equal, above, or not
 * comparable (an empty value, or one of another kind).
 */
function standing(value: unknown, literal: Exclude<Literal, { kind: 'null' }>): number {
  if (value === null || value === undefined) return Number.NaN;
  switch (literal.kind) {
    case 'boolean':
      return value === literal.value || String(value) === String(literal.value) ? 0 : Number.NaN;
    case 'number': {
      const held = Number(value);
      return Number.isFinite(held) ? Math.sign(held - literal.value) : Number.NaN;
    }
    case 'dateTime': {
      const held = dateTimeOf(value);
      return Number.isFinite(held) ? Math.sign(held - literal.ms) : Number.NaN;
    }
    case 'date': {
      const held = String(value).slice(0, 10);
      return held < literal.value ? -1 : held > literal.value ? 1 : 0;
    }
    case 'string': {
      const text = String(value);
      const [held, wanted] =
        ID_SHAPE.test(text) && ID_SHAPE.test(literal.value)
          ? [text.slice(0, 15), literal.value.slice(0, 15)]
          : [text, literal.value];
      return held < wanted ? -1 : held > wanted ? 1 : 0;
    }
  }
}

/** Whether a row's `value` passes `operator` against `literal`. */
function passes(value: unknown, operator: string, literal: Literal): boolean {
  if (literal.kind === 'null') {
    const empty = value === null || value === undefined;
    return operator === '=' ? empty : !empty;
  }
  const at = standing(value, literal);
  switch (operator) {
    case '=':
      return at === 0;
    case '!=':
      return at !== 0;
    case '<':
      return at < 0;
    case '<=':
      return at <= 0;
    case '>':
      return at > 0;
    case '>=':
      return at >= 0;
    default:
      throw new Error(`Unsupported operator ${operator}`);
  }
}

/** A text as `=` compares it: an id by its first fifteen characters. */
function comparedText(text: string): string {
  return ID_SHAPE.test(text) ? text.slice(0, 15) : text;
}

/**
 * Whether a value is one of `values`, as `IN` reads it. A list of texts —
 * the 200 ids of a read by id, run over every row of a large object — is
 * looked up, not compared one by one.
 */
function amongOf(values: readonly Literal[]): (value: unknown) => boolean {
  if (values.every((value) => value.kind === 'string')) {
    const texts = new Set(values.map((value) => comparedText((value as { value: string }).value)));
    return (value) =>
      value !== null && value !== undefined && texts.has(comparedText(String(value)));
  }
  return (value) => values.some((literal) => passes(value, '=', literal));
}

/** How two values of an ORDER BY field stand, empty values first. */
function ordering(a: unknown, b: unknown): number {
  const emptyA = a === null || a === undefined;
  const emptyB = b === null || b === undefined;
  if (emptyA || emptyB) return emptyA === emptyB ? 0 : emptyA ? -1 : 1;
  const [dateA, dateB] = [dateTimeOf(a), dateTimeOf(b)];
  if (Number.isFinite(dateA) && Number.isFinite(dateB)) return Math.sign(dateA - dateB);
  if (typeof a === 'number' && typeof b === 'number') return Math.sign(a - b);
  const [textA, textB] = [String(a), String(b)];
  return textA < textB ? -1 : textA > textB ? 1 : 0;
}

/**
 * Read `soql` as the memory org does: see the module's comment.
 *
 * @throws Error when the statement is not one this reader understands.
 */
export function parseSoql(soql: string): SoqlStatement {
  const tokens = soql.match(TOKENS) ?? [];
  let at = 0;
  const peek = (): string | undefined => tokens[at];
  const keyword = (word: string): boolean => peek()?.toUpperCase() === word;
  const take = (): string => {
    const token = tokens[at++];
    if (token === undefined) throw new Error(`Statement ends too early: ${soql}`);
    return token;
  };
  const expect = (wanted: string): void => {
    const token = take();
    if (token.toUpperCase() !== wanted) {
      throw new Error(`Expected ${wanted}, found ${token}: ${soql}`);
    }
  };
  const identifier = (): string => {
    const token = take();
    if (!IDENTIFIER.test(token)) {
      throw new Error(`Not a field the fake org reads: ${token}: ${soql}`);
    }
    return token;
  };
  const literal = (): Literal => {
    const token = take();
    const word = token.toLowerCase();
    if (word === 'null') return { kind: 'null' };
    if (word === 'true' || word === 'false') return { kind: 'boolean', value: word === 'true' };
    if (token.startsWith("'")) {
      return { kind: 'string', value: token.slice(1, -1).replace(/\\(.)/g, '$1') };
    }
    // The org drops the milliseconds of a date-time literal and honours its offset.
    if (DATE_TIME.test(token))
      return { kind: 'dateTime', ms: Math.floor(Date.parse(token) / 1000) * 1000 };
    if (DATE.test(token)) return { kind: 'date', value: token };
    if (NUMBER.test(token)) return { kind: 'number', value: Number(token) };
    throw new Error(`Not a value the fake org reads: ${token}: ${soql}`);
  };

  type RowTest = (row: SoqlRow) => boolean;
  const term = (): RowTest => {
    if (peek() === '(') {
      take();
      const inner = anyOf();
      expect(')');
      return inner;
    }
    const field = identifier();
    let operator = take().toUpperCase();
    if (operator === 'NOT') {
      expect('IN');
      operator = 'NOT IN';
    }
    if (operator === 'IN' || operator === 'NOT IN') {
      expect('(');
      const values: Literal[] = [literal()];
      while (peek() === ',') {
        take();
        values.push(literal());
      }
      expect(')');
      const among = amongOf(values);
      return operator === 'IN' ? (row) => among(row[field]) : (row) => !among(row[field]);
    }
    if (!['=', '!=', '<>', '<', '<=', '>', '>='].includes(operator)) {
      throw new Error(`Unsupported operator ${operator}: ${soql}`);
    }
    const compared = literal();
    const normalised = operator === '<>' ? '!=' : operator;
    if (
      (compared.kind === 'null' || compared.kind === 'boolean') &&
      !['=', '!='].includes(normalised)
    ) {
      throw new Error(`The org compares ${compared.kind} with = and != only: ${soql}`);
    }
    return (row) => passes(row[field], normalised, compared);
  };
  const allOf = (): RowTest => {
    const tests = [term()];
    while (keyword('AND')) {
      take();
      tests.push(term());
    }
    return (row) => tests.every((test) => test(row));
  };
  const anyOf = (): RowTest => {
    const tests = [allOf()];
    while (keyword('OR')) {
      take();
      tests.push(allOf());
    }
    return (row) => tests.some((test) => test(row));
  };

  expect('SELECT');
  let columns: string[] | null;
  if (keyword('COUNT')) {
    take();
    expect('(');
    expect(')');
    columns = null;
  } else {
    columns = [identifier()];
    while (peek() === ',') {
      take();
      columns.push(identifier());
    }
  }
  expect('FROM');
  const object = identifier();
  let where: RowTest = () => true;
  if (keyword('WHERE')) {
    take();
    where = anyOf();
  }
  const orderBy: Array<{ field: string; descending: boolean }> = [];
  if (keyword('ORDER')) {
    take();
    expect('BY');
    do {
      if (peek() === ',') take();
      const field = identifier();
      let descending = false;
      if (keyword('ASC') || keyword('DESC')) descending = take().toUpperCase() === 'DESC';
      orderBy.push({ field, descending });
    } while (peek() === ',');
  }
  let limit: number | undefined;
  if (keyword('LIMIT')) {
    take();
    const count = take();
    if (!/^\d+$/.test(count)) throw new Error(`Not a limit: ${count}: ${soql}`);
    limit = Number(count);
  }
  if (at !== tokens.length) throw new Error(`Unread tail from ${tokens[at]}: ${soql}`);
  return { object, columns, where, orderBy, ...(limit === undefined ? {} : { limit }) };
}

/**
 * The rows of `rows` that `statement` selects, in its order, up to its limit:
 * the rows themselves, for the caller to take the columns it names from.
 */
export function selectFrom<T extends SoqlRow>(rows: readonly T[], statement: SoqlStatement): T[] {
  const selected = rows.filter((row) => statement.where(row));
  if (statement.orderBy.length > 0) {
    selected.sort((a, b) => {
      for (const { field, descending } of statement.orderBy) {
        const order = ordering(a[field], b[field]);
        if (order !== 0) return descending ? -order : order;
      }
      return 0;
    });
  }
  return statement.limit === undefined ? selected : selected.slice(0, statement.limit);
}
