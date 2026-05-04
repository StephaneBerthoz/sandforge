/**
 * Dependency edge between Salesforce objects.
 * Represents a foreign key relationship (lookup or master-detail).
 */
export interface DependencyEdge {
  source: string;
  target: string;
  fieldApiName: string;
  type:
    | 'lookup'
    | 'master_detail'
    | 'self_reference'
    | 'hierarchical'
    | 'external_lookup'
    | 'polymorphic';
  required: boolean;
  cascadeDelete: boolean;
  polymorphicTypes?: string[];
}

/** Resolved dependency graph with topological ordering and layer information */
export interface ResolvedDependencyGraph {
  objects: string[];
  edges: DependencyEdge[];
  topologicalOrder: string[];
  layers: string[][];
  cycles: string[][];
  hasCycles: boolean;
}

/**
 * Resolves dependencies between Salesforce objects and computes the optimal
 * insertion order using topological sorting (Kahn's algorithm).
 */
export class DependencyResolver {
  private edges: DependencyEdge[] = [];
  private objects: Set<string> = new Set();

  /** Add an object to the resolver */
  addObject(objectName: string): void {
    this.objects.add(objectName);
  }

  /** Add a dependency edge between two objects */
  addDependency(edge: DependencyEdge): void {
    this.objects.add(edge.source);
    this.objects.add(edge.target);
    this.edges.push(edge);
  }

  /** Resolve dependencies and compute execution order */
  resolve(): ResolvedDependencyGraph {
    const depsOf = this.buildDependencyMap();
    const { sorted, remaining } = this.topologicalSort(depsOf);

    const cycles: string[][] = remaining.size > 0 ? this.findConnectedComponents(remaining) : [];
    const topologicalOrder = [...sorted, ...Array.from(remaining.keys()).sort()];
    const layers = this.computeLayers(topologicalOrder, depsOf);

    return {
      objects: Array.from(this.objects).sort(),
      edges: [...this.edges],
      topologicalOrder,
      layers,
      cycles,
      hasCycles: cycles.length > 0,
    };
  }

  /** Get the number of registered objects */
  get objectCount(): number {
    return this.objects.size;
  }

  /** Get the number of edges */
  get edgeCount(): number {
    return this.edges.length;
  }

  /** Clear all objects and edges */
  clear(): void {
    this.objects.clear();
    this.edges.length = 0;
  }

  /** Build a map of object -> set of objects it depends on */
  private buildDependencyMap(): Map<string, Set<string>> {
    const depsOf = new Map<string, Set<string>>();
    for (const obj of this.objects) {
      depsOf.set(obj, new Set());
    }
    for (const edge of this.edges) {
      if (edge.source === edge.target) continue;
      depsOf.get(edge.source)?.add(edge.target);
    }
    return depsOf;
  }

  /** Kahn's algorithm: returns sorted objects and any remaining (cycled) objects */
  private topologicalSort(depsOf: Map<string, Set<string>>): {
    sorted: string[];
    remaining: Map<string, Set<string>>;
  } {
    const sorted: string[] = [];
    const remaining = new Map(Array.from(depsOf).map(([k, v]) => [k, new Set(v)]));

    while (remaining.size > 0) {
      const ready: string[] = [];
      for (const [obj, deps] of remaining) {
        if (deps.size === 0) ready.push(obj);
      }
      if (ready.length === 0) break;

      ready.sort();
      for (const obj of ready) {
        sorted.push(obj);
        remaining.delete(obj);
        for (const deps of remaining.values()) {
          deps.delete(obj);
        }
      }
    }

    return { sorted, remaining };
  }

  /** Find connected components in the remaining (cycled) graph */
  private findConnectedComponents(remaining: Map<string, Set<string>>): string[][] {
    const visited = new Set<string>();
    const components: string[][] = [];
    for (const startNode of remaining.keys()) {
      if (visited.has(startNode)) continue;
      const component: string[] = [];
      const stack = [startNode];
      while (stack.length > 0) {
        const node = stack.pop()!;
        if (visited.has(node)) continue;
        visited.add(node);
        component.push(node);
        for (const dep of remaining.get(node) ?? []) {
          if (remaining.has(dep) && !visited.has(dep)) {
            stack.push(dep);
          }
        }
      }
      if (component.length > 0) {
        components.push(component.sort());
      }
    }
    return components;
  }

  /** Compute parallel execution layers from topological order */
  private computeLayers(order: string[], depsOf: Map<string, Set<string>>): string[][] {
    const layers: string[][] = [];
    const layerOf = new Map<string, number>();

    for (const obj of order) {
      const deps = depsOf.get(obj) ?? new Set();
      let maxDepLayer = -1;
      for (const dep of deps) {
        maxDepLayer = Math.max(maxDepLayer, layerOf.get(dep) ?? 0);
      }
      const layer = deps.size === 0 ? 0 : maxDepLayer + 1;
      layerOf.set(obj, layer);
      while (layers.length <= layer) layers.push([]);
      layers[layer].push(obj);
    }

    return layers;
  }
}
