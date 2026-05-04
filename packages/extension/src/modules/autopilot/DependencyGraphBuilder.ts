/**
 * DependencyGraphBuilder — Builds an AutopilotGraph from Salesforce object describe results.
 * Uses Tarjan's SCC algorithm for cycle detection and topological sort with level computation.
 */

import type {
  AutopilotGraph,
  AutopilotNode,
  AutopilotEdge,
  CycleResolution,
  CycleResolutionStrategy,
  GraphStats,
  RelationshipType,
} from '@sandforge/shared';

/** Simplified describe field for graph building. */
export interface GraphFieldDescribe {
  /** Field API name. */
  readonly name: string;
  /** Salesforce field type (e.g. 'reference', 'string'). */
  readonly type: string;
  /** Whether the field accepts null values. */
  readonly nillable: boolean;
  /** API names of objects this field references. */
  readonly referenceTo: string[];
  /** Relationship name (e.g. 'Account' for AccountId). */
  readonly relationshipName: string | null;
}

/** Simplified describe result for graph building. */
export interface GraphObjectDescribe {
  /** Object API name. */
  readonly name: string;
  /** Fields on the object. */
  readonly fields: GraphFieldDescribe[];
}

/** Internal state for Tarjan's SCC algorithm. */
interface TarjanState {
  /** Discovery index counter. */
  index: number;
  /** Stack of nodes being processed. */
  stack: string[];
  /** Set of nodes currently on the stack. */
  onStack: Set<string>;
  /** Discovery index per node. */
  indices: Map<string, number>;
  /** Low-link value per node. */
  lowLinks: Map<string, number>;
  /** Resulting strongly connected components. */
  sccs: string[][];
}

/**
 * Builds an AutopilotGraph from object describe results.
 * Uses Tarjan's SCC algorithm for cycle detection and topological sort.
 * Computes node levels for ReactFlow layout positioning.
 */
export class DependencyGraphBuilder {
  /**
   * Build the complete dependency graph.
   * @param describes - Object describe results (from SchemaScanner).
   * @param recordCounts - Record counts per object (from SchemaScanner).
   * @param batchSize - Default batch size for API call estimation.
   * @returns The fully constructed AutopilotGraph.
   */
  build(
    describes: Map<string, GraphObjectDescribe>,
    recordCounts: Map<string, number>,
    batchSize: number = 200,
  ): AutopilotGraph {
    const edges = this.extractEdges(describes);
    const sccs = this.tarjanSCC(Array.from(describes.keys()), edges);
    const cycles = this.resolveCycles(sccs, edges);
    const { order, levels } = this.topologicalSort(Array.from(describes.keys()), edges, sccs);
    const nodes = this.buildNodes(describes, recordCounts, order, levels, batchSize);
    const stats = this.computeStats(nodes, edges, cycles);
    return { nodes, edges, cycles, stats };
  }

  /**
   * Extract edges from describe results.
   * For each reference field, creates an edge from the referenced (parent) object
   * to the current (child) object, since the parent must be inserted first.
   * @param describes - Map of object name to describe result.
   * @returns Array of AutopilotEdge representing all relationships.
   */
  private extractEdges(describes: Map<string, GraphObjectDescribe>): AutopilotEdge[] {
    const edges: AutopilotEdge[] = [];
    const knownObjects = new Set(describes.keys());

    for (const [objectName, describe] of describes) {
      for (const field of describe.fields) {
        if (field.type !== 'reference' || field.referenceTo.length === 0) {
          continue;
        }

        // Filter to only references that exist in our graph
        const validRefs = field.referenceTo.filter((ref) => knownObjects.has(ref));

        if (validRefs.length === 0) {
          continue;
        }

        // Polymorphic: field references multiple objects
        if (validRefs.length > 1) {
          for (const ref of validRefs) {
            edges.push({
              from: ref,
              to: objectName,
              fieldApiName: field.name,
              relationshipType: 'polymorphic' as RelationshipType,
              required: !field.nillable,
            });
          }
          continue;
        }

        // Single reference
        const ref = validRefs[0];
        let relationshipType: RelationshipType;

        if (ref === objectName) {
          // Self-reference (e.g. Account.ParentId -> Account)
          relationshipType = 'hierarchical';
        } else if (!field.nillable) {
          // Non-nullable reference = master-detail
          relationshipType = 'master_detail';
        } else {
          // Nullable reference = lookup
          relationshipType = 'lookup';
        }

        edges.push({
          from: ref,
          to: objectName,
          fieldApiName: field.name,
          relationshipType,
          required: !field.nillable,
        });
      }
    }

    return edges;
  }

