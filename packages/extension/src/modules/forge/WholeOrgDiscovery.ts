/**
 * The graph of a clone of the whole org: every object of the source the
 * target can take and the source holds records of, the relations between
 * them, and every other object of the source with why the clone leaves it.
 *
 * A walk from a root reaches what one record or one query leads to, and stops
 * at a node cap: a truthful answer for a slice, and a wrong one for "all of
 * it", where a cap would drop objects without saying. So this discovery
 * walks nothing. It lists both orgs' objects, settles which the clone may
 * take (`wholeOrgCandidates`), counts the records of each, describes those
 * that hold any, and draws the relations from each child's own lookups. An
 * object never silently goes: it is a node, or it is in `leftOut` with a
 * reason, and a graph too big for one run is refused, never cut.
 *
 * Three phases, each said to the page with how far it is (`total`):
 *
 * - `listing`: the global describes of both orgs, the names the target's
 *   Tooling API serves, what the target says of who may be given Create and
 *   the source's own approximation of its record counts, all at once;
 * - `counting`: an exact `COUNT()` of each candidate, six at a time as every
 *   Forge pass on one org. A count the org does not answer in time keeps the
 *   approximation, or is marked unknown, and the object stays in: the run
 *   copies what it reads, whatever a figure said. A count the org refuses
 *   leaves the object out as unreadable, in the org's own words. An empty
 *   table is left out without a describe;
 * - `describing`: the describe of each object that holds records, which
 *   names its personal fields and the lookups the relations are drawn from.
 *
 * Each node is sized as a walk from a root sizes its nodes, by REST calls of
 * 200 rows; what the run's writes cost by the Bulk API is the write gate's to
 * count, where the run's parts are priced.
 */

import * as z from 'zod';
import {
  FORGE_LEFT_OUT_MAX,
  isInsertOnlyField,
  isRequiredLookup,
  isSettableField,
  wholeOrgConfigIssue,
  type ForgeConfig,
  type ForgeGraph,
  type ForgeGraphEdge,
  type ForgeGraphNode,
  type ForgeLeftOutObject,
} from '@sandforge/shared';
import { assertSoqlIdentifier } from '../../core/common/soqlValidator.js';
import { ARCHIVED_ACTIVITIES } from '../../core/removal/tableIds.js';
import { extractErrorCode, extractErrorMessage } from '../../core/common/extractErrorMessage.js';
import { isAuthError } from '../../core/common/isAuthError.js';
import { isNetworkError } from '../../core/common/isNetworkError.js';
import { TimeoutError } from '../../core/engine/TimeoutManager.js';
import { logger } from '../../logger.js';
import {
  DiscoveryCancelled,
  emptyGraph,
  MB_PER_RECORD,
  SECONDS_PER_RECORD,
  untilCancelled,
  yieldToEventLoop,
  type DiscoveryOptions,
  type DiscoveryProgressEvent,
  type GraphDiscoveryDeps,
  type ObjectDescribe,
} from './GraphDiscoveryService.js';
import { stronglyConnected } from './ForgePlanGenerator.js';
import { ordersTheWrite } from './stages/ScopeResolver.js';
import { CONCURRENT_DESCRIBE_LIMIT } from './orgConcurrency.js';
import type { CreateFacts } from './targetCreators.js';
import { wholeOrgCandidates } from './wholeOrgScope.js';

/**
 * The most objects a clone of the whole org takes in one run.
 *
 * A graph holds two thousand nodes at most (`forgeGraphSchema`), which the
 * run journal checks the graph against before the first write, and a run adds
 * nodes of its own as it goes — the parents and children it meets outside the
 * graph. Fifty places are left for those.
 */
export const WHOLE_ORG_MAX_NODES = 1_950;

/**
 * The most pairs of related objects a clone of the whole org relates: the
 * edges a graph holds (`forgeGraphSchema`), one a pair.
 */
export const WHOLE_ORG_MAX_PAIRS = 20_000;

