import type {
  AggregatedGrappeResult,
  GrappeConfig,
  GrappeOperationStatus,
  GrappeResult,
} from '@sandforge/shared';

import type { GrappePartitioner } from './GrappePartitioner.js';
import type { GrappeWorkerManager } from './GrappeWorkerManager.js';
import type { GrappeAggregator } from './GrappeAggregator.js';
import type { GrappeScheduler } from './GrappeScheduler.js';
import type { BackPressureManager } from './BackPressureManager.js';
import type { GrappeMonitor } from './GrappeMonitor.js';
import { generateId } from './GrappePartitioner.js';

/** Event types emitted by the GrappeOrchestrator */
export type GrappeOrchestratorEventType =
  | 'started'
  | 'completed'
  | 'failed'
  | 'paused'
  | 'resumed';

/** Listener function for orchestrator events */
export type GrappeOrchestratorListener = (data: GrappeOrchestratorEventData) => void;

/** Event data for orchestrator events */
export interface GrappeOrchestratorEventData {
  type: GrappeOrchestratorEventType;
  operationId: string;
  result?: AggregatedGrappeResult;
  error?: string;
}

/** Dependencies required by the GrappeOrchestrator */
export interface GrappeOrchestratorDeps {
  partitioner: GrappePartitioner;
  workerManager: GrappeWorkerManager;
  aggregator: GrappeAggregator;
  scheduler: GrappeScheduler;
  backPressureManager: BackPressureManager;
  monitor: GrappeMonitor;
}

/**
 * Top-level orchestrator for grappe (cluster) operations.
 * Composes all grappe services to execute large-scale record processing:
 * partitioning, scheduling, worker management, back-pressure control, and monitoring.
 */
export class GrappeOrchestrator {
  private readonly deps: GrappeOrchestratorDeps;
  private listeners: Map<
    GrappeOrchestratorEventType,
    Set<GrappeOrchestratorListener>
  > = new Map();
  private currentStatus: GrappeOperationStatus | undefined;
  private paused = false;
  private cancelled = false;
  private currentOperationId: string | undefined;

  /**
   * Create a new GrappeOrchestrator.
   * @param deps - All required sub-services injected as dependencies
   */
  constructor(deps: GrappeOrchestratorDeps) {
    this.deps = deps;
  }

  /**
   * Execute a full grappe operation: partition records, schedule waves,
   * assign to workers, process, and aggregate results.
   * @param records - Array of record IDs to process
   * @param config - Grappe configuration
   * @param processFn - Async function that processes a batch of records
   * @returns Aggregated result of the entire operation
   */
  async execute(
    records: string[],
    config: GrappeConfig,
    processFn: (records: string[]) => Promise<GrappeResult>
  ): Promise<AggregatedGrappeResult> {
    const operationId = generateId();
    this.currentOperationId = operationId;
    this.paused = false;
    this.cancelled = false;

    this.deps.aggregator.reset();
    this.deps.monitor.startMonitoring(operationId);
    this.deps.workerManager.createWorkers(config.maxWorkers);
    this.deps.backPressureManager.reset();

    this.emitEvent('started', { type: 'started', operationId });

    try {
      const partitions = this.deps.partitioner.partition(records, config);
      const waves = this.deps.scheduler.schedule(partitions);
      const completed = new Set<string>();

      for (const wave of waves) {
        if (this.cancelled) {
          break;
        }

        await this.waitWhilePaused();

        if (this.cancelled) {
          break;
        }

        const prioritized = this.deps.scheduler.reorderByPriority(wave);
        const wavePromises: Promise<void>[] = [];

        for (const partition of prioritized) {
          if (this.cancelled) {
            break;
          }

          const delay = this.deps.backPressureManager.getDelay();
          if (delay > 0) {
            await this.sleep(delay);
          }

          if (this.deps.backPressureManager.shouldPause()) {
            await this.waitForBackPressureRelease();
          }

          const availableWorkers =
            this.deps.workerManager.getAvailableWorkerCount();
          if (availableWorkers === 0 && wavePromises.length > 0) {
            await Promise.race(wavePromises);
          }

          const workerId = this.deps.workerManager.assignPartition(partition);
          partition.assignedWorker = workerId;
          partition.status = 'running';
          partition.startTime = new Date().toISOString();

          this.deps.monitor.updatePartitionStatus(partition.id, 'running');

          const promise = this.deps.workerManager
            .processPartition(workerId, partition, processFn)
            .then((result) => {
              partition.status = 'completed';
              partition.endTime = new Date().toISOString();
              this.deps.monitor.updatePartitionStatus(
                partition.id,
                'completed'
              );
              this.deps.aggregator.addResult(result);
              completed.add(partition.id);
            })
            .catch((error: Error) => {
              partition.status = 'failed';
              partition.endTime = new Date().toISOString();
              this.deps.monitor.updatePartitionStatus(partition.id, 'failed');
              this.deps.aggregator.addResult({
                grappeId: partition.id,
                status: 'failure',
                processedRecords: 0,
                successCount: 0,
                failureCount: partition.recordCount,
                errors: [error.message],
                duration: 0,
              });
              completed.add(partition.id);
            });

          wavePromises.push(promise);
        }

        await Promise.all(wavePromises);
      }

      const result = this.deps.aggregator.aggregate(operationId);

      this.currentStatus = this.deps.monitor.getOperationStatus(
        this.deps.partitioner.partition(records, config),
        this.deps.workerManager.getAllWorkerStatuses(),
        this.deps.backPressureManager.getLevel(),
        0
      );

      this.deps.monitor.stopMonitoring();

      this.emitEvent('completed', {
        type: 'completed',
        operationId,
        result,
      });

      return result;
    } catch (error: unknown) {
      this.deps.monitor.stopMonitoring();
      const message =
        error instanceof Error ? error.message : 'Unknown error';

      this.emitEvent('failed', {
        type: 'failed',
        operationId,
        error: message,
      });

      throw error;
    }
  }

