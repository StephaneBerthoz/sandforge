/**
 * SOQL injection prevention utilities.
 *
 * Provides sanitization for string literal values and validation
 * for Salesforce API identifiers (object and field names) used
 * in dynamically built SOQL queries.
 */

/**
 * Pattern for valid Salesforce API names.
 * Must start with a letter, contain only alphanumeric characters and underscores,
 * and be at most 255 characters long. Allows namespace prefix (e.g. `ns__Field__c`).
 */
const SALESFORCE_API_NAME_REGEX = /^[a-zA-Z][a-zA-Z0-9_]{0,254}$/;

/**
 * One ORDER BY term: a field path (up to 5 relationship hops, SOQL's own
 * ceiling), an optional direction and an optional NULLS placement.
 */
const SOQL_ORDER_BY_TERM_REGEX =
  /^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*){0,5}(\s+(?:ASC|DESC))?(\s+NULLS\s+(?:FIRST|LAST))?$/i;

/** Max terms in one ORDER BY clause (SOQL itself allows 32). */
const SOQL_ORDER_BY_MAX_TERMS = 32;

/** Max length of an ORDER BY clause, mirroring the WHERE bound. */
const SOQL_ORDER_BY_MAX_LENGTH = 2000;

/** Max length of a WHERE clause (the bridge bound). */
const SOQL_WHERE_MAX_LENGTH = 2000;

/**
 * What may not appear in a WHERE clause outside its string literals. A WHERE
 * fragment is followed by whatever the builder appends, so each of these would
 * turn the filter into something else: a clause that ends the statement
 * (`LIMIT`, `OFFSET`, `ORDER BY`, `GROUP BY`, `HAVING`, `FOR`, `WITH`,
 * `ALL ROWS`), a subquery or DML keyword, a statement separator, or a comment
 * marker that would swallow the rest of the query.
 */
const SOQL_WHERE_FORBIDDEN: readonly RegExp[] = [
  /\bLIMIT\b/i,
  /\bOFFSET\b/i,
  /\bORDER\s+BY\b/i,
  /\bGROUP\s+BY\b/i,
  /\bHAVING\b/i,
  /\bFOR\b/i,
  /\bWITH\b/i,
  /\bALL\s+ROWS\b/i,
  /\bSELECT\b/i,
  /\bINSERT\b/i,
  /\bUPDATE\b/i,
  /\bDELETE\b/i,
  /;/,
  /--/,
  /\/\*/,
  /\*\//,
];

/**
 * Escape a string value for safe inclusion in a SOQL string literal.
 *
 * Escapes backslashes and single quotes so the value can be safely
 * interpolated inside single-quoted SOQL strings.
 *
 * @param value - The raw string value to sanitize.
 * @returns The escaped string, safe for use inside SOQL single quotes.
 *
 * @example
 * ```ts
 * const soql = `SELECT Id FROM Account WHERE Name = '${sanitizeSoqlValue(userInput)}'`;
 * ```
 */
export function sanitizeSoqlValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

/**
 * Check whether a string is a valid Salesforce API name.
 *
 * Valid names start with a letter, contain only alphanumeric characters
 * and underscores, and are at most 255 characters long.
 *
 * @param name - The identifier to validate.
 * @returns `true` if the name is a valid Salesforce API identifier.
 */
export function validateSoqlIdentifier(name: string): boolean {
  return SALESFORCE_API_NAME_REGEX.test(name);
}

/**
 * Check whether a string is a plain SOQL ORDER BY clause.
 *
 * Accepts a comma-separated list of field paths, each with an optional
 * `ASC`/`DESC` and an optional `NULLS FIRST`/`NULLS LAST`. A blank clause is
 * accepted: it adds no ordering and the builders skip it.
 *
 * @param clause - The ORDER BY clause to check.
 * @returns `true` if the clause is a sort specification and nothing else.
 */
export function isSafeSoqlOrderBy(clause: string): boolean {
  if (clause.trim().length === 0) return true;
  if (clause.length > SOQL_ORDER_BY_MAX_LENGTH) return false;
  const terms = clause.split(',');
  if (terms.length > SOQL_ORDER_BY_MAX_TERMS) return false;
  return terms.every((term) => SOQL_ORDER_BY_TERM_REGEX.test(term.trim()));
}

/**
 * Assert that a string is a sort specification and nothing else, then return it.
 *
 * An ORDER BY sits at the tail of the query, so whatever follows it is still
 * part of the statement: `Id ASC LIMIT 1` truncates the read, `Id ASC FOR
 * UPDATE` locks the rows it returned. Accepting only field paths, directions
 * and NULLS placement keeps the clause a sort order.
 *
 * @param clause - The ORDER BY clause to validate.
 * @returns The validated clause, unchanged.
 * @throws {Error} If the clause is not a plain list of sort terms.
 *
 * @example
 * ```ts
 * const soql = `SELECT Id FROM Account ORDER BY ${assertSoqlOrderBy(orderBy)}`;
 * ```
 */
