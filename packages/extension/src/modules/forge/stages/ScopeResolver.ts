/**
 * Scope resolution stage of the Forge execution pipeline.
 *
 * Owns everything that decides *which* records a node pulls from the source
 * org: topological ordering of the graph (parents before children, root
 * first in record-scoped mode), scoped vs full-table SOQL construction
 * (including the per-object `LIMIT` cap), and scope-cache seeding so
 * downstream waves can follow FK values back to the root.
 */

import type { ForgeGraph, ForgeGraphEdge, ForgeGraphNode } from '@sandforge/shared';
import type { FieldInfo } from '../ForgeExecutor.js';
import { assertSoqlIdentifier } from '../../../core/common/soqlValidator.js';
import type { RecordScopeCache } from '../RecordScopeCache.js';
import type { ScopedSoqlBuilder } from '../ScopedSoqlBuilder.js';

/**
 * Order graph nodes for execution: parents before children (Kahn's
 * algorithm), with the root object brought to the front when
 * `rootObjectApiName` is provided (record-scoped mode).
 *
 * @throws Error when the root is missing from the graph or excluded.
 */
export function sortNodesForExecution(
  graph: ForgeGraph,
  rootObjectApiName?: string,
): ForgeGraphNode[] {
  const sorted = topologicalSort(graph);
  return rootObjectApiName ? bringRootToFront(sorted, rootObjectApiName) : sorted;
}

/**
 * Order nodes for writing: every parent a child cannot do without comes
 * first.
 *
 * Kahn's algorithm cannot order the members of a cycle, so it appends them in
 * whatever order the map holds — and a graph of a real org is full of cycles
 * made of optional lookups. That is survivable for a lookup, which is
 * nullified at insert and repaired by the second pass, and fatal for one the
 * platform will not let the record omit: the insert is refused outright and
 * there is nothing left to repair. Run between two sandboxes, that is what
 * kept every line item of a cloned opportunity out of the target — it landed
 * in the same cycle bucket as the price book entry it could not be written
 * without, and went first.
 *
 * So the order is settled on the required edges alone, which in practice do
 * not form cycles, and the optional ones only break ties. A graph with no
 * required edges sorts exactly as before.
 */
export function sortNodesForWriting(graph: ForgeGraph): ForgeGraphNode[] {
  const requiredEdges = graph.edges.filter((e) => e.required === true);
  if (requiredEdges.length === 0) return topologicalSort(graph);
  const byRequired = topologicalSort(graph, requiredEdges);
  const rank = new Map<string, number>();
  byRequired.forEach((node, index) => rank.set(node.objectApiName, index));
  // Within what the required edges leave free, keep the full order so an
  // optional parent still tends to come before its child.
  const full = topologicalSort(graph);
  return [...full].sort(
    (a, b) =>
      (rank.get(a.objectApiName) ?? 0) - (rank.get(b.objectApiName) ?? 0) ||
      full.indexOf(a) - full.indexOf(b),
  );
}

/**
 * Get the parent object names for a given object based on graph edges.
 * A parent is an object that appears as sourceObject in an edge
 * where the given object is the targetObject.
 */
export function getParentObjects(objectApiName: string, graph: ForgeGraph): string[] {
  return graph.edges.filter((e) => e.targetObject === objectApiName).map((e) => e.sourceObject);
}

/** Inputs for {@link buildNodeQuery}. */
export interface NodeQueryInput {
  /** The graph node about to be queried. */
  node: ForgeGraphNode;
  /** All edges from the discovery graph (parent→child convention). */
  edges: readonly ForgeGraphEdge[];
  /** Source-org field metadata for the node. */
  fieldInfos: FieldInfo[];
  /** Scoped SOQL builder — present only in record-scoped mode. */
  scopedBuilder: ScopedSoqlBuilder | null;
  /** Scope cache — present only in record-scoped mode. */
  scopeCache: RecordScopeCache | null;
  /** API name of the root object (scoped mode). */
  rootObjectApiName?: string;
  /** The original record ID supplied by the user (scoped mode). */
  rootRecordId?: string;
  /** Per-object extra WHERE fragment (`ExecuteOptions.objectSoqlFilters`). */
  extraWhere?: string;
  /** Per-object hard cap appended as `LIMIT N` when > 0. */
  maxRecordsPerObject?: number;
}

/** The statements that read one node's records, as {@link queryNodeRecords} runs them. */
export interface NodeQuery {
  kind: 'query';
  /**
   * SOQL to run in order. More than one only when a scope's Id lists do not
   * fit one query URI; the rows are then merged by `Id`.
   */
  statements: string[];
  /** Per-object cap, already appended as `LIMIT N` to every statement. */
  limit?: number;
}

/**
 * Result of {@link buildNodeQuery}: either the statements to run, or
 * `'skip'` with the reason the node is out of scope (caller skips the node
 * and surfaces the reason in the error report).
 */