  /**
   * Determine whether grappe mode should activate based on record count
   * and the auto-activation threshold.
   * @param recordCount - Number of records in the operation
   * @param config - Grappe configuration
   * @returns True if grappe mode should be activated
   */
  shouldActivateGrappe(recordCount: number, config: GrappeConfig): boolean {
    return config.enabled && recordCount >= config.autoActivateThreshold;
  }

  /**
   * Get the current operation status, if an operation is running or has completed.
   * @returns The current GrappeOperationStatus, or undefined if no operation has run
   */
  getStatus(): GrappeOperationStatus | undefined {
    return this.currentStatus;
  }

  /**
   * Pause the current operation. Processing will stop after the current wave completes.
   */
  pause(): void {
    this.paused = true;
    if (this.currentOperationId) {
      this.emitEvent('paused', {
        type: 'paused',
        operationId: this.currentOperationId,
      });
    }
  }

  /**
   * Resume a paused operation.
   */
  resume(): void {
    this.paused = false;
    if (this.currentOperationId) {
      this.emitEvent('resumed', {
        type: 'resumed',
        operationId: this.currentOperationId,
      });
    }
  }

  /**
   * Cancel the current operation. Processing will stop as soon as possible.
   */
  cancel(): void {
    this.cancelled = true;
    this.paused = false;
  }

  /**
   * Register a listener for an orchestrator event type.
   * @param event - The event type
   * @param listener - The callback function
   */
  on(
    event: GrappeOrchestratorEventType,
    listener: GrappeOrchestratorListener
  ): void {
    const listeners = this.listeners.get(event);
    if (listeners) {
      listeners.add(listener);
    } else {
      this.listeners.set(event, new Set([listener]));
    }
  }

  /**
   * Remove a listener for an orchestrator event type.
   * @param event - The event type
   * @param listener - The callback function to remove
   */
  off(
    event: GrappeOrchestratorEventType,
    listener: GrappeOrchestratorListener
  ): void {
    const listeners = this.listeners.get(event);
    if (listeners) {
      listeners.delete(listener);
    }
  }

  /**
   * Emit an event to all registered listeners.
   */
  private emitEvent(
    event: GrappeOrchestratorEventType,
    data: GrappeOrchestratorEventData
  ): void {
    const listeners = this.listeners.get(event);
    if (listeners) {
      for (const listener of listeners) {
        listener(data);
      }
    }
  }

  /**
   * Wait while the operation is paused.
   */
  private async waitWhilePaused(): Promise<void> {
    while (this.paused && !this.cancelled) {
      await this.sleep(100);
    }
  }

  /**
   * Wait until back-pressure drops below critical.
   */
  private async waitForBackPressureRelease(): Promise<void> {
    while (
      this.deps.backPressureManager.shouldPause() &&
      !this.cancelled
    ) {
      await this.sleep(this.deps.backPressureManager.getDelay());
    }
  }

  /**
   * Sleep for a given duration.
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
