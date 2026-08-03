/** Metrics for a single tracked operation */
export interface PerformanceMetrics {
  operationId: string;
  module: string;
  startTime: number;
  endTime?: number;
  durationMs?: number;
  recordsPerSecond?: number;
  totalRecords: number;
  apiCalls: number;
  peakMemoryMB?: number;
}

/** Aggregated historical performance for an object */
export interface PerformanceHistory {
  objectName: string;
  averageDurationMs: number;
  averageRecordsPerSec: number;
  sampleCount: number;
}

const DEGRADATION_THRESHOLD = 0.8;

/** Maximum completed operations retained per module (FIFO eviction). */
const MAX_HISTORY_PER_MODULE = 100;

/**
 * Tracks the performance of operations across modules.
 * Maintains per-operation metrics and aggregated history
 * to detect performance degradation.
 */
export class PerformanceTracker {
  private readonly activeOperations: Map<string, PerformanceMetrics> = new Map();
  private readonly completedHistory: Map<string, PerformanceMetrics[]> = new Map();

  /** Begin tracking an operation */
  start(operationId: string, module: string): void {
    this.activeOperations.set(operationId, {
      operationId,
      module,
      startTime: Date.now(),
      totalRecords: 0,
      apiCalls: 0,
    });
  }

  /** Update in-flight metrics for a tracked operation */
  update(operationId: string, records: number, apiCalls: number): void {
    const metrics = this.activeOperations.get(operationId);
    if (!metrics) return;
    metrics.totalRecords += records;
    metrics.apiCalls += apiCalls;
  }

  /** Complete an operation and move it to history. Returns the final metrics. */
  complete(operationId: string): PerformanceMetrics | undefined {
    const metrics = this.activeOperations.get(operationId);
    if (!metrics) return undefined;

    metrics.endTime = Date.now();
    metrics.durationMs = metrics.endTime - metrics.startTime;
    metrics.recordsPerSecond =
      metrics.durationMs > 0 ? (metrics.totalRecords / metrics.durationMs) * 1000 : 0;

    this.activeOperations.delete(operationId);
    this.addToHistory(metrics);
    return { ...metrics };
  }

  /** Get the current metrics for an active or recently completed operation */
  getMetrics(operationId: string): PerformanceMetrics | undefined {
    const active = this.activeOperations.get(operationId);
    if (active) return { ...active };

    for (const entries of this.completedHistory.values()) {
      const found = entries.find((e) => e.operationId === operationId);
      if (found) return { ...found };
    }

    return undefined;
  }

  /** Get aggregated performance history for a module */
  getHistory(objectName: string): PerformanceHistory | undefined {
    const entries = this.completedHistory.get(objectName);
    if (!entries || entries.length === 0) return undefined;

    const totalDuration = entries.reduce((s, e) => s + (e.durationMs ?? 0), 0);
    const totalRps = entries.reduce((s, e) => s + (e.recordsPerSecond ?? 0), 0);

    return {
      objectName,
      averageDurationMs: totalDuration / entries.length,
      averageRecordsPerSec: totalRps / entries.length,
      sampleCount: entries.length,
    };
  }

  /**
   * Detect whether an active operation's throughput has degraded
   * compared to the historical average for its module.
   * Returns true if current performance is below 80% of the average.
   */
  detectDegradation(operationId: string): boolean {
    const metrics = this.activeOperations.get(operationId);
    if (!metrics) return false;

    const elapsed = Date.now() - metrics.startTime;
    if (elapsed === 0 || metrics.totalRecords === 0) return false;

    const currentRps = (metrics.totalRecords / elapsed) * 1000;
    const history = this.getHistory(metrics.module);
    if (!history || history.sampleCount === 0) return false;

    return currentRps < history.averageRecordsPerSec * DEGRADATION_THRESHOLD;
  }

  /** Return all currently active (in-flight) operations */
  getAllActive(): PerformanceMetrics[] {
    return Array.from(this.activeOperations.values()).map((m) => ({ ...m }));
  }

  /** Clear all tracked operations and history */
  dispose(): void {
    this.activeOperations.clear();
    this.completedHistory.clear();
  }

  private addToHistory(metrics: PerformanceMetrics): void {
    const key = metrics.module;
    const existing = this.completedHistory.get(key) ?? [];
    existing.push(metrics);
    // Cap per-module history — unbounded growth otherwise (long sessions
    // running thousands of operations would pin every metrics object).
    if (existing.length > MAX_HISTORY_PER_MODULE) {
      existing.splice(0, existing.length - MAX_HISTORY_PER_MODULE);
    }
    this.completedHistory.set(key, existing);
  }
}
