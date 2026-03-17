import type {
  PipelineHistoryEntry,
  PipelineRun,
} from '@sandforge/shared';

/**
 * Manages the execution history of pipeline runs.
 * Stores runs and history entries in memory, provides query methods
 * for retrieving runs, statistics, and recent activity.
 */
export class PipelineHistory {
  private readonly runs: Map<string, PipelineRun> = new Map();
  private readonly history: Map<string, PipelineHistoryEntry[]> = new Map();

  /**
   * Record a completed pipeline run and its history entry.
   * @param run - The pipeline run to record
   */
  record(run: PipelineRun): void {
    this.runs.set(run.id, run);

    const entry: PipelineHistoryEntry = {
      runId: run.id,
      pipelineId: run.pipelineId,
      pipelineName: run.pipelineName,
      status: run.status,
      triggeredBy: run.triggeredBy,
      startTime: run.startTime,
      duration: run.duration ?? 0,
      stepCount: run.stepResults.length,
      errorCount: run.stepResults.filter((r) => r.status === 'failed').length,
    };

    const pipelineHistory = this.history.get(run.pipelineId) ?? [];
    pipelineHistory.push(entry);
    this.history.set(run.pipelineId, pipelineHistory);
  }

  /**
   * Retrieve the execution history for a specific pipeline.
   * @param pipelineId - ID of the pipeline
   * @param limit - Maximum number of entries to return
   * @returns Array of history entries, most recent first
   */
  getHistory(pipelineId: string, limit: number): PipelineHistoryEntry[] {
    const entries = this.history.get(pipelineId) ?? [];
    return entries
      .slice()
      .sort((a, b) => new Date(b.startTime).getTime() - new Date(a.startTime).getTime())
      .slice(0, limit);
  }

  /**
   * Retrieve a specific pipeline run by its ID.
   * @param runId - ID of the run to retrieve
   * @returns The pipeline run, or undefined if not found
   */
  getRun(runId: string): PipelineRun | undefined {
    return this.runs.get(runId);
  }

  /**
   * Compute aggregate statistics for a pipeline's execution history.
   * @param pipelineId - ID of the pipeline
   * @returns Object containing totalRuns, successRate, and avgDuration
   */
  getStats(pipelineId: string): {
    totalRuns: number;
    successRate: number;
    avgDuration: number;
  } {
    const entries = this.history.get(pipelineId) ?? [];

    if (entries.length === 0) {
      return { totalRuns: 0, successRate: 0, avgDuration: 0 };
    }

    const totalRuns = entries.length;
    const successCount = entries.filter(
      (e) => e.status === 'completed' || e.status === 'completed_with_warnings'
    ).length;
    const successRate = successCount / totalRuns;
    const totalDuration = entries.reduce((sum, e) => sum + e.duration, 0);
    const avgDuration = totalDuration / totalRuns;

    return { totalRuns, successRate, avgDuration };
  }

  /**
   * Clear all execution history for a specific pipeline.
   * @param pipelineId - ID of the pipeline whose history to clear
   */
  clearHistory(pipelineId: string): void {
    const entries = this.history.get(pipelineId) ?? [];
    for (const entry of entries) {
      this.runs.delete(entry.runId);
    }
    this.history.delete(pipelineId);
  }

  /**
   * Retrieve the most recent pipeline runs across all pipelines.
   * @param limit - Maximum number of entries to return
   * @returns Array of history entries, most recent first
   */
  getRecentRuns(limit: number): PipelineHistoryEntry[] {
    const allEntries: PipelineHistoryEntry[] = [];
    for (const entries of this.history.values()) {
      allEntries.push(...entries);
    }

    return allEntries
      .sort((a, b) => new Date(b.startTime).getTime() - new Date(a.startTime).getTime())
      .slice(0, limit);
  }
}
