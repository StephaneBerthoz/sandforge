/**
 * Pure helper functions for the Forge input form. Extracted from
 * ForgeInput.tsx so they can be unit-tested in isolation.
 */

import { SOQL_NEWEST_FIRST, soqlRootQuery } from '@sandforge/shared';

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

/** The catalogue keys a starter template's name and description are said by. */
export interface StarterTemplateKeys {
  name: string;
  description: string;
}

/**
 * The keys of each starter template, by its id. Their names and descriptions
 * were drawn as `@sandforge/shared` holds them, in English in every language;
 * the shared copy stays the fallback for an id this table does not know.
 */
const STARTER_TEMPLATE_KEYS: Readonly<Record<string, StarterTemplateKeys>> = {
  'builtin:account-360': {
    name: 'forge.starter.account360.name',
    description: 'forge.starter.account360.description',
  },
  'builtin:case-workflow': {
    name: 'forge.starter.caseWorkflow.name',
    description: 'forge.starter.caseWorkflow.description',
  },
  'builtin:lead-to-opp': {
    name: 'forge.starter.leadToOpp.name',
    description: 'forge.starter.leadToOpp.description',
  },
};

/** The keys a starter template is said by, or null for any other template. */
export function starterTemplateKeys(id: string): StarterTemplateKeys | null {
  return STARTER_TEMPLATE_KEYS[id] ?? null;
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

/** The object cap discovery takes when the page names none, as the extension's discovery does. */
export const DEFAULT_OBJECT_CAP = 50;

/**
 * The highest object cap the page offers. A graph cut short at it is not
 * lifted by raising the cap: a lower depth, a query or ALL is.
 */
export const MOST_OBJECTS_OFFERED = 500;

/**
 * The query that takes the newest of the records `soql` chooses, `cap` of
 * them: `ORDER BY CreatedDate DESC, Id DESC LIMIT <cap>` after it — the order
 * of the ids is not the order the records were made in, and records made in
 * the same second need the ids to come back in one order —, or `LIMIT <cap>`
 * alone after an ORDER BY of its own, the first of them in that order.
 * Nothing for a query that has a LIMIT already, which the user changes
 * themselves, or that names no object.
 */
export function newestQueryOf(soql: string, cap: number): string | undefined {
  const query = soqlRootQuery(soql);
  if (!query || query.limit !== null) return undefined;
  const typed = soql.trimEnd();
  return query.orderBy !== null
    ? `${typed} LIMIT ${cap}`
    : `${typed} ORDER BY ${SOQL_NEWEST_FIRST} LIMIT ${cap}`;
}
