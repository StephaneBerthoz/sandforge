import type {
  SyncConfig,
  SyncExecutionResult,
  SyncObjectConfig,
  SyncObjectResult,
  GrappeConfig,
} from '@sandforge/shared';
import type { DataSync } from './DataSync';
import type { MetadataSync } from './MetadataSync';
import type { DeltaDetector } from './DeltaDetector';
import type { ConflictResolver } from './ConflictResolver';
import type { FieldMappingService } from './FieldMapping';
import type { TransformPipeline } from './TransformPipeline';
import type { IncrementalTracker } from './IncrementalTracker';
import type { CoreServices } from '../../services.js';

/** Function to query records from an org */
export type OrchestratorQueryFn = (
  orgId: string,
  objectConfig: SyncObjectConfig,
) => Promise<Record<string, unknown>[]>;

/** Grappe event emitted during partitioned sync execution */
export interface SyncGrappeEvent {
  type: 'grappe:started' | 'grappe:partitionProgress' | 'grappe:completed';
  payload: Record<string, unknown>;
}

/** Dependencies required by the SyncOrchestrator */
export interface SyncOrchestratorDeps {
  dataSync: DataSync;
  metadataSync: MetadataSync;
  deltaDetector: DeltaDetector;
  conflictResolver: ConflictResolver;
  fieldMapping: FieldMappingService;
  transformPipeline: TransformPipeline;
  incrementalTracker: IncrementalTracker;
  querySource: OrchestratorQueryFn;
  queryTarget: OrchestratorQueryFn;
  grappeConfig?: GrappeConfig;
  onGrappeEvent?: (event: SyncGrappeEvent) => void;
  /**
   * Injected cross-cutting adapters (telemetry, storage, salesforce, fs).
   * Provided by the composition root (`services.ts`). Optional to preserve
   * backward compatibility with tests that pass a narrow deps shape.
   */
  services?: CoreServices;
}

/**
 * Central orchestrator that coordinates all sync sub-services.
 * Manages the full sync lifecycle for each object: data querying, delta
 * detection, field mapping, conflict resolution and data sync.
 *
 * A sync moves data and nothing else — it never runs code in an org. Configs
 * carrying a `preScript`/`postScript` are refused at the bridge boundary
 * (`syncConfigPayloadSchema`) rather than silently ignored here.
 */
export class SyncOrchestrator {
  private readonly deps: SyncOrchestratorDeps;

  constructor(deps: SyncOrchestratorDeps) {
    this.deps = deps;
  }

  /**
   * Execute a full sync based on the provided configuration.
   * Coordinates all services in sequence for each object, sorted by insertOrder.
   * Activates grappe mode when total source records exceed the configured threshold.
   */
  async execute(config: SyncConfig): Promise<SyncExecutionResult> {
    const startTime = Date.now();
    const operationId = `sync-${Date.now()}`;
    const objectResults: SyncObjectResult[] = [];

    const sortedObjects = [...config.objects].sort((a, b) => a.insertOrder - b.insertOrder);

    const grappeActive = this.isGrappeActive();
    if (grappeActive) {
      this.deps.onGrappeEvent?.({
        type: 'grappe:started',
        payload: { operationId, totalPartitions: sortedObjects.length, totalRecords: 0 },
      });
    }

    let partitionIndex = 0;
    for (const objectConfig of sortedObjects) {
      const result = await this.syncObject(config, objectConfig);
      objectResults.push(result);

      if (grappeActive) {
        partitionIndex++;
        this.deps.onGrappeEvent?.({
          type: 'grappe:partitionProgress',
          payload: {
            grappeId: `sync-partition-${partitionIndex}`,
            percentage: Math.round((partitionIndex / sortedObjects.length) * 100),
            processedRecords: result.processed,
          },
        });
      }
    }

    const timestamp = new Date().toISOString();
    for (const objectConfig of sortedObjects) {
      this.deps.incrementalTracker.recordSync(config.id, objectConfig.objectApiName, timestamp);
    }

    const status = determineStatus(objectResults);

    if (grappeActive) {
      let totalProcessed = 0;
      let totalFailed = 0;
      for (const r of objectResults) {
        totalProcessed += r.processed;
        totalFailed += r.failed;
      }
      this.deps.onGrappeEvent?.({
        type: 'grappe:completed',
        payload: { operationId, totalProcessed, totalFailed },
      });
    }

    return buildResult(config.id, operationId, objectResults, startTime, status);
  }

  /** Check whether grappe mode is active based on config. */
  private isGrappeActive(): boolean {
    const config = this.deps.grappeConfig;
    return !!config?.enabled;
  }

