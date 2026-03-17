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
