import type {
  CheckpointInvalidReason,
  CompareResult,
  GuardTier,
  PipelineApprovalRecord,
  PipelineMaskingTemplateInfo,
  PipelineRewindStepInfo,
  PipelineSeedTemplateInfo,
  PipelineStep,
  PipelineStepResult,
  PipelineSyncConfigInfo,
  RewindResult,
  SeedTemplate,
  SyncConfig,
  SyncExecutionResult,
  TriggerType,
} from '@sandforge/shared';
import {
  APPROVAL_DEFAULT_TIMEOUT_MINUTES,
  APPROVAL_MAX_MESSAGE_LENGTH,
  APPROVAL_MAX_TIMEOUT_MINUTES,
  COMPARE_DIFFERENCE_COUNT,
  PRECHECK_VARIABLES,
  PREBUILT_SEED_TEMPLATES,
  approvalDefect,
  approvalTimeoutMinutes,
  pipelineAnonymizeStepConfigSchema,
  pipelineCheckpointStepConfigSchema,
  pipelineRewindStepConfigSchema,
  pipelineSeedStepConfigSchema,
  pipelineWriteVerdict,
} from '@sandforge/shared';
import * as z from 'zod';
import type { GivenAnswer } from '../../core/precheck/ProductionGuard.js';
import { grantRefusalWords, type GrantRefusal } from '../../modules/automation/RewindGrants.js';
import {
  StepCancelledError,
  type StepCheck,
  type StepCheckContext,
  type StepContext,
  type StepExecutor,
  type StepHandler,
} from '../../modules/automation/StepExecutor.js';
import type { HealthSignal } from '../../modules/monitor/HealthCheck.js';
import type { HealthSignalName } from '../../modules/monitor/MonitorOpsFactory.js';
import { pipelineMaskingAsked } from './anonymizePipeline.js';
import type { PipelineMaskingOutcome, PipelineMaskingRequest } from './anonymizePipeline.js';
import {
  CheckpointStepRefused,
  type CheckpointPipelineRewindOutcome,
  type CheckpointPipelineRewindRequest,
  type CheckpointPipelineTakeOutcome,
  type CheckpointPipelineTakeRequest,
  type VerifiedRewindGrant,
} from './CheckpointHandler.js';
import type { BackupTaken } from './DataOpsHandler.js';
import { aiRuleFields, pipelineSeedAsked } from './seedPipeline.js';
import type { PipelineSeedOutcome, PipelineSeedRequest } from './seedPipeline.js';
import {
  compareExecutePayloadSchema,
  dataOpsBackupPayloadSchema,
  orgIdSchema,
  seedTemplatePayloadSchema,
  sfApiNameSchema,
  syncExecutePayloadSchema,
} from '../validatePayload.js';

/**
 * The pipeline steps that run through a module's own flow: Backup takes a
 * DataOps snapshot, Compare runs the Compare page's diff, Pre-check reads the
 * Monitor's health signals, Notification shows a VS Code notification,
 * Approval waits for a person's answer in VS Code, Sync runs a saved Sync
 * configuration, Seed seeds with a template of the Seed page, Anonymize masks
 * with a template of the DataOps page, Checkpoint takes a checkpoint and
 * Rewind puts an org back to one.
 *
 * Four of them write to an org, each only as its own module writes, and a
 * pipeline may run where nobody watches:
 * - Sync runs the configuration saved on the Sync page, through the run its
 *   schedule makes, which consults Production Guard. A Sync step whose target
 *   the guard asks about — a production org, a sandbox marked Staging — is
 *   refused before the run unless an Approval step comes before it; the
 *   person's answer to that step is the answer the guard takes;
 * - Seed and Anonymize never write to a production org, whatever an Approval
 *   step answered, and write to a sandbox marked Staging only behind an
 *   approved one (`pipelineWriteVerdict`); every question their page would
 *   put is answered by that Approval, and refused without it. Neither is ever
 *   tried again: a second try writes a second set of records, or masks again
 *   what the first masked;
 * - Rewind runs only once a person has confirmed it, by typing the org's
 *   alias below its preview, for its configuration as saved; the
 *   confirmation is this machine's (`RewindGrants`), and the step's bounds
 *   stand in for the person who would read the preview.
 * Restore and Delete are not here: each runs from its own page.
 *
 * A step's configuration is read before the run with the schema its module's
 * own request is read with, so a step is refused for the same reasons the
 * panel would refuse the request, and said so before anything starts.
 */

/** The checks a Pre-check step can run, and the Monitor signal each one reads. */
const PRECHECK_SIGNALS: Readonly<Record<PrecheckName, HealthSignalName>> = {
  apiLimits: 'apiLimits',
  storage: 'storage',
  recentErrors: 'recentErrors',
  failedJobs: 'activeJobs',
};

/** A check a Pre-check step can run. */
type PrecheckName = 'apiLimits' | 'storage' | 'recentErrors' | 'failedJobs';

/** Every check a Pre-check step can run, in the order a result lists them. */
const PRECHECK_NAMES = Object.keys(PRECHECK_SIGNALS) as PrecheckName[];

/**
 * What each check hands on to the steps after it: the name a Condition tests,
 * and the reading it takes. `apiUsagePercent` is what the Marketplace's API
 * Limit Monitoring template tests.
 */
const HANDED_ON: Readonly<
  Record<PrecheckName, { variable: string; read: (signal: HealthSignal) => number | undefined }>
> = {
  apiLimits: { variable: PRECHECK_VARIABLES.apiLimits, read: (signal) => signal.percent },
  storage: { variable: PRECHECK_VARIABLES.storage, read: (signal) => signal.percent },
  recentErrors: { variable: PRECHECK_VARIABLES.recentErrors, read: (signal) => signal.count },
  failedJobs: { variable: PRECHECK_VARIABLES.failedJobs, read: (signal) => signal.count },
};

/** The longest message a Notification step shows. */
const MAX_NOTIFICATION_LENGTH = 500;

const precheckConfigSchema = z.object({
  orgId: orgIdSchema,
  checks: z
    .array(z.enum(['apiLimits', 'storage', 'recentErrors', 'failedJobs']))
    .min(1)
    .refine((checks) => new Set(checks).size === checks.length),
});

const notificationConfigSchema = z.object({
  message: z.string().trim().min(1).max(MAX_NOTIFICATION_LENGTH),
});

/** What an Approval step asks: the step, its pipeline, and how long it waits. */
export interface ApprovalAsk {
  stepId: string;
  stepName: string;
  pipelineName?: string;
  /** What the step says with its question; absent, it asks with the names alone. */
  message?: string;
  /** How long it waits for an answer, in milliseconds. */
  timeoutMs: number;
}

/**
 * What Production Guard does with a Sync run of a configuration, worked out
 * from its check alone, before anyone is asked anything: lets it through,
 * asks a person first, or refuses it whatever anyone answers.
 */
export type SyncGuardVerdict =
  { decision: 'allowed' } | { decision: 'asks' } | { decision: 'refused'; reason: string };

/**
 * What the steps run on: the flows the modules' own panels run, on the same
 * handler instances, so a pipeline's snapshot and one taken from the DataOps
 * page wait on the same per-org lock.
 */
