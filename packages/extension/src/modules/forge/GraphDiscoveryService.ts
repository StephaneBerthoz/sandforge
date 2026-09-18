import type { ForgeConfig, ForgeGraph, ForgeGraphNode, ForgeGraphEdge } from '@sandforge/shared';
import { assertSoqlIdentifier } from '../../core/common/soqlValidator.js';
import { extractErrorMessage } from '../../core/common/extractErrorMessage.js';
import { logger } from '../../logger.js';
import { isForgeExcludedObject } from './excludedObjects.js';
import { CONCURRENT_DESCRIBE_LIMIT } from './orgConcurrency.js';

/** Describe result for an object returned by the org connection. */
export interface ObjectDescribe {
  /** API name of the object. */
  name: string;
  /** Fields on the object. */
  fields: FieldDescribe[];
  /** Child relationships where this object is the parent. */
  childRelationships: ChildRelationship[];
}

/** Describe result for a single field. */
export interface FieldDescribe {
  /** Field API name. */
  name: string;
  /** Salesforce field type (e.g. 'reference', 'string'). */
  type: string;
  /** Objects this field references (non-empty for lookups). */
  referenceTo: string[];
  /** Relationship name, if any. */
  relationshipName: string | null;
  /** Whether this is a master-detail relationship. */
  isMasterDetail: boolean;
  /**
   * Whether the field accepts null. `false` means the platform refuses a
   * record that does not carry it, which makes the object it points at a
   * dependency rather than a nicety. Optional so a caller that cannot say
   * keeps the previous behaviour: unknown is treated as nullable.
   */
  nillable?: boolean;
}

/** Child relationship descriptor from the parent object describe. */
export interface ChildRelationship {
  /** API name of the child object. */
  childSObject: string;
  /** Field on the child object that holds the relationship. */
  field: string;
  /** Relationship name. */
  relationshipName: string;
  /** Whether deleting the parent cascades to the child. */
  isCascadeDelete: boolean;
}

/**
 * Dependencies for GraphDiscoveryService, injected at construction time.
 *
 * Every org call receives the discovery's abort signal. The service stops
 * waiting on a call as soon as the signal fires, whatever the dependency does
 * with it; a dependency uses it to avoid starting a request nobody will read.
 */
export interface GraphDiscoveryDeps {
  /** Describe a Salesforce object by API name. */
  describeObject: (
    orgId: string,
    objectApiName: string,
    signal?: AbortSignal,
  ) => Promise<ObjectDescribe>;
  /** Count records matching a SOQL query. */
  queryCount: (orgId: string, soql: string, signal?: AbortSignal) => Promise<number>;
  /** Detect PII fields from a list of field describes. */
  detectPII: (fields: FieldDescribe[]) => string[];
  /** Describe all objects in the org (used for record ID prefix resolution). */
  describeGlobal: (
    orgId: string,
    signal?: AbortSignal,
  ) => Promise<Array<{ name: string; keyPrefix: string | null }>>;
}

/**
 * What a progress event reports:
 * - `resolving-root`: the root object is being looked up, nothing discovered yet;
 * - `object`: one more object was added to the graph;
 * - `cached`: a graph discovered earlier is served whole.
 */
export type DiscoveryPhase = 'resolving-root' | 'object' | 'cached';

/** Progress event emitted during graph discovery. */
export interface DiscoveryProgressEvent {
  /** What the event reports. */
  phase: DiscoveryPhase;
  /** API name of the object just discovered. Set on `object` events only. */
  objectApiName?: string;
  /** Total count of nodes discovered so far. */
  discoveredCount: number;
  /** Number of objects remaining in the BFS queue. */
  queueRemaining: number;
}

/** Options for the discover method. */
export interface DiscoveryOptions {
  /** Signal to abort discovery early. */
  signal?: AbortSignal;
  /** Callback invoked after each node is discovered. */
  onProgress?: (event: DiscoveryProgressEvent) => void;
  /** Override the default max nodes cap (default: 50). */
  maxNodes?: number;
}

/** Heuristic: estimated MB per record. */
const MB_PER_RECORD = 0.001;
/** Heuristic: estimated seconds per record. */
const SECONDS_PER_RECORD = 0.01;

/** Default maximum number of nodes to discover. */
const DEFAULT_MAX_NODES = 50;

