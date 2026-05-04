/**
 * ExecutionPlanGenerator — Generates an ExecutionPlan from an AutopilotGraph.
 * Groups objects into parallelizable waves based on dependency levels.
 * Estimates duration and API calls for the complete execution.
 */

import type {
  AutopilotGraph,
  ExecutionPlan,
  ExecutionWave,
  ComplianceFrameworkType,
  AnonymizationSummary,
} from '@sandforge/shared';

/** Options for plan generation */
export interface PlanGeneratorOptions {
  /** Average seconds per API call for duration estimation */
  readonly avgSecondsPerApiCall?: number;
  /** Batch size for API call estimation */
  readonly batchSize?: number;
}

/**
 * Generates an ExecutionPlan from an AutopilotGraph.
 * Groups objects into parallelizable waves based on dependencies.
 * Estimates duration and API calls.
 */
export class ExecutionPlanGenerator {
  private readonly avgSecondsPerApiCall: number;
  private readonly batchSize: number;

  /** Creates an ExecutionPlanGenerator with optional tuning parameters. */
  constructor(options?: PlanGeneratorOptions) {
    this.avgSecondsPerApiCall = options?.avgSecondsPerApiCall ?? 0.5;
    this.batchSize = options?.batchSize ?? 200;
  }

  /**
   * Returns the configured batch size for API call estimation.
   * @returns The batch size used for chunking API operations
   */
  getBatchSize(): number {
    return this.batchSize;
  }

  /**
   * Generate an execution plan from the dependency graph.
   * Objects at the same level with no inter-dependencies are grouped into the same wave.
   * @param graph - The autopilot dependency graph
   * @param complianceFramework - The compliance framework to apply
   * @param anonymizationSummary - Summary of anonymization actions
   * @returns A complete execution plan with waves, estimates, and compliance info
   */
  generate(
    graph: AutopilotGraph,
    complianceFramework: ComplianceFrameworkType,
    anonymizationSummary: AnonymizationSummary,
  ): ExecutionPlan {
    const waves = this.buildWaves(graph);
    const totalRecords = graph.stats.totalRecords;
    const estimatedApiCalls = graph.stats.totalEstimatedApiCalls;
    const estimatedDurationSec = this.estimateDuration(waves, graph);

    return {
      waves,
      totalRecords,
      estimatedDurationSec,
      estimatedApiCalls,
      complianceFramework,
      anonymizationSummary,
      cycleResolutions: graph.cycles,
    };
  }

  /**
   * Build execution waves from graph nodes and edges.
   * Algorithm:
   * 1. Sort nodes by insertOrder
   * 2. Group nodes by level — each level becomes a wave
   * 3. Calculate dependsOn by finding which earlier waves contain parent objects
   * @param graph - The autopilot dependency graph
   * @returns Ordered array of execution waves
   */
  private buildWaves(graph: AutopilotGraph): ExecutionWave[] {
    if (graph.nodes.length === 0) {
      return [];
    }

    // Sort nodes by insertOrder for deterministic grouping
    const sortedNodes = [...graph.nodes].sort((a, b) => a.insertOrder - b.insertOrder);

    // Group nodes by level
    const levelMap = new Map<number, string[]>();
    for (const node of sortedNodes) {
      const existing = levelMap.get(node.level);
      if (existing) {
        existing.push(node.objectApiName);
      } else {
        levelMap.set(node.level, [node.objectApiName]);
      }
    }

    // Sort levels in ascending order
    const sortedLevels = [...levelMap.keys()].sort((a, b) => a - b);

    // Build a map: objectApiName -> wave index
    const objectToWaveIndex = new Map<string, number>();
    for (let waveIdx = 0; waveIdx < sortedLevels.length; waveIdx++) {
      const level = sortedLevels[waveIdx];
      const objects = levelMap.get(level);
      if (objects) {
        for (const obj of objects) {
          objectToWaveIndex.set(obj, waveIdx);
        }
      }
    }

    // Build waves with dependency tracking
    const waves: ExecutionWave[] = [];
    for (let waveIdx = 0; waveIdx < sortedLevels.length; waveIdx++) {
      const level = sortedLevels[waveIdx];
      const objects = levelMap.get(level) ?? [];

      // Find which waves this wave depends on
      const dependsOnSet = new Set<number>();
      for (const obj of objects) {
        // Find all edges where this object is a child (to === obj)
        for (const edge of graph.edges) {
          if (edge.to === obj) {
            const parentWaveIdx = objectToWaveIndex.get(edge.from);
            if (parentWaveIdx !== undefined && parentWaveIdx < waveIdx) {
              dependsOnSet.add(parentWaveIdx);
            }
          }
        }
      }

      const dependsOn = [...dependsOnSet].sort((a, b) => a - b);

      waves.push({
        order: waveIdx,
        objects,
        dependsOn,
      });
    }

    return waves;
  }

  /**
   * Estimate total duration in seconds.
   * For each wave, the duration is the max API calls across objects (parallel execution).
   * Waves are sequential, so durations are summed.
   * @param waves - The execution waves
   * @param graph - The autopilot dependency graph (for per-node API call estimates)
   * @returns Estimated total duration in seconds
   */
  private estimateDuration(waves: ExecutionWave[], graph: AutopilotGraph): number {
    // Build a lookup for estimatedApiCalls by objectApiName
    const apiCallsByObject = new Map<string, number>();
    for (const node of graph.nodes) {
      apiCallsByObject.set(node.objectApiName, node.estimatedApiCalls);
    }

    let totalDuration = 0;

    for (const wave of waves) {
      // In a wave, objects run in parallel, so duration = max API calls in wave
      let maxApiCalls = 0;
      for (const obj of wave.objects) {
        const calls = apiCallsByObject.get(obj) ?? 0;
        if (calls > maxApiCalls) {
          maxApiCalls = calls;
        }
      }
      totalDuration += maxApiCalls * this.avgSecondsPerApiCall;
    }

    return totalDuration;
  }
}
