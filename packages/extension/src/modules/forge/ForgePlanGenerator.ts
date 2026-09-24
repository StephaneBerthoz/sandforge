/**
 * ForgePlanGenerator generates a ForgePlan from a ForgeGraph.
 * Finds the cycles with Tarjan's SCC algorithm, groups nodes into waves by
 * their level in the graph whose cycles are each taken as one node, and
 * estimates API calls and duration.
 */

import type {
  ForgeGraph,
  ForgeGraphEdge,
  ForgePlan,
  ForgeWave,
  ForgeCycleResolution,
} from '@sandforge/shared';
import { ForgeBatchStrategy as BatchStrategy } from './ForgeBatchStrategy.js';
import { sortNodesForWriting } from './stages/ScopeResolver.js';

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

    // Edges are parent→child (source must be inserted before target), so a
    // node's wave is its longest path from any root in the included subgraph,
    // the members of a cycle counted as one node.
    const { edges, components } = cyclesOf(graph);
    const topoLevel = this.computeTopoLevels(edges, components);

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
    const nodeMap = new Map(includedNodes.map((n) => [n.objectApiName, n]));

    const waves: ForgeWave[] = sortedLevels.map((level, index) => {
      const objects = levelMap.get(level) ?? [];
      let totalRecords = 0;
      let totalApiCalls = 0;
      let maxDuration = 0;

      for (const objName of objects) {
        const node = nodeMap.get(objName);
        if (!node) continue;
        totalRecords += node.recordCount;
        const resolved = this.batchStrategy.resolve(node.batchStrategy, node.recordCount);
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

    const cycleResolutions = this.detectCycles(graph, edges, components);

    const totalRecords = waves.reduce((s, w) => s + w.totalRecords, 0);
    const totalApiCalls = waves.reduce((s, w) => s + w.estimatedApiCalls, 0);
    const estimatedDurationSeconds = waves.reduce((s, w) => s + w.estimatedDurationSeconds, 0);

    return {
      waves,
      totalRecords,
      totalApiCalls,
      estimatedDurationSeconds,
      cycleResolutions,
    };
  }

  /**
   * The level of each included node: the longest path to it from a node
   * nothing points at, the members of a cycle counted as one node.
   *
   * Taken node by node, as Kahn's algorithm takes them, a member of a cycle
   * never comes free, and nor does anything below it: a cycle and every
   * object under it were put in one last wave, the comments on a contact's
   * cases beside the cases they cannot come before. Taken as one node, a
   * cycle sits after what any of its members needs, and each node after it
   * where its own parents put it.
   *
   * @param edges - The edges between two included objects, none to itself.
   * @param components - The included objects grouped by cycle, each object
   *   alone in its group when it is in none, in the order
   *   {@link stronglyConnected} finds them: a group after every group it
   *   points at.
   * @returns Map of objectApiName → level (0 = nothing points at it).
   */
  private computeTopoLevels(
    edges: readonly ForgeGraphEdge[],
    components: readonly (readonly string[])[],
  ): Map<string, number> {
    const componentOf = new Map<string, number>();
    components.forEach((members, index) => {
      for (const name of members) componentOf.set(name, index);
    });
    const outgoing = new Map<number, number[]>();
    for (const edge of edges) {
      const from = componentOf.get(edge.sourceObject);
      const to = componentOf.get(edge.targetObject);
      if (from === undefined || to === undefined || from === to) continue;
      const list = outgoing.get(from);
      if (list) list.push(to);
      else outgoing.set(from, [to]);
    }
    // Found children first, so taken backwards: parents first.
    const componentLevel = components.map(() => 0);
    for (let index = components.length - 1; index >= 0; index--) {
      for (const child of outgoing.get(index) ?? []) {
        componentLevel[child] = Math.max(componentLevel[child], componentLevel[index] + 1);
      }
    }
    const level = new Map<string, number>();
    for (const [name, index] of componentOf) level.set(name, componentLevel[index]);
    return level;
  }

  /**
   * Say how the run gets through each cycle among the objects it writes: the
   * groups of {@link stronglyConnected} with more than one object.
   *
   * The run writes a cycle in the order `sortNodesForWriting` gives, the
   * executor's: a lookup whose record comes later in it is left empty at
   * insert and filled in by the second pass (`CycleFkPatcher`) — in a run of
   * whole tables as well, which keeps the source's ids of what it does not
   * write only. That holds for a lookup the record may omit. The order is
   * settled on the ones it may not, and one of those still pointing at a later
   * record takes its record down: the insert is refused, and nothing is left
   * for the second pass to fill in. The plan used to suggest "inserting with
   * null lookups" whatever the lookups were, named none of them, and offered a
   * first pass with null references to a cycle of master-detail relationships
   * the platform refuses at the first insert.
   *
   * The order is read from the graph: a run also learns, from the fields it
   * describes, of required lookups discovery did not walk.
   *
   * @param graph - The graph to analyze.
   * @param edges - The edges between two objects the run writes, none to itself.
   * @param components - The objects the run writes, grouped by cycle.
   * @returns Cycle resolutions with strategy suggestions.
   */
  private detectCycles(
    graph: ForgeGraph,
    edges: readonly ForgeGraphEdge[],
    components: readonly (readonly string[])[],
  ): ForgeCycleResolution[] {
    const sccs = components.filter((members) => members.length > 1);
    if (sccs.length === 0) return [];

    const position = new Map(
      sortNodesForWriting(graph).map((node, index) => [node.objectApiName, index]),
    );
    const at = (name: string): number => position.get(name) ?? 0;
    return sccs.map((scc): ForgeCycleResolution => {
      const members = new Set(scc);
      const objects = [...scc].sort((a, b) => at(a) - at(b));
      // The lookups of the cycle written before the record they point at.
      const early = edges.filter(
        (e) =>
          members.has(e.sourceObject) &&
          members.has(e.targetObject) &&
          at(e.targetObject) < at(e.sourceObject),
      );
      const refused = early.filter((e) => e.required === true);
      if (refused.length > 0) {
        const children = [...new Set(refused.map((e) => e.targetObject))];
        const parents = [...new Set(refused.map((e) => e.sourceObject))];
        const one = children.length === 1;
        return {
          objects,
          strategy: 'unbreakable',
          description:
            `The run cannot break this cycle: ${listed(refused.map(lookupOf))} may not be ` +
            `left empty, and no order writes ${listed(parents)} first. ${listed(children)} ` +
            `${one ? 'is' : 'are'} refused, and what cannot be written without ` +
            `${one ? 'it' : 'them'} is skipped.`,
        };
      }
      return {
        objects,
        strategy: 'nullable_lookup',
        description:
          `Written in this order, with ${listed(early.map(lookupOf))} left empty at insert ` +
          `and filled in by the second pass.`,
      };
    });
  }
}

/**
 * The edges between two objects the run writes, none from an object to
 * itself, and the objects it writes grouped by cycle: an object left out
 * writes nothing, so a lookup at it is not a cycle to break.
 */
function cyclesOf(graph: ForgeGraph): { edges: ForgeGraphEdge[]; components: string[][] } {
  const included = graph.nodes.filter((n) => n.included).map((n) => n.objectApiName);
  const names = new Set(included);
  const edges = graph.edges.filter(
    (e) =>
      e.sourceObject !== e.targetObject && names.has(e.sourceObject) && names.has(e.targetObject),
  );
  return { edges, components: stronglyConnected(included, edges) };
}

/**
 * The strongly connected components of `names` under `edges` (Tarjan), an
 * object alone in its own when it is in no cycle, each found after every
 * component it points at.
 *
 * Iterative: the recursive form blew the call stack at >10K-node depth on
 * forged graphs (nodes are bounded server-side now, but this is
 * defense-in-depth — 50 is the realistic cap, but the algorithm shouldn't be
 * one-edge-away from RangeError on any input). An explicit "frame" array
 * simulates the recursion: each frame remembers (node v, edge iterator index
 * i); on the way down child frames are pushed, on the way up lowLink is
 * propagated and components are emitted. Equivalent to the recursive form,
 * O(V+E).
 */
function stronglyConnected(names: readonly string[], edges: readonly ForgeGraphEdge[]): string[][] {
  const adj = new Map<string, string[]>();
  for (const name of names) adj.set(name, []);
  for (const edge of edges) adj.get(edge.sourceObject)?.push(edge.targetObject);

  let index = 0;
  const nodeIndex = new Map<string, number>();
  const lowLink = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const components: string[][] = [];

  interface Frame {
    v: string;
    neighbors: string[];
    i: number;
  }

  const strongConnect = (root: string): void => {
    const callStack: Frame[] = [];
    nodeIndex.set(root, index);
    lowLink.set(root, index);
    index++;
    stack.push(root);
    onStack.add(root);
    callStack.push({ v: root, neighbors: adj.get(root) ?? [], i: 0 });

    while (callStack.length > 0) {
      const frame = callStack[callStack.length - 1];
      if (frame.i < frame.neighbors.length) {
        const w = frame.neighbors[frame.i++];
        if (!nodeIndex.has(w)) {
          // Recurse: push child frame, continue loop.
          nodeIndex.set(w, index);
          lowLink.set(w, index);
          index++;
          stack.push(w);
          onStack.add(w);
          callStack.push({ v: w, neighbors: adj.get(w) ?? [], i: 0 });
        } else if (onStack.has(w)) {
          lowLink.set(frame.v, Math.min(lowLink.get(frame.v)!, nodeIndex.get(w)!));
        }
        continue;
      }
      // All neighbors visited — pop this frame.
      const v = frame.v;
      callStack.pop();
      // Propagate lowLink to parent frame (matches the recursive
      // `lowLink[v] = min(lowLink[v], lowLink[w])` after recursion).
      const parent = callStack[callStack.length - 1];
      if (parent) {
        lowLink.set(parent.v, Math.min(lowLink.get(parent.v)!, lowLink.get(v)!));
      }
      // Emit the component rooted at v.
      if (lowLink.get(v) === nodeIndex.get(v)) {
        const component: string[] = [];
        let w: string;
        do {
          w = stack.pop()!;
          onStack.delete(w);
          component.push(w);
        } while (w !== v);
        components.push(component);
      }
    }
  };

  for (const name of names) {
    if (!nodeIndex.has(name)) strongConnect(name);
  }
  return components;
}

/** A lookup as the plan names it: the child's, at the parent. */
function lookupOf(edge: ForgeGraphEdge): string {
  return `${edge.targetObject}'s lookup to ${edge.sourceObject}`;
}

/** Items joined as a sentence lists them: "a", "a and b", "a, b and c". */
function listed(items: readonly string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}
