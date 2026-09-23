/**
 * A source org in miniature for scoped-read tests: rows per object, and the
 * rows a scoped statement selects from them.
 *
 * Asserting on the text of a scoped query says what was asked, not what came
 * back. A row the scope leaves out shows up here as a record missing from the
 * clone, which is how it showed up in a real one: a contact created by a
 * second user was dropped by a filter on `CreatedById` that no test had read
 * as a filter.
 *
 * It reads what the scoped reads write, and only that: `Field IN ('a', …)`
 * and `Field = 'a'` terms — or a bare literal, `IsStandard = true` — under
 * AND, OR and parentheses, then an optional `LIMIT`. Anything else throws, so
 * a statement it cannot read never passes for one that selects nothing.
 *
 * Lives under `src/test/` with no `.test.ts` suffix: a helper, not a suite.
 */

/** A row of the fake org, field by field. */
export type FakeRow = Record<string, string | boolean | null>;

/** Whether a row matches. */
type RowTest = (row: FakeRow) => boolean;

/**
 * The rows of `tables` that `soql` selects, in table order, up to its LIMIT.
 * Each row comes back whole, as a copy.
 *
 * @throws Error when the statement is not one this reader understands.
 */
export function selectRows(
  tables: Readonly<Record<string, readonly FakeRow[]>>,
  soql: string,
): FakeRow[] {
  const statement = /^SELECT .+? FROM (\w+) WHERE (.+?)(?: LIMIT (\d+))?$/.exec(soql);
  if (!statement) throw new Error(`Not a statement the fake org reads: ${soql}`);
  const [, object, where, limit] = statement;
  const tokens = where.match(/'(?:[^'\\]|\\.)*'|[(),=]|\w+/g) ?? [];
  let at = 0;

  const take = (): string => {
    const token = tokens[at++];
    if (token === undefined) throw new Error(`Statement ends too early: ${soql}`);
    return token;
  };
  const expect = (wanted: string): void => {
    const token = take();
    if (token !== wanted) throw new Error(`Expected ${wanted}, found ${token}: ${soql}`);
  };
  const literal = (token: string): string =>
    token.startsWith("'") ? token.slice(1, -1).replace(/\\(.)/g, '$1') : token;

  const term = (): RowTest => {
    if (tokens[at] === '(') {
      take();
      const inner = anyOf();
      expect(')');
      return inner;
    }
    const field = take();
    const operator = take();
    const values: string[] = [];
    if (operator === 'IN') {
      expect('(');
      for (let token = take(); token !== ')'; token = take()) {
        if (token !== ',') values.push(literal(token));
      }
    } else if (operator === '=') {
      values.push(literal(take()));
    } else {
      throw new Error(`Unsupported operator ${operator}: ${soql}`);
    }
    return (row) => values.includes(String(row[field]));
  };
  const allOf = (): RowTest => {
    const tests = [term()];
    while (tokens[at] === 'AND') {
      take();
      tests.push(term());
    }
    return (row) => tests.every((test) => test(row));
  };
  const anyOf = (): RowTest => {
    const tests = [allOf()];
    while (tokens[at] === 'OR') {
      take();
      tests.push(allOf());
    }
    return (row) => tests.some((test) => test(row));
  };

  const matches = anyOf();
  if (at !== tokens.length) throw new Error(`Unread tail from ${tokens[at]}: ${soql}`);
  const rows = (tables[object] ?? []).filter(matches).map((row) => ({ ...row }));
  return limit === undefined ? rows : rows.slice(0, Number(limit));
}