/**
 * How far past the node cap discovery may go to reach a required parent.
 *
 * The cap bounds how much work a discovery does, and it is right to bound
 * optional breadth: an object's children are a nicety, and fifty of them is
 * already more than a person reads. A parent behind a non-nullable lookup is
 * not optional — the child cannot be written without it, so leaving it out
 * buys nothing and costs the whole write. Run for real, an Opportunity's
 * fifty-odd child relationships filled the cap before discovery ever reached
 * `PricebookEntry`, and every line item was then refused with
 * `FIELD_INTEGRITY_EXCEPTION: must specify pricebook entry id`.
 *
 * So required parents raise the budget by one each, and this bounds how far
 * that can go: a graph still stops, it just stops after the things it needs
 * rather than before them.
 */
const REQUIRED_PARENT_CEILING_FACTOR = 2;

/**
 * Yield to the event loop. `setImmediate` is Node-only — fall back to
 * `setTimeout(0)` so the suite stays portable across jsdom / browser-like
 * environments that the webview tests may run in.
 */
const yieldToEventLoop: () => Promise<void> =
  typeof setImmediate === 'function'
    ? () => new Promise<void>((resolve) => setImmediate(resolve))
    : () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** Raised inside the walk when the signal fires while an org call is pending. */
class DiscoveryCancelled extends Error {
  constructor() {
    super('Discovery cancelled');
    this.name = 'DiscoveryCancelled';
  }
}

/**
 * Run one org call and settle as soon as either it answers or `signal` fires.
 *
 * jsforce gives no way to tear down a request it has sent, so a call that hangs
 * on a rate-limited org would otherwise hold the whole wave until its timeout.
 * The listener is attached before the call starts, so a cancel that lands while
 * the call is being issued is not missed. A call that answers after the cancel
 * is ignored; its rejection is still observed here, never left unhandled.
 */
