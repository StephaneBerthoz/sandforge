/**
 * What a SOQL query says of the records it chooses, read alike by the Forge
 * panel, the extension and the command line: the object after its top-level
 * FROM, its WHERE, ORDER BY and LIMIT, and the clauses that would make the
 * rows a clone reads other than those the query returns.
 *
 * A clone from a query (`ForgeConfig.queryScope: 'records'`) reads its roots
 * by its own statement, `SELECT Id FROM <object> WHERE … ORDER BY … LIMIT …`,
 * never by the query as typed: a GROUP BY, an OFFSET or an aggregate there
 * would have the clone read other records than the query shows, and are
 * refused rather than dropped.
 */
import * as z from 'zod';

import type { ForgeConfig } from '../types/forge.types.js';
import { FORGE_ROOTS_MAX } from './forge-run-gate.js';

/** The object a SOQL query reads and its WHERE clause, as SOQL mode applies them. */
export interface SoqlRootFilter {
  /** The object after the top-level FROM. */
  objectApiName: string;
  /** The top-level WHERE clause without the keyword, or null when there is none. */
  where: string | null;
  /**
   * Set only when a query that has a WHERE clause lists, after the FROM
   * object, a relationship whose alias cannot be traced back to it. The clause
   * then still carries an alias nothing can rewrite, so the run must not be
   * sent. A query with no WHERE clause sends no filter at all — its aliases
   * are read by nothing — and the flag stays unset there.
   */
  unresolvedAlias?: true;
}

/**
 * The clauses a query that chooses the records to clone may not hold, each
 * changing the rows it returns or how they are read: grouped, past an
 * offset, locked, tracked, of a scope, of a security mode, or an aggregate
 * in its select list (`aggregate`).
 */
export const SOQL_ROOT_REFUSED_CLAUSES = [
  'GROUP BY',
  'HAVING',
  'OFFSET',
  'FOR',
  'WITH',
  'USING SCOPE',
  'UPDATE',
  'aggregate',
] as const;

/** A clause a query that chooses records may not hold: see {@link SOQL_ROOT_REFUSED_CLAUSES}. */
export type SoqlRootRefusedClause = (typeof SOQL_ROOT_REFUSED_CLAUSES)[number];

/**
 * What a query says of the records it chooses: its object and WHERE, its
 * ORDER BY and LIMIT, each without its keyword, the aliases of its FROM
 * written out, and the clauses it holds that a clone from records refuses.
 */
export interface SoqlRootQuery extends SoqlRootFilter {
  /** The top-level ORDER BY without the keywords, or null when there is none. */
  orderBy: string | null;
  /**
   * The LIMIT, or null when there is none. A LIMIT that is not a whole
   * number as typed — a bind variable, a word — reads as NaN.
   */
  limit: number | null;
  /** The refused clauses it holds, in the order the query gives them. */
  refused: SoqlRootRefusedClause[];
}

/** A word of a SOQL query outside quotes and parentheses, with its offsets. */
interface SoqlWord {
  word: string;
  start: number;
  end: number;
}

/**
 * The clauses that may follow the FROM list, as
 * `[name, keyword, one of the words that must follow it]`. The name is the
 * clause as a refusal says it.
 */
const CLAUSES: ReadonlyArray<[string, string, readonly string[] | null]> = [
  ['WHERE', 'WHERE', null],
  ['USING SCOPE', 'USING', ['SCOPE']],
  ['WITH', 'WITH', null],
  ['GROUP BY', 'GROUP', ['BY']],
  ['HAVING', 'HAVING', null],
  ['ORDER BY', 'ORDER', ['BY']],
  ['LIMIT', 'LIMIT', null],
  ['OFFSET', 'OFFSET', null],
  ['FOR', 'FOR', ['VIEW', 'REFERENCE', 'UPDATE']],
  ['UPDATE', 'UPDATE', ['TRACKING', 'VIEWSTAT']],
];

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

