import type {
  PipelineDefinition,
  PipelineStep,
  PipelineTrigger,
  PipelineVariable,
} from '@sandforge/shared';

/**
 * Generates a RFC4122 v4 UUID via the platform crypto primitive.
 * Used internally to assign unique identifiers to pipeline entities.
 */
function generateId(): string {
  return globalThis.crypto.randomUUID();
}

/**
 * Builds and manipulates PipelineDefinition instances.
 * Provides immutable-style operations — every method returns a new definition
 * rather than mutating the input.
 */
export class PipelineBuilder {
  /**
   * Create a new empty pipeline definition with the given name and description.
   * @param name - Human-readable name for the pipeline
   * @param description - Detailed description of the pipeline purpose
   * @returns A fresh PipelineDefinition with a generated ID
   */
  create(name: string, description: string): PipelineDefinition {
    const now = new Date().toISOString();
    return {
      id: generateId(),
      name,
      description,
      version: 1,
      steps: [],
      triggers: [],
      variables: [],
      tags: [],
      createdAt: now,
      updatedAt: now,
    };
  }

  /**
   * Add a step to the pipeline and return the updated definition.
   * @param pipeline - The pipeline to add the step to
   * @param step - Step definition without an ID (one will be generated)
   * @returns Updated pipeline with the new step appended
   */
  addStep(
    pipeline: PipelineDefinition,
    step: Omit<PipelineStep, 'id'>
  ): PipelineDefinition {
    const newStep: PipelineStep = { ...step, id: generateId() };
    return {
      ...pipeline,
      steps: [...pipeline.steps, newStep],
      updatedAt: new Date().toISOString(),
    };
  }

  /**
   * Remove a step from the pipeline by its ID.
   * @param pipeline - The pipeline to remove the step from
   * @param stepId - ID of the step to remove
   * @returns Updated pipeline without the specified step
   */
  removeStep(pipeline: PipelineDefinition, stepId: string): PipelineDefinition {
    return {
      ...pipeline,
      steps: pipeline.steps.filter((s) => s.id !== stepId),
      updatedAt: new Date().toISOString(),
    };
  }

  /**
   * Move a step to a new position within the pipeline.
   * @param pipeline - The pipeline to reorder
   * @param stepId - ID of the step to move
   * @param newIndex - Zero-based target index
   * @returns Updated pipeline with the step at the new position
   */
  moveStep(
    pipeline: PipelineDefinition,
    stepId: string,
    newIndex: number
  ): PipelineDefinition {
    const steps = [...pipeline.steps];
    const currentIndex = steps.findIndex((s) => s.id === stepId);
    if (currentIndex === -1) {
      return pipeline;
    }
    const [step] = steps.splice(currentIndex, 1);
    const clampedIndex = Math.max(0, Math.min(newIndex, steps.length));
    steps.splice(clampedIndex, 0, step);
    return {
      ...pipeline,
      steps,
      updatedAt: new Date().toISOString(),
    };
  }

  /**
   * Add a trigger to the pipeline and return the updated definition.
   * @param pipeline - The pipeline to add the trigger to
   * @param trigger - Trigger definition without an ID (one will be generated)
   * @returns Updated pipeline with the new trigger appended
   */
  addTrigger(
    pipeline: PipelineDefinition,
    trigger: Omit<PipelineTrigger, 'id'>
  ): PipelineDefinition {
    const newTrigger: PipelineTrigger = { ...trigger, id: generateId() };
    return {
      ...pipeline,
      triggers: [...pipeline.triggers, newTrigger],
      updatedAt: new Date().toISOString(),
    };
  }

  /**
   * Remove a trigger from the pipeline by its ID.
   * @param pipeline - The pipeline to remove the trigger from
   * @param triggerId - ID of the trigger to remove
   * @returns Updated pipeline without the specified trigger
   */
  removeTrigger(
    pipeline: PipelineDefinition,
    triggerId: string
  ): PipelineDefinition {
    return {
      ...pipeline,
      triggers: pipeline.triggers.filter((t) => t.id !== triggerId),
      updatedAt: new Date().toISOString(),
    };
  }

