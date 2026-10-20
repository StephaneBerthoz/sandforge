import { TypedEventEmitter } from '../../core/common/TypedEventEmitter.js';
import type {
  ForgeConfig,
  ForgeFileCopyOption,
  ForgeGraph,
  ForgeExecutionResult,
  ForgePlan,
  ForgeWriteOptions,
} from '@sandforge/shared';
import { BYTES_PER_MB, FORGE_READ_CEILING_PER_OBJECT, leftOutByTheUser } from '@sandforge/shared';
import type { GraphDiscoveryService, DiscoveryOptions } from './GraphDiscoveryService.js';
import type { ExecuteOptions, ForgeExecutor, ForgeProgressEvent } from './ForgeExecutor.js';
import type { ForgePlanGenerator } from './ForgePlanGenerator.js';
import {
  runAnonymization,
  type ForgeAnonymizationMethods,
  type PIIFieldInfo,
} from './ForgeAnonymizer.js';
import { extractErrorMessage } from '../../core/common/extractErrorMessage.js';
import { finishedRunStatus, forgeRunResult } from './runResult.js';
import { SchemaCache } from '../../core/metadata/SchemaCache.js';
import { runDecisionsOf } from './stages/RunDecisions.js';

/** Events emitted by ForgeOrchestrator during operation. */
type ForgeEvents = {
  [key: string]: unknown;
  /** Emitted on each node progress update during execution. */
  'forge:progress': ForgeProgressEvent;
  /** Emitted when execution completes successfully. */
  'forge:complete': ForgeExecutionResult;
  /** Emitted when an unrecoverable error occurs. */
  'forge:error': { message: string };
};

/** Dependencies for ForgeOrchestrator, injected at construction time. */
export interface ForgeOrchestratorDeps {
  /** Service for discovering the dependency graph. */
  discoveryService: GraphDiscoveryService;
  /** Executor for running the forge plan. */
  executor: ForgeExecutor;
  /** Optional plan generator for wave-based execution planning. */
  planGenerator?: ForgePlanGenerator;
  /**
   * Drop the cached org describes, for every org or only the ones named.
   *
   * The discovery cache is not the only thing that goes stale when the source
   * or target schema changes: the graph is built from describes held in their
   * own cache, so re-discovering with that cache warm rebuilt the same graph
   * from the same five-minute-old schema.
   */
  clearDescribes?: (orgIds?: string[]) => void;
  /**
   * Set what the writes of the run about to start ask of the target's rules:
   * whether its assignment rules apply to the records the run creates and
   * updates. The executor holds one run at a time, and its writers read it as
   * each call goes out; told before every run, a run never writes with the
   * choice of the one before it.
   */
  setWriteOptions?: (options: ForgeWriteOptions) => void;
  /**
   * Set the most rows of one object the run about to start reads
   * (`sandforge.forge.maxRecordsPerObject`): the bound of every read that
   * holds its rows. Told before every run, as `setWriteOptions` is.
   */
  setReadOptions?: (options: { maxRecordsPerObject: number }) => void;
}

/**
 * Central orchestrator for the Forge module.
 *
 * Coordinates the full flow: discover dependency graph -> execute plan.
 * Emits typed events for progress tracking and completion notification.
 */
export class ForgeOrchestrator extends TypedEventEmitter<ForgeEvents> {
  private readonly deps: ForgeOrchestratorDeps;

  /**
   * Session-scoped discovery cache. Keyed by
   * `${sourceOrgId}::${inputMode}::${recordId|soql}::${depth}::${customDepth}`.
   * Avoids re-running the 30s+ BFS when the user re-discovers the same root
   * within the same VSCode session. TTL 10min, LRU 16 entries (~5MB max)
   * so stale graphs after schema changes age out without manual reset.
   */
  private discoveryCache = new SchemaCache<ForgeGraph>({
    defaultTtl: 10 * 60_000,
    maxSize: 16,
    maxSizeBytes: 5 * 1024 * 1024,
  });

  /** @param deps - Injected dependencies for discovery and execution. */
  constructor(deps: ForgeOrchestratorDeps) {
    super();
    this.deps = deps;
  }

