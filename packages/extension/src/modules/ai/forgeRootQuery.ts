/**
 * The check a Forge root query goes through before the user is offered it.
 *
 * Forge's AI tab asks the model for a query, and a model writes field names
 * as readily from memory as from the schema it was shown. Discovery reads
 * only the object after FROM, and the run filters that object with the WHERE
 * clause, so a filter naming a field the org does not have would be refused
 * well into the run, after the graph was walked and the plan reviewed. A
 * field the SELECT list invents is ignored by the run, and is checked all the
 * same: it is the plainest sign the draft was written from memory.
 *
 * So the query is checked here, against the org it is to be run on: the
 * object is one the org lets this user query, every field and relationship
 * the query names at its top level exists on it, and the org's own parser
 * accepts the query — asked through the REST `explain` parameter, which plans
 * a query without running it.
 */
import type { ForgePlanProblem } from '@sandforge/shared';
import { extractErrorMessage } from '../../core/common/extractErrorMessage.js';

/** What the check reads out of a query. */
export interface ForgeRootQueryParts {
  /** The object after the top-level FROM, as written. */
  objectApiName: string;
  /**
   * The fields and relationship paths the query names at its top level, first
   * spelling kept, each once: the plain items of the SELECT list (a function
   * over one field counts as that field) and the left-hand side of each WHERE
   * condition, with the object's alias taken off.
   *
   * A subquery, a TYPEOF block, a field inside a nested function call and
   * every value are left to the org's parser.
   */
  fieldRefs: string[];
}

/** An object as the check needs it described. */
export interface ForgeDescribedObject {
  /** API name. */
  name: string;
  /** Label, as the org gives it. */
  label: string;
  /** Every field, with the relationship name a lookup is followed by. */
  fields: ReadonlyArray<{ name: string; relationshipName?: string | null }>;
}

/** What the check asks the org. */
export interface ForgeRootCheckDeps {
  /** The org's queryable objects. */
  catalog: ReadonlyArray<{ name: string; label: string }>;
  /** Describe one object; throws what the org answered when it cannot. */
  describe(objectApiName: string): Promise<ForgeDescribedObject>;
  /** Have the org plan the query without running it; throws what the org answered. */
  explain(soql: string): Promise<unknown>;
}

/** What the check found. */
export interface ForgeRootCheck {
  /** The object after FROM, as the org names it once found. */
  rootObject?: string;
  /** Its label, once found. */
  rootLabel?: string;
  /** How many distinct fields and relationships were compared against the describe. */
  fieldsChecked: number;
  /** Everything found wrong; empty when the query holds up. */
  problems: ForgePlanProblem[];
}

/** Words that may follow the object after FROM. Any other word there is its alias. */
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

/** Words that end a WHERE clause at the top level of a query. */
const WORDS_AFTER_WHERE = new Set(['WITH', 'GROUP', 'ORDER', 'LIMIT', 'OFFSET', 'FOR', 'UPDATE']);

/** Words a condition's left-hand side can never be. */
const CONDITION_KEYWORDS = new Set(['AND', 'OR', 'NOT', 'WHERE']);

/** A field name or a relationship path: `Name`, `Account.Owner.Name`. */
const FIELD_PATH = /^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*$/;

