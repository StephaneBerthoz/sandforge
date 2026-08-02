/**
 * Pure helper functions for the Forge input form. Extracted from
 * ForgeInput.tsx so they can be unit-tested in isolation.
 */

/** Preview data returned by the extension for a Salesforce record. */
export interface RecordPreview {
  objectApiName: string;
  objectLabel: string;
  recordId: string;
  fields: Array<{ name: string; value: string }>;
  estimatedRecordCount?: number;
  totalFieldCount?: number;
  estimatedSize?: number;
}

/** Common PII field name patterns for badge detection. */
const PII_FIELD_PATTERNS = [
  /email/i,
  /phone/i,
  /mobile/i,
  /fax/i,
  /street/i,
  /address/i,
  /city/i,
  /postal/i,
  /zip/i,
  /ssn/i,
  /birth/i,
  /personal/i,
];

/** Check if a field name matches common PII patterns. */
export function isPiiField(fieldName: string): boolean {
  return PII_FIELD_PATTERNS.some((p) => p.test(fieldName));
}

/**
 * Pick a per-object record cap proportional to the org's volumetry. The
 * input is the root object's `estimatedRecordCount` from the preview;
 * larger orgs get a tighter cap so big-org clones stay bounded.
 *
 * Returns `0` to mean "no cap" (translates to undefined downstream).
 */
export function smartLimitForCount(count: number): number {
  if (count > 50_000) return 50;
  if (count > 5_000) return 100;
  if (count > 500) return 500;
  if (count > 50) return 1000;
  return 0;
}

/** Extract a Salesforce Record ID from a plain ID or Salesforce URL. */
export function extractRecordId(input: string): string | null {
  const trimmed = input.trim();
  if (/^[a-zA-Z0-9]{15}([a-zA-Z0-9]{3})?$/.test(trimmed)) {
    return trimmed;
  }
  const match = trimmed.match(/\/([a-zA-Z0-9]{15,18})(?:\/|$|\?)/);
  return match?.[1] ?? null;
}

/** Extract the hostname/pod from a Salesforce URL or instanceUrl. */
export function extractSalesforceDomain(url: string): string | null {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    return host.split('.')[0] ?? null;
  } catch {
    return null;
  }
}
