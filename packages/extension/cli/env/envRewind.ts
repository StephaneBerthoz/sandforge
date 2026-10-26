/**
 * Rewinding an org to one of its environment's checkpoints, by the checkpoint
 * script's own rewind (`sandforge-checkpoint rewind --json`):
 *
 * - **`reset`**, to the checkpoint taken after the last apply: what tests
 *   created, changed and deleted since is taken back, whoever made it, and
 *   the environment's records are back as applied, with their Ids. The state
 *   stays as it is: it names the same runs, and their records are in the org
 *   again. The pool pattern: one org per suite, reset between two suites.
 * - **`destroy --rewind`**, to the checkpoint taken before the first apply:
 *   the org as it was before the environment, everyone's work since taken
 *   back with it, not only the environment's records. On a dedicated CI org,
 *   the whole destroy; on a shared sandbox, the wrong one, and its question
 *   names who last changed what. Once it ended 0, every resource of the state
 *   is destroyed and the environment's checkpoints are deleted.
 *
 * Neither makes records again with new Ids (`--accept-recreate`): the state
 * would name Ids the org no longer holds. A record the recycle bin no longer
 * gives back is left, and named by the rewind.
 *
 * Each holds the environment lock of the org, as an apply does, so a reset
 * never runs under an apply's steps. The rewind's own exit code is the
 * command's: 0, 1 refused, 3 records still differ, 4 someone changed records
 * during it, or the stop's.
 */

import type {
  EnvCheckpointStep,
  EnvCheckpointStepResult,
  EnvRewindResult,
  EnvState,
} from '@sandforge/shared';
import { DONE_EXIT, FAILED_EXIT } from '../exitCodes.js';
import { onStopSignal, stopExitCode, type StopSignal } from '../stopSignals.js';
import type { EnvStepDeps } from './envApply.js';
import {
  CHECKPOINT_SCRIPT,
  changedByWords,
  checkpointRewindLine,
  checkpointsOfState,
  deleteEnvCheckpoint,
  envCheckpointStoreOf,
  rewindPreviewOf,
  rewindRanOf,
  rewindUndoOf,
  undoLine,
  withCheckpoint,
  type RewindPreview,
} from './envCheckpoints.js';
import type { EnvFileResolved } from './envFile.js';
import { lockRefusal, type EnvRefusal, type EnvTarget } from './envGuards.js';
import { acquireEnvLock } from './envLock.js';
import { EnvStateError } from './envState.js';

/** What a rewind of the environment is given. */
export interface EnvRewindInput {
  verb: 'reset' | 'destroy';
  resolved: EnvFileResolved;
  target: EnvTarget;
  /** The state as the command read it; undefined when there was none. */
  state: EnvState | undefined;
  /** Rewind although the org runs automation as records are written back: the line's. */
  acceptAutomation: boolean;
  /** Rewind although undo could not bring back some records it deletes: the line's. */
  acceptNoUndo: boolean;
}

/** The step of the checkpoint each verb rewinds to. */
const STEP_OF: Readonly<Record<EnvRewindInput['verb'], EnvCheckpointStep>> = {
  reset: 'after',
  destroy: 'before',
};

/** The checkpoint a verb rewinds to, as the state names it. */
export function rewindTargetOf(
  verb: EnvRewindInput['verb'],
  state: Pick<EnvState, 'checkpoints'> | undefined,
): { step: EnvCheckpointStep; checkpoint: string } | undefined {
  const step = STEP_OF[verb];
  const checkpoint = state?.checkpoints?.[step];
  return checkpoint !== undefined ? { step, checkpoint } : undefined;
}

/**
 * Why a verb may not rewind the org, before anything of it is read: no state
 * on this machine, no checkpoint of the step the verb rewinds to, or — for a
 * reset — a resource the last apply did not leave applied, which the
 * checkpoint before it no longer holds as the state names it.
 */
