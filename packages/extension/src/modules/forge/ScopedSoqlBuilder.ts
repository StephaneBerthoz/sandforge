import type { ForgeGraphEdge, ForgeGraphNode } from '@sandforge/shared';
import { assertSoqlIdentifier, sanitizeSoqlValue } from '../../core/common/soqlValidator.js';
import type { RecordScopeCache } from './RecordScopeCache.js';

/**
 * Field metadata required to scope a SOQL query against a parent set.
 * Subset of `FieldDescribeInfo` from describe APIs.
 */
export interface ScopableField {
  /** API name of the field (e.g. `AccountId`). */
  name: string;
  /** Field type — only `'reference'` participates in scope construction. */
  type: string;
  /** Objects this field references (one for monomorphic, many for polymorphic). */
  referenceTo: string[];
  /**
   * Whether the field accepts null. `false` means a row that does not carry
   * it cannot be written, which makes it worth filtering a read by.
   */
  nillable?: boolean;
}

/** How the SOQL was scoped to the record-graph closure. */
export type ScopeKind =
  /** Root record query (`WHERE Id = '<rootRecordId>'`). */
  | 'root'
  /** This object already has IDs in the cache (from earlier wave). */
  | 'self-cached'
  /** Scoped via foreign-key fields pointing to cached parents. */
  | 'parent-fk'
  /**
   * Both of the above, when the build asks for every edge: the IDs cached
   * for this object, then its rows whose foreign key points at a cached
   * parent.
   */
  | 'self-and-parent-fk'
  /** No scoping possible — the query was rewritten to return zero rows. */
  | 'unscoped';

/** Result returned by `ScopedSoqlBuilder.build`. */
export interface ScopedSoqlResult {
  /**
   * The SOQL to execute, in order. One statement unless the scope is too
   * large for a single query URI, in which case the Id lists are split across
   * several statements whose results the caller merges by `Id` (a row that
   * matches two FK clauses can come back from two statements).
   */
  statements: string[];
  /** True when a real scope restriction was applied (any kind except `unscoped`). */
  scoped: boolean;
  /** How the scope was determined. */
  scope: ScopeKind;
  /** Human-readable explanation — used by the recipe and progress logs. */
  reason: string;
  /** Parent objects whose IDs were used to build the WHERE. */
  parentObjectsUsed: string[];
  /** Number of distinct IDs referenced in the WHERE clause (0 for `unscoped`). */
  scopeIdCount: number;
  /**
   * How many of `statements`, from the first, read rows by the IDs rows
   * already read point at. The others read the root, or rows under a parent
   * in scope: rows the run reached from above.
   */
  byIdCount: number;
}

/** Inputs to `ScopedSoqlBuilder.build`. */
export interface ScopedSoqlBuildOpts {
  /** The graph node we are about to query. */
  node: ForgeGraphNode;
  /** Field metadata for the node (subset suitable for scope detection). */
  fields: ScopableField[];
  /** Already filtered list of fields to include in the SELECT clause. */
  selectFields: string[];
  /** All edges from the discovery graph (parent→child convention). */
  edges: readonly ForgeGraphEdge[];
  /** Cache of IDs collected by previous waves. */
  cache: RecordScopeCache;
  /** API name of the root object (the one matching `recordId`). */
  rootObjectApiName: string;
  /** The original record ID supplied by the user. */
  rootRecordId: string;
  /**
   * Optional extra WHERE-clause fragment appended via `AND (...)` after the
   * scope-derived clause. Used by per-object filters from `ForgeConfig`
   * (e.g. `Status = 'Open' AND CreatedDate > LAST_N_DAYS:30`). The fragment
   * is wrapped in parens so a top-level `OR` doesn't escape the AND scope.
   * Caller is responsible for length-bounding via Zod (see schema).
   */
  extraWhere?: string;
  /**
   * Read an object that has IDs cached through every edge that reaches it:
   * the rows those IDs name, and its rows under a cached parent. Left off, the
   * cached IDs alone decide the read and its foreign keys are not consulted.
   */
  everyEdge?: boolean;
  /**
   * The objects whose records this run reads, or otherwise holds a target
   * record for: the included nodes of its graph. Only a required lookup at
   * one of them narrows a read. Left off, none does.
   */
  readObjects?: ReadonlySet<string>;
  /**
   * Objects every record that points at them shares: price books, products
   * and their prices. Left off, none is.
   *
   * A row of one brings the rows under it only when the run reached it from
   * above — the root, or a row read under a parent in scope
   * (`RecordScopeCache.addReached`). One the run only met through a lookup is
   * read so that what points at it can be written, and brings nothing: an
   * opportunity's price book is also the book of every other sale priced
   * from it. Read as any parent in scope is, it brought its every price, and
   * the products of all of them, into the clone of one opportunity.
   *
   * And a required lookup at one of them whose read is still to come does not
   * narrow a read. That read takes the rows the lookup names, so there is
   * nothing to hold the row to yet — and what the run had named of it so far
   * would drop a quote line whose price no line read before had named.
   */
  catalog?: ReadonlySet<string>;
  /**
   * The root's object is read a second time, for the rows of it the records
   * read since name: by the IDs cached for it, the root's among them, rather
   * than by the root's ID alone. By ID only, as the root is: no row of the
   * object is read under a parent. Ignored for any other object.
   */
  rootReadAgain?: boolean;
}

