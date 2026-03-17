import type { UUID, ISODateString } from './common.types.js';

/** Pipeline run status */
export type PipelineRunStatus =
  | 'idle'
  | 'queued'
  | 'running'
  | 'paused'
  | 'waiting_approval'
  | 'completed'
  | 'completed_with_warnings'
  | 'failed'
  | 'cancelled';

/** Pipeline step type — the building blocks of a pipeline */
export type PipelineStepType =
  | 'seed'
  | 'sync'
  | 'backup'
  | 'restore'
  | 'anonymize'
  | 'delete'
  | 'compare'
  | 'precheck'
  | 'script'
  | 'notification'
  | 'approval'
  | 'delay'
  | 'condition'
  | 'loop'
  | 'parallel';

/** Trigger type for automated pipeline execution */
export type TriggerType =
  | 'manual'
  | 'schedule'
  | 'event'
  | 'webhook'
  | 'sandbox_refresh'
  | 'deployment_complete';

/** Condition operator for conditional routing */
export type ConditionOperator =
  | 'eq'
  | 'neq'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'contains'
  | 'not_contains'
  | 'matches'
  | 'is_empty'
  | 'is_not_empty';

/** Pipeline definition — the configuration */
export interface PipelineDefinition {
  id: UUID;
  name: string;
  description: string;
  version: number;
  steps: PipelineStep[];
  triggers: PipelineTrigger[];
  variables: PipelineVariable[];
  tags: string[];
  createdAt: ISODateString;
  updatedAt: ISODateString;
}

/** Pipeline step definition */
export interface PipelineStep {
  id: UUID;
  name: string;
  type: PipelineStepType;
  config: Record<string, unknown>;
  continueOnError: boolean;
  timeout?: number;
  retries?: number;
  condition?: PipelineCondition;
  onSuccess?: UUID;
  onFailure?: UUID;
}

/** Pipeline trigger definition */
export interface PipelineTrigger {
  id: UUID;
  type: TriggerType;
  enabled: boolean;
  config: TriggerConfig;
}

/** Trigger configuration — varies by type */
export interface TriggerConfig {
  cron?: string;
  timezone?: string;
  eventType?: string;
  webhookSecret?: string;
  orgId?: string;
}

/** Pipeline variable */
export interface PipelineVariable {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'secret';
  defaultValue?: string;
  required: boolean;
  description: string;
}

/** Conditional routing rule */
export interface PipelineCondition {
  field: string;
  operator: ConditionOperator;
  value: string | number | boolean;
  logicalGroup?: 'and' | 'or';
}

/** Pipeline execution run */
export interface PipelineRun {
  id: UUID;
  pipelineId: UUID;
  pipelineName: string;
  status: PipelineRunStatus;
  triggeredBy: TriggerType;
  stepResults: PipelineStepResult[];
  variables: Record<string, string>;
  startTime: ISODateString;
  endTime?: ISODateString;
  duration?: number;
  error?: string;
}

/** Pipeline step result */
export interface PipelineStepResult {
  stepId: UUID;
  stepName: string;
  stepType: PipelineStepType;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
  output?: Record<string, unknown>;
  error?: string;
  startTime?: ISODateString;
  endTime?: ISODateString;
  duration?: number;
}

/** Pipeline history entry */
export interface PipelineHistoryEntry {
  runId: UUID;
  pipelineId: UUID;
  pipelineName: string;
  status: PipelineRunStatus;
  triggeredBy: TriggerType;
  startTime: ISODateString;
  duration: number;
  stepCount: number;
  errorCount: number;
}
