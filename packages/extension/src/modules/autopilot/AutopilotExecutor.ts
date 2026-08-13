/**
 * AutopilotExecutor executes an autopilot plan wave by wave.
 * Emits real-time progress events for the UI.
 * Supports pause/resume/skip operations.
 */

import { TypedEventEmitter } from '../../core/common/TypedEventEmitter.js';
import type {
  ExecutionPlan,
  AutopilotEvent,
  AutopilotNodeProgressEvent,
  AutopilotNodeCompletedEvent,
  AutopilotNodeFailedEvent,
  AutopilotAnonymizationRule,
  AutopilotEdge,
  ApiName,
} from '@sandforge/shared';
import type { SmartAnonymizer } from './SmartAnonymizer.js';
import type { RecordIdRemapper } from './RecordIdRemapper.js';
import { extractErrorMessage } from '../../core/common/extractErrorMessage.js';
import { logger } from '../../logger.js';

/** Local alias matching the autopilot domain name. */
type AnonymizationRule = AutopilotAnonymizationRule;

/** Function to query records from source org */
export type QueryFn = (
  objectApiName: string,
  offset: number,
  limit: number,
) => Promise<Record<string, unknown>[]>;

/** Function to insert records into target org */
export type InsertFn = (
  objectApiName: string,
  records: Record<string, unknown>[],
) => Promise<InsertResult>;

/** Result of an insert operation */
export interface InsertResult {
  /** IDs of successfully inserted records in target org */
  successIds: string[];
  /** Source IDs corresponding to successIds (same order) */
  sourceIds: string[];
  /** Error messages for failed records */
  errors: string[];
}

/**
 * Fatal-crash event. Carries the message the run died with, so a listener that
 * only observes events (and never sees the thrown error) can still report why.
 */
export interface AutopilotExecutionFailedEvent extends AutopilotEvent {
  /** Event type discriminator */
  readonly type: 'execution-failed';
  /** Message the execution died with */
  readonly error: string;
}

/** Events emitted by AutopilotExecutor */
export type AutopilotExecutorEvents = {
  [key: string]: unknown;
  'node-progress': AutopilotNodeProgressEvent;
  'node-completed': AutopilotNodeCompletedEvent;
  'node-failed': AutopilotNodeFailedEvent;
  'wave-completed': AutopilotEvent;
  'execution-started': AutopilotEvent;
  'execution-completed': AutopilotEvent;
  'execution-failed': AutopilotExecutionFailedEvent;
  paused: AutopilotEvent;
  resumed: AutopilotEvent;
};

/** Execution result summary */
export interface ExecutionResult {
  /** Total successfully inserted records */
  totalSuccess: number;
  /** Total failed records */
  totalFailure: number;
  /** Total skipped records */
  totalSkipped: number;
  /** Total elapsed time in milliseconds */
  elapsedMs: number;
  /** Objects that completed successfully */
  completedObjects: string[];
  /** Objects that failed */
  failedObjects: string[];
  /** Objects that were skipped */
  skippedObjects: string[];
  /**
   * First error message per failed object, keyed by API name. The aggregate
   * counters cannot carry it, and it is what the UI shows on the failed node.
   */
  nodeErrors?: Record<string, string>;
  /**
   * Message the run died with. Set only when execution crashed, in which case
   * the counters above are partial and the executor rethrows instead of
   * returning this result.
   */
  fatalError?: string;
}

/** Dependencies for the executor */
export interface AutopilotExecutorDeps {
  /** Function to query records from source org */
  query: QueryFn;
  /** Function to insert records into target org */
  insert: InsertFn;
  /** Anonymizer for PII fields */
  anonymizer: SmartAnonymizer;
  /** ID remapper for lookup fields */
  remapper: RecordIdRemapper;
  /** Batch size for queries and inserts (default: 200) */
  batchSize?: number;
}

/** Result of executing a single object */
interface ObjectResult {
  success: number;
  failure: number;
  errors: string[];
  apiCallsUsed: number;
  elapsedMs: number;
}

/**
 * Executes an autopilot plan wave by wave.
 * Emits real-time progress events for the UI.
 * Supports pause/resume/skip operations.
 */