export interface PipelineStepRunners {
  /** The name the user knows a registered org by; undefined when no org is registered under the id. */
  orgName(orgId: string): string | undefined;
  /** A new id for each snapshot a Backup step takes: a retry is a new snapshot. */
  newId(): string;
  /**
   * DataOps's snapshot flow (`DataOpsHandler.backupForPipeline`). Rejects with
   * a `StepCancelledError` when a cancel from Live Operations stopped the
   * snapshot, which ends the step without a retry.
   */
  backup(
    request: { operationId: string; orgId: string; objects: string[] },
    signal?: AbortSignal,
  ): Promise<BackupTaken>;
  /**
   * The Compare page's diff (`CompareHandler.compareOrgs`). `signal` stops it
   * reading the orgs: it makes no request once aborted.
   */
  compare(
    request: {
      sourceOrgId: string;
      targetOrgId: string;
      types: string[];
    },
    signal?: AbortSignal,
  ): Promise<CompareResult>;
  /** The Monitor's health signals (`MonitorOpsHandler.readOrgHealth`). */
  readOrgHealth(orgId: string, signals: readonly HealthSignalName[]): Promise<HealthSignal[]>;
  /** Shows a notification in the VS Code window; absent where there is no window. */
  notify?: (message: string) => void;
  /**
   * Puts an Approval step's question to the person — a VS Code notification
   * with Approve and Reject, and the same choice beside the step on the
   * Automation page for a run it started — and resolves with the first
   * answer, or with the end of the wait or of the run. Never rejects. Absent
   * where there is no window to ask in.
   */
  askApproval?: (ask: ApprovalAsk, signal?: AbortSignal) => Promise<PipelineApprovalRecord>;
  /** A saved Sync configuration as it is stored, by id; undefined when none is saved under it. */
  savedSyncConfig?: (configId: string) => unknown;
  /** Every saved Sync configuration as it is stored, as the Sync page lists them. */
  listSyncConfigs?: () => unknown[];
  /** What Production Guard does with a run of `config`, without asking anyone (see {@link SyncGuardVerdict}). */
  syncGuard?: (config: SyncConfig) => SyncGuardVerdict;
  /**
   * Sync's own run of a saved configuration: the run its schedule makes
   * (`SyncOpsHandler.executeScheduled`), which consults Production Guard, with
   * `answer` standing for the guard's question. `signal` cancels the run, as
   * Cancel in Live Operations does. Resolves with Sync's own result; rejects
   * when the guard stops the run or the configuration does not validate.
   */
  runSync?: (
    config: SyncConfig,
    answer: GivenAnswer,
    signal?: AbortSignal,
  ) => Promise<SyncExecutionResult>;
  /**
   * The guard's tier of a registered org (`guardTierOf`), which the steps that
   * write read their verdict from; undefined for an org not registered.
   */
  orgTier?: (orgId: string) => GuardTier | undefined;
  /**
   * The Organization Ids a registered org is known by: the one it was
   * registered with, and the one it answered as last. A Rewind step's
   * checkpoint is of the org only when it was taken of one of them.
   */
  organizationIdsOf?: (orgId: string) => string[];
  /** The pipeline the steps are checked and run for, by id: a Rewind step's confirmation is kept under it. */
  pipelineId?: string;
  /** How the run the steps are of was started: recorded with a rewind in the audit trail. */
  trigger?: TriggerType;
  /** A template the Seed page saved, as stored, by id; undefined when none is saved under it. */
  savedSeedTemplate?: (templateId: string) => SeedTemplate | undefined;
  /** Every template the Seed page saved, as stored. */
  listSeedTemplates?: () => unknown[];
  /**
   * Seed's own run of a template for a pipeline (`SeedOpsHandler.seedForPipeline`):
   * its gates, its Recent runs entry, Live Operations and the audit trail.
   * Rejects with a `code` when it is refused before it writes.
   */
  seed?: (request: PipelineSeedRequest, signal?: AbortSignal) => Promise<PipelineSeedOutcome>;
  /** Every masking template, those DataOps ships first, with the fields their rules name. */
  maskingTemplates?: () => ReadonlyArray<MaskingTemplate>;
  /**
   * DataOps's own masking run for a pipeline (`DataOpsHandler.anonymizeForPipeline`):
   * coverage first, Production Guard, the snapshot always, then the masking.
   * Rejects with a `code` when it is refused before it writes or fails.
   */
  anonymize?: (
    request: PipelineMaskingRequest,
    signal?: AbortSignal,
  ) => Promise<PipelineMaskingOutcome>;
  /**
   * The take of a checkpoint for a pipeline (`CheckpointHandler.takeForPipeline`).
   * Rejects with a {@link CheckpointStepRefused} when the take is refused.
   */
  takeCheckpoint?: (
    request: CheckpointPipelineTakeRequest,
    signal?: AbortSignal,
  ) => Promise<CheckpointPipelineTakeOutcome>;
  /**
   * The confirmation kept on this machine for a Rewind step of the pipeline
   * `pipelineId`, given for the configuration it runs with; otherwise why not
   * (`RewindGrants.verify`).
   */
  rewindGrant?: (
    pipelineId: string,
    step: Pick<PipelineStep, 'id' | 'config'>,
  ) => { grant: VerifiedRewindGrant } | { refusal: GrantRefusal };
  /**
   * A checkpoint a Rewind step names, as read from this machine before the
   * check; undefined when it was not read, and the run reads it then.
   */
  checkpointKept?: (checkpointId: string) => RewindCheckpoint | undefined;
  /**
   * A checkpoint as read from this machine, without contacting its org: what
   * {@link checkpointKept} answers from, read before each check and run of a
   * pipeline that holds a Rewind step, and as a confirmation is given.
   */
  readCheckpoint?: (checkpointId: string) => Promise<RewindCheckpoint>;
  /**
   * The rewind of an org for a pipeline (`CheckpointHandler.rewindForPipeline`):
   * a preview of its own, the bounds, then the rewind. Rejects with a
   * {@link CheckpointStepRefused} when it is refused.
   */
  rewind?: (
    request: CheckpointPipelineRewindRequest,
    signal?: AbortSignal,
  ) => Promise<CheckpointPipelineRewindOutcome>;
}

/** A masking template as a pipeline's Anonymize step reads it: what its rules name, and where it comes from. */
export interface MaskingTemplate {
  id: string;
  name: string;
  builtIn: boolean;
  rules: ReadonlyArray<{ fieldPattern: string }>;
}

/**
 * A checkpoint a Rewind step names, as read from this machine without
 * contacting the org: not kept here, or kept, of an Organization Id, and
 * whether it can be rewound to and why not (`CheckpointListEntry`).
 */
export type RewindCheckpoint =
  | { kept: false }
  | {
      kept: true;
      /** The Organization Id it was taken of; absent for one whose file does not read. */
      organizationId?: string;
      name?: string;
      valid: boolean;
      why?: CheckpointInvalidReason;
    };

