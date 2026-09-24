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
import {
  PRICEBOOK_ENTRY_OBJECT,
  PRICEBOOK_ENTRY_SELLING_MODEL_FIELD,
  PRICEBOOK_OBJECT,
  SELLING_MODEL_OBJECT,
  SELLING_MODEL_OPTION_OBJECT,
  isRequiredLookup,
} from '@sandforge/shared';
import type { FieldInfo } from '../ForgeExecutor.js';
import { assertSoqlIdentifier } from '../../../core/common/soqlValidator.js';
import type { RecordScopeCache } from '../RecordScopeCache.js';
import { UNSCOPED_NO_PARENT_REASON, type ScopedSoqlBuilder } from '../ScopedSoqlBuilder.js';

/** The product every price, option and line of the catalog names. */
export const PRODUCT_OBJECT = 'Product2';

/**
 * The catalog — prices, products, selling models and the options that join
 * the two, price books, and the categories products are assigned to with the
 * catalogs that hold them — in the order a record-scoped run reads it, once
 * the rest of the graph has been read, but for what its own rows name (see
 * {@link sortNodesAskedAgain}). A node something reaches from above is
 * read at its turn as well, for the rows under what it reached, and read
 * here all the same: the records read after it name rows of it too.
 *
 * Every sale priced from the catalog points at it, so its scope is what the
 * clone's records name, and it is read once they all have been: its turn in
 * parents-first order comes before the line items that say which prices
 * they use. Read then, a price was scoped by the price books in scope — the
 * opportunity's own, and the standard book matched for the standard prices —
 * and run between two sandboxes, an opportunity with three line items
 * brought 171 prices and all 146 products. Prices come first here because a
 * price names its product, its selling model and its book; the options come
 * after the products and selling models they join.
 *
 * A selling model is as shared as a price book: every price sold under it
 * points at it, and read as any parent in scope is, the one-time model of a
 * real org would have brought its 275 prices.
 *
 * So is a category, which every product assigned to it points at through its
 * assignment, and the catalog that holds the categories. Read as parents in
 * scope, the category a product's assignment named and its catalog brought
 * the whole catalog: run between two sandboxes, a product's clone carried its
 * twenty-four assignments, where the product has one, and its six
 * categories, where that assignment names one. They come last: a category
 * names its catalog, and nothing else of the catalog names either.
 */
export const CATALOG_READ_ORDER: readonly string[] = [
  PRICEBOOK_ENTRY_OBJECT,
  PRODUCT_OBJECT,
  SELLING_MODEL_OBJECT,
  SELLING_MODEL_OPTION_OBJECT,
  PRICEBOOK_OBJECT,
  'ProductCategory',
  'ProductCatalog',
];

/** The objects of {@link CATALOG_READ_ORDER}. */
export const CATALOG_OBJECTS: ReadonlySet<string> = new Set(CATALOG_READ_ORDER);

/**
 * Whether a copy follows a lookup of `objectApiName` to the record it names,
 * wherever discovery stopped: one its rows cannot be written without —
 * required as the platform has it, which is not always as the describe says:
 * an opportunity's line reads as nullable and is refused without its price
 * (`platform-required-fields.ts` in shared) — or the selling model of a price,
 * optional as that lookup is. A book prices a product once per model it is
 * sold under, and a price written without its model is the product's other
 * price over again.
 */
export function followsToItsParent(
  objectApiName: string,
  field: { readonly name: string; readonly nillable?: boolean },
): boolean {
  return (
    isRequiredLookup(objectApiName, field.name, field.nillable) ||
    (objectApiName === PRICEBOOK_ENTRY_OBJECT && field.name === PRICEBOOK_ENTRY_SELLING_MODEL_FIELD)
  );
}

/**
 * The objects of the catalog a graph does not hold at all: neither among the
 * objects it reads nor among those it leaves out — and that the user did not
 * leave out by name.
 *
 * Discovery stops at a cap, and the catalog sits past the records that price
 * from it: run for real at the default cap of fifty objects, a clone of an
 * opportunity held its three line items and not one of their prices. A
 * record's price, its product, its book and its selling model are part of the
 * copy wherever discovery stopped — unless the graph holds the object and
 * leaves it out: excluded, or empty in the whole org. Or unless the user
 * excluded it by name: marked on the graph's node alone, an exclusion of an
 * object discovery never reached was no exclusion, and it came all the same.
 *
 * @param leftOut - The objects the user excluded by name, reached or not.
 */
