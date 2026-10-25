/**
 * Taking an environment back from an org: each resource's own removal, the
 * last applied first, into the recycle bin.
 *
 * Every resource the state holds is taken back through the script that
 * wrote it — `sandforge-seed --remove … --json`, from the summary its run
 * printed, or from its run file for a run stopped before it printed one;
 * `sandforge-clone --remove … --json`, from the summary its run wrote as it
 * went — each before the resources it depended on when it was applied: the removal
 * keeps a record while records that stay hang from it, so taking the
 * accounts back before the contacts under them would keep every account.
 *
 * What a removal cannot take back is named, and the destroy exits 3, the
 * state kept with what is left for the next destroy:
 *
 * - records others changed since the apply, kept unless `--include-changed`,
 *   which takes them, and what was created under them since;
 * - records that stay because records of the org depend on them;
 * - what the org's automation created as the records went in, unless
 *   `--sweep` takes it, as the run's user, in each run's window;
 * - what the platform does not take back: a person's contact apart from its
 *   account, a lead converted since, a contract activated since.
 *
 * A removal refused before it deletes — the org runs automation as records
 * go and the line gave no `--accept-automation`, a user who may not delete
 * some objects — stops the destroy there, before the resources that
 * resource depended on: their records would be kept for it anyway. Once
 * every resource is taken back whole, the state stays, every resource in it
 * destroyed: the next apply creates them again. Deleted, it left the next
 * apply to a Developer Edition org or a sandbox with no state, refused
 * without --accept-no-state as if a cache had been lost: a pipeline that
 * destroys after each run gave the flag every time, and the refusal kept
 * nothing apart.
 *
 * A destroy is not undone as a whole: children deleted before their parent
 * cannot come back with it from the recycle bin. It is undone by applying
 * again.
 */

import type { EnvPlan, EnvRunResult, EnvState, EnvStepResult } from '@sandforge/shared';
import { DONE_EXIT, FAILED_EXIT, PARTIAL_EXIT, worstExit } from '../exitCodes.js';
import { onStopSignal, stopExitCode, type StopSignal } from '../stopSignals.js';
import type { EnvFileResolved } from './envFile.js';
import { checkpointActRefusal, lockRefusal, type EnvTarget } from './envGuards.js';
import { acquireEnvLock, checkpointLockRefusal } from './envLock.js';
import { liveResources, removalOrder } from './envPlan.js';
import {
  isStopCode,
  removeResource,
  statusOf,
  type EnvRunOutcome,
  type EnvStepDeps,
} from './envApply.js';
import { EnvStateError } from './envState.js';

/** What a destroy is given beside its plan. */
export interface EnvDestroyInput {
  /** What it would take back, as the plan of the destruction says it. */
  plan: EnvPlan;
  resolved: EnvFileResolved;
  target: EnvTarget;
  /** The state as the plan read it; undefined when there was none. */
  state: EnvState | undefined;
  /** Take also the records changed since apply, and what was created under them since. */
  includeChanged: boolean;
  /** Take also what the org's automation created during each run, as its user. */
  sweep: boolean;
  /** Delete although the org runs automation as records go. */
  acceptAutomation: boolean;
}

/** The order a destroy takes a state's resources back in: the last applied first. */
export function destroyOrder(state: EnvState | undefined): string[] {
  return removalOrder(
    state,
    liveResources(state).map(([name]) => name),
  );
}

/**
 * Take back every resource the state holds: see the module's comment. With
 * no state, or one whose resources were all taken back, nothing is reached:
 * the state, if any, is deleted.
 */
