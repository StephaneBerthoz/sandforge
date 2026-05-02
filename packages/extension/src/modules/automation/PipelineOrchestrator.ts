import type {
  PipelineDefinition,
  PipelineRun,
  PipelineStepResult,
  TriggerType,
} from '@sandforge/shared';
import type { PipelineBuilder } from './PipelineBuilder';
import type { TriggerEngine } from './TriggerEngine';
import type { SchedulerService } from './SchedulerService';
import type { StepLibrary } from './StepLibrary';
import type { StepExecutor } from './StepExecutor';
import type { ConditionalRouter } from './ConditionalRouter';
import type { PipelineHistory } from './PipelineHistory';
import type { CoreServices } from '../../services.js';

/** Events emitted by the PipelineOrchestrator */
export type PipelineEvent =
  | 'started'
  | 'stepCompleted'
  | 'completed'
  | 'failed';

/** Handler function for pipeline events */
export type PipelineEventHandler = (
  event: PipelineEvent,
  data: unknown
) => void;

/** Dependencies required by the PipelineOrchestrator */
export interface PipelineOrchestratorDependencies {
  builder: PipelineBuilder;
  triggerEngine: TriggerEngine;
  scheduler: SchedulerService;
  stepLibrary: StepLibrary;
  stepExecutor: StepExecutor;
  conditionalRouter: ConditionalRouter;
  history: PipelineHistory;
  /**
   * Injected cross-cutting adapters (telemetry, storage, salesforce, fs).
   * Provided by the composition root (`services.ts`). Optional to preserve
   * backward compatibility with tests that pass a narrow deps shape.
   */
  services?: CoreServices;
}

/**
 * Generates a RFC4122 v4 UUID via the platform crypto primitive.
 * Used internally to assign unique identifiers to pipeline runs.
 */
function generateId(): string {
  return globalThis.crypto.randomUUID();
}

/**
 * Top-level orchestrator that coordinates all pipeline automation services.
 * Manages the full lifecycle of pipeline execution including step sequencing,
 * conditional routing, pause/resume/cancel, and history recording.
 */
export class PipelineOrchestrator {
  private readonly deps: PipelineOrchestratorDependencies;
  private readonly activeRuns: Map<string, PipelineRun> = new Map();
  private readonly handlers: Map<PipelineEvent, Set<PipelineEventHandler>> = new Map();
  private readonly pausedRuns: Set<string> = new Set();
  private readonly cancelledRuns: Set<string> = new Set();

  constructor(deps: PipelineOrchestratorDependencies) {
    this.deps = deps;
  }

  /**
   * Execute a pipeline definition with the given variables.
   * Runs all steps sequentially, respects conditional routing,
   * and records the run in history upon completion.
   * @param pipeline - The pipeline definition to execute
   * @param variables - Runtime variables for the execution
   * @param triggeredBy - What triggered this execution
   * @returns The completed pipeline run
   */
  async execute(
    pipeline: PipelineDefinition,
    variables: Record<string, string>,
    triggeredBy: TriggerType
  ): Promise<PipelineRun> {
    const errors = this.deps.builder.validate(pipeline);
    if (errors.length > 0) {
      const failedRun = this.createRun(pipeline, variables, triggeredBy);
      failedRun.status = 'failed';
      failedRun.error = `Validation failed: ${errors.join(', ')}`;
      failedRun.endTime = new Date().toISOString();
      this.emit('failed', { runId: failedRun.id, error: failedRun.error });
      return failedRun;
    }

    const run = this.createRun(pipeline, variables, triggeredBy);
    run.status = 'running';
    this.activeRuns.set(run.id, run);
    this.emit('started', { runId: run.id, pipelineId: pipeline.id });

    let hasFailures = false;

    for (const step of pipeline.steps) {
      if (this.cancelledRuns.has(run.id)) {
        run.status = 'cancelled';
        break;
      }

      if (this.pausedRuns.has(run.id)) {
        run.status = 'paused';
        break;
      }

      if (step.condition) {
        const conditionContext: Record<string, unknown> = { ...variables };
        const conditionMet = this.deps.conditionalRouter.evaluate(
          step.condition,
          conditionContext
        );
        if (!conditionMet) {
          const skippedResult: PipelineStepResult = {
            stepId: step.id,
            stepName: step.name,
            stepType: step.type,
            status: 'skipped',
          };
          run.stepResults.push(skippedResult);
          continue;
        }
      }

      const result = await this.deps.stepExecutor.execute(step, {
        variables,
        previousResults: run.stepResults,
        pipelineId: pipeline.id,
        runId: run.id,
      });

      run.stepResults.push(result);
      this.emit('stepCompleted', { runId: run.id, stepResult: result });

      if (result.status === 'failed') {
        hasFailures = true;
        if (!step.continueOnError) {
          run.status = 'failed';
          run.error = result.error;
          break;
        }
      }

      const nextStepId = this.deps.conditionalRouter.getNextStep(step, result);
      if (nextStepId) {
        const nextStep = pipeline.steps.find((s) => s.id === nextStepId);
        if (nextStep) {
          const nextResult = await this.deps.stepExecutor.execute(nextStep, {
            variables,
            previousResults: run.stepResults,
            pipelineId: pipeline.id,
            runId: run.id,
          });
          run.stepResults.push(nextResult);
          this.emit('stepCompleted', { runId: run.id, stepResult: nextResult });
        }
      }
    }

    if (run.status === 'running') {
      run.status = hasFailures ? 'completed_with_warnings' : 'completed';
    }

    run.endTime = new Date().toISOString();
    run.duration =
      new Date(run.endTime).getTime() - new Date(run.startTime).getTime();

    this.activeRuns.delete(run.id);
    this.pausedRuns.delete(run.id);
    this.cancelledRuns.delete(run.id);

    this.deps.history.record(run);

    if (run.status === 'failed') {
      this.emit('failed', { runId: run.id, error: run.error });
    } else {
      this.emit('completed', { runId: run.id, status: run.status });
    }

    return run;
  }