export function rewindRefusalOf(
  input: Pick<EnvRewindInput, 'verb' | 'resolved' | 'target' | 'state'>,
): EnvRefusal | undefined {
  const env = input.resolved.checked.file.name;
  const { alias } = input.target;
  const refused = (message: string): EnvRefusal => ({
    code: 'NO_CHECKPOINT',
    message: `${message} Nothing was written.`,
    exit: 1,
  });
  const verb = input.verb === 'reset' ? 'reset' : 'destroy --rewind';
  const state = input.state;
  if (state === undefined) {
    return refused(
      `This machine keeps no state of ${env} on ${alias}: ${verb} rewinds the org to a ` +
        'checkpoint its state names. Restore the journal directory of the apply, or apply first.',
    );
  }
  if (rewindTargetOf(input.verb, state) === undefined) {
    return refused(
      input.verb === 'reset'
        ? `The state of ${env} on ${alias} names no checkpoint taken after an apply: the file ` +
            'asks none (checkpoint.after), or the last apply did not take it. Apply with ' +
            'checkpoint.after in the file, then reset.'
        : `The state of ${env} on ${alias} names no checkpoint taken before its first apply: ` +
            'the file asked none (checkpoint.before: true) when it was first applied. destroy ' +
            'without --rewind takes back what the environment wrote.',
    );
  }
  // The checkpoint before the first apply holds, in clear, the values a
  // masking wrote over since: rewound to, the org would get them back.
  const masks = Object.entries(state.resources).filter(([, resource]) => resource.kind === 'mask');
  if (input.verb === 'destroy' && masks.length > 0) {
    return {
      code: 'MASKED',
      message:
        `The state of ${env} on ${alias} names mask resources (${masks.map(([name]) => name).join(', ')}): ` +
        'the checkpoint taken before the first apply holds the values they wrote over, and a ' +
        'rewind to it would put them back into the org. destroy never unmasks: destroy without ' +
        '--rewind takes back what the environment wrote, and leaves its maskings as they are. ' +
        'Nothing was written.',
      exit: 1,
    };
  }
  if (input.verb === 'reset') {
    const unwhole = Object.entries(state.resources).filter(
      ([, resource]) => resource.status !== 'applied' && resource.status !== 'destroyed',
    );
    if (unwhole.length > 0) {
      return refused(
        `${unwhole.map(([name, resource]) => `${name} is ${resource.status}`).join(', ')}: the ` +
          'last apply did not end whole, and the checkpoint taken after the apply before it no ' +
          'longer holds the environment the state names. Apply again, then reset.',
      );
    }
  }
  return undefined;
}

/** What a rewind's step reads and writes with. */
type RewindDeps = Pick<
  EnvStepDeps,
  'runner' | 'store' | 'locksDir' | 'journalDir' | 'say' | 'onStop' | 'lockOptions'
>;

/**
 * What the rewind would do, by its own preview (`rewind --dry-run`): what it
 * deletes, gives back and brings back, and who last changed it. Asked before
 * the question, which names them.
 */
export async function previewEnvRewind(
  deps: Pick<RewindDeps, 'runner' | 'journalDir' | 'say'>,
  input: EnvRewindInput,
  signal: AbortSignal,
): Promise<RewindPreview | { refusal: string }> {
  const to = rewindTargetOf(input.verb, input.state);
  if (to === undefined) return { refusal: 'no checkpoint to rewind to' };
  deps.say(`checkpoint ${to.checkpoint}: reading what a rewind to it would do`);
  const ran = await deps.runner(
    CHECKPOINT_SCRIPT,
    checkpointRewindLine({
      org: input.target.alias,
      store: envCheckpointStoreOf(deps.journalDir),
      checkpoint: to.checkpoint,
      dryRun: true,
      acceptAutomation: input.acceptAutomation,
      acceptNoUndo: input.acceptNoUndo,
    }),
    signal,
  );
  return rewindPreviewOf(ran);
}

const count = (n: number): string => n.toLocaleString('en-US');

/** The question a reset or a destroy --rewind asks before it writes: the alias, typed. */
export function rewindQuestionOf(
  input: Pick<EnvRewindInput, 'verb' | 'resolved' | 'target'>,
  preview: RewindPreview,
): string {
  const { alias } = input.target;
  const what =
    `it deletes ${count(preview.toDelete)} record(s) created since, gives ` +
    `${count(preview.toGiveBack)} their values back and brings ${count(preview.toBringBack)} ` +
    'back from the recycle bin — whoever made these changes' +
    (changedByWords(preview.lastChangedBy) !== ''
      ? `, last changed by ${changedByWords(preview.lastChangedBy)}`
      : '');
  return input.verb === 'reset'
    ? `Type ${alias} to reset it to '${preview.checkpoint.name}', as ` +
        `${input.resolved.checked.file.name} was applied: ${what}:`
    : `Type ${alias} to rewind it to before ${input.resolved.checked.file.name} was first ` +
        `applied: ${what}; the environment's checkpoints are then deleted, and this is not ` +
        'undone:';
}