/**
 * Default zero-result clause appended when no scoping path is available.
 * Using a literal NULL comparison avoids accidentally pulling unrelated rows
 * while still returning a valid SOQL query.
 */
const ZERO_RESULT_WHERE = 'Id = NULL';

/**
 * Builds a SOQL query restricted to the transitive closure of the root record.
 *
 * For each node in the topologically sorted graph, the builder picks one of
 * three strategies in order of preference:
 *
 *   1. **root**        — the node *is* the root record → `WHERE Id = ?`.
 *   2. **self-cached** — the cache already contains IDs for this node (the
 *                        executor seeded them via lookup-field extraction in
 *                        an earlier wave) → `WHERE Id IN (...)`.
 *   3. **parent-fk**   — the node has at least one reference field pointing
 *                        at a parent whose IDs are in the cache → `WHERE
 *                        FK1 IN (...) OR FK2 IN (...)`.
 *
 * With `everyEdge`, 2 and 3 are not alternatives: a node with cached IDs is
 * read through its reference fields as well, and the statements of both come
 * back, those by ID first. The root's object, read again (`rootReadAgain`),
 * is read by its cached IDs alone.
 *
 * If none of the above applies, the query is rewritten to return zero rows
 * (`Id = NULL`) and the result is flagged `scoped: false` so the executor
 * can decide whether to skip the node entirely.
 */
/**
 * The verdict for a node that is neither the root nor reachable from anything
 * read so far.
 *
 * It is not a permanent answer: a node can be an ancestor whose IDs only
 * become known once a descendant has been read, so the executor defers a node
 * with this verdict and asks again at the end of the pass. Named rather than
 * matched as a string so the two files cannot drift apart.
 */
export const UNSCOPED_NO_PARENT_REASON = 'no parent in cache and not the root';