/**
 * Past this many records by the org's approximation, an object is not
 * counted exactly: a `COUNT()` of a table that big runs into the org's own
 * query timeout, and the approximation is as good a figure to size a run by.
 * Not when the object is filtered: the filter may keep few of its rows, and
 * only the count says how many.
 */
const APPROXIMATE_ONLY_ABOVE = 1_000_000;

/**
 * The deepest level a node of a clone of the whole org gets. A node's level
 * is bounded to twenty (`forgeGraphSchema`), and a node a run adds sits one
 * level under the node it was met from; level 0 names a root, which a clone
 * of the whole org has none of.
 */
const MAX_LEVEL = 18;

/** Rows a REST write sends a call: what a node's calls are sized by, as a walk from a root sizes them. */
const ROWS_PER_CALL = 200;

/**
 * Error codes of an org that did not answer a count, rather than refused it:
 * the count is kept as unknown, not the object left out.
 */
const NO_ANSWER_CODES: ReadonlySet<string> = new Set([
  'QUERY_TIMEOUT',
  'OPERATION_TOO_LARGE',
  'REQUEST_LIMIT_EXCEEDED',
  'REQUEST_RUNNING_TOO_LONG',
  'SERVER_UNAVAILABLE',
  'UNKNOWN_EXCEPTION',
]);

/**
 * Whether the org refused to count an object — an object it will not read
 * without a filter, one the user may not query after all — rather than gave
 * no answer: a timeout, a dropped connection, a server error or a query too
 * long for it. Only a refusal carries a code of the org's that is none of
 * those.
 */
function refusedByTheOrg(error: unknown): boolean {
  if (error instanceof TimeoutError || isNetworkError(error)) return false;
  const code = extractErrorCode(extractErrorMessage(error));
  if (code === undefined) return false;
  return !NO_ANSWER_CODES.has(code) && !code.startsWith('ERROR_HTTP_');
}

/**
 * The count of one object's records, as it is to be read: an activity the org
 * may have archived through `queryAll`, the recycle bin left out by the
 * statement, as an emptying reads its ids (`tableIdsQuery`).
 */
function countStatement(
  objectApiName: string,
  filter: string | undefined,
): { soql: string; all: boolean } {
  const all = ARCHIVED_ACTIVITIES.has(objectApiName);
  const conditions = [...(filter ? [`(${filter})`] : []), ...(all ? ['IsDeleted = false'] : [])];
  return {
    soql: `SELECT COUNT() FROM ${assertSoqlIdentifier(objectApiName)}${
      conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : ''
    }`,
    all,
  };
}

/**
 * Run `work` on every item, {@link CONCURRENT_DESCRIBE_LIMIT} at a time. The
 * first failure stops the items still to start, and is the one thrown: a
 * cancel or an expired session is not met once per object left.
 *
 * The failure is thrown at once, while the other workers' calls are still in
 * the air: an expired session is said without waiting out their timeouts.
 * Those calls still answer later, after the discovery has failed, so `work`
 * asks `stopped()` once its call is back and, when it is, neither keeps the
 * answer nor tells the page of a progress past the failure it was told.
 */
export async function eachInPool<T>(
  items: readonly T[],
  work: (item: T, index: number, stopped: () => boolean) => Promise<void>,
): Promise<void> {
  let next = 0;
  let failed = false;
  const stopped = (): boolean => failed;
  const worker = async (): Promise<void> => {
    while (!failed && next < items.length) {
      const index = next++;
      try {
        await work(items[index], index, stopped);
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENT_DESCRIBE_LIMIT, items.length) }, worker),
  );
}

/**
 * The describe of one object, asked again once when the org gave no answer —
 * a timeout, a dropped connection, a server error. A describe is the only way
 * an object holding records becomes a node: left out for one lost answer, a
 * table with data would go, and the relations of its children to it with it.
 * An answer the org refused is not asked again: it would refuse it again.
 */