/** `count` and `noun`, the noun in the plural unless the count is one. */
function counted(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/** The result of a step that did its work. */
function completed(
  step: PipelineStep,
  startTime: string,
  output: Record<string, unknown>,
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

/** The result of a step that ran and found what keeps the run from going on. */
function failed(
  step: PipelineStep,
  startTime: string,
  output: Record<string, unknown>,
  error: string,
): PipelineStepResult {
  const endTime = new Date().toISOString();
  return {
    stepId: step.id,
    stepName: step.name,
    stepType: step.type,
    status: 'failed',
    output,
    error,
    startTime,
    endTime,
    duration: new Date(endTime).getTime() - new Date(startTime).getTime(),
  };
}

/**
 * What is wrong with the org a step names, or undefined when it names one
 * that is registered.
 * @param who - How the reason names the step ("Backup step "Nightly"")
 * @param orgId - The org id the step's configuration holds
 * @param role - What the org is to the step ("the org it backs up")
 */
function orgProblem(
  runners: PipelineStepRunners,
  who: string,
  orgId: unknown,
  role: string,
): string | undefined {
  if (typeof orgId !== 'string' || orgId.trim() === '') {
    return `${who} names no org: choose ${role}.`;
  }
  if (runners.orgName(orgId) === undefined) {
    return `${who} names an org SandForge does not know (${orgId}): connect it, or choose ${role} again.`;
  }
  return undefined;
}

/** The entries of a list a step's configuration holds; undefined when it holds none. */
function listed(value: unknown): unknown[] | undefined {
  return Array.isArray(value) && value.length > 0 ? value : undefined;
}

function checkBackup(runners: PipelineStepRunners): StepCheck {
  return (step) => {
    const who = `Backup step "${step.name}"`;
    const config = step.config ?? {};
    const problem = orgProblem(runners, who, config['orgId'], 'the org it backs up');
    if (problem) return problem;
    const objects = listed(config['objects']);
    if (!objects) {
      return `${who} names no object: list the API names of the objects it backs up.`;
    }
    const notNames = objects.filter((name) => !sfApiNameSchema.safeParse(name).success);
    if (notNames.length > 0) {
      return `${who} names what is not an object API name: ${notNames.map(String).join(', ')}.`;
    }
    // The DataOps request's own schema, so the step is refused for whatever
    // the Backup button's request would be refused for.
    if (!dataOpsBackupPayloadSchema.safeParse({ orgId: config['orgId'], objects }).success) {
      return `${who} backs up more objects than one backup takes: at most 100.`;
    }
    return undefined;
  };
}

function checkCompare(runners: PipelineStepRunners): StepCheck {
  return (step) => {
    const who = `Compare step "${step.name}"`;
    const config = step.config ?? {};
    const problem =
      orgProblem(runners, who, config['sourceOrgId'], 'the org it compares from') ??
      orgProblem(runners, who, config['targetOrgId'], 'the org it compares with');
    if (problem) return problem;
    if (config['sourceOrgId'] === config['targetOrgId']) {
      return `${who} compares an org with itself: choose two different orgs.`;
    }
    const types = listed(config['types']);
    if (!types) {
      return `${who} names no component type: choose what it compares.`;
    }
    const parsed = compareExecutePayloadSchema.safeParse({
      sourceOrgId: config['sourceOrgId'],
      targetOrgId: config['targetOrgId'],
      types,
    });
    if (!parsed.success) {
      return `${who} names component types the Compare page would not send: at most 50, each a type name.`;
    }
    return undefined;
  };
}

function checkPrecheck(runners: PipelineStepRunners): StepCheck {
  return (step) => {
    const who = `Pre-check step "${step.name}"`;
    const config = step.config ?? {};
    const problem = orgProblem(runners, who, config['orgId'], 'the org it checks');
    if (problem) return problem;
    const checks = listed(config['checks']);
    if (!checks) {
      return `${who} names no check: choose what it checks (${PRECHECK_NAMES.join(', ')}).`;
    }
    const unknown = checks.filter(
      (check) => typeof check !== 'string' || !(PRECHECK_NAMES as string[]).includes(check),
    );
    if (unknown.length > 0) {
      return `${who} names checks SandForge does not have: ${unknown.map(String).join(', ')}. It can check ${PRECHECK_NAMES.join(', ')}.`;
    }
    if (!precheckConfigSchema.safeParse({ orgId: config['orgId'], checks }).success) {
      return `${who} names the same check twice.`;
    }
    return undefined;
  };
}

function checkNotification(runners: PipelineStepRunners): StepCheck {
  return (step) => {
    const who = `Notification step "${step.name}"`;
    if (!runners.notify) {
      return `${who} cannot show a notification: there is no VS Code window to show it in.`;
    }
    const message = (step.config ?? {})['message'];
    if (typeof message !== 'string' || message.trim() === '') {
      return `${who} has no message: write what the notification says.`;
    }
    if (!notificationConfigSchema.safeParse({ message }).success) {
      return `${who} has a message longer than ${MAX_NOTIFICATION_LENGTH} characters.`;
    }
    return undefined;
  };
}

function backupHandler(runners: PipelineStepRunners): StepHandler {
  return async (step: PipelineStep, context: StepContext) => {
    const startTime = new Date().toISOString();
    const { orgId, objects } = dataOpsBackupPayloadSchema.parse({
      orgId: step.config['orgId'],
      objects: step.config['objects'],
    });
    const taken = await runners.backup(
      { operationId: runners.newId(), orgId, objects },
      context.signal,
    );
    const org = runners.orgName(orgId) ?? orgId;
    const cut = taken.objects.filter((o) => o.truncated).map((o) => o.objectApiName);
    // A partial snapshot is still the step's work, and still better than none,
    // but the history says what it is not.
    const summary =
      `Backed up ${counted(taken.totalRecords, 'record')} of ` +
      `${counted(taken.objects.length, 'object')} from ${org}` +
      (cut.length > 0
        ? `; only part of ${cut.join(', ')}: the org holds more rows than one backup reads.`
        : '.');
    return completed(
      step,
      startTime,
      {
        operationId: taken.operationId,
        orgId,
        objects: taken.objects,
        totalRecords: taken.totalRecords,
        partial: taken.partial,
      },
      summary,
    );
  };
}

function compareHandler(runners: PipelineStepRunners): StepHandler {
  return async (step: PipelineStep, context: StepContext) => {
    const startTime = new Date().toISOString();
    const { sourceOrgId, targetOrgId, types } = compareExecutePayloadSchema.parse({
      sourceOrgId: step.config['sourceOrgId'],
      targetOrgId: step.config['targetOrgId'],
      types: step.config['types'],
    });
    // The step's signal, which the run's cancel and time budget and the
    // step's own timeout abort. Without it a comparison given up on went on
    // listing and reading both orgs to its end, unobserved.
    const result = await runners.compare({ sourceOrgId, targetOrgId, types }, context.signal);
    const { added, removed, modified, unchanged, notCompared } = result.summary;
    const source = runners.orgName(sourceOrgId) ?? sourceOrgId;
    const target = runners.orgName(targetOrgId) ?? targetOrgId;
    // The counts only: every diff of a large org is the Compare page's to
    // show, and a history entry that carried them would grow without bound.
    // They are named by the org that holds them, as the Compare page names
    // them: DiffEngine's `added` is a component only the target holds, which
    // "added" read as one the run had created.
    // How many components differ, handed on for a Condition after the step
    // ("Compare found more than N differences"): what is only in one org,
    // only in the other, or modified. What could not be compared is no
    // difference anyone found.
    return completed(
      step,
      startTime,
      {
        sourceOrgId,
        targetOrgId,
        types,
        summary: result.summary,
        content: result.content,
        variables: { [COMPARE_DIFFERENCE_COUNT]: String(added + removed + modified) },
      },
      `Compared ${counted(types.length, 'component type')} of ${source} with ${target}: ` +
        `${removed} only in ${source}, ${added} only in ${target}, ${modified} modified, ` +
        `${unchanged} unchanged, ${notCompared} not compared.`,
    );
  };
}

/** How a reading reads in a result: the Monitor's own words, and what they mean here. */
function describeReading(signal: HealthSignal): string {
  switch (signal.status) {
    case 'critical':
      return `${signal.message} (critical)`;
    case 'unknown':
      return `${signal.message} (could not be read)`;
    case 'warning':
      return `${signal.message} (warning)`;
    default:
      return signal.message;
  }
}

function precheckHandler(runners: PipelineStepRunners): StepHandler {
  return async (step: PipelineStep) => {
    const startTime = new Date().toISOString();
    const { orgId, checks } = precheckConfigSchema.parse({
      orgId: step.config['orgId'],
      checks: step.config['checks'],
    });
    const org = runners.orgName(orgId) ?? orgId;
    const signals = await runners.readOrgHealth(
      orgId,
      checks.map((check) => PRECHECK_SIGNALS[check]),
    );

    const readings = checks.map((check, index) => ({ check, signal: signals[index] }));
    const variables: Record<string, string> = {};
    for (const { check, signal } of readings) {
      const value = signal ? HANDED_ON[check].read(signal) : undefined;
      if (value !== undefined && signal.status !== 'unknown') {
        variables[HANDED_ON[check].variable] = String(value);
      }
    }
    const output = {
      orgId,
      checks: readings.map(({ check, signal }) => ({
        check,
        status: signal?.status ?? 'unknown',
        message: signal?.message ?? 'Not read',
      })),
      variables,
    };

    // A check fails the step when the Monitor calls its reading critical, or
    // cannot read it at all: a pre-check that cannot see the org has checked
    // nothing, and the steps after it would run on a guess.
    const failing = readings.filter(
      ({ signal }) => !signal || signal.status === 'critical' || signal.status === 'unknown',
    );
    if (failing.length > 0) {
      return failed(
        step,
        startTime,
        output,
        `Pre-check "${step.name}" failed on ${org}: ` +
          `${failing.map(({ check, signal }) => (signal ? describeReading(signal) : `${check} was not read`)).join('; ')}.`,
      );
    }
    return completed(
      step,
      startTime,
      output,
      `${readings.length === 1 ? 'The check' : `${readings.length} checks`} passed on ${org}: ` +
        `${readings.map(({ signal }) => describeReading(signal)).join('; ')}.`,
    );
  };
}

function notificationHandler(runners: PipelineStepRunners): StepHandler {
  return async (step: PipelineStep, context: StepContext) => {
    const startTime = new Date().toISOString();
    const { message } = notificationConfigSchema.parse({ message: step.config['message'] });
    if (!runners.notify) {
      return failed(
        step,
        startTime,
        {},
        `Notification step "${step.name}" cannot show a notification: there is no VS Code window to show it in.`,
      );
    }
    // Shown, not awaited: a notification stays until it is read, and the run
    // does not wait for someone to read it.
    runners.notify(context.pipelineName ? `${context.pipelineName}: ${message}` : message);
    return completed(step, startTime, { message }, 'Showed a notification in VS Code.');
  };
}

function checkApproval(runners: PipelineStepRunners): StepCheck {
  return (step) => {
    const who = `Approval step "${step.name}"`;
    if (!runners.askApproval) {
      return `${who} cannot ask anyone: there is no VS Code window to ask in.`;
    }
    switch (approvalDefect(step.config)) {
      case 'timeout':
        return `${who} waits for a time it cannot keep: set a whole number of minutes from 1 to ${APPROVAL_MAX_TIMEOUT_MINUTES} (a day).`;
      case 'message':
        return `${who} has a message that is not text, or is longer than ${APPROVAL_MAX_MESSAGE_LENGTH} characters.`;
      default:
        return undefined;
    }
  };
}

/** Where an answer was given, as a sentence goes on: " on the Automation page". */
function answeredVia(record: PipelineApprovalRecord): string {
  if (record.via === 'page') return ' on the Automation page';
  if (record.via === 'notification') return ' in the VS Code notification';
  return '';
}

function approvalHandler(runners: PipelineStepRunners): StepHandler {
  return async (step: PipelineStep, context: StepContext) => {
    const startTime = new Date().toISOString();
    const who = `Approval step "${step.name}"`;
    if (!runners.askApproval) {
      return failed(
        step,
        startTime,
        {},
        `${who} cannot ask anyone: there is no VS Code window to ask in.`,
      );
    }
    const minutes = approvalTimeoutMinutes(step.config) ?? APPROVAL_DEFAULT_TIMEOUT_MINUTES;
    const text = step.config?.['message'];
    const message = typeof text === 'string' && text.trim() !== '' ? text.trim() : undefined;
    // The step's signal, which the run's cancel and time budget abort: a run
    // given up on leaves no question open that an answer would act on.
    const record = await runners.askApproval(
      {
        stepId: step.id,
        stepName: step.name,
        ...(context.pipelineName ? { pipelineName: context.pipelineName } : {}),
        ...(message ? { message } : {}),
        timeoutMs: minutes * 60_000,
      },
      context.signal,
    );
    const output = { approval: record };
    switch (record.decision) {
      case 'approved':
        return {
          ...completed(step, startTime, output, `Approved${answeredVia(record)} at ${record.at}.`),
          approval: record,
        };
      case 'rejected':
        return {
          ...failed(
            step,
            startTime,
            output,
            `${who} was rejected${answeredVia(record)} at ${record.at}.`,
          ),
          approval: record,
        };
      case 'timedOut':
        return {
          ...failed(
            step,
            startTime,
            output,
            `${who} was not approved in time: nobody answered within ${counted(minutes, 'minute')}.`,
          ),
          approval: record,
        };
      case 'cancelled':
        return {
          ...failed(step, startTime, output, `${who} was stopped before anyone answered.`),
          approval: record,
        };
    }
  };
}

/** A saved Sync configuration read for a step: as stored and checked, or what is wrong with it. */
type SavedSync = { config: SyncConfig; name: string } | { problem: string };

/**
 * The Sync configuration a step names, read as Sync's schedule reads one: the
 * stored configuration, checked with the schema a run from the Sync page is
 * checked with. A configuration deleted on the Sync page, or one an older
 * release wrote that no longer reads, refuses the step.
 */
function readSavedSync(runners: PipelineStepRunners, step: PipelineStep): SavedSync {
  const who = `Sync step "${step.name}"`;
  const configId = (step.config ?? {})['configId'];
  if (typeof configId !== 'string' || configId.trim() === '') {
    return { problem: `${who} names no saved Sync configuration: choose the one it runs.` };
  }
  const stored = runners.savedSyncConfig?.(configId);
  if (stored === undefined || stored === null) {
    return {
      problem: `${who} names a Sync configuration that is no longer saved (${configId}): choose another.`,
    };
  }
  const parsed = syncExecutePayloadSchema.safeParse({ config: stored });
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      problem:
        `${who} names a Sync configuration that no longer validates ` +
        // The path within the configuration, not within the request it is read as.
        `(${issue.path.slice(1).join('.')}: ${issue.message}): open it on the Sync page and save it again.`,
    };
  }
  // The configuration as stored, as Sync's schedule hands it to the run,
  // which fills in what the store left out the way a run from its page does.
  const config = stored as SyncConfig;
  const name = typeof config.name === 'string' && config.name !== '' ? config.name : configId;
  return { config, name };
}

