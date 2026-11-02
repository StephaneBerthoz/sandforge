/**
 * What an SFDMU export says in its `query`. A real export.json has no key for
 * the object, the filter, the order or the cap: all four are in the SOQL. The
 * importer asked for an `objectName` no such file holds, and carried `where`
 * and `orderBy` from keys SFDMU does not read, so a filter in the query would
 * have been dropped and Sync, which never runs that query, would have read
 * every record of the object.
 */

/** The parts of a query a Sync configuration can say, or has to say it cannot. */
export interface SfdmuQuery {
  /** The object of the outer FROM, as written. Absent when no FROM can be read. */
  object?: string;
  /** The filter, on one line, without the object's alias. */
  where?: string;
  /** The order, on one line, without the object's alias. */
  orderBy?: string;
  limit?: number;
  /** The rest of the statement, as written: `OFFSET 5`, `ALL ROWS`, `FOR VIEW`. */
  otherClauses: string[];
}

/** A word of the statement, outside literals and parentheses. */
interface Word {
  text: string;
  start: number;
  end: number;
}

const WORD_CHARACTER = /[A-Za-z0-9_.$]/;
const API_NAME = /^[A-Za-z][A-Za-z0-9_]*$/;

/**
 * The words of the outer statement. A subquery sits in parentheses and a
 * literal in quotes, so a `FROM` in either is not this statement's; a field
 * such as `Valid_From__c` or `Account.From` is one word and is not a keyword.
 */
function outerWords(query: string): Word[] {
  const words: Word[] = [];
  let depth = 0;
  let i = 0;
  while (i < query.length) {
    const ch = query[i];
    if (ch === "'") {
      i++;
      while (i < query.length && query[i] !== "'") i += query[i] === '\\' ? 2 : 1;
      i++;
    } else if (ch === '(') {
      depth++;
      i++;
    } else if (ch === ')') {
      depth = Math.max(0, depth - 1);
      i++;
    } else if (WORD_CHARACTER.test(ch)) {
      const start = i;
      while (i < query.length && WORD_CHARACTER.test(query[i])) i++;
      if (depth === 0) words.push({ text: query.slice(start, i), start, end: i });
    } else {
      i++;
    }
  }
  return words;
}

/** Whether a clause of the statement starts at `words[at]`, by its first keyword or two. */
function startsClause(words: readonly Word[], at: number): boolean {
  const word = words[at].text.toLowerCase();
  const next = words[at + 1]?.text.toLowerCase();
  if (['where', 'with', 'having', 'limit', 'offset', 'for'].includes(word)) return true;
  if (word === 'group' || word === 'order') return next === 'by';
  if (word === 'all') return next === 'rows';
  if (word === 'using') return next === 'scope';
  return word === 'update' && (next === 'tracking' || next === 'viewstat');
}

/** `clause` with `change` applied to what lies outside its literals, which stay as written. */
function outsideLiterals(clause: string, change: (text: string) => string): string {
  return clause
    .split(/('(?:[^'\\]|\\.)*'?)/s)
    .map((part, at) => (at % 2 === 0 ? change(part) : part))
    .join('');
}

/**
 * A clause as Sync's own read can hold it: on one line, and without the alias,
 * which that read does not declare: `a.Name = 'x'` would be refused there.
 */
function asSyncClause(clause: string, alias: string | undefined): string {
  const qualified = alias ? new RegExp(`(?<![\\w.$])${alias}\\.`, 'gi') : undefined;
  return outsideLiterals(clause, (text) => {
    const oneLine = text.replace(/\s+/g, ' ');
    return qualified ? oneLine.replace(qualified, '') : oneLine;
  }).trim();
}

/**
 * Read an SFDMU query.
 *
 * @param query - The SOQL of an export's object, whatever its layout or case.
 * @returns What it selects from and how, each part as a Sync configuration
 *   holds it; no `object` when no outer FROM can be read.
 */
export function readSfdmuQuery(query: string): SfdmuQuery {
  const words = outerWords(query);
  const from = words.findIndex((word) => word.text.toLowerCase() === 'from');
  const object = words[from + 1];
  if (from < 0 || !object || !API_NAME.test(object.text)) return { otherClauses: [] };

  let at = from + 2;
  let alias: string | undefined;
  if (words[at] && !startsClause(words, at)) {
    const named = words[at].text.toLowerCase() === 'as' ? at + 1 : at;
    if (words[named] && API_NAME.test(words[named].text)) {
      alias = words[named].text;
      at = named + 1;
    }
  }

  const clauseStarts: number[] = [];
  for (let w = at; w < words.length; w++) {
    if (startsClause(words, w)) clauseStarts.push(w);
  }

  const read: SfdmuQuery = { object: object.text, otherClauses: [] };
  // What stands between the object and the first clause: `, c.Account a`.
  const afterObject = alias ? words[at - 1].end : object.end;
  const firstClause = clauseStarts.length > 0 ? words[clauseStarts[0]].start : query.length;
  const between = query.slice(afterObject, firstClause).trim();
  if (between !== '') read.otherClauses.push(between);

  clauseStarts.forEach((start, n) => {
    const end = n + 1 < clauseStarts.length ? words[clauseStarts[n + 1]].start : query.length;
    const keyword = words[start].text.toLowerCase();
    const text = query.slice(words[start].start, end).trim();
    if (keyword === 'where') {
      read.where = asSyncClause(text.slice('where'.length), alias);
    } else if (keyword === 'order') {
      read.orderBy = asSyncClause(text.replace(/^order\s+by/i, ''), alias);
    } else if (keyword === 'limit' && /^limit\s+\d+$/i.test(text)) {
      read.limit = Number(text.slice('limit'.length));
    } else {
      read.otherClauses.push(text);
    }
  });
  return read;
}
