/**
 * Shared utilities for mutating graph nodes in Zustand stores.
 *
 * Both useForgeStore and useAutopilotStore manipulate arrays of graph nodes
 * that share a common shape (objectApiName, status, progress).  These helpers
 * centralise the immutable-update logic so both stores stay consistent.
 */

/** Minimal shape a graph node must have to be updatable. */
interface GraphNodeLike {
  objectApiName: string;
  status: string;
  progress: number;
}

/**
 * Update the status (and optionally progress) of a graph node identified by objectApiName.
 * Returns a new array with the updated node.
 *
 * When `progress` is omitted the existing value is preserved.
 */
export function updateGraphNodeStatus<T extends GraphNodeLike>(
  nodes: T[],
  objectName: string,
  status: T['status'],
  progress?: number,
): T[] {
  return nodes.map((n) =>
    n.objectApiName === objectName
      ? { ...n, status, ...(progress !== undefined ? { progress } : {}) }
      : n,
  );
}

/**
 * Update progress and a numeric counter field on a graph node.
 * Returns a new array with the updated node.
 */
export function updateGraphNodeProgress<T extends GraphNodeLike>(
  nodes: T[],
  objectName: string,
  progress: number,
  counterField: string & keyof T,
  counterValue: number,
): T[] {
  return nodes.map((n) =>
    n.objectApiName === objectName ? ({ ...n, progress, [counterField]: counterValue } as T) : n,
  );
}
