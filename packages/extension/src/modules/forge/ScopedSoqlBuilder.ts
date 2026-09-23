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
 * back, those by ID first.
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

    if (opts.node.objectApiName === opts.rootObjectApiName) {
      const escapedId = sanitizeSoqlValue(opts.rootRecordId);
      return {
        statements: [`${prefix}Id = '${escapedId}'${extraSuffix}`],
        scoped: true,
        scope: 'root',
        reason: `root record${reasonSuffix}`,
        parentObjectsUsed: [opts.rootObjectApiName],
        scopeIdCount: 1,
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
    };
    if (ownCount > 0 && !opts.everyEdge) return selfCached;

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
      const parentIds = opts.cache.scopeOf(edge.sourceObject);
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
     */
    const requiredTerms: string[] = [];
    for (const field of opts.fields) {
      if (field.type !== 'reference' || field.nillable !== false) continue;
      const ids = new Set<string>();
      for (const target of field.referenceTo) {
        if (!opts.readObjects?.has(target)) continue;
        const cached = opts.cache.get(target);
        if (cached) for (const id of cached) ids.add(id);
      }
      if (ids.size === 0) continue;
      const values = [...ids].map((id) => `'${sanitizeSoqlValue(id)}'`).join(', ');
      requiredTerms.push(`${assertSoqlIdentifier(field.name)} IN (${values})`);
    }
    const requiredSuffix = requiredTerms.map((term) => ` AND (${term})`).join('');
    const scopedSuffix = `${requiredSuffix}${extraSuffix}`;
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
      };
    }

    // Wrap fk clauses in parens only when an extraWhere is appended, so
    // existing callers / snapshot tests aren't broken by gratuitous
    // parens. The extraWhere itself is always wrapped on its own.
    const fkStatements = packInClauses(
      {
        prefix,
        suffix: scopedSuffix,
        wrap: scopedSuffix !== '',
        objectApiName: opts.node.objectApiName,
      },
      fkClauses,
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
    };
  }

  private formatSelect(selectFields: string[]): string {
    if (selectFields.length === 0) return 'Id';
    return selectFields.map((f) => assertSoqlIdentifier(f)).join(', ');
  }
}

/**
 * Longest statement, measured as it travels in the request URI, that a scoped
 * query may reach.
 *
 * jsforce sends a query over GET with the SOQL percent-encoded into `?q=`, and
 * Salesforce refuses a request URI much past 16 000 characters. Encoding is
 * what makes an Id list expensive: `'001...AAA', ` is 22 characters in the
 * statement and 30 in the URI. The budget leaves room for the API path in
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
        throw new Error(
          `Scoped clone for ${frame.objectApiName} selects so many fields that a Salesforce ` +
            `query URI has no room left for a single record Id. Exclude fields from this ` +
            `object and run it again.`,
        );
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