export type NodeQueryResult = NodeQuery | { kind: 'skip'; reason: string };

/**
 * Build the SOQL for one node: scoped to the transitive closure of the
 * root record when a scope builder is available, full-table otherwise
 * (narrowed by the object's filter when it has one).
 * Appends `LIMIT N` when a positive per-object cap is configured.
 */
export function buildNodeQuery(input: NodeQueryInput): NodeQueryResult {
  const queryFields = input.fieldInfos.filter((f) => f.queryable).map((f) => f.name);
  if (queryFields.length === 0) {
    queryFields.push('Id');
  }

  let statements: string[];
  if (input.scopedBuilder && input.scopeCache && input.rootObjectApiName && input.rootRecordId) {
    const scopeFields = input.fieldInfos
      .filter((f) => f.isReference)
      .map((f) => ({
        name: f.name,
        type: 'reference',
        referenceTo: f.referenceTo ?? [],
        nillable: f.nillable,
      }));
    const scopeResult = input.scopedBuilder.build({
      node: input.node,
      fields: scopeFields,
      selectFields: queryFields,
      edges: input.edges,
      cache: input.scopeCache,
      rootObjectApiName: input.rootObjectApiName,
      rootRecordId: input.rootRecordId,
      extraWhere: input.extraWhere,
    });
    if (!scopeResult.scoped) {
      return { kind: 'skip', reason: scopeResult.reason };
    }
    statements = scopeResult.statements;
  } else {
    // Outside scoped mode the object's filter is its whole WHERE clause. This
    // is how a SOQL-mode run applies its query's WHERE to the object after FROM;
    // without it that object was read from its whole table.
    const where = input.extraWhere ? ` WHERE (${input.extraWhere})` : '';
    statements = [
      `SELECT ${queryFields.join(', ')} FROM ${assertSoqlIdentifier(input.node.objectApiName)}${where}`,
    ];
  }

  // Math.floor on positive non-integers is safe; guard against
  // negatives or NaN that would produce MALFORMED_QUERY.
  if (input.maxRecordsPerObject && input.maxRecordsPerObject > 0) {
    const cap = Math.floor(input.maxRecordsPerObject);
    if (cap > 0) {
      return { kind: 'query', statements: statements.map((s) => `${s} LIMIT ${cap}`), limit: cap };
    }
  }
  return { kind: 'query', statements };
}

/**
 * Run a node's statements against the source org and return its records.
 *
 * A chunked scope asks for the same row twice when it matches FK clauses that
 * landed in different statements; inserting both copies would clone the
 * record twice, so rows are kept once per `Id`. The per-object cap sits on
 * each statement, which bounds a single read but not their sum, so it is
 * enforced again here and the remaining statements are not sent once it is
 * reached.
 */
export async function queryNodeRecords(
  query: NodeQuery,
  queryRecords: (soql: string) => Promise<Record<string, unknown>[]>,
): Promise<Record<string, unknown>[]> {
  if (query.statements.length === 1) {
    return queryRecords(query.statements[0]);
  }
  const records: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  for (const soql of query.statements) {
    for (const record of await queryRecords(soql)) {
      const id = record['Id'];
      if (typeof id === 'string') {
        if (seen.has(id)) continue;
        seen.add(id);
      }
      records.push(record);
      if (query.limit !== undefined && records.length >= query.limit) return records;
    }
  }
  return records;
}

/**
 * Register a node's own record IDs in the scope cache. Used by every
 * branch that queried source records — including the reference-data and
 * dry-run branches — so FK propagation keeps working downstream.
 */
export function seedOwnIds(
  scopeCache: RecordScopeCache,
  objectApiName: string,
  records: Record<string, unknown>[],
): void {
  const ownIds: string[] = [];
  for (const rec of records) {
    const id = rec['Id'];
    if (typeof id === 'string' && id) ownIds.push(id);
  }
  scopeCache.add(objectApiName, ownIds);
}

/**
 * Seed the cache with this node's IDs and extract FK values for downstream
 * multi-hop scoping (e.g. Case.AccountId → Account, then Account.OwnerId → User).
 */
export function seedScopeCache(
  scopeCache: RecordScopeCache,
  objectApiName: string,
  records: Record<string, unknown>[],
  fieldInfos: FieldInfo[],
): void {
  seedOwnIds(scopeCache, objectApiName, records);

  const refFieldsWithTargets = fieldInfos.filter(
    (f) => f.isReference && f.referenceTo && f.referenceTo.length > 0,
  );
  for (const field of refFieldsWithTargets) {
    const targets = field.referenceTo ?? [];
    for (const rec of records) {
      const value = rec[field.name];
      if (typeof value !== 'string' || !value) continue;
      for (const target of targets) {
        scopeCache.add(target, [value]);
      }
    }
  }
}

