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
}

/** How the SOQL was scoped to the record-graph closure. */
export type ScopeKind =
  /** Root record query (`WHERE Id = '<rootRecordId>'`). */
  | 'root'
  /** This object already has IDs in the cache (from earlier wave). */
  | 'self-cached'
  /** Scoped via foreign-key fields pointing to cached parents. */
  | 'parent-fk'
  /** No scoping possible — the query was rewritten to return zero rows. */
  | 'unscoped';

/** Result returned by `ScopedSoqlBuilder.build`. */
export interface ScopedSoqlResult {
  /** The full SOQL string ready to be executed. */
  soql: string;
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
 * If none of the above applies, the query is rewritten to return zero rows
 * (`Id = NULL`) and the result is flagged `scoped: false` so the executor
 * can decide whether to skip the node entirely.
 */
export class ScopedSoqlBuilder {
  /** Build a scope-aware SOQL query for one graph node. */
  build(opts: ScopedSoqlBuildOpts): ScopedSoqlResult {
    const objectName = assertSoqlIdentifier(opts.node.objectApiName);
    const select = this.formatSelect(opts.selectFields);
    const extraSuffix = opts.extraWhere ? ` AND (${opts.extraWhere})` : '';
    const reasonSuffix = opts.extraWhere ? ' + extra filter' : '';

    if (opts.node.objectApiName === opts.rootObjectApiName) {
      const escapedId = sanitizeSoqlValue(opts.rootRecordId);
      return {
        soql: `SELECT ${select} FROM ${objectName} WHERE Id = '${escapedId}'${extraSuffix}`,
        scoped: true,
        scope: 'root',
        reason: `root record${reasonSuffix}`,
        parentObjectsUsed: [opts.rootObjectApiName],
        scopeIdCount: 1,
      };
    }

    const ownIds = opts.cache.get(opts.node.objectApiName);
    if (ownIds && ownIds.size > 0) {
      const idList = formatIdList(ownIds);
      return {
        soql: `SELECT ${select} FROM ${objectName} WHERE Id IN (${idList})${extraSuffix}`,
        scoped: true,
        scope: 'self-cached',
        reason: `${ownIds.size} ID(s) cached from earlier wave${reasonSuffix}`,
        parentObjectsUsed: [],
        scopeIdCount: ownIds.size,
      };
    }

    const fkClauses: string[] = [];
    const parentObjectsUsed: string[] = [];
    let totalScopeIds = 0;

    for (const edge of opts.edges) {
      if (edge.targetObject !== opts.node.objectApiName) continue;
      const parentIds = opts.cache.get(edge.sourceObject);
      if (!parentIds || parentIds.size === 0) continue;

      const fkFields = opts.fields.filter(
        (f) => f.type === 'reference' && f.referenceTo.includes(edge.sourceObject),
      );
      if (fkFields.length === 0) continue;

      const idList = formatIdList(parentIds);
      for (const fk of fkFields) {
        fkClauses.push(`${assertSoqlIdentifier(fk.name)} IN (${idList})`);
      }
      if (!parentObjectsUsed.includes(edge.sourceObject)) {
        parentObjectsUsed.push(edge.sourceObject);
        totalScopeIds += parentIds.size;
      }
    }

    if (fkClauses.length === 0) {
      return {
        soql: `SELECT ${select} FROM ${objectName} WHERE ${ZERO_RESULT_WHERE}`,
        scoped: false,
        scope: 'unscoped',
        reason: 'no parent in cache and not the root',
        parentObjectsUsed: [],
        scopeIdCount: 0,
      };
    }

    // Wrap fk clauses in parens only when an extraWhere is appended, so
    // existing callers / snapshot tests aren't broken by gratuitous
    // parens. The extraWhere itself is always wrapped on its own.
    const fkJoined = fkClauses.join(' OR ');
    const fkWrapped = extraSuffix ? `(${fkJoined})` : fkJoined;
    return {
      soql: `SELECT ${select} FROM ${objectName} WHERE ${fkWrapped}${extraSuffix}`,
      scoped: true,
      scope: 'parent-fk',
      reason: `via ${parentObjectsUsed.join(', ')}${reasonSuffix}`,
      parentObjectsUsed,
      scopeIdCount: totalScopeIds,
    };
  }

  private formatSelect(selectFields: string[]): string {
    if (selectFields.length === 0) return 'Id';
    return selectFields.map((f) => assertSoqlIdentifier(f)).join(', ');
  }
}

/** Format a set of IDs as a SOQL `IN` list with single-quoted, sanitized values. */
function formatIdList(ids: ReadonlySet<string>): string {
  const parts: string[] = [];
  for (const id of ids) {
    parts.push(`'${sanitizeSoqlValue(id)}'`);
  }
  return parts.join(', ');
}
