import { z } from 'zod';

/** Pipeline step type */
export const pipelineStepTypeEnum = z.enum([
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
  'delay',
  'condition',
  'loop',
  'parallel',
]);

/** A single step in the pipeline definition */
export const pipelineStepSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1),
  type: pipelineStepTypeEnum,
  config: z.record(z.string(), z.unknown()),
  continueOnError: z.boolean().default(false),
  timeout: z.number().positive().optional(),
  retries: z.number().int().nonnegative().optional(),
});

/** Pipeline trigger type */
export const pipelineTriggerTypeEnum = z.enum([
  'manual',
  'schedule',
  'event',
  'webhook',
  'sandbox_refresh',
  'deployment_complete',
]);

/** A trigger that starts a pipeline */
export const pipelineTriggerSchema = z.object({
  id: z.string().uuid(),
  type: pipelineTriggerTypeEnum,
  enabled: z.boolean(),
  config: z.record(z.string(), z.unknown()),
});

/** Pipeline variable value type */
export const pipelineVariableTypeEnum = z.enum(['string', 'number', 'boolean', 'secret']);

/** A pipeline variable definition */
export const pipelineVariableSchema = z.object({
  name: z.string().min(1),
  type: pipelineVariableTypeEnum,
  defaultValue: z.union([z.string(), z.number(), z.boolean()]).optional(),
  required: z.boolean(),
  description: z.string(),
});

/** Top-level pipeline definition schema */
export const pipelineSchema = z.object({
  name: z.string().min(1),
  description: z.string().default(''),
  version: z.number().int().positive().default(1),
  steps: z.array(pipelineStepSchema).min(1),
  triggers: z.array(pipelineTriggerSchema),
  variables: z.array(pipelineVariableSchema),
});

/** Inferred type for a pipeline step input */
export type PipelineStepInput = z.infer<typeof pipelineStepSchema>;

/** Inferred type for a pipeline trigger input */
export type PipelineTriggerInput = z.infer<typeof pipelineTriggerSchema>;

/** Inferred type for a pipeline variable input */
export type PipelineVariableInput = z.infer<typeof pipelineVariableSchema>;

/** Inferred type for pipeline definition input */
export type PipelineInput = z.infer<typeof pipelineSchema>;