  /**
   * Pause a currently running pipeline.
   * @param runId - ID of the run to pause
   */
  pause(runId: string): void {
    if (this.activeRuns.has(runId)) {
      this.pausedRuns.add(runId);
      const run = this.activeRuns.get(runId);
      if (run) {
        run.status = 'paused';
      }
    }
  }

  /**
   * Resume a paused pipeline.
   * @param runId - ID of the run to resume
   */
  resume(runId: string): void {
    if (this.pausedRuns.has(runId)) {
      this.pausedRuns.delete(runId);
      const run = this.activeRuns.get(runId);
      if (run) {
        run.status = 'running';
      }
    }
  }

  /**
   * Cancel a currently running or paused pipeline.
   * @param runId - ID of the run to cancel
   */
  cancel(runId: string): void {
    if (this.activeRuns.has(runId)) {
      this.cancelledRuns.add(runId);
      const run = this.activeRuns.get(runId);
      if (run) {
        run.status = 'cancelled';
      }
    }
  }

  /**
   * Retrieve a pipeline run by its ID (active or from history).
   * @param runId - ID of the run to retrieve
   * @returns The pipeline run, or undefined if not found
   */
  getRun(runId: string): PipelineRun | undefined {
    return this.activeRuns.get(runId) ?? this.deps.history.getRun(runId);
  }

  /**
   * Return all currently active pipeline runs.
   * @returns Array of active pipeline runs
   */
  getActiveRuns(): PipelineRun[] {
    return [...this.activeRuns.values()];
  }

  /**
   * Register an event handler for pipeline events.
   * @param event - The event type to listen for
   * @param handler - The callback function
   */
  on(event: PipelineEvent, handler: PipelineEventHandler): void {
    let eventHandlers = this.handlers.get(event);
    if (!eventHandlers) {
      eventHandlers = new Set();
      this.handlers.set(event, eventHandlers);
    }
    eventHandlers.add(handler);
  }

  /**
   * Unregister an event handler for pipeline events.
   * @param event - The event type to stop listening for
   * @param handler - The callback function to remove
   */
  off(event: PipelineEvent, handler: PipelineEventHandler): void {
    const eventHandlers = this.handlers.get(event);
    if (eventHandlers) {
      eventHandlers.delete(handler);
    }
  }

  private emit(event: PipelineEvent, data: unknown): void {
    const eventHandlers = this.handlers.get(event);
    if (eventHandlers) {
      for (const handler of eventHandlers) {
        handler(event, data);
      }
    }
  }

  private createRun(
    pipeline: PipelineDefinition,
    variables: Record<string, string>,
    triggeredBy: TriggerType
  ): PipelineRun {
    return {
      id: generateId(),
      pipelineId: pipeline.id,
      pipelineName: pipeline.name,
      status: 'queued',
      triggeredBy,
      stepResults: [],
      variables,
      startTime: new Date().toISOString(),
    };
  }
}
