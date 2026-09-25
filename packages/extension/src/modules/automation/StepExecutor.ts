import type { PipelineStep, PipelineStepResult, PipelineStepType } from '@sandforge/shared';
import { extractErrorMessage } from '../../core/common/extractErrorMessage.js';
import { conditionDefect, evaluateCondition } from './ConditionalRouter.js';

/** Runtime context passed to step handlers during execution */
export interface StepContext {
  /**
   * The run's variables: the pipeline's defaults, with the values the run was
   * given over them, and the values the steps before this one handed on.
   */
  variables: Record<string, string>;
  previousResults: PipelineStepResult[];
  pipelineId: string;
  /** The pipeline's name, for a step that tells the user something about the run. */
  pipelineName?: string;
  runId: string;
  /**
   * Aborted when the run is cancelled or outlives its time budget. A step that
   * waits stops waiting then, so a run given up on does not carry on.
   */
  signal?: AbortSignal;
}

/** Function signature for a step handler that executes a specific step type */
export type StepHandler = (step: PipelineStep, context: StepContext) => Promise<PipelineStepResult>;

/**
 * Reads a step's configuration before anything runs, and says what keeps the
 * step from doing its work — or nothing when it can run.
 */
export type StepCheck = (step: PipelineStep) => string | undefined;

/**
 * The longest wait a Delay step accepts: 24 days. A timer holds little more —
 * past 2^31 - 1 ms Node fires it after 1 ms — and a longer delay would report
 * the whole wait having waited for none of it.
 */
const MAX_DELAY_MS = 24 * 24 * 60 * 60 * 1000;

/**
 * The longest timeout a step accepts, the same 24 days: a timeout is a timer
 * too. One set past 2^31 - 1 ms fired after 1 ms, so a step given a month to
 * finish was timed out as it started, and every retry with it. Refused before
 * the run rather than clamped: a clamped timeout would stop a step sooner than
 * its configuration says, and nothing would tell the reader why.
 */
const MAX_TIMEOUT_MS = MAX_DELAY_MS;

/**
 * What a step handler throws when the work it started was cancelled rather
 * than failed: a Backup whose snapshot was cancelled from Live Operations,
 * which is not the run's own cancel. A cancel is not transient, so the step is
 * not tried again: a retry would take the snapshot the person has just
 * stopped. The run ends cancelled with it.
 */
export class StepCancelledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StepCancelledError';
  }
}

/**
 * How one try at a step ended: with the handler's own result, or with the
 * reason it did not give one. `final` marks a try the run itself stopped,
 * which no retry may follow; `cancelled`, a try whose work was cancelled
 * (see {@link StepCancelledError}), which no retry follows either.
 */
type Attempt =
  { result: PipelineStepResult } | { error: string; final: boolean; cancelled?: boolean };

/** What a try settles with when its signal aborts before the handler answers. */
const STOPPED: unique symbol = Symbol('stopped');

/**
 * Creates a successful step result for the given step.
 * @param step - The step that completed
 * @param output - Optional output data
 * @param startTime - ISO string of when the step started
 * @param summary - What the step did, for the run history
 */
function createSuccessResult(
  step: PipelineStep,
  output: Record<string, unknown>,
  startTime: string,
  summary: string,
): PipelineStepResult {
  const endTime = new Date().toISOString();
  return {
    stepId: step.id,
    stepName: step.name,
    stepType: step.type,
    status: 'completed',
    output,
    summary,
    startTime,
    endTime,
    duration: new Date(endTime).getTime() - new Date(startTime).getTime(),
  };
}

/**
 * Creates a failed step result for the given step.
 * @param step - The step that failed
 * @param error - Error message
 * @param startTime - ISO string of when the step started
 */
function createFailureResult(
  step: PipelineStep,
  error: string,
  startTime: string,
): PipelineStepResult {
  const endTime = new Date().toISOString();
  return {
    stepId: step.id,
    stepName: step.name,
    stepType: step.type,
    status: 'failed',
    error,
    startTime,
    endTime,
    duration: new Date(endTime).getTime() - new Date(startTime).getTime(),
  };
}

/** Why a step whose type has no handler is refused. */
function notRunnable(step: PipelineStep): string {
  return `Step "${step.name}" is a ${String(step.type)} step, and this step type cannot run in a pipeline yet.`;
}

/**
 * Why `step`'s timeout cannot be kept, or undefined when it can: a timeout
 * that is not a number, or one longer than a timer holds. A timeout of 0 or
 * less sets no timeout, as it always has.
 */
function timeoutProblem(step: PipelineStep): string | undefined {
  const { timeout } = step;
  if (timeout === undefined) return undefined;
  if (typeof timeout !== 'number' || !Number.isFinite(timeout)) {
    return `Step "${step.name}" has a timeout that is not a number of milliseconds: ${JSON.stringify(timeout)}.`;
  }
  if (timeout > MAX_TIMEOUT_MS) {
    return `Step "${step.name}" has a timeout of ${timeout} ms, longer than a step can be given: set at most 24 days (${MAX_TIMEOUT_MS} ms).`;
  }
  return undefined;
}