export function catalogBeyond(
  graph: Pick<ForgeGraph, 'nodes'>,
  leftOut: ReadonlySet<string> = new Set(),
): Set<string> {
  const held = new Set(graph.nodes.map((n) => n.objectApiName));
  return new Set(
    CATALOG_READ_ORDER.filter(
      (objectApiName) => !held.has(objectApiName) && !leftOut.has(objectApiName),
    ),
  );
}

/**
 * The graph with the nodes of the objects the user excluded by name left
 * out, as a node unchecked on the Forge page is: listed, skipped, and never
 * read. The objects discovery never reached have no node, and are left out
 * where a copy would add them (`catalogBeyond`).
 */
export function withObjectsLeftOut<G extends Pick<ForgeGraph, 'nodes'>>(
  graph: G,
  leftOut: ReadonlySet<string>,
): G {
  if (!graph.nodes.some((n) => n.included && leftOut.has(n.objectApiName))) return graph;
  return {
    ...graph,
    nodes: graph.nodes.map((n) =>
      n.included && leftOut.has(n.objectApiName) ? { ...n, included: false } : n,
    ),
  };
}

/**
 * The objects among `targets` — those a lookup can name — that a record id it
 * holds can belong to, told by the three characters every id of an object
 * begins with: the object known to have the id's key prefix, or, when none of
 * them is known to have it, each of them whose prefix is not known.
 *
 * A lookup that can name several objects holds the id of one of them. Taken
 * for an id of each, the quote an email was related to was asked of every
 * object of the graph the lookup could name, and of their children: some
 * forty statements a clone of an opportunity sent, every one empty.
 *
 * @param keyPrefixes - The key prefix of each object known so far, by object.
 */
export function objectsOfId(
  id: string,
  targets: readonly string[],
  keyPrefixes: ReadonlyMap<string, string>,
): readonly string[] {
  if (targets.length < 2) return targets;
  const prefix = id.slice(0, 3);
  const owner = targets.find((target) => keyPrefixes.get(target) === prefix);
  if (owner !== undefined) return [owner];
  return targets.filter((target) => !keyPrefixes.has(target));
}

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

/** A catalog node asked again once the first pass is done. */
export interface CatalogNodeAskedAgain {
  readonly node: ForgeGraphNode;
  /** The source fields its turn described: what its rows can name. */
  readonly fieldInfos: readonly FieldInfo[];
}

/**
 * The order the nodes asked again once the first pass is done are read in:
 * the nodes put off that the catalog's rows cannot bring into scope, then the
 * catalog in {@link CATALOG_READ_ORDER}, then the nodes put off that its rows
 * can.
 *
 * The catalog is read once, by the ids the records read point at, so each
 * record that can name a row of it has to be read before it — and a node put
 * off can: nothing had named it at its turn, something read since has. Read
 * after the catalog, the asset a line renews — put off, since the line comes
 * after it — names a product and a price no line names, neither is read, and
 * the asset goes to the target without them.
 *
 * What the catalog's rows point at goes the other way — the classification
 * a product is based on, the proration policy of a selling model option: it
 * is read by the ids those rows name. So is whatever the graph reads under
 * one of those, which waits for its rows, and whatever such a row names in
 * turn, which the ids it names are all that bring into scope: the attribute
 * definition an attribute of a classification cannot be written without,
 * and the picklist of that definition. Read before the catalog, a definition
 * nothing had named yet was left out of the clone, and the attribute went to
 * the target without it: REQUIRED_FIELD_MISSING, AttributeDefinitionId. What
 * such a node names of the catalog comes too late for its read, and is read
 * by a second one (`readCatalogAgain` in the executor).
 *
 * The fields of a catalog node's turn say what its rows can name — any
 * object one of its lookups can point at — and the graph's edges what a node
 * is read under, and what its rows can name. The nodes put off keep the order
 * the first pass met them in, parents first, each read after the node that
 * brings it into scope.
 *
 * @param putOff - The nodes put off, in the order the first pass met them.
 * @param catalog - The catalog nodes to read again, put off or read at their turn.
 * @param edges - The graph's edges (parent→child).
 */
