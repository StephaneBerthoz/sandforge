import type { ForgeGraph, ForgeGraphNode, ForgeNodeStatus } from '@sandforge/shared';
import { IdRemapper } from './IdRemapper.js';
import { ForgeBatchStrategy as ForgeBatchStrategyService } from './ForgeBatchStrategy.js';
import { extractErrorMessage } from '../../core/common/extractErrorMessage.js';
import { assertSoqlIdentifier } from '../../core/common/soqlValidator.js';

/** Result of a single record insert operation. */
export interface InsertResult {
  /** New Salesforce record ID. */
  id: string;
  /** Whether the insert succeeded. */
  success: boolean;
  /** Error messages if the insert failed. */
  errors: string[];
}

/** Field metadata returned by describeFields. */
export interface FieldInfo {
  /** Field API name. */
  name: string;
  /** Whether the field can be queried. */
  queryable: boolean;
  /** Whether the field can be set on create. */
  createable: boolean;
  /** Whether the field is a reference (lookup/master-detail). */
  isReference: boolean;
}

/** Dependencies for ForgeExecutor, injected at construction time. */
export interface ForgeExecutorDeps {
  /** Query records from a Salesforce org. */
  queryRecords: (orgId: string, soql: string) => Promise<Record<string, unknown>[]>;
  /** Insert records into a Salesforce org. */
  insertRecords: (
    orgId: string,
    objectName: string,
    records: Record<string, unknown>[],
  ) => Promise<InsertResult[]>;
  /** Get field metadata for an object (queryable, createable, reference flags). */
  describeFields: (orgId: string, objectName: string) => Promise<FieldInfo[]>;
  /** Optional batch strategy for splitting inserts into batches. */
  batchStrategy?: ForgeBatchStrategyService;
  /** Optional anonymization function applied before insert. */
  anonymize?: (records: Record<string, unknown>[], objectApiName: string) => Record<string, unknown>[];
}

/** Progress event emitted during execution. */
export interface ForgeProgressEvent {
  /** Object being processed. */
  objectName: string;
  /** Current status of the object. */
  status: ForgeNodeStatus;
  /** Progress percentage (0-100). */
  progress: number;
  /** Human-readable status message. */
  message: string;
}

/** Summary returned after execution completes. */
export interface ExecutionSummary {
  /** Number of successfully inserted records. */
  successCount: number;
  /** Number of records that failed to insert. */
  failedCount: number;
  /** Number of skipped objects. */
  skippedCount: number;
  /** Total remapped IDs. */
  remapCount: number;
}

/**
 * Executes a Forge plan by processing graph nodes in topological order.
 *
 * For each included node: queries records from the source org, remaps
 * lookup IDs, inserts into the target org, and tracks new ID mappings.
 * Errors on a parent cause dependent children to be skipped.
 */
export class ForgeExecutor {
  private readonly deps: ForgeExecutorDeps;
  private isPaused = false;
  private pauseResolve: (() => void) | null = null;
  private isAborted = false;

  /** @param deps - Injected dependencies for org data operations. */
  constructor(deps: ForgeExecutorDeps) {
    this.deps = deps;
  }

  /** Pause execution between batches. */
  pause(): void {
    this.isPaused = true;
  }

  /** Resume execution after pause. */
  resume(): void {
    this.isPaused = false;
    this.pauseResolve?.();
    this.pauseResolve = null;
  }

  /** Abort execution. Resumes any paused state to propagate the abort. */
  abort(): void {
    this.isAborted = true;
    this.resume();
  }

  /**
   * Wait if paused, throw if aborted.
   * Called between batch iterations.
   */
  private async waitIfPaused(): Promise<void> {
    if (this.isAborted) {
      throw new Error('Forge execution was aborted by user request. No further batches will be processed.');
    }
    if (!this.isPaused) {
      return;
    }
    await new Promise<void>((resolve) => {
      this.pauseResolve = resolve;
    });
    if (this.isAborted) {
      throw new Error('Forge execution was aborted while paused. No further batches will be processed.');
    }
  }

