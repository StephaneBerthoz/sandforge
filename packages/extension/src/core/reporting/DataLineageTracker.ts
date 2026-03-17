import { randomUUID } from 'node:crypto';
import type {
  DataLineageGraph,
  LineageNode,
  LineageEdge,
} from '@sandforge/shared';

/** Internal state for a tracked operation */
interface TrackedOperation {
  operationId: string;
  nodes: LineageNode[];
  edges: LineageEdge[];
  startedAt: string;
}

/**
 * Tracks data lineage through SandForge operations.
 * Maintains a graph of nodes and edges for each tracked operation,
 * allowing visualization of data flow from source to destination.
 */
export class DataLineageTracker {
  private readonly operations: Map<string, TrackedOperation> = new Map();

  /**
   * Start tracking a new operation. Must be called before adding nodes or edges.
   * @param operationId - The UUID of the operation to track
   */
  startTracking(operationId: string): void {
    this.operations.set(operationId, {
      operationId,
      nodes: [],
      edges: [],
      startedAt: new Date().toISOString(),
    });
  }

  /**
   * Add a node to a tracked operation's lineage graph.
   * @param operationId - The UUID of the operation
   * @param node - The node data (id will be generated)
   * @returns The generated UUID for the node
   * @throws Error if the operation is not being tracked
   */
  addNode(operationId: string, node: Omit<LineageNode, 'id'>): string {
    const operation = this.getOperationOrThrow(operationId);
    const id = randomUUID();
    const fullNode: LineageNode = { id, ...node };
    operation.nodes.push(fullNode);
    return id;
  }

  /**
   * Add an edge between two nodes in a tracked operation's lineage graph.
   * @param operationId - The UUID of the operation
   * @param edge - The edge connecting two nodes
   * @throws Error if the operation is not being tracked
   */
  addEdge(operationId: string, edge: LineageEdge): void {
    const operation = this.getOperationOrThrow(operationId);
    operation.edges.push(edge);
  }

  /**
   * Retrieve the complete lineage graph for a tracked operation.
   * @param operationId - The UUID of the operation
   * @returns The lineage graph if the operation is tracked, undefined otherwise
   */
  getLineage(operationId: string): DataLineageGraph | undefined {
    const operation = this.operations.get(operationId);
    if (!operation) {
      return undefined;
    }

    return {
      nodes: [...operation.nodes],
      edges: [...operation.edges],
      operationId: operation.operationId,
      generatedAt: new Date().toISOString(),
    };
  }

  /**
   * List all currently tracked operation IDs.
   * @returns An array of operation UUIDs
   */
  listOperations(): string[] {
    return Array.from(this.operations.keys());
  }

  /**
   * Clear tracked operations. If an operationId is provided, only that operation
   * is cleared. Otherwise, all operations are cleared.
   * @param operationId - Optional operation ID to clear
   */
  clear(operationId?: string): void {
    if (operationId !== undefined) {
      this.operations.delete(operationId);
    } else {
      this.operations.clear();
    }
  }

  private getOperationOrThrow(operationId: string): TrackedOperation {
    const operation = this.operations.get(operationId);
    if (!operation) {
      throw new Error(
        `Operation "${operationId}" is not being tracked. Call startTracking() first.`
      );
    }
    return operation;
  }
}
