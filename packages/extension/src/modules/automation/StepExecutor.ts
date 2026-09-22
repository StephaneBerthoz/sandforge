import type {
  ConditionOperator,
  PipelineStep,
  PipelineStepResult,
  PipelineStepType,
} from '@sandforge/shared';
import { extractErrorMessage } from '../../core/common/extractErrorMessage.js';

/** Runtime context passed to step handlers during execution */
export interface StepContext {
  variables: Record<string, string>;
  previousResults: PipelineStepResult[];
  pipelineId: string;
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
type StepCheck = (step: PipelineStep) => string | undefined;

/**
 * The longest wait a Delay step accepts: 24 days. A timer holds little more —
 * past 2^31 - 1 ms Node fires it after 1 ms — and a longer delay would report
 * the whole wait having waited for none of it.
 */
const MAX_DELAY_MS = 24 * 24 * 60 * 60 * 1000;

/** Every operator a condition can name; any other one would quietly evaluate to false. */
const CONDITION_OPERATORS: ReadonlySet<string> = new Set<ConditionOperator>([
  'eq',
  'neq',
  'gt',
  'gte',
  'lt',
  'lte',
  'contains',
  'not_contains',
  'matches',
  'is_empty',
  'is_not_empty',
]);

/**
 * Creates a successful step result for the given step.
 * @param step - The step that completed
 * @param output - Optional output data
 * @param startTime - ISO string of when the step started
 */
function createSuccessResult(
  step: PipelineStep,
  output: Record<string, unknown>,
  startTime: string,
): PipelineStepResult {
  const endTime = new Date().toISOString();
  return {
    stepId: step.id,
    stepName: step.name,
    stepType: step.type,
    status: 'completed',
    output,
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
  if (!CONDITION_OPERATORS.has(condition.operator)) {
    return `Condition step "${step.name}" uses an unknown operator: ${String(condition.operator)}.`;
  }
  return undefined;
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
   * @param step - The step to execute
   * @param context - Runtime context with variables and previous results
   * @returns The result of executing the step
   */
  async execute(step: PipelineStep, context: StepContext): Promise<PipelineStepResult> {
    const refusal = this.check(step);
    if (refusal) {
      return createFailureResult(step, refusal, new Date().toISOString());
    }

    const handler = this.getExecutor(step.type);
    const maxRetries = step.retries ?? 0;
    let lastError = '';

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const resultPromise = handler(step, context);

        if (step.timeout && step.timeout > 0) {
          const timeoutPromise = new Promise<PipelineStepResult>((_, reject) => {
            setTimeout(() => reject(new Error('Step execution timed out')), step.timeout);
          });
          return await Promise.race([resultPromise, timeoutPromise]);
        }

        return await resultPromise;
      } catch (err) {
        lastError = extractErrorMessage(err);
        if (attempt === maxRetries) {
          return createFailureResult(step, lastError, new Date().toISOString());
        }
      }
    }

    return createFailureResult(step, lastError, new Date().toISOString());
  }

  /**
   * Say why a step cannot do its work, before it runs: its type has no
   * handler, or its configuration leaves the handler nothing to do.
   * @param step - The step to check
   * @returns The reason, or undefined when the step can run
   */
  check(step: PipelineStep): string | undefined {
    if (!this.handlers.has(step.type)) {
      return notRunnable(step);
    }
    return this.checks.get(step.type)?.(step);
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
   * configuration check that came with it: a replacement reads its own config.
   * @param type - The step type to register
   * @param handler - The handler function
   */
  registerHandler(type: PipelineStepType, handler: StepHandler): void {
    this.handlers.set(type, handler);
    this.checks.delete(type);
  }

  private readonly refusingHandler: StepHandler = async (
    step: PipelineStep,
  ): Promise<PipelineStepResult> =>
    createFailureResult(step, notRunnable(step), new Date().toISOString());

  /**
   * Delay and Condition are the only step types that run. The other thirteen —
   * the data steps above all — have no handler here, and are refused.
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

      return createSuccessResult(step, { delayed: durationMs }, startTime);
    };
  }

  private createConditionHandler(): StepHandler {
    return async (step: PipelineStep, context: StepContext): Promise<PipelineStepResult> => {
      const startTime = new Date().toISOString();
      const refusal = checkCondition(step);

      if (refusal || !step.condition) {
        return createFailureResult(step, refusal ?? 'No condition', startTime);
      }

      const fieldValue = context.variables[step.condition.field];
      const conditionMet = this.evaluateSimpleCondition(
        fieldValue,
        step.condition.operator,
        step.condition.value,
      );

      return createSuccessResult(step, { conditionMet }, startTime);
    };
  }

  private evaluateSimpleCondition(
    actual: string | undefined,
    operator: string,
    expected: string | number | boolean,
  ): boolean {
    const actualStr = actual ?? '';
    const expectedStr = String(expected);

    switch (operator) {
      case 'eq':
        return actualStr === expectedStr;
      case 'neq':
        return actualStr !== expectedStr;
      case 'contains':
        return actualStr.includes(expectedStr);
      case 'not_contains':
        return !actualStr.includes(expectedStr);
      case 'is_empty':
        return actualStr === '';
      case 'is_not_empty':
        return actualStr !== '';
      case 'gt':
        return Number(actualStr) > Number(expectedStr);
      case 'gte':
        return Number(actualStr) >= Number(expectedStr);
      case 'lt':
        return Number(actualStr) < Number(expectedStr);
      case 'lte':
        return Number(actualStr) <= Number(expectedStr);
      case 'matches': {
        try {
          return new RegExp(expectedStr).test(actualStr);
        } catch {
          return false;
        }
      }
      default:
        return false;
    }
  }
}
