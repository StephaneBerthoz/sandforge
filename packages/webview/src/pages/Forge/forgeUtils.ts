/**
 * Pure helper functions for the Forge input form. Extracted from
 * ForgeInput.tsx so they can be unit-tested in isolation.
 */

import { forgeConfigSchema } from '@sandforge/shared';

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

/**
 * Per-object record cap forced in SOQL mode.
 *
 * The query's WHERE clause filters the object after FROM only. Related objects
 * the graph discovered are not narrowed to the records it matches — each is
 * read from its whole table — so the run is bounded rather than left to pull an
 * entire org.
 */
export const SOQL_UNSCOPED_RECORD_CAP = 200;

/** The object a SOQL query reads and its WHERE clause, as SOQL mode applies them. */
export interface SoqlRootFilter {
  /** The object after the top-level FROM. */
  objectApiName: string;
  /** The top-level WHERE clause without the keyword, or null when there is none. */
  where: string | null;
}

/** Clauses that may follow WHERE, as `[keyword, one of the words that must follow it]`. */
const CLAUSES_AFTER_WHERE: Array<[string, string[] | null]> = [
  ['WITH', null],
  ['LIMIT', null],
  ['OFFSET', null],
  ['GROUP', ['BY']],
  ['ORDER', ['BY']],
  ['FOR', ['VIEW', 'REFERENCE', 'UPDATE']],
  ['UPDATE', ['TRACKING', 'VIEWSTAT']],
];

/** A word of a SOQL query outside quotes and parentheses, with its offsets. */
interface SoqlWord {
  word: string;
  start: number;
  end: number;
}

/**
 * Words that may follow the object after FROM. Any other word there is the
 * object's alias.
 */
const WORDS_AFTER_OBJECT = new Set([
  'WHERE',
  'USING',
  'WITH',
  'GROUP',
  'ORDER',
  'LIMIT',
  'OFFSET',
  'FOR',
  'UPDATE',
]);

/** The top-level words of `soql`: quoted strings and parenthesised parts are skipped. */
function topLevelWords(soql: string): SoqlWord[] {
  const words: SoqlWord[] = [];
  let depth = 0;
  let i = 0;
  while (i < soql.length) {
    const ch = soql[i];
    if (ch === "'") {
      i++;
      while (i < soql.length && soql[i] !== "'") {
        i += soql[i] === '\\' ? 2 : 1;
      }
      i++;
    } else if (ch === '(') {
      depth++;
      i++;
    } else if (ch === ')') {
      depth = Math.max(0, depth - 1);
      i++;
    } else if (/\w/.test(ch)) {
      const start = i;
      while (i < soql.length && /\w/.test(soql[i])) i++;
      if (depth === 0) words.push({ word: soql.slice(start, i), start, end: i });
    } else {
      i++;
    }
  }
  return words;
}

/**
 * Read the root object and the WHERE clause of a SOQL query.
 *
 * Only top-level words count: quoted strings and anything in parentheses
 * (a subquery in the select list, a semi-join inside the filter) are skipped,
 * so `(SELECT Id FROM Contacts WHERE …)` cannot pass for the root, and a
 * quoted `'ORDER BY'` cannot end the filter. The clause stops where ORDER BY,
 * LIMIT or any other trailing clause starts; those are not applied.
 *
 * The filter is appended to queries that name the object without an alias, so
 * an alias (`FROM Account a WHERE a.Industry = …`) is removed from the
 * top-level field paths that start with it.
 *
 * Returns null when there is no top-level `FROM <object>`.
 */
export function soqlRootFilter(soql: string): SoqlRootFilter | null {
  const words = topLevelWords(soql);
  const upper = (k: number): string | undefined => words[k]?.word.toUpperCase();
  const fromAt = words.findIndex((w) => w.word.toUpperCase() === 'FROM');
  if (fromAt < 0 || fromAt + 1 >= words.length) return null;
  const objectApiName = words[fromAt + 1].word;

  const whereAt = words.findIndex((w, k) => k > fromAt + 1 && w.word.toUpperCase() === 'WHERE');
  if (whereAt < 0) return { objectApiName, where: null };

  const aliasAt = upper(fromAt + 2) === 'AS' ? fromAt + 3 : fromAt + 2;
  const aliasWord = upper(aliasAt);
  const alias =
    aliasAt < whereAt && aliasWord !== undefined && !WORDS_AFTER_OBJECT.has(aliasWord)
      ? aliasWord
      : null;

  let endAt = words.length;
  for (let k = whereAt + 1; k < words.length; k++) {
    const next = upper(k + 1);
    const clause = CLAUSES_AFTER_WHERE.find(
      ([keyword, followers]) =>
        upper(k) === keyword &&
        (followers === null || (next !== undefined && followers.includes(next))),
    );
    if (clause) {
      endAt = k;
      break;
    }
  }
  const end = endAt < words.length ? words[endAt].start : soql.length;

  let where = soql.slice(words[whereAt].end, end);
  if (alias) {
    const offset = words[whereAt].end;
    // Right to left, so the offsets of the paths not yet visited stay valid.
    for (let k = endAt - 1; k > whereAt; k--) {
      const w = words[k];
      const isPathHead =
        w.word.toUpperCase() === alias &&
        soql[w.end] === '.' &&
        soql.slice(0, w.start).trimEnd().slice(-1) !== '.';
      if (isPathHead) {
        where = where.slice(0, w.start - offset) + where.slice(w.end + 1 - offset);
      }
    }
  }
  where = where.trim();
  return { objectApiName, where: where.length > 0 ? where : null };
}

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
const objectSoqlFilterRule = forgeConfigSchema.shape.objectSoqlFilters
  .unwrap()
  .innerType().valueSchema;

/**
 * Whether the query's WHERE clause breaks the rules the extension checks every
 * object filter against: at most 512 characters, no SOQL comment marker even
 * inside a quoted value, no trailing semicolon. Such a run would be refused as
 * a whole, so the form holds it back and says why.
 */
export function soqlFilterRefused(soql: string): boolean {
  const where = soqlRootFilter(soql)?.where;
  return !!where && !objectSoqlFilterRule.safeParse(where).success;
}
