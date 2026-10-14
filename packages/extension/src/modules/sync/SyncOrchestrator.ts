import type {
  ConflictRecord,
  SyncConfig,
  SyncDeltaOutcome,
  SyncExecutionResult,
  SyncObjectConfig,
  SyncObjectResult,
  SyncObjectSimulation,
  SyncSimulationResult,
  GrappeConfig,
} from '@sandforge/shared';
import { sanitizeSoqlObjectName } from '@sandforge/shared';
import { buildObjectResult, type DataSync, type OperationOutcome } from './DataSync.js';
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
  changedSinceLiteral,
  deletionKeyOf,
  deletionNotes,
  deltaOutcomeOf,
  planObjectRead,
  sourceReadWhere,
  tallyDeletions,
  type DeletionTally,
  type ObjectReadPlan,
  type SyncDeltaLoad,
  type SyncDeltaReads,
  type SyncDeltaStore,
} from './SyncDelta.js';
import {
  RowsLeftToThePlatform,
  leftToThePlatformNote,
  lookupsThePlatformFills,
} from '../../core/common/platformRecords.js';
import {
  copyPlannedFiles,
  planRunFiles,
  SyncFilesRefusedError,
  type SyncFileDeps,
  type SyncFilePlan,
  type TiedRecords,
} from './SyncFiles.js';
import { assertSoqlIdentifier } from '../../core/common/soqlValidator.js';
import { idLists } from '../dataops/RecordRemoval.js';
import type { SyncCreationRecorder } from './SyncRunCreations.js';

/** How a source read of one object is asked, beyond the object's own filter. */
export interface SourceRead {
  /**
   * On a delta read: only the records whose `SystemModstamp` is after this
   * SOQL datetime, as `sourceReadWhere` combines it with the filter.
   */
  changedSince?: string;
  /** Told when a bound stopped the read before the source was exhausted. */
  onBoundReached?: () => void;
}

/** Function to query records from an org */
export type OrchestratorQueryFn = (
  orgId: string,
  objectConfig: SyncObjectConfig,
  read?: SourceRead,
) => Promise<Record<string, unknown>[]>;