  /**
   * Tarjan's Strongly Connected Components algorithm.
   * Returns all SCCs; components with more than 1 member indicate cycles.
   * Single-node SCCs with a self-edge also indicate cycles (hierarchical).
   * @param objects - All object names in the graph.
   * @param edges - All edges in the graph.
   * @returns Array of SCCs (each SCC is an array of object names).
   */
  private tarjanSCC(objects: string[], edges: AutopilotEdge[]): string[][] {
    // Build adjacency list: from -> [to, ...]
    // Edge direction: from=parent, to=child. For dependency analysis,
    // child depends on parent, so adjacency for Tarjan follows edge direction.
    const adjacency = new Map<string, string[]>();
    for (const obj of objects) {
      adjacency.set(obj, []);
    }
    for (const edge of edges) {
      // We track edges from -> to (parent -> child)
      // But for cycle detection, we need the dependency direction:
      // child depends on parent, i.e. to -> from
      const deps = adjacency.get(edge.to);
      if (deps) {
        deps.push(edge.from);
      }
    }

    const state: TarjanState = {
      index: 0,
      stack: [],
      onStack: new Set(),
      indices: new Map(),
      lowLinks: new Map(),
      sccs: [],
    };

    // Process all nodes (sorted for deterministic output)
    const sortedObjects = [...objects].sort();
    for (const obj of sortedObjects) {
      if (!state.indices.has(obj)) {
        this.tarjanStrongConnect(obj, adjacency, state);
      }
    }

    return state.sccs;
  }

  /**
   * Recursive strong-connect for Tarjan's algorithm.
   * @param node - Current node being processed.
   * @param adjacency - Adjacency list (dependency direction: child -> parent).
   * @param state - Mutable Tarjan state.
   */
  private tarjanStrongConnect(
    node: string,
    adjacency: Map<string, string[]>,
    state: TarjanState,
  ): void {
    state.indices.set(node, state.index);
    state.lowLinks.set(node, state.index);
    state.index++;
    state.stack.push(node);
    state.onStack.add(node);

    const neighbors = adjacency.get(node) ?? [];
    for (const neighbor of neighbors) {
      if (!state.indices.has(neighbor)) {
        // Neighbor not yet visited
        this.tarjanStrongConnect(neighbor, adjacency, state);
        const currentLow = state.lowLinks.get(node) ?? 0;
        const neighborLow = state.lowLinks.get(neighbor) ?? 0;
        state.lowLinks.set(node, Math.min(currentLow, neighborLow));
      } else if (state.onStack.has(neighbor)) {
        // Neighbor is on stack, so it's in the current SCC
        const currentLow = state.lowLinks.get(node) ?? 0;
        const neighborIndex = state.indices.get(neighbor) ?? 0;
        state.lowLinks.set(node, Math.min(currentLow, neighborIndex));
      }
    }

    // If node is a root of an SCC, pop the SCC from the stack
    if (state.lowLinks.get(node) === state.indices.get(node)) {
      const scc: string[] = [];
      let w: string;
      do {
        w = state.stack.pop()!;
        state.onStack.delete(w);
        scc.push(w);
      } while (w !== node);
      state.sccs.push(scc.sort());
    }
  }