/**
 * Reorder a topologically sorted list so the root object comes first while
 * preserving the relative order of all other nodes. Used in record-scoped
 * mode to guarantee the root record (and the FK values it carries) populate
 * the scope cache before any sibling node from the same cycle wave runs.
 *
 * Throws if the root is excluded from the graph. In scoped mode
 * the root *must* be cloned; otherwise every child that references it
 * orphan-nullifies its FK silently, producing a disconnected clone.
 * The error surfaces to the UI so the user can either include the root
 * or drop scoped mode.
 *
 * `included === false` carries two unrelated facts. Discovery
 * clears it for a node the user (or `skipEmpty`) deliberately left out, and
 * also for one it could not measure at all — a describe or a `SELECT COUNT()`
 * that failed, which discovery marks with `status: 'error'` and the reason in
 * `errors`. "Re-include the root" is useless advice when the org never
 * answered for that object, and an unmeasured object is not an empty one, so
 * the two cases get two distinct messages.
 */
function bringRootToFront(nodes: ForgeGraphNode[], rootObjectApiName: string): ForgeGraphNode[] {
  const rootIndex = nodes.findIndex((n) => n.objectApiName === rootObjectApiName);
  if (rootIndex < 0) {
    throw new Error(
      `Cannot run scoped clone with root "${rootObjectApiName}" missing from the graph. ` +
        `The root node was excluded or filtered out — re-include it before executing.`,
    );
  }
  const rootNode = nodes[rootIndex];
  if (!rootNode.included) {
    if (rootNode.status === 'error') {
      throw new Error(
        `Cannot run scoped clone: root "${rootObjectApiName}" could not be measured during ` +
          `discovery (${rootNode.errors[0] ?? 'unknown discovery error'}). ` +
          `Its record count is unknown, not zero — re-run discovery once the org answers for ` +
          `this object instead of re-including the node.`,
      );
    }
    throw new Error(
      `Cannot run scoped clone with root "${rootObjectApiName}" excluded. ` +
        `Children referencing the root would orphan-nullify their FK silently. ` +
        `Either include the root node or switch to non-scoped mode.`,
    );
  }
  if (rootIndex === 0) return nodes;
  const reordered = [...nodes];
  const [root] = reordered.splice(rootIndex, 1);
  reordered.unshift(root);
  return reordered;
}

/**
 * Topological sort of graph nodes so parents are processed before children.
 *
 * Uses Kahn's algorithm: nodes with no incoming edges are processed first,
 * then their outgoing edges are removed, revealing the next layer.
 * If cycles exist, remaining nodes are appended at the end.
 */
function topologicalSort(graph: ForgeGraph, edges?: readonly ForgeGraphEdge[]): ForgeGraphNode[] {
  const graphEdges = edges ?? graph.edges;
  const nodeMap = new Map<string, ForgeGraphNode>();
  for (const node of graph.nodes) {
    nodeMap.set(node.objectApiName, node);
  }

  // Build in-degree map AND adjacency map in one O(E) pass. Adjacency
  // turns the inner edge scan from O(E) to O(out-degree), critical for
  // big graphs (50K-record clones with 350 SObjects).
  const inDegree = new Map<string, number>();
  const outgoing = new Map<string, string[]>();
  for (const node of graph.nodes) {
    inDegree.set(node.objectApiName, 0);
  }
  for (const edge of graphEdges) {
    if (inDegree.has(edge.targetObject)) {
      inDegree.set(edge.targetObject, (inDegree.get(edge.targetObject) ?? 0) + 1);
    }
    const list = outgoing.get(edge.sourceObject);
    if (list) list.push(edge.targetObject);
    else outgoing.set(edge.sourceObject, [edge.targetObject]);
  }

  // Start with nodes that have no incoming edges
  const queue: string[] = [];
  for (const [name, degree] of inDegree) {
    if (degree === 0) {
      queue.push(name);
    }
  }

  const sorted: ForgeGraphNode[] = [];
  const visited = new Set<string>();

  while (queue.length > 0) {
    const name = queue.shift()!;
    if (visited.has(name)) continue;
    visited.add(name);

    const node = nodeMap.get(name);
    if (node) {
      sorted.push(node);
    }

    // Remove outgoing edges via adjacency map (O(out-degree)).
    const targets = outgoing.get(name);
    if (targets) {
      for (const target of targets) {
        if (inDegree.has(target)) {
          const newDegree = (inDegree.get(target) ?? 1) - 1;
          inDegree.set(target, newDegree);
          if (newDegree === 0 && !visited.has(target)) {
            queue.push(target);
          }
        }
      }
    }
  }

  // Append any remaining nodes (cycles)
  for (const node of graph.nodes) {
    if (!visited.has(node.objectApiName)) {
      sorted.push(node);
    }
  }

  return sorted;
}
