import type {
  PipelineDefinition,
  PipelineRun,
  PipelineStep,
  PipelineStepResult,
  TriggerType,
} from '@sandforge/shared';
import type { PipelineBuilder } from './PipelineBuilder';
import type { TriggerEngine } from './TriggerEngine';
import type { StepLibrary } from './StepLibrary';
import type { StepExecutor } from './StepExecutor';
import type { ConditionalRouter } from './ConditionalRouter';
import type { PipelineHistory } from './PipelineHistory';
import type { CoreServices } from '../../services.js';
import { extractErrorMessage } from '../../core/common/extractErrorMessage.js';

/** Events emitted by the PipelineOrchestrator */
export type PipelineEvent = 'started' | 'stepCompleted' | 'completed' | 'failed';

/** Handler function for pipeline events */
export type PipelineEventHandler = (event: PipelineEvent, data: unknown) => void;

/** Dependencies required by the PipelineOrchestrator */
export interface PipelineOrchestratorDependencies {
  builder: PipelineBuilder;
  triggerEngine: TriggerEngine;
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
 * The result of a step the run passed over: its condition did not hold, a
 * route jumped past it, or a Condition step before it held it back.
 */
function skipped(step: PipelineStep): PipelineStepResult {
  return { stepId: step.id, stepName: step.name, stepType: step.type, status: 'skipped' };
}

/**
 * The values a run's steps and conditions read: every variable the pipeline
 * declares, at its default, with the values the run was started with laid
 * over them. The declared variables used to be read by nothing, so a condition
 * on one found it unset whatever its default said.
 */
function runVariables(
  pipeline: PipelineDefinition,
  supplied: Record<string, string>,
): Record<string, string> {
  const defaults: Record<string, string> = {};
  for (const variable of pipeline.variables) {
    if (variable.defaultValue !== undefined) {
      defaults[variable.name] = variable.defaultValue;
    }
  }
  return { ...defaults, ...supplied };
}

/**
 * What is wrong with where `step` routes, or undefined when nothing is. A run
 * takes each step once, in order, and a route only skips ahead: the steps it
 * jumps over are passed over. A route back to an earlier step, or to the step
 * itself, would take a step again.
 * @param step - The step whose routes are checked
 * @param index - Where `step` sits in `steps`
 * @param steps - Every step of the pipeline, in order
 */
function routeProblem(
  step: PipelineStep,
  index: number,
  steps: readonly PipelineStep[],
): string | undefined {
  const routes = [
    ['success', step.onSuccess],
    ['failure', step.onFailure],
  ] as const;
  for (const [outcome, target] of routes) {
    if (!target) continue;
    const at = steps.findIndex((candidate) => candidate.id === target);
    if (at > index) continue;
    const where =
      at === -1
        ? `"${target}", which is not a step of this pipeline`
        : `"${steps[at].name}", which does not come after it`;
    return `Step "${step.name}" routes on ${outcome} to ${where}: a route can only skip ahead.`;
  }
  return undefined;
}

/**
 * Top-level orchestrator that coordinates all pipeline automation services.
 * Manages the full lifecycle of pipeline execution including step sequencing,
 * conditional routing, cancellation, and history recording.
 *
 * A run cannot be paused. It could be asked to once: the run then stopped
 * where it was and was recorded as paused, and nothing ever took it up again.
 */
export class PipelineOrchestrator {
  private readonly deps: PipelineOrchestratorDependencies;
  private readonly activeRuns: Map<string, PipelineRun> = new Map();
  private readonly handlers: Map<PipelineEvent, Set<PipelineEventHandler>> = new Map();
  private readonly cancelledRuns: Set<string> = new Set();
  private readonly aborters: Map<string, AbortController> = new Map();

  constructor(deps: PipelineOrchestratorDependencies) {
    this.deps = deps;
  }