/** A destroyed state: every resource taken back, every run of it said taken back whole. */
function destroyedWhole(state: EnvState): EnvState {
  return {
    ...state,
    resources: Object.fromEntries(
      Object.entries(state.resources).map(([name, resource]) => [
        name,
        {
          ...resource,
          status: 'destroyed' as const,
          runs: resource.runs.map((run) => ({ ...run, takenBack: true as const })),
        },
      ]),
    ),
  };
}

/** What a rewind of the environment came to, and the exit code it ends with. */
export interface EnvRewindOutcome {
  result: EnvRewindResult;
  exitCode: number;
}

/**
 * Rewind the org to the environment's checkpoint the verb names: see the
 * module's comment. Refused before the rewind — another apply, destroy or
 * reset of the org holds its lock, the state moved since it was read — it
 * writes nothing and ends 1.
 */
export async function rewindEnvironment(
  deps: RewindDeps,
  input: EnvRewindInput,
  preview?: RewindPreview,
): Promise<EnvRewindOutcome> {
  const { target, resolved, verb } = input;
  const env = resolved.checked.file.name;
  const to = rewindTargetOf(verb, input.state);
  const base = {
    env,
    org: { organizationId: target.organizationId, kind: target.kind, alias: target.alias },
    verb,
    checkpoint: {
      step: STEP_OF[verb],
      id: to?.checkpoint ?? '',
      ...(preview !== undefined
        ? {
            name: preview.checkpoint.name,
            takenAt: new Date(preview.checkpoint.takenAt).toISOString(),
          }
        : {}),
    },
    ...(preview !== undefined
      ? {
          preview: {
            toDelete: preview.toDelete,
            toGiveBack: preview.toGiveBack,
            toBringBack: preview.toBringBack,
            lastChangedBy: preview.lastChangedBy,
          },
        }
      : {}),
  };
  const refused = (refusal: string, serial: number): EnvRewindOutcome => ({
    result: {
      ...base,
      exitCode: FAILED_EXIT,
      status: 'failure',
      undo: { offered: false, why: 'nothing was rewound' },
      refusal,
      state: { serial },
    },
    exitCode: FAILED_EXIT,
  });
  // The command refuses these before it reads the org: met here, it is a caller's mistake.
  const before = rewindRefusalOf(input);
  if (before !== undefined || to === undefined || input.state === undefined) {
    throw new Error(before?.message ?? 'There is no checkpoint to rewind to.');
  }
  const state = input.state;

  const taken = acquireEnvLock(
    deps.locksDir,
    target.organizationId,
    { operation: verb, env, alias: target.alias },
    deps.lockOptions,
  );
  if ('busy' in taken) return refused(lockRefusal(taken.busy).message, state.serial);
  const stop = new AbortController();
  let stoppedBy: StopSignal | undefined;
  const release = (deps.onStop ?? onStopSignal)((signal) => {
    stoppedBy = signal;
    deps.say(
      `\nstopped by ${signal}: the rewind stops before its next call to the org, and leaves its ` +
        'journal: run this again to take it up',
    );
    stop.abort();
  });
  try {
    let current: EnvState;
    try {
      const read = await deps.store.read(target.organizationId, env);
      if (read === undefined || read.serial !== state.serial || read.lineage !== state.lineage) {
        return refused(
          `The state of ${env} on ${target.alias} changed since it was read (another apply, ` +
            'destroy or reset ran, or a cache put back another state). Nothing was written: run ' +
            'this again.',
          read?.serial ?? state.serial,
        );
      }
      current = read;
    } catch (err: unknown) {
      if (err instanceof EnvStateError) return refused(err.message, state.serial);
      throw err;
    }

    deps.say(
      `${verb === 'reset' ? 'reset' : 'destroy --rewind'}: rewinding ${target.alias} to checkpoint ${to.checkpoint}`,
    );
    const run = await deps.runner(
      CHECKPOINT_SCRIPT,
      checkpointRewindLine({
        org: target.alias,
        store: envCheckpointStoreOf(deps.journalDir),
        checkpoint: to.checkpoint,
        dryRun: false,
        acceptAutomation: input.acceptAutomation,
        acceptNoUndo: input.acceptNoUndo,
      }),
      stop.signal,
    );
    const ran = rewindRanOf(run);
    const exitCode = stoppedBy !== undefined ? stopExitCode(stoppedBy) : ran.exitCode;

    // The org is back before the first apply: nothing of the environment is
    // left in it, and its checkpoints hold the org's values in clear.
    const deleted: EnvCheckpointStepResult[] = [];
    if (verb === 'destroy' && exitCode === DONE_EXIT) {
      current = await deps.store.update(current, destroyedWhole);
      for (const { step, checkpoint } of checkpointsOfState(current)) {
        const gone = await deleteEnvCheckpoint(
          deps,
          {
            org: { alias: target.alias, kind: target.kind },
            checkpoint,
            why: 'the environment it was taken of is taken back',
          },
          stop.signal,
        );
        deleted.push(gone);
        if (gone.exitCode === DONE_EXIT) {
          current = await deps.store.update(current, (s) => withCheckpoint(s, step, undefined));
        }
      }
      deps.say(
        `every record of ${env} is taken back from ${target.alias}, with what anyone changed ` +
          'since its first apply: the state keeps it as destroyed, and the next apply creates it ' +
          'again',
      );
    }
    const undo = rewindUndoOf(
      {
        verb,
        alias: target.alias,
        checkpoint: to.checkpoint,
        journalDir: deps.journalDir,
        deleted: deleted.length > 0 && deleted.every((d) => d.exitCode === DONE_EXIT),
      },
      ran,
    );
    const refusal =
      ran.refusal === undefined
        ? undefined
        : ran.refusal.code === 'RECREATE'
          ? `${ran.refusal.message} ${verb === 'reset' ? 'reset' : 'destroy --rewind'} never ` +
            'makes records again with new Ids, which the state would no longer name: rewind with ' +
            'sandforge-checkpoint itself, then apply again.'
          : ran.refusal.message;
    return {
      result: {
        ...base,
        exitCode,
        status: stoppedBy !== undefined ? 'cancelled' : ran.status,
        ...(ran.answer !== undefined ? { answer: ran.answer } : {}),
        undo,
        ...(refusal !== undefined ? { refusal: refusal.slice(0, 8_000) } : {}),
        ...(deleted.length > 0 ? { deleted } : {}),
        state: { serial: current.serial },
      },
      exitCode,
    };
  } finally {
    release();
    taken.lock.release();
  }
}