  /**
   * Perform a dry run of the sync without writing any data.
   * Returns what would happen if the sync were executed.
   */
  async dryRun(config: SyncConfig): Promise<SyncExecutionResult> {
    const startTime = Date.now();
    const operationId = `dryrun-${Date.now()}`;
    const objectResults: SyncObjectResult[] = [];

    const sortedObjects = [...config.objects].sort((a, b) => a.insertOrder - b.insertOrder);

    for (const objectConfig of sortedObjects) {
      const sourceRecords = await this.deps.querySource(config.sourceOrgId, objectConfig);

      const lastSync = this.deps.incrementalTracker.getLastSync(
        config.id,
        objectConfig.objectApiName,
      );

      const delta = await this.deps.deltaDetector.detect(
        objectConfig,
        config.sourceOrgId,
        lastSync,
      );

      objectResults.push({
        objectApiName: objectConfig.objectApiName,
        operation: objectConfig.operation,
        processed: sourceRecords.length,
        success: sourceRecords.length,
        failed: 0,
        skipped: 0,
        conflictCount: 0,
        errors: [],
      });

      void delta;
    }

    return buildResult(config.id, operationId, objectResults, startTime, 'success');
  }

  private async syncObject(
    config: SyncConfig,
    objectConfig: SyncObjectConfig,
  ): Promise<SyncObjectResult> {
    const sourceRecords = await this.deps.querySource(config.sourceOrgId, objectConfig);

    if (sourceRecords.length === 0) {
      return createEmptyResult(objectConfig);
    }

    const mappedRecords = sourceRecords.map((record) => {
      const mapped = this.deps.fieldMapping.apply(record, objectConfig.fieldMappings);
      return this.deps.transformPipeline.transformRecord(mapped, objectConfig);
    });

    const recordsWithAddOns = mappedRecords.map((record) =>
      this.deps.fieldMapping.applyAddOns(record, objectConfig.addOnFields),
    );

    let finalRecords = recordsWithAddOns;

    if (config.direction === 'bidirectional') {
      const targetRecords = await this.deps.queryTarget(config.targetOrgId, objectConfig);

      const matchField = objectConfig.externalIdField ?? 'Id';
      const conflicts = this.deps.conflictResolver.detectConflicts(
        recordsWithAddOns,
        targetRecords,
        matchField,
      );

      if (conflicts.length > 0) {
        const resolved = this.deps.conflictResolver.resolve(conflicts, config.conflictStrategy);

        const resolvedMap = new Map(resolved.map((r) => [r.recordId, r.resolvedValues]));

        finalRecords = recordsWithAddOns.map((record) => {
          const key = String(record[matchField] ?? '');
          const resolvedValues = resolvedMap.get(key);
          if (resolvedValues) {
            return { ...record, ...resolvedValues };
          }
          return record;
        });
      }
    }

    return this.deps.dataSync.sync(objectConfig, finalRecords);
  }
}

/**
 * Create an empty result for an object with no records to sync.
 */
function createEmptyResult(objectConfig: SyncObjectConfig): SyncObjectResult {
  return {
    objectApiName: objectConfig.objectApiName,
    operation: objectConfig.operation,
    processed: 0,
    success: 0,
    failed: 0,
    skipped: 0,
    conflictCount: 0,
    errors: [],
  };
}

/**
 * Determine the overall status from individual object results.
 */
function determineStatus(results: SyncObjectResult[]): 'success' | 'partial' | 'failure' {
  if (results.length === 0) {
    return 'success';
  }

  const allFailed = results.every((r) => r.failed > 0 && r.success === 0);
  if (allFailed) {
    return 'failure';
  }

  const hasFailed = results.some((r) => r.failed > 0);
  if (hasFailed) {
    return 'partial';
  }

  return 'success';
}

/**
 * Build the final SyncExecutionResult.
 */
function buildResult(
  configId: string,
  operationId: string,
  objectResults: SyncObjectResult[],
  startTime: number,
  status: 'success' | 'partial' | 'failure',
): SyncExecutionResult {
  let totalProcessed = 0;
  let totalSuccess = 0;
  let totalFailed = 0;
  let totalSkipped = 0;

  for (const r of objectResults) {
    totalProcessed += r.processed;
    totalSuccess += r.success;
    totalFailed += r.failed;
    totalSkipped += r.skipped;
  }

  return {
    configId,
    operationId,
    status,
    objectResults,
    totalProcessed,
    totalSuccess,
    totalFailed,
    totalSkipped,
    duration: Date.now() - startTime,
    timestamp: new Date().toISOString(),
  };
}