/**
 * Each saved Sync configuration as a Sync step sees it: whether it reads as
 * Sync's schedule reads one, the orgs it names, and what Production Guard
 * does with a run of it. The page checks a Sync step against these before
 * Run, with the same reading the step's own check makes.
 * @param runners - The flows the steps run on
 */
export function describeSyncConfigs(runners: PipelineStepRunners): PipelineSyncConfigInfo[] {
  const stored = runners.listSyncConfigs?.() ?? [];
  return stored.flatMap((raw): PipelineSyncConfigInfo[] => {
    if (typeof raw !== 'object' || raw === null) return [];
    const { id, name } = raw as Record<string, unknown>;
    if (typeof id !== 'string' || id === '') return [];
    const label = typeof name === 'string' && name !== '' ? name : id;
    if (!syncExecutePayloadSchema.safeParse({ config: raw }).success) {
      return [{ id, name: label, valid: false }];
    }
    const config = raw as SyncConfig;
    return [
      {
        id,
        name: label,
        valid: true,
        sourceOrgId: config.sourceOrgId,
        targetOrgId: config.targetOrgId,
        ...(runners.syncGuard ? { guard: runners.syncGuard(config).decision } : {}),
      },
    ];
  });
}

/**
 * Whether an Approval step comes before the step checked. A step checked on
 * its own, as it runs, was checked in its pipeline before the run started;
 * at run time the guard takes the answer of the Approval step the run took,
 * and declines its question when there is none.
 */
