import type {
  ConflictRecord,
  SyncConfig,
  SyncExecutionResult,
  SyncObjectConfig,
  SyncObjectResult,
  SyncObjectSimulation,
  SyncSimulationResult,
  GrappeConfig,
} from '@sandforge/shared';
import { buildObjectResult, type DataSync } from './DataSync.js';
import type { ConflictResolver } from './ConflictResolver';
import type { FieldMappingService } from './FieldMapping';
import type { TransformPipeline } from './TransformPipeline';
import type { CoreServices } from '../../services.js';
import type { PauseGate } from './PauseGate.js';
import type { TargetWriteFields } from './targetWriteFields.js';
import { SyncRunFailure } from './SyncRunFailure.js';
import { WriteCancelledError } from './WriteCancelledError.js';
import { simulateObjectOutcome, simulationKey, targetKeyOf } from './SyncSimulation.js';
import {
  RowsLeftToThePlatform,
  leftToThePlatformNote,
  lookupsThePlatformFills,
} from '../../core/common/platformRecords.js';

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

/**
 * How many records of an object an org holds with each of `keys` in
 * `keyField`, by the key as `simulationKey` gives it. What a simulation asks
 * the target in place of the write: an upsert updates the one record its key
 * matches, creates one where it matches none and is refused where it matches
 * several; an update and a delete find their record by `Id` or fail.
 */
export type OrchestratorFindFn = (
  orgId: string,
  objectConfig: SyncObjectConfig,
  keyField: string,
  keys: readonly (string | number | boolean)[],
) => Promise<ReadonlyMap<string, number>>;

/** Grappe event emitted during partitioned sync execution */
export interface SyncGrappeEvent {
  type: 'grappe:started' | 'grappe:partitionProgress' | 'grappe:completed';
  payload: Record<string, unknown>;
}

/** Dependencies required by the SyncOrchestrator */
export interface SyncOrchestratorDeps {
  dataSync: DataSync;
  conflictResolver: ConflictResolver;
  fieldMapping: FieldMappingService;
  transformPipeline: TransformPipeline;
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
   * job is still open and stops a REST write before each of its batches. A
   * write already sent is not taken back, and a closed Bulk API job runs to
   * its end; the objects after it are not synced, and the run answers with
   * the ones it reached and what the stopped one wrote, `cancelled` set.
   */
  signal?: AbortSignal;
  /**
   * The run's pause, asked from the Sync page. Waited on before each object
   * and before an object's write, as the writer waits on it before each batch
   * or job it opens; a cancel ends the wait. See {@link PauseGate}.
   */
  pauseGate?: PauseGate;
  /** For {@link SyncOrchestrator.simulate}: what the target holds. Required there. */
  findInTarget?: OrchestratorFindFn;
  /**
   * For {@link SyncOrchestrator.simulate}: what the target lets a write carry,
   * the describe the write reads too. Without it every field the records
   * carry is taken as written.
   */
  describeTargetFields?: (objectApiName: string) => Promise<TargetWriteFields>;
  /** For {@link SyncOrchestrator.simulate}: called before each object is read. */
  onSimulationProgress?: (done: number, total: number, objectApiName: string) => void;
  /**
   * Injected cross-cutting adapters (telemetry, storage, fs).
   * Provided by the composition root (`services.ts`). Optional to preserve
   * backward compatibility with tests that pass a narrow deps shape.
   */
  services?: CoreServices;
}

/** What {@link SyncOrchestrator.syncObject} answers for an object a cancel stopped before its write. */
const NOT_WRITTEN: unique symbol = Symbol('not written');

/** One object's records as the run's write would be handed them. */
interface PreparedObject {
  /** Rows the source read returned. */
  read: number;
  /** The records for the write, conflicts settled, in the order read. */
  records: Record<string, unknown>[];
  /** On a bidirectional run: the records both orgs hold with different values. */
  conflicts: ConflictRecord[];
  /** The records before the strategy settled those conflicts. */
  unsettled: Record<string, unknown>[];
  /** The field the conflicts were matched on. */
  matchField: string;
}

