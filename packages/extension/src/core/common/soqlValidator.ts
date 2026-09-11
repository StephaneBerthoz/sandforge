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