  /**
   * Execute the forge plan for the given graph.
   *
   * @param graph - The dependency graph to execute.
   * @param sourceOrgId - ID of the source Salesforce org.
   * @param targetOrgId - ID of the target Salesforce org.
   * @param onProgress - Callback for progress events.
   * @returns Execution summary with counts.
   */
  async execute(
    graph: ForgeGraph,
    sourceOrgId: string,
    targetOrgId: string,
    onProgress: (event: ForgeProgressEvent) => void,
  ): Promise<ExecutionSummary> {
    this.isAborted = false;
    this.isPaused = false;
    this.pauseResolve = null;

    const sortedNodes = topologicalSort(graph);
    const remapper = new IdRemapper();
    const failedObjects = new Set<string>();

    let successCount = 0;
    let failedCount = 0;
    let skippedCount = 0;

    for (const node of sortedNodes) {
      if (!node.included) {
        skippedCount++;
        onProgress({
          objectName: node.objectApiName,
          status: 'skipped',
          progress: 100,
          message: `Skipped ${node.objectApiName} (excluded)`,
        });
        continue;
      }

      // Check if any parent object has failed
      const parentObjects = getParentObjects(node.objectApiName, graph);
      const hasFailedParent = parentObjects.some((p) => failedObjects.has(p));
      if (hasFailedParent) {
        skippedCount++;
        failedObjects.add(node.objectApiName);
        onProgress({
          objectName: node.objectApiName,
          status: 'skipped',
          progress: 100,
          message: `Skipped ${node.objectApiName} (parent failed)`,
        });
        continue;
      }

      try {
        // Step 1: Scanning — describe fields to build SOQL and filter sets
        onProgress({
          objectName: node.objectApiName,
          status: 'scanning',
          progress: 0,
          message: `Querying ${node.objectApiName} records...`,
        });

        const fieldInfos = await this.deps.describeFields(sourceOrgId, node.objectApiName);
        const queryFields = fieldInfos.filter((f) => f.queryable).map((f) => f.name);
        const createableSet = new Set(fieldInfos.filter((f) => f.createable).map((f) => f.name));
        const lookupFields = fieldInfos.filter((f) => f.isReference).map((f) => f.name);

        if (queryFields.length === 0) {
          queryFields.push('Id');
        }

        const soql = `SELECT ${queryFields.join(', ')} FROM ${assertSoqlIdentifier(node.objectApiName)}`;
        const records = await this.deps.queryRecords(sourceOrgId, soql);

        // Step 2: Remap lookup IDs and strip non-createable fields
        let remappedRecords = records.map((r) => {
          const remapped = remapper.remapRecord(r, lookupFields);
          const cleaned: Record<string, unknown> = {};
          for (const key of Object.keys(remapped)) {
            if (createableSet.has(key)) {
              cleaned[key] = remapped[key];
            }
          }
          return cleaned;
        });

        // Step 2b: Apply anonymization if configured
        if (this.deps.anonymize) {
          remappedRecords = this.deps.anonymize(remappedRecords, node.objectApiName);
        }

        // Step 3: Running — batch and insert into target
        const batchStrategy = this.deps.batchStrategy ?? new ForgeBatchStrategyService();
        const { batchSize, batchCount } = batchStrategy.resolve(
          node.batchStrategy,
          remappedRecords.length,
        );

        onProgress({
          objectName: node.objectApiName,
          status: 'running',
          progress: 0,
          message: `Inserting ${remappedRecords.length} ${node.objectApiName} records in ${batchCount} batch(es)...`,
        });

        let nodeSuccess = 0;
        let nodeFailure = 0;
        let recordOffset = 0;

        for (let b = 0; b < batchCount; b++) {
          await this.waitIfPaused();

          const batch = remappedRecords.slice(b * batchSize, (b + 1) * batchSize);
          const results = await this.deps.insertRecords(
            targetOrgId,
            node.objectApiName,
            batch,
          );

          // Step 4: Register new IDs for this batch
          for (let i = 0; i < results.length; i++) {
            const result = results[i];
            if (result.success) {
              nodeSuccess++;
              const oldId = records[recordOffset + i]?.['Id'];
              if (typeof oldId === 'string') {
                remapper.add(oldId, result.id);
              }
            } else {
              nodeFailure++;
            }
          }

          recordOffset += batch.length;

          onProgress({
            objectName: node.objectApiName,
            status: 'running',
            progress: Math.round(((b + 1) / batchCount) * 100),
            message: `batch ${b + 1}/${batchCount} \u2014 ${Math.min((b + 1) * batchSize, remappedRecords.length)}/${remappedRecords.length} records`,
          });
        }

        successCount += nodeSuccess;
        failedCount += nodeFailure;

        if (nodeFailure > 0 && nodeSuccess === 0) {
          failedObjects.add(node.objectApiName);
          onProgress({
            objectName: node.objectApiName,
            status: 'error',
            progress: 100,
            message: `Failed all ${node.objectApiName} records`,
          });
        } else {
          onProgress({
            objectName: node.objectApiName,
            status: 'done',
            progress: 100,
            message: `Completed ${node.objectApiName}: ${nodeSuccess} succeeded, ${nodeFailure} failed`,
          });
        }
      } catch (err) {
        failedObjects.add(node.objectApiName);
        failedCount += node.recordCount;
        onProgress({
          objectName: node.objectApiName,
          status: 'error',
          progress: 100,
          message: `Error on ${node.objectApiName}: ${extractErrorMessage(err)}`,
        });
      }
    }

    return {
      successCount,
      failedCount,
      skippedCount,
      remapCount: remapper.count,
    };
  }
}

