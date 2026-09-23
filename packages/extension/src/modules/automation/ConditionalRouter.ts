import type { PipelineCondition, PipelineStep, PipelineStepResult } from '@sandforge/shared';
import { conditionDefect, evaluateCondition } from '@sandforge/shared';

/**
 * A condition is read the same way here and on the Automation page, which
 * says before Run is pressed whether a Condition step can run: both read the
 * one implementation in the shared package.
 */
export { conditionDefect, evaluateCondition };

/** Whether `result` is a Condition step's answer that its condition does not hold. */
function conditionFailed(step: PipelineStep, result: PipelineStepResult): boolean {
  return (
    step.type === 'condition' &&
    result.status === 'completed' &&
    result.output?.['conditionMet'] === false
  );
}

/**
 * Routes pipeline execution based on conditions and step results.
 * Evaluates individual conditions against a context, handles logical
 * grouping (and/or), and determines the next step in the pipeline
 * based on success or failure outcomes.
 */
export class ConditionalRouter {
  /**
   * Evaluate a single condition against a context of key-value pairs.
   * Supports all 11 condition operators; see {@link evaluateCondition}.
   * @param condition - The condition to evaluate
   * @param context - Key-value context to resolve field references
   * @returns true if the condition is satisfied
   * @throws When the condition has no answer for this context
   */
  evaluate(condition: PipelineCondition, context: Record<string, unknown>): boolean {
    return evaluateCondition(condition, context);
  }

  /**
   * Say what keeps a condition from being evaluated, before any run asks it.
   * @param condition - The condition to check
   * @returns The reason, written to follow "the condition", or undefined
   */
  check(condition: PipelineCondition | undefined): string | undefined {
    return conditionDefect(condition);
  }

  /**
   * Evaluate a group of conditions using logical AND or OR.
   * Conditions without a logicalGroup default to 'and'.
   * @param conditions - Array of conditions to evaluate together
   * @param context - Key-value context to resolve field references
   * @returns true if the combined conditions are satisfied
   */
  evaluateGroup(conditions: PipelineCondition[], context: Record<string, unknown>): boolean {
    if (conditions.length === 0) {
      return true;
    }

    const hasOrGroup = conditions.some((c) => c.logicalGroup === 'or');

    if (hasOrGroup) {
      return conditions.some((c) => this.evaluate(c, context));
    }

    return conditions.every((c) => this.evaluate(c, context));
  }

  /**
   * Determine the next step ID based on a step result's success or failure.
   * Returns the onSuccess or onFailure target step ID. A Condition step
   * succeeds when its condition holds: one that does not hold goes to its
   * onFailure step.
   * @param step - The step that was just executed
   * @param result - The execution result of that step
   * @returns The ID of the next step, or undefined if no branching is configured
   */
  getNextStep(step: PipelineStep, result: PipelineStepResult): string | undefined {
    if (result.status === 'completed') {
      return conditionFailed(step, result) ? step.onFailure : step.onSuccess;
    }
    if (result.status === 'failed') {
      return step.onFailure;
    }
    return undefined;
  }

  /**
   * Whether the run ends after `step`: a Condition step whose condition does
   * not hold, and that names no onFailure step to go to instead, holds back
   * every step after it. That is what the step is for, and it used to hold
   * back nothing: the answer was recorded and the next step ran regardless.
   * @param step - The step that was just executed
   * @param result - The execution result of that step
   */
  endsRun(step: PipelineStep, result: PipelineStepResult): boolean {
    return conditionFailed(step, result) && !step.onFailure;
  }

  /**
   * Find the chain of steps following a branch (success or failure path)
   * starting from a given step. Follows onSuccess or onFailure links until
   * no further link is found.
   * @param steps - All steps in the pipeline
   * @param fromStepId - The starting step ID
   * @param success - true to follow onSuccess, false to follow onFailure
   * @returns Array of steps along the branch path
   */
  findBranch(steps: PipelineStep[], fromStepId: string, success: boolean): PipelineStep[] {
    const stepMap = new Map(steps.map((s) => [s.id, s]));
    const branch: PipelineStep[] = [];
    const visited = new Set<string>();

    let currentId: string | undefined = fromStepId;
    const startStep = stepMap.get(currentId);
    if (!startStep) {
      return branch;
    }

    currentId = success ? startStep.onSuccess : startStep.onFailure;

    while (currentId && !visited.has(currentId)) {
      visited.add(currentId);
      const step = stepMap.get(currentId);
      if (!step) {
        break;
      }
      branch.push(step);
      currentId = success ? step.onSuccess : step.onFailure;
    }

    return branch;
  }
}
