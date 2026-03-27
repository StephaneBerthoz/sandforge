/**
 * CloneReferenceLinker resolves topological insert order for Clone operations
 * using AutopilotEdge relationships and Kahn's algorithm.
 */

import type { AutopilotEdge, RelationshipType } from '@sandforge/shared';

/** Describe field shape for buildEdgesFromDescribe. */
interface DescribeField {
  name: string;
  type: string;
  referenceTo?: string[];
}

/** Describe result shape for buildEdgesFromDescribe. */
export interface DescribeSObjectResultLike {
  fields: DescribeField[];
}

/**
 * Resolves the insertion order of objects during a Clone operation.
 * Uses Kahn's algorithm for topological sorting with cycle detection.
 * Self-referential edges are excluded from ordering (handled by two-pass insert).
 */
export class CloneReferenceLinker {
  /**
   * Resolve the topological insert order for a set of objects based on their edges.
   * Objects with no dependencies (no parents) are placed first.
   * Self-referential edges (where from === to) are ignored for ordering.
   *
   * @param objects - List of object API names to sort.
   * @param edges - Lookup relationships between objects.
   * @returns Topologically sorted array of object API names.
   * @throws Error if a cycle is detected among the objects.
   */
  resolveInsertOrder(objects: string[], edges: AutopilotEdge[]): string[] {
    if (objects.length === 0) {
      return [];
    }

    // Filter out self-referential edges and edges involving objects outside the set
    const objectSet = new Set(objects);
    const relevantEdges = edges.filter(
      (e) => e.from !== e.to && objectSet.has(e.from) && objectSet.has(e.to),
    );

    // Build adjacency and in-degree maps
    // Edge semantics: e.to (child) has a lookup to e.from (parent)
    // So e.from must be inserted before e.to
    const inDegree = new Map<string, number>();
    const adjacency = new Map<string, string[]>();

    for (const obj of objects) {
      inDegree.set(obj, 0);
      adjacency.set(obj, []);
    }

    for (const edge of relevantEdges) {
      // from (parent) -> to (child): child depends on parent
      adjacency.get(edge.from)!.push(edge.to);
      inDegree.set(edge.to, (inDegree.get(edge.to) ?? 0) + 1);
    }

    // Kahn's algorithm
    const queue: string[] = [];
    for (const [obj, degree] of inDegree) {
      if (degree === 0) {
        queue.push(obj);
      }
    }

    const sorted: string[] = [];
    while (queue.length > 0) {
      const current = queue.shift()!;
      sorted.push(current);

      for (const neighbor of adjacency.get(current) ?? []) {
        const newDegree = (inDegree.get(neighbor) ?? 1) - 1;
        inDegree.set(neighbor, newDegree);
        if (newDegree === 0) {
          queue.push(neighbor);
        }
      }
    }

    if (sorted.length !== objects.length) {
      const remaining = objects.filter((o) => !sorted.includes(o));
      throw new Error(`Cycle detected among objects: ${remaining.join(', ')}`);
    }

    return sorted;
  }

  /**
   * Detect self-referential edges (where the lookup points to the same object).
   * These require two-pass insert logic (insert with NULL, then UPDATE).
   *
   * @param edges - All edges to inspect.
   * @returns Array of self-referential edges.
   */
  detectSelfReferentialEdges(edges: AutopilotEdge[]): AutopilotEdge[] {
    return edges.filter((e) => e.from === e.to);
  }

  /**
   * Build AutopilotEdge array from describe results.
   * For each object, inspects reference-type fields and creates edges
   * for fields whose referenceTo includes another object in the clone set.
   *
   * @param objectApiNames - Object API names in the clone set.
   * @param describeResults - Map of object API name to describe result.
   * @returns Array of AutopilotEdge objects.
   */
  buildEdgesFromDescribe(
    objectApiNames: string[],
    describeResults: Map<string, DescribeSObjectResultLike>,
  ): AutopilotEdge[] {
    const objectSet = new Set(objectApiNames);
    const edges: AutopilotEdge[] = [];

    for (const objectApiName of objectApiNames) {
      const describe = describeResults.get(objectApiName);
      if (!describe) continue;

      for (const field of describe.fields) {
        if (field.type === 'reference' && field.referenceTo) {
          for (const refTarget of field.referenceTo) {
            if (objectSet.has(refTarget)) {
              edges.push({
                from: refTarget,
                to: objectApiName,
                fieldApiName: field.name,
                relationshipType: 'lookup' as RelationshipType,
                required: false,
              });
            }
          }
        }
      }
    }

    return edges;
  }
}