export class ScopedSoqlBuilder {
  /** Build a scope-aware SOQL query for one graph node. */
  build(opts: ScopedSoqlBuildOpts): ScopedSoqlResult {
    const objectName = assertSoqlIdentifier(opts.node.objectApiName);
    const select = this.formatSelect(opts.selectFields);
    const extraSuffix = opts.extraWhere ? ` AND (${opts.extraWhere})` : '';
    const reasonSuffix = opts.extraWhere ? ' + extra filter' : '';
    const prefix = `SELECT ${select} FROM ${objectName} WHERE `;

    const root = opts.node.objectApiName === opts.rootObjectApiName;
    if (root && !(opts.rootReadAgain && opts.cache.has(opts.node.objectApiName))) {
      const escapedId = sanitizeSoqlValue(opts.rootRecordId);
      return {
        statements: [`${prefix}Id = '${escapedId}'${extraSuffix}`],
        scoped: true,
        scope: 'root',
        reason: `root record${reasonSuffix}`,
        parentObjectsUsed: [opts.rootObjectApiName],
        scopeIdCount: 1,
        byIdCount: 0,
      };
    }

    const ownIds = opts.cache.get(opts.node.objectApiName);
    const ownCount = ownIds?.size ?? 0;
    const ownStatements =
      ownIds && ownCount > 0
        ? packInClauses(
            { prefix, suffix: extraSuffix, wrap: false, objectApiName: opts.node.objectApiName },
            [{ field: 'Id', ids: ownIds }],
          )
        : [];
    const ownReason = `${ownCount} ID(s) cached from earlier wave`;
    const selfCached: ScopedSoqlResult = {
      statements: ownStatements,
      scoped: true,
      scope: 'self-cached',
      reason: `${ownReason}${reasonSuffix}`,
      parentObjectsUsed: [],
      scopeIdCount: ownCount,
      byIdCount: ownStatements.length,
    };
    if (ownCount > 0 && (!opts.everyEdge || root)) return selfCached;

    const fkClauses: InClause[] = [];
    const parentObjectsUsed: string[] = [];
    let totalScopeIds = 0;

    for (const edge of opts.edges) {
      if (edge.targetObject !== opts.node.objectApiName) continue;
      // A lookup from an object to itself (`ParentId`, `ReportsToId`) brings
      // nothing: discovery keeps no such edge, and read under this node's own
      // cached IDs it would take one level of a hierarchy — a key contact's
      // reports, and not theirs.
      if (edge.sourceObject === edge.targetObject) continue;
      // The parent's scope, not every ID met for it: one met after the parent
      // was read names a row no read fetches, and its children are not ours.
      // Of a catalog parent, only the rows the run reached from above.
      const parentIds = opts.catalog?.has(edge.sourceObject)
        ? opts.cache.reachedOf(edge.sourceObject)
        : opts.cache.scopeOf(edge.sourceObject);
      if (!parentIds || parentIds.size === 0) continue;

      const fkFields = opts.fields.filter(
        (f) => f.type === 'reference' && f.referenceTo.includes(edge.sourceObject),
      );
      if (fkFields.length === 0) continue;

      for (const fk of fkFields) {
        fkClauses.push({ field: assertSoqlIdentifier(fk.name), ids: parentIds });
      }
      if (!parentObjectsUsed.includes(edge.sourceObject)) {
        parentObjectsUsed.push(edge.sourceObject);
        totalScopeIds += parentIds.size;
      }
    }

    /**
     * Rows the write is bound to refuse are not worth reading.
     *
     * Scope is an OR across the parents in hand, which is right for finding
     * the closure and wrong for what comes of it: a price book entry reached
     * through its product satisfies the OR while belonging to a price book
     * nothing in this run will create. Run for real, that is what came back —
     * entries whose required `Pricebook2Id` pointed outside the graph, read,
     * carried all the way to the insert and refused there.
     *
     * So each lookup the platform will not let the row omit, whose target
     * this run reads, is required to land inside what the run has of it.
     * A target with nothing cached is left alone: there is nothing to
     * restrict against, and an empty IN list would select no rows at all.
     * Only the rows found through a parent are narrowed — the root must be
     * read whatever it points at, and cached ids came from a row that was
     * read, which needs the row they name whatever that row points at.
     *
     * A target the run never reads says nothing about which rows belong to
     * the clone, even though every lookup at it caches the ids it meets.
     * `OwnerId`, `CreatedById` and `LastModifiedById` are required lookups at
     * a `User`: held to the users the rows read before happened to name, a
     * contact created by anyone else was left out of the clone, without an
     * error.
     *
     * A catalog object whose read is still to come holds nothing back either:
     * it is read by the ids the rows name, this row's among them (see
     * `catalog`).
     */
    const requiredTerms: InClause[] = [];
    for (const field of opts.fields) {
      if (field.type !== 'reference' || field.nillable !== false) continue;
      const ids = new Set<string>();
      for (const target of field.referenceTo) {
        if (!opts.readObjects?.has(target)) continue;
        if (opts.catalog?.has(target) && !opts.cache.isRead(target)) continue;
        const cached = opts.cache.get(target);
        if (cached) for (const id of cached) ids.add(id);
      }
      if (ids.size === 0) continue;
      requiredTerms.push({ field: assertSoqlIdentifier(field.name), ids });
    }
    const requiredReason = requiredTerms.length > 0 ? ' + required parents in scope' : '';

    if (fkClauses.length === 0) {
      if (ownCount > 0) return selfCached;
      return {
        statements: [`${prefix}${ZERO_RESULT_WHERE}`],
        scoped: false,
        scope: 'unscoped',
        reason: UNSCOPED_NO_PARENT_REASON,
        parentObjectsUsed: [],
        scopeIdCount: 0,
        byIdCount: 1,
      };
    }

    const fkStatements = narrowedStatements(
      { prefix, extraSuffix, objectApiName: opts.node.objectApiName },
      fkClauses,
      requiredTerms,
    );
    const viaReason = `via ${parentObjectsUsed.join(', ')}${reasonSuffix}${requiredReason}`;
    if (ownCount === 0) {
      return {
        statements: fkStatements,
        scoped: true,
        scope: 'parent-fk',
        reason: viaReason,
        parentObjectsUsed,
        scopeIdCount: totalScopeIds,
        byIdCount: 0,
      };
    }

    /**
     * An object reached both ways is read both ways.
     *
     * Its cached ids are the rows something already read points at; its
     * foreign keys find its rows under the parents in scope. Either alone
     * misses rows: an account's lookup to a contact made Contact a cached
     * object, and run against a sandbox the clone took the one contact the
     * account named and left out its sibling, whose `AccountId` was the root.
     *
     * Kept as two sets of statements rather than one OR: the rows named by id
     * are not narrowed to the required parents in scope, and under a
     * per-object cap they are read first, so the rows already read find what
     * they point at. A row both sets return is kept once — the caller merges
     * the statements by `Id`.
     */
    return {
      statements: [...ownStatements, ...fkStatements],
      scoped: true,
      scope: 'self-and-parent-fk',
      reason: `${ownReason}, and ${viaReason}`,
      parentObjectsUsed,
      scopeIdCount: ownCount + totalScopeIds,
      byIdCount: ownStatements.length,
    };
  }