/** The functions of a select list that make a query return one row per group, or one in all. */
const AGGREGATES = new Set(['COUNT', 'COUNT_DISTINCT', 'SUM', 'AVG', 'MIN', 'MAX']);

/**
 * One entry of the comma list after the FROM object: `<alias>.<Relationship> <alias>`,
 * captured as head alias, dotted relationship path and the alias it declares.
 */
const RELATIONSHIP_ENTRY = /^([A-Za-z]\w*)((?:\.[A-Za-z]\w*)+)\s+(?:AS\s+)?([A-Za-z]\w*)$/i;

/** The top-level words of `soql`: quoted strings and parenthesised parts are skipped. */
function topLevelWords(soql: string): SoqlWord[] {
  const words: SoqlWord[] = [];
  let depth = 0;
  let i = 0;
  while (i < soql.length) {
    const ch = soql[i] ?? '';
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
      while (i < soql.length && /\w/.test(soql[i] ?? '')) i++;
      if (depth === 0) words.push({ word: soql.slice(start, i), start, end: i });
    } else {
      i++;
    }
  }
  return words;
}

/** A clause of the query: its name, its first word and the words of its body. */
interface Clause {
  name: string;
  at: number;
  bodyFrom: number;
  bodyTo: number;
}

/** Everything the two readings of a query share. */
interface ParsedQuery {
  soql: string;
  words: SoqlWord[];
  fromAt: number;
  objectApiName: string;
  clauses: Clause[];
  aliasPaths: Map<string, string>;
  unresolvedAlias: boolean;
}

function parse(soql: string): ParsedQuery | null {
  const words = topLevelWords(soql);
  const upper = (k: number): string | undefined => words[k]?.word.toUpperCase();
  const fromAt = words.findIndex((w) => w.word.toUpperCase() === 'FROM');
  const object = words[fromAt + 1];
  if (fromAt < 0 || object === undefined) return null;

  /** The clause the word at `k` starts, if it starts one. */
  const clauseAt = (k: number): readonly [string, number] | undefined => {
    const next = upper(k + 1);
    const found = CLAUSES.find(
      ([, keyword, followers]) =>
        upper(k) === keyword &&
        (followers === null || (next !== undefined && followers.includes(next))),
    );
    if (!found) return undefined;
    return [found[0], found[2] === null ? 1 : 2] as const;
  };

  const starts: Array<{ name: string; at: number; words: number }> = [];
  for (let k = fromAt + 2; k < words.length; k++) {
    const clause = clauseAt(k);
    if (!clause) continue;
    // Only the first WHERE starts the filter: a later one is a word of a
    // clause nothing reads.
    if (clause[0] === 'WHERE' && starts.some((s) => s.name === 'WHERE')) continue;
    starts.push({ name: clause[0], at: k, words: clause[1] });
    k += clause[1] - 1;
  }
  const clauses: Clause[] = starts.map((start, index) => ({
    name: start.name,
    at: start.at,
    bodyFrom: start.at + start.words,
    bodyTo: starts[index + 1]?.at ?? words.length,
  }));
  const listEnd = clauses[0]?.at ?? words.length;

  const aliasAt = upper(fromAt + 2) === 'AS' ? fromAt + 3 : fromAt + 2;
  const aliasWord = upper(aliasAt);
  const alias =
    aliasAt < listEnd && aliasWord !== undefined && !WORDS_AFTER_OBJECT.has(aliasWord)
      ? aliasWord
      : null;

  // What a top-level path headed by each alias becomes: the empty string for
  // the root alias (the path is sent bare), the relationship path for a
  // comma-form entry.
  const aliasPaths = new Map<string, string>();
  if (alias) aliasPaths.set(alias, '');
  let unresolvedAlias = false;
  const listTo = words[listEnd]?.start ?? soql.length;
  for (const entry of soql.slice(object.end, listTo).split(',').slice(1)) {
    const parts = RELATIONSHIP_ENTRY.exec(entry.trim());
    const head = parts ? aliasPaths.get((parts[1] ?? '').toUpperCase()) : undefined;
    if (!parts || head === undefined) {
      unresolvedAlias = true;
      continue;
    }
    const path = (parts[2] ?? '').slice(1);
    aliasPaths.set((parts[3] ?? '').toUpperCase(), head ? `${head}.${path}` : path);
  }
  return {
    soql,
    words,
    fromAt,
    objectApiName: object.word,
    clauses,
    aliasPaths,
    unresolvedAlias,
  };
}