export function sortNodesAskedAgain(
  putOff: readonly ForgeGraphNode[],
  catalog: readonly CatalogNodeAskedAgain[],
  edges: readonly ForgeGraphEdge[],
): ForgeGraphNode[] {
  const inReadOrder = CATALOG_READ_ORDER.flatMap((name) =>
    catalog.filter(({ node }) => node.objectApiName === name),
  );
  const named = new Set(
    inReadOrder.flatMap(({ fieldInfos }) =>
      fieldInfos.flatMap((f) => (f.isReference ? (f.referenceTo ?? []) : [])),
    ),
  );
  const parentsOf = new Map<string, string[]>();
  const childrenOf = new Map<string, string[]>();
  const link = (map: Map<string, string[]>, from: string, to: string): void => {
    const list = map.get(from);
    if (list) list.push(to);
    else map.set(from, [to]);
  };
  for (const { sourceObject, targetObject } of edges) {
    link(parentsOf, targetObject, sourceObject);
    link(childrenOf, sourceObject, targetObject);
  }
  const after: ForgeGraphNode[] = [];
  const readAfter = new Set<string>();
  let before = [...putOff];
  // Round by round, until none is added: those the catalog's rows name, then
  // those read under one read after it, or named by one.
  let round = before.filter((node) => named.has(node.objectApiName));
  while (round.length > 0) {
    for (const node of round) {
      readAfter.add(node.objectApiName);
      after.push(node);
    }
    before = before.filter((node) => !readAfter.has(node.objectApiName));
    round = before.filter(
      ({ objectApiName }) =>
        (parentsOf.get(objectApiName) ?? []).some((parent) => readAfter.has(parent)) ||
        (childrenOf.get(objectApiName) ?? []).some((child) => readAfter.has(child)),
    );
  }
  return [...before, ...inReadOrder.map(({ node }) => node), ...after];
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
 *
 * Breaking ties is what they did not do. Each object was ranked by its place
 * in the order of the required edges, a place no two objects share, so the
 * optional edges were never asked: an opportunity, met first by discovery,
 * was written before its account and its price book, inserted without them,
 * and patched by the second pass. Among the objects the required edges leave
 * free, the next one written is now the one with the fewest optional parents
 * still to write, and on a tie the one first in the order of every edge — so
 * where nothing but a cycle stands in the way, parents come first.
 *
 * @param orderEdges - Orders the graph does not hold as lookups, kept like
 *   required edges: the catalog's, see {@link catalogWriteEdges}.
 */
export function sortNodesForWriting(
  graph: ForgeGraph,
  orderEdges: readonly ForgeGraphEdge[] = [],
): ForgeGraphNode[] {
  const requiredEdges = [...graph.edges.filter((e) => e.required === true), ...orderEdges];
  if (requiredEdges.length === 0) return topologicalSort(graph);

  const names = new Set(graph.nodes.map((n) => n.objectApiName));
  const full = topologicalSort(graph);
  const fullIndex = new Map(full.map((node, index) => [node.objectApiName, index]));
  const requiredParents = new Map<string, Set<string>>();
  const requiredChildren = new Map<string, Set<string>>();
  const optionalParents = new Map<string, Set<string>>();
  const link = (map: Map<string, Set<string>>, from: string, to: string): void => {
    const set = map.get(from) ?? new Set<string>();
    set.add(to);
    map.set(from, set);
  };
  for (const edge of requiredEdges) {
    const { sourceObject: parent, targetObject: child } = edge;
    if (parent === child || !names.has(parent) || !names.has(child)) continue;
    link(requiredParents, child, parent);
    link(requiredChildren, parent, child);
  }
  for (const edge of graph.edges) {
    const { sourceObject: parent, targetObject: child } = edge;
    if (parent === child || !names.has(parent) || !names.has(child)) continue;
    if (requiredParents.get(child)?.has(parent)) continue;
    link(optionalParents, child, parent);
  }
  const optionalChildren = new Map<string, Set<string>>();
  for (const [child, parents] of optionalParents) {
    for (const parent of parents) link(optionalChildren, parent, child);
  }

  const requiredLeft = new Map<string, number>();
  const optionalLeft = new Map<string, number>();
  for (const name of names) {
    requiredLeft.set(name, requiredParents.get(name)?.size ?? 0);
    optionalLeft.set(name, optionalParents.get(name)?.size ?? 0);
  }
  const ready = new Set([...names].filter((name) => requiredLeft.get(name) === 0));
  const byName = new Map(graph.nodes.map((n) => [n.objectApiName, n]));
  const sorted: ForgeGraphNode[] = [];
  const written = new Set<string>();
  while (ready.size > 0) {
    let next: string | undefined;
    for (const name of ready) {
      if (
        next === undefined ||
        (optionalLeft.get(name) ?? 0) < (optionalLeft.get(next) ?? 0) ||
        ((optionalLeft.get(name) ?? 0) === (optionalLeft.get(next) ?? 0) &&
          (fullIndex.get(name) ?? 0) < (fullIndex.get(next) ?? 0))
      ) {
        next = name;
      }
    }
    if (next === undefined) break;
    ready.delete(next);
    written.add(next);
    const node = byName.get(next);
    if (node) sorted.push(node);
    for (const child of requiredChildren.get(next) ?? []) {
      const left = (requiredLeft.get(child) ?? 1) - 1;
      requiredLeft.set(child, left);
      if (left === 0 && !written.has(child)) ready.add(child);
    }
    for (const child of optionalChildren.get(next) ?? []) {
      optionalLeft.set(child, (optionalLeft.get(child) ?? 1) - 1);
    }
  }
  // Members of a cycle of required edges, which no order satisfies: as Kahn's
  // algorithm leaves them, in the graph's order.
  for (const node of graph.nodes) {
    if (!written.has(node.objectApiName)) sorted.push(node);
  }
  return sorted;
}

/**
 * The order the catalog is written in, whatever order discovery met it in:
 * products and selling models, then the options that join them, then the
 * prices — the standard ones first, inside the prices' own write — then
 * every line that prices from them.
 *
 * Discovery only knows an edge it walked, and at the edge of a graph it
 * walks nothing: two levels around an opportunity, the price, the quote line
 * and the order item were all met and none of them walked, so nothing said a
 * line needs its price, and the lines went first. The product came before its
 * prices only because discovery happened to meet it first. An option is no
 * lookup at all — the platform refuses a price without one, and no describe
 * says so.
 *
 * @param objects - The objects the run writes; an edge is kept between two of them only.
 * @param lines - Of those, the ones whose records point at a price.
 */
export function catalogWriteEdges(
  objects: ReadonlySet<string>,
  lines: readonly string[],
): ForgeGraphEdge[] {
  const order: Array<readonly [string, string]> = [
    [PRODUCT_OBJECT, SELLING_MODEL_OPTION_OBJECT],
    [SELLING_MODEL_OBJECT, SELLING_MODEL_OPTION_OBJECT],
    [PRODUCT_OBJECT, PRICEBOOK_ENTRY_OBJECT],
    [SELLING_MODEL_OBJECT, PRICEBOOK_ENTRY_OBJECT],
    [SELLING_MODEL_OPTION_OBJECT, PRICEBOOK_ENTRY_OBJECT],
    [PRICEBOOK_OBJECT, PRICEBOOK_ENTRY_OBJECT],
    ...lines.map((line) => [PRICEBOOK_ENTRY_OBJECT, line] as const),
  ];
  return order
    .filter(([before, after]) => before !== after && objects.has(before) && objects.has(after))
    .map(([sourceObject, targetObject]) => ({
      sourceObject,
      targetObject,
      relationshipName: `${sourceObject}Before${targetObject}`,
      type: 'lookup',
      required: true,
    }));
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
  /**
   * Objects the run reads or maps (scoped mode): only a required lookup at
   * one of them narrows a read. See `ScopedSoqlBuildOpts.readObjects`.
   */
  readObjects?: ReadonlySet<string>;
  /**
   * Objects every record pointing at them shares (scoped mode). See
   * `ScopedSoqlBuildOpts.catalog`.
   */
  catalog?: ReadonlySet<string>;
  /**
   * The root's object is read a second time (scoped mode). See
   * `ScopedSoqlBuildOpts.rootReadAgain`.
   */
  rootReadAgain?: boolean;
  /**
   * Read only the rows under these parents (scoped mode). See
   * `ScopedSoqlBuildOpts.under`.
   */
  under?: ReadonlySet<string>;
}

/** The statements that read one node's records, as {@link queryNodeRecords} runs them. */
export interface NodeQuery {
  kind: 'query';
  /**
   * SOQL to run in order. More than one only when a scope's Id lists do not
   * fit one query URI, or when rows are read both by id and under a parent;
   * the rows are then merged by `Id`.
   */
  statements: string[];
  /** Per-object cap, already appended as `LIMIT N` to every statement. */
  limit?: number;
  /**
   * How many statements, from the first, read rows by the ids rows already
   * read point at; the rest read rows the run reached from above. Absent
   * when none reads by id.
   */
  byIdCount?: number;
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
  let byIdCount = 0;
  if (
    input.scopedBuilder &&
    input.scopeCache &&
    input.rootObjectApiName &&
    input.rootRecordId &&
    input.node.objectApiName === SELLING_MODEL_OPTION_OBJECT &&
    input.node.objectApiName !== input.rootObjectApiName &&
    input.catalog?.has(SELLING_MODEL_OPTION_OBJECT)
  ) {
    const options = sellingModelOptionStatements(
      input.scopedBuilder,
      input.scopeCache,
      queryFields,
      input.extraWhere,
    );
    if (!options) return { kind: 'skip', reason: UNSCOPED_NO_PARENT_REASON };
    statements = options;
    byIdCount = statements.length;
  } else if (
    input.scopedBuilder &&
    input.scopeCache &&
    input.rootObjectApiName &&
    input.rootRecordId
  ) {
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
      // An object is read once, so its read has to take what every edge
      // brings to it: the rows already read point at, and its rows under a
      // parent in scope. A clone of an account whose lookup names one of its
      // contacts read that contact and none of the others.
      everyEdge: true,
      readObjects: input.readObjects,
      catalog: input.catalog,
      rootReadAgain: input.rootReadAgain,
      under: input.under,
    });
    if (!scopeResult.scoped) {
      return { kind: 'skip', reason: scopeResult.reason };
    }
    statements = scopeResult.statements;
    byIdCount = scopeResult.byIdCount;
  } else {
    // Outside scoped mode the object's filter is its whole WHERE clause. This
    // is how a SOQL-mode run applies its query's WHERE to the object after FROM;
    // without it that object was read from its whole table.
    const where = input.extraWhere ? ` WHERE (${input.extraWhere})` : '';
    statements = [
      `SELECT ${queryFields.join(', ')} FROM ${assertSoqlIdentifier(input.node.objectApiName)}${where}`,
    ];
  }

  const byId = byIdCount > 0 ? { byIdCount } : {};
  // Math.floor on positive non-integers is safe; guard against
  // negatives or NaN that would produce MALFORMED_QUERY.
  if (input.maxRecordsPerObject && input.maxRecordsPerObject > 0) {
    const cap = Math.floor(input.maxRecordsPerObject);
    if (cap > 0) {
      return {
        kind: 'query',
        statements: statements.map((s) => `${s} LIMIT ${cap}`),
        limit: cap,
        ...byId,
      };
    }
  }
  return { kind: 'query', statements, ...byId };
}