  /**
   * Rows of an object whose two lookups both land among the ids given: the
   * rows that join two sets of records the run holds.
   *
   * The ids of `split` are laid over as many statements as fit a query URI;
   * those of `whole` are carried by every statement, so `whole` has to be
   * the short list — a handful of selling models against the products.
   */
  buildJoining(opts: JoiningOpts): string[] {
    const objectName = assertSoqlIdentifier(opts.objectApiName);
    const prefix = `SELECT ${this.formatSelect(opts.selectFields)} FROM ${objectName} WHERE `;
    const extraSuffix = opts.extraWhere ? ` AND (${opts.extraWhere})` : '';
    return narrowedStatements(
      { prefix, extraSuffix, objectApiName: opts.objectApiName },
      [{ field: assertSoqlIdentifier(opts.split.field), ids: opts.split.ids }],
      [{ field: assertSoqlIdentifier(opts.whole.field), ids: opts.whole.ids }],
    );
  }

  private formatSelect(selectFields: string[]): string {
    if (selectFields.length === 0) return 'Id';
    return selectFields.map((f) => assertSoqlIdentifier(f)).join(', ');
  }
}

/** Inputs to {@link ScopedSoqlBuilder.buildJoining}. */
export interface JoiningOpts {
  /** The object read. */
  objectApiName: string;
  /** Fields of the SELECT clause. */
  selectFields: string[];
  /** The lookup whose ids are split over statements, and the ids. */
  split: { field: string; ids: ReadonlySet<string> };
  /** The lookup every statement carries whole, and the ids. */
  whole: { field: string; ids: ReadonlySet<string> };
  /** Extra WHERE fragment, appended as `AND (...)` as in {@link ScopedSoqlBuildOpts}. */
  extraWhere?: string;
}

/**
 * Longest statement, measured as it travels in the request URI, that a scoped
 * query may reach.
 *
 * jsforce sends a query over GET with the SOQL percent-encoded into `?q=`, and
 * Salesforce refuses a request URI much past 16 000 characters. Encoding is
 * what makes an Id list expensive: `'001...AAA', ` is 22 characters in the
 * statement and 26 in the URI, where the comma and the space are encoded and
 * the quotes are not. The budget leaves room for the API path in
 * front of the query and the ` LIMIT N` a per-object cap appends after it.
 */
export const MAX_STATEMENT_URI_CHARS = 15_800;

/**
 * Most Ids one statement carries even when the URI would take more. Keeps a
 * single statement's result set, and the cost of retrying it, modest.
 */
export const MAX_IDS_PER_STATEMENT = 500;

/** One `field IN (...)` term of a scoped WHERE clause. */
interface InClause {
  /** Validated API name of the filtered field. */
  field: string;
  /** Ids the field is matched against. */
  ids: ReadonlySet<string>;
}

