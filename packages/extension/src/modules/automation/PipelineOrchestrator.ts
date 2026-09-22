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
export type PipelineEvent = 'started' | 'stepCompleted' | 'completed' | 'failed';

/** Handler function for pipeline events */
export type PipelineEventHandler = (event: PipelineEvent, data: unknown) => void;

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
   * Injected cross-cutting adapters (telemetry, storage, fs).
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
  private readonly aborters: Map<string, AbortController> = new Map();

  constructor(deps: PipelineOrchestratorDependencies) {
    this.deps = deps;
  }

  /**
   * Execute a pipeline definition with the given variables.
   * Runs all steps sequentially, respects conditional routing,
   * and records the run in history upon completion.
   *
   * A pipeline with a step that cannot do its work does not start: see
   * {@link refuseUnrunnable}.
   * @param pipeline - The pipeline definition to execute
   * @param variables - Runtime variables for the execution
   * @param triggeredBy - What triggered this execution
   * @param signal - Stops the run when aborted, the step in progress included:
   *   a caller that has given up on the run (its time budget spent) must not
   *   leave the steps after it running unobserved.
   * @returns The completed pipeline run
   */
  async execute(
    pipeline: PipelineDefinition,
    variables: Record<string, string>,
    triggeredBy: TriggerType,
    signal?: AbortSignal,
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

    const refused = this.refuseUnrunnable(pipeline, variables, triggeredBy);
    if (refused) {
      return refused;
    }

    const run = this.createRun(pipeline, variables, triggeredBy);
    run.status = 'running';
    this.activeRuns.set(run.id, run);

    const aborter = new AbortController();
    const abort = (): void => aborter.abort();
    if (signal?.aborted) aborter.abort();
    signal?.addEventListener('abort', abort, { once: true });
    this.aborters.set(run.id, aborter);

    this.emit('started', { runId: run.id, pipelineId: pipeline.id });

    let hasFailures = false;

    for (const step of pipeline.steps) {
      if (this.cancelledRuns.has(run.id) || aborter.signal.aborted) {
        run.status = 'cancelled';
        break;
      }

      if (this.pausedRuns.has(run.id)) {
        run.status = 'paused';
        break;
      }

      if (step.condition) {
        const conditionContext: Record<string, unknown> = { ...variables };
        const conditionMet = this.deps.conditionalRouter.evaluate(step.condition, conditionContext);
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
        signal: aborter.signal,
      });

      run.stepResults.push(result);
      this.emit('stepCompleted', { runId: run.id, stepResult: result });

      // A step cut short by the abort failed because the run was stopped, not
      // on its own: the run is cancelled, and nothing is routed from it.
      if (aborter.signal.aborted) {
        run.status = 'cancelled';
        break;
      }

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
            signal: aborter.signal,
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
    run.duration = new Date(run.endTime).getTime() - new Date(run.startTime).getTime();

    signal?.removeEventListener('abort', abort);
    this.aborters.delete(run.id);
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
   * Cancel a currently running or paused pipeline. The step in progress is
   * stopped too: a Delay stops waiting rather than running to its end first.
   * @param runId - ID of the run to cancel
   */
  cancel(runId: string): void {
    if (this.activeRuns.has(runId)) {
      this.cancelledRuns.add(runId);
      this.aborters.get(runId)?.abort();
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

  /**
   * Refuse, before any step runs, a pipeline one of whose steps cannot do its
   * work — a type with no handler, or a configuration its handler cannot act
   * on. Running the steps before it would leave the pipeline half done, and
   * `continueOnError` would walk past the refused step to a run recorded as a
   * success.
   *
   * The run is recorded failed, with one failed result per refused step and
   * no result for the others, which never ran.
   * @returns The refused run, or undefined when every step can run
   */
  private refuseUnrunnable(
    pipeline: PipelineDefinition,
    variables: Record<string, string>,
    triggeredBy: TriggerType,
  ): PipelineRun | undefined {
    const refusals = pipeline.steps.flatMap((step) => {
      const reason = this.deps.stepExecutor.check(step);
      return reason === undefined ? [] : [{ step, reason }];
    });
    if (refusals.length === 0) {
      return undefined;
    }

    const run = this.createRun(pipeline, variables, triggeredBy);
    run.status = 'failed';
    run.stepResults = refusals.map(({ step, reason }) => ({
      stepId: step.id,
      stepName: step.name,
      stepType: step.type,
      status: 'failed',
      error: reason,
    }));
    run.error = `Pipeline did not start: ${refusals.map(({ reason }) => reason).join(' ')}`;
    run.endTime = new Date().toISOString();
    run.duration = new Date(run.endTime).getTime() - new Date(run.startTime).getTime();

    this.deps.history.record(run);
    this.emit('failed', { runId: run.id, error: run.error });
    return run;
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
    triggeredBy: TriggerType,
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
