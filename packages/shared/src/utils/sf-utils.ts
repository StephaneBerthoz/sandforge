/**
 * Salesforce-specific utility functions.
 *
 * Only the helpers with live consumers remain: SOQL object-name
 * sanitization (injection guard) and org-type → guard-tier mapping.
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

/**
 * Maps an org type string to a ProductionGuard safety tier.
 * This maps to the guard-level tiers (production/staging/development/scratch),
 * NOT to the UX-level `OrgSafetyTier` enum (critical/high/medium/low).
 * Defaults to 'development' for unknown types.
 */
export function orgTypeToGuardTier(
  orgType: string,
): 'production' | 'staging' | 'development' | 'scratch' {
  const map: Record<string, 'production' | 'staging' | 'development' | 'scratch'> = {
    Production: 'production',
    Sandbox: 'development',
    Scratch: 'scratch',
    Developer: 'development',
  };
  return map[orgType] ?? 'development';
}