/**
 * Central orchestrator that coordinates all sync sub-services.
 * Manages the full sync lifecycle for each object: data querying, field
 * mapping, conflict resolution and data sync.
 *
 * A sync moves data and nothing else — it never runs code in an org. Configs
 * carrying a `preScript`/`postScript` are refused at the bridge boundary
 * (`syncConfigPayloadSchema`) rather than silently ignored here.
 *
 * A run writes. {@link simulate} reads and compares the same way and writes
 * nothing; it is asked apart, never by a flag of the configuration — a config
 * carrying `dryRun: true` is refused at that same boundary, so a saved or
 * scheduled run can never believe it only reports.
 *
 * Every run is a full sync: each object is read whole, as its filter allows,
 * every time. Nothing remembers where a previous run stopped.
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
      // A pause holds the run here, between two objects; a cancel ends it.
      await this.deps.pauseGate?.whilePaused(this.deps.signal);
      if (this.deps.signal?.aborted) return stopHere(sortedObjects.slice(index));
      // The rows the object's read leaves to the platform, kept out here: its
      // result says them however it ends — written, stopped by a cancel, or
      // failed. Held inside the read, they reached the result of a write that
      // went through alone, and a cancel during the write dropped the tracked
      // change it had left out, and the note saying why.
      const leftOut = new RowsLeftToThePlatform();
      let result: SyncObjectResult | typeof NOT_WRITTEN;
      try {
        result = await this.syncObject(config, objectConfig, leftOut);
      } catch (err: unknown) {
        // The cancel stopped the object's write: an aborted upload wrote none
        // of it, and a REST write stopped before one of its batches wrote the
        // records before. What it wrote stays in the org, so it is counted,
        // with what the write says of it; the object is not synced in full,
        // like the ones after it.
        if (err instanceof WriteCancelledError) {
          const stopped = withRowsLeftOut(
            buildObjectResult(
              objectConfig.objectApiName,
              objectConfig.operation,
              err.written,
              err.notes,
            ),
            leftOut,
          );
          if (stopped.processed > 0 || stopped.skipped > 0) objectResults.push(stopped);
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
        objectResults.push(
          withRowsLeftOut(
            {
              ...createEmptyResult(objectConfig),
              failed: 1,
              errors: [err instanceof Error ? err.message : String(err)],
            },
            leftOut,
          ),
        );
        throw new SyncRunFailure(
          err instanceof Error ? err.message : String(err),
          buildResult(config.id, operationId, objectResults, startTime, 'failure'),
          err,
        );
      }
      if (result === NOT_WRITTEN) {
        // Nothing of it was written; the rows its read left out are said all the same.
        const stopped = withRowsLeftOut(createEmptyResult(objectConfig), leftOut);
        if (stopped.skipped > 0) objectResults.push(stopped);
        return stopHere(sortedObjects.slice(index));
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
   * What the run would do, object by object, without writing anything.
   *
   * Each object is read, mapped and settled exactly as {@link execute} reads
   * it, in the same order; then, where the run would write, the target is
   * asked whether it holds the key each record would be written on. Nothing
   * is handed to the writer. A read that fails stops the simulation at that
   * object, where it would stop the run; a cancel stops it before its next
   * object, with the objects it reached.
   */
  async simulate(config: SyncConfig): Promise<SyncSimulationResult> {
    const startTime = Date.now();
    const objects: SyncObjectSimulation[] = [];
    const ordered = [...config.objects].sort((a, b) => a.insertOrder - b.insertOrder);
    const answer = (ending: Partial<SyncSimulationResult> = {}): SyncSimulationResult => ({
      configId: config.id,
      operationId: `sync-simulation-${startTime}`,
      direction: config.direction,
      conflictStrategy: config.conflictStrategy,
      objects,
      duration: Date.now() - startTime,
      timestamp: new Date().toISOString(),
      ...ending,
    });

    for (const [index, objectConfig] of ordered.entries()) {
      if (this.deps.signal?.aborted) return answer({ cancelled: true });
      this.deps.onSimulationProgress?.(index, ordered.length, objectConfig.objectApiName);
      try {
        objects.push(await this.simulateObject(config, objectConfig));
      } catch (err: unknown) {
        // A lookup the cancel cut short is the cancel, not an error of the read.
        if (this.deps.signal?.aborted) return answer({ cancelled: true });
        return answer({
          error: err instanceof Error ? err.message : String(err),
          failedObject: objectConfig.objectApiName,
        });
      }
    }
    return answer();
  }

  /** One object's line of {@link simulate}. */
  private async simulateObject(
    config: SyncConfig,
    objectConfig: SyncObjectConfig,
  ): Promise<SyncObjectSimulation> {
    const find = this.deps.findInTarget;
    if (!find) throw new Error('A simulation needs to look records up in the target org.');
    const leftOut = new RowsLeftToThePlatform();
    const prepared = await this.prepare(config, objectConfig, leftOut);

    const keyField = targetKeyOf(objectConfig);
    let inTarget: ReadonlyMap<string, number> = new Map();
    if (keyField !== null) {
      const keys = new Map<string, string | number | boolean>();
      for (const record of prepared.records) {
        const value = record[keyField];
        const key = simulationKey(value);
        if (key !== null) keys.set(key, value as string | number | boolean);
      }
      if (keys.size > 0) {
        inTarget = await find(config.targetOrgId, objectConfig, keyField, [...keys.values()]);
      }
    }

    // What the write would carry decides which conflicts are worth a word: a
    // field the target does not let anyone write is never written.
    let writable: ReadonlySet<string> | null = null;
    if (prepared.conflicts.length > 0 && this.deps.describeTargetFields) {
      try {
        const described = await this.deps.describeTargetFields(objectConfig.objectApiName);
        writable = described.creatable.size > 0 ? described.creatable : null;
      } catch {
        writable = null;
      }
    }

    return simulateObjectOutcome({
      objectConfig,
      read: prepared.read,
      records: prepared.records,
      leftOut: leftOut.counts(objectConfig.objectApiName),
      inTarget,
      conflicts: prepared.conflicts,
      unsettled: prepared.unsettled,
      matchField: prepared.matchField,
      writable,
    });
  }

  /**
   * Read, map and write one object: its result, or {@link NOT_WRITTEN} when a
   * cancel came while it was being read, before anything of it was written.
   *
   * @param leftOut - Receives the rows the read leaves to the platform.
   */
  private async syncObject(
    config: SyncConfig,
    objectConfig: SyncObjectConfig,
    leftOut: RowsLeftToThePlatform,
  ): Promise<SyncObjectResult | typeof NOT_WRITTEN> {
    const { records } = await this.prepare(config, objectConfig, leftOut);

    if (records.length === 0) {
      return withRowsLeftOut(createEmptyResult(objectConfig), leftOut);
    }

    // Reading a large object takes a while: a pause or a cancel that came
    // meanwhile is honoured before its first record is written.
    await this.deps.pauseGate?.whilePaused(this.deps.signal);
    if (this.deps.signal?.aborted) return NOT_WRITTEN;

    // The records are mapped, transformed and carry their add-ons, so DataSync
    // is handed nothing left to apply — as Real-time hands it. Given the
    // object's own mappings, it mapped every record a second time, by source
    // field name, on records that hold target names: a rename, a constant or a
    // formula found nothing there and wrote its field empty.
    return withRowsLeftOut(
      await this.deps.dataSync.sync(
        { ...objectConfig, fieldMappings: [], addOnFields: [] },
        records,
      ),
      leftOut,
    );
  }

  /**
   * Read one object and make its records what the write is handed: the rows
   * left to the platform set aside, mapped, transformed, with their add-ons,
   * and on a bidirectional run every conflict with the target settled by the
   * strategy. {@link execute} writes them; {@link simulate} only looks.
   *
   * @param leftOut - Receives the rows the read leaves to the platform.
   */
  private async prepare(
    config: SyncConfig,
    objectConfig: SyncObjectConfig,
    leftOut: RowsLeftToThePlatform,
  ): Promise<PreparedObject> {
    const read = await this.deps.querySource(config.sourceOrgId, objectConfig);
    const matchField = objectConfig.externalIdField ?? 'Id';

    // What the platform writes itself is left out of a write that creates
    // records, and said: see `writtenByThePlatform`. Sent, a tracked change is
    // refused — "Cannot directly insert FeedItem with type TrackedChange". An
    // update or a delete creates none, and the target says whether it takes
    // it. What hangs from one is left to the write: a sync copies ids as it
    // reads them, and the target may hold the change a comment answers.
    const creates = objectConfig.operation === 'insert' || objectConfig.operation === 'upsert';
    const sourceRecords = creates ? leftOut.keep(objectConfig.objectApiName, read) : read;

    if (sourceRecords.length === 0) {
      return { read: read.length, records: [], conflicts: [], unsettled: [], matchField };
    }

    const mappedRecords = sourceRecords.map((record) => {
      const mapped = this.deps.fieldMapping.apply(record, objectConfig.fieldMappings);
      return this.deps.transformPipeline.transformRecord(mapped, objectConfig);
    });

    // Nor does a record it creates carry a lookup the platform fills in
    // itself: an email's task, unless the email is on a case. Sent with the id
    // read from the source, the email is refused, "you cannot modify this
    // field". See `lookupsThePlatformFills`.
    const recordsWithAddOns = mappedRecords.map((record) => {
      const withAddOns = this.deps.fieldMapping.applyAddOns(record, objectConfig.addOnFields);
      return creates
        ? withoutWhatThePlatformFills(objectConfig.objectApiName, withAddOns)
        : withAddOns;
    });

    let finalRecords = recordsWithAddOns;
    let conflicts: ConflictRecord[] = [];

    if (config.direction === 'bidirectional') {
      const targetRecords = await this.deps.queryTarget(config.targetOrgId, objectConfig);

      conflicts = this.deps.conflictResolver.detectConflicts(
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

    return {
      read: read.length,
      records: finalRecords,
      conflicts,
      unsettled: recordsWithAddOns,
      matchField,
    };
  }
}

/** A record to create, without the lookups the platform fills in itself. */
function withoutWhatThePlatformFills(
  objectApiName: string,
  record: Record<string, unknown>,
): Record<string, unknown> {
  const filled = lookupsThePlatformFills(objectApiName, record);
  if (filled.length === 0) return record;
  const kept = { ...record };
  for (const field of filled) delete kept[field];
  return kept;
}

/**
 * An object's result, with the rows its read left to the platform counted as
 * skipped and each kind said, as `leftToThePlatformNote` words it.
 */
function withRowsLeftOut(
  result: SyncObjectResult,
  leftOut: RowsLeftToThePlatform,
): SyncObjectResult {
  const counts = leftOut.counts();
  if (counts.length === 0) return result;
  return {
    ...result,
    skipped: result.skipped + counts.reduce((sum, { count }) => sum + count, 0),
    errors: [
      ...result.errors,
      ...counts.map(({ why, count }) => leftToThePlatformNote(count, why)),
    ],
  };
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