  /**
   * Compute a stable cache key for a discovery request. Identical configs
   * resolve to the same key — different sources/depths/inputs collide
   * intentionally to share the same cached graph.
   *
   * Includes every config field that materially affects the resulting graph
   * (target org, anonymize, expandOrphanParents, maxRecordsPerObject) so
   * cache hits never silently swap one configuration for another.
   */
  private cacheKeyFor(config: ForgeConfig): string {
    const root =
      config.inputMode === 'record'
        ? (config.recordId ?? '')
        : config.inputMode === 'soql'
          ? (config.soqlQuery ?? '')
          : config.inputMode === 'template'
            ? (config.templateId ?? '')
            : (config.aiPrompt ?? '');
    return [
      config.sourceOrgId,
      config.targetOrgId,
      config.inputMode,
      root,
      config.depth,
      config.customDepth ?? '',
      config.skipEmpty ? 'skipEmpty' : '',
      config.anonymizePII ? 'anonPII' : '',
      config.expandOrphanParents ? 'orphan' : '',
      config.maxRecordsPerObject ?? '',
    ].join('::');
  }

  /**
   * Drop the discovery cache and the org describes behind it — called when the
   * user explicitly re-discovers. Keeping the describes would rebuild the same
   * graph from the same schema and make the re-discovery a no-op.
   *
   * @param orgIds - The orgs whose schema the caller is re-reading, normally
   *   the source and the target of the run. Omitted, every org's describes go:
   *   a caller that cannot name its pair still gets a truthful rebuild, at the
   *   cost of the describes another org pair had warm.
   */
  clearDiscoveryCache(orgIds?: string[]): void {
    this.discoveryCache.clear();
    this.deps.clearDescribes?.(orgIds);
  }

  /**
   * Free resources held by the orchestrator. Called when the extension
   * deactivates or the user disconnects an org. Without this,
   * the discoveryCache (16 entries × ~5 MB) stays in heap until VSCode
   * restarts, and stale graphs survive schema changes on the source org.
   */
  dispose(): void {
    this.discoveryCache.clear();
    this.removeAllListeners?.();
  }

  /**
   * Discover the full dependency graph for the given Forge configuration.
   *
   * @param config - Forge configuration specifying input, depth, and orgs.
   * @param options - Optional discovery options (abort signal, progress, max nodes).
   * @returns The discovered ForgeGraph with nodes, edges, and estimates.
   */
  async discover(config: ForgeConfig, options?: DiscoveryOptions): Promise<ForgeGraph> {
    const key = this.cacheKeyFor(config);
    const cached = this.discoveryCache.get(key);
    if (cached) {
      // Emit a single synthetic event on cache hit instead of replaying N
      // events (was a perf cliff on big graphs: 350 sequential postMessages
      // blocked the event loop for ~200ms for no useful UI feedback).
      options?.onProgress?.({
        phase: 'cached',
        discoveredCount: cached.nodes.length,
        queueRemaining: 0,
      });
      return cached;
    }
    const graph = await this.deps.discoveryService.discover(config, options);
    // A cancelled BFS returns the partial graph it had reached. It is still
    // handed back, but never cached: the next identical request would
    // otherwise be served the truncated graph as a complete one.
    if (!options?.signal?.aborted) {
      this.discoveryCache.set(key, graph);
    }
    return graph;
  }

  /**
   * The graph with the personal fields of the nodes that know none of their
   * fields read from the source org — see
   * {@link GraphDiscoveryService.readPersonalFields}.
   */
  readPersonalFields(
    graph: ForgeGraph,
    config: Pick<ForgeConfig, 'sourceOrgId' | 'anonymizePII'>,
    signal?: AbortSignal,
  ): Promise<ForgeGraph> {
    return this.deps.discoveryService.readPersonalFields(graph, config, signal);
  }