/** A SELECT item that is a field or a path, with an optional alias after it. */
const SELECT_FIELD_ITEM = /^([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)(?:\s+[A-Za-z_]\w*)?$/;

/** A SELECT item that is one function over plain arguments, with an optional alias. */
const SELECT_FUNCTION_ITEM = /^[A-Za-z_]\w*\s*\(([^()]*)\)(?:\s+[A-Za-z_]\w*)?$/;

/**
 * The left-hand side of a WHERE condition: a field or a path followed by a
 * comparison. The multi-character operators come first so `<=` is not read
 * as `<`, and `IN` needs a word boundary so `INCLUDES` is not read as it.
 */
const CONDITION_LHS =
  /([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)\s*(?:!=|<>|<=|>=|=|<|>|\bNOT\s+IN\b|\bIN\b|\bLIKE\b|\bINCLUDES\b|\bEXCLUDES\b)/gi;

/** A word at the top level of a query, with its offsets. */
interface TopLevelWord {
  word: string;
  start: number;
  end: number;
}

/**
 * `soql` with every string literal emptied (`'…'` becomes `''`, `\'` does not
 * close it), so nothing quoted can pass for a keyword, a bracket or a comma.
 */
function maskLiterals(soql: string): string {
  let out = '';
  let i = 0;
  while (i < soql.length) {
    if (soql[i] !== "'") {
      out += soql[i];
      i++;
      continue;
    }
    i++;
    while (i < soql.length && soql[i] !== "'") i += soql[i] === '\\' ? 2 : 1;
    i++;
    out += "''";
  }
  return out;
}

/** An opening bracket that starts a subquery, matched at one position. */
const SUBQUERY_OPEN = /\(\s*SELECT\b/iy;

/**
 * `text` (literals already masked) with every bracketed subquery replaced by
 * `()`, whatever brackets it holds, so no field of another object — a
 * semi-join's, a child relationship's — is read as one of the root's. A
 * subquery left unclosed runs to the end.
 */
function maskSubqueries(text: string): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    SUBQUERY_OPEN.lastIndex = i;
    if (text[i] !== '(' || !SUBQUERY_OPEN.test(text)) {
      out += text[i];
      i++;
      continue;
    }
    let depth = 0;
    let j = i;
    for (; j < text.length; j++) {
      if (text[j] === '(') depth++;
      else if (text[j] === ')' && --depth === 0) break;
    }
    out += '()';
    i = j + 1;
  }
  return out;
}

/** The words of `text` outside every bracket. */
function topLevelWords(text: string): TopLevelWord[] {
  const words: TopLevelWord[] = [];
  let depth = 0;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '(') {
      depth++;
      i++;
    } else if (ch === ')') {
      depth = Math.max(0, depth - 1);
      i++;
    } else if (/\w/.test(ch)) {
      const start = i;
      while (i < text.length && /\w/.test(text[i])) i++;
      if (depth === 0) words.push({ word: text.slice(start, i), start, end: i });
    } else {
      i++;
    }
  }
  return words;
}

/** `text` cut at every comma outside a bracket. */
function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let from = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '(') depth++;
    else if (text[i] === ')') depth = Math.max(0, depth - 1);
    else if (text[i] === ',' && depth === 0) {
      parts.push(text.slice(from, i));
      from = i + 1;
    }
  }
  parts.push(text.slice(from));
  return parts;
}

/** The field a SELECT item names, or null when it names none this check reads. */
function selectItemRef(item: string): string | null {
  const field = SELECT_FIELD_ITEM.exec(item);
  if (field) return field[1];
  const call = SELECT_FUNCTION_ITEM.exec(item);
  if (call) {
    const argument = call[1].trim();
    return FIELD_PATH.test(argument) ? argument : null;
  }
  return null;
}

/**
 * Read the object and the field references of a query.
 *
 * Returns null when the query does not start with SELECT or names no object
 * after a top-level FROM.
 */