async function describeAgainOnce(
  describe: () => Promise<ObjectDescribe>,
  objectApiName: string,
): Promise<ObjectDescribe> {
  try {
    return await describe();
  } catch (error) {
    if (error instanceof DiscoveryCancelled || isAuthError(error) || refusedByTheOrg(error)) {
      throw error;
    }
    logger.warn(
      `[forge-discover] whole org: describe of ${objectApiName} unanswered, asked again: ${extractErrorMessage(error)}`,
    );
    return describe();
  }
}

/**
 * Refuse a graph that lists more objects left out than a graph holds
 * ({@link FORGE_LEFT_OUT_MAX}), in words, rather than hand it on to be
 * refused by the run's own check of its payload with a schema's message.
 */
function assertLeftOutFits(count: number): void {
  if (count <= FORGE_LEFT_OUT_MAX) return;
  throw new Error(
    `The source org lists ${count} objects a clone of the whole org leaves out, more than ` +
      `the ${FORGE_LEFT_OUT_MAX} one graph says. Nothing was written. Clone the org in parts ` +
      'instead: a run from a record or from a query for each part.',
  );
}

/** One object of the org's answer to `/limits/recordCount`. */
const recordCountEntrySchema = z.object({
  name: z.string().min(1),
  count: z.number().int().nonnegative(),
});

/**
 * The org's approximation of each object's records, by object, from its
 * answer to `/limits/recordCount` (`{ sObjects: [{ count, name }] }`): an
 * entry that does not read so is passed over, and an answer that does not
 * read at all says nothing of any object.
 */
export function recordCountsOf(answer: unknown): ReadonlyMap<string, number> | undefined {
  const read = z.object({ sObjects: z.array(z.unknown()) }).safeParse(answer);
  if (!read.success) return undefined;
  const figures = new Map<string, number>();
  for (const entry of read.data.sObjects) {
    const figure = recordCountEntrySchema.safeParse(entry);
    if (figure.success) figures.set(figure.data.name, figure.data.count);
  }
  return figures;
}

/** How an object's records were counted. */
interface Counted {
  objectApiName: string;
  rows: number;
  /** The figure is the org's approximation. */
  approximate?: true;
  /** Nobody could count them: `rows` is a placeholder zero. */
  unknown?: true;
}

/**
 * The relations between the nodes, one a pair of objects, drawn from each
 * child's own lookups: a lookup at an object that is no node relates nothing,
 * whatever the copy's lists say of it, and none relates an object to itself.
 *
 * A pair seen through several lookups keeps the first, unless a later one is
 * master-detail over a lookup; it is required when any lookup is, orders
 * nothing when no write can set any of them (`settable: false`), and wants
 * its parent first when one only an insert sets (`insertOnly`) — the rules a
 * walk from a root merges its sightings by.
 */
function relationsOf(described: ReadonlyMap<string, ObjectDescribe>): ForgeGraphEdge[] {
  const pairs = new Map<
    string,
    { edge: ForgeGraphEdge; noneSettable: boolean; insertOnly: boolean }
  >();
  for (const [child, describe] of described) {
    for (const field of describe.fields) {
      if (field.referenceTo.length === 0) continue;
      const settable = isSettableField(field);
      const required = settable && isRequiredLookup(child, field.name, field.nillable);
      const insertOnly = isInsertOnlyField(field);
      for (const parent of field.referenceTo) {
        if (parent === child || !described.has(parent)) continue;
        const key = `${parent}|${child}`;
        const edge: ForgeGraphEdge = {
          sourceObject: parent,
          targetObject: child,
          relationshipName: field.relationshipName ?? field.name,
          type: field.isMasterDetail ? 'master-detail' : 'lookup',
          required,
        };
        const seen = pairs.get(key);
        if (!seen) {
          pairs.set(key, { edge, noneSettable: !settable, insertOnly });
          continue;
        }
        const kept =
          edge.type === 'master-detail' && seen.edge.type === 'lookup' ? edge : seen.edge;
        seen.edge = { ...kept, required: seen.edge.required === true || required };
        seen.noneSettable = seen.noneSettable && !settable;
        seen.insertOnly = seen.insertOnly || insertOnly;
      }
    }
  }
  return [...pairs.values()].map(({ edge, noneSettable, insertOnly }) => ({
    ...edge,
    ...(noneSettable ? { settable: false } : {}),
    ...(insertOnly ? { insertOnly: true } : {}),
  }));
}