export class AutopilotExecutor extends TypedEventEmitter<AutopilotExecutorEvents> {
  private readonly deps: AutopilotExecutorDeps;
  private readonly batchSize: number;
  private paused = false;
  private pausePromise: Promise<void> | null = null;
  private pauseResolve: (() => void) | null = null;
  private skippedObjects = new Set<string>();

  constructor(deps: AutopilotExecutorDeps) {
    super();
    this.deps = deps;
    this.batchSize = deps.batchSize ?? 200;
  }

  /**
   * Execute the full plan wave by wave.
   * @param plan - The execution plan with waves
   * @param edges - Dependency edges for ID remapping
   * @param rules - Anonymization rules to apply
   * @param recordCounts - Map of object API name to record count
   * @returns Execution result summary
   */
  async execute(
    plan: ExecutionPlan,
    edges: AutopilotEdge[],
    rules: AnonymizationRule[],
    recordCounts: Map<string, number>,
  ): Promise<ExecutionResult> {
    const startTime = Date.now();
    const nodeErrors: Record<string, string> = {};
    const result: ExecutionResult = {
      totalSuccess: 0,
      totalFailure: 0,
      totalSkipped: 0,
      elapsedMs: 0,
      completedObjects: [],
      failedObjects: [],
      skippedObjects: [],
      nodeErrors,
    };

    this.emit(
      'execution-started',
      this.makeEvent({
        type: 'execution-started' as const,
        timestamp: '',
      }),
    );

    try {
      for (const wave of plan.waves) {
        const waveResults = await Promise.all(
          wave.objects.map(async (objectApiName) => {
            if (this.skippedObjects.has(objectApiName)) {
              const totalRecords = recordCounts.get(objectApiName) ?? 0;
              result.skippedObjects.push(objectApiName);
              result.totalSkipped += totalRecords;
              return;
            }

            await this.checkPause();

            const totalRecords = recordCounts.get(objectApiName) ?? 0;
            try {
              const objResult = await this.executeObject(
                objectApiName as ApiName,
                edges,
                rules,
                totalRecords,
              );

              result.totalSuccess += objResult.success;
              result.totalFailure += objResult.failure;

              if (objResult.errors.length > 0 && objResult.success === 0) {
                result.failedObjects.push(objectApiName);
                nodeErrors[objectApiName] = objResult.errors[0];
                this.emit(
                  'node-failed',
                  this.makeEvent({
                    type: 'node-failed' as const,
                    timestamp: '',
                    objectApiName: objectApiName as ApiName,
                    errors: objResult.errors,
                    partialSuccessCount: objResult.success,
                  }),
                );
              } else {
                result.completedObjects.push(objectApiName);
                this.emit(
                  'node-completed',
                  this.makeEvent({
                    type: 'node-completed' as const,
                    timestamp: '',
                    objectApiName: objectApiName as ApiName,
                    successCount: objResult.success,
                    failureCount: objResult.failure,
                    elapsedMs: objResult.elapsedMs,
                    apiCallsUsed: objResult.apiCallsUsed,
                  }),
                );
              }
            } catch (err) {
              result.failedObjects.push(objectApiName);
              const errorMsg = extractErrorMessage(err);
              nodeErrors[objectApiName] = errorMsg;
              this.emit(
                'node-failed',
                this.makeEvent({
                  type: 'node-failed' as const,
                  timestamp: '',
                  objectApiName: objectApiName as ApiName,
                  errors: [errorMsg],
                  partialSuccessCount: 0,
                }),
              );
            }
          }),
        );

        void waveResults;

        this.emit(
          'wave-completed',
          this.makeEvent({
            type: 'wave-completed' as const,
            timestamp: '',
          }),
        );
      }

      result.elapsedMs = Date.now() - startTime;
      this.emit(
        'execution-completed',
        this.makeEvent({
          type: 'execution-completed' as const,
          timestamp: '',
        }),
      );

      return result;
    } catch (err) {
      result.elapsedMs = Date.now() - startTime;
      result.fatalError = extractErrorMessage(err);
      logger.error('Autopilot execution crashed', { error: result.fatalError });
      this.emit(
        'execution-failed',
        this.makeEvent({
          type: 'execution-failed' as const,
          timestamp: '',
          error: result.fatalError,
        }),
      );
      // Rethrow: returning hands the caller partial counters indistinguishable
      // from a finished run, which is how a crash reaches the user as a success.
      throw err;
    }
  }