  /**
   * Generate an execution plan from a ForgeGraph.
   *
   * @param graph - The dependency graph to plan.
   * @returns A ForgePlan with waves, timing estimates, and cycle resolutions.
   * @throws Error if planGenerator is not configured.
   */
  async generatePlan(graph: ForgeGraph): Promise<ForgePlan> {
    if (!this.deps.planGenerator) {
      throw new Error(
        'Plan generator not configured. Ensure ForgeOrchestrator was initialized with a planGenerator dependency.',
      );
    }
    return this.deps.planGenerator.generate(graph);
  }

  /**
   * Execute the forge plan for the given graph and configuration.
   *
   * Inserts records from source to target org in topological order,
   * remapping IDs along the way. Emits progress events and a final
   * completion event with the execution result.
   *
   * @param graph - The dependency graph to execute.
   * @param config - Forge configuration with source/target org IDs.
   * @returns The execution result with status, timing, and remap count.
   */
  /** Abort the current forge execution. Delegates to the internal executor. */
  abort(): void {
    this.deps.executor.abort();
  }

  /** Pause the current forge execution. Delegates to the internal executor. */
  pause(): void {
    this.deps.executor.pause();
  }

  /** Resume the current forge execution. Delegates to the internal executor. */
  resume(): void {
    this.deps.executor.resume();
  }

  /**
   * @param runOptions - Execution inputs that are not part of the user's
   *   config: the RecordType translation table the bridge builds by querying
   *   both orgs before a run, the method per PII category Review holds,
   *   whether Review asked for the files of the records to be copied, for a
   *   retry, what the run it retries wrote, and what is to see every row
   *   before the first is written.
   */
  async execute(
    graph: ForgeGraph,
    config: ForgeConfig,
    runOptions?: ForgeRunOptions,
  ): Promise<ForgeExecutionResult> {
    const startTime = Date.now();

    try {
      const scoped = forgeExecuteOptions(graph, config, runOptions, (fields) =>
        this.deps.discoveryService.personalFields(fields),
      );
      const stream = runOptions?.stream;

      // Forge sets each record's owner itself: the target's assignment rules
      // apply only when the run asks for them.
      this.deps.setWriteOptions?.({ applyAssignmentRules: config.applyAssignmentRules === true });
      this.deps.setReadOptions?.({
        maxRecordsPerObject: stream?.ceiling ?? FORGE_READ_CEILING_PER_OBJECT,
      });
      const summary = await this.deps.executor.execute(
        graph,
        config.sourceOrgId,
        config.targetOrgId,
        (event) => this.emit('forge:progress', event),
        scoped,
      );

      const result = forgeRunResult(summary, graph, {
        startedAt: startTime,
        status: finishedRunStatus(summary),
      });

      this.emit('forge:complete', result);
      return result;
    } catch (err) {
      const message = extractErrorMessage(err);
      this.emit('forge:error', { message });
      throw err;
    } finally {
      // What reads through the same deps after the run — a rehearsal, a
      // verification — reads to the default, never to this run's number.
      this.deps.setReadOptions?.({ maxRecordsPerObject: FORGE_READ_CEILING_PER_OBJECT });
    }
  }
}

/**
 * What a run is handed besides the user's config: the RecordType translation
 * table built by querying both orgs before a run, the method per PII category
 * Review holds, whether the files of the records are copied, for a retry,
 * what the run it retries wrote, what is to see every row before the first is
 * written, and how a run of whole tables is read page by page.
 */
export type ForgeRunOptions = Pick<
  ExecuteOptions,
  'recordTypeMappings' | 'writtenBefore' | 'beforeWrite' | 'stream'
> & {
  anonymizationRules?: ForgeAnonymizationMethods;
  files?: ForgeFileCopyOption;
};

/**
 * What the executor is asked to do by a run of `config` over `graph`, as
 * {@link ForgeOrchestrator.execute} asks it: a run from a record reads what
 * that record reaches; any other reads whole tables, each through its own
 * filter, page by page once `runOptions.stream` is given. Exported so that a
 * run of whole tables from the command line is handed to the executor as the
 * panel's is, rather than by a copy of these rules that could drift from them.
 *
 * @param personalFieldsOf - The personal fields of an object, as discovery
 *   names them: what anonymization covers on a record read from outside the
 *   graph.
 */
