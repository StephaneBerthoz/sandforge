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
 *
 * A type the map does not list gets 'production', the most restrictive tier.
 * Callers pass '' for an org the registry does not know, and a stored type
 * can fall outside `OrgType`: nothing then shows the org is a sandbox. The
 * former 'development' default let a write to such an org skip the production
 * confirmation and a delete skip the production block. Own keys only, for the
 * same reason: a stored type is data, and 'constructor' must not come back as
 * a tier.
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
  return Object.prototype.hasOwnProperty.call(map, orgType) ? map[orgType] : 'production';
}