/**
 * The body of a clause of the query, trimmed, its aliases written out as the
 * paths they stand for; null when the clause is absent or says nothing.
 */
function bodyOf(parsed: ParsedQuery, name: string): string | null {
  const clause = parsed.clauses.find((c) => c.name === name);
  if (!clause) return null;
  const { soql, words, aliasPaths } = parsed;
  const from = words[clause.bodyFrom - 1]?.end ?? soql.length;
  const to = words[clause.bodyTo]?.start ?? soql.length;
  let body = soql.slice(from, to);
  if (aliasPaths.size > 0) {
    // Right to left, so the offsets of the paths not yet visited stay valid.
    for (let k = clause.bodyTo - 1; k >= clause.bodyFrom; k--) {
      const w = words[k];
      if (w === undefined) continue;
      const path = aliasPaths.get(w.word.toUpperCase());
      const isPathHead =
        path !== undefined &&
        soql[w.end] === '.' &&
        soql.slice(0, w.start).trimEnd().slice(-1) !== '.';
      if (isPathHead) {
        body =
          body.slice(0, w.start - from) + (path ? `${path}.` : '') + body.slice(w.end + 1 - from);
      }
    }
  }
  body = body.trim();
  return body.length > 0 ? body : null;
}

/**
 * Read the root object and the WHERE clause of a SOQL query.
 *
 * Only top-level words count: quoted strings and anything in parentheses
 * (a subquery in the select list, a semi-join inside the filter) are skipped,
 * so `(SELECT Id FROM Contacts WHERE …)` cannot pass for the root, and a
 * quoted `'ORDER BY'` cannot end the filter. The clause stops where ORDER BY,
 * LIMIT or any other trailing clause starts.
 *
 * The filter is appended to queries that name the object without an alias, so
 * an alias (`FROM Account a WHERE a.Industry = …`) is removed from the
 * top-level field paths that start with it.
 *
 * A comma list after the object declares more aliases, each standing for a
 * relationship walked from an alias already declared
 * (`FROM Contact c, c.Account a`). Those are rewritten to the relationship
 * path the object itself understands, so `a.Name` is sent as `Account.Name`.
 * An entry no alias resolves leaves {@link SoqlRootFilter.unresolvedAlias} set,
 * which only a query with a WHERE clause to rewrite can reach.
 *
 * Returns null when there is no top-level `FROM <object>`.
 */
export function soqlRootFilter(soql: string): SoqlRootFilter | null {
  const parsed = parse(soql);
  if (!parsed) return null;
  const { objectApiName } = parsed;
  if (!parsed.clauses.some((c) => c.name === 'WHERE')) return { objectApiName, where: null };
  return {
    objectApiName,
    where: bodyOf(parsed, 'WHERE'),
    ...(parsed.unresolvedAlias ? { unresolvedAlias: true as const } : {}),
  };
}

/**
 * Read what a SOQL query says of the records it chooses: {@link soqlRootFilter}'s
 * object and WHERE, and its ORDER BY and LIMIT, read the same way, with the
 * clauses it holds that a clone from records refuses. An alias nothing
 * traces is marked when a WHERE or an ORDER BY would carry it.
 *
 * Returns null when there is no top-level `FROM <object>`.
 */