  /**
   * Resolve each cycle (SCC with > 1 member, or self-referencing node) into
   * a CycleResolution with an appropriate strategy.
   * @param sccs - Strongly connected components from Tarjan's algorithm.
   * @param edges - All edges in the graph.
   * @returns Array of CycleResolution for each detected cycle.
   */
  private resolveCycles(sccs: string[][], edges: AutopilotEdge[]): CycleResolution[] {
    const resolutions: CycleResolution[] = [];

    // Also detect self-referencing objects (hierarchical edges)
    const selfRefObjects = new Set<string>();
    for (const edge of edges) {
      if (edge.from === edge.to && edge.relationshipType === 'hierarchical') {
        selfRefObjects.add(edge.from);
      }
    }

    // Handle self-references (single-node cycles)
    for (const obj of selfRefObjects) {
      resolutions.push({
        objects: [obj],
        strategy: 'two_pass' as CycleResolutionStrategy,
        description: `Insert ${obj} without self-lookup, update in 2nd pass`,
      });
    }

    // Handle multi-node SCCs
    for (const scc of sccs) {
      if (scc.length <= 1) {
        continue;
      }

      const sccSet = new Set(scc);
      const internalEdges = edges.filter(
        (e) => sccSet.has(e.from) && sccSet.has(e.to) && e.from !== e.to,
      );

      let strategy: CycleResolutionStrategy;
      let description: string;

      if (scc.length === 2) {
        // Check if there are nullable lookups we can break
        const hasNullable = internalEdges.some((e) => !e.required);
        if (hasNullable) {
          strategy = 'nullable_lookup';
          description = `Insert ${scc[0]} without ${scc[1]} lookup, insert ${scc[1]} with ${scc[0]} lookup, update ${scc[0]}`;
        } else {
          strategy = 'upsert_external_id';
          description = `Decompose cycle into waves with upsert + external ID`;
        }
      } else {
        // 3+ objects in cycle
        strategy = 'upsert_external_id';
        description = `Decompose cycle into waves with upsert + external ID`;
      }

      resolutions.push({
        objects: [...scc],
        strategy,
        description,
      });
    }

    return resolutions;
  }

  /**
   * Topological sort respecting cycles (place SCC members together).
   * Uses a modified Kahn's algorithm that treats each SCC as a single node.
   * @param objects - All object names in the graph.
   * @param edges - All edges in the graph.
   * @param sccs - Strongly connected components from Tarjan's algorithm.
   * @returns Maps of insert order and depth level per object.
   */
  private topologicalSort(
    objects: string[],
    edges: AutopilotEdge[],
    sccs: string[][],
  ): { order: Map<string, number>; levels: Map<string, number> } {
    // Map each object to its SCC index
    const objectToScc = new Map<string, number>();
    for (let i = 0; i < sccs.length; i++) {
      for (const obj of sccs[i]) {
        objectToScc.set(obj, i);
      }
    }

    // Build SCC-level dependency graph
    // Edge from->to means parent->child; dependency: child depends on parent
    // So in SCC graph: scc(to) depends on scc(from), unless same SCC
    const sccCount = sccs.length;
    const sccDeps = new Map<number, Set<number>>();
    for (let i = 0; i < sccCount; i++) {
      sccDeps.set(i, new Set());
    }

    for (const edge of edges) {
      const fromScc = objectToScc.get(edge.from);
      const toScc = objectToScc.get(edge.to);
      if (fromScc !== undefined && toScc !== undefined && fromScc !== toScc) {
        // Child (to) SCC depends on parent (from) SCC
        sccDeps.get(toScc)!.add(fromScc);
      }
    }

    // Kahn's algorithm on SCC graph
    const remaining = new Map<number, Set<number>>();
    for (const [sccIdx, deps] of sccDeps) {
      remaining.set(sccIdx, new Set(deps));
    }

    const sccOrder: number[] = [];
    const sccLevels = new Map<number, number>();

    while (remaining.size > 0) {
      const ready: number[] = [];
      for (const [sccIdx, deps] of remaining) {
        if (deps.size === 0) {
          ready.push(sccIdx);
        }
      }

      if (ready.length === 0) {
        // All remaining are in a higher-level cycle — just add them
        for (const sccIdx of remaining.keys()) {
          sccOrder.push(sccIdx);
          if (!sccLevels.has(sccIdx)) {
            sccLevels.set(sccIdx, 0);
          }
        }
        break;
      }

      ready.sort((a, b) => a - b);
      for (const sccIdx of ready) {
        sccOrder.push(sccIdx);
        // Level = max level of dependencies + 1 (or 0 if no deps)
        const originalDeps = sccDeps.get(sccIdx) ?? new Set();
        let maxDepLevel = -1;
        for (const dep of originalDeps) {
          maxDepLevel = Math.max(maxDepLevel, sccLevels.get(dep) ?? 0);
        }
        sccLevels.set(sccIdx, originalDeps.size === 0 ? 0 : maxDepLevel + 1);

        remaining.delete(sccIdx);
        for (const deps of remaining.values()) {
          deps.delete(sccIdx);
        }
      }
    }

    // Convert SCC order to object order
    const order = new Map<string, number>();
    const levels = new Map<string, number>();
    let insertIndex = 0;

    for (const sccIdx of sccOrder) {
      const scc = sccs[sccIdx];
      const level = sccLevels.get(sccIdx) ?? 0;
      // Sort objects within each SCC alphabetically for determinism
      const sortedScc = [...scc].sort();
      for (const obj of sortedScc) {
        order.set(obj, insertIndex);
        levels.set(obj, level);
        insertIndex++;
      }
    }

    // Handle any objects not in an SCC (shouldn't happen, but defensive)
    for (const obj of objects) {
      if (!order.has(obj)) {
        order.set(obj, insertIndex);
        levels.set(obj, 0);
        insertIndex++;
      }
    }

    return { order, levels };
  }