function approvalBefore(context: StepCheckContext | undefined): boolean {
  return (
    context === undefined ||
    context.steps.slice(0, context.index).some((step) => step.type === 'approval')
  );
}

function checkSync(runners: PipelineStepRunners): StepCheck {
  return (step, context) => {
    const who = `Sync step "${step.name}"`;
    if (!runners.runSync || !runners.savedSyncConfig || !runners.syncGuard) {
      return `${who} cannot run here: Sync is not available in this window.`;
    }
    const saved = readSavedSync(runners, step);
    if ('problem' in saved) return saved.problem;
    const { config } = saved;
    const problem =
      orgProblem(runners, who, config.sourceOrgId, 'the source org of its configuration') ??
      orgProblem(runners, who, config.targetOrgId, 'the target org of its configuration');
    if (problem) return problem;
    const verdict = runners.syncGuard(config);
    if (verdict.decision === 'refused') {
      return `${who} writes where Production Guard refuses it, whatever anyone answers: ${verdict.reason}.`;
    }
    if (verdict.decision === 'asks' && !approvalBefore(context)) {
      const target = runners.orgName(config.targetOrgId) ?? config.targetOrgId;
      return (
        `${who} writes to ${target}, which Production Guard asks about before a write, and ` +
        `nobody may be there to answer when the pipeline runs: put an Approval step before it.`
      );
    }
    return undefined;
  };
}

/**
 * The answer the Approval step before this one gave, for the guard's
 * question: the last Approval the run took, approved or not. None — no
 * Approval step ran, its condition passed it over, a route jumped it — is no
 * approval, and a question the guard puts is declined.
 */
function givenAnswer(context: StepContext): GivenAnswer {
  const approvals = context.previousResults.filter((result) => result.stepType === 'approval');
  const last = approvals[approvals.length - 1];
  return {
    approved: last?.status === 'completed' && last.approval?.decision === 'approved',
  };
}

function syncHandler(runners: PipelineStepRunners): StepHandler {
  return async (step: PipelineStep, context: StepContext) => {
    const startTime = new Date().toISOString();
    const saved = readSavedSync(runners, step);
    // Checked before the run, and read again here: the Sync page can delete
    // or change the configuration while the steps before this one run.
    if ('problem' in saved) throw new Error(saved.problem);
    if (!runners.runSync) {
      throw new Error(
        `Sync step "${step.name}" cannot run here: Sync is not available in this window.`,
      );
    }
    const { config, name } = saved;
    const result = await runners.runSync(config, givenAnswer(context), context.signal);
    if (result.cancelled) {
      throw new StepCancelledError(
        `Sync step "${step.name}" was cancelled: ${result.error ?? 'the run stopped before it synced every object.'}`,
      );
    }
    const target = runners.orgName(config.targetOrgId) ?? config.targetOrgId;
    // Sync's counts, and the summary its run gives beside them, passed on as
    // the run gave it.
    const runSummary = (result as unknown as Record<string, unknown>)['summary'];
    const output: Record<string, unknown> = {
      configId: config.id,
      configName: name,
      operationId: result.operationId,
      status: result.status,
      totalProcessed: result.totalProcessed,
      totalSuccess: result.totalSuccess,
      totalFailed: result.totalFailed,
      totalSkipped: result.totalSkipped,
      objects: result.objectResults.map((object) => ({
        objectApiName: object.objectApiName,
        operation: object.operation,
        processed: object.processed,
        success: object.success,
        failed: object.failed,
        skipped: object.skipped,
      })),
      ...(typeof runSummary === 'object' && runSummary !== null ? { summary: runSummary } : {}),
    };
    const counts =
      `${counted(result.totalSuccess, 'record')} written, ${result.totalFailed} failed and ` +
      `${result.totalSkipped} skipped of ${result.totalProcessed} read`;
    // A run that wrote some records and failed others is no success: the
    // steps after it would go on as if every record were there.
    if (result.status !== 'success') {
      return failed(
        step,
        startTime,
        output,
        `Sync step "${step.name}" ran "${name}" into ${target} and did not complete: ${counts}` +
          (result.error ? `; ${result.error}` : '.'),
      );
    }
    return completed(step, startTime, output, `Synced "${name}" into ${target}: ${counts}.`);
  };
}

// ─── The steps that seed, mask, take a checkpoint and rewind ─────────────────

/** A step's configuration read as text, an empty one as none: the page clears a field to ''. */
function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

/** The first issue of a schema's refusal, as "path: message". */
function firstIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return 'its configuration is not one';
  return issue.path.length > 0 ? `${issue.path.join('.')}: ${issue.message}` : issue.message;
}

/** Whether two Organization Ids name one org: the 15-character id and its 18-character form alike. */
function sameOrganization(a: string | undefined, b: string | undefined): boolean {
  return a !== undefined && b !== undefined && a.length >= 15 && a.slice(0, 15) === b.slice(0, 15);
}

/** How the pipeline a step runs in is named, to the module its step runs. */
function pipelineNameOf(context: StepContext): string {
  return context.pipelineName ?? context.pipelineId;
}

/**
 * Why a step that writes may not write to its org, whatever it writes, or
 * undefined when it may (`pipelineWriteVerdict`): a production org, or one
 * SandForge cannot tell is not one, whatever an Approval step answers; a
 * sandbox marked Staging, with no Approval step before it.
 * @param does - What the step does there, as a sentence goes on: "seeds", "masks"
 */
function writeVerdictProblem(
  runners: PipelineStepRunners,
  who: string,
  orgId: string,
  does: string,
  context: StepCheckContext | undefined,
): string | undefined {
  const org = runners.orgName(orgId) ?? orgId;
  const verdict = pipelineWriteVerdict(runners.orgTier?.(orgId) ?? 'production');
  if (verdict === 'refused') {
    return (
      `${who} writes to ${org}, a production org or one SandForge cannot tell is not: a ` +
      `pipeline never ${does} one, whatever an Approval step answers. Choose a sandbox, a ` +
      'scratch org or a Developer Edition org.'
    );
  }
  if (verdict === 'needsApproval' && !approvalBefore(context)) {
    return (
      `${who} writes to ${org}, a sandbox marked Staging, which a pipeline ${does} only once ` +
      'an Approval step before it has approved the run: put an Approval step before it.'
    );
  }
  return undefined;
}

/** Why a step that writes may not be tried again, or undefined when it is given no retry. */
function retriesProblem(step: PipelineStep, who: string, why: string): string | undefined {
  return step.retries !== undefined && step.retries > 0
    ? `${who} is given retries, and is never tried again: ${why}. Set its retries to 0.`
    : undefined;
}

/** A refusal before a step wrote, carried as an error with a `code`: its code, or undefined. */
function refusalCode(err: unknown): string | undefined {
  if (err instanceof StepCancelledError) return undefined;
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
}

function checkSeed(runners: PipelineStepRunners): StepCheck {
  return (step, context) => {
    const who = `Seed step "${step.name}"`;
    if (!runners.seed || !runners.savedSeedTemplate) {
      return `${who} cannot run here: Seed is not available in this window.`;
    }
    const config = step.config ?? {};
    const problem = orgProblem(runners, who, config['orgId'], 'the org it seeds');
    if (problem) return problem;
    const templateId = text(config['templateId']);
    if (templateId === undefined) {
      return `${who} names no Seed template: choose the one it seeds with.`;
    }
    const orgId = String(config['orgId']);
    const chosen = pipelineSeedAsked(orgId, templateId, (id) => runners.savedSeedTemplate?.(id));
    if ('refusal' in chosen) return `${who}: ${chosen.refusal.message}`;
    return (
      retriesProblem(step, who, 'a second try would write a second set of records') ??
      writeVerdictProblem(runners, who, orgId, 'seeds', context)
    );
  };
}