export function soqlRootQuery(soql: string): SoqlRootQuery | null {
  const parsed = parse(soql);
  if (!parsed) return null;
  const { words, fromAt, clauses } = parsed;
  const refused: SoqlRootRefusedClause[] = [];
  // An aggregate of the select list returns one row per group, or one in all:
  // a function name followed by its parenthesis, at the top level.
  const aggregate = words
    .slice(0, fromAt)
    .some((w) => AGGREGATES.has(w.word.toUpperCase()) && /^\s*\(/.test(parsed.soql.slice(w.end)));
  if (aggregate) refused.push('aggregate');
  for (const clause of clauses) {
    const name = SOQL_ROOT_REFUSED_CLAUSES.find((c) => c === clause.name);
    if (name !== undefined && !refused.includes(name)) refused.push(name);
  }
  const where = bodyOf(parsed, 'WHERE');
  const orderBy = bodyOf(parsed, 'ORDER BY');
  const limitText = clauses.some((c) => c.name === 'LIMIT') ? bodyOf(parsed, 'LIMIT') : null;
  const limit = clauses.some((c) => c.name === 'LIMIT')
    ? limitText !== null && /^\d{1,9}$/.test(limitText)
      ? Number(limitText)
      : Number.NaN
    : null;
  const carriesAliases = where !== null || orderBy !== null;
  return {
    objectApiName: parsed.objectApiName,
    where,
    orderBy,
    limit,
    refused,
    ...(parsed.unresolvedAlias && carriesAliases ? { unresolvedAlias: true as const } : {}),
  };
}

/** An object's API name, as Salesforce allows them. */
const OBJECT_NAME = /^[A-Za-z][A-Za-z0-9_]{0,79}$/;

/**
 * A SOQL condition, without WHERE, as Forge sends one into a statement of its
 * own: 512 characters at most, no comment marker even inside a quoted value,
 * no trailing semicolon, which would end the statement it goes into. The
 * condition itself is free: whoever runs the clone writes their own.
 */
export const soqlWhereFragmentSchema = z
  .string()
  .min(1)
  .max(512)
  .refine((s) => !/--|\/\*|\*\/|;\s*$/.test(s), {
    message: 'SOQL filter must not contain comment markers (--, /*, */) or trailing semicolon',
  });

/** The most characters of an ORDER BY a clone from a query takes. */
export const SOQL_ROOT_ORDER_BY_MAX = 200;

/** One ordering of an ORDER BY: a field path, ASC or DESC, NULLS FIRST or LAST. */
const ORDERING =
  /^[A-Za-z][A-Za-z0-9_]{0,79}(?:\.[A-Za-z][A-Za-z0-9_]{0,79}){0,4}(?:\s+(?:ASC|DESC))?(?:\s+NULLS\s+(?:FIRST|LAST))?$/i;

/**
 * An ORDER BY, without the keywords, as a clone from a query sends it into
 * its statement: field paths, each with ASC or DESC and NULLS FIRST or LAST,
 * separated by commas, 200 characters at most. Nothing else — no function,
 * no literal —, so nothing in it can change the statement it goes into.
 */
export const soqlOrderBySchema = z
  .string()
  .min(1)
  .max(SOQL_ROOT_ORDER_BY_MAX)
  .refine((s) => s.split(',').every((ordering) => ORDERING.test(ordering.trim())), {
    message:
      'An ORDER BY takes field paths, each with ASC or DESC and NULLS FIRST or LAST, separated by commas',
  });

/**
 * Why a query cannot choose the records a clone takes, by what of it: no
 * object after FROM (`noObject`), an object name that is none (`object`), a
 * clause that changes the rows it returns (`refused`), an alias nothing
 * traces (`alias`), a WHERE past the rules of a filter (`where`), an ORDER BY
 * past its own (`orderBy`), a LIMIT that is no whole number from 1 to
 * `FORGE_ROOTS_MAX` (`limit`).
 */
export type SoqlRootIssue =
  | { kind: 'noObject' }
  | { kind: 'object'; objectApiName: string }
  | { kind: 'refused'; clause: SoqlRootRefusedClause }
  | { kind: 'alias' }
  | { kind: 'where' }
  | { kind: 'orderBy' }
  | { kind: 'limit' };

/**
 * Why a query cannot choose the records a clone takes, or nothing when it
 * can: the first of its issues, in the order a reader fixes them. What the
 * query chooses is read by the clone's own statement; one it would read
 * otherwise than the query returns them is refused, never cut.
 */
export function soqlRootQueryIssue(soql: string): SoqlRootIssue | undefined {
  const query = soqlRootQuery(soql);
  if (!query) return { kind: 'noObject' };
  if (!OBJECT_NAME.test(query.objectApiName)) {
    return { kind: 'object', objectApiName: query.objectApiName };
  }
  const [clause] = query.refused;
  if (clause !== undefined) return { kind: 'refused', clause };
  if (query.unresolvedAlias) return { kind: 'alias' };
  if (query.where !== null && !soqlWhereFragmentSchema.safeParse(query.where).success) {
    return { kind: 'where' };
  }
  if (query.orderBy !== null && !soqlOrderBySchema.safeParse(query.orderBy).success) {
    return { kind: 'orderBy' };
  }
  if (
    query.limit !== null &&
    !(Number.isInteger(query.limit) && query.limit >= 1 && query.limit <= FORGE_ROOTS_MAX)
  ) {
    return { kind: 'limit' };
  }
  return undefined;
}

/**
 * A refusal of a query as the command line and the extension say it: what
 * is wrong, and what to write instead.
 */
export function soqlRootIssueWords(issue: SoqlRootIssue): string {
  switch (issue.kind) {
    case 'noObject':
      return 'The query names no object after FROM: write it as SELECT Id FROM <Object> WHERE …';
    case 'object':
      return `"${issue.objectApiName}" after FROM is not an object’s API name: name the object as the org does, as Account or Region__c`;
    case 'refused':
      return issue.clause === 'aggregate'
        ? 'The query counts, sums or groups its rows (COUNT(), SUM(), MAX()…), and returns no record to clone: select the records themselves, as SELECT Id FROM <Object> WHERE …'
        : `The query’s ${issue.clause} changes the records it returns, and the clone would read others than it shows: take it out, and choose the records by WHERE, ORDER BY and LIMIT`;
    case 'alias':
      return 'The query names a relationship by an alias that does not lead back to its object (FROM Contact c, x.Account a): write each path from the object, as Account.Name';
    case 'where':
      return 'The query’s WHERE is past 512 characters, or holds a comment marker (--, /*, */) or ends with ;: shorten it, or take them out';
    case 'orderBy':
      return `The query’s ORDER BY takes field paths, each with ASC or DESC and NULLS FIRST or LAST, separated by commas, ${SOQL_ROOT_ORDER_BY_MAX} characters at most: as ORDER BY CreatedDate DESC, Id`;
    case 'limit':
      return `The query’s LIMIT is a whole number from 1 to ${FORGE_ROOTS_MAX.toLocaleString('en-US')}: past it, copy a sample of the whole org with a filter on its roots`;
  }
}

/**
 * Whether a run clones records and what they reach, reading only that,
 * where discovery counted whole tables: a clone of one record, or of the
 * records a query chooses (`queryScope: 'records'`). The counts, sizes and
 * calls said before such a run are the source tables', and so the most it
 * may read. A query read as tables (`queryScope` absent or `tables`), a
 * template, an AI draft not yet sent as a query and the whole org are not.
 */
export function isRecordScoped(
  config:
    | Partial<Pick<ForgeConfig, 'inputMode' | 'recordId' | 'soqlQuery' | 'queryScope'>>
    | null
    | undefined,
): boolean {
  if (!config) return false;
  if (config.inputMode === 'record') return typeof config.recordId === 'string';
  return (
    config.inputMode === 'soql' &&
    config.queryScope === 'records' &&
    typeof config.soqlQuery === 'string'
  );
}
