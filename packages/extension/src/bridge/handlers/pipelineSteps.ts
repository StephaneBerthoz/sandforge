import type {
  CompareResult,
  PipelineApprovalRecord,
  PipelineStep,
  PipelineStepResult,
  PipelineSyncConfigInfo,
  SyncConfig,
  SyncExecutionResult,
} from '@sandforge/shared';
import {
  APPROVAL_DEFAULT_TIMEOUT_MINUTES,
  APPROVAL_MAX_MESSAGE_LENGTH,
  APPROVAL_MAX_TIMEOUT_MINUTES,
  COMPARE_DIFFERENCE_COUNT,
  PRECHECK_VARIABLES,
  approvalDefect,
  approvalTimeoutMinutes,
} from '@sandforge/shared';
import * as z from 'zod';
import type { GivenAnswer } from '../../core/precheck/ProductionGuard.js';
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
import type { BackupTaken } from './DataOpsHandler.js';
import {
  compareExecutePayloadSchema,
  dataOpsBackupPayloadSchema,
  orgIdSchema,
  sfApiNameSchema,
  syncExecutePayloadSchema,
} from '../validatePayload.js';

/**
 * The pipeline steps that run through a module's own flow: Backup takes a
 * DataOps snapshot, Compare runs the Compare page's diff, Pre-check reads the
 * Monitor's health signals, Notification shows a VS Code notification,
 * Approval waits for a person's answer in VS Code, and Sync runs a saved Sync
 * configuration.
 *
 * Sync is the one step that writes to an org, and it writes only as Sync's
 * own run does: the configuration saved on the Sync page, through the run its
 * schedule makes, which consults Production Guard. A pipeline may run where
 * nobody watches, so a Sync step whose target the guard asks about — a
 * production org, a Developer Edition — is refused before the run unless an
 * Approval step comes before it; the person's answer to that step is the
 * answer the guard takes, and the guard shows nothing. Seed, Restore,
 * Anonymize and Delete are not here: each runs from its own page.
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
}

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

/**
 * Give `executor` the Backup, Compare, Pre-check, Notification, Approval and
 * Sync steps, each with the check that reads its configuration before the run.
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
}
