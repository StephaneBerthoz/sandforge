/**
 * Salesforce-specific utility functions.
 *
 * Only the helpers with live consumers remain: SOQL object-name
 * sanitization (injection guard). What kind of org an org is, and the guard
 * tier it gets, is `org-kind.ts`'s.
 */

/** Checks if a string is a valid SF API name (e.g. Account, Custom__c). */
function isValidApiName(name: string): boolean {
  return /^[A-Za-z][A-Za-z0-9_]*(__[a-zA-Z][a-zA-Z0-9]*)?$/.test(name);
}

/**
 * Validates and sanitizes a Salesforce object API name for use in SOQL queries.
 * Prevents SOQL injection by rejecting invalid names.
 * @throws Error if the name is not a valid Salesforce API name.
 */
export function sanitizeSoqlObjectName(name: string): string {
  if (!name || !isValidApiName(name)) {
    throw new Error(`Invalid Salesforce object API name: "${name}"`);
  }
  return name;
}
