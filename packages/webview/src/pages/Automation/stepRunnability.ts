import type { PipelineStep, PipelineStepType } from '@sandforge/shared';
import { conditionDefect } from '@sandforge/shared';

/**
 * The step types a pipeline built on this page can run.
 *
 * The extension runs Delay and Condition, and runs Backup, Compare, Pre-check
 * and Notification through the modules that own their work: a DataOps
 * snapshot, the Compare page's diff, the Monitor's health signals, a VS Code
 * notification. It refuses every other type before the pipeline starts. This
 * page says so with the same list, and reads each step's configuration the
 * way the extension does: a list stricter than the extension's only ever
 * keeps a pipeline from being sent, and a looser one would send pipelines to
 * be refused.
 */
const RUNNABLE_STEP_TYPES: ReadonlySet<string> = new Set<PipelineStepType>([
  'delay',
  'condition',
  'backup',
  'compare',
  'precheck',
  'notification',
]);

/**
 * The step types that write to an org. Each runs from its own page, where
 * Production Guard stops or asks before a write to a production org; a
 * pipeline runs unattended, with nobody there to answer, so it runs none.
 */
const WRITES_TO_AN_ORG: ReadonlySet<string> = new Set<PipelineStepType>([
  'seed',
  'sync',
  'restore',
  'anonymize',
  'delete',
]);

/** The checks a Pre-check step can run: the Monitor's health signals. */
export const PRECHECK_CHECKS = ['apiLimits', 'storage', 'recentErrors', 'failedJobs'] as const;

/** A check a Pre-check step can run. */
export type PrecheckCheck = (typeof PRECHECK_CHECKS)[number];

/** The longest wait the extension accepts for a Delay step: 24 days, in seconds. */
const MAX_DELAY_SECONDS = 24 * 24 * 60 * 60;

/** The longest timeout the extension accepts for a step: the same 24 days, in milliseconds. */
export const MAX_STEP_TIMEOUT_MS = MAX_DELAY_SECONDS * 1000;

/** The most objects one backup takes, as the DataOps request allows. */
const MAX_BACKUP_OBJECTS = 100;

/** The most component types one comparison lists, as the Compare request allows. */
const MAX_COMPARE_TYPES = 50;

/** The longest message a Notification step shows. */
export const MAX_NOTIFICATION_LENGTH = 500;

/** A Salesforce object API name, as the extension checks one. */
const API_NAME = /^[A-Za-z][A-Za-z0-9_]*$/;

/** Why a step cannot run, as its key under `automation.runnability`. */
export type StepBlocker =
  | 'writesToOrg'
  | 'typeCannotRun'
  | 'conditionNeedsCondition'
  | 'delayNeedsSeconds'
  | 'timeoutTooLong'
  | 'needsOrg'
  | 'orgNotConnected'
  | 'backupNeedsObjects'
  | 'compareNeedsOrgs'
  | 'compareNeedsTypes'
  | 'precheckNeedsChecks'
  | 'notificationNeedsMessage';

/** A step that keeps its pipeline from running, and why. */
export interface BlockedStep {
  stepId: string;
  stepName: string;
  stepType: PipelineStepType;
  blocker: StepBlocker;
}

/**
 * Whether `value` is a wait the extension accepts: a number from 0 up to 24
 * days, counted in units of which `unitsPerSecond` make a second.
 */
function isWait(value: unknown, unitsPerSecond: number): boolean {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= MAX_DELAY_SECONDS * unitsPerSecond
  );
}

/** The entries of `value` when it is a non-empty list, else nothing. */
function listed(value: unknown): unknown[] | undefined {
  return Array.isArray(value) && value.length > 0 ? value : undefined;
}

/**
 * Why a step of `type` cannot run in a pipeline, however it is configured, or
 * undefined when the type runs. `type` is a plain string because the
 * Marketplace names step types this page has no label for.
 */
export function typeBlocker(type: string): StepBlocker | undefined {
  if (RUNNABLE_STEP_TYPES.has(type)) return undefined;
  return WRITES_TO_AN_ORG.has(type) ? 'writesToOrg' : 'typeCannotRun';
}

/**
 * Why the palette will not add a step of `type`: its type cannot run, or, for
 * Condition, this page cannot give it a condition. A Condition step from a
 * Marketplace template carries its own, and runs.
 */
export function paletteBlocker(type: PipelineStepType): StepBlocker | undefined {
  return typeBlocker(type) ?? (type === 'condition' ? 'conditionNeedsCondition' : undefined);
}

