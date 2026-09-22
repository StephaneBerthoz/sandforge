import type { PipelineStep, PipelineStepType } from '@sandforge/shared';

/**
 * The step types a pipeline built on this page can run.
 *
 * The extension's `StepExecutor` runs Delay and Condition and refuses every
 * other type before the pipeline starts. Condition is left out here too:
 * nothing on this page sets a step's condition, and a run started here carries
 * no variables for one to test, so the extension refuses every Condition step
 * this page can build. A list stricter than the extension's only ever keeps a
 * pipeline from being sent; a looser one would send pipelines to be refused.
 */
const RUNNABLE_STEP_TYPES: ReadonlySet<string> = new Set<PipelineStepType>(['delay']);

/** The longest wait the extension accepts for a Delay step: 24 days, in seconds. */
const MAX_DELAY_SECONDS = 24 * 24 * 60 * 60;

/** Why a step cannot run, as its key under `automation.runnability`. */
export type StepBlocker = 'typeCannotRun' | 'conditionCannotRun' | 'delayNeedsSeconds';

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

/**
 * Why a step of `type` cannot run in a pipeline yet, however it is configured,
 * or undefined when the type runs. `type` is a plain string because the
 * Marketplace names step types this page has no label for.
 */
export function typeBlocker(type: string): StepBlocker | undefined {
  if (RUNNABLE_STEP_TYPES.has(type)) return undefined;
  return type === 'condition' ? 'conditionCannotRun' : 'typeCannotRun';
}

/**
 * Why `step` cannot run as configured, or undefined when it can. A Delay step
 * needs its wait: the Step Config Panel writes `seconds`, and the step library
 * declares `durationMs`, which the extension reads when `seconds` is absent.
 */
export function stepBlocker(step: Pick<PipelineStep, 'type' | 'config'>): StepBlocker | undefined {
  const blocker = typeBlocker(step.type);
  if (blocker !== undefined) return blocker;
  if (step.type === 'delay') {
    // A pipeline read back from storage is not checked against its type: a
    // step saved without a config has none.
    const config: Record<string, unknown> | undefined = step.config;
    const seconds = config?.['seconds'];
    const waits = seconds === undefined ? isWait(config?.['durationMs'], 1000) : isWait(seconds, 1);
    if (!waits) return 'delayNeedsSeconds';
  }
  return undefined;
}

/** Every step of `steps` that keeps the pipeline from running, in pipeline order. */
export function blockedSteps(steps: readonly PipelineStep[]): BlockedStep[] {
  return steps.flatMap((step) => {
    const blocker = stepBlocker(step);
    return blocker === undefined
      ? []
      : [{ stepId: step.id, stepName: step.name, stepType: step.type, blocker }];
  });
}