  /**
   * Add a variable to the pipeline and return the updated definition.
   * @param pipeline - The pipeline to add the variable to
   * @param variable - Variable definition
   * @returns Updated pipeline with the new variable appended
   */
  addVariable(
    pipeline: PipelineDefinition,
    variable: PipelineVariable
  ): PipelineDefinition {
    return {
      ...pipeline,
      variables: [...pipeline.variables, variable],
      updatedAt: new Date().toISOString(),
    };
  }

  /**
   * Validate a pipeline definition and return an array of error messages.
   * An empty array indicates the pipeline is valid.
   * @param pipeline - The pipeline to validate
   * @returns Array of validation error strings (empty if valid)
   */
  validate(pipeline: PipelineDefinition): string[] {
    const errors: string[] = [];

    if (!pipeline.name.trim()) {
      errors.push('Pipeline name is required');
    }

    if (pipeline.steps.length === 0) {
      errors.push('Pipeline must have at least one step');
    }

    const stepIds = new Set<string>();
    for (const step of pipeline.steps) {
      if (stepIds.has(step.id)) {
        errors.push(`Duplicate step ID: ${step.id}`);
      }
      stepIds.add(step.id);

      if (!step.name.trim()) {
        errors.push(`Step must have a name (step ID: ${step.id})`);
      }

      if (step.onSuccess && !stepIds.has(step.onSuccess) && !pipeline.steps.some((s) => s.id === step.onSuccess)) {
        errors.push(`Step "${step.name}" references non-existent onSuccess step: ${step.onSuccess}`);
      }

      if (step.onFailure && !stepIds.has(step.onFailure) && !pipeline.steps.some((s) => s.id === step.onFailure)) {
        errors.push(`Step "${step.name}" references non-existent onFailure step: ${step.onFailure}`);
      }
    }

    for (const variable of pipeline.variables) {
      if (!variable.name.trim()) {
        errors.push('Variable must have a name');
      }
      if (variable.required && variable.defaultValue === undefined) {
        errors.push(`Required variable "${variable.name}" must have a default value`);
      }
    }

    const triggerIds = new Set<string>();
    for (const trigger of pipeline.triggers) {
      if (triggerIds.has(trigger.id)) {
        errors.push(`Duplicate trigger ID: ${trigger.id}`);
      }
      triggerIds.add(trigger.id);

      if (trigger.type === 'schedule' && !trigger.config.cron) {
        errors.push(`Schedule trigger "${trigger.id}" requires a cron expression`);
      }
    }

    return errors;
  }

  /**
   * Deep clone a pipeline, generating new IDs for the pipeline, all steps,
   * and all triggers to guarantee uniqueness.
   * @param pipeline - The pipeline to clone
   * @returns A new pipeline with fresh IDs
   */
  clone(pipeline: PipelineDefinition): PipelineDefinition {
    const now = new Date().toISOString();
    const stepIdMap = new Map<string, string>();

    for (const step of pipeline.steps) {
      stepIdMap.set(step.id, generateId());
    }

    const clonedSteps: PipelineStep[] = pipeline.steps.map((step) => ({
      ...step,
      id: stepIdMap.get(step.id) as string,
      config: { ...step.config },
      condition: step.condition ? { ...step.condition } : undefined,
      onSuccess: step.onSuccess ? stepIdMap.get(step.onSuccess) : undefined,
      onFailure: step.onFailure ? stepIdMap.get(step.onFailure) : undefined,
    }));

    const clonedTriggers: PipelineTrigger[] = pipeline.triggers.map((t) => ({
      ...t,
      id: generateId(),
      config: { ...t.config },
    }));

    const clonedVariables: PipelineVariable[] = pipeline.variables.map((v) => ({
      ...v,
    }));

    return {
      ...pipeline,
      id: generateId(),
      steps: clonedSteps,
      triggers: clonedTriggers,
      variables: clonedVariables,
      tags: [...pipeline.tags],
      createdAt: now,
      updatedAt: now,
    };
  }
}