/** The lines a reset or a destroy --rewind ends with. */
export function rewindResultLines(result: EnvRewindResult): string[] {
  const verb = result.verb === 'reset' ? 'reset' : 'destroy --rewind';
  const lines: string[] = [''];
  const answer = result.answer as
    | {
        deleted?: { done: number };
        givenBack?: { done: number };
        broughtBack?: { done: number };
        residual?: Array<{ count: number }>;
      }
    | undefined;
  if (answer?.deleted !== undefined) {
    const differing = (answer.residual ?? []).reduce((sum, r) => sum + r.count, 0);
    lines.push(
      `  rewind to ${result.checkpoint.id}: exit ${result.exitCode}, ${result.status}  ` +
        `${count(answer.deleted.done)} deleted, ${count(answer.givenBack?.done ?? 0)} given ` +
        `back, ${count(answer.broughtBack?.done ?? 0)} brought back` +
        (differing > 0 ? `, ${count(differing)} still differ` : ''),
    );
  }
  for (const step of result.deleted ?? []) {
    lines.push(
      step.exitCode === DONE_EXIT
        ? `  checkpoint ${step.checkpoint ?? ''} deleted`
        : `  checkpoint ${step.checkpoint ?? ''} kept: ${step.refusal ?? ''}`,
    );
  }
  if (result.refusal !== undefined) lines.push(`${verb} refused: ${result.refusal}`);
  lines.push(undoLine(result.undo));
  lines.push(`${verb}: ${result.status}; state serial ${result.state.serial}`);
  return lines;
}