/** The fixed parts of every statement {@link packInClauses} emits. */
interface StatementFrame {
  /** `SELECT ... FROM ... WHERE `. */
  prefix: string;
  /** ` AND (extraWhere)`, or empty. */
  suffix: string;
  /** Parenthesise the OR-joined clauses so the suffix's AND binds to all of them. */
  wrap: boolean;
  /** Named in the error when not even one Id fits. */
  objectApiName: string;
}

/** Characters `text` occupies once percent-encoded into a query URI. */
export function uriLength(text: string): number {
  return encodeURIComponent(text).length;
}

/** What every statement of one read carries around the clauses it is given. */
interface NarrowedFrame {
  /** `SELECT ... FROM ... WHERE `. */
  prefix: string;
  /** ` AND (extraWhere)`, or empty. */
  extraSuffix: string;
  /** Named in the error when not even one Id fits. */
  objectApiName: string;
}

/** ` AND (field IN (...))` for one narrowing term. */
function narrowingTerm(term: InClause, ids: Iterable<string>): string {
  const values = [...ids].map((id) => `'${sanitizeSoqlValue(id)}'`).join(', ');
  return ` AND (${term.field} IN (${values}))`;
}

/** Whether every row `clause` selects is one `narrowing` holds already: the same field, among its ids. */
function implies(clause: InClause, narrowing: InClause): boolean {
  if (clause.field !== narrowing.field) return false;
  for (const id of clause.ids) if (!narrowing.ids.has(id)) return false;
  return true;
}

/**
 * The lists `term`'s ids are cut into, so that none takes more than `budget`
 * characters of a query URI once written as a narrowing term.
 *
 * @throws Error when not even one id fits the budget.
 */
function narrowingLists(term: InClause, budget: number, objectApiName: string): string[][] {
  const frame = uriLength(narrowingTerm(term, []));
  const separator = uriLength(', ');
  const lists: string[][] = [];
  let list: string[] = [];
  let length = frame;
  for (const id of term.ids) {
    const value = uriLength(`'${sanitizeSoqlValue(id)}'`);
    if (list.length > 0 && length + separator + value > budget) {
      lists.push(list);
      list = [];
      length = frame;
    }
    if (list.length === 0 && frame + value > budget) throw noRoomLeft(objectApiName);
    length += (list.length > 0 ? separator : 0) + value;
    list.push(id);
  }
  if (list.length > 0) lists.push(list);
  return lists;
}

/** Every combination of one list per term, written as the narrowing suffix of a statement. */
function narrowingSuffixes(
  terms: readonly InClause[],
  budget: number,
  objectApiName: string,
): string[] {
  let suffixes = [''];
  for (const term of terms) {
    const lists = narrowingLists(term, budget / terms.length, objectApiName);
    suffixes = suffixes.flatMap((suffix) =>
      lists.map((list) => suffix + narrowingTerm(term, list)),
    );
  }
  return suffixes;
}

/**
 * The statements that read the rows `clauses` select — OR-joined — whose
 * `narrowing` lookups — AND-joined — all land among their ids, each within
 * the URI budget.
 *
 * A narrowing written whole into every statement took the room the clauses
 * were to be split into, and past some five hundred parent ids it took more
 * than a query URI holds: the read threw before a single row was read, blaming
 * the field list. Where the narrowing fits in half the room a statement
 * leaves, it is still carried whole, as it always was. Past that, a clause on
 * the narrowed field itself, whose ids all lie among the narrowing's, already
 * holds its rows to it and is read without it — an order's items read under
 * the orders in scope need no second list of the same orders. What the other
 * clauses still need is cut into lists that fit, and they are read under each
 * combination of those lists. The rows are those of the single statement that
 * no URI could carry; a row two statements return is kept once by the caller.
 *
 * @throws Error when the fixed part of a statement leaves no room for a
 *   single Id — only a field list of many hundreds of long names gets there.
 */