export async function destroyEnvironment(
  deps: EnvStepDeps,
  input: EnvDestroyInput,
): Promise<EnvRunOutcome> {
  const { plan, target, resolved } = input;
  const env = resolved.checked.file.name;
  const refused = (refusal: string): EnvRunOutcome => ({
    result: {
      plan,
      steps: [],
      status: 'failure',
      refusal,
      state: { serial: input.state?.serial ?? 0 },
    },
    exitCode: FAILED_EXIT,
  });
  if (input.state === undefined) {
    deps.say(
      `this machine keeps no state of ${env} on ${target.alias}: there is nothing to take back`,
    );
    return {
      result: { plan, steps: [], status: 'success', state: { serial: 0 } },
      exitCode: DONE_EXIT,
    };
  }
  if (plan.refusal !== undefined) return refused(plan.refusal);
  const order = destroyOrder(input.state);

  const taken = acquireEnvLock(
    deps.locksDir,
    target.organizationId,
    { operation: 'destroy', env, alias: target.alias },
    deps.lockOptions,
  );
  if ('busy' in taken) return refused(lockRefusal(taken.busy).message);
  const stop = new AbortController();
  let stoppedBy: StopSignal | undefined;
  const release = (deps.onStop ?? onStopSignal)((signal) => {
    stoppedBy = signal;
    deps.say(
      `\nstopped by ${signal}: the removal under way stops before its next call to the org; ` +
        'destroy again takes up from the state',
    );
    stop.abort();
  });
  try {
    let current: EnvState;
    try {
      const read = await deps.store.read(target.organizationId, env);
      if (
        read === undefined ||
        read.serial !== input.state.serial ||
        read.lineage !== input.state.lineage
      ) {
        return refused(
          `The state of ${env} on ${target.alias} changed since the plan of the destruction ` +
            '(another apply or destroy ran, or a cache put back another state). Nothing was ' +
            'deleted: run destroy again.',
        );
      }
      current = read;
    } catch (err: unknown) {
      if (err instanceof EnvStateError) return refused(err.message);
      throw err;
    }

    const steps: EnvStepResult[] = [];
    const skipped: Array<{ resource: string; why: string }> = [];
    const codes: number[] = [];
    let wrote = false;
    let stoppedCode: number | undefined;
    let stoppedAt: number | undefined;
    for (const [index, resource] of order.entries()) {
      if (stoppedBy !== undefined || stoppedCode !== undefined) {
        stoppedAt ??= index;
        break;
      }
      const busy = checkpointLockRefusal(deps.locksDir, target.organizationId, deps.lockOptions);
      if (busy !== undefined) {
        deps.say(checkpointActRefusal(busy).message);
        codes.push(FAILED_EXIT);
        stoppedAt = index;
        break;
      }
      const accept =
        input.acceptAutomation ||
        resolved.checked.file.resources[resource]?.accept?.automation === true;
      const ended = await removeResource(
        deps,
        current,
        {
          resource,
          action: 'delete',
          target,
          includeChanged: input.includeChanged,
          sweep: input.sweep,
          acceptAutomation: accept,
          ends: { whole: 'destroyed', left: 'partial' },
        },
        stop.signal,
      );
      current = ended.state;
      steps.push(...ended.steps);
      wrote ||= ended.wrote;
      if (isStopCode(ended.code)) {
        stoppedCode = ended.code;
        stoppedAt = index + 1;
        break;
      }
      codes.push(ended.code);
      // Refused or failed: the resources it depended on would keep their
      // records for it.
      if (ended.code !== DONE_EXIT && ended.code !== PARTIAL_EXIT) {
        stoppedAt = index + 1;
        break;
      }
    }
    for (const resource of stoppedAt !== undefined ? order.slice(stoppedAt) : []) {
      skipped.push({
        resource,
        why:
          stoppedBy !== undefined || stoppedCode !== undefined
            ? 'the destroy was stopped before it'
            : 'a removal before it was refused or failed: its records would be kept for it',
      });
    }

    const whole = Object.values(current.resources).every((r) => r.status === 'destroyed');
    if (whole && stoppedAt === undefined) {
      deps.say(
        `every record of ${env} is taken back from ${target.alias}: the state keeps it as ` +
          'destroyed, and the next apply creates it again',
      );
    }
    const exitCode =
      stoppedBy !== undefined
        ? stopExitCode(stoppedBy)
        : stoppedCode !== undefined
          ? stoppedCode
          : (() => {
              const worst = worstExit(codes);
              return worst === FAILED_EXIT && wrote ? PARTIAL_EXIT : worst;
            })();
    const result: EnvRunResult = {
      plan,
      steps,
      ...(skipped.length > 0 ? { skipped } : {}),
      status: statusOf(exitCode),
      state: { serial: current.serial },
    };
    return { result, exitCode };
  } finally {
    release();
    taken.lock.release();
  }
}
