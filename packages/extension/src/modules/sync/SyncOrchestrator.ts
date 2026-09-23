import type {
  SyncConfig,
  SyncExecutionResult,
  SyncObjectConfig,
  SyncObjectResult,
  GrappeConfig,
} from '@sandforge/shared';
import { buildObjectResult, type DataSync } from './DataSync.js';
import type { MetadataSync } from './MetadataSync';
import type { ConflictResolver } from './ConflictResolver';
import type { FieldMappingService } from './FieldMapping';
import type { TransformPipeline } from './TransformPipeline';
import type { IncrementalTracker } from './IncrementalTracker';
import type { CoreServices } from '../../services.js';
import { SyncRunFailure } from './SyncRunFailure.js';
import { WriteCancelledError } from './WriteCancelledError.js';

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
   * The run's cancel: Live Operations' Cancel, through the registry the run
   * is listed in. Honoured before each object and between an object's reads
   * and its write, and by the writer, which aborts a Bulk API upload while its
   * job is still open and stops a REST write between two of its batches. A
   * write already sent is not taken back, and a closed Bulk API job runs to
   * its end; the objects after it are not synced, and the run answers with
   * the ones it reached and what the stopped one wrote, `cancelled` set.
   */
  signal?: AbortSignal;
  /**
   * Injected cross-cutting adapters (telemetry, storage, fs).
   * Provided by the composition root (`services.ts`). Optional to preserve
   * backward compatibility with tests that pass a narrow deps shape.
   */
  services?: CoreServices;
}

/** What {@link SyncOrchestrator.syncObject} answers for an object a cancel stopped before its write. */
const NOT_WRITTEN: unique symbol = Symbol('not written');

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

    /** Tell the Grappe view the run is over, with what its objects came to. */
    const endGrappe = (): void => {
      if (!grappeActive) return;
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
    };

    /*
     * A cancel stops the run before its next object, or before the write of
     * the object being read. Nothing but a Bulk API upload of more than ten
     * thousand records used to look at it: every other object went on being
     * read and written, and the run was reported by its objects' counts as if
     * nobody had stopped it.
     */
    const stopHere = (notReached: readonly SyncObjectConfig[]): SyncExecutionResult => {
      endGrappe();
      return stoppedResult(config.id, operationId, objectResults, startTime, notReached);
    };

    let partitionIndex = 0;
    for (const [index, objectConfig] of sortedObjects.entries()) {
      if (this.deps.signal?.aborted) return stopHere(sortedObjects.slice(index));
      let result: SyncObjectResult | typeof NOT_WRITTEN;
      try {
        result = await this.syncObject(config, objectConfig);
      } catch (err: unknown) {
        // The cancel stopped the object's write: an aborted upload wrote none
        // of it, and a REST write stopped between two batches wrote the
        // records before. What it wrote stays in the org, so it is counted;
        // the object is not synced in full, like the ones after it.
        if (err instanceof WriteCancelledError) {
          if (err.written.length > 0) {
            objectResults.push(
              buildObjectResult(objectConfig.objectApiName, objectConfig.operation, err.written),
            );
          }
          return stopHere(sortedObjects.slice(index));
        }
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
      if (result === NOT_WRITTEN) return stopHere(sortedObjects.slice(index));
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

    endGrappe();

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

  /**
   * Read, map and write one object: its result, or {@link NOT_WRITTEN} when a
   * cancel came while it was being read, before anything of it was written.
   */
  private async syncObject(
    config: SyncConfig,
    objectConfig: SyncObjectConfig,
  ): Promise<SyncObjectResult | typeof NOT_WRITTEN> {
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

    // Reading a large object takes a while: a cancel that came meanwhile is
    // honoured before its first record is written.
    if (this.deps.signal?.aborted) return NOT_WRITTEN;

    // The records are mapped, transformed and carry their add-ons, so DataSync
    // is handed nothing left to apply — as Real-time hands it. Given the
    // object's own mappings, it mapped every record a second time, by source
    // field name, on records that hold target names: a rename, a constant or a
    // formula found nothing there and wrote its field empty.
    return this.deps.dataSync.sync(
      { ...objectConfig, fieldMappings: [], addOnFields: [] },
      finalRecords,
    );
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
 * The result of a run a cancel stopped: the objects it reached, and a status
 * that is never `success`, since the objects after the cancel were not synced.
 * `error` names them, for the history entry that says why the run ended early.
 */
function stoppedResult(
  configId: string,
  operationId: string,
  objectResults: SyncObjectResult[],
  startTime: number,
  notReached: readonly SyncObjectConfig[],
): SyncExecutionResult {
  const reached = determineStatus(objectResults) === 'failure' ? 'failure' : 'partial';
  const names = notReached.map((o) => o.objectApiName);
  return {
    ...buildResult(configId, operationId, objectResults, startTime, reached),
    cancelled: true,
    error: `Cancelled before ${names.join(', ')} ${names.length === 1 ? 'was' : 'were'} synced.`,
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