function narrowedStatements(
  frame: NarrowedFrame,
  clauses: readonly InClause[],
  narrowing: readonly InClause[],
): string[] {
  const pack = (suffix: string, packed: readonly InClause[]): string[] =>
    // Wrap the clauses in parens only when something is appended, so a read
    // with nothing to add keeps the statement it always had.
    packInClauses(
      { prefix: frame.prefix, suffix, wrap: suffix !== '', objectApiName: frame.objectApiName },
      packed,
    );
  const whole = narrowing.map((term) => narrowingTerm(term, term.ids)).join('');
  const room = MAX_STATEMENT_URI_CHARS - uriLength(`${frame.prefix}()${frame.extraSuffix}`);
  if (uriLength(whole) <= room / 2) return pack(`${whole}${frame.extraSuffix}`, clauses);

  const groups = new Map<string, { needed: InClause[]; clauses: InClause[] }>();
  for (const clause of clauses) {
    const needed = narrowing.filter((term) => !implies(clause, term));
    const key = needed.map((term) => term.field).join('|');
    const group = groups.get(key) ?? { needed, clauses: [] };
    group.clauses.push(clause);
    groups.set(key, group);
  }
  const statements: string[] = [];
  for (const group of groups.values()) {
    for (const suffix of narrowingSuffixes(group.needed, room / 2, frame.objectApiName)) {
      statements.push(...pack(`${suffix}${frame.extraSuffix}`, group.clauses));
    }
  }
  return statements;
}

/** The error a statement with no room left for a single Id is refused with. */
function noRoomLeft(objectApiName: string): Error {
  return new Error(
    `Scoped clone for ${objectApiName} selects so many fields that a Salesforce ` +
      `query URI has no room left for a single record Id. Exclude fields from this ` +
      `object and run it again.`,
  );
}

/**
 * Lay `clauses` out over as few statements as fit the URI budget.
 *
 * The clauses of one statement are OR-joined, so splitting an Id list across
 * statements selects exactly the union of the rows the single unsplit query
 * would have selected. A small scope still produces the one statement it
 * always did; a large one is cut wherever the next Id would push the
 * statement past {@link MAX_STATEMENT_URI_CHARS} or
 * {@link MAX_IDS_PER_STATEMENT}.
 *
 * This replaces a hard stop at 600 Ids per list, which was both too strict —
 * a clone with more than 600 children refused to run at all — and not strict
 * enough, because the list was repeated once per FK field and three fields
 * near the cap still overflowed the URI.
 *
 * @throws Error when the fixed part of the statement leaves no room for a
 *   single Id — only a field list of many hundreds of long names gets there.
 */
function packInClauses(frame: StatementFrame, clauses: readonly InClause[]): string[] {
  const open = frame.wrap ? '(' : '';
  const close = frame.wrap ? ')' : '';
  const frameLength = uriLength(frame.prefix + open + close + frame.suffix);
  const separatorLength = uriLength(', ');
  const orLength = uriLength(' OR ');

  const statements: string[] = [];
  let terms: Array<{ field: string; values: string[] }> = [];
  let length = frameLength;
  let idCount = 0;

  const flush = (): void => {
    const where = terms.map((t) => `${t.field} IN (${t.values.join(', ')})`).join(' OR ');
    statements.push(`${frame.prefix}${open}${where}${close}${frame.suffix}`);
    terms = [];
    length = frameLength;
    idCount = 0;
  };

  for (const clause of clauses) {
    const clauseFrameLength = uriLength(`${clause.field} IN ()`);
    // A clause cut by a flush reopens as a new term in the next statement.
    let continuesTerm = false;
    for (const id of clause.ids) {
      const value = `'${sanitizeSoqlValue(id)}'`;
      const valueLength = uriLength(value);
      let cost = continuesTerm
        ? separatorLength + valueLength
        : (terms.length > 0 ? orLength : 0) + clauseFrameLength + valueLength;

      const full = length + cost > MAX_STATEMENT_URI_CHARS || idCount >= MAX_IDS_PER_STATEMENT;
      if (terms.length > 0 && full) {
        flush();
        continuesTerm = false;
        cost = clauseFrameLength + valueLength;
      }
      if (terms.length === 0 && length + cost > MAX_STATEMENT_URI_CHARS) {
        throw noRoomLeft(frame.objectApiName);
      }

      if (continuesTerm) {
        terms[terms.length - 1].values.push(value);
      } else {
        terms.push({ field: clause.field, values: [value] });
        continuesTerm = true;
      }
      length += cost;
      idCount++;
    }
  }
  if (terms.length > 0) flush();
  return statements;
}