/**
 * How long a Delay step waits, in milliseconds, or undefined when it names no
 * usable duration. The Step Config Panel writes `seconds`; `durationMs` is the
 * key the step library declares.
 */
function delayMs(config: Record<string, unknown>): number | undefined {
  const seconds = config['seconds'];
  const ms = seconds === undefined ? config['durationMs'] : seconds;
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return undefined;
  const total = seconds === undefined ? ms : ms * 1000;
  return total <= MAX_DELAY_MS ? total : undefined;
}

/**
 * A Delay step with no duration used to wait 0 ms and report the wait done:
 * the panel writes `seconds` and the handler only read `durationMs`, so every
 * delay configured in the UI was skipped and called complete.
 */
function checkDelay(step: PipelineStep): string | undefined {
  if (step.config['seconds'] === undefined && step.config['durationMs'] === undefined) {
    return `Delay step "${step.name}" has no duration: set how many seconds it waits.`;
  }
  if (delayMs(step.config) === undefined) {
    return `Delay step "${step.name}" has no usable duration: set a number of seconds, from 0 up to 24 days.`;
  }
  return undefined;
}

/**
 * A Condition step with nothing to evaluate used to report its condition met.
 * An operator outside the list evaluated to false, which read as a real answer.
 */
function checkCondition(step: PipelineStep): string | undefined {
  const condition = step.condition;
  if (!condition || typeof condition.field !== 'string' || condition.field.trim() === '') {
    return `Condition step "${step.name}" has no condition to evaluate.`;
  }
  const defect = conditionDefect(condition);
  return defect === undefined ? undefined : `Condition step "${step.name}" ${defect}.`;
}

/**
 * Resolves true once `ms` have passed, or false as soon as `signal` aborts.
 * @param ms - How long to wait
 * @param signal - Stops the wait early when aborted
 */