export function assertSoqlOrderBy(clause: string): string {
  if (!isSafeSoqlOrderBy(clause)) {
    throw new Error(
      `Invalid SOQL ORDER BY clause: "${clause}". ` +
        'Only field names, optional ASC/DESC and optional NULLS FIRST/LAST are allowed ' +
        '(no LIMIT, OFFSET, FOR UPDATE or subquery).',
    );
  }
  return clause;
}

/**
 * The clause with the content of every single-quoted literal removed, or
 * `undefined` when a literal is never closed. Backslash escapes inside a
 * literal (`\'`, `\\`) are honoured, so `'O\'Brien'` is one literal.
 */
function withoutSoqlLiterals(clause: string): string | undefined {
  let outside = '';
  let inLiteral = false;
  for (let i = 0; i < clause.length; i++) {
    const ch = clause[i];
    if (inLiteral) {
      if (ch === '\\') {
        i++;
      } else if (ch === "'") {
        inLiteral = false;
        outside += "'";
      }
      continue;
    }
    if (ch === "'") inLiteral = true;
    outside += ch;
  }
  return inLiteral ? undefined : outside;
}

/** Whether every parenthesis in `text` closes one opened before it, and all are closed. */
function hasBalancedParentheses(text: string): boolean {
  let depth = 0;
  for (const ch of text) {
    if (ch === '(') depth++;
    else if (ch === ')' && --depth < 0) return false;
  }
  return depth === 0;
}

/**
 * Check whether a string is a SOQL WHERE condition and nothing else.
 *
 * Literals are set aside first, so `Status = 'Delete pending'` is a filter.
 * Outside them the clause may not carry anything that ends or extends the
 * statement (see {@link SOQL_WHERE_FORBIDDEN}), may not leave a parenthesis
 * open or close one it did not open — a builder that wraps the fragment in
 * parentheses would otherwise see its grouping escaped — and may not leave a
 * literal unterminated. A blank clause is accepted: the builders skip it.
 *
 * @param clause - The WHERE clause to check, without the `WHERE` keyword.
 * @returns `true` if the clause only filters.
 */
export function isSafeSoqlWhere(clause: string): boolean {
  if (clause.trim().length === 0) return true;
  if (clause.length > SOQL_WHERE_MAX_LENGTH) return false;
  const outside = withoutSoqlLiterals(clause);
  if (outside === undefined) return false;
  if (SOQL_WHERE_FORBIDDEN.some((pattern) => pattern.test(outside))) return false;
  return hasBalancedParentheses(outside);
}

/**
 * Assert that a string is a WHERE condition and nothing else, then return it.
 *
 * A WHERE fragment is followed by whatever the builder appends, so a clause
 * that went on past the filter still runs: `Id != null LIMIT 1` copies one
 * record from an object and the run reports itself complete.
 *
 * @param clause - The WHERE clause to validate.
 * @returns The validated clause, unchanged.
 * @throws {Error} If the clause does more than filter.
 *
 * @example
 * ```ts
 * const soql = `SELECT Id FROM Account WHERE ${assertSoqlWhere(where)}`;
 * ```
 */
export function assertSoqlWhere(clause: string): string {
  if (!isSafeSoqlWhere(clause)) {
    throw new Error(`Invalid SOQL WHERE clause: "${clause}". ${SOQL_WHERE_RULE}`);
  }
  return clause;
}

/** What a WHERE clause may not contain, as the bridge and the builders both say it. */
export const SOQL_WHERE_RULE =
  'A WHERE clause may only filter: no LIMIT, OFFSET, ORDER BY, GROUP BY, HAVING, FOR, WITH, ' +
  'ALL ROWS, subquery or DML keyword, no semicolon or comment, and every parenthesis and quote closed.';

/**
 * Assert that a string is a valid Salesforce API identifier and return it.
 *
 * Throws an `Error` if the name does not match the expected pattern.
 * Use this before interpolating field or object names into SOQL queries
 * to prevent SOQL injection.
 *
 * @param name - The identifier to validate.
 * @returns The validated name, unchanged.
 * @throws {Error} If the name is not a valid Salesforce API identifier.
 *
 * @example
 * ```ts
 * const soql = `SELECT Id FROM ${assertSoqlIdentifier(objectName)}`;
 * ```
 */
export function assertSoqlIdentifier(name: string): string {
  if (!validateSoqlIdentifier(name)) {
    throw new Error(
      `Invalid Salesforce API name: "${name}". ` +
        'Must start with a letter, contain only alphanumeric characters and underscores, ' +
        'and be at most 255 characters.',
    );
  }
  return name;
}
