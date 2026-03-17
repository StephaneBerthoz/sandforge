/**
 * Salesforce-specific utility functions.
 *
 * Provides helpers for ID validation and conversion, API name checks,
 * namespace extraction, and display formatting for record counts.
 */

/** Validates a Salesforce 15 or 18 character ID. */
export function isValidSalesforceId(id: string): boolean {
  return /^[a-zA-Z0-9]{15}(?:[a-zA-Z0-9]{3})?$/.test(id);
}

/** Converts a 15-char SF ID to 18-char by computing the checksum suffix. */
export function to18CharId(id: string): string {
  if (id.length === 18) return id;
  if (id.length !== 15) {
    throw new Error(`Invalid Salesforce ID length: ${id.length}`);
  }

  const CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ012345';
  let suffix = '';
  for (let i = 0; i < 3; i++) {
    let flags = 0;
    for (let j = 0; j < 5; j++) {
      const c = id.charAt(i * 5 + j);
      if (c >= 'A' && c <= 'Z') {
        flags += 1 << j;
      }
    }
    suffix += CHARS.charAt(flags);
  }
  return id + suffix;
}

/** Checks if a string is a valid SF API name (e.g. Account, Custom__c). */
export function isValidApiName(name: string): boolean {
  return /^[A-Za-z][A-Za-z0-9_]*(__[a-zA-Z][a-zA-Z0-9]*)?$/.test(name);
}

/** Checks if an object API name refers to a custom object (ends with __c). */
export function isCustomObject(apiName: string): boolean {
  return apiName.endsWith('__c');
}

/** Checks if a field API name refers to a custom field (ends with __c). */
export function isCustomField(fieldApiName: string): boolean {
  return fieldApiName.endsWith('__c');
}

/**
 * Extracts the namespace prefix from an API name like `Namespace__Object__c`.
 * Returns `undefined` for standard or non-namespaced names.
 */
export function extractNamespace(apiName: string): string | undefined {
  const match = apiName.match(/^([a-zA-Z][a-zA-Z0-9]*)__[a-zA-Z]/);
  if (match && apiName.endsWith('__c') && (apiName.match(/__/g)?.length ?? 0) >= 2) {
    return match[1];
  }
  return undefined;
}

/** Formats a record count for display (e.g. "1.2K", "3.5M"). */
export function formatRecordCount(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}K`;
  return String(count);
}

/** Calculates estimated API calls for an operation given batch size. */
export function estimateApiCalls(recordCount: number, batchSize: number): number {
  if (batchSize <= 0 || !Number.isFinite(batchSize)) {
    throw new Error('batchSize must be a finite positive number');
  }
  if (!Number.isFinite(recordCount)) {
    throw new Error('recordCount must be a finite number');
  }
  if (recordCount <= 0) return 0;
  return Math.ceil(recordCount / batchSize);
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

/** @deprecated Use `orgTypeToGuardTier` instead. */
export const orgTypeToSafetyTier = orgTypeToGuardTier;