function wait(ms: number, signal: AbortSignal | undefined): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false);
  return new Promise<boolean>((resolve) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve(false);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve(true);
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Executes individual pipeline steps by dispatching to registered handlers.
 *
 * Only the step types with a handler run. Every other type is refused with the
 * reason, never answered with a success: a pipeline that records "completed"
 * when nothing happened is a history a user trusts and moves on from. Handles
 * timeouts and retry logic.
 */
export class StepExecutor {
  private readonly handlers: Map<PipelineStepType, StepHandler> = new Map();
  private readonly checks: Map<PipelineStepType, StepCheck> = new Map();

  constructor() {
    this.registerDefaults();
  }

  /**
   * Execute a pipeline step within the given context.
   * Applies timeout and retry logic as configured on the step. A step that
   * cannot run fails at once, without retries: nothing about it is transient.
   * Nor is a step whose work was cancelled: its result says it was, and its
   * run ends cancelled. A Backup cancelled from Live Operations used to be
   * tried again, and each retry took a new snapshot.
   *
   * A step's timeout stops the step, not only the wait for it. It used to give
   * up on the step and leave it running: the result said the step had timed
   * out while a Delay went on waiting, and a retry started a second wait beside
   * the first. See {@link attempt}.
   * @param step - The step to execute
   * @param context - Runtime context with variables and previous results
   * @returns The result of executing the step
   */
  async execute(step: PipelineStep, context: StepContext): Promise<PipelineStepResult> {
    const startTime = new Date().toISOString();
    const refusal = this.check(step);
    if (refusal) {
      return createFailureResult(step, refusal, startTime);
    }

    const handler = this.getExecutor(step.type);
    const maxRetries = step.retries ?? 0;
    let lastError = '';

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const outcome = await this.attempt(handler, step, context);
      if ('result' in outcome) {
        return outcome.result;
      }
      if (outcome.cancelled) {
        return { ...createFailureResult(step, outcome.error, startTime), cancelled: true };
      }
      lastError = outcome.error;
      if (outcome.final) {
        break;
      }
    }

    return createFailureResult(step, lastError, startTime);
  }

  /**
   * One try at `step`. The handler runs under a signal of its own, which the
   * run's signal and the step's timeout both abort, and the try ends as soon as
   * that signal aborts, whatever the handler does with it: a handler that
   * ignores its signal cannot hold the run, or the next try, after the step
   * has been given up on. Nothing the try set up — its timer, its listener on
   * the run — outlives it.
   * @param handler - The handler of the step's type
   * @param step - The step to try
   * @param context - The run's context; its signal stops the try
   */
  private async attempt(
    handler: StepHandler,
    step: PipelineStep,
    context: StepContext,
  ): Promise<Attempt> {
    const run = context.signal;
    if (run?.aborted) {
      return { error: `Step "${step.name}" was stopped before it started.`, final: true };
    }

    const stop = new AbortController();
    const stopped = new Promise<typeof STOPPED>((resolve) => {
      stop.signal.addEventListener('abort', () => resolve(STOPPED), { once: true });
    });
    const onRunAbort = (): void => stop.abort();
    run?.addEventListener('abort', onRunAbort, { once: true });

    let timedOut = false;
    const timeout = step.timeout;
    const timer =
      timeout !== undefined && timeout > 0
        ? setTimeout(() => {
            timedOut = true;
            stop.abort();
          }, timeout)
        : undefined;

    try {
      const outcome = await Promise.race([
        handler(step, { ...context, signal: stop.signal }),
        stopped,
      ]);
      if (outcome !== STOPPED) {
        return { result: outcome };
      }
      return timedOut
        ? { error: `Step "${step.name}" timed out after ${timeout} ms.`, final: false }
        : { error: `Step "${step.name}" was stopped before it finished.`, final: true };
    } catch (err) {
      if (err instanceof StepCancelledError) {
        return { error: err.message, final: true, cancelled: true };
      }
      return { error: extractErrorMessage(err), final: false };
    } finally {
      clearTimeout(timer);
      run?.removeEventListener('abort', onRunAbort);
    }
  }

  /**
   * Say why a step cannot do its work, before it runs: its type has no
   * handler, its timeout cannot be kept, or its configuration leaves the
   * handler nothing to do.
   * @param step - The step to check
   * @returns The reason, or undefined when the step can run
   */
  check(step: PipelineStep): string | undefined {
    if (!this.handlers.has(step.type)) {
      return notRunnable(step);
    }
    return timeoutProblem(step) ?? this.checks.get(step.type)?.(step);
  }

  /**
   * Retrieve the handler registered for a specific step type.
   * A type with no handler gets one that refuses the step, so that a caller
   * holding a handler can never turn an unknown type into a success.
   * @param type - The step type to look up
   * @returns The handler function for the step type
   */
  getExecutor(type: PipelineStepType): StepHandler {
    return this.handlers.get(type) ?? this.refusingHandler;
  }

  /**
   * Register a custom handler for a specific step type.
   * Replaces any previously registered handler for that type, and the
   * configuration check that came with it: a replacement reads its own config,
   * and brings the check that reads it, if any.
   * @param type - The step type to register
   * @param handler - The handler function
   * @param check - Says, before the run, what in a step's configuration keeps
   *   the handler from doing its work
   */
  registerHandler(type: PipelineStepType, handler: StepHandler, check?: StepCheck): void {
    this.handlers.set(type, handler);
    if (check) {
      this.checks.set(type, check);
    } else {
      this.checks.delete(type);
    }
  }

  private readonly refusingHandler: StepHandler = async (
    step: PipelineStep,
  ): Promise<PipelineStepResult> =>
    createFailureResult(step, notRunnable(step), new Date().toISOString());

  /**
   * Delay and Condition run wherever a pipeline runs. Backup, Compare,
   * Pre-check and Notification run through the modules that own their work,
   * which the extension registers for its runs (see `pipelineSteps.ts`). The
   * others — every step that writes to an org among them — have no handler,
   * and are refused.
   */
  private registerDefaults(): void {
    this.handlers.set('delay', this.createDelayHandler());
    this.checks.set('delay', checkDelay);
    this.handlers.set('condition', this.createConditionHandler());
    this.checks.set('condition', checkCondition);
  }

  private createDelayHandler(): StepHandler {
    return async (step: PipelineStep, context: StepContext): Promise<PipelineStepResult> => {
      const startTime = new Date().toISOString();
      const durationMs = delayMs(step.config);
      if (durationMs === undefined) {
        return createFailureResult(step, checkDelay(step) ?? 'No usable duration', startTime);
      }

      const waited = await wait(durationMs, context.signal);
      if (!waited) {
        return createFailureResult(
          step,
          `Delay step "${step.name}" was stopped before its ${durationMs} ms wait ended.`,
          startTime,
        );
      }

      return createSuccessResult(
        step,
        { delayed: durationMs },
        startTime,
        `Waited ${durationMs / 1000} s.`,
      );
    };
  }

  private createConditionHandler(): StepHandler {
    return async (step: PipelineStep, context: StepContext): Promise<PipelineStepResult> => {
      const startTime = new Date().toISOString();
      const refusal = checkCondition(step);

      if (refusal || !step.condition) {
        return createFailureResult(step, refusal ?? 'No condition', startTime);
      }

      // Held or not, the answer is the step's work, and the run reads it: a
      // condition that does not hold keeps the steps after it from running.
      // The one evaluation the router makes serves here too, so a Condition
      // step and a condition on any other step cannot answer differently.
      try {
        const conditionMet = evaluateCondition(step.condition, context.variables);
        return createSuccessResult(
          step,
          { conditionMet },
          startTime,
          conditionMet ? 'The condition held.' : 'The condition did not hold.',
        );
      } catch (err) {
        return createFailureResult(
          step,
          `Condition step "${step.name}" could not be evaluated: ${extractErrorMessage(err)}.`,
          startTime,
        );
      }
    };
  }
}
