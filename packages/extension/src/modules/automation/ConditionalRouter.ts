import type {
  PipelineCondition,
  PipelineStep,
  PipelineStepResult,
} from '@sandforge/shared';

/**
 * Routes pipeline execution based on conditions and step results.
 * Evaluates individual conditions against a context, handles logical
 * grouping (and/or), and determines the next step in the pipeline
 * based on success or failure outcomes.
 */
export class ConditionalRouter {
  /**
   * Evaluate a single condition against a context of key-value pairs.
   * Supports all 11 condition operators.
   * @param condition - The condition to evaluate
   * @param context - Key-value context to resolve field references
   * @returns true if the condition is satisfied
   */
  evaluate(
    condition: PipelineCondition,
    context: Record<string, unknown>
  ): boolean {
    const fieldValue = context[condition.field];

    switch (condition.operator) {
      case 'eq':
        return fieldValue === condition.value;
      case 'neq':
        return fieldValue !== condition.value;
      case 'gt':
        return Number(fieldValue) > Number(condition.value);
      case 'gte':
        return Number(fieldValue) >= Number(condition.value);
      case 'lt':
        return Number(fieldValue) < Number(condition.value);
      case 'lte':
        return Number(fieldValue) <= Number(condition.value);
      case 'contains':
        return String(fieldValue ?? '').includes(String(condition.value));
      case 'not_contains':
        return !String(fieldValue ?? '').includes(String(condition.value));
      case 'matches': {
        try {
          return new RegExp(String(condition.value)).test(
            String(fieldValue ?? '')
          );
        } catch {
          return false;
        }
      }
      case 'is_empty':
        return (
          fieldValue === undefined ||
          fieldValue === null ||
          fieldValue === ''
        );
      case 'is_not_empty':
        return (
          fieldValue !== undefined &&
          fieldValue !== null &&
          fieldValue !== ''
        );
    }
  }

  /**
   * Evaluate a group of conditions using logical AND or OR.
   * Conditions without a logicalGroup default to 'and'.
   * @param conditions - Array of conditions to evaluate together
   * @param context - Key-value context to resolve field references
   * @returns true if the combined conditions are satisfied
   */
  evaluateGroup(
    conditions: PipelineCondition[],
    context: Record<string, unknown>
  ): boolean {
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
   * Returns the onSuccess or onFailure target step ID.
   * @param step - The step that was just executed
   * @param result - The execution result of that step
   * @returns The ID of the next step, or undefined if no branching is configured
   */
  getNextStep(
    step: PipelineStep,
    result: PipelineStepResult
  ): string | undefined {
    if (result.status === 'completed') {
      return step.onSuccess;
    }
    if (result.status === 'failed') {
      return step.onFailure;
    }
    return undefined;
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
  findBranch(
    steps: PipelineStep[],
    fromStepId: string,
    success: boolean
  ): PipelineStep[] {
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
