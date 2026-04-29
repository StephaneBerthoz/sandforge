/**
 * ForgePlanGenerator generates a ForgePlan from a ForgeGraph.
 * Groups nodes by topological level into waves, detects cycles using
 * Tarjan's SCC algorithm, and estimates API calls and duration.
 */

import type {
  ForgeGraph,
  ForgeGraphNode,
  ForgePlan,
  ForgeWave,
  ForgeCycleResolution,
} from '@sandforge/shared';
import { ForgeBatchStrategy as BatchStrategy } from './ForgeBatchStrategy.js';

/**
 * Generates execution plans from Forge dependency graphs.
 * Handles wave grouping, cycle detection, and time/API estimation.
 */
export class ForgePlanGenerator {
  private readonly avgSecondsPerApiCall: number;
  private readonly batchStrategy: BatchStrategy;

  constructor(options?: { avgSecondsPerApiCall?: number }) {
    this.avgSecondsPerApiCall = options?.avgSecondsPerApiCall ?? 0.5;
    this.batchStrategy = new BatchStrategy();
  }

  /**
   * Generate an execution plan from a Forge graph.
   *
   * @param graph - The dependency graph with nodes and edges.
   * @returns A plan with ordered waves, totals, and cycle resolutions.
   */
  generate(graph: ForgeGraph): ForgePlan {
    const includedNodes = graph.nodes.filter((n) => n.included);
    if (includedNodes.length === 0) {
      return {
        waves: [],
        totalRecords: 0,
        totalApiCalls: 0,
        estimatedDurationSeconds: 0,
        cycleResolutions: [],
      };
    }

    // Compute topological level via Kahn's algorithm.
    // Edges are parent→child (source must be inserted before target),
    // so a node's wave is its longest path from any root in the included subgraph.
    // Falls back to node.level (BFS depth) when the topo grouping is unusable
    // (e.g. the included subgraph is fully cyclic).
    const topoLevel = this.computeTopoLevels(graph, includedNodes);

    const levelMap = new Map<number, string[]>();
    for (const node of includedNodes) {
      const lvl = topoLevel.get(node.objectApiName) ?? node.level;
      const existing = levelMap.get(lvl);
      if (existing) {
        existing.push(node.objectApiName);
      } else {
        levelMap.set(lvl, [node.objectApiName]);
      }
    }

    const sortedLevels = [...levelMap.keys()].sort((a, b) => a - b);
    const nodeMap = new Map(
      includedNodes.map((n) => [n.objectApiName, n]),
    );

    const waves: ForgeWave[] = sortedLevels.map((level, index) => {
      const objects = levelMap.get(level) ?? [];
      let totalRecords = 0;
      let totalApiCalls = 0;
      let maxDuration = 0;

      for (const objName of objects) {
        const node = nodeMap.get(objName);
        if (!node) continue;
        totalRecords += node.recordCount;
        const resolved = this.batchStrategy.resolve(
          node.batchStrategy,
          node.recordCount,
        );
        const apiCalls = resolved.batchCount;
        totalApiCalls += apiCalls;
        const duration = apiCalls * this.avgSecondsPerApiCall;
        if (duration > maxDuration) maxDuration = duration;
      }

      return {
        order: index,
        objectApiNames: objects,
        totalRecords,
        estimatedDurationSeconds: maxDuration,
        estimatedApiCalls: totalApiCalls,
      };
    });

    const cycleResolutions = this.detectCycles(graph);

    const totalRecords = waves.reduce((s, w) => s + w.totalRecords, 0);
    const totalApiCalls = waves.reduce(
      (s, w) => s + w.estimatedApiCalls,
      0,
    );
    const estimatedDurationSeconds = waves.reduce(
      (s, w) => s + w.estimatedDurationSeconds,
      0,
    );

    return {
      waves,
      totalRecords,
      totalApiCalls,
      estimatedDurationSeconds,
      cycleResolutions,
    };
  }

