import type { PipelineTrigger } from '@sandforge/shared';
import type { TriggerEngine } from './TriggerEngine';

/** A scheduled pipeline entry with its next computed fire time */
export interface ScheduledEntry {
  pipelineId: string;
  trigger: PipelineTrigger;
  nextFireTime: Date;
}

/** Dependencies required by the SchedulerService */
export interface SchedulerDependencies {
  triggerEngine: TriggerEngine;
}

/**
 * Manages scheduled pipeline execution.
 * Maintains an in-memory registry of pipelines mapped to their schedule triggers,
 * and computes next fire times via the TriggerEngine.
 */
export class SchedulerService {
  private readonly deps: SchedulerDependencies;
  private readonly schedules: Map<string, PipelineTrigger> = new Map();

  constructor(deps: SchedulerDependencies) {
    this.deps = deps;
  }

  /**
   * Register a pipeline for scheduled execution.
   * @param pipelineId - Unique ID of the pipeline to schedule
   * @param trigger - The schedule trigger configuration
   */
  schedule(pipelineId: string, trigger: PipelineTrigger): void {
    this.schedules.set(pipelineId, trigger);
  }

  /**
   * Remove a pipeline from the schedule registry.
   * @param pipelineId - ID of the pipeline to unschedule
   */
  unschedule(pipelineId: string): void {
    this.schedules.delete(pipelineId);
  }

  /**
   * Return all scheduled pipelines with their computed next fire times.
   * Pipelines whose next fire time cannot be determined are excluded.
   * @returns Array of pipeline IDs and their next fire times
   */
  getScheduledPipelines(): Array<{ pipelineId: string; nextFireTime: Date }> {
    const result: Array<{ pipelineId: string; nextFireTime: Date }> = [];

    for (const [pipelineId, trigger] of this.schedules.entries()) {
      const nextFireTime = this.deps.triggerEngine.getNextFireTime(trigger);
      if (nextFireTime) {
        result.push({ pipelineId, nextFireTime });
      }
    }

    return result;
  }

  /**
   * Check whether a pipeline is currently scheduled.
   * @param pipelineId - ID of the pipeline to check
   * @returns true if the pipeline has a registered schedule
   */
  isScheduled(pipelineId: string): boolean {
    return this.schedules.has(pipelineId);
  }

  /**
   * Retrieve the schedule trigger for a pipeline.
   * @param pipelineId - ID of the pipeline
   * @returns The trigger if scheduled, or undefined
   */
  getSchedule(pipelineId: string): PipelineTrigger | undefined {
    return this.schedules.get(pipelineId);
  }
}
