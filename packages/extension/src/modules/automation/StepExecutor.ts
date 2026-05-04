import type { PipelineStep, PipelineStepResult, PipelineStepType } from '@sandforge/shared';
import { extractErrorMessage } from '../../core/common/extractErrorMessage.js';

/** Runtime context passed to step handlers during execution */
export interface StepContext {
  variables: Record<string, string>;
  previousResults: PipelineStepResult[];
  pipelineId: string;
  runId: string;
}

/** Function signature for a step handler that executes a specific step type */
export type StepHandler = (step: PipelineStep, context: StepContext) => Promise<PipelineStepResult>;

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

/**
 * Executes individual pipeline steps by dispatching to registered handlers.
 * Provides a default handler for each step type and supports custom handler
 * registration. Handles timeouts and retry logic.
 */
export class StepExecutor {
  private readonly handlers: Map<PipelineStepType, StepHandler> = new Map();

  constructor() {
    this.registerDefaults();
  }

  /**
   * Execute a pipeline step within the given context.
   * Applies timeout and retry logic as configured on the step.
   * @param step - The step to execute
   * @param context - Runtime context with variables and previous results
   * @returns The result of executing the step
   */
  async execute(step: PipelineStep, context: StepContext): Promise<PipelineStepResult> {
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
   * Retrieve the handler registered for a specific step type.
   * Falls back to a default pass-through handler if none is registered.
   * @param type - The step type to look up
   * @returns The handler function for the step type
   */
  getExecutor(type: PipelineStepType): StepHandler {
    const handler = this.handlers.get(type);
    if (handler) {
      return handler;
    }
    return this.defaultHandler;
  }

  /**
   * Register a custom handler for a specific step type.
   * Replaces any previously registered handler for that type.
   * @param type - The step type to register
   * @param handler - The handler function
   */
  registerHandler(type: PipelineStepType, handler: StepHandler): void {
    this.handlers.set(type, handler);
  }

  private readonly defaultHandler: StepHandler = async (
    step: PipelineStep,
  ): Promise<PipelineStepResult> => {
    const startTime = new Date().toISOString();
    return createSuccessResult(step, { message: `Step "${step.name}" completed` }, startTime);
  };

  private registerDefaults(): void {
    const passThrough: PipelineStepType[] = [
      'seed',
      'sync',
      'backup',
      'restore',
      'anonymize',
      'delete',
      'compare',
      'precheck',
      'script',
      'notification',
      'approval',
      'loop',
      'parallel',
    ];

    for (const type of passThrough) {
      this.handlers.set(type, this.defaultHandler);
    }

    this.handlers.set('delay', this.createDelayHandler());
    this.handlers.set('condition', this.createConditionHandler());
  }

  private createDelayHandler(): StepHandler {
    return async (step: PipelineStep): Promise<PipelineStepResult> => {
      const startTime = new Date().toISOString();
      const durationMs =
        typeof step.config['durationMs'] === 'number' ? step.config['durationMs'] : 0;

      await new Promise<void>((resolve) => setTimeout(resolve, durationMs));

      return createSuccessResult(step, { delayed: durationMs }, startTime);
    };
  }

  private createConditionHandler(): StepHandler {
    return async (step: PipelineStep, context: StepContext): Promise<PipelineStepResult> => {
      const startTime = new Date().toISOString();

      if (!step.condition) {
        return createSuccessResult(step, { conditionMet: true }, startTime);
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