export function forgeExecuteOptions(
  graph: ForgeGraph,
  config: ForgeConfig,
  runOptions: ForgeRunOptions | undefined,
  personalFieldsOf: (fields: PIIFieldInfo[]) => string[],
): ExecuteOptions | undefined {
  // When inputMode === 'record', activate scoped execution so the
  // executor only clones the transitive closure of the root record
  // instead of the whole graph. Orphan parent expansion flows
  // through ForgeConfig. The maxRecordsPerObject cap
  // applies to all input modes — it's a safety knob, not scope-only.
  const recordTypeMappings = runOptions?.recordTypeMappings;
  const anonymization = runAnonymization(
    config.anonymizePII,
    graph,
    runOptions?.anonymizationRules,
    personalFieldsOf,
  );
  const files: ExecuteOptions['files'] = runOptions?.files
    ? {
        maxFileBytes: runOptions.files.maxFileSizeMB * BYTES_PER_MB,
        acceptedAsIs: runOptions.files.acceptedAsIs,
      }
    : undefined;
  const writtenBefore = runOptions?.writtenBefore;
  const beforeWrite = runOptions?.beforeWrite;
  // Read page by page when it reads whole tables: see `ExecuteOptions.stream`.
  const stream = runOptions?.stream;
  // The objects unchecked on the Forge page leave the run as objects
  // excluded by name: the rows that cannot be written without one of
  // their records are held back and said, not sent for the target to
  // refuse. Discovery's own — the empty tables, what it could not read —
  // stay nodes the run skips. So do the objects the user chose on the
  // Gaps tab not to write: what points at them goes as at any object
  // outside the clone.
  const leftOut = [
    ...new Set([
      ...graph.nodes.filter(leftOutByTheUser).map((n) => n.objectApiName),
      ...(config.excludedObjects ?? []),
    ]),
  ];
  const excludedObjects = leftOut.length > 0 ? leftOut : undefined;
  // A simulation goes through every stage a real run does and writes
  // nothing; the decisions apply to both.
  const dryRun = config.dryRun === true ? true : undefined;
  const decisions = runDecisionsOf(config);
  // Only said when the user keeps them: absent, the executor neutralizes
  // every email address and phone number it writes.
  const keepContactPoints = config.keepContactPoints === true ? true : undefined;
  const scoped: ExecuteOptions | undefined =
    config.inputMode === 'record' && typeof config.recordId === 'string'
      ? {
          rootRecordId: config.recordId,
          rootObjectApiName: graph.nodes[0]?.objectApiName,
          expandOrphanParents: config.expandOrphanParents,
          maxRecordsPerObject: config.maxRecordsPerObject,
          fieldExclusions: config.fieldExclusions,
          excludedObjects,
          ownerMappings: config.ownerMappings,
          objectSoqlFilters: config.objectSoqlFilters,
          fieldMappings: config.fieldMappings,
          recordTypeMappings,
          anonymization,
          keepContactPoints,
          files,
          writtenBefore,
          beforeWrite,
          stream,
          dryRun,
          decisions,
        }
      : config.maxRecordsPerObject != null ||
          config.fieldExclusions ||
          excludedObjects ||
          config.ownerMappings ||
          config.objectSoqlFilters ||
          config.fieldMappings ||
          recordTypeMappings ||
          anonymization ||
          keepContactPoints ||
          files ||
          writtenBefore ||
          beforeWrite ||
          stream ||
          dryRun ||
          decisions
        ? {
            maxRecordsPerObject: config.maxRecordsPerObject,
            fieldExclusions: config.fieldExclusions,
            excludedObjects,
            ownerMappings: config.ownerMappings,
            objectSoqlFilters: config.objectSoqlFilters,
            fieldMappings: config.fieldMappings,
            recordTypeMappings,
            anonymization,
            keepContactPoints,
            files,
            writtenBefore,
            beforeWrite,
            stream,
            dryRun,
            decisions,
          }
        : undefined;
  return scoped;
}