function seedHandler(runners: PipelineStepRunners): StepHandler {
  return async (step: PipelineStep, context: StepContext) => {
    const startTime = new Date().toISOString();
    const who = `Seed step "${step.name}"`;
    if (!runners.seed) {
      throw new Error(`${who} cannot run here: Seed is not available in this window.`);
    }
    const { orgId, templateId } = pipelineSeedStepConfigSchema.parse({
      orgId: step.config['orgId'],
      templateId: text(step.config['templateId']),
    });
    const org = runners.orgName(orgId) ?? orgId;
    let outcome: PipelineSeedOutcome;
    try {
      outcome = await runners.seed(
        {
          orgId,
          templateId,
          pipeline: { name: pipelineNameOf(context) },
          answer: givenAnswer(context),
        },
        context.signal,
      );
    } catch (err: unknown) {
      const code = refusalCode(err);
      if (code === undefined) throw err;
      return failed(
        step,
        startTime,
        { orgId, templateId, code },
        `${who}: ${(err as Error).message}`,
      );
    }
    const { result } = outcome;
    const output: Record<string, unknown> = {
      orgId,
      templateId,
      operationId: outcome.operationId,
      runId: outcome.runId,
      status: result.status,
      totalRecordsCreated: result.totalRecordsCreated,
      totalRecordsFailed: result.totalRecordsFailed,
      objects: result.objectResults.map((object) => ({
        objectApiName: object.objectApiName,
        recordsCreated: object.recordsCreated,
        recordsFailed: object.recordsFailed,
      })),
      ...(outcome.automation.length > 0 ? { automation: outcome.automation } : {}),
    };
    const created = counted(result.totalRecordsCreated, 'record');
    // What a seed wrote stays in the org until someone takes it back, a seed
    // stopped part way included: the step says from where.
    const takeBack = "take them back from Seed's Recent runs";
    if (result.cancelled) {
      throw new StepCancelledError(
        `${who} was cancelled: it had created ${created} in ${org}, which stay there; ${takeBack}.`,
      );
    }
    if (result.status !== 'success') {
      return failed(
        step,
        startTime,
        output,
        `${who} seeded ${org} and did not complete: ${created} created, ` +
          `${result.totalRecordsFailed} refused; ${takeBack}.`,
      );
    }
    return completed(step, startTime, output, `Seeded ${created} into ${org}: ${takeBack}.`);
  };
}

/**
 * Each Seed template as a Seed step sees it: those the Seed page saved, then
 * those SandForge ships, whether it reads as a run of the page is read, and
 * whether it holds an AI rule. The page checks a Seed step against these
 * before Run, as the step's own check does.
 * @param runners - The flows the steps run on
 */
export function describeSeedTemplates(runners: PipelineStepRunners): PipelineSeedTemplateInfo[] {
  const saved = (runners.listSeedTemplates?.() ?? []).map((raw) => ({ raw, builtIn: false }));
  const shipped = PREBUILT_SEED_TEMPLATES.map((raw) => ({ raw: raw as unknown, builtIn: true }));
  const seen = new Set<string>();
  return [...saved, ...shipped].flatMap(({ raw, builtIn }): PipelineSeedTemplateInfo[] => {
    if (typeof raw !== 'object' || raw === null) return [];
    const { id, name } = raw as Record<string, unknown>;
    // A saved template shadows a shipped one of the same id, as the step reads it.
    if (typeof id !== 'string' || id === '' || seen.has(id)) return [];
    seen.add(id);
    const label = typeof name === 'string' && name !== '' ? name : id;
    const parsed = seedTemplatePayloadSchema.safeParse(raw);
    return [
      {
        id,
        name: label,
        builtIn,
        valid: parsed.success,
        usesAi: parsed.success && aiRuleFields(parsed.data).length > 0,
      },
    ];
  });
}

/** The objects a masking template's rules name, by API name, in the order they come. */
function maskedObjectsOf(template: MaskingTemplate): string[] {
  const objects: string[] = [];
  for (const rule of template.rules) {
    const object = rule.fieldPattern.split('.')[0];
    if (object && !objects.includes(object)) objects.push(object);
  }
  return objects;
}

/**
 * Each masking template as an Anonymize step sees it: those DataOps ships,
 * then those its page saved, with the objects their rules name, which a
 * masking run of it writes to unless the step names one.
 * @param runners - The flows the steps run on
 */
export function describeMaskingTemplates(
  runners: PipelineStepRunners,
): PipelineMaskingTemplateInfo[] {
  return (runners.maskingTemplates?.() ?? []).map((template) => ({
    id: template.id,
    name: template.name,
    builtIn: template.builtIn,
    objects: maskedObjectsOf(template),
  }));
}

function checkAnonymize(runners: PipelineStepRunners): StepCheck {
  return (step, context) => {
    const who = `Anonymize step "${step.name}"`;
    if (!runners.anonymize || !runners.maskingTemplates) {
      return `${who} cannot run here: DataOps is not available in this window.`;
    }
    const config = step.config ?? {};
    const problem = orgProblem(runners, who, config['orgId'], 'the org it masks');
    if (problem) return problem;
    const templateId = text(config['templateId']);
    if (templateId === undefined) {
      return `${who} names no masking template: choose the one it masks with.`;
    }
    const orgId = String(config['orgId']);
    const templates = runners.maskingTemplates();
    const object = text(config['object']);
    const where = text(config['where']);
    const chosen = pipelineMaskingAsked(
      {
        orgId,
        templateId,
        ...(object !== undefined ? { object } : {}),
        ...(where !== undefined ? { where } : {}),
        ...(step.retries !== undefined ? { retries: step.retries } : {}),
      },
      (id) => templates.some((template) => template.id === id),
    );
    if ('refusal' in chosen) return `${who}: ${chosen.refusal.message}`;
    return writeVerdictProblem(runners, who, orgId, 'masks', context);
  };
}