/**
 * Each node's level: one more than the longest chain of parents above it,
 * through the relations that order the write, an object of a cycle levelled
 * with the rest of its cycle — from 1, no node being a root, to
 * {@link MAX_LEVEL}.
 */
function levelsOf(names: readonly string[], edges: readonly ForgeGraphEdge[]): Map<string, number> {
  const ordering = edges.filter(ordersTheWrite);
  // Tarjan finds a group after every group it points at, children first:
  // reversed, every parent's group comes before its children's.
  const groups = stronglyConnected(names, ordering).reverse();
  const groupOf = new Map<string, number>();
  groups.forEach((group, index) => {
    for (const name of group) groupOf.set(name, index);
  });
  const parentsOf = new Map<string, string[]>();
  for (const edge of ordering) {
    const parents = parentsOf.get(edge.targetObject) ?? [];
    parents.push(edge.sourceObject);
    parentsOf.set(edge.targetObject, parents);
  }
  const layers = groups.map(() => 0);
  groups.forEach((group, index) => {
    for (const name of group) {
      for (const parent of parentsOf.get(name) ?? []) {
        const above = groupOf.get(parent);
        if (above !== undefined && above !== index) {
          layers[index] = Math.max(layers[index], layers[above] + 1);
        }
      }
    }
  });
  return new Map(
    names.map((name) => [name, Math.min(MAX_LEVEL, 1 + layers[groupOf.get(name) ?? 0])]),
  );
}

/**
 * Discover the graph of a clone of the whole org (`inputMode: 'org'`).
 *
 * A cancel hands back an empty graph, never a partial one: half the objects
 * of an org is not the whole org.
 *
 * @throws When the config is not a clone of the whole org as one must be
 *   (`wholeOrgConfigIssue`), when either org's global describe fails, when
 *   the session has expired, or when the graph is more than one run writes
 *   ({@link WHOLE_ORG_MAX_NODES}, {@link WHOLE_ORG_MAX_PAIRS}) or lists more
 *   objects left out than a graph holds ({@link FORGE_LEFT_OUT_MAX}).
 */
export async function discoverWholeOrg(
  deps: GraphDiscoveryDeps,
  config: ForgeConfig,
  options?: DiscoveryOptions,
): Promise<ForgeGraph> {
  const issue = wholeOrgConfigIssue(config);
  if (issue !== undefined) throw new Error(issue);
  const signal = options?.signal;
  if (signal?.aborted) return emptyGraph();
  try {
    return await wholeOrgGraph(deps, config, options);
  } catch (error) {
    if (error instanceof DiscoveryCancelled || signal?.aborted) return emptyGraph();
    throw error;
  }
}

