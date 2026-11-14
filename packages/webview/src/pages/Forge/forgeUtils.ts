/**
 * Pure helper functions for the Forge input form. Extracted from
 * ForgeInput.tsx so they can be unit-tested in isolation.
 */

import { forgeConfigSchema, soqlRootFilter } from '@sandforge/shared';

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

/**
 * The cap on each object Smart gives a run from a SOQL query, whose objects
 * past the one after FROM are read from their whole tables. A clone of one
 * record's graph gets none on Smart: it reads only what the record reaches.
 */
export const SMART_SOQL_CAP = 100;

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

/**
 * Per-object record cap forced in SOQL mode.
 *
 * The query's WHERE clause filters the object after FROM only. Related objects
 * the graph discovered are not narrowed to the records it matches — each is
 * read from its whole table — so the run is bounded rather than left to pull an
 * entire org.
 */
export const SOQL_UNSCOPED_RECORD_CAP = 200;

/** The object cap discovery takes when the page names none, as the extension's discovery does. */
export const DEFAULT_OBJECT_CAP = 50;

/**
 * The highest object cap the page offers. A graph cut short at it is not
 * lifted by raising the cap: a lower depth, a query or ALL is.
 */
export const MOST_OBJECTS_OFFERED = 500;

/**
 * The `objectSoqlFilters` a SOQL-mode run sends: the query's WHERE clause under
 * the name of the object after FROM, or undefined when there is nothing to filter.
 */
export function soqlObjectFilters(soql: string): Record<string, string> | undefined {
  const root = soqlRootFilter(soql);
  return root?.where ? { [root.objectApiName]: root.where } : undefined;
}

/**
 * The rule every object filter value is checked against. The object name has
 * its own rule, and a name it refuses says nothing about the clause.
 */
const objectSoqlFilterRule = forgeConfigSchema.shape.objectSoqlFilters.unwrap().valueType;

/**
 * Whether the query's WHERE clause breaks the rules the extension checks every
 * object filter against: at most 512 characters, no SOQL comment marker even
 * inside a quoted value, no trailing semicolon. Such a run would be refused as
 * a whole, so the form holds it back and says why.
 *
 * A WHERE clause under a FROM clause that declares an alias over a relationship
 * nobody can trace is held back too: its paths would reach the org under a name
 * the object has no field for, and the run would fail on the first object it
 * reads. Without a WHERE clause there is nothing to send under those aliases,
 * and the query is accepted.
 */
export function soqlFilterRefused(soql: string): boolean {
  const root = soqlRootFilter(soql);
  if (root?.unresolvedAlias) return true;
  const where = root?.where;
  return !!where && !objectSoqlFilterRule.safeParse(where).success;
}

/** The rule every object filter KEY is checked against: an SObject API name. */
const objectSoqlFilterKeyRule = forgeConfigSchema.shape.objectSoqlFilters.unwrap().keyType;

/**
 * Whether the name after FROM breaks the rule the extension checks every
 * object filter key against: a letter followed by at most 79 letters, digits
 * or underscores. The clause travels under that name, so a name the schema
 * refuses sinks the whole run — and only once it reached the host, with the
 * form showing nothing.
 *
 * A query with no WHERE clause sends no filter at all, so nothing is refused.
 */
export function soqlObjectNameRefused(soql: string): boolean {
  const root = soqlRootFilter(soql);
  return !!root?.where && !objectSoqlFilterKeyRule.safeParse(root.objectApiName).success;
}