/**
 * The statements that read the options of the products in scope under the
 * selling models in scope — however either was reached — or `undefined` when
 * the run holds none of one of them.
 *
 * Not a row shared by every sale, as the rest of the catalog is, but part of
 * the product it belongs to: the platform will not take a price for the
 * product under the model without it. Held to the selling models in scope,
 * which the prices name, because an option cannot be written without its
 * model. Read by these ids alone, so no option brings anything under it.
 */
function sellingModelOptionStatements(
  builder: ScopedSoqlBuilder,
  cache: RecordScopeCache,
  selectFields: string[],
  extraWhere: string | undefined,
): string[] | undefined {
  const products = cache.scopeOf(PRODUCT_OBJECT);
  const models = cache.scopeOf(SELLING_MODEL_OBJECT);
  if (!products || products.size === 0 || !models || models.size === 0) return undefined;
  return builder.buildJoining({
    objectApiName: SELLING_MODEL_OPTION_OBJECT,
    selectFields,
    split: { field: 'Product2Id', ids: products },
    whole: { field: 'ProductSellingModelId', ids: models },
    extraWhere,
  });
}

/** Whether a node's query reads any row from above: the root, or rows under a parent in scope. */
export function readsFromAbove(query: NodeQuery): boolean {
  return (query.byIdCount ?? 0) < query.statements.length;
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
 *
 * @param reached - When given, receives the ids of the rows a statement
 *   after the first `byIdCount` returned: the rows the run reached from
 *   above, including one a read by id returned as well.
 */
export async function queryNodeRecords(
  query: NodeQuery,
  queryRecords: (soql: string) => Promise<Record<string, unknown>[]>,
  reached?: Set<string>,
): Promise<Record<string, unknown>[]> {
  const byIdCount = query.byIdCount ?? 0;
  if (query.statements.length === 1) {
    const rows = await queryRecords(query.statements[0]);
    if (reached && byIdCount === 0) {
      for (const row of rows) if (typeof row['Id'] === 'string') reached.add(row['Id']);
    }
    return rows;
  }
  const records: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  for (const [index, soql] of query.statements.entries()) {
    for (const record of await queryRecords(soql)) {
      const id = record['Id'];
      if (typeof id === 'string') {
        if (reached && index >= byIdCount) reached.add(id);
        if (seen.has(id)) continue;
        seen.add(id);
      }
      records.push(record);
      if (query.limit !== undefined && records.length >= query.limit) return records;
    }
  }
  return records;
}

/** How {@link seedOwnIds} and {@link seedScopeCache} leave the node's scope. */
export interface SeedOptions {
  /**
   * Whether the node's read is done, settling its scope. False for a read to
   * be done again: the scope stays open, and every ID of the object met until
   * then is one that read fetches. Defaults to true.
   */
  settle?: boolean;
  /**
   * The key prefix of each object known so far, by object: an ID a lookup
   * naming several objects holds goes to the one it can belong to (see
   * {@link objectsOfId}). Left out, it goes to each of them.
   */
  keyPrefixes?: ReadonlyMap<string, string>;
}

/**
 * Register a node's own record IDs in the scope cache. Used by every
 * branch that queried source records — including the reference-data and
 * dry-run branches — so FK propagation keeps working downstream.
 *
 * The node's read is done, so its scope is settled here: an ID of this
 * object met later — through the node's own self-lookup, or a lookup of a
 * row read after it — no longer puts its children in scope. A read to be done
 * again leaves it open (`settle: false`).
 */
export function seedOwnIds(
  scopeCache: RecordScopeCache,
  objectApiName: string,
  records: Record<string, unknown>[],
  { settle = true }: SeedOptions = {},
): void {
  const ownIds: string[] = [];
  for (const rec of records) {
    const id = rec['Id'];
    if (typeof id === 'string' && id) ownIds.push(id);
  }
  if (settle) scopeCache.addRead(objectApiName, ownIds);
  else scopeCache.add(objectApiName, ownIds);
}

/**
 * Seed the cache with this node's IDs and extract FK values for downstream
 * multi-hop scoping (e.g. Case.AccountId → Account, then Account.OwnerId → User).
 *
 * An ID a lookup naming several objects holds goes to the objects it can
 * belong to, as far as `keyPrefixes` tells. Put in scope as an ID of each, the
 * quote an email was related to was asked of every object of the graph the
 * lookup could name — a calculation procedure, a document template, an
 * expression set — each in a statement bound to come back empty, and the
 * children of each were asked for it again.
 */
export function seedScopeCache(
  scopeCache: RecordScopeCache,
  objectApiName: string,
  records: Record<string, unknown>[],
  fieldInfos: FieldInfo[],
  options: SeedOptions = {},
): void {
  seedOwnIds(scopeCache, objectApiName, records, options);

  const keyPrefixes = options.keyPrefixes ?? new Map<string, string>();
  const refFieldsWithTargets = fieldInfos.filter(
    (f) => f.isReference && f.referenceTo && f.referenceTo.length > 0,
  );
  for (const field of refFieldsWithTargets) {
    const targets = field.referenceTo ?? [];
    for (const rec of records) {
      const value = rec[field.name];
      if (typeof value !== 'string' || !value) continue;
      for (const target of objectsOfId(value, targets, keyPrefixes)) {
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