  /**
   * Execute a single object transfer: query, anonymize, remap, insert in batches.
   * @param objectApiName - The object to transfer
   * @param edges - Dependency edges for remapping
   * @param rules - Anonymization rules
   * @param totalRecords - Total records to process
   * @returns Object result with success/failure counts
   */
  private async executeObject(
    objectApiName: ApiName,
    edges: AutopilotEdge[],
    rules: AnonymizationRule[],
    totalRecords: number,
  ): Promise<ObjectResult> {
    const objStart = Date.now();
    let success = 0;
    let failure = 0;
    let apiCallsUsed = 0;
    const errors: string[] = [];

    let offset = 0;

    while (offset < totalRecords) {
      await this.checkPause();

      // 1. Query from source
      const batch = await this.deps.query(objectApiName, offset, this.batchSize);
      apiCallsUsed++;

      if (batch.length === 0) {
        break;
      }

      // 2. Anonymize
      this.deps.anonymizer.anonymize(batch, rules, objectApiName);

      // 3. Remap lookup IDs
      this.deps.remapper.remapRecords(batch, edges, objectApiName);

      // 4. Insert into target
      const insertResult = await this.deps.insert(objectApiName, batch);
      apiCallsUsed++;

      // 5. Register new ID mappings
      const mappings: Array<[string, string]> = [];
      for (let i = 0; i < insertResult.successIds.length; i++) {
        const sourceId = insertResult.sourceIds[i];
        const targetId = insertResult.successIds[i];
        if (sourceId && targetId) {
          mappings.push([sourceId, targetId]);
        }
      }
      if (mappings.length > 0) {
        this.deps.remapper.registerMappings(objectApiName, mappings);
      }

      success += insertResult.successIds.length;
      failure += insertResult.errors.length;
      errors.push(...insertResult.errors);

      offset += batch.length;

      // 6. Emit node-progress
      const processed = Math.min(offset, totalRecords);
      const progress = totalRecords > 0 ? Math.round((processed / totalRecords) * 100) : 100;

      this.emit(
        'node-progress',
        this.makeEvent({
          type: 'node-progress' as const,
          timestamp: '',
          objectApiName,
          progress,
          recordsProcessed: processed,
          recordsTotal: totalRecords,
          apiCallsUsed,
        }),
      );
    }

    return {
      success,
      failure,
      errors,
      apiCallsUsed,
      elapsedMs: Date.now() - objStart,
    };
  }

  /** Pause execution. Subsequent batch iterations will wait until resumed. */
  pause(): void {
    if (this.paused) return;
    this.paused = true;
    this.pausePromise = new Promise<void>((resolve) => {
      this.pauseResolve = resolve;
    });
    this.emit(
      'paused',
      this.makeEvent({
        type: 'paused' as const,
        timestamp: '',
      }),
    );
  }

  /** Resume execution after a pause. */
  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    this.pauseResolve?.();
    this.pausePromise = null;
    this.pauseResolve = null;
    this.emit(
      'resumed',
      this.makeEvent({
        type: 'resumed' as const,
        timestamp: '',
      }),
    );
  }

  /**
   * Skip an object. If called before execution reaches that object, it will be skipped.
   * @param objectApiName - The object to skip
   */
  skip(objectApiName: string): void {
    this.skippedObjects.add(objectApiName);
  }

  /** Check if paused and wait until resumed. */
  private async checkPause(): Promise<void> {
    if (this.paused && this.pausePromise) {
      await this.pausePromise;
    }
  }

  /** Create a timestamped event, overriding the timestamp field. */
  private makeEvent<T extends AutopilotEvent>(event: T): T {
    return { ...event, timestamp: new Date().toISOString() };
  }
}
