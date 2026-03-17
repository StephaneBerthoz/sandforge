/**
 * Configurable query limits adapted by org tier.
 * Sandbox orgs can use higher limits, while production orgs
 * use conservative defaults to respect governor limits.
 */

/** Supported org tiers for query limit configuration */
export type OrgTier = 'sandbox' | 'production';

/** Query limit configuration per org tier */
export interface QueryLimitConfig {
  /** Maximum number of records per SOQL query */
  defaultQueryLimit: number;
  /** Maximum records for data preview queries */
  previewQueryLimit: number;
  /** Maximum records for backup/export queries */
  exportQueryLimit: number;
  /** Maximum permission sets to query */
  permissionSetLimit: number;
}

/** Conservative limits for production orgs */
const PRODUCTION_LIMITS: QueryLimitConfig = {
  defaultQueryLimit: 500,
  previewQueryLimit: 200,
  exportQueryLimit: 1000,
  permissionSetLimit: 50,
};

/** Higher limits for sandbox orgs */
const SANDBOX_LIMITS: QueryLimitConfig = {
  defaultQueryLimit: 2000,
  previewQueryLimit: 2000,
  exportQueryLimit: 5000,
  permissionSetLimit: 100,
};

/**
 * Get query limits for the given org tier.
 * @param tier - The org tier ('sandbox' or 'production')
 * @returns Query limit configuration for the tier
 */
export function getQueryLimits(tier: OrgTier): QueryLimitConfig {
  return tier === 'production' ? { ...PRODUCTION_LIMITS } : { ...SANDBOX_LIMITS };
}

/**
 * Get the default query limit for a given org tier.
 * Convenience function for the most common use case.
 * @param tier - The org tier ('sandbox' or 'production')
 * @returns The default query limit
 */
export function getDefaultQueryLimit(tier: OrgTier): number {
  return tier === 'production'
    ? PRODUCTION_LIMITS.defaultQueryLimit
    : SANDBOX_LIMITS.defaultQueryLimit;
}

/**
 * Determine the org tier from org metadata.
 * @param isSandbox - Whether the org is a sandbox
 * @returns The org tier
 */
export function resolveOrgTier(isSandbox: boolean): OrgTier {
  return isSandbox ? 'sandbox' : 'production';
}