/**
 * Get the parent object names for a given object based on graph edges.
 * A parent is an object that appears as sourceObject in an edge
 * where the given object is the targetObject.
 */
function getParentObjects(objectApiName: string, graph: ForgeGraph): string[] {
  return graph.edges
    .filter((e) => e.targetObject === objectApiName)
    .map((e) => e.sourceObject);
}

/**
 * Topological sort of graph nodes so parents are processed before children.
 *
 * Uses Kahn's algorithm: nodes with no incoming edges are processed first,
 * then their outgoing edges are removed, revealing the next layer.
 * If cycles exist, remaining nodes are appended at the end.
 */
function topologicalSort(graph: ForgeGraph): ForgeGraphNode[] {
  const nodeMap = new Map<string, ForgeGraphNode>();
  for (const node of graph.nodes) {
    nodeMap.set(node.objectApiName, node);
  }

  // Build in-degree map (count of edges where this node is the target)
  const inDegree = new Map<string, number>();
  for (const node of graph.nodes) {
    inDegree.set(node.objectApiName, 0);
  }
  for (const edge of graph.edges) {
    if (inDegree.has(edge.targetObject)) {
      inDegree.set(edge.targetObject, (inDegree.get(edge.targetObject) ?? 0) + 1);
    }
  }

  // Start with nodes that have no incoming edges
  const queue: string[] = [];
  for (const [name, degree] of inDegree) {
    if (degree === 0) {
      queue.push(name);
    }
  }

  const sorted: ForgeGraphNode[] = [];
  const visited = new Set<string>();

  while (queue.length > 0) {
    const name = queue.shift()!;
    if (visited.has(name)) continue;
    visited.add(name);

    const node = nodeMap.get(name);
    if (node) {
      sorted.push(node);
    }

    // Remove outgoing edges from this node
    for (const edge of graph.edges) {
      if (edge.sourceObject === name && inDegree.has(edge.targetObject)) {
        const newDegree = (inDegree.get(edge.targetObject) ?? 1) - 1;
        inDegree.set(edge.targetObject, newDegree);
        if (newDegree === 0 && !visited.has(edge.targetObject)) {
          queue.push(edge.targetObject);
        }
      }
    }
  }

  // Append any remaining nodes (cycles)
  for (const node of graph.nodes) {
    if (!visited.has(node.objectApiName)) {
      sorted.push(node);
    }
  }

  return sorted;
}