/** Function counting the records a query of an object would return */
export type OrchestratorCountFn = (
  orgId: string,
  objectConfig: SyncObjectConfig,
  read?: SourceRead,
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
   * Where a delta configuration's watermarks are kept, and what it asks the
   * orgs beside its reads: see `SyncDelta`. Without both, a configuration in
   * delta mode reads every object whole and says it was not run as a saved
   * one, since no watermark can be kept for it.
   */
  deltaStore?: SyncDeltaStore;
  deltaReads?: SyncDeltaReads;
  /**
   * What a configuration that copies files reads and writes beside its
   * records, and where it keeps which file it copied where: see `SyncFiles`.
   * Without it, such a configuration is refused before anything is read.
   */
  files?: SyncFileDeps;
  /**
   * Where the run keeps what it creates in the target, as it writes it: the
   * records it inserted, or upserted where the target held none, and the
   * files it created. What a removal of the run takes back, and nothing else:
   * a record it updated was the target's before. Without it, nothing is kept
   * and the run cannot be taken back.
   */
  creations?: SyncCreationRecorder;
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
 * One object's source read as it happened: asked from `changedSince` on a
 * delta read, the rows it returned, and whether a bound cut it short. Filled
 * in by {@link SyncOrchestrator.prepare}.
 */
interface ObjectRead {
  readonly changedSince?: string;
  rows: number;
  cut: boolean;
}

/** What a deletion pass carried to the target. */
interface CarriedDeletions {
  deleted: number;
  deleteFailed: number;
  error?: string;
  notes: string[];
  /** Whether the pass read every deleted row it asked for. */
  complete: boolean;
}

/** One object's records as the run's write would be handed them. */
interface PreparedObject {
  /** Rows the source read returned. */
  read: number;
  /** The records for the write, conflicts settled, in the order read. */
  records: Record<string, unknown>[];
  /** The source id of each of `records`, in the same order: what a record's files are found by. */
  sourceIds: Array<string | undefined>;
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
 * A configuration in `full` mode reads each object whole, as its filter
 * allows, every time. One in `delta` mode reads each object from the
 * watermark its last good run recorded, and carries the source's deletions
 * when asked to: see `SyncDelta`.
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
    const deltaLoad = this.deltaLoadOf(config);

    // The files of every object, found and measured before the first write: a
    // run whose files would not fit in the target is refused with nothing
    // written, rather than stopped once its records are there without them.
    let filePlan: SyncFilePlan | undefined;
    try {
      filePlan = await this.planFiles(config, sortedObjects, deltaLoad);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      throw new SyncRunFailure(
        message,
        buildResult(config.id, operationId, [], startTime, 'failure'),
        err,
      );
    }
    if (filePlan?.storage.shortfall) {
      throw new SyncRunFailure(`${filePlan.storage.shortfall} Nothing was written.`, {
        ...buildResult(config.id, operationId, [], startTime, 'failure'),
        files: filePlan.storage,
      });
    }

    // What the run creates, kept as it writes it, for its removal to take
    // back: see `creations`.
    const recorder = this.deps.creations;
    /** Records the run created, per object in the order it first wrote each. */
    const createdByObject = new Map<string, number>();
    let filesCreated = 0;
    const noteCreated = (
      objectConfig: SyncObjectConfig,
      outcomes: readonly OperationOutcome[],
    ): void => {
      if (!recorder) return;
      const ids = createdIds(objectConfig.operation, outcomes);
      if (ids.length === 0) return;
      recorder.note(objectConfig.objectApiName, ids);
      const name = objectConfig.objectApiName;
      createdByObject.set(name, (createdByObject.get(name) ?? 0) + ids.length);
    };
    const noteFile = (objectApiName: 'ContentDocument' | 'Attachment', id: string): void => {
      if (!recorder) return;
      recorder.note(objectApiName, [id]);
      filesCreated++;
    };
    let unkeptSaid = false;
    /**
     * An object's result, once what the run created by then is kept; with a
     * word, the first time, when some of it could not be: the run goes on,
     * and its removal cannot take what was not kept.
     */
    const kept = async (result: SyncObjectResult): Promise<SyncObjectResult> => {
      const failure = await recorder?.flush();
      if (failure === undefined || unkeptSaid) return result;
      unkeptSaid = true;
      return {
        ...result,
        errors: [
          ...result.errors,
          `What this run created could not all be kept (${failure}): removing the run may ` +
            'leave some of it in the target.',
        ],
      };
    };
    const push = async (result: SyncObjectResult): Promise<void> => {
      objectResults.push(await kept(result));
    };

    /**
     * A result of this run, with what its files took of the target's storage
     * and what it created, counted.
     */
    const finish = (result: SyncExecutionResult): SyncExecutionResult => {
      const withFiles = filePlan ? { ...result, files: filePlan.storage } : result;
      if (!recorder || (createdByObject.size === 0 && filesCreated === 0)) return withFiles;
      return {
        ...withFiles,
        created: {
          runId: recorder.runId,
          objects: [...createdByObject].map(([objectApiName, count]) => ({ objectApiName, count })),
          files: filesCreated,
        },
      };
    };

    const totalRecords = await this.countForGrappe(config, sortedObjects, deltaLoad);
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
    const stopHere = async (
      notReached: readonly SyncObjectConfig[],
      reason?: string,
    ): Promise<SyncExecutionResult> => {
      endGrappe();
      await recorder?.flush();
      return finish(
        stoppedResult(config.id, operationId, objectResults, startTime, notReached, reason),
      );
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
      // On a delta configuration: how the object is read, and the watermark
      // taken from the source before it is — the org's own time.
      const { plan, mark } = await this.readPlan(config, objectConfig, deltaLoad);
      const read: ObjectRead = {
        changedSince: plan?.read === 'delta' ? changedSinceLiteral(plan.since) : undefined,
        rows: 0,
        cut: false,
      };
      const withPlan = (r: SyncObjectResult, deletions?: CarriedDeletions): SyncObjectResult =>
        plan ? { ...r, delta: deltaOutcomeOf(plan, read.rows, deletions) } : r;
      // On a configuration that copies files: the records the write took, by source id.
      const plannedFiles = filePlan?.objects.get(objectConfig.objectApiName);
      const written = plannedFiles ? new Map<string, string>() : undefined;
      let synced: SyncObjectResult | typeof NOT_WRITTEN;
      try {
        synced = await this.syncObject(
          config,
          objectConfig,
          leftOut,
          plan ? read : undefined,
          written,
          recorder ? (outcomes) => noteCreated(objectConfig, outcomes) : undefined,
        );
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
          if (stopped.processed > 0 || stopped.skipped > 0) await push(withPlan(stopped));
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
        await push(
          withPlan(
            withRowsLeftOut(
              {
                ...createEmptyResult(objectConfig),
                failed: 1,
                errors: [err instanceof Error ? err.message : String(err)],
              },
              leftOut,
            ),
          ),
        );
        throw new SyncRunFailure(
          err instanceof Error ? err.message : String(err),
          finish(buildResult(config.id, operationId, objectResults, startTime, 'failure')),
          err,
        );
      }
      if (synced === NOT_WRITTEN) {
        // Nothing of it was written; the rows its read left out are said all the same.
        const stopped = withRowsLeftOut(createEmptyResult(objectConfig), leftOut);
        if (stopped.skipped > 0) await push(withPlan(stopped));
        return stopHere(sortedObjects.slice(index));
      }
      let result: SyncObjectResult = synced;

      // The files of the records it wrote, once they are in the target: each
      // goes to the copy of its record there.
      let filesComplete = true;
      if (plannedFiles && written && config.files) {
        await this.deps.pauseGate?.whilePaused(this.deps.signal);
        if (this.deps.signal?.aborted) {
          await push(withPlan(result));
          return stopHere(sortedObjects.slice(index + 1), filesNotCopied(objectConfig));
        }
        const files = await copyPlannedFiles({
          config,
          option: config.files,
          objectApiName: objectConfig.objectApiName,
          planned: plannedFiles,
          written,
          deps: this.deps.files as SyncFileDeps,
          signal: this.deps.signal,
          waitIfPaused: () =>
            this.deps.pauseGate?.whilePaused(this.deps.signal) ?? Promise.resolve(),
          onCreated: noteFile,
        });
        result = { ...result, files: files.outcome, errors: [...result.errors, ...files.notes] };
        // A file not copied this time is copied by the next run only if that
        // run reads its record again: the watermark stays where it was.
        filesComplete =
          files.outcome.failed === 0 && files.outcome.pastRunCap === 0 && files.unplanned === 0;
        if (files.cancelled) {
          await push(withPlan(result));
          return stopHere(sortedObjects.slice(index + 1), filesNotCopied(objectConfig));
        }
      }

      // The source's deletions, after its changes: only on a delta read, which
      // knows since when to look. A full read has no point to start from, and
      // reading the whole recycle bin would delete what earlier runs never
      // copied.
      let deletions: CarriedDeletions | undefined;
      if (plan?.read === 'delta' && config.propagateDeletes === true && read.changedSince) {
        await this.deps.pauseGate?.whilePaused(this.deps.signal);
        if (this.deps.signal?.aborted) {
          await push(withPlan(result));
          return stopHere(sortedObjects.slice(index));
        }
        try {
          deletions = await this.carryDeletions(objectConfig, read.changedSince);
        } catch (err: unknown) {
          if (!(err instanceof WriteCancelledError)) throw err;
          // Stopped between two batches of deletes: those sent are done, the
          // rest are read again by the next run, from the same watermark.
          const sent = buildObjectResult(objectConfig.objectApiName, 'delete', err.written);
          await push(
            withPlan(
              { ...result, errors: [...result.errors, ...sent.errors, ...err.notes] },
              { deleted: sent.success, deleteFailed: sent.failed, notes: [], complete: false },
            ),
          );
          return stopHere(sortedObjects.slice(index));
        }
        result = { ...result, errors: [...result.errors, ...deletions.notes] };
      }

      // The watermark moves only past an object the run finished cleanly:
      // every record written, every deletion carried, nothing left past a
      // read bound. Anything else reads again from the same point next time.
      const clean =
        result.failed === 0 &&
        filesComplete &&
        !read.cut &&
        (deletions === undefined ||
          (deletions.deleteFailed === 0 && deletions.error === undefined && deletions.complete));
      let recorded: string | undefined;
      if (plan && mark !== null && clean) {
        // With the newest file stamp the run's lookups looked at, which the
        // next run's look past.
        const filesSeen = plannedFiles?.filesSeen;
        try {
          this.deps.deltaStore?.record(config.id, {
            sourceOrgId: config.sourceOrgId,
            targetOrgId: config.targetOrgId,
            objectApiName: objectConfig.objectApiName,
            watermark: mark,
            fingerprint: plan.fingerprint,
            recordedAt: new Date().toISOString(),
            ...(filesSeen !== undefined ? { filesSeen } : {}),
          });
          recorded = mark;
        } catch (err: unknown) {
          result = {
            ...result,
            errors: [
              ...result.errors,
              `The watermark could not be saved, so the next run reads from the previous one: ` +
                `${err instanceof Error ? err.message : String(err)}`,
            ],
          };
        }
      }
      if (plan) {
        result = { ...result, delta: deltaOutcomeOf(plan, read.rows, deletions, recorded) };
      }
      await push(result);

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

    await recorder?.flush();
    return finish(buildResult(config.id, operationId, objectResults, startTime, status));
  }

  /**
   * The watermarks of a delta configuration: `undefined` for a full one,
   * `null` when none can be kept — a configuration that is not saved, or a
   * run given nowhere to keep them.
   */
  private deltaLoadOf(config: SyncConfig): SyncDeltaLoad | null | undefined {
    if (config.mode !== 'delta') return undefined;
    if (!this.deps.deltaStore || !this.deps.deltaReads) return null;
    return this.deps.deltaStore.load(config.id);
  }

  /**
   * How one object of a delta configuration is read, and the watermark taken
   * from the source before it is. A source that will not say its latest
   * `SystemModstamp` has the object read whole, recording nothing: a delta
   * read filters on that same field.
   */
  private async readPlan(
    config: SyncConfig,
    objectConfig: SyncObjectConfig,
    load: SyncDeltaLoad | null | undefined,
  ): Promise<{ plan: ObjectReadPlan | null; mark: string | null }> {
    if (load === undefined) return { plan: null, mark: null };
    const plan = planObjectRead(config, objectConfig, load);
    const reads = this.deps.deltaReads;
    if (!reads || (plan.read === 'full' && plan.reason === 'not_saved')) {
      return { plan, mark: null };
    }
    try {
      return { plan, mark: await reads.latestModstamp(objectConfig.objectApiName) };
    } catch {
      return {
        plan: { read: 'full', reason: 'no_modstamp', fingerprint: plan.fingerprint },
        mark: null,
      };
    }
  }

  /**
   * Delete in the target what the source deleted since `changedSince`.
   *
   * The deleted rows are read from the source's recycle bin, within the
   * object's filter, and each is tied to its target record by the key the
   * write matches on, computed by the same mapping and transforms the write
   * applies: see `tallyDeletions`. Only a target record that alone holds the
   * key of a record the source no longer holds is deleted — never one the run
   * cannot tie to a deleted source record. The deletes go through the run's
   * writer, its cancel and its pause.
   */
  private async carryDeletions(
    objectConfig: SyncObjectConfig,
    changedSince: string,
  ): Promise<CarriedDeletions> {
    const tallied = await this.tallyObjectDeletions(objectConfig, changedSince);
    if ('error' in tallied) {
      return {
        deleted: 0,
        deleteFailed: 0,
        error: tallied.error,
        notes: [tallied.error],
        complete: false,
      };
    }
    const { tally, notes } = tallied;
    if (tally.ids.length === 0) {
      return { deleted: 0, deleteFailed: 0, notes, complete: !tally.truncated };
    }
    const written = await this.deps.dataSync.sync(
      {
        ...objectConfig,
        operation: 'delete',
        fieldMappings: [],
        transformRules: [],
        addOnFields: [],
      },
      tally.ids.map((Id) => ({ Id })),
    );
    return {
      deleted: written.success,
      deleteFailed: written.failed,
      notes: [...written.errors, ...notes],
      complete: !tally.truncated,
    };
  }

  /**
   * The target records a deletion pass of `objectConfig` would delete, and
   * what it would leave alone, in words; or why it cannot run.
   */
  private async tallyObjectDeletions(
    objectConfig: SyncObjectConfig,
    changedSince: string,
  ): Promise<{ tally: DeletionTally; notes: string[] } | { error: string }> {
    const reads = this.deps.deltaReads;
    if (!reads) return { error: `Deletions need the source's recycle bin, and none was given.` };
    const key = deletionKeyOf(objectConfig);
    if ('refused' in key) return { error: key.refused };
    const where = sourceReadWhere(objectConfig.where, changedSince) ?? '';
    try {
      const tally = await tallyDeletions(reads, objectConfig, key, where, (row) => {
        if (key.sourceField === 'Id') return row.Id;
        const mapped = this.deps.fieldMapping.apply(row, objectConfig.fieldMappings);
        return this.deps.transformPipeline.transformRecord(mapped, objectConfig)[key.keyField];
      });
      return { tally, notes: deletionNotes(tally, key.keyField) };
    } catch (err: unknown) {
      // A cancel that cut a lookup short is the cancel, said as the writer says one.
      if (this.deps.signal?.aborted) throw new WriteCancelledError(objectConfig.objectApiName, []);
      return {
        error:
          `The source's deletions could not be read, so none was carried; the next run ` +
          `looks for them again: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  /**
   * The source records the run will read, counted before the first write, or
   * `undefined` when grappe is off or the count is unavailable. A delta read
   * is counted from its watermark.
   */
  private async countForGrappe(
    config: SyncConfig,
    objects: readonly SyncObjectConfig[],
    load: SyncDeltaLoad | null | undefined,
  ): Promise<number | undefined> {
    const count = this.deps.countSource;
    if (!this.deps.grappeConfig?.enabled || !count) return undefined;
    let total = 0;
    try {
      for (const objectConfig of objects) {
        const plan = load === undefined ? null : planObjectRead(config, objectConfig, load);
        total +=
          plan?.read === 'delta'
            ? await count(config.sourceOrgId, objectConfig, {
                changedSince: changedSinceLiteral(plan.since),
              })
            : await count(config.sourceOrgId, objectConfig);
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
    let filePlan: SyncFilePlan | undefined;
    const answer = (ending: Partial<SyncSimulationResult> = {}): SyncSimulationResult => ({
      configId: config.id,
      operationId: `sync-simulation-${startTime}`,
      direction: config.direction,
      conflictStrategy: config.conflictStrategy,
      objects,
      duration: Date.now() - startTime,
      timestamp: new Date().toISOString(),
      ...(filePlan ? { files: filePlan.storage } : {}),
      ...ending,
    });

    // A simulation reads the watermarks a run would read, and records none.
    const deltaLoad = this.deltaLoadOf(config);
    // And finds the files a run would copy, as the run finds them before its
    // first write; what refuses the run stops the simulation there.
    try {
      filePlan = await this.planFiles(config, ordered, deltaLoad);
    } catch (err: unknown) {
      if (this.deps.signal?.aborted) return answer({ cancelled: true });
      return answer({ error: err instanceof Error ? err.message : String(err) });
    }
    for (const [index, objectConfig] of ordered.entries()) {
      if (this.deps.signal?.aborted) return answer({ cancelled: true });
      this.deps.onSimulationProgress?.(index, ordered.length, objectConfig.objectApiName);
      try {
        const simulated = await this.simulateObject(config, objectConfig, deltaLoad);
        const files = filePlan?.objects.get(objectConfig.objectApiName);
        objects.push(
          files
            ? {
                ...simulated,
                files: files.outcome,
                notes: [...simulated.notes, ...files.notes],
              }
            : simulated,
        );
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

  /**
   * One object's line of {@link simulate}. On a delta configuration the
   * object is read as the run would read it — from its watermark, or whole
   * for the same reason — and the deletions a run would carry are counted,
   * tied to their target records as a run ties them.
   */
  private async simulateObject(
    config: SyncConfig,
    objectConfig: SyncObjectConfig,
    deltaLoad: SyncDeltaLoad | null | undefined,
  ): Promise<SyncObjectSimulation> {
    const find = this.deps.findInTarget;
    if (!find) throw new Error('A simulation needs to look records up in the target org.');
    const leftOut = new RowsLeftToThePlatform();
    const { plan } = await this.readPlan(config, objectConfig, deltaLoad);
    const read: ObjectRead = {
      changedSince: plan?.read === 'delta' ? changedSinceLiteral(plan.since) : undefined,
      rows: 0,
      cut: false,
    };
    const prepared = await this.prepare(config, objectConfig, leftOut, plan ? read : undefined);

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

    const outcome = simulateObjectOutcome({
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
    if (!plan) return outcome;

    // The deletions a run would carry: tied as a run ties them, deleted by none.
    if (plan.read === 'delta' && config.propagateDeletes === true && read.changedSince) {
      const tallied = await this.tallyObjectDeletions(objectConfig, read.changedSince);
      if ('error' in tallied) {
        return {
          ...outcome,
          notes: [...outcome.notes, tallied.error],
          delta: deltaOutcomeOf(plan, read.rows, {
            deleted: 0,
            deleteFailed: 0,
            error: tallied.error,
          }),
        };
      }
      const wouldDelete = tallied.tally.ids.length;
      return {
        ...outcome,
        delete: outcome.delete + wouldDelete,
        notes: [...outcome.notes, ...tallied.notes],
        delta: deltaOutcomeOf(plan, read.rows, { deleted: wouldDelete, deleteFailed: 0 }),
      };
    }
    return { ...outcome, delta: deltaOutcomeOf(plan, read.rows) };
  }

  /**
   * Read, map and write one object: its result, or {@link NOT_WRITTEN} when a
   * cancel came while it was being read, before anything of it was written.
   *
   * @param leftOut - Receives the rows the read leaves to the platform.
   * @param read - On a delta configuration: how the source is read, filled in
   *   with what the read returned.
   * @param written - Receives the records the write took, source id to target id.
   * @param onWritten - Told what the write did, record by record, once it
   *   answers — also the records it wrote before a cancel stopped it.
   */
  private async syncObject(
    config: SyncConfig,
    objectConfig: SyncObjectConfig,
    leftOut: RowsLeftToThePlatform,
    read?: ObjectRead,
    written?: Map<string, string>,
    onWritten?: (outcomes: readonly OperationOutcome[]) => void,
  ): Promise<SyncObjectResult | typeof NOT_WRITTEN> {
    const { records, sourceIds } = await this.prepare(config, objectConfig, leftOut, read);

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
    if (written || onWritten) {
      // A run that copies files needs each record the write took, and its id
      // in the target: the files of a record go to its copy there. A run that
      // keeps what it creates needs each record the write created.
      const note = (outcomes: readonly OperationOutcome[]): void => {
        outcomes.forEach((outcome, at) => {
          const sourceId = sourceIds[at];
          if (written && outcome.success && outcome.id && sourceId) {
            written.set(sourceId, outcome.id);
          }
        });
        onWritten?.(outcomes);
      };
      try {
        const { outcomes, notes } = await this.deps.dataSync.write(
          { ...objectConfig, fieldMappings: [], addOnFields: [] },
          records,
        );
        note(outcomes);
        return withRowsLeftOut(
          buildObjectResult(objectConfig.objectApiName, objectConfig.operation, outcomes, notes),
          leftOut,
        );
      } catch (err: unknown) {
        if (err instanceof WriteCancelledError) note(err.written);
        throw err;
      }
    }
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
   * @param asked - On a delta configuration: how the source is read, filled in
   *   with the rows the read returned and whether a bound cut it short. The
   *   target of a bidirectional run is read whole: a conflict is a record both
   *   orgs hold, whenever either changed it.
   */
  private async prepare(
    config: SyncConfig,
    objectConfig: SyncObjectConfig,
    leftOut: RowsLeftToThePlatform,
    asked?: ObjectRead,
  ): Promise<PreparedObject> {
    const read = asked
      ? await this.deps.querySource(config.sourceOrgId, objectConfig, {
          changedSince: asked.changedSince,
          onBoundReached: () => {
            asked.cut = true;
          },
        })
      : await this.deps.querySource(config.sourceOrgId, objectConfig);
    if (asked) asked.rows = read.length;
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
      return {
        read: read.length,
        records: [],
        sourceIds: [],
        conflicts: [],
        unsettled: [],
        matchField,
      };
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
      sourceIds: sourceRecords.map((record) =>
        typeof record.Id === 'string' ? record.Id : undefined,
      ),
      conflicts,
      unsettled: recordsWithAddOns,
      matchField,
    };
  }

  /**
   * The files of every object of a configuration that copies them, found and
   * measured before anything is written: each object from the read the run
   * will make of it — on a delta read, from its watermark. `undefined` for a
   * configuration that copies none, which reads no file at all.
   *
   * @throws {SyncFilesRefusedError} When the run may not copy files: see `planRunFiles`.
   */
  private async planFiles(
    config: SyncConfig,
    objects: readonly SyncObjectConfig[],
    load: SyncDeltaLoad | null | undefined,
  ): Promise<SyncFilePlan | undefined> {
    const option = config.files;
    if (!option) return undefined;
    const deps = this.deps.files;
    if (!deps) {
      throw new SyncFilesRefusedError(
        'This session cannot copy files: it reads no file content or file storage. ' +
          'Nothing was read or written.',
      );
    }
    return planRunFiles({
      config,
      option,
      deps,
      tie: (objectConfig, sourceIds) => this.tieToTarget(config, objectConfig, sourceIds),
      objects: objects.map((objectConfig) => {
        const plan = load === undefined ? null : planObjectRead(config, objectConfig, load);
        return {
          objectConfig,
          ...(plan?.read === 'delta'
            ? {
                changedSince: changedSinceLiteral(plan.since),
                ...(plan.filesSeen !== undefined ? { filesSeen: plan.filesSeen } : {}),
              }
            : {}),
        };
      }),
    });
  }

  /**
   * The copies an earlier run made in the target of `sourceIds`, records this
   * run does not write: each tied by the key the object's write matches on,
   * computed by the same mapping and transforms the write applies, as a
   * deletion is tied. The files those records gained since the last run go to
   * their copies. A record whose key ties it to no target record, or to more
   * than one, is left out.
   */
  private async tieToTarget(
    config: SyncConfig,
    objectConfig: SyncObjectConfig,
    sourceIds: readonly string[],
  ): Promise<TiedRecords> {
    const reads = this.deps.deltaReads;
    const files = this.deps.files;
    if (!reads || !files) return { held: new Map(), refused: 'the target cannot be asked' };
    const key = deletionKeyOf(objectConfig);
    if ('refused' in key) return { held: new Map(), refused: key.refused };
    const name = objectConfig.objectApiName;
    const keys = new Map<string, string | number | boolean>();
    if (key.sourceField === 'Id') {
      for (const id of sourceIds) keys.set(id, id);
    } else {
      const object = sanitizeSoqlObjectName(name);
      const field = assertSoqlIdentifier(key.sourceField);
      for (const list of idLists(sourceIds)) {
        const rows = await files.copy.queryRecords(
          config.sourceOrgId,
          `SELECT Id, ${field} FROM ${object} WHERE Id IN (${list})`,
        );
        for (const row of rows) {
          const mapped = this.deps.fieldMapping.apply(row, objectConfig.fieldMappings);
          const value = this.deps.transformPipeline.transformRecord(mapped, objectConfig)[
            key.keyField
          ];
          if (typeof row.Id === 'string' && simulationKey(value) !== null) {
            keys.set(row.Id, value as string | number | boolean);
          }
        }
      }
    }
    if (keys.size === 0) return { held: new Map() };
    const found = await reads.targetIdsByKey(name, key.keyField, [...new Set(keys.values())]);
    const held = new Map<string, string>();
    for (const [sourceId, value] of keys) {
      const ids = found.get(simulationKey(value) as string) ?? [];
      if (ids.length === 1) held.set(sourceId, ids[0]);
    }
    return { held };
  }
}

/**
 * The records a write created, by their ids in the target: every record an
 * insert wrote, and those an upsert wrote that the org said it created. One
 * the org updated was the target's before; one an upsert wrote without the
 * org saying which it did is left out, never guessed into the run's.
 */
export function createdIds(
  operation: SyncObjectConfig['operation'],
  outcomes: readonly OperationOutcome[],
): string[] {
  if (operation !== 'insert' && operation !== 'upsert') return [];
  return outcomes.flatMap((outcome) =>
    outcome.success &&
    typeof outcome.id === 'string' &&
    outcome.id !== '' &&
    (operation === 'insert' || outcome.created === true)
      ? [outcome.id]
      : [],
  );
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
  reason?: string,
): SyncExecutionResult {
  const reached = determineStatus(objectResults) === 'failure' ? 'failure' : 'partial';
  const names = notReached.map((o) => o.objectApiName);
  const before =
    names.length > 0
      ? `Cancelled before ${names.join(', ')} ${names.length === 1 ? 'was' : 'were'} synced.`
      : 'Cancelled.';
  return {
    ...buildResult(configId, operationId, objectResults, startTime, reached),
    cancelled: true,
    error: reason ? `${reason} ${names.length > 0 ? before : ''}`.trim() : before,
  };
}

/** Why a run stopped while the files of an object's records were copied. */
function filesNotCopied(objectConfig: SyncObjectConfig): string {
  return (
    `Cancelled while the files of ${objectConfig.objectApiName} were copied: those copied stay ` +
    'in the target, the others are copied by the next run.'
  );
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

  // A deletion the target refused, or a deletion pass that could not run, is
  // an object the run did not finish, however its records were written.
  // So is one whose files were not all copied: the target lacks them.
  const hasFailed = results.some(
    (r) => r.failed > 0 || deletionsFell(r.delta) || (r.files?.failed ?? 0) > 0,
  );
  if (hasFailed) {
    return 'partial';
  }

  return 'success';
}

/** Whether an object's deletions were not all carried: refused, or never read. */
function deletionsFell(delta: SyncDeltaOutcome | undefined): boolean {
  return delta !== undefined && (delta.deleteFailed > 0 || delta.deletionError !== undefined);
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
