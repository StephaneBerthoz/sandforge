import type { PipelineStepType, RetiredPipelineStepType } from '../types/automation.types.js';

/**
 * Rules about pipeline steps that the extension, which runs them, and the
 * Automation page, which says before Run is pressed whether a step can run,
 * have to read alike: the step types there are, the ones SandForge no longer
 * has, and how an Approval step's configuration is read.
 */

/** Every member of {@link PipelineStepType}, as data, for narrowing what a payload or a store holds. */
export const PIPELINE_STEP_TYPES: readonly PipelineStepType[] = [
  'seed',
  'sync',
  'backup',
  'restore',
  'anonymize',
  'delete',
  'compare',
  'precheck',
  'notification',
  'approval',
  'delay',
  'condition',
];

/** Every member of {@link RetiredPipelineStepType}, as data. */
export const RETIRED_PIPELINE_STEP_TYPES: readonly RetiredPipelineStepType[] = [
  'script',
  'loop',
  'parallel',
];

/** Whether `type` is a step type SandForge has. */
export function isPipelineStepType(type: unknown): type is PipelineStepType {
  return typeof type === 'string' && (PIPELINE_STEP_TYPES as readonly string[]).includes(type);
}

/** Whether `type` is a step type SandForge no longer has (see {@link RetiredPipelineStepType}). */
export function isRetiredPipelineStepType(type: unknown): type is RetiredPipelineStepType {
  return (
    typeof type === 'string' && (RETIRED_PIPELINE_STEP_TYPES as readonly string[]).includes(type)
  );
}

/** How long an Approval step waits for an answer when its configuration does not say. */
export const APPROVAL_DEFAULT_TIMEOUT_MINUTES = 60;

/**
 * The longest an Approval step may wait: a day. A step that waited longer
 * would hold its pipeline, and every trigger of it, for longer than anyone
 * comes back to a question.
 */
export const APPROVAL_MAX_TIMEOUT_MINUTES = 24 * 60;

/** The longest message an Approval step shows with its question. */
export const APPROVAL_MAX_MESSAGE_LENGTH = 500;

/** What keeps an Approval step's configuration from being used. */
export type ApprovalDefect = 'timeout' | 'message';

/**
 * How many minutes an Approval step waits, or undefined when its
 * configuration names no usable wait: a whole number of minutes from 1 to a
 * day. A step that names none waits {@link APPROVAL_DEFAULT_TIMEOUT_MINUTES}.
 * @param config - The step's configuration; a step read back from storage may have none
 */
export function approvalTimeoutMinutes(
  config: Readonly<Record<string, unknown>> | undefined,
): number | undefined {
  const minutes = config?.['timeoutMinutes'];
  if (minutes === undefined) return APPROVAL_DEFAULT_TIMEOUT_MINUTES;
  return typeof minutes === 'number' &&
    Number.isInteger(minutes) &&
    minutes >= 1 &&
    minutes <= APPROVAL_MAX_TIMEOUT_MINUTES
    ? minutes
    : undefined;
}

/**
 * What keeps an Approval step's configuration from being used, or undefined
 * when nothing does: a wait outside 1 minute to a day, or a message that is
 * not text or is longer than {@link APPROVAL_MAX_MESSAGE_LENGTH}. A step with
 * no message asks with the pipeline's and the step's names alone.
 * @param config - The step's configuration
 */
export function approvalDefect(
  config: Readonly<Record<string, unknown>> | undefined,
): ApprovalDefect | undefined {
  if (approvalTimeoutMinutes(config) === undefined) return 'timeout';
  const message = config?.['message'];
  if (message === undefined) return undefined;
  return typeof message === 'string' && message.trim().length <= APPROVAL_MAX_MESSAGE_LENGTH
    ? undefined
    : 'message';
}