function untilCancelled<T>(call: () => Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return call();
  if (signal.aborted) return Promise.reject(new DiscoveryCancelled());
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(new DiscoveryCancelled());
    signal.addEventListener('abort', onAbort, { once: true });
    call().then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

/** The graph a discovery cancelled before its root was resolved hands back. */
function emptyGraph(): ForgeGraph {
  return {
    nodes: [],
    edges: [],
    totalRecords: 0,
    estimatedSizeMB: 0,
    estimatedDurationSeconds: 0,
    truncated: false,
  };
}

/**
 * Service that discovers the Salesforce dependency graph for a Forge operation.
 *
 * Given a ForgeConfig (record ID or SOQL), performs BFS traversal of object
 * relationships to build a complete ForgeGraph with nodes, edges, and estimates.
 */
export class GraphDiscoveryService {
  private readonly deps: GraphDiscoveryDeps;

  /** @param deps - Injected dependencies for org interaction and PII detection. */
  constructor(deps: GraphDiscoveryDeps) {
    this.deps = deps;
  }

  /**
   * Discover the full dependency graph for the given Forge configuration.
   *
   * @param config - Forge configuration specifying input mode, depth, and source org.
   * @param options - Optional settings for abort, progress reporting, and node cap.
   * @returns The complete ForgeGraph with nodes, edges, and estimates.
   */
  async discover(config: ForgeConfig, options?: DiscoveryOptions): Promise<ForgeGraph> {
    const signal = options?.signal;
    if (signal?.aborted) return emptyGraph();
    // Emit a "resolving" event so the wizard never sits silent
    // during the initial describeGlobal round-trip (5-50 MB on big orgs,
    // can take 30-90s on a large org).
    options?.onProgress?.({
      phase: 'resolving-root',
      discoveredCount: 0,
      queueRemaining: 1,
    });
    // Breadcrumb the cold path. Profiling identified
    // resolveRootObject (which calls describeGlobal) as the source of
    // 30-90s freezes on big orgs. Logging Date.now() at entry/exit lets
    // us measure empirically whether the cache + timeout fix is effective
    // for the next user session.
    const t0 = Date.now();
    let rootObject: string;
    try {
      rootObject = await this.resolveRootObject(config, signal);
    } catch (e) {
      if (e instanceof DiscoveryCancelled) return emptyGraph();
      throw e;
    }
    const t1 = Date.now();
    if (t1 - t0 > 2_000) {
      logger.warn(
        `[forge-discover] resolveRootObject took ${t1 - t0}ms (cold path, consider verifying describeGlobal cache state)`,
      );
    }
    const maxDepth = this.resolveMaxDepth(config);
    const maxNodes = options?.maxNodes ?? DEFAULT_MAX_NODES;
    /**
     * The cap as it currently stands. It starts at `maxNodes` and rises by
     * one for each required parent admitted past it, never above the ceiling.
     */
    let nodeBudget = maxNodes;
    const nodeCeiling = maxNodes * REQUIRED_PARENT_CEILING_FACTOR;
    /**
     * Objects the cap turned away. They stay visited so the walk does not
     * revisit them for nothing, and a later required lookup can take one back.
     */
    const cappedOutObjects = new Set<string>();

    const visitedObjects = new Set<string>();
    const nodes: ForgeGraphNode[] = [];
    const edgeMap = new Map<string, ForgeGraphEdge>();
    let skippedDueToCap = 0;

    const addEdge = (e: ForgeGraphEdge): void => {
      if (isForgeExcludedObject(e.sourceObject) || isForgeExcludedObject(e.targetObject)) return;
      if (e.sourceObject === e.targetObject) return;
      const key = `${e.sourceObject}|${e.targetObject}`;
      const existing = edgeMap.get(key);
      if (!existing) {
        edgeMap.set(key, e);
      } else if (e.type === 'master-detail' && existing.type === 'lookup') {
        edgeMap.set(key, e);
      }
    };

    // BFS queue: [objectApiName, currentDepth]
    const queue: Array<[string, number]> = [[rootObject, 0]];
    visitedObjects.add(rootObject);

    // Drain the queue in waves fetched in parallel. Sequential await per node
    // was the root cause of the 2:30 freeze on a large org (50 nodes ×
    // ~1.5s/node ≈ 75s); a wave of CONCURRENT_DESCRIBE_LIMIT describe+queryCount
    // calls shaves ~6× off the wall-clock time.

    while (queue.length > 0) {
      if (signal?.aborted) {
        break;
      }

      // Yield to the event loop so VSCode's UI thread gets a chance to
      // paint between waves. Without this, even with parallel I/O, the
      // synchronous post-processing (build node, walk relations, push
      // queue, etc.) can starve the renderer for seconds → "window not
      // responding" dialog. Polyfill: setImmediate is Node-only;
      // tests under jsdom or browser-like environments fall back to
      // setTimeout(0) so the suite stays portable.
      await yieldToEventLoop();

      // Cap wave at the smaller of the concurrent-describe limit, remaining
      // headroom under maxNodes, and queue length. Without this, we
      // over-process and overshoot the user-supplied node cap.
      const remaining = nodeBudget - nodes.length;
      if (remaining <= 0) break;
      const waveLimit = Math.min(CONCURRENT_DESCRIBE_LIMIT, remaining, queue.length);
      const wave = queue.splice(0, waveLimit);

      // Fetch describe + record count in parallel for every entry in the
      // wave. Per-call timeouts in the deps wrapper guarantee that one bad
      // jsforce call does not block the whole wave forever.
      // `describe: null` / `recordCount: -1` are the two failure sentinels:
      // an object we could not describe at all, and one we described but
      // could not count. Both still become nodes below — a graph that
      // silently omits them looks complete when it is not.
      // `cancelled` marks an object whose calls were still pending when the
      // signal fired: nothing is known about it, so it is left out.
      type WaveResult = {
        objectName: string;
        depth: number;
        describe: ObjectDescribe | null;
        recordCount: number;
        countError?: string;
        describeError?: string;
        cancelled?: true;
      };
      // Each call settles on its own answer or on the signal, whichever comes
      // first, so a cancel does not wait for the slowest call of the wave.
      // Objects whose calls had both answered before the cancel keep their
      // results and are added below: the partial graph holds everything that
      // was actually learned.
      const waveResults: WaveResult[] = await Promise.all(
        wave.map(async ([objectName, depth]): Promise<WaveResult> => {
          let countError: string | undefined = undefined;
          // An object with a filter is cloned through it (in SOQL mode, the
          // object after FROM), so its count is the rows the filter matches.
          const filter = config.objectSoqlFilters?.[objectName];
          const countSoql = `SELECT COUNT() FROM ${assertSoqlIdentifier(objectName)}${
            filter ? ` WHERE (${filter})` : ''
          }`;
          try {
            const [describe, recordCount] = await Promise.all([
              untilCancelled(
                () => this.deps.describeObject(config.sourceOrgId, objectName, signal),
                signal,
              ),
              untilCancelled(
                () => this.deps.queryCount(config.sourceOrgId, countSoql, signal),
                signal,
              ).catch((e: unknown) => {
                if (e instanceof DiscoveryCancelled) throw e;
                countError = extractErrorMessage(e);
                return -1;
              }),
            ]);
            return { objectName, depth, describe, recordCount, countError };
          } catch (e) {
            if (e instanceof DiscoveryCancelled || signal?.aborted) {
              return { objectName, depth, describe: null, recordCount: -1, cancelled: true };
            }
            // Describe failed hard (timeout, FLS-blocked, non-queryable).
            // We know nothing about the object's shape, so it carries no
            // fields and no relations to walk — but it stays in the graph
            // as an error node so the user sees which branch we lost.
            return {
              objectName,
              depth,
              describe: null,
              recordCount: -1,
              describeError: extractErrorMessage(e),
            };
          }
        }),
      );

      // Sequentially process the results: build the node, walk relations,
      // enqueue children. A cancel stops the walk at the next wave boundary
      // (the check at the top of the loop); the objects of this wave that had
      // answered are still added.
      for (const r of waveResults) {
        if (r.cancelled) continue;
        const { objectName, depth, describe, recordCount, countError, describeError } = r;

        if (!describe) {
          nodes.push({
            objectApiName: objectName,
            recordCount: 0,
            fieldCount: 0,
            status: 'error',
            progress: 0,
            included: false,
            piiFields: [],
            anonymizeFields: [],
            level: depth,
            successCount: 0,
            failureCount: 0,
            errors: [`Describe unavailable: ${describeError ?? 'unknown error'}`],
            createableFieldCount: 0,
            estimatedSizeMB: 0,
            estimatedApiCalls: 0,
            batchStrategy: 'auto' as const,
          });
          options?.onProgress?.({
            phase: 'object',
            objectApiName: objectName,
            discoveredCount: nodes.length,
            queueRemaining: queue.length,
          });
          continue;
        }

        // The count query failed while the describe succeeded: keep the
        // object visible with its real shape, but excluded — cloning an
        // unknown number of records is not something the user can size.
        const countFailed = recordCount < 0;
        const effectiveCount = countFailed ? 0 : recordCount;
        const piiFields = this.deps.detectPII(describe.fields);
        const createableFieldCount = describe.fields.filter((f) => f.type !== 'id').length;
        const node: ForgeGraphNode = {
          objectApiName: objectName,
          recordCount: effectiveCount,
          fieldCount: describe.fields.length,
          status: countFailed ? 'error' : 'idle',
          progress: 0,
          included: countFailed ? false : !config.skipEmpty || effectiveCount > 0,
          piiFields,
          anonymizeFields: config.anonymizePII ? piiFields : [],
          level: depth,
          successCount: 0,
          failureCount: 0,
          errors: countFailed ? [`Record count unavailable: ${countError ?? 'unknown error'}`] : [],
          createableFieldCount,
          estimatedSizeMB: effectiveCount * MB_PER_RECORD,
          estimatedApiCalls: Math.ceil(effectiveCount / 200),
          batchStrategy: 'auto' as const,
        };
        nodes.push(node);

        if (depth < maxDepth) {
          for (const field of describe.fields) {
            if (field.referenceTo.length === 0) continue;
            // A lookup the platform will not let the record omit. The object
            // behind it has to be in the graph or the child cannot be written.
            const required = field.nillable === false;
            for (const targetObject of field.referenceTo) {
              addEdge({
                sourceObject: targetObject,
                targetObject: objectName,
                relationshipName: field.relationshipName ?? field.name,
                type: field.isMasterDetail ? 'master-detail' : 'lookup',
              });
              // An object the cap turned away is still marked visited, so
              // without this it can never come back — and the first thing to
              // meet it is usually an optional child relationship, long
              // before the one lookup that cannot do without it. Run for
              // real, `Product2` was turned away that way and every price
              // book entry was then refused for want of a product.
              const turnedAwayEarlier = cappedOutObjects.has(targetObject);
              const firstSighting = !visitedObjects.has(targetObject);
              if (
                (firstSighting || (required && turnedAwayEarlier)) &&
                !isForgeExcludedObject(targetObject)
              ) {
                if (nodes.length + queue.length < nodeBudget) {
                  visitedObjects.add(targetObject);
                  cappedOutObjects.delete(targetObject);
                  // Ahead of the optional breadth already queued: reaching a
                  // dependency late is the same as not reaching it.
                  if (required) queue.unshift([targetObject, depth + 1]);
                  else queue.push([targetObject, depth + 1]);
                } else if (required && nodeBudget < nodeCeiling) {
                  visitedObjects.add(targetObject);
                  cappedOutObjects.delete(targetObject);
                  nodeBudget++;
                  queue.unshift([targetObject, depth + 1]);
                } else {
                  visitedObjects.add(targetObject);
                  cappedOutObjects.add(targetObject);
                  skippedDueToCap++;
                }
              }
            }
          }
          for (const child of describe.childRelationships) {
            addEdge({
              sourceObject: objectName,
              targetObject: child.childSObject,
              relationshipName: child.relationshipName,
              type: child.isCascadeDelete ? 'master-detail' : 'lookup',
            });
            if (
              !visitedObjects.has(child.childSObject) &&
              !isForgeExcludedObject(child.childSObject)
            ) {
              visitedObjects.add(child.childSObject);
              if (nodes.length + queue.length < nodeBudget) {
                queue.push([child.childSObject, depth + 1]);
              } else {
                // Noted rather than forgotten: this is usually where an
                // object is first met, and a required lookup later on is
                // what takes it back.
                cappedOutObjects.add(child.childSObject);
                skippedDueToCap++;
              }
            }
          }
        }

        options?.onProgress?.({
          phase: 'object',
          objectApiName: objectName,
          discoveredCount: nodes.length,
          queueRemaining: queue.length,
        });
      }
    }

    const totalRecords = nodes.reduce((sum, n) => sum + n.recordCount, 0);
    const edges = [...edgeMap.values()];

    return {
      nodes,
      edges,
      totalRecords,
      estimatedSizeMB: totalRecords * MB_PER_RECORD,
      estimatedDurationSeconds: totalRecords * SECONDS_PER_RECORD,
      truncated: skippedDueToCap > 0,
    };
  }

  /**
   * Resolve the root object name from the config.
   * For record mode, uses describeGlobal to resolve object type from the record ID prefix.
   * For SOQL mode, parses the FROM clause.
   */
  private async resolveRootObject(
    config: ForgeConfig,
    signal: AbortSignal | undefined,
  ): Promise<string> {
    if (config.inputMode === 'record' && config.recordId) {
      const prefix = config.recordId.substring(0, 3);
      const globalDesc = await untilCancelled(
        () => this.deps.describeGlobal(config.sourceOrgId, signal),
        signal,
      );
      const match = globalDesc.find((s) => s.keyPrefix === prefix);
      if (!match) {
        throw new Error(
          `No object found for record ID prefix "${prefix}". The ID may not belong to any accessible object in this org.`,
        );
      }
      return match.name;
    }
    if (config.inputMode === 'soql' && config.soqlQuery) {
      return parseObjectFromSOQL(config.soqlQuery);
    }
    throw new Error(
      `Cannot resolve root object for inputMode "${config.inputMode}". Provide a valid recordId (for "record" mode) or soqlQuery (for "soql" mode).`,
    );
  }

  /** Resolve the maximum BFS traversal depth from the config. */
  private resolveMaxDepth(config: ForgeConfig): number {
    switch (config.depth) {
      case 'direct':
        return 1;
      case 'full':
        return 5;
      case 'custom':
        // Hard upper bound 10 — beyond this BFS hammers the org's API
        // governor limits without producing a usable graph (depth 10 of
        // a CRM org explodes into thousands of describes).
        return Math.max(1, Math.min(10, config.customDepth ?? 3));
    }
  }
}

/**
 * Parse the object name from a SOQL query's FROM clause. Strips comments
 * and subqueries first so nested SELECTs and block comments don't trick
 * the parser into picking the wrong root. Validates via assertSoqlIdentifier
 * to block crafted SOQL injection from user-supplied queries.
 *
 * Subquery stripping iterates to a fixed point so deeply nested parens
 * (`SELECT … FROM (SELECT … FROM (SELECT … FROM Inner))`) are fully removed.
 * A single-pass `.replace(/\([^()]*\)/g, '')` only strips one nesting level
 * and leaves a stale `FROM Inner` that the parser would mistake for the root.
 * Bounded to 32 iterations (deeper than any realistic SOQL) to keep this O(L).
 */
function parseObjectFromSOQL(soql: string): string {
  let cleaned = soql.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '');
  for (let i = 0; i < 32; i++) {
    const next = cleaned.replace(/\([^()]*\)/g, '');
    if (next === cleaned) break;
    cleaned = next;
  }
  const matched = /\bFROM\s+(\w+)/i.exec(cleaned);
  if (!matched) {
    throw new Error(
      'Could not parse object name from SOQL query. Ensure the query uses standard "SELECT ... FROM ObjectName" syntax.',
    );
  }
  return assertSoqlIdentifier(matched[1]);
}