  /**
   * Build AutopilotNode array from describe results and computed order/levels.
   * @param describes - Object describe results.
   * @param recordCounts - Record counts per object.
   * @param order - Insertion order per object.
   * @param levels - Depth level per object.
   * @param batchSize - Batch size for API call estimation.
   * @returns Array of AutopilotNode.
   */
  private buildNodes(
    describes: Map<string, GraphObjectDescribe>,
    recordCounts: Map<string, number>,
    order: Map<string, number>,
    levels: Map<string, number>,
    batchSize: number,
  ): AutopilotNode[] {
    const nodes: AutopilotNode[] = [];

    for (const objectApiName of describes.keys()) {
      const count = recordCounts.get(objectApiName) ?? 0;
      nodes.push({
        objectApiName,
        recordCount: count,
        estimatedApiCalls: count === 0 ? 0 : Math.ceil(count / batchSize),
        piiFields: [],
        anonymizationRules: [],
        status: 'pending',
        progress: 0,
        insertOrder: order.get(objectApiName) ?? 0,
        level: levels.get(objectApiName) ?? 0,
        successCount: 0,
        failureCount: 0,
        errors: [],
        elapsedMs: 0,
        apiCallsUsed: 0,
      });
    }

    // Sort by insertOrder
    nodes.sort((a, b) => a.insertOrder - b.insertOrder);
    return nodes;
  }

  /**
   * Compute aggregate statistics for the graph.
   * @param nodes - All nodes in the graph.
   * @param edges - All edges in the graph.
   * @param cycles - All resolved cycles.
   * @returns GraphStats with aggregate metrics.
   */
  private computeStats(
    nodes: AutopilotNode[],
    edges: AutopilotEdge[],
    cycles: CycleResolution[],
  ): GraphStats {
    return {
      totalObjects: nodes.length,
      totalRelationships: edges.length,
      cycleCount: cycles.length,
      maxDepth: Math.max(0, ...nodes.map((n) => n.level)),
      totalRecords: nodes.reduce((sum, n) => sum + n.recordCount, 0),
      totalEstimatedApiCalls: nodes.reduce((sum, n) => sum + n.estimatedApiCalls, 0),
    };
  }
}