  /**
   * Compute the topological level of each included node using Kahn's
   * algorithm restricted to the included subgraph. Nodes participating in
   * a cycle never reach in-degree zero and are bucketed at maxLevel + 1
   * so they execute last (after all acyclic dependencies are satisfied).
   *
   * @param graph - The full dependency graph.
   * @param includedNodes - Nodes that survived `n.included === true` filtering.
   * @returns Map of objectApiName → topological level (0 = no in-degree).
   */
  private computeTopoLevels(
    graph: ForgeGraph,
    includedNodes: ForgeGraphNode[],
  ): Map<string, number> {
    const includedSet = new Set(includedNodes.map((n) => n.objectApiName));
    const inDegree = new Map<string, number>();
    for (const node of includedNodes) {
      inDegree.set(node.objectApiName, 0);
    }
    for (const edge of graph.edges) {
      if (edge.sourceObject === edge.targetObject) continue;
      if (!includedSet.has(edge.sourceObject)) continue;
      if (!includedSet.has(edge.targetObject)) continue;
      inDegree.set(
        edge.targetObject,
        (inDegree.get(edge.targetObject) ?? 0) + 1,
      );
    }

    const level = new Map<string, number>();
    const queue: string[] = [];
    for (const [name, deg] of inDegree) {
      if (deg === 0) {
        level.set(name, 0);
        queue.push(name);
      }
    }

    while (queue.length > 0) {
      const name = queue.shift()!;
      const myLevel = level.get(name) ?? 0;
      for (const edge of graph.edges) {
        if (edge.sourceObject !== name) continue;
        if (edge.sourceObject === edge.targetObject) continue;
        if (!includedSet.has(edge.targetObject)) continue;
        const newDeg = (inDegree.get(edge.targetObject) ?? 1) - 1;
        inDegree.set(edge.targetObject, newDeg);
        const candidateLevel = myLevel + 1;
        const existing = level.get(edge.targetObject);
        if (existing === undefined || candidateLevel > existing) {
          level.set(edge.targetObject, candidateLevel);
        }
        if (newDeg === 0) {
          queue.push(edge.targetObject);
        }
      }
    }

    let maxLevel = 0;
    for (const v of level.values()) {
      if (v > maxLevel) maxLevel = v;
    }
    for (const node of includedNodes) {
      if (!level.has(node.objectApiName)) {
        level.set(node.objectApiName, maxLevel + 1);
      }
    }
    return level;
  }

  /**
   * Detect cycles using Tarjan's SCC algorithm and propose resolutions.
   * Only SCCs with more than one node are reported as cycles.
   *
   * @param graph - The graph to analyze.
   * @returns Cycle resolutions with strategy suggestions.
   */
  private detectCycles(graph: ForgeGraph): ForgeCycleResolution[] {
    // Build adjacency list from edges
    const adj = new Map<string, string[]>();
    for (const node of graph.nodes) {
      adj.set(node.objectApiName, []);
    }
    for (const edge of graph.edges) {
      const list = adj.get(edge.sourceObject);
      if (list) list.push(edge.targetObject);
    }

    // Tarjan's SCC
    let index = 0;
    const nodeIndex = new Map<string, number>();
    const lowLink = new Map<string, number>();
    const onStack = new Set<string>();
    const stack: string[] = [];
    const sccs: string[][] = [];

    const strongConnect = (v: string): void => {
      nodeIndex.set(v, index);
      lowLink.set(v, index);
      index++;
      stack.push(v);
      onStack.add(v);

      for (const w of adj.get(v) ?? []) {
        if (!nodeIndex.has(w)) {
          strongConnect(w);
          lowLink.set(
            v,
            Math.min(lowLink.get(v)!, lowLink.get(w)!),
          );
        } else if (onStack.has(w)) {
          lowLink.set(
            v,
            Math.min(lowLink.get(v)!, nodeIndex.get(w)!),
          );
        }
      }

      if (lowLink.get(v) === nodeIndex.get(v)) {
        const scc: string[] = [];
        let w: string;
        do {
          w = stack.pop()!;
          onStack.delete(w);
          scc.push(w);
        } while (w !== v);
        if (scc.length > 1) {
          sccs.push(scc);
        }
      }
    };

    for (const node of graph.nodes) {
      if (!nodeIndex.has(node.objectApiName)) {
        strongConnect(node.objectApiName);
      }
    }

    // Convert SCCs to cycle resolutions
    return sccs.map((objects) => {
      // Check if any edge in the cycle is nullable (lookup)
      const hasNullableLookup = graph.edges.some(
        (e) =>
          objects.includes(e.sourceObject) &&
          objects.includes(e.targetObject) &&
          e.type === 'lookup',
      );

      const strategy = hasNullableLookup
        ? 'nullable_lookup'
        : 'two_pass';
      return {
        objects,
        strategy,
        description:
          strategy === 'nullable_lookup'
            ? `Break cycle by inserting with null lookups, then updating: ${objects.join(' \u2192 ')}`
            : `Two-pass insert: first pass with null references, second pass updates: ${objects.join(' \u2192 ')}`,
      };
    });
  }
}
