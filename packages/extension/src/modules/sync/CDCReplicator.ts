import type {
  CDCEvent,
  CDCConflict,
  ConflictStrategy,
  FieldMapping,
  ApiName,
} from '@sandforge/shared';
import type { FieldMappingService } from './FieldMapping';

/** Function to apply a record change (insert/update/delete) to the target org */
export type ReplicatorApplyFn = (
  objectName: string,
  operation: 'insert' | 'update' | 'delete' | 'undelete',
  records: Record<string, unknown>[],
) => Promise<ReplicatorApplyResult[]>;

/** Result of applying a single record to the target */
export interface ReplicatorApplyResult {
  recordId: string;
  success: boolean;
  error?: string;
}

/** Function to query current target record values for conflict detection */
export type TargetQueryFn = (
  objectName: string,
  recordIds: string[],
) => Promise<Record<string, unknown>[]>;

/** Callback for when a conflict is detected */
export type ConflictHandler = (conflict: CDCConflict) => void;

/** Dependencies required by the CDCReplicator */
export interface CDCReplicatorDeps {
  applyFn: ReplicatorApplyFn;
  targetQueryFn: TargetQueryFn;
  fieldMapping: FieldMappingService;
  conflictStrategy: ConflictStrategy;
  fieldMappings: Record<ApiName, FieldMapping[]>;
  flushIntervalMs: number;
  maxBatchSize: number;
  onConflict?: ConflictHandler;
}

/** Replication metrics tracked per event */
interface ReplicationTiming {
  eventTimestamp: number;
  appliedTimestamp: number;
}

/**
 * Applies CDC events received from CDCListener to a target org.
 * Buffers incoming changes and flushes them in configurable batches.
 * Handles field mapping, conflict detection, and replication lag tracking.
 */
export class CDCReplicator {
  private readonly deps: CDCReplicatorDeps;
  private buffer: Map<string, CDCEvent[]> = new Map();
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private timings: ReplicationTiming[] = [];
  private totalApplied = 0;
  private totalFailed = 0;
  private running = false;

  constructor(deps: CDCReplicatorDeps) {
    this.deps = deps;
  }

  /**
   * Start the replicator, enabling event buffering and periodic flush.
   * Sets up a timer that flushes buffered events at the configured interval.
   */
  start(): void {
    if (this.running) {
      return;
    }
    this.running = true;
    this.flushTimer = setInterval(() => {
      void this.flush();
    }, this.deps.flushIntervalMs);
  }

  /**
   * Stop the replicator, flushing remaining events and clearing the timer.
   * Performs a final flush before stopping to avoid data loss.
   */
  async stop(): Promise<void> {
    this.running = false;
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    await this.flush();
  }

  /**
   * Receive a CDC event and buffer it for batched application.
   * Events are grouped by object API name for efficient batch processing.
   */
  receive(event: CDCEvent): void {
    const existing = this.buffer.get(event.objectApiName) ?? [];
    existing.push(event);
    this.buffer.set(event.objectApiName, existing);

    // Auto-flush if buffer exceeds max batch size
    const totalBuffered = this.getBufferedCount();
    if (totalBuffered >= this.deps.maxBatchSize) {
      void this.flush();
    }
  }

  /**
   * Flush all buffered events, applying them to the target org.
   * Groups events by object and operation type for batch processing.
   */
  async flush(): Promise<void> {
    const snapshot = new Map(this.buffer);
    this.buffer.clear();

    for (const [objectName, events] of snapshot) {
      await this.applyEvents(objectName, events);
    }
  }

  /** Total number of events successfully applied since start. */
  getTotalApplied(): number {
    return this.totalApplied;
  }

  /** Total number of events that failed to apply since start. */
  getTotalFailed(): number {
    return this.totalFailed;
  }

  /** Current number of events waiting in the buffer. */
  getBufferedCount(): number {
    let count = 0;
    for (const events of this.buffer.values()) {
      count += events.length;
    }
    return count;
  }

  /**
   * Calculate the average replication lag in milliseconds.
   * Lag is measured from when the event was committed in source to when it was applied.
   */
  getAverageLagMs(): number {
    if (this.timings.length === 0) {
      return 0;
    }
    let total = 0;
    for (const t of this.timings) {
      total += t.appliedTimestamp - t.eventTimestamp;
    }
    return Math.round(total / this.timings.length);
  }

