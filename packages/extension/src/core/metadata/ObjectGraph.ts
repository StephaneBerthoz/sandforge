/** Node in the object dependency graph */
export interface GraphNode {
  objectName: string;
  inDegree: number;
  outDegree: number;
  level: number;
}

/** Edge in the dependency graph */
export interface GraphEdge {
  source: string;
  target: string;
  fieldName: string;
  type: 'lookup' | 'master_detail' | 'self_reference' | 'polymorphic';
  required: boolean;
  cascadeDelete: boolean;
}

/** Cycle detected in the graph */
export interface CycleInfo {
  objects: string[];
  breakableAt?: string;
}

/**
 * Builds and queries a directed graph of Salesforce object relationships.
 * Used for topological sorting and dependency analysis.
 */
export class ObjectGraph {
  private nodes: Map<string, GraphNode> = new Map();
  private edges: GraphEdge[] = [];
  private adjacencyList: Map<string, string[]> = new Map();
  private reverseAdjacency: Map<string, string[]> = new Map();

  /** Add an object node to the graph */
  addNode(objectName: string): void {
    if (!this.nodes.has(objectName)) {
      this.nodes.set(objectName, { objectName, inDegree: 0, outDegree: 0, level: 0 });
      this.adjacencyList.set(objectName, []);
      this.reverseAdjacency.set(objectName, []);
    }
  }

  /** Add a dependency edge (source depends on target) */
  addEdge(edge: GraphEdge): void {
    this.addNode(edge.source);
    this.addNode(edge.target);
    this.edges.push(edge);

    const adj = this.adjacencyList.get(edge.source);
    if (adj && !adj.includes(edge.target)) {
      adj.push(edge.target);
    }
    const rev = this.reverseAdjacency.get(edge.target);
    if (rev && !rev.includes(edge.source)) {
      rev.push(edge.source);
    }

    const sourceNode = this.nodes.get(edge.source);
    const targetNode = this.nodes.get(edge.target);
    if (sourceNode) sourceNode.outDegree = this.adjacencyList.get(edge.source)?.length ?? 0;
    if (targetNode) targetNode.inDegree = this.reverseAdjacency.get(edge.target)?.length ?? 0;
  }

  /** Get all nodes */
  getNodes(): GraphNode[] {
    return Array.from(this.nodes.values());
  }

  /** Get all edges */
  getEdges(): GraphEdge[] {
    return [...this.edges];
  }

  /** Get dependencies for an object (objects it depends on) */
  getDependencies(objectName: string): string[] {
    return this.adjacencyList.get(objectName) ?? [];
  }

  /** Get dependents of an object (objects that depend on it) */
  getDependents(objectName: string): string[] {
    return this.reverseAdjacency.get(objectName) ?? [];
  }

  /**
   * Topological sort using Kahn's algorithm. Returns undefined if cycles exist.
   * Produces an order where dependencies come before dependents.
   */
  topologicalSort(): string[] | undefined {
    // outDegree in our graph = number of dependencies.
    // We need nodes with zero dependencies (outDegree=0) to come first.
    const depCount = new Map<string, number>();
    for (const [name, node] of this.nodes) {
      depCount.set(name, node.outDegree);
    }

    const queue: string[] = [];
    for (const [name, count] of depCount) {
      if (count === 0) queue.push(name);
    }

    const result: string[] = [];
    let qi = 0;
    while (qi < queue.length) {
      const current = queue[qi++];
      result.push(current);

      // For each node that depends on 'current', reduce its dependency count
      for (const dependent of this.reverseAdjacency.get(current) ?? []) {
        const newCount = (depCount.get(dependent) ?? 0) - 1;
        depCount.set(dependent, newCount);
        if (newCount === 0) queue.push(dependent);
      }
    }

    return result.length === this.nodes.size ? result : undefined;
  }

  /** Detect cycles using DFS */
  detectCycles(): CycleInfo[] {
    const cycles: CycleInfo[] = [];
    const visited = new Set<string>();
    const recursionStack = new Set<string>();
    const path: string[] = [];

    const dfs = (node: string): void => {
      visited.add(node);
      recursionStack.add(node);
      path.push(node);

      for (const neighbor of this.adjacencyList.get(node) ?? []) {
        if (!visited.has(neighbor)) {
          dfs(neighbor);
        } else if (recursionStack.has(neighbor)) {
          const cycleStart = path.indexOf(neighbor);
          const cycle = path.slice(cycleStart);
          const breakable = this.findBreakableEdge(cycle);
          cycles.push({ objects: cycle, breakableAt: breakable });
        }
      }

      path.pop();
      recursionStack.delete(node);
    };

    for (const name of this.nodes.keys()) {
      if (!visited.has(name)) {
        dfs(name);
      }
    }

    return cycles;
  }

  /** Compute layers for parallel execution */
  computeLayers(): string[][] {
    const sorted = this.topologicalSort();
    if (!sorted) return [];

    const layers: string[][] = [];
    const levelMap = new Map<string, number>();

    for (const name of sorted) {
      const deps = this.adjacencyList.get(name) ?? [];
      const maxDepLevel = deps.reduce((max, dep) => Math.max(max, levelMap.get(dep) ?? 0), -1);
      const level = maxDepLevel + 1;
      levelMap.set(name, level);

      while (layers.length <= level) layers.push([]);
      layers[level].push(name);
    }

    return layers;
  }

  /** Get graph size */
  get nodeCount(): number {
    return this.nodes.size;
  }

  /** Get edge count */
  get edgeCount(): number {
    return this.edges.length;
  }

  /** Clear the graph */
  clear(): void {
    this.nodes.clear();
    this.edges.length = 0;
    this.adjacencyList.clear();
    this.reverseAdjacency.clear();
  }

  /** Find a breakable edge in a cycle (prefer lookups over master-detail) */
  private findBreakableEdge(cycle: string[]): string | undefined {
    for (let i = 0; i < cycle.length; i++) {
      const source = cycle[i];
      const target = cycle[(i + 1) % cycle.length];
      const edge = this.edges.find(
        (e) => e.source === source && e.target === target && !e.required,
      );
      if (edge) return source;
    }
    return undefined;
  }
}
