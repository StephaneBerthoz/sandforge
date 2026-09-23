import type { UUID, ISODateString } from './common.types.js';

/** Pipeline run status */
export type PipelineRunStatus =
  | 'idle'
  | 'queued'
  | 'running'
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
  /**
   * What the step did, in one sentence: the records a backup took, the
   * differences a comparison found. Written by the host in English, like
   * `error`, for the run history and the execution view.
   */
  summary?: string;
  error?: string;
  /**
   * Set when the work the step started was cancelled rather than failed: a
   * Backup whose snapshot was cancelled from Live Operations. The step is not
   * tried again, and its run ends cancelled. Its status stays `failed`, as for
   * the step a cancelled run stops: it did not do its work.
   */
  cancelled?: boolean;
  startTime?: ISODateString;
  endTime?: ISODateString;
  duration?: number;
}

/** One step of a finished run, as the run history keeps it. */
export interface PipelineHistoryStep {
  stepName: string;
  stepType: PipelineStepType;
  status: PipelineStepResult['status'];
  /** How long the step ran, in milliseconds; absent for a step that did not run. */
  duration?: number;
  /** What the step did (see {@link PipelineStepResult.summary}). */
  summary?: string;
  /** Why the step failed. */
  error?: string;
}

/**
 * The status of a history entry: how a run ended, or `missed` for a start a
 * trigger owed and did not make (see {@link PipelineMissedStart}). No run is
 * ever missed; only the history records one.
 */
export type PipelineHistoryStatus = PipelineRunStatus | 'missed';

/**
 * Why a trigger fired and no run started:
 *
 * - `closed`: the schedule fell due while VS Code was closed.
 * - `asleep`: it fell due while VS Code could not check it — the computer
 *   asleep, the extension host held up — and the check came too late.
 * - `busy`: a run of the same pipeline was still going.
 * - `cannotRun`: a sandbox was refreshed, and a step of the pipeline cannot run.
 *
 * None of them is started late: a missed start is reported, never replayed.
 */
export type PipelineMissedReason = 'closed' | 'asleep' | 'busy' | 'cannotRun';

/** A start a trigger owed and did not make, as the history keeps it. */
export interface PipelineMissedStart {
  reason: PipelineMissedReason;
  /**
   * How many starts were missed for this reason. The entry's `startTime` is
   * when the first of them fell due.
   */
  count: number;
  /** Whether more fell due than `count` says: a long absence is counted up to a bound. */
  atLeast?: boolean;
  /** When the last of them fell due, when there was more than one. */
  lastDueAt?: ISODateString;
  /** For `busy`: when the run that was still going had started. */
  busySince?: ISODateString;
  /** For `cannotRun`: why the pipeline cannot run, in the host's words (English). */
  detail?: string;
}

/** Pipeline history entry */
export interface PipelineHistoryEntry {
  runId: UUID;
  pipelineId: UUID;
  pipelineName: string;
  status: PipelineHistoryStatus;
  triggeredBy: TriggerType;
  /** When the run started — for a `missed` entry, when the start fell due. */
  startTime: ISODateString;
  duration: number;
  stepCount: number;
  errorCount: number;
  /**
   * Each step of the run, in order, with what it did. Absent from the entries
   * written before steps that read an org could run.
   */
  steps?: PipelineHistoryStep[];
  /** Why no run started, on a `missed` entry. */
  missed?: PipelineMissedStart;
}

/**
 * Why a schedule or sandbox refresh trigger starts nothing:
 *
 * - `disabled`: it is switched off.
 * - `noCron`, `badCron`, `badTimezone`, `noNextRun`: its schedule gives no
 *   time — no expression, one that does not parse, a time zone that does not
 *   exist, or an expression no date of the coming year matches.
 * - `noSandbox`, `unknownSandbox`, `notSandbox`: it names no sandbox, one
 *   SandForge does not know, or an org that is not a sandbox.
 * - `cannotRun`: a step of the pipeline cannot run in a pipeline.
 * - `stopped`: nothing watches triggers in this host (the extension's
 *   trigger scheduler was not started).
 */
export type PipelineTriggerIdleReason =
  | 'disabled'
  | 'noCron'
  | 'badCron'
  | 'badTimezone'
  | 'noNextRun'
  | 'noSandbox'
  | 'unknownSandbox'
  | 'notSandbox'
  | 'cannotRun'
  | 'stopped';

/**
 * What a saved schedule or sandbox refresh trigger will do, as the extension
 * sees it. The page reads it for the saved pipeline: an edit on the canvas
 * changes nothing until it is saved.
 */
export interface PipelineTriggerStatus {
  pipelineId: UUID;
  triggerId: UUID;
  type: 'schedule' | 'sandbox_refresh';
  /** Whether the trigger starts runs. */
  armed: boolean;
  /** Why it starts nothing, when it is not armed. */
  idle?: PipelineTriggerIdleReason;
  /**
   * What lies behind `idle`, in the host's words (English): the cron parser's
   * message, or why a step cannot run.
   */
  detail?: string;
  /** When its schedule next starts the pipeline (an armed schedule trigger). */
  nextRunAt?: ISODateString;
  /** The time zone its schedule is read in: its own, or the extension host's. */
  timezone?: string;
  /** When it last fired, and whether a run started then. */
  lastFiredAt?: ISODateString;
  lastOutcome?: 'started' | 'missed';
}