  /**
   * Get the most recent replication lag in milliseconds.
   * Returns 0 if no events have been applied yet.
   */
  getCurrentLagMs(): number {
    if (this.timings.length === 0) {
      return 0;
    }
    const last = this.timings[this.timings.length - 1];
    return last.appliedTimestamp - last.eventTimestamp;
  }

  /** Whether the replicator is currently running. */
  isRunning(): boolean {
    return this.running;
  }

  private async applyEvents(
    objectName: string,
    events: CDCEvent[],
  ): Promise<void> {
    // Group by change type
    const groups = this.groupByChangeType(events);

    for (const [operation, groupEvents] of groups) {
      const sfOperation = this.mapOperation(operation);

      // Check for conflicts on UPDATE operations
      if (operation === 'UPDATE') {
        await this.checkConflicts(objectName, groupEvents);
      }

      const mappedRecords = groupEvents.map((event) =>
        this.mapFields(objectName, event),
      );

      try {
        const results = await this.deps.applyFn(
          objectName,
          sfOperation,
          mappedRecords,
        );

        const now = Date.now();
        for (let i = 0; i < results.length; i++) {
          const result = results[i];
          const event = groupEvents[i];
          if (result.success) {
            this.totalApplied++;
            this.timings.push({
              eventTimestamp: new Date(event.commitTimestamp).getTime(),
              appliedTimestamp: now,
            });
          } else {
            this.totalFailed++;
          }
        }

        // Keep only the last 1000 timings to bound memory
        if (this.timings.length > 1000) {
          this.timings = this.timings.slice(-500);
        }
      } catch {
        this.totalFailed += groupEvents.length;
      }
    }
  }

  private groupByChangeType(
    events: CDCEvent[],
  ): Map<string, CDCEvent[]> {
    const groups = new Map<string, CDCEvent[]>();
    for (const event of events) {
      const existing = groups.get(event.changeType) ?? [];
      existing.push(event);
      groups.set(event.changeType, existing);
    }
    return groups;
  }

  private mapOperation(
    changeType: string,
  ): 'insert' | 'update' | 'delete' | 'undelete' {
    switch (changeType) {
      case 'CREATE':
        return 'insert';
      case 'UPDATE':
        return 'update';
      case 'DELETE':
        return 'delete';
      case 'UNDELETE':
        return 'undelete';
      default:
        return 'update';
    }
  }

  private mapFields(
    objectName: string,
    event: CDCEvent,
  ): Record<string, unknown> {
    const mappings = this.deps.fieldMappings[objectName];
    if (!mappings || mappings.length === 0) {
      // No mappings configured — pass through with record IDs
      return {
        ...event.changedFields,
        Id: event.recordIds[0],
      };
    }

    const mapped = this.deps.fieldMapping.apply(event.changedFields, mappings);
    return {
      ...mapped,
      Id: event.recordIds[0],
    };
  }

  private async checkConflicts(
    objectName: string,
    events: CDCEvent[],
  ): Promise<void> {
    if (!this.deps.onConflict) {
      return;
    }

    const allRecordIds = events.flatMap((e) => e.recordIds);
    if (allRecordIds.length === 0) {
      return;
    }

    let targetRecords: Record<string, unknown>[];
    try {
      targetRecords = await this.deps.targetQueryFn(objectName, allRecordIds);
    } catch {
      return; // Skip conflict detection on query failure
    }

    const targetMap = new Map<string, Record<string, unknown>>();
    for (const record of targetRecords) {
      const id = String(record.Id ?? '');
      if (id) {
        targetMap.set(id, record);
      }
    }

    for (const event of events) {
      for (const recordId of event.recordIds) {
        const targetRecord = targetMap.get(recordId);
        if (!targetRecord) {
          continue;
        }

        const targetLastModified = String(
          targetRecord.LastModifiedDate ?? '',
        );
        if (!targetLastModified) {
          continue;
        }

        const targetDate = new Date(targetLastModified);
        const eventDate = new Date(event.commitTimestamp);

        // Conflict if target was modified after the CDC event
        if (targetDate > eventDate) {
          const conflict: CDCConflict = {
            event,
            targetValues: targetRecord,
            targetLastModified: targetDate.toISOString(),
            resolved: this.deps.conflictStrategy !== 'manual',
            resolution:
              this.deps.conflictStrategy !== 'manual'
                ? this.deps.conflictStrategy
                : undefined,
          };
          this.deps.onConflict(conflict);
        }
      }
    }
  }
}