/** {@link discoverWholeOrg}, cancels thrown as {@link DiscoveryCancelled}. */
async function wholeOrgGraph(
  deps: GraphDiscoveryDeps,
  config: ForgeConfig,
  options: DiscoveryOptions | undefined,
): Promise<ForgeGraph> {
  const signal = options?.signal;
  const tell = (event: DiscoveryProgressEvent): void => options?.onProgress?.(event);
  const started = Date.now();
  /** An optional call's failure, a cancel aside, as `fallback`. */
  const orElse =
    <T>(fallback: T) =>
    (error: unknown): T => {
      if (error instanceof DiscoveryCancelled) throw error;
      logger.warn(`[forge-discover] whole org: ${extractErrorMessage(error)}`);
      return fallback;
    };
  const { toolingObjects, recordCounts, createFacts } = deps;

  tell({ phase: 'listing', discoveredCount: 0, queueRemaining: 0 });
  const [sourceGlobal, targetGlobal, targetTooling, facts, recordCountAnswer] = await Promise.all([
    untilCancelled(() => deps.describeGlobal(config.sourceOrgId, signal), signal),
    untilCancelled(() => deps.describeGlobal(config.targetOrgId, signal), signal),
    toolingObjects
      ? untilCancelled(() => toolingObjects(config.targetOrgId, signal), signal).catch(
          orElse<string[]>([]),
        )
      : Promise.resolve<string[]>([]),
    createFacts
      ? untilCancelled(() => createFacts(config.targetOrgId), signal).catch(
          orElse<CreateFacts | undefined>(undefined),
        )
      : Promise.resolve(undefined),
    recordCounts
      ? untilCancelled(() => recordCounts(config.sourceOrgId, signal), signal).catch(
          orElse<unknown>(undefined),
        )
      : Promise.resolve(undefined),
  ]);
  const approximate = recordCountsOf(recordCountAnswer);
  const { candidates, leftOut } = wholeOrgCandidates(
    sourceGlobal,
    targetGlobal,
    targetTooling,
    facts ? { createFacts: facts } : {},
  );
  const out: ForgeLeftOutObject[] = [...leftOut];
  // Counting and describing only add to the list: said now, before minutes of counts.
  assertLeftOutFits(out.length);

  // Counting: every candidate, in name order whatever order the counts answer in.
  const counts: Array<Counted | undefined> = candidates.map(() => undefined);
  let counted = 0;
  tell({
    phase: 'counting',
    discoveredCount: 0,
    queueRemaining: candidates.length,
    total: candidates.length,
  });
  await eachInPool(candidates, async (objectApiName, index, stopped) => {
    const figure = approximate?.get(objectApiName);
    const filter = config.objectSoqlFilters?.[objectApiName];
    if (figure !== undefined && figure > APPROXIMATE_ONLY_ABOVE && !filter) {
      counts[index] = { objectApiName, rows: figure, approximate: true };
    } else {
      try {
        const { soql, all } = countStatement(objectApiName, filter);
        const rows = await untilCancelled(
          () => deps.queryCount(config.sourceOrgId, soql, signal, all ? { all: true } : undefined),
          signal,
        );
        if (stopped()) return;
        if (rows > 0) counts[index] = { objectApiName, rows };
        else out.push({ objectApiName, reason: 'empty' });
      } catch (error) {
        if (error instanceof DiscoveryCancelled || isAuthError(error)) throw error;
        if (stopped()) return;
        if (refusedByTheOrg(error)) {
          out.push({ objectApiName, reason: 'unreadable', detail: extractErrorMessage(error) });
        } else {
          logger.warn(
            `[forge-discover] whole org: ${objectApiName} not counted, kept: ${extractErrorMessage(error)}`,
          );
          // The approximation is of the whole table: a filtered object may
          // keep a few of its millions of rows, and only its count says how
          // many. Its figure is unknown, not the table's.
          counts[index] =
            figure !== undefined && figure > 0 && !filter
              ? { objectApiName, rows: figure, approximate: true }
              : { objectApiName, rows: 0, unknown: true };
        }
      }
    }
    counted++;
    tell({
      phase: 'counting',
      objectApiName,
      discoveredCount: counted,
      queueRemaining: candidates.length - counted,
      total: candidates.length,
    });
  });
  const holding = counts.filter((count): count is Counted => count !== undefined);
  if (holding.length > WHOLE_ORG_MAX_NODES) {
    throw new Error(
      `The source org holds records in ${holding.length} objects a clone of the whole org ` +
        `would take, more than the ${WHOLE_ORG_MAX_NODES} one run writes. Nothing was written. ` +
        'Clone the org in parts instead: a run from a record or from a query for each part.',
    );
  }

  // Describing: only the objects that hold records, or might.
  const describes: Array<ObjectDescribe | undefined> = holding.map(() => undefined);
  let describedCount = 0;
  tell({
    phase: 'describing',
    discoveredCount: 0,
    queueRemaining: holding.length,
    total: holding.length,
  });
  await eachInPool(holding, async ({ objectApiName }, index, stopped) => {
    try {
      const describe = await describeAgainOnce(
        () =>
          untilCancelled(
            () => deps.describeObject(config.sourceOrgId, objectApiName, signal),
            signal,
          ),
        objectApiName,
      );
      if (stopped()) return;
      describes[index] = describe;
    } catch (error) {
      if (error instanceof DiscoveryCancelled || isAuthError(error)) throw error;
      if (stopped()) return;
      out.push({ objectApiName, reason: 'notDescribed', detail: extractErrorMessage(error) });
    }
    describedCount++;
    tell({
      phase: 'describing',
      objectApiName,
      discoveredCount: describedCount,
      queueRemaining: holding.length - describedCount,
      total: holding.length,
    });
  });
  await yieldToEventLoop();

  const described = new Map<string, ObjectDescribe>();
  const countOf = new Map<string, Counted>();
  holding.forEach((count, index) => {
    const describe = describes[index];
    if (!describe) return;
    described.set(count.objectApiName, describe);
    countOf.set(count.objectApiName, count);
  });
  const edges = relationsOf(described);
  if (edges.length > WHOLE_ORG_MAX_PAIRS) {
    throw new Error(
      `The ${described.size} objects of the source org a clone of the whole org would take ` +
        `relate ${edges.length} pairs of objects, more than the ${WHOLE_ORG_MAX_PAIRS} one run ` +
        'writes in order. Nothing was written. Clone the org in parts instead: a run from a ' +
        'record or from a query for each part.',
    );
  }
  const names = [...described.keys()];
  const levels = levelsOf(names, edges);

  const nodes = names.map((objectApiName): ForgeGraphNode => {
    const describe = described.get(objectApiName)!;
    const count = countOf.get(objectApiName)!;
    const rows = count.rows;
    const piiFields = deps.detectPII(describe.fields);
    return {
      objectApiName,
      ...(describe.label ? { label: describe.label } : {}),
      recordCount: rows,
      ...(count.approximate ? { recordCountApproximate: true } : {}),
      ...(count.unknown ? { recordCountUnknown: true } : {}),
      fieldCount: describe.fields.length,
      status: 'idle',
      progress: 0,
      included: true,
      piiFields,
      anonymizeFields: config.anonymizePII ? [...piiFields] : [],
      level: levels.get(objectApiName) ?? 1,
      successCount: 0,
      failureCount: 0,
      errors: [],
      createableFieldCount: describe.fields.filter((f) => f.type !== 'id').length,
      estimatedSizeMB: rows * MB_PER_RECORD,
      estimatedApiCalls: Math.ceil(rows / ROWS_PER_CALL),
      batchStrategy: 'auto',
    };
  });
  assertLeftOutFits(out.length);
  const totalRecords = nodes.reduce((sum, node) => sum + node.recordCount, 0);
  out.sort((a, b) =>
    a.objectApiName < b.objectApiName ? -1 : a.objectApiName > b.objectApiName ? 1 : 0,
  );
  logger.info(
    `[forge-discover] whole org: ${nodes.length} object(s), ${edges.length} relation(s), ` +
      `${out.length} left out, ${totalRecords} record(s), in ${Date.now() - started}ms`,
  );
  return {
    nodes,
    edges,
    totalRecords,
    estimatedSizeMB: totalRecords * MB_PER_RECORD,
    estimatedDurationSeconds: totalRecords * SECONDS_PER_RECORD,
    truncated: false,
    leftOut: out,
  };
}