function anonymizeHandler(runners: PipelineStepRunners): StepHandler {
  return async (step: PipelineStep, context: StepContext) => {
    const startTime = new Date().toISOString();
    const who = `Anonymize step "${step.name}"`;
    if (!runners.anonymize) {
      throw new Error(`${who} cannot run here: DataOps is not available in this window.`);
    }
    const object = text(step.config['object']);
    const where = text(step.config['where']);
    const { orgId, templateId } = pipelineAnonymizeStepConfigSchema.parse({
      orgId: step.config['orgId'],
      templateId: text(step.config['templateId']),
      ...(object !== undefined ? { object } : {}),
      ...(where !== undefined ? { where } : {}),
    });
    const org = runners.orgName(orgId) ?? orgId;
    let outcome: PipelineMaskingOutcome;
    try {
      outcome = await runners.anonymize(
        {
          orgId,
          templateId,
          ...(object !== undefined ? { object } : {}),
          ...(where !== undefined ? { where } : {}),
          ...(step.retries !== undefined ? { retries: step.retries } : {}),
          pipeline: { name: pipelineNameOf(context) },
          answer: givenAnswer(context),
        },
        context.signal,
      );
    } catch (err: unknown) {
      const code = refusalCode(err);
      if (code === undefined) throw err;
      const snapshot = (err as { snapshot?: { operationId?: unknown } }).snapshot;
      return failed(
        step,
        startTime,
        { orgId, templateId, code, ...(snapshot !== undefined ? { snapshot } : {}) },
        `${who}: ${(err as Error).message}` +
          (typeof snapshot?.operationId === 'string'
            ? ` The snapshot ${snapshot.operationId} it took keeps the values it wrote over, in ` +
              'clear, until it is deleted on the DataOps page.'
            : ''),
      );
    }
    const { result } = outcome;
    const kept = result.snapshot
      ? `the snapshot ${result.snapshot.operationId} keeps the values it wrote over, in clear, ` +
        'until it is deleted on the DataOps page, where a restore writes them back'
      : 'no snapshot was kept';
    const output: Record<string, unknown> = {
      orgId,
      templateId,
      ...(object !== undefined ? { object } : {}),
      ...(where !== undefined ? { where } : {}),
      operationId: outcome.operationId,
      status: result.status,
      recordsProcessed: result.recordsProcessed,
      recordsFailed: result.recordsFailed,
      recordsNotMasked: result.recordsNotMasked,
      objects: result.objects,
      ...(result.fieldsNotFound.length > 0 ? { fieldsNotFound: result.fieldsNotFound } : {}),
      ...(result.snapshot ? { snapshot: result.snapshot } : {}),
    };
    if (result.cancelled) {
      throw new StepCancelledError(
        `${who} was cancelled: it masked ${counted(result.recordsProcessed, 'record')} in ${org} ` +
          `before the stop, and ${result.recordsNotMasked} still hold their values; ${kept}.`,
      );
    }
    // Rows the org refused, or left unreached, still hold what the template
    // masks: the steps after it would go on as if the org were masked.
    const left = result.objects.filter((entry) => entry.notMasked > 0);
    if (result.recordsNotMasked > 0 || result.fieldsNotFound.length > 0) {
      const unmasked =
        left.length > 0
          ? `${left.map((entry) => `${entry.notMasked} of ${entry.objectApiName}`).join(', ')} ` +
            'still hold their values'
          : `${result.fieldsNotFound.map((f) => `${f.objectApiName}.${f.fieldApiName}`).join(', ')} ` +
            'masked nothing';
      return failed(
        step,
        startTime,
        output,
        `${who} masked ${org} and did not complete: ${unmasked}; ${kept}.`,
      );
    }
    const scope =
      object !== undefined
        ? where !== undefined
          ? `the ${object} rows where ${where}`
          : `every ${object} row`
        : `every row of ${result.objects.map((entry) => entry.objectApiName).join(', ')}`;
    return completed(
      step,
      startTime,
      output,
      `Masked ${counted(result.recordsProcessed, 'record')} in ${org}, ${scope}; ${kept}.`,
    );
  };
}

function checkCheckpoint(runners: PipelineStepRunners): StepCheck {
  return (step) => {
    const who = `Checkpoint step "${step.name}"`;
    if (!runners.takeCheckpoint) {
      return `${who} cannot run here: Checkpoints are not available in this window.`;
    }
    const config = step.config ?? {};
    const problem = orgProblem(runners, who, config['orgId'], 'the org it takes');
    if (problem) return problem;
    const orgId = String(config['orgId']);
    if ((runners.orgTier?.(orgId) ?? 'production') === 'production') {
      return (
        `${who} names ${runners.orgName(orgId) ?? orgId}, a production org or one SandForge ` +
        'cannot tell is not: SandForge takes no checkpoint of one.'
      );
    }
    const parsed = pipelineCheckpointStepConfigSchema.safeParse(config);
    if (!parsed.success) return `${who} does not read (${firstIssue(parsed.error)}).`;
    return undefined;
  };
}

