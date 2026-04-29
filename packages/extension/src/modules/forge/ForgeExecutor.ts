import type { ForgeGraph, ForgeGraphNode, ForgeNodeStatus } from '@sandforge/shared';
import { IdRemapper } from './IdRemapper.js';
import { ForgeBatchStrategy as ForgeBatchStrategyService } from './ForgeBatchStrategy.js';
import { extractErrorMessage } from '../../core/common/extractErrorMessage.js';
import { assertSoqlIdentifier } from '../../core/common/soqlValidator.js';
import { RecordScopeCache } from './RecordScopeCache.js';
import { ScopedSoqlBuilder } from './ScopedSoqlBuilder.js';
import { RecordTypeMapper } from '../sync/RecordTypeMapper.js';
import type { RecordTypeMapping } from '../sync/RecordTypeMapper.js';

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
  /**
   * Objects this reference field can point to (one entry for monomorphic,
   * many for polymorphic fields like Task.WhatId). Only meaningful when
   * `isReference === true`. Required for scope-aware execution; optional
   * for legacy (full-table) execution.
   */
  referenceTo?: string[];
}

/** Optional execution mode parameters. */
export interface ExecuteOptions {
  /**
   * The root record ID supplied by the user (`ForgeConfig.recordId`). When
   * provided alongside `rootObjectApiName`, the executor enters
   * **record-scoped mode**: queries are restricted to the transitive closure
   * of this record instead of cloning every row of every table.
   */
  rootRecordId?: string;
  /** API name of the root object (resolved from the record ID prefix). */
  rootObjectApiName?: string;
  /**
   * When true, the executor still queries source records and populates the
   * scope cache, but skips all writes to the target org. Used by the recipe
   * to preview what *would* happen before committing real writes.
   */
  dryRun?: boolean;
  /**
   * How to handle reference fields whose value points to a record that was
   * never cloned (User, Owner, an excluded parent, etc.) — i.e. the
   * `IdRemapper` has no entry for it.
   *
   * - `'nullify'`: replace the orphaned reference with `null`. Salesforce
   *   then either leaves the field empty or assigns the running user
   *   (for OwnerId). Default in scoped mode.
   * - `'keep'`: preserve the original source-org ID. Almost always rejected
   *   by Salesforce for FKs; left as escape hatch and for legacy
   *   compatibility (default outside scoped mode).
   *
   * `RecordTypeId` is preserved unless a `recordTypeMappings` entry exists
   * for the source value, in which case it is translated to the target ID.
   */
  referenceFallback?: 'nullify' | 'keep';
  /**
   * Cross-org RecordType ID translations (matched by `developerName`).
   * Built up-front by the caller — typically by querying `RecordType` on
   * both orgs and passing the result through {@link RecordTypeMapper}.
   *
   * When supplied, every cloned record's `RecordTypeId` is rewritten to the
   * target-org ID. Records whose `RecordTypeId` has no mapping keep the
   * source value (which Salesforce will reject if the target org does not
   * happen to share that ID).
   */
  recordTypeMappings?: RecordTypeMapping[];
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
    options?: ExecuteOptions,
  ): Promise<ExecutionSummary> {
    this.isAborted = false;
    this.isPaused = false;
    this.pauseResolve = null;

    const isScoped = !!(options?.rootRecordId && options.rootObjectApiName);
    const dryRun = options?.dryRun ?? false;
    const referenceFallback = options?.referenceFallback ?? (isScoped ? 'nullify' : 'keep');
    const scopeCache = isScoped ? new RecordScopeCache() : null;
    const scopedBuilder = isScoped ? new ScopedSoqlBuilder() : null;
    const recordTypeMappings = options?.recordTypeMappings;
    const recordTypeMapper = recordTypeMappings && recordTypeMappings.length > 0 ? new RecordTypeMapper() : null;

    if (scopeCache && options?.rootRecordId && options.rootObjectApiName) {
      scopeCache.add(options.rootObjectApiName, [options.rootRecordId]);
    }

    let sortedNodes = topologicalSort(graph);
    if (isScoped && options?.rootObjectApiName) {
      sortedNodes = bringRootToFront(sortedNodes, options.rootObjectApiName);
    }

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

        let soql: string;
        if (scopedBuilder && scopeCache && options?.rootObjectApiName && options.rootRecordId) {
          const scopeFields = fieldInfos
            .filter((f) => f.isReference)
            .map((f) => ({
              name: f.name,
              type: 'reference',
              referenceTo: f.referenceTo ?? [],
            }));
          const scopeResult = scopedBuilder.build({
            node,
            fields: scopeFields,
            selectFields: queryFields,
            edges: graph.edges,
            cache: scopeCache,
            rootObjectApiName: options.rootObjectApiName,
            rootRecordId: options.rootRecordId,
          });
          if (!scopeResult.scoped) {
            skippedCount++;
            onProgress({
              objectName: node.objectApiName,
              status: 'skipped',
              progress: 100,
              message: `Skipped ${node.objectApiName} (out of scope: ${scopeResult.reason})`,
            });
            continue;
          }
          soql = scopeResult.soql;
        } else {
          soql = `SELECT ${queryFields.join(', ')} FROM ${assertSoqlIdentifier(node.objectApiName)}`;
        }

        const records = await this.deps.queryRecords(sourceOrgId, soql);

        // Seed cache with this node's IDs and extract FK values for downstream
        // multi-hop scoping (e.g. Case.AccountId → Account, then Account.OwnerId → User).
        if (scopeCache) {
          const ownIds: string[] = [];
          for (const rec of records) {
            const id = rec['Id'];
            if (typeof id === 'string' && id) ownIds.push(id);
          }
          scopeCache.add(node.objectApiName, ownIds);

          const refFieldsWithTargets = fieldInfos.filter(
            (f) => f.isReference && f.referenceTo && f.referenceTo.length > 0,
          );
          for (const field of refFieldsWithTargets) {
            const targets = field.referenceTo ?? [];
            for (const rec of records) {
              const value = rec[field.name];
              if (typeof value !== 'string' || !value) continue;
              for (const target of targets) {
                scopeCache.add(target, [value]);
              }
            }
          }
        }

        if (dryRun) {
          onProgress({
            objectName: node.objectApiName,
            status: 'done',
            progress: 100,
            message: `[dry-run] ${node.objectApiName}: ${records.length} record(s) would be inserted`,
          });
          successCount += records.length;
          continue;
        }

        // Step 2: Remap lookup IDs, translate RecordTypeId, nullify orphans,
        //         strip non-createable fields.
        let remappedRecords = records.map((r) => {
          let remapped = remapper.remapRecord(r, lookupFields);
          if (referenceFallback === 'nullify') {
            remapped = nullifyOrphanedFks(remapped, fieldInfos, remapper);
          }
          const cleaned: Record<string, unknown> = {};
          for (const key of Object.keys(remapped)) {
            if (createableSet.has(key)) {
              cleaned[key] = remapped[key];
            }
          }
          return cleaned;
        });
        if (recordTypeMapper && recordTypeMappings) {
          remappedRecords = recordTypeMapper.apply(remappedRecords, recordTypeMappings);
        }

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
 * Replace any reference field whose value points to a record that was never
 * cloned (no entry in the IdRemapper) with `null`. This prevents bulk inserts
 * from being rejected for `INVALID_FIELD_FOR_INSERT_OPERATION` /
 * `ID_NOT_FOUND` when the parent lives in an excluded namespace (User,
 * RecordType, an explicitly skipped object, …).
 *
 * `RecordTypeId` is intentionally preserved — Salesforce validates it
 * against the developer name on the target org schema, and a dedicated
 * RecordType mapper handles cross-org translation. Nullifying it would
 * break records that require a record type.
 */
function nullifyOrphanedFks(
  record: Record<string, unknown>,
  fieldInfos: FieldInfo[],
  remapper: IdRemapper,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...record };
  for (const field of fieldInfos) {
    if (!field.isReference) continue;
    if (field.name === 'RecordTypeId') continue;
    const value = result[field.name];
    if (typeof value !== 'string' || !value) continue;
    if (remapper.get(value)) continue;
    result[field.name] = null;
  }
  return result;
}

/**
 * Reorder a topologically sorted list so the root object comes first while
 * preserving the relative order of all other nodes. Used in record-scoped
 * mode to guarantee the root record (and the FK values it carries) populate
 * the scope cache before any sibling node from the same cycle wave runs.
 */
function bringRootToFront(
  nodes: ForgeGraphNode[],
  rootObjectApiName: string,
): ForgeGraphNode[] {
  const rootIndex = nodes.findIndex((n) => n.objectApiName === rootObjectApiName);
  if (rootIndex <= 0) return nodes;
  const reordered = [...nodes];
  const [root] = reordered.splice(rootIndex, 1);
  reordered.unshift(root);
  return reordered;
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