  /**
   * Execute a pipeline definition with the given variables.
   * Runs the steps in order, each at most once, and records the run in
   * history upon completion.
   *
   * - A step carrying a condition runs only when the condition holds, and is
   *   passed over otherwise.
   * - A Condition step records its answer. One that does not hold ends the
   *   run there, every later step passed over, unless it names an onFailure
   *   step to go on from.
   * - A step that names an onSuccess or onFailure step for its outcome jumps
   *   to it, and the steps in between are passed over. The target used to run
   *   twice: once when routed to, and again when its turn came.
   *
   * A pipeline with a step that cannot do its work does not start: see
   * {@link refuseUnrunnable}.
   * @param pipeline - The pipeline definition to execute
   * @param variables - Values for this run, laid over the defaults of the
   *   variables the pipeline declares
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

    const values = runVariables(pipeline, variables);
    const { steps } = pipeline;
    const router = this.deps.conditionalRouter;
    let hasFailures = false;
    let index = 0;

    while (index < steps.length) {
      if (this.cancelledRuns.has(run.id) || aborter.signal.aborted) {
        run.status = 'cancelled';
        break;
      }

      const step = steps[index];
      const result = await this.runStep(step, run, values, aborter.signal);
      run.stepResults.push(result);
      if (result.status === 'skipped') {
        index += 1;
        continue;
      }
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

      // The run goes on from the step a route names, or from the next one; a
      // Condition that does not hold, with nowhere to go, ends it. Whatever is
      // jumped over is passed over, never run later in its turn.
      let next = index + 1;
      if (router.endsRun(step, result)) {
        next = steps.length;
      } else {
        // refuseUnrunnable has made sure a route only points ahead.
        const target = router.getNextStep(step, result);
        const at = target ? steps.findIndex((s, i) => i > index && s.id === target) : -1;
        if (at !== -1) next = at;
      }
      for (const passed of steps.slice(index + 1, next)) {
        run.stepResults.push(skipped(passed));
      }
      index = next;
    }

    if (run.status === 'running') {
      run.status = hasFailures ? 'completed_with_warnings' : 'completed';
    }

    run.endTime = new Date().toISOString();
    run.duration = new Date(run.endTime).getTime() - new Date(run.startTime).getTime();

    signal?.removeEventListener('abort', abort);
    this.aborters.delete(run.id);
    this.activeRuns.delete(run.id);
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
   * Cancel a currently running pipeline. The step in progress is stopped too:
   * a Delay stops waiting rather than running to its end first.
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
   * Run `step`, or pass it over when it carries a condition that does not
   * hold. A Condition step is not held back by its own condition: evaluating
   * it is the step's work, and its answer is recorded either way. It used to
   * be passed over whenever the answer was no, as if nothing had been asked.
   *
   * A condition with no answer for this run fails the step it guards, with
   * the reason, rather than passing it over as if the answer were no.
   * @param step - The step to run
   * @param run - The run it belongs to
   * @param values - The run's variables, defaults included
   * @param signal - Stops the step when the run is stopped
   */
  private async runStep(
    step: PipelineStep,
    run: PipelineRun,
    values: Record<string, string>,
    signal: AbortSignal,
  ): Promise<PipelineStepResult> {
    if (step.condition && step.type !== 'condition') {
      let holds: boolean;
      try {
        holds = this.deps.conditionalRouter.evaluate(step.condition, values);
      } catch (err) {
        return {
          stepId: step.id,
          stepName: step.name,
          stepType: step.type,
          status: 'failed',
          error: `Step "${step.name}" did not run: its condition could not be evaluated, as ${extractErrorMessage(err)}.`,
        };
      }
      if (!holds) {
        return skipped(step);
      }
    }

    return this.deps.stepExecutor.execute(step, {
      variables: values,
      previousResults: run.stepResults,
      pipelineId: run.pipelineId,
      runId: run.id,
      signal,
    });
  }

  /**
   * Refuse, before any step runs, a pipeline one of whose steps cannot do its
   * work — a type with no handler, a configuration its handler cannot act on,
   * a condition that cannot be evaluated, or a route that does not point
   * ahead. Running the steps before it would leave the pipeline half done,
   * and `continueOnError` would walk past the refused step to a run recorded
   * as a success.
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
    const refusals = pipeline.steps.flatMap((step, index) => {
      const reason =
        this.deps.stepExecutor.check(step) ??
        this.conditionProblem(step) ??
        routeProblem(step, index, pipeline.steps);
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

  /**
   * Why the condition `step` runs under cannot be evaluated, or undefined when
   * it can or there is none. A Condition step's own condition is its
   * configuration, which the step executor checks.
   */
  private conditionProblem(step: PipelineStep): string | undefined {
    if (!step.condition || step.type === 'condition') {
      return undefined;
    }
    const defect = this.deps.conditionalRouter.check(step.condition);
    return defect === undefined
      ? undefined
      : `Step "${step.name}" runs only when its condition holds, and the condition ${defect}.`;
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