/**
 * What is wrong with the org a step names, or undefined when it names one of
 * `orgIds`. With no `orgIds` known, any org id passes: the extension still
 * checks it against the orgs it has registered.
 */
function orgBlocker(orgId: unknown, orgIds?: ReadonlySet<string>): StepBlocker | undefined {
  if (typeof orgId !== 'string' || orgId.trim() === '') return 'needsOrg';
  if (orgIds && !orgIds.has(orgId)) return 'orgNotConnected';
  return undefined;
}

/**
 * Why `step` cannot run as configured, or undefined when it can.
 *
 * - A Delay step needs its wait: the Step Config Panel writes `seconds`, and
 *   the step library declares `durationMs`, which the extension reads when
 *   `seconds` is absent.
 * - A Condition step needs a condition the extension can evaluate.
 * - Backup needs an org and the API names of its objects; Compare two
 *   different orgs and at least one component type; Pre-check an org and at
 *   least one check it knows; Notification its message.
 * - Any step's timeout must fit in a timer: at most 24 days.
 * @param step - The step to read
 * @param orgIds - The ids of the orgs connected here, when known
 */
export function stepBlocker(
  step: Pick<PipelineStep, 'type' | 'config' | 'timeout' | 'condition'>,
  orgIds?: ReadonlySet<string>,
): StepBlocker | undefined {
  const blocker = typeBlocker(step.type);
  if (blocker !== undefined) return blocker;
  if (
    step.timeout !== undefined &&
    (typeof step.timeout !== 'number' ||
      !Number.isFinite(step.timeout) ||
      step.timeout > MAX_STEP_TIMEOUT_MS)
  ) {
    return 'timeoutTooLong';
  }
  // A pipeline read back from storage is not checked against its type: a
  // step saved without a config has none.
  const config: Record<string, unknown> = step.config ?? {};
  switch (step.type) {
    case 'delay': {
      const seconds = config['seconds'];
      const waits = seconds === undefined ? isWait(config['durationMs'], 1000) : isWait(seconds, 1);
      return waits ? undefined : 'delayNeedsSeconds';
    }
    case 'condition':
      return conditionDefect(step.condition) === undefined ? undefined : 'conditionNeedsCondition';
    case 'backup': {
      const org = orgBlocker(config['orgId'], orgIds);
      if (org) return org;
      const objects = listed(config['objects']);
      const named =
        objects !== undefined &&
        objects.length <= MAX_BACKUP_OBJECTS &&
        objects.every(
          (name) => typeof name === 'string' && name.length <= 80 && API_NAME.test(name),
        );
      return named ? undefined : 'backupNeedsObjects';
    }
    case 'compare': {
      const org =
        orgBlocker(config['sourceOrgId'], orgIds) ?? orgBlocker(config['targetOrgId'], orgIds);
      if (org === 'needsOrg') return 'compareNeedsOrgs';
      if (org) return org;
      if (config['sourceOrgId'] === config['targetOrgId']) return 'compareNeedsOrgs';
      const types = listed(config['types']);
      const named =
        types !== undefined &&
        types.length <= MAX_COMPARE_TYPES &&
        types.every((type) => typeof type === 'string' && type.length > 0 && type.length <= 80);
      return named ? undefined : 'compareNeedsTypes';
    }
    case 'precheck': {
      const org = orgBlocker(config['orgId'], orgIds);
      if (org) return org;
      const checks = listed(config['checks']);
      const known =
        checks !== undefined &&
        new Set(checks).size === checks.length &&
        checks.every((check) => (PRECHECK_CHECKS as readonly unknown[]).includes(check));
      return known ? undefined : 'precheckNeedsChecks';
    }
    case 'notification': {
      const message = config['message'];
      return typeof message === 'string' &&
        message.trim() !== '' &&
        message.trim().length <= MAX_NOTIFICATION_LENGTH
        ? undefined
        : 'notificationNeedsMessage';
    }
    default:
      return undefined;
  }
}

/**
 * Every step of `steps` that keeps the pipeline from running, in pipeline order.
 * @param steps - The pipeline's steps
 * @param orgIds - The ids of the orgs connected here, when known
 */
export function blockedSteps(
  steps: readonly PipelineStep[],
  orgIds?: ReadonlySet<string>,
): BlockedStep[] {
  return steps.flatMap((step) => {
    const blocker = stepBlocker(step, orgIds);
    return blocker === undefined
      ? []
      : [{ stepId: step.id, stepName: step.name, stepType: step.type, blocker }];
  });
}
