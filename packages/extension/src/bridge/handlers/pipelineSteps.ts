import type { CompareResult, PipelineStep, PipelineStepResult } from '@sandforge/shared';
import { z } from 'zod';
import type {
  StepCheck,
  StepContext,
  StepExecutor,
  StepHandler,
} from '../../modules/automation/StepExecutor.js';
import type { HealthSignal } from '../../modules/monitor/HealthCheck.js';
import type { HealthSignalName } from '../../modules/monitor/MonitorOpsFactory.js';
import type { BackupTaken } from './DataOpsHandler.js';
import {
  compareExecutePayloadSchema,
  dataOpsBackupPayloadSchema,
  orgIdSchema,
  sfApiNameSchema,
} from '../validatePayload.js';

/**
 * The pipeline steps that run through a module's own flow: Backup takes a
 * DataOps snapshot, Compare runs the Compare page's diff, Pre-check reads the
 * Monitor's health signals, Notification shows a VS Code notification.
 *
 * None of them writes to an org. Backup and Pre-check read one, Compare reads
 * two, and a snapshot is written to local storage only. The steps that write
 * — Seed, Sync, Restore, Anonymize, Delete — are not here: each goes through
 * its module's Production Guard and a confirmation asked of the person at the
 * panel, and a pipeline runs unattended.
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
  apiLimits: { variable: 'apiUsagePercent', read: (signal) => signal.percent },
  storage: { variable: 'storageUsagePercent', read: (signal) => signal.percent },
  recentErrors: { variable: 'recentErrorCount', read: (signal) => signal.count },
  failedJobs: { variable: 'failedJobCount', read: (signal) => signal.count },
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
    return completed(
      step,
      startTime,
      {
        sourceOrgId,
        targetOrgId,
        types,
        summary: result.summary,
        content: result.content,
      },
      `Compared ${counted(types.length, 'component type')} of ${source} with ${target}: ` +
        `${added} added, ${removed} removed, ${modified} modified, ${unchanged} unchanged, ` +
        `${notCompared} not compared.`,
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

/**
 * Give `executor` the Backup, Compare, Pre-check and Notification steps, each
 * with the check that reads its configuration before the run.
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
}
