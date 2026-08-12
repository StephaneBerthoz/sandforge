import type { ForgeConfig, ForgeGraph, ForgeGraphNode, ForgeGraphEdge } from '@sandforge/shared';
import { assertSoqlIdentifier } from '../../core/common/soqlValidator.js';
import { logger } from '../../logger.js';

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

/** Dependencies for GraphDiscoveryService, injected at construction time. */
export interface GraphDiscoveryDeps {
  /** Describe a Salesforce object by API name. */
  describeObject: (orgId: string, objectApiName: string) => Promise<ObjectDescribe>;
  /** Count records matching a SOQL query. */
  queryCount: (orgId: string, soql: string) => Promise<number>;
  /** Detect PII fields from a list of field describes. */
  detectPII: (fields: FieldDescribe[]) => string[];
  /** Describe all objects in the org (used for record ID prefix resolution). */
  describeGlobal: (orgId: string) => Promise<Array<{ name: string; keyPrefix: string | null }>>;
}

/** Progress event emitted during graph discovery. */
export interface DiscoveryProgressEvent {
  /** API name of the object just discovered. */
  objectApiName: string;
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
 * Yield to the event loop. `setImmediate` is Node-only — fall back to
 * `setTimeout(0)` so the suite stays portable across jsdom / browser-like
 * environments that the webview tests may run in.
 */
const yieldToEventLoop: () => Promise<void> =
  typeof setImmediate === 'function'
    ? () => new Promise<void>((resolve) => setImmediate(resolve))
    : () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** Hub/system objects excluded from BFS traversal (still referenced in edges). */
const EXCLUDED_OBJECTS = new Set([
  'User',
  'Group',
  'Profile',
  'UserRole',
  'RecordType',
  'Organization',
  'BusinessProcess',
  'CurrencyType',
  'DandBCompany',
  'DuplicateRecordItem',
  'DuplicateRecordSet',
  'ProcessInstance',
  // Big-org perf killers: SELECT COUNT() on these takes 30s+ each on big
  // sandboxes. They never carry user data worth cloning anyway.
  'LoginHistory',
  'LoginEvent',
  'LoginIp',
  'LoginGeo',
  'AsyncApexJob',
  'ApexLog',
  'ApexTestResult',
  'ApexTestQueueItem',
  'LightningUsageByPageMetrics',
  'LightningExitByPageMetrics',
  'EventBusSubscriber',
  'PlatformEventUsageMetric',
  'CronTrigger',
  'CronJobDetail',
  // Non-queryable virtual objects exposed in describe but unsupported by SOQL
  'AttachedContentDocument',
  'AttachedContentNote',
  'CombinedAttachment',
  'ContentBody',
  'NoteAndAttachment',
  'OwnedContentDocument',
  'EntitySubscription',
  'TopicAssignment',
  'UserRecordAccess',
  'DeclinedEventRelation',
  'UndecidedEventRelation',
  'AcceptedEventRelation',
  'OpenActivity',
  'ActivityHistory',
]);

/** Suffix patterns excluded from BFS traversal. */
const EXCLUDED_SUFFIXES = ['History', 'Feed', 'Share', 'ChangeEvent', '__hd', '__Tag'];

/** Check whether an object should be excluded from BFS traversal. */
function isExcludedObject(objectName: string): boolean {
  if (EXCLUDED_OBJECTS.has(objectName)) {
    return true;
  }
  return EXCLUDED_SUFFIXES.some((suffix) => objectName.endsWith(suffix));
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
    // Emit a synthetic "resolving" event so the wizard never sits silent
    // during the initial describeGlobal round-trip (5-50 MB on big orgs,
    // can take 30-90s on SOURCE-UAT).
    options?.onProgress?.({
      objectApiName: '__resolving_root__',
      discoveredCount: 0,
      queueRemaining: 1,
    });
    // PERF-001: breadcrumb the cold path. The audit doc identified
    // resolveRootObject (which calls describeGlobal) as the source of
    // 30-90s freezes on big orgs. Logging Date.now() at entry/exit lets
    // us measure empirically whether the cache + timeout fix is effective
    // for the next user session.
    const t0 = Date.now();
    const rootObject = await this.resolveRootObject(config);
    const t1 = Date.now();
    if (t1 - t0 > 2_000) {
      logger.warn(
        `[forge-discover] resolveRootObject took ${t1 - t0}ms (cold path, consider verifying describeGlobal cache state)`,
      );
    }
    const maxDepth = this.resolveMaxDepth(config);
    const maxNodes = options?.maxNodes ?? DEFAULT_MAX_NODES;

    const visitedObjects = new Set<string>();
    const nodes: ForgeGraphNode[] = [];
    const edgeMap = new Map<string, ForgeGraphEdge>();
    let skippedDueToCap = 0;

    const addEdge = (e: ForgeGraphEdge): void => {
      if (isExcludedObject(e.sourceObject) || isExcludedObject(e.targetObject)) return;
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

    // Drain the queue in waves of WAVE_SIZE entries fetched in parallel.
    // Sequential await per node was the root cause of the 2:30 freeze on
    // SOURCE-UAT (50 nodes × ~1.5s/node ≈ 75s). With 6 concurrent
    // describe+queryCount calls we stay under jsforce's default 5-conn pool
    // + Salesforce per-IP cap while shaving ~6× off the wall-clock time.
    const WAVE_SIZE = 6;
    let aborted = false;

    while (queue.length > 0 && !aborted) {
      if (options?.signal?.aborted) {
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

      // Cap wave at the smaller of WAVE_SIZE, remaining headroom under
      // maxNodes, and queue length. Without this, we over-process and
      // overshoot the user-supplied node cap.
      const remaining = maxNodes - nodes.length;
      if (remaining <= 0) break;
      const waveLimit = Math.min(WAVE_SIZE, remaining, queue.length);
      const wave = queue.splice(0, waveLimit);

      // Fetch describe + record count in parallel for every entry in the
      // wave. Per-call timeouts in the deps wrapper guarantee that one bad
      // jsforce call does not block the whole wave forever.
      type WaveResult = {
        objectName: string;
        depth: number;
        describe: ObjectDescribe;
        recordCount: number;
      } | null;
      // PERF-001: wave is processed cooperatively — Promise.all gathers
      // all describes/queryCounts (bounded by per-call timeouts in the
      // adapter layer) and the abort latch in the result-processing loop
      // below halts the BFS at the next wave boundary. The previous attempt
      // at racing the wave against signal abortion broke partial-graph
      // semantics (callers expect already-completed describes to be
      // surfaced even when abort fires mid-wave).
      const waveResults: WaveResult[] = await Promise.all(
        wave.map(async ([objectName, depth]): Promise<WaveResult> => {
          try {
            const [describe, recordCount] = await Promise.all([
              this.deps.describeObject(config.sourceOrgId, objectName),
              this.deps
                .queryCount(
                  config.sourceOrgId,
                  `SELECT COUNT() FROM ${assertSoqlIdentifier(objectName)}`,
                )
                .catch(() => 0),
            ]);
            return { objectName, depth, describe, recordCount };
          } catch {
            // Hard failure (timeout, FLS-blocked, non-queryable) —
            // emit empty node so the user sees we tried, then skip.
            return null;
          }
        }),
      );

      // Sequentially process the results: build the node, walk relations,
      // enqueue children. The abort check happens AFTER each result is
      // processed so the in-flight describe that triggered the abort is
      // still added (consistent with sequential semantics).
      for (const r of waveResults) {
        if (aborted) break;
        if (!r) continue;
        const { objectName, depth, describe, recordCount } = r;
        const piiFields = this.deps.detectPII(describe.fields);
        const createableFieldCount = describe.fields.filter((f) => f.type !== 'id').length;
        const node: ForgeGraphNode = {
          objectApiName: objectName,
          recordCount,
          fieldCount: describe.fields.length,
          status: 'idle',
          progress: 0,
          included: !config.skipEmpty || recordCount > 0,
          piiFields,
          anonymizeFields: config.anonymizePII ? piiFields : [],
          level: depth,
          successCount: 0,
          failureCount: 0,
          errors: [],
          createableFieldCount,
          estimatedSizeMB: recordCount * MB_PER_RECORD,
          estimatedApiCalls: Math.ceil(recordCount / 200),
          batchStrategy: 'auto' as const,
        };
        nodes.push(node);

        if (depth < maxDepth) {
          for (const field of describe.fields) {
            if (field.referenceTo.length === 0) continue;
            for (const targetObject of field.referenceTo) {
              addEdge({
                sourceObject: targetObject,
                targetObject: objectName,
                relationshipName: field.relationshipName ?? field.name,
                type: field.isMasterDetail ? 'master-detail' : 'lookup',
              });
              if (!visitedObjects.has(targetObject) && !isExcludedObject(targetObject)) {
                visitedObjects.add(targetObject);
                if (nodes.length + queue.length < maxNodes) {
                  queue.push([targetObject, depth + 1]);
                } else {
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
            if (!visitedObjects.has(child.childSObject) && !isExcludedObject(child.childSObject)) {
              visitedObjects.add(child.childSObject);
              if (nodes.length + queue.length < maxNodes) {
                queue.push([child.childSObject, depth + 1]);
              } else {
                skippedDueToCap++;
              }
            }
          }
        }

        options?.onProgress?.({
          objectApiName: objectName,
          discoveredCount: nodes.length,
          queueRemaining: queue.length,
        });

        // Latch abort AFTER processing the in-flight result. Any other
        // already-completed results in the wave are dropped on next iter.
        if (options?.signal?.aborted) {
          aborted = true;
        }
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
  private async resolveRootObject(config: ForgeConfig): Promise<string> {
    if (config.inputMode === 'record' && config.recordId) {
      const prefix = config.recordId.substring(0, 3);
      const globalDesc = await this.deps.describeGlobal(config.sourceOrgId);
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
