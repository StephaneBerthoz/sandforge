import { TypedEventEmitter } from '../../core/common/TypedEventEmitter.js';
import type { ForgeConfig, ForgeGraph, ForgeExecutionResult, ForgePlan } from '@sandforge/shared';
import type { GraphDiscoveryService, DiscoveryOptions } from './GraphDiscoveryService.js';
import type { ForgeExecutor, ForgeProgressEvent } from './ForgeExecutor.js';
import type { ForgePlanGenerator } from './ForgePlanGenerator.js';
import { extractErrorMessage } from '../../core/common/extractErrorMessage.js';

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
   * within the same VSCode session. Cleared on extension reload.
   */
  private discoveryCache = new Map<string, ForgeGraph>();

  /** @param deps - Injected dependencies for discovery and execution. */
  constructor(deps: ForgeOrchestratorDeps) {
    super();
    this.deps = deps;
  }

  /**
   * Compute a stable cache key for a discovery request. Identical configs
   * resolve to the same key — different sources/depths/inputs collide
   * intentionally to share the same cached graph.
   */
  private cacheKeyFor(config: ForgeConfig): string {
    const root =
      config.inputMode === 'record'
        ? config.recordId ?? ''
        : config.inputMode === 'soql'
          ? config.soqlQuery ?? ''
          : config.inputMode === 'template'
            ? config.templateId ?? ''
            : config.aiPrompt ?? '';
    return [
      config.sourceOrgId,
      config.inputMode,
      root,
      config.depth,
      config.customDepth ?? '',
      config.skipEmpty ? 'skipEmpty' : '',
    ].join('::');
  }

  /** Drop the discovery cache — called when the user explicitly re-discovers. */
  clearDiscoveryCache(): void {
    this.discoveryCache.clear();
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
      // Replay the progress callback so the UI animation completes even on
      // a cache hit — otherwise the wizard sits at "discovering...".
      if (options?.onProgress) {
        for (const node of cached.nodes) {
          options.onProgress({
            objectApiName: node.objectApiName,
            discoveredCount: cached.nodes.length,
            queueRemaining: 0,
          });
        }
      }
      return cached;
    }
    const graph = await this.deps.discoveryService.discover(config, options);
    this.discoveryCache.set(key, graph);
    return graph;
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
      throw new Error('Plan generator not configured. Ensure ForgeOrchestrator was initialized with a planGenerator dependency.');
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

  async execute(graph: ForgeGraph, config: ForgeConfig): Promise<ForgeExecutionResult> {
    const startTime = Date.now();

    try {
      // When inputMode === 'record', activate scoped execution so the
      // executor only clones the transitive closure of the root record
      // instead of the whole graph. Wave 2 v4 features (orphan parent
      // expansion) flow through ForgeConfig.
      const scoped = config.inputMode === 'record' && typeof config.recordId === 'string'
        ? {
            rootRecordId: config.recordId,
            rootObjectApiName: graph.nodes[0]?.objectApiName,
            expandOrphanParents: config.expandOrphanParents,
          }
        : undefined;

      const summary = await this.deps.executor.execute(
        graph,
        config.sourceOrgId,
        config.targetOrgId,
        (event) => this.emit('forge:progress', event),
        scoped,
      );

      const result: ForgeExecutionResult = {
        forgeId: `forge-${Date.now()}`,
        status: determineStatus(summary.successCount, summary.failedCount),
        graph,
        duration: Date.now() - startTime,
        timestamp: new Date().toISOString(),
        idRemapCount: summary.remapCount,
        errors: summary.errors,
      };

      this.emit('forge:complete', result);
      return result;
    } catch (err) {
      const message = extractErrorMessage(err);
      this.emit('forge:error', { message });
      throw err;
    }
  }
}

/**
 * Determine the overall execution status from success/failure counts.
 */
function determineStatus(
  successCount: number,
  failedCount: number,
): 'success' | 'partial' | 'failure' {
  if (failedCount === 0) {
    return 'success';
  }
  if (successCount > 0) {
    return 'partial';
  }
  return 'failure';
}