/** How many bytes, in the unit a person reads them in. */
function sizeOf(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function checkpointHandler(runners: PipelineStepRunners): StepHandler {
  return async (step: PipelineStep, context: StepContext) => {
    const startTime = new Date().toISOString();
    const who = `Checkpoint step "${step.name}"`;
    if (!runners.takeCheckpoint) {
      throw new Error(`${who} cannot run here: Checkpoints are not available in this window.`);
    }
    const config = pipelineCheckpointStepConfigSchema.parse(step.config);
    const org = runners.orgName(config.orgId) ?? config.orgId;
    let taken: CheckpointPipelineTakeOutcome;
    try {
      taken = await runners.takeCheckpoint(
        {
          config,
          origin: {
            pipeline: pipelineNameOf(context),
            step: step.name,
            trigger: runners.trigger ?? 'manual',
          },
        },
        context.signal,
      );
    } catch (err: unknown) {
      if (!(err instanceof CheckpointStepRefused)) throw err;
      return failed(step, startTime, { orgId: config.orgId, code: err.code }, err.message);
    }
    const moved = taken.movedWhileTaken;
    const movedCount = moved.changed + moved.deleted + moved.created;
    return completed(
      step,
      startTime,
      {
        orgId: config.orgId,
        operationId: taken.operationId,
        checkpointId: taken.checkpointId,
        name: taken.name,
        records: taken.records,
        objects: taken.objects,
        bytes: taken.bytes,
        movedWhileTaken: moved,
      },
      `Took the checkpoint '${taken.name}' of ${org}: ${counted(taken.records, 'record')} of ` +
        `${counted(taken.objects, 'object')}, ${sizeOf(taken.bytes)} on this machine, ` +
        (config.keepDays === 0
          ? 'kept until it is deleted'
          : `kept ${counted(config.keepDays, 'day')}`) +
        (movedCount > 0 ? `; ${counted(movedCount, 'record')} changed while it was taken.` : '.'),
    );
  };
}

/** Why a checkpoint a Rewind step names cannot be rewound to, as a clause that goes on from its name. */
const CHECKPOINT_UNUSABLE: Readonly<Record<CheckpointInvalidReason, string>> = {
  damaged: 'whose file cannot be read: it can only be deleted',
  taking: 'whose take is under way or never ended',
  failed: 'whose take failed: it can only be deleted',
  refreshed:
    'of the org a sandbox was before its refresh: the sandbox is another org now, and the ' +
    'checkpoint can only be deleted. Take a checkpoint of it again, and choose it',
  scratchExpired: 'of a scratch org that has expired: it can only be deleted',
};

/**
 * Why the checkpoint a Rewind step names cannot be rewound to, as read from
 * this machine before the run, or undefined when it can — or was not read,
 * which leaves it to the run.
 */
function checkpointProblem(
  runners: PipelineStepRunners,
  who: string,
  orgId: string,
  checkpointId: string,
): { why: NonNullable<PipelineRewindStepInfo['why']>; problem: string } | undefined {
  const kept = runners.checkpointKept?.(checkpointId);
  if (kept === undefined) return undefined;
  if (!kept.kept) {
    return {
      why: 'missing',
      problem:
        `${who} rewinds to the checkpoint ${checkpointId}, which is not kept on this machine: ` +
        'it was deleted or expired, or the pipeline came from another machine. Take a ' +
        'checkpoint here, choose it, and confirm the step again.',
    };
  }
  const named = kept.name !== undefined ? `'${kept.name}'` : checkpointId;
  if (!kept.valid) {
    const why = kept.why ?? 'damaged';
    return {
      why,
      problem: `${who} rewinds to the checkpoint ${named}, ${CHECKPOINT_UNUSABLE[why]}.`,
    };
  }
  const ids = runners.organizationIdsOf?.(orgId) ?? [];
  if (
    kept.organizationId !== undefined &&
    !ids.some((id) => sameOrganization(id, kept.organizationId))
  ) {
    return {
      why: 'otherOrg',
      problem:
        `${who} rewinds ${runners.orgName(orgId) ?? orgId} to the checkpoint ${named}, which ` +
        'was taken of another org.',
    };
  }
  return undefined;
}

function checkRewind(runners: PipelineStepRunners): StepCheck {
  return (step) => {
    const who = `Rewind step "${step.name}"`;
    if (!runners.rewind || !runners.rewindGrant) {
      return `${who} cannot run here: Checkpoints are not available in this window.`;
    }
    const config = step.config ?? {};
    const problem = orgProblem(runners, who, config['orgId'], 'the org it rewinds');
    if (problem) return problem;
    const orgId = String(config['orgId']);
    if ((runners.orgTier?.(orgId) ?? 'production') === 'production') {
      return (
        `${who} writes to ${runners.orgName(orgId) ?? orgId}, a production org or one SandForge ` +
        'cannot tell is not: SandForge rewinds none.'
      );
    }
    const parsed = pipelineRewindStepConfigSchema.safeParse(config);
    if (!parsed.success) return `${who} does not read (${firstIssue(parsed.error)}).`;
    const retries = retriesProblem(
      step,
      who,
      'a second try would read the org after the first one wrote, with nobody to read its preview',
    );
    if (retries) return retries;
    // Kept on this machine for the configuration the run holds: an edit not
    // saved, or saved since the confirmation, is no confirmed rewind.
    const granted = runners.rewindGrant(runners.pipelineId ?? '', step);
    if ('refusal' in granted) return grantRefusalWords(step.name, granted.refusal);
    return checkpointProblem(runners, who, orgId, parsed.data.checkpointId)?.problem;
  };
}

/** How many records a rewind wrote, by what it did to them. */
function rewound(result: RewindResult): {
  deleted: number;
  gaveBack: number;
  broughtBack: number;
  madeAgain: number;
} {
  return {
    deleted: result.deleted.reduce((sum, object) => sum + object.deleted, 0),
    gaveBack: result.restored.reduce(
      (sum, object) => sum + object.restored + (object.restoredWithout ?? 0),
      0,
    ),
    broughtBack: result.undeleted.reduce((sum, object) => sum + object.undeleted, 0),
    madeAgain: (result.recreated ?? []).reduce((sum, object) => sum + object.created, 0),
  };
}

/** What a rewind did, in the words of its result. */
function rewoundWords(result: RewindResult): string {
  const done = rewound(result);
  return (
    `${done.deleted} deleted, ${done.gaveBack} given their values back, ` +
    `${done.broughtBack} brought back from the recycle bin` +
    (done.madeAgain > 0 ? `, ${done.madeAgain} made again with new Ids` : '')
  );
}

/** Until when Undo, on the Checkpoints page, takes a rewind back, as a clause. */
function undoWords(result: RewindResult): string {
  return result.undo
    ? `Undo on the Checkpoints page takes it back until ${result.undo.until}`
    : 'it wrote nothing Undo would take back';
}

function rewindHandler(runners: PipelineStepRunners): StepHandler {
  return async (step: PipelineStep, context: StepContext) => {
    const startTime = new Date().toISOString();
    const who = `Rewind step "${step.name}"`;
    if (!runners.rewind || !runners.rewindGrant) {
      throw new Error(`${who} cannot run here: Checkpoints are not available in this window.`);
    }
    const config = pipelineRewindStepConfigSchema.parse(step.config);
    // Read again here: the confirmation can be taken back, by a save in
    // another window, while the steps before this one run.
    const granted = runners.rewindGrant(context.pipelineId, step);
    if ('refusal' in granted) {
      return failed(
        step,
        startTime,
        { orgId: config.orgId, checkpointId: config.checkpointId, code: 'NOT_CONFIRMED' },
        grantRefusalWords(step.name, granted.refusal),
      );
    }
    const org = runners.orgName(config.orgId) ?? config.orgId;
    let outcome: CheckpointPipelineRewindOutcome;
    try {
      outcome = await runners.rewind(
        {
          config,
          grant: granted.grant,
          origin: {
            pipeline: pipelineNameOf(context),
            step: step.name,
            trigger: runners.trigger ?? 'manual',
          },
        },
        context.signal,
      );
    } catch (err: unknown) {
      if (!(err instanceof CheckpointStepRefused)) throw err;
      return failed(
        step,
        startTime,
        {
          orgId: config.orgId,
          checkpointId: config.checkpointId,
          code: err.code,
          ...(err.result ? { status: err.result.status, ...rewound(err.result) } : {}),
        },
        err.message,
      );
    }
    const { result } = outcome;
    const left = result.residual.reduce((sum, residual) => sum + residual.count, 0);
    const output: Record<string, unknown> = {
      orgId: config.orgId,
      checkpointId: outcome.checkpointId,
      operationId: outcome.operationId,
      rewindId: result.rewindId,
      status: result.status,
      ...rewound(result),
      residual: left,
      ...(result.undo ? { undoUntil: result.undo.until } : {}),
      apiRequests: result.apiRequests.used,
    };
    if (result.status === 'cancelled') {
      throw new StepCancelledError(
        `${who} was stopped part way in ${org}: ${rewoundWords(result)}; ${undoWords(result)}.`,
      );
    }
    if (result.status !== 'success') {
      return failed(
        step,
        startTime,
        output,
        `${who} rewound ${org} and did not complete (${result.status}): ${rewoundWords(result)}; ` +
          `${counted(left, 'record')} still ${left === 1 ? 'differs' : 'differ'} from the checkpoint` +
          (result.unread && result.unread.length > 0
            ? `, and ${result.unread.map((unread) => unread.objectApiName).join(', ')} could not be read`
            : '') +
          `; ${undoWords(result)}.`,
      );
    }
    return completed(
      step,
      startTime,
      output,
      `Rewound ${org} to the checkpoint ${outcome.checkpointId}: ${rewoundWords(result)}, with ` +
        `${counted(result.apiRequests.used, 'API request')}; ${undoWords(result)}.`,
    );
  };
}

/**
 * A Rewind step of a saved pipeline as the extension sees it on this
 * machine: whether its checkpoint can be rewound to, and the confirmation
 * kept for it, with whether it was given for the configuration as saved.
 * @param checkpoint - Its checkpoint as read from this machine; undefined
 *   when its configuration names none that reads
 * @param kept - The confirmation kept for it, if one is
 */
export function rewindStepInfo(
  runners: PipelineStepRunners,
  step: Pick<PipelineStep, 'id' | 'config'>,
  checkpoint: RewindCheckpoint | undefined,
  kept: { grantedAt: string; matches: boolean } | undefined,
): PipelineRewindStepInfo {
  const granted = kept ? { granted: { at: kept.grantedAt, digestMatches: kept.matches } } : {};
  const parsed = pipelineRewindStepConfigSchema.safeParse(step.config ?? {});
  if (!parsed.success) return { stepId: step.id, valid: false, why: 'config', ...granted };
  const { orgId, checkpointId } = parsed.data;
  const problem = checkpointProblem(
    { ...runners, checkpointKept: () => checkpoint },
    'The step',
    orgId,
    checkpointId,
  );
  return {
    stepId: step.id,
    checkpointId,
    valid: problem === undefined,
    ...(problem ? { why: problem.why } : {}),
    ...granted,
  };
}

/**
 * Give `executor` the Backup, Compare, Pre-check, Notification, Approval,
 * Sync, Seed, Anonymize, Checkpoint and Rewind steps, each with the check
 * that reads its configuration before the run.
 * @param executor - The step executor of one run
 * @param runners - The flows the steps run on
 */
export function registerPipelineSteps(executor: StepExecutor, runners: PipelineStepRunners): void {
  executor.registerHandler('backup', backupHandler(runners), checkBackup(runners));
  executor.registerHandler('compare', compareHandler(runners), checkCompare(runners));
  executor.registerHandler('precheck', precheckHandler(runners), checkPrecheck(runners));
  executor.registerHandler(
    'notification',
    notificationHandler(runners),
    checkNotification(runners),
  );
  executor.registerHandler('approval', approvalHandler(runners), checkApproval(runners));
  executor.registerHandler('sync', syncHandler(runners), checkSync(runners));
  executor.registerHandler('seed', seedHandler(runners), checkSeed(runners));
  executor.registerHandler('anonymize', anonymizeHandler(runners), checkAnonymize(runners));
  executor.registerHandler('checkpoint', checkpointHandler(runners), checkCheckpoint(runners));
  executor.registerHandler('rewind', rewindHandler(runners), checkRewind(runners));
}
