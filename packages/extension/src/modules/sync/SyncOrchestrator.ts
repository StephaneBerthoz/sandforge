import type {
  SyncConfig,
  SyncExecutionResult,
  SyncObjectConfig,
  SyncObjectResult,
  GrappeConfig,
} from '@sandforge/shared';
import type { DataSync } from './DataSync';
import type { MetadataSync } from './MetadataSync';
import type { ConflictResolver } from './ConflictResolver';
import type { FieldMappingService } from './FieldMapping';
import type { TransformPipeline } from './TransformPipeline';
import type { IncrementalTracker } from './IncrementalTracker';
import type { CoreServices } from '../../services.js';
import { SyncRunFailure } from './SyncRunFailure.js';

/** Function to query records from an org */
export type OrchestratorQueryFn = (
  orgId: string,
  objectConfig: SyncObjectConfig,
) => Promise<Record<string, unknown>[]>;

/** Function counting the records a query of an object would return */
export type OrchestratorCountFn = (
  orgId: string,
  objectConfig: SyncObjectConfig,
) => Promise<number>;

/** Grappe event emitted during partitioned sync execution */
export interface SyncGrappeEvent {
  type: 'grappe:started' | 'grappe:partitionProgress' | 'grappe:completed';
  payload: Record<string, unknown>;
}

/** Dependencies required by the SyncOrchestrator */
export interface SyncOrchestratorDeps {
  dataSync: DataSync;
  metadataSync: MetadataSync;
  conflictResolver: ConflictResolver;
  fieldMapping: FieldMappingService;
  transformPipeline: TransformPipeline;
  incrementalTracker: IncrementalTracker;
  querySource: OrchestratorQueryFn;
  queryTarget: OrchestratorQueryFn;
  grappeConfig?: GrappeConfig;
  onGrappeEvent?: (event: SyncGrappeEvent) => void;
  /**
   * Counts the source records of an object before anything is read, so a run
   * is held to `grappeConfig.autoActivateThreshold` like Seed and Autopilot.
   * Only called while grappe is enabled. Without it, or when a count fails,
   * the run stays sequential and reports nothing to the Grappe view: the
   * threshold cannot be checked, and grappe mode must never turn itself on.
   */
  countSource?: OrchestratorCountFn;
  /**
   * Injected cross-cutting adapters (telemetry, storage, fs).
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
 *
 * Every run writes: there is no simulated path. A config asking for one
 * (`dryRun: true`) is refused at that same boundary.
 */
export class SyncOrchestrator {
  private readonly deps: SyncOrchestratorDeps;

  constructor(deps: SyncOrchestratorDeps) {
    this.deps = deps;
  }

  /**
   * Execute a full sync based on the provided configuration.
   * Coordinates all services in sequence for each object, sorted by insertOrder.
   * Activates grappe mode when the source records counted before the run reach
   * the configured threshold.
   */
  async execute(config: SyncConfig): Promise<SyncExecutionResult> {
    const startTime = Date.now();
    const operationId = `sync-${Date.now()}`;
    const objectResults: SyncObjectResult[] = [];

    const sortedObjects = [...config.objects].sort((a, b) => a.insertOrder - b.insertOrder);

    const totalRecords = await this.countForGrappe(config.sourceOrgId, sortedObjects);
    const grappeActive = this.isGrappeActive(totalRecords);
    if (grappeActive) {
      this.deps.onGrappeEvent?.({
        type: 'grappe:started',
        payload: { operationId, totalPartitions: sortedObjects.length, totalRecords },
      });
    }

    let partitionIndex = 0;
    for (const objectConfig of sortedObjects) {
      let result: SyncObjectResult;
      try {
        result = await this.syncObject(config, objectConfig);
      } catch (err: unknown) {
        /*
         * The run stops here, but what the objects before this one wrote is
         * still reported. Letting the error travel bare discarded the lot: the
         * handler's catch built a result with `objectResults: []`, `duration: 0`
         * and four zeroes, so a run that wrote two objects of three and then
         * failed on the third was stored — and shown in the history panel — as
         * "failure, 0 objects, 0 ms", with no way to tell it from a run that
         * never started.
         */
        objectResults.push({
          ...createEmptyResult(objectConfig),
          failed: 1,
          errors: [err instanceof Error ? err.message : String(err)],
        });
        throw new SyncRunFailure(
          err instanceof Error ? err.message : String(err),
          buildResult(config.id, operationId, objectResults, startTime, 'failure'),
          err,
        );
      }
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

  /**
   * The source records the run will read, counted before the first write, or
   * `undefined` when grappe is off or the count is unavailable.
   */
  private async countForGrappe(
    sourceOrgId: string,
    objects: readonly SyncObjectConfig[],
  ): Promise<number | undefined> {
    const count = this.deps.countSource;
    if (!this.deps.grappeConfig?.enabled || !count) return undefined;
    let total = 0;
    try {
      for (const objectConfig of objects) {
        total += await count(sourceOrgId, objectConfig);
      }
    } catch {
      // Grappe only changes what the Grappe view is told; a count the org
      // refuses must not stop a sync that would otherwise run.
      return undefined;
    }
    return total;
  }

  /** Check whether grappe mode should activate based on the counted records and config. */
  private isGrappeActive(totalRecords: number | undefined): boolean {
    const config = this.deps.grappeConfig;
    return !!(
      config?.enabled &&
      totalRecords !== undefined &&
      totalRecords >= config.autoActivateThreshold
    );
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