export function readForgeRootQuery(soql: string): ForgeRootQueryParts | null {
  const masked = maskSubqueries(maskLiterals(soql)).replace(/\bTYPEOF\b[\s\S]*?\bEND\b/gi, '()');
  const words = topLevelWords(masked);
  const upper = (k: number): string | undefined => words[k]?.word.toUpperCase();
  if (upper(0) !== 'SELECT') return null;
  const fromAt = words.findIndex((w) => w.word.toUpperCase() === 'FROM');
  if (fromAt < 1 || fromAt + 1 >= words.length) return null;
  const objectApiName = words[fromAt + 1].word;

  // The name a query may prefix its paths with: an alias, and the object itself.
  const prefixes = new Set([objectApiName.toUpperCase()]);
  const aliasAt = upper(fromAt + 2) === 'AS' ? fromAt + 3 : fromAt + 2;
  const aliasWord = upper(aliasAt);
  const betweenObjectAndAlias = masked.slice(words[fromAt + 1].end, words[aliasAt]?.start);
  if (aliasWord && !WORDS_AFTER_OBJECT.has(aliasWord) && !betweenObjectAndAlias.includes(',')) {
    prefixes.add(aliasWord);
  }

  const refs: string[] = [];
  const selectList = masked.slice(words[0].end, words[fromAt].start);
  for (const item of splitTopLevel(selectList)) {
    const ref = selectItemRef(item.trim());
    if (ref) refs.push(ref);
  }

  const whereAt = words.findIndex((w, k) => k > fromAt + 1 && w.word.toUpperCase() === 'WHERE');
  if (whereAt >= 0) {
    const endAt = words.findIndex((_w, k) => k > whereAt && WORDS_AFTER_WHERE.has(upper(k) ?? ''));
    const where = masked.slice(words[whereAt].end, endAt < 0 ? masked.length : words[endAt].start);
    for (const match of where.matchAll(CONDITION_LHS)) {
      if (!CONDITION_KEYWORDS.has(match[1].toUpperCase())) refs.push(match[1]);
    }
  }

  const seen = new Set<string>();
  const fieldRefs: string[] = [];
  for (const ref of refs) {
    const [head, ...rest] = ref.split('.');
    const bare = rest.length > 0 && prefixes.has(head.toUpperCase()) ? rest.join('.') : ref;
    const key = bare.toUpperCase();
    if (seen.has(key)) continue;
    seen.add(key);
    fieldRefs.push(bare);
  }
  return { objectApiName, fieldRefs };
}

/**
 * Check a Forge root query against the org it is to be run on.
 *
 * Stops at the first step that leaves nothing further to ask: no object, an
 * object the org does not have, or one it will not describe. The org's
 * parser is only asked once every name the query holds was found, so a
 * missing field is reported once, by name, rather than again in the org's
 * words.
 *
 * @param soql - The query, as the user will run it.
 * @param deps - The org's catalog, describe and query planner.
 * @returns What the check found.
 */
export async function checkForgeRootQuery(
  soql: string,
  deps: ForgeRootCheckDeps,
): Promise<ForgeRootCheck> {
  const parts = readForgeRootQuery(soql);
  if (!parts) return { fieldsChecked: 0, problems: [{ kind: 'no-from' }] };

  const wanted = parts.objectApiName.toLowerCase();
  const entry = deps.catalog.find((c) => c.name.toLowerCase() === wanted);
  if (!entry) {
    return {
      rootObject: parts.objectApiName,
      fieldsChecked: 0,
      problems: [{ kind: 'object-missing', object: parts.objectApiName }],
    };
  }

  let described: ForgeDescribedObject;
  try {
    described = await deps.describe(entry.name);
  } catch (err: unknown) {
    return {
      rootObject: entry.name,
      rootLabel: entry.label,
      fieldsChecked: 0,
      problems: [{ kind: 'describe-failed', object: entry.name, detail: extractErrorMessage(err) }],
    };
  }

  const fieldNames = new Set(described.fields.map((f) => f.name.toLowerCase()));
  const relationships = new Set(
    described.fields.flatMap((f) => (f.relationshipName ? [f.relationshipName.toLowerCase()] : [])),
  );
  const problems: ForgePlanProblem[] = [];
  const reportedRelationships = new Set<string>();
  for (const ref of parts.fieldRefs) {
    const [head, ...rest] = ref.split('.');
    if (rest.length === 0) {
      if (!fieldNames.has(head.toLowerCase())) {
        problems.push({ kind: 'field-missing', object: entry.name, field: head });
      }
    } else if (
      !relationships.has(head.toLowerCase()) &&
      !reportedRelationships.has(head.toLowerCase())
    ) {
      reportedRelationships.add(head.toLowerCase());
      problems.push({ kind: 'relationship-missing', object: entry.name, relationship: head });
    }
  }

  if (problems.length === 0) {
    try {
      await deps.explain(soql);
    } catch (err: unknown) {
      problems.push({ kind: 'org-refused', detail: extractErrorMessage(err) });
    }
  }

  return {
    rootObject: entry.name,
    rootLabel: described.label || entry.label,
    fieldsChecked: parts.fieldRefs.length,
    problems,
  };
}
