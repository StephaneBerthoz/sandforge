/**
 * Applying a plan: each resource's step run by its own script, in the order
 * the plan's dependencies give, its outcome kept in the state before the
 * next one starts.
 *
 * The environment writes nothing to the org itself. A step spawns the script
 * that does the work — `sandforge-seed` with the template the file converts
 * into, under a run id of the environment's making; `sandforge-clone` with
 * the template a forge resource converts into, held to its dry run's count
 * and writing its summary as it goes — and every guard, gate and run file of
 * the script holds as it holds on a terminal.
 *
 * Write-ahead: before a script is spawned, its resource goes to `applying`
 * (or `destroying`) in the state, with the run's rank, id and the time on the
 * org's clock, written and renamed over before the spawn. A process killed
 * anywhere leaves a state that names the run, and the seed's run file names
 * what it wrote, the clone's summary what it created: the next plan replaces
 * the resource from it.
 *
 * A forge run that ended is verified (`--verify`): what it created is read
 * back from the target, and its lookups checked on a sample against the
 * source. Records not there, or lookups that do not hold, make it partial;
 * readings that never agree make it unstable, which stops the apply. A
 * frozen run is a load held to its dry run's count, in the sas the state
 * keeps for its resource, and judged by the verification the load chains
 * after it: an object it FAILED makes it partial. A frozen resource's
 * replace is one run, a reload, whose purge takes back what the loads before
 * it created, or refuses before anything is written.
 *
 * A users resource runs first and is taken back last: its run converges from
 * the one before it (`--replaces`), which it then holds, and its removal is
 * of its last run alone. A replay is held to its dry run's count, and its
 * replace replays again, whose purge takes back the replays before it.
 *
 * A seed resource whose relations draw their parents from another
 * resource's records is handed their ids as its run begins, read from what
 * that resource's last run keeps: run first in the same apply, its records
 * are the ones it has just created.
 *
 * The order: what is taken back first — every `delete`, and the removal half
 * of every `replace` — each resource before those it depended on when it was
 * applied; then every `create` and the run half of every `replace`, each
 * after what it depends on. The removal keeps a record while records that
 * stay hang from it, so the forward order would keep every parent.
 *
 * How a step ends decides what the apply does next:
 *
 * | The script exits                         | The resource           | The apply                      |
 * |------------------------------------------|------------------------|--------------------------------|
 * | 0, having created what its dry run counted | `applied`            | goes on                        |
 * | 0 short of it, or 3: records refused     | `partial`              | goes on, but not with what depends on it |
 * | 1 or 2                                   | `failed`               | stops                          |
 * | 4, or a verification that never agreed   | `partial`              | stops                          |
 * | 129, 130, 143                            | stays `applying`       | stops; the next apply replaces it |
 *
 * The apply exits with the worst of its steps (`worstExit`), but 1 only when
 * it wrote nothing: once a step wrote, the org holds part of the environment
 * and the state names it, which is partial (3). An apply whose plan holds
 * nothing to do writes nothing, to the org or the state: applied twice, the
 * second writes nothing and leaves the state's serial where it was.
 *
 * The checkpoints the plan lists (`envCheckpoints.ts`) frame the steps: the
 * one before the first write is taken before the first step, and a take that
 * does not end 0 stops the apply there, nothing written; the one after is
 * taken once every step ended 0, its id kept in the state. Once an apply
 * wrote, the checkpoint the last apply left no longer holds the environment
 * as applied, and is deleted, whether the new one is taken or not: a reset
 * to it would take back what this apply wrote and leave the state naming it.
 */

import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import {
  usersApplyAnswerSchema,
  usersPlanAnswerSchema,
  type EnvActionKind,
  type EnvCheckpointStepResult,
  type EnvPlan,
  type EnvResourceState,
  type EnvResourceStatus,
  type EnvRun,
  type EnvRunResult,
  type EnvState,
  type EnvStepObject,
  type EnvStepResult,
} from '@sandforge/shared';
import type { LinkedLockOptions } from '../../src/modules/checkpoint/linkedLock.js';
import { organizationKey } from '../../src/modules/checkpoint/OrgCheckpointStore.js';
import { SEED_RUNS_DIR } from '../../src/modules/seed/SeedRunCreations.js';
import { DONE_EXIT, FAILED_EXIT, PARTIAL_EXIT, UNSTABLE_EXIT, worstExit } from '../exitCodes.js';
import type { CommandRunner } from '../scriptRunner.js';
import { STOP_SIGNALS, onStopSignal, stopExitCode, type StopSignal } from '../stopSignals.js';
import {
  deleteEnvCheckpoint,
  envCheckpointStoreOf,
  takeEnvCheckpoint,
  takeSettingsOf,
  withCheckpoint,
} from './envCheckpoints.js';
import type { EnvFileResolved, EnvFileResource } from './envFile.js';
import {
  checkpointActRefusal,
  lockRefusal,
  STATE_MOVED,
  stateRefusal,
  type EnvTarget,
} from './envGuards.js';
import {
  applyLineOf,
  dryRunCountOf,
  payloadOf,
  readRemovalOf,
  removalObjectsOf,
  removeLineOf,
  replacesInOneRun,
  type EnvKindScript,
  type EnvRemovalAnswer,
} from './envKinds.js';
import { acquireEnvLock, checkpointLockRefusal, type EnvLockOperation } from './envLock.js';
import { dryRunTotalOf, liveResources, removalOrder, type EnvDryRun } from './envPlan.js';
import {
  EnvStateError,
  envRunIdOf,
  newEnvState,
  nextRunNumber,
  removalStarted,
  runStarted,
  runSummaryPathOf,
  runTakenBack,
  runTemplatePathOf,
  stepEnded,
  withOrgHost,
  type EnvStore,
} from './envState.js';
import { StepAnswerError, reasonLineOf, type EnvRunCount } from './kinds/common.js';
import {
  forgeRootsPlanFileOf,
  forgeRunCount,
  forgeVerifyLine,
  readForgeRun,
  readForgeVerify,
  verificationShortOf,
} from './kinds/forge.js';
import {
  frozenRunCount,
  frozenSasOf,
  frozenVerdictShortOf,
  readFrozenRun,
  reloadDeleted,
  reloadPurgedWhole,
  resourceOfSas,
} from './kinds/frozen.js';
import {
  forgetMaskStore,
  maskForgottenLine,
  maskRunCount,
  maskStoreOf,
  readMaskRun,
  type MaskRunCount,
  type MaskStoreForgotten,
} from './kinds/mask.js';
import { REPLAY_SCRIPT, readReplayRun, replayPurgedWhole, replayRunCount } from './kinds/replay.js';
import { readSeedRun, seedRunCount } from './kinds/seed.js';
import {
  USERS_SCRIPT,
  changeWords,
  readUsersApply,
  usersRunCount,
  usersRunNumberOf,
  type UsersRemovalAnswer,
} from './kinds/users.js';
import { drawnOf } from './envReferences.js';
import { commandOf } from '../invocation.js';

/** What a step runs with, beside its line: the product's own, or a test's. */
export interface EnvStepDeps {
  /** Runs a script of `cli/` with the arguments after its name. */
  runner: CommandRunner;
  store: EnvStore;
  /** Where the environment locks and the checkpoint locks are. */
  locksDir: string;
  /** The folder `SANDFORGE_JOURNAL_DIR` names, where the seed keeps its run files and the clone its journals. */
  journalDir: string;
  /** Now, as the org stamps a write: the state's spans are on its clock. */
  orgNow: () => Promise<string>;
  /** A line for whoever reads: stderr with `--json`. */
  say: (line: string) => void;
  /** This SandForge's version, which a new state records. */
  sandforgeVersion: string;
  /** Hears the stop signals; the process's own unless a test gives another. */
  onStop?: (stop: (signal: StopSignal) => void) => () => void;
  /** The checks a lock makes of its holder; a test gives its own. */
  lockOptions?: LinkedLockOptions;
}

/** What an apply or a destroy came to, and the exit code it ends with. */
export interface EnvRunOutcome {
  result: EnvRunResult;
  exitCode: number;
}

/** Whether `code` is the exit code of a run a stop signal stopped. */
export function isStopCode(code: number): boolean {
  return STOP_SIGNALS.some((signal) => stopExitCode(signal) === code);
}

/** The folder of a state, the state's org and environment named. */
interface Where {
  organizationId: string;
  env: string;
}

/**
 * What refused or failed a step, in its script's own words: what its `--json`
 * answer says, where it says it; else, for a step that ended neither done,
 * partial, unstable nor stopped, the last line it said on stderr that says
 * why. A script refused before its first write prints no run on stdout,
 * only its refusal (`isRefusedSummary`): live, a forge run its gate refused —
 * `The run would write 6 records, more than --max-total 5` — left the apply's
 * `--json` with its exit code alone, and the reason on the clone's stderr.
 */
function stepRefusalOf(
  code: number,
  answered: string | undefined,
  stderr: string,
): string | undefined {
  const ended =
    code === DONE_EXIT || code === PARTIAL_EXIT || code === UNSTABLE_EXIT || isStopCode(code);
  const said = answered ?? (ended ? undefined : reasonLineOf(stderr));
  return said !== undefined && said !== '' ? said.slice(0, 4_000) : undefined;
}

/** A removal's answer, per object, as a step names it. */
function removalObjects(answer: EnvRemovalAnswer | undefined): EnvStepObject[] {
  return removalObjectsOf(answer).map((object) => {
    const reasons = [
      object.keptChanged > 0 ? `${object.keptChanged} changed since the run, kept` : '',
      object.keptDependents > 0
        ? `${object.keptDependents} kept for records that stay (${object.heldBy.join(', ') || 'records that stay'})`
        : '',
      object.refused > 0 ? `${object.refused} refused` : '',
      (object.notVisible ?? 0) > 0 ? `${object.notVisible} not visible to the user` : '',
      (object.notReached ?? 0) > 0 ? `${object.notReached} not reached` : '',
      ...object.reasons,
    ].filter(Boolean);
    return {
      object: object.objectApiName,
      created: 0,
      refused: object.refused,
      deleted: object.deleted,
      kept: object.keptChanged + object.keptDependents + object.refused,
      ...(reasons.length > 0 ? { reason: reasons.join('; ').slice(0, 2_000) } : {}),
    };
  });
}

/** What a run wrote, per object, as a step names it. */
function runObjects(count: EnvRunCount | undefined): EnvStepObject[] {
  return (count?.objects ?? []).map((object) => ({
    object: object.object,
    created: object.created,
    refused: object.refused,
    deleted: 0,
    kept: 0,
    ...(object.errors.length > 0
      ? { reason: object.errors.slice(0, 5).join('; ').slice(0, 2_000) }
      : {}),
  }));
}

/**
 * Whether `--json` answered that the run's gate refused it (`refusedSummary`):
 * no run to read, which is no misreading. Its reason is its last line on stderr.
 */
function isRefusedSummary(stdout: string): boolean {
  try {
    const answer = JSON.parse(stdout) as { refused?: { code?: unknown } } | null;
    return typeof answer?.refused?.code === 'string';
  } catch {
    return false;
  }
}

/** What a script printed on stdout read with `read`, or undefined, the reason said. */
function answerOf<T>(
  read: (stdout: string) => T,
  stdout: string,
  say: (line: string) => void,
): T | undefined {
  if (stdout.trim() === '' || isRefusedSummary(stdout)) return undefined;
  try {
    return read(stdout);
  } catch (err: unknown) {
    if (err instanceof StepAnswerError) {
      say(`  ${err.message}`);
      return undefined;
    }
    throw err;
  }
}

/**
 * What a run of a resource is taken back from: the summary it printed, kept
 * beside the state, or — for a run stopped before it printed one — its run
 * file, by its id, which the seed writes as the org takes its records; for a
 * frozen run, the configuration it was given, which names the sas its loads
 * are kept in; or nothing, for a run that never wrote: no summary and no run
 * file.
 */
export function removalSubjectOf(
  run: { n: number; summary?: string; runId?: string; sas?: string; script?: string },
  where: Where,
  deps: Pick<EnvStepDeps, 'store' | 'journalDir'>,
  resource?: string,
): string | undefined {
  const frozen = resourceOfSas(run.sas);
  if (frozen !== undefined) {
    const file = deps.store.fileOf(
      where.organizationId,
      where.env,
      runTemplatePathOf(frozen, run.n),
    );
    return existsSync(file) ? file : undefined;
  }
  if (run.summary !== undefined) {
    const file = deps.store.fileOf(where.organizationId, where.env, run.summary);
    if (existsSync(file)) return file;
  }
  if (
    run.runId !== undefined &&
    existsSync(join(deps.journalDir, SEED_RUNS_DIR, `${run.runId}.ndjson`))
  ) {
    return run.runId;
  }
  // A replay stopped before it answered: the payload it was given names the
  // checkpoint it replays, which its removal is named by.
  if (run.script === REPLAY_SCRIPT && resource !== undefined) {
    const file = deps.store.fileOf(
      where.organizationId,
      where.env,
      runTemplatePathOf(resource, run.n),
    );
    return existsSync(file) ? file : undefined;
  }
  return undefined;
}

/**
 * The run of `sandforge users` a run of a users resource is, by the number
 * the script gave it: the one its answer, kept as its summary, names; for a
 * run stopped before it answered, the one run file the script began on this
 * machine after the environment launched it that no other run of the
 * resource names, adopted; none, for a run its script refused before its
 * first write, which begins no run file; or, for any other, why nobody can
 * say which it was — never guessed.
 */
export type EnvUsersRunOf =
  { run: number; file: string; adopted?: true } | { none: true } | { unknown: string };

/** A run file of `sandforge users`, in its org's folder. */
const USERS_RUN_FILE = /^run-([1-9]\d{0,5})\.json$/;

/**
 * How far before the environment's launch a run file's start may read: the
 * state is stamped on the org's clock, the run file on this machine's.
 */
const USERS_CLOCK_LEEWAY_MS = 60_000;

/** What of a run file of `sandforge users` tells when it began, and whether a removal took it back. */
const usersRunBegunSchema = z
  .object({
    run: z.number().int().positive(),
    startedAt: z.string(),
    removals: z.array(z.object({ status: z.string() }).loose()).optional(),
  })
  .loose();

export function usersRunOf(
  run: Pick<EnvRun, 'n' | 'summary' | 'startedAt' | 'exitCode'>,
  runs: ReadonlyArray<Pick<EnvRun, 'n' | 'summary'>>,
  where: Where,
  deps: Pick<EnvStepDeps, 'store' | 'journalDir'>,
): EnvUsersRunOf {
  const named = (summary: string | undefined): { run: number; file: string } | undefined => {
    if (summary === undefined) return undefined;
    const file = deps.store.fileOf(where.organizationId, where.env, summary);
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      return undefined;
    }
    const number = usersRunNumberOf(text);
    return number !== undefined ? { run: number, file } : undefined;
  };
  const own = named(run.summary);
  if (own !== undefined) return own;
  const claimed = new Set(
    runs.flatMap((other) => (other.n === run.n ? [] : [named(other.summary)?.run ?? 0])),
  );
  const folder = join(deps.journalDir, 'users', organizationKey(where.organizationId));
  let names: string[];
  try {
    names = readdirSync(folder);
  } catch {
    names = [];
  }
  const since = Date.parse(run.startedAt) - USERS_CLOCK_LEEWAY_MS;
  const began = names.flatMap((name) => {
    const number = Number(USERS_RUN_FILE.exec(name)?.[1] ?? 0);
    if (number === 0 || claimed.has(number)) return [];
    const file = join(folder, name);
    try {
      const read = usersRunBegunSchema.safeParse(JSON.parse(readFileSync(file, 'utf8')));
      // A run a removal took back whole holds nothing left to take.
      const takenBack = read.success && read.data.removals?.at(-1)?.status === 'success';
      return read.success &&
        read.data.run === number &&
        !takenBack &&
        Date.parse(read.data.startedAt) >= since
        ? [{ run: number, file }]
        : [];
    } catch {
      return [];
    }
  });
  const [one] = began;
  if (one !== undefined && began.length === 1) return { ...one, adopted: true };
  // Refused before its first write, the script begins no run file.
  if (began.length === 0 && (run.exitCode === FAILED_EXIT || run.exitCode === 2)) {
    return { none: true };
  }
  return {
    unknown:
      began.length === 0
        ? `its run ${run.n} stopped before it answered, and no run of ${commandOf('users')} ` +
          'began on this machine after it was launched: which it was, nobody can say'
        : `its run ${run.n} stopped before it answered, and ${began.length} runs of ` +
          `${commandOf('users')} began on this machine after it was launched ` +
          `(${began.map((each) => each.run).join(', ')}): which is its, nobody can say. ` +
          `${commandOf('users')} remove --run <n> takes one back`,
  };
}

/**
 * The run of `sandforge users` a users resource converges from: its last
 * live run whose number is known, a run stopped before it answered adopted;
 * and, of a later one nobody can name, why, which the plan says.
 */
export function usersReplacesOf(
  kept: Pick<EnvResourceState, 'runs'> | undefined,
  where: Where,
  deps: Pick<EnvStepDeps, 'store' | 'journalDir'>,
): { run?: number; unknown?: string } {
  let unknown: string | undefined;
  for (const run of [...(kept?.runs ?? [])].reverse()) {
    if (run.takenBack === true) continue;
    const of = usersRunOf(run, kept?.runs ?? [], where, deps);
    if ('run' in of) return { run: of.run, ...(unknown !== undefined ? { unknown } : {}) };
    if ('unknown' in of) unknown ??= of.unknown;
  }
  return unknown !== undefined ? { unknown } : {};
}

/** How taking back one resource's runs ended. */
export interface RemovalEnd {
  /** Every run taken back whole: nothing of the resource is left in the org. */
  whole: boolean;
  /** The exit code that ended it: 0, 3 (records left), 1 (refused or failed), or the one that stopped it. */
  code: number;
  /** Whether a removal may have deleted records. */
  wrote: boolean;
  steps: EnvStepResult[];
  state: EnvState;
}

/** What a resource's runs are taken back with. */
export interface RemovalAsk {
  resource: string;
  /** The plan's action the removal serves: `delete`, `replace`, or a destroy's `delete`. */
  action: EnvActionKind;
  target: EnvTarget;
  includeChanged: boolean;
  sweep: boolean;
  acceptAutomation: boolean;
  /** The resource's status once every run is taken back whole, and once records are left. */
  ends: { whole: EnvResourceStatus; left: EnvResourceStatus };
}

/**
 * Take back every run of a resource, the last first, through its script's
 * own removal: the resource `destroying` in the state before the first spawn,
 * then `ends.whole` or `ends.left` once they ended. A run taken back whole
 * already costs its removal nothing: it says so from its summary's sidecar,
 * without reaching the org. A removal refused, failed or stopped stops here:
 * the status it had comes back for a refusal, and `destroying` stays for a
 * stop, which the next plan replaces.
 */
export async function removeResource(
  deps: EnvStepDeps,
  state: EnvState,
  ask: RemovalAsk,
  signal: AbortSignal,
): Promise<RemovalEnd> {
  const where = { organizationId: state.org.organizationId, env: state.env };
  const before = state.resources[ask.resource];
  if (before === undefined) {
    throw new EnvStateError('invalid', `The state holds no resource ${ask.resource} to take back`);
  }
  if (before.kind === 'mask') return forgetMask(deps, state, ask);
  let current = await deps.store.update(state, (s) => removalStarted(s, ask.resource));
  const steps: EnvStepResult[] = [];
  let left = false;
  let wrote = false;
  // A users run converges from the one before it, and holds what that one
  // held: its last run known is taken back alone, the earlier with it.
  let usersTaken = false;
  for (const run of [...before.runs].reverse()) {
    if (run.takenBack === true) continue;
    let subject: string | undefined;
    if (before.kind === 'users') {
      if (usersTaken) {
        current = await deps.store.update(current, (s) => runTakenBack(s, ask.resource, run.n));
        continue;
      }
      const of = usersRunOf(run, before.runs, where, deps);
      if ('unknown' in of) {
        // Nobody can say which run of the script it was: what it created is
        // left, said, for the line that takes a run back by hand.
        deps.say(`${ask.resource}: run ${run.n} is not taken back: ${of.unknown}`);
        left = true;
        continue;
      }
      subject = 'run' in of ? of.file : undefined;
    } else {
      subject = removalSubjectOf(run, where, deps, ask.resource);
    }
    if (subject === undefined) continue;
    deps.say(`${ask.resource}: taking back run ${run.n}`);
    const line = removeLineOf(before.kind, {
      target: ask.target.alias,
      subject,
      includeChanged: ask.includeChanged,
      acceptAutomation: ask.acceptAutomation,
      sweep: ask.sweep,
      checkpointStore: envCheckpointStoreOf(deps.journalDir),
    });
    const ran = await deps.runner(line.script, line.args, signal);
    const answer = answerOf((out) => readRemovalOf(before.kind, out), ran.stdout, deps.say);
    const deleted = removalObjectsOf(answer).reduce((sum, o) => sum + o.deleted, 0);
    wrote ||= answer !== undefined ? deleted > 0 : ran.code !== FAILED_EXIT && ran.code !== 2;
    const stopped = isStopCode(ran.code);
    const ok = ran.code === DONE_EXIT || ran.code === PARTIAL_EXIT;
    const status: EnvResourceStatus = stopped
      ? 'destroying'
      : ok
        ? ran.code === PARTIAL_EXIT
          ? ask.ends.left
          : ask.ends.whole
        : before.status;
    // A removal refused before its first delete prints nothing on stdout.
    const refusal = stepRefusalOf(ran.code, undefined, ran.stderr);
    steps.push({
      resource: ask.resource,
      action: ask.action,
      phase: 'remove',
      run: run.n,
      script: line.script,
      exitCode: ran.code,
      status,
      ...(run.summary !== undefined ? { summary: run.summary } : {}),
      objects: removalObjects(answer),
      ...(answer !== undefined ? { answer } : {}),
      ...(refusal !== undefined ? { refusal } : {}),
    });
    if (ran.code === PARTIAL_EXIT) left = true;
    if (ran.code === DONE_EXIT) {
      current = await deps.store.update(current, (s) => runTakenBack(s, ask.resource, run.n));
      usersTaken = before.kind === 'users';
    } else if (before.kind === 'users' && ok) {
      // What it kept, it keeps for the runs before it too: none is asked again.
      break;
    }
    if (!ok) {
      if (!stopped)
        current = await deps.store.update(current, (s) =>
          stepEnded(s, { resource: ask.resource, status: before.status }),
        );
      // A line the script refused ends 2, which no apply or destroy ranks:
      // counted as it came, an apply stopped at a refused removal ended 0.
      return { whole: false, code: stopped ? ran.code : FAILED_EXIT, wrote, steps, state: current };
    }
  }
  current = await deps.store.update(current, (s) =>
    stepEnded(s, { resource: ask.resource, status: left ? ask.ends.left : ask.ends.whole }),
  );
  return { whole: !left, code: left ? PARTIAL_EXIT : DONE_EXIT, wrote, steps, state: current };
}

/**
 * Take a mask resource back as a masking is: never unmasked. Its DataOps
 * store is deleted whole — its snapshots, the only copy of the values it
 * wrote over —, the resource `destroying` in the state before, `destroyed`
 * once the store is gone, every run of it taken back. Its records stay as
 * they are, masked. Putting their values back was the person's own act,
 * `sandforge-dataops anonymize --restore`, before.
 */
async function forgetMask(
  deps: EnvStepDeps,
  state: EnvState,
  ask: RemovalAsk,
): Promise<RemovalEnd> {
  const before = state.resources[ask.resource];
  if (before === undefined) {
    throw new EnvStateError('invalid', `The state holds no resource ${ask.resource} to take back`);
  }
  let current = await deps.store.update(state, (s) => removalStarted(s, ask.resource));
  const store = deps.store.sasOf(state.org.organizationId, state.env, maskStoreOf(ask.resource));
  const last = before.runs.at(-1);
  const step = (status: EnvResourceStatus, exitCode: number, reason: string): EnvStepResult => ({
    resource: ask.resource,
    action: ask.action,
    phase: 'remove',
    run: last?.n ?? 1,
    script: 'sandforge-dataops',
    exitCode,
    status,
    objects: (last?.objects ?? []).map((object) => ({
      object: object.objectApiName,
      created: 0,
      refused: 0,
      deleted: 0,
      kept: 0,
      masked: object.masked ?? 0,
      reason,
    })),
  });
  deps.say(`${ask.resource}: deleting its store ${store}`);
  let forgotten: MaskStoreForgotten;
  try {
    forgotten = await forgetMaskStore(store);
  } catch (err: unknown) {
    const why = err instanceof Error ? err.message : String(err);
    deps.say(`${ask.resource}: ${why}`);
    current = await deps.store.update(current, (s) =>
      stepEnded(s, { resource: ask.resource, status: before.status }),
    );
    return {
      whole: false,
      code: FAILED_EXIT,
      wrote: false,
      steps: [step(before.status, FAILED_EXIT, why)],
      state: current,
    };
  }
  deps.say(maskForgottenLine(ask.resource, forgotten));
  for (const run of before.runs) {
    if (run.takenBack === true) continue;
    current = await deps.store.update(current, (s) => runTakenBack(s, ask.resource, run.n));
  }
  current = await deps.store.update(current, (s) =>
    stepEnded(s, { resource: ask.resource, status: ask.ends.whole }),
  );
  const deleted =
    forgotten.snapshots.length > 0
      ? `snapshot${forgotten.snapshots.length === 1 ? '' : 's'} ${forgotten.snapshots.join(', ')}`
      : 'its store';
  return {
    whole: true,
    code: DONE_EXIT,
    // Nothing of the org is written: the store is on this machine.
    wrote: false,
    steps: [
      step(
        ask.ends.whole,
        DONE_EXIT,
        `left masked, as destroy leaves a masking; ${deleted} deleted`,
      ),
    ],
    state: current,
  };
}

/**
 * The scripts that read the target's automation before they write, and are
 * refused for the emails what still runs sends where it delivers them
 * (`EMAILS_NOT_ACCEPTED`): a seed, a clone, a masking, a frozen load and a
 * replay; and a users run, which asks addresses back in an org that delivers
 * all email only with it (`USERS_EMAILS_OPEN`).
 */
const SCRIPTS_THAT_ASK_FOR_THE_EMAILS: ReadonlySet<string> = new Set([
  'sandforge-seed',
  'sandforge-clone',
  'sandforge-dataops',
  'sandforge-frozen',
  'sandforge-users',
  'sandforge-checkpoint',
]);

/**
 * A resource's line, dry run or run, with the accord of the environment's own
 * line (`--accept-emails`) when its script asks for one: the question it
 * would put has nobody to answer it, and the file holds no such accord, which
 * is the person's to give each time.
 */
export function withEmailsAccepted<L extends { script: string; args: string[] }>(
  line: L,
  acceptEmails: boolean,
): L {
  return acceptEmails && SCRIPTS_THAT_ASK_FOR_THE_EMAILS.has(line.script)
    ? { ...line, args: [...line.args, '--accept-emails'] }
    : line;
}

/** What an apply is given beside its plan. */
export interface EnvApplyInput {
  plan: EnvPlan;
  resolved: EnvFileResolved;
  target: EnvTarget;
  /** The state as the plan read it; undefined when there was none. */
  state: EnvState | undefined;
  /** The dry runs the plan read, by resource: what each run is held to, and the seed it drew. */
  dryRuns: Readonly<Record<string, EnvDryRun>>;
  /** Delete although the target runs automation as the records go: the line's. */
  acceptAutomation: boolean;
  /**
   * Write although the target delivers the emails what still runs sends, or
   * would not say whether it does: the line's, handed to the resources'
   * runs. Not given, not accepted; never `acceptAutomation`.
   */
  acceptEmails?: boolean;
  /**
   * Let Salesforce email the people whose address a users resource asks
   * back: the line's, never the file's. Not given, not accepted.
   */
  acceptUserEmails?: boolean;
}

/** A step of an apply: a resource's runs taken back, or its script run. */
type ApplyStep =
  | { phase: 'remove'; resource: string; action: EnvActionKind }
  | { phase: 'run'; resource: string; action: EnvActionKind };

/** The steps of a plan, in the order they run: see the module's comment. */
export function applySteps(plan: EnvPlan, state: EnvState | undefined): ApplyStep[] {
  const byName = new Map(plan.actions.map((action) => [action.resource, action]));
  const live = new Set(liveResources(state).map(([name]) => name));
  // A frozen resource's replace is a reload: its run takes back what the
  // loads before it created, or refuses before anything is written.
  const removed = removalOrder(
    state,
    plan.actions
      .filter(
        (a) =>
          (a.action === 'delete' || (a.action === 'replace' && !replacesInOneRun(a.kind))) &&
          live.has(a.resource),
      )
      .map((a) => a.resource),
  ).map((resource): ApplyStep => ({
    phase: 'remove',
    resource,
    action: byName.get(resource)?.action ?? 'delete',
  }));
  const run = plan.actions
    .filter((a) => a.action === 'create' || a.action === 'replace')
    .map((a): ApplyStep => ({ phase: 'run', resource: a.resource, action: a.action }));
  return [...removed, ...run];
}

/** The status of a run step, and the code it counts for in the apply's, from how its script exited. */
function runEnd(
  code: number,
  count: EnvRunCount | undefined,
  planned: number | undefined,
): { status: EnvResourceStatus; counts: number; stops: boolean; short?: string } {
  if (isStopCode(code)) return { status: 'applying', counts: code, stops: true };
  if (code === DONE_EXIT && count !== undefined) {
    const created = count.created;
    if (planned !== undefined && created !== planned) {
      return {
        status: 'partial',
        counts: PARTIAL_EXIT,
        stops: false,
        short: `it created ${created} record(s) of the ${planned} its dry run counted`,
      };
    }
    return { status: 'applied', counts: DONE_EXIT, stops: false };
  }
  if (code === PARTIAL_EXIT) return { status: 'partial', counts: PARTIAL_EXIT, stops: false };
  if (code === UNSTABLE_EXIT) return { status: 'partial', counts: UNSTABLE_EXIT, stops: true };
  return { status: 'failed', counts: FAILED_EXIT, stops: true };
}

/** What a verification of a forge run found: what the target holds short of what it created. */
type Verified = { short?: string; unstable: boolean } | { unread: string };

/**
 * A run's end, once its verification is read: an applied run whose records
 * are not all there, or whose lookups do not hold, is partial; one whose
 * readings never agreed is partial too and stops the apply, as the
 * verification exits 4. A verification that did not answer leaves the run as
 * its script said it ended, and says so.
 */
function verifiedEnd(
  ended: ReturnType<typeof runEnd>,
  verified: Verified | undefined,
): ReturnType<typeof runEnd> {
  if (verified === undefined) return ended;
  // A frozen load its own verification ended partial, exit 3, says what that
  // verification found, as an applied run does.
  if (ended.status === 'partial' && ended.short === undefined && 'short' in verified) {
    return verified.short === undefined || verified.unstable
      ? ended
      : { ...ended, short: `its verification found ${verified.short}` };
  }
  if (ended.status !== 'applied') return ended;
  if ('unread' in verified) return { ...ended, short: `not verified: ${verified.unread}` };
  if (verified.unstable) {
    return {
      status: 'partial',
      counts: UNSTABLE_EXIT,
      stops: true,
      short: `its verification is unstable: ${verified.short ?? ''}`,
    };
  }
  if (verified.short === undefined) return ended;
  return {
    status: 'partial',
    counts: PARTIAL_EXIT,
    stops: false,
    short: `its verification found ${verified.short}`,
  };
}

/** What a run step is given: its resource, its rank, and where it writes. */
interface RunStepInput {
  resource: EnvFileResource;
  n: number;
  where: Where;
  target: EnvTarget;
  /** The payload the resource converts into, written beside the state. */
  templateFile: string;
  dry: EnvDryRun | undefined;
  /** What it depends on ran first in this apply: its dry run read the org before them. */
  readTooEarly: boolean;
  /** Whether the run replaces runs of it still in the org: a frozen resource's is a reload. */
  replace: boolean;
  /** The line's `--accept-automation` or the file's, which a reload's purge is held to. */
  acceptAutomation: boolean;
  /** The line's `--accept-emails`, handed to a run whose script asks for it. */
  acceptEmails: boolean;
  /** The line's `--accept-user-emails`, handed to a users run. */
  acceptUserEmails: boolean;
  /** Of a users resource replaced, the run of its script it converges from. */
  replacesRun?: number;
  signal: AbortSignal;
}

/** How a run step's script ended, read as every kind is read. */
interface RunStepOutcome {
  state: EnvState;
  script: EnvKindScript;
  code: number;
  count?: EnvRunCount;
  /** The script's own `--json` answer. */
  answer?: unknown;
  /** Its summary, from the state's folder, once there is one. */
  summary?: string;
  /** Whether it may have written records. */
  wrote: boolean;
  /** What a whole run of it creates, as its dry run counted it. */
  planned?: number;
  verified?: Verified;
  /** A reload whose purge took the loads before it whole: their runs are taken back. */
  tookBackEarlier?: true;
  /** A masking's: what it went through per object, and the snapshot it took first. */
  masking?: MaskRunCount;
  /** What refused or failed the run, as the script's `--json` answer says it. */
  answered?: string;
  /** What the script said on stderr. */
  stderr: string;
}

/**
 * Run a resource's script: the state ahead of the spawn, then the script, then
 * its answer read as its kind reads it.
 *
 * A seed runs under a run id of the environment's making, its draws the dry
 * run's when the file pins none, and its summary is what it printed. A forge
 * run is held to its dry run's count (`--max-total`) and writes its summary
 * beside the state as it goes, which the state names before the spawn: a run
 * stopped part way leaves what it created there for the next apply to take
 * back. A forge run that ended is then verified.
 */
async function runResourceStep(
  deps: EnvStepDeps,
  state: EnvState,
  input: RunStepInput,
): Promise<RunStepOutcome> {
  const { resource, n, where, target, templateFile, dry, signal } = input;
  const env = where.env;
  const dryAnswer = dry !== undefined && 'answer' in dry ? dry.answer : undefined;
  const planned =
    dryAnswer === undefined || input.readTooEarly ? undefined : dryRunCountOf(dryAnswer).created;
  const startedAt = await deps.orgNow();
  if (resource.kind === 'seed') {
    const runId = envRunIdOf(env, resource.name, n);
    // The seed the dry run drew, when the file pins none: the run writes
    // the records the dry run counted.
    const seed =
      resource.run.seed ?? (dryAnswer?.tool === 'sandforge-seed' ? dryAnswer.seed : undefined);
    const current = await deps.store.update(state, (s) =>
      runStarted(s, {
        resource: resource.name,
        kind: 'seed',
        fingerprint: resource.fingerprint,
        dependsOn: resource.dependsOn,
        run: {
          script: 'sandforge-seed',
          runId,
          ...(seed !== undefined ? { seed } : {}),
          startedAt,
        },
      }),
    );
    const line = withEmailsAccepted(
      applyLineOf(resource, {
        target: target.alias,
        templateFile,
        runId,
        summaryFile: '',
        ...(seed !== undefined ? { seed } : {}),
      }),
      input.acceptEmails,
    );
    const ran = await deps.runner(line.script, line.args, signal);
    const answer = answerOf(readSeedRun, ran.stdout, deps.say);
    const count = answer !== undefined ? seedRunCount(answer) : undefined;
    const wrote =
      (count?.created ?? 0) > 0 ||
      existsSync(join(deps.journalDir, SEED_RUNS_DIR, `${runId}.ndjson`));
    const summary =
      answer !== undefined
        ? await deps.store
            .writeFile(where.organizationId, env, runSummaryPathOf(resource.name, n), ran.stdout)
            .then(() => runSummaryPathOf(resource.name, n))
        : undefined;
    return {
      state: current,
      script: line.script,
      code: ran.code,
      ...(count !== undefined ? { count } : {}),
      ...(answer !== undefined ? { answer } : {}),
      ...(summary !== undefined ? { summary } : {}),
      wrote,
      ...(planned !== undefined ? { planned } : {}),
      ...(count?.refusal !== undefined ? { answered: count.refusal } : {}),
      stderr: ran.stderr,
    };
  }

  if (resource.kind === 'frozen') {
    return runFrozenStep(deps, state, input, startedAt, planned);
  }
  if (resource.kind === 'mask') {
    return runMaskStep(deps, state, input, startedAt);
  }
  if (resource.kind === 'users') {
    return runUsersStep(deps, state, input, startedAt);
  }
  if (resource.kind === 'replay') {
    return runReplayStep(deps, state, input, startedAt, planned);
  }
  // A forge run: its summary named in the state before the clone starts it.
  const summary = runSummaryPathOf(resource.name, n);
  const summaryFile = await deps.store.prepareFile(where.organizationId, env, summary);
  const current = await deps.store.update(state, (s) =>
    runStarted(s, {
      resource: resource.name,
      kind: 'forge',
      fingerprint: resource.fingerprint,
      dependsOn: resource.dependsOn,
      run: { script: 'sandforge-clone', summary, startedAt },
    }),
  );
  // Held to its dry run's count: a scope that widened since is refused, not written.
  const maxTotal = dryRunTotalOf(dry);
  // Of the records a query chooses, those its dry run chose and kept: the run
  // writes those, and none the query chooses after.
  const rootsPlanFile =
    resource.kind === 'forge' && resource.run.records !== undefined
      ? forgeRootsPlanFileOf(deps.journalDir, where.organizationId, env, resource.name)
      : undefined;
  const line = withEmailsAccepted(
    applyLineOf(resource, {
      target: target.alias,
      templateFile,
      runId: '',
      summaryFile,
      ...(maxTotal !== undefined ? { maxTotal } : {}),
      ...(rootsPlanFile !== undefined ? { rootsPlanFile } : {}),
    }),
    input.acceptEmails,
  );
  const ran = await deps.runner(line.script, line.args, signal);
  // A production's ids, which no run takes up after this one: a run taken
  // back and made again is planned again.
  if (rootsPlanFile !== undefined) rmSync(rootsPlanFile, { force: true });
  // The summary as the clone wrote it, read back: it says what the run
  // created however it ended, where stdout says nothing of a run killed.
  const kept = existsSync(summaryFile) ? readFileSync(summaryFile, 'utf8') : undefined;
  const answer =
    answerOf(readForgeRun, kept ?? '', deps.say) ?? answerOf(readForgeRun, ran.stdout, deps.say);
  const count = answer !== undefined ? forgeRunCount(answer) : undefined;
  const wrote = count !== undefined ? count.created > 0 : kept !== undefined;
  let verified: Verified | undefined;
  if (ran.code === DONE_EXIT && kept !== undefined && (count?.created ?? 0) > 0) {
    deps.say(`${resource.name}: verifying run ${n}`);
    const checked = await deps.runner(
      line.script,
      forgeVerifyLine({
        summary: summaryFile,
        target: target.alias,
        source: resource.source.alias,
      }),
      signal,
    );
    const verification =
      checked.stdout.trim() === ''
        ? undefined
        : answerOf(readForgeVerify, checked.stdout, deps.say);
    if (verification !== undefined) {
      const short = verificationShortOf(verification);
      verified = {
        unstable: verification.result.verdict === 'unstable',
        ...(short !== undefined ? { short } : {}),
      };
    } else if (checked.code !== DONE_EXIT) {
      verified = { unread: `its verification ended ${checked.code} without an answer` };
    }
  }
  return {
    state: current,
    script: line.script,
    code: ran.code,
    ...(count !== undefined ? { count } : {}),
    ...(answer !== undefined ? { answer } : {}),
    ...(kept !== undefined ? { summary } : {}),
    wrote,
    ...(planned !== undefined ? { planned } : {}),
    ...(verified !== undefined ? { verified } : {}),
    // A run that failed past its first objects keeps why in its summary; one
    // its gate refused before its first write says it in its line on stderr,
    // its code named, its summary naming no run to read.
    ...(answer?.error !== undefined ? { answered: answer.error } : {}),
    stderr: ran.stderr,
  };
}

/**
 * Run a frozen resource's load: its sas named in the state before the
 * script starts, held to its dry run's count, a reload for a replace. Its
 * answer is kept beside the state, and the verification the load chains
 * after it is read as its own. A load stopped part way keeps its mapping in
 * the sas, which the next apply's reload purges, or the destroy's removal
 * takes back.
 */
async function runFrozenStep(
  deps: EnvStepDeps,
  state: EnvState,
  input: RunStepInput,
  startedAt: string,
  planned: number | undefined,
): Promise<RunStepOutcome> {
  const { resource, n, where, target, templateFile, dry, signal } = input;
  const current = await deps.store.update(state, (s) =>
    runStarted(s, {
      resource: resource.name,
      kind: 'frozen',
      fingerprint: resource.fingerprint,
      dependsOn: resource.dependsOn,
      run: { script: 'sandforge-frozen', sas: frozenSasOf(resource.name), startedAt },
    }),
  );
  // Held to what its dry run counted to insert: a dataset or a target that
  // changed since is refused before its first write, the purge included.
  const maxTotal = dryRunTotalOf(dry);
  // With the accord of the environment's line, as a seed's and a clone's:
  // the load is refused for its emails otherwise, where the org delivers them.
  const line = withEmailsAccepted(
    applyLineOf(resource, {
      target: target.alias,
      templateFile,
      runId: '',
      summaryFile: '',
      replace: input.replace,
      acceptAutomation: input.acceptAutomation,
      ...(maxTotal !== undefined ? { maxTotal } : {}),
    }),
    input.acceptEmails,
  );
  const ran = await deps.runner(line.script, line.args, signal);
  const answer = answerOf(readFrozenRun, ran.stdout, deps.say);
  const count = answer !== undefined ? frozenRunCount(answer) : undefined;
  if (count?.refusal !== undefined) deps.say(`${resource.name}: ${count.refusal}`);
  // Killed, it said nothing: what it wrote is in the sas, which the state names.
  const wrote =
    answer === undefined
      ? isStopCode(ran.code)
      : (count?.created ?? 0) > 0 || reloadDeleted(answer);
  const summary =
    answer !== undefined
      ? await deps.store
          .writeFile(
            where.organizationId,
            where.env,
            runSummaryPathOf(resource.name, n),
            ran.stdout,
          )
          .then(() => runSummaryPathOf(resource.name, n))
      : undefined;
  const verdict = answer?.verdict;
  const verified: Verified | undefined =
    verdict !== undefined
      ? frozenVerdictShortOf(verdict)
      : ran.code === DONE_EXIT && (count?.created ?? 0) > 0
        ? { unread: 'the load chained no verification' }
        : undefined;
  return {
    state: current,
    script: line.script,
    code: ran.code,
    ...(count !== undefined ? { count } : {}),
    ...(answer !== undefined ? { answer } : {}),
    ...(summary !== undefined ? { summary } : {}),
    wrote,
    ...(planned !== undefined ? { planned } : {}),
    ...(verified !== undefined ? { verified } : {}),
    ...(input.replace && answer !== undefined && reloadPurgedWhole(answer)
      ? { tookBackEarlier: true }
      : {}),
    ...(count?.refusal !== undefined ? { answered: count.refusal } : {}),
    stderr: ran.stderr,
  };
}

/**
 * Run a mask resource's masking: the run named in the state before the
 * script starts, its DataOps store the resource's own folder of the state's,
 * which keeps the snapshot the script takes before its first write. Its
 * answer is kept beside the state, and the snapshot's id in the state: a
 * masking stopped before it answered leaves its snapshot in the store all
 * the same, which a destroy deletes with it.
 */
async function runMaskStep(
  deps: EnvStepDeps,
  state: EnvState,
  input: RunStepInput,
  startedAt: string,
): Promise<RunStepOutcome> {
  const { resource, n, where, target, templateFile, signal } = input;
  const current = await deps.store.update(state, (s) =>
    runStarted(s, {
      resource: resource.name,
      kind: 'mask',
      fingerprint: resource.fingerprint,
      dependsOn: resource.dependsOn,
      run: { script: 'sandforge-dataops', startedAt },
    }),
  );
  const store = await deps.store.prepareFolder(
    where.organizationId,
    where.env,
    maskStoreOf(resource.name),
  );
  // With the accord of the environment's own line: a masking is refused for
  // the emails what the org runs sends as the records are written over.
  const line = withEmailsAccepted(
    applyLineOf(resource, {
      target: target.alias,
      templateFile,
      runId: '',
      summaryFile: '',
      store,
    }),
    input.acceptEmails,
  );
  const ran = await deps.runner(line.script, line.args, signal);
  const answer = answerOf(readMaskRun, ran.stdout, deps.say);
  const masking = answer !== undefined ? maskRunCount(answer) : undefined;
  if (masking?.refusal !== undefined) deps.say(`${resource.name}: ${masking.refusal}`);
  // Killed, it said nothing: what it masked the store's audit trail keeps.
  const wrote =
    masking !== undefined
      ? masking.objects.some((object) => object.masked > 0)
      : isStopCode(ran.code);
  const summary =
    answer !== undefined
      ? await deps.store
          .writeFile(
            where.organizationId,
            where.env,
            runSummaryPathOf(resource.name, n),
            ran.stdout,
          )
          .then(() => runSummaryPathOf(resource.name, n))
      : undefined;
  return {
    state: current,
    script: line.script,
    code: ran.code,
    ...(answer !== undefined ? { answer } : {}),
    ...(summary !== undefined ? { summary } : {}),
    wrote,
    ...(masking !== undefined ? { masking } : {}),
    ...(masking?.refusal !== undefined ? { answered: masking.refusal } : {}),
    stderr: ran.stderr,
  };
}

/** The refusals of a users run its script refused before its first write: it answers its plan. */
function usersPlanRefusalsOf(stdout: string): string[] | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  if (usersApplyAnswerSchema.safeParse(raw).success) return undefined;
  const read = usersPlanAnswerSchema.safeParse(raw);
  return read.success ? (read.data.refusals ?? []).map((refusal) => refusal.message) : undefined;
}

/**
 * Run a users resource: the run named in the state before the script
 * starts, given the run it converges from when it replaces one. Its answer
 * is kept beside the state as the run's summary, which names the run of the
 * script a removal takes back. A run refused before its first write answers
 * its plan, and wrote nothing; one stopped before it answered is told by the
 * run file the script began ({@link usersRunOf}).
 */
async function runUsersStep(
  deps: EnvStepDeps,
  state: EnvState,
  input: RunStepInput,
  startedAt: string,
): Promise<RunStepOutcome> {
  const { resource, n, where, target, templateFile, signal } = input;
  const current = await deps.store.update(state, (s) =>
    runStarted(s, {
      resource: resource.name,
      kind: 'users',
      fingerprint: resource.fingerprint,
      dependsOn: resource.dependsOn,
      run: { script: USERS_SCRIPT, startedAt },
    }),
  );
  const line = withEmailsAccepted(
    applyLineOf(resource, {
      target: target.alias,
      templateFile,
      runId: '',
      summaryFile: '',
      acceptAutomation: input.acceptAutomation,
      acceptUserEmails: input.acceptUserEmails,
      ...(input.replacesRun !== undefined ? { replacesRun: input.replacesRun } : {}),
    }),
    input.acceptEmails,
  );
  const ran = await deps.runner(line.script, line.args, signal);
  const refusals = usersPlanRefusalsOf(ran.stdout);
  const answer =
    refusals === undefined ? answerOf(readUsersApply, ran.stdout, deps.say) : undefined;
  const count = answer !== undefined ? usersRunCount(answer) : undefined;
  const wrote =
    answer !== undefined
      ? answer.users.some((user) => user.done.length > 0)
      : refusals === undefined && ran.code !== FAILED_EXIT && ran.code !== 2;
  const summary =
    answer !== undefined
      ? await deps.store
          .writeFile(
            where.organizationId,
            where.env,
            runSummaryPathOf(resource.name, n),
            ran.stdout,
          )
          .then(() => runSummaryPathOf(resource.name, n))
      : undefined;
  const answered = count?.refusal ?? (refusals !== undefined ? refusals.join(' ') : undefined);
  return {
    state: current,
    script: line.script,
    code: ran.code,
    ...(count !== undefined ? { count } : {}),
    ...(answer !== undefined ? { answer } : {}),
    ...(summary !== undefined ? { summary } : {}),
    wrote,
    // Converged from the run before it, it holds what that one held, which
    // no removal takes back again.
    ...(input.replacesRun !== undefined && answer !== undefined ? { tookBackEarlier: true } : {}),
    ...(answered !== undefined && answered !== '' ? { answered } : {}),
    stderr: ran.stderr,
  };
}

/**
 * Run a replay resource: the replay named in the state before the script
 * starts, held to its dry run's count, a replay again (`--again`) for a
 * replace, whose purge takes back what the replays before it created. Its
 * answer is kept beside the state, and names the checkpoint its removal is
 * named by; one stopped before it answered is named by the payload it was
 * given, which names the same.
 */
async function runReplayStep(
  deps: EnvStepDeps,
  state: EnvState,
  input: RunStepInput,
  startedAt: string,
  planned: number | undefined,
): Promise<RunStepOutcome> {
  const { resource, n, where, target, templateFile, dry, signal } = input;
  const current = await deps.store.update(state, (s) =>
    runStarted(s, {
      resource: resource.name,
      kind: 'replay',
      fingerprint: resource.fingerprint,
      dependsOn: resource.dependsOn,
      run: { script: REPLAY_SCRIPT, startedAt },
    }),
  );
  const maxTotal = dryRunTotalOf(dry);
  const line = withEmailsAccepted(
    applyLineOf(resource, {
      target: target.alias,
      templateFile,
      runId: '',
      summaryFile: '',
      replace: input.replace,
      acceptAutomation: input.acceptAutomation,
      checkpointStore: envCheckpointStoreOf(deps.journalDir),
      ...(maxTotal !== undefined ? { maxTotal } : {}),
    }),
    input.acceptEmails,
  );
  const ran = await deps.runner(line.script, line.args, signal);
  const answer = answerOf(readReplayRun, ran.stdout, deps.say);
  const count = answer !== undefined ? replayRunCount(answer) : undefined;
  // Killed, it said nothing: what it wrote, the store of checkpoints keeps.
  const wrote = answer !== undefined ? (count?.created ?? 0) > 0 : isStopCode(ran.code);
  const summary =
    answer !== undefined
      ? await deps.store
          .writeFile(
            where.organizationId,
            where.env,
            runSummaryPathOf(resource.name, n),
            ran.stdout,
          )
          .then(() => runSummaryPathOf(resource.name, n))
      : undefined;
  return {
    state: current,
    script: line.script,
    code: ran.code,
    ...(count !== undefined ? { count } : {}),
    ...(answer !== undefined ? { answer } : {}),
    ...(summary !== undefined ? { summary } : {}),
    wrote,
    ...(planned !== undefined ? { planned } : {}),
    ...(input.replace && answer !== undefined && replayPurgedWhole(answer)
      ? { tookBackEarlier: true }
      : {}),
    ...(count?.refusal !== undefined ? { answered: count.refusal } : {}),
    stderr: ran.stderr,
  };
}

/**
 * How a masking ended: applied once it went through every record and left
 * no value as it was; partial when it left some, refused by the org; as every
 * run ends otherwise, a field the org does not show the user among them, which
 * the script refuses before it writes.
 */
function maskEnd(code: number, masking: MaskRunCount | undefined): ReturnType<typeof runEnd> {
  const ended = runEnd(code, undefined, undefined);
  if (code !== DONE_EXIT) return ended;
  const left = (masking?.objects ?? []).reduce((sum, object) => sum + object.notMasked, 0);
  if (masking?.short !== undefined || left > 0) {
    return {
      status: 'partial',
      counts: PARTIAL_EXIT,
      stops: false,
      short:
        masking?.short ??
        `${left} record(s) still hold their original values: the next apply masks them again`,
    };
  }
  return { status: 'applied', counts: DONE_EXIT, stops: false };
}

/** A masking's step objects: per object what it masked, what the org refused, and the snapshot it took first. */
function maskObjects(masking: MaskRunCount | undefined): EnvStepObject[] {
  return (masking?.objects ?? []).map((object, i) => ({
    object: object.object,
    created: 0,
    refused: object.refused,
    deleted: 0,
    kept: 0,
    masked: object.masked,
    ...(i === 0 && masking?.snapshotId !== undefined
      ? {
          reason:
            `snapshot ${masking.snapshotId} of the values it wrote over, taken first, kept on ` +
            'this machine until destroy deletes it',
        }
      : {}),
  }));
}

/**
 * The payload a resource's run is given: a seed's template with the parents
 * its draws are handed, read from the runs of the resources they draw from as
 * the state names them now; a frozen resource's configuration, its sas
 * prepared in the state's folder; or why the run cannot start.
 */
async function runPayloadOf(
  deps: EnvStepDeps,
  state: EnvState,
  resource: EnvFileResource,
  where: Where,
  target: EnvTarget,
): Promise<{ payload: unknown } | { refusal: string }> {
  if (resource.kind === 'frozen') {
    const sasDir = await deps.store.prepareFolder(
      where.organizationId,
      where.env,
      frozenSasOf(resource.name),
    );
    return { payload: payloadOf(resource, { sasDir }) };
  }
  if (resource.kind === 'replay') {
    // What it replays, by the id the plan resolved: what a removal of a
    // replay stopped before it answered is named by.
    const read = resource.checkpoint.read;
    if (read === undefined || 'refusal' in read) {
      return { refusal: read?.refusal ?? 'its checkpoint was not resolved: plan again' };
    }
    return {
      payload: {
        command: 'replay',
        checkpoint: { id: read.checkpointId, organizationId: read.organizationId },
      },
    };
  }
  if (resource.kind !== 'seed' || (resource.run.draws ?? []).length === 0) {
    return { payload: payloadOf(resource, {}) };
  }
  const drawn = await drawnOf(
    resource,
    state,
    new Set(),
    { ...where, target: target.alias },
    { store: deps.store, journalDir: deps.journalDir },
  );
  if (drawn.refusals.length > 0) return { refusal: drawn.refusals.join(' ') };
  return { payload: payloadOf(resource, { drawn: drawn.ids }) };
}

/**
 * The state with each resource the plan keeps, or says drifted, applied from
 * the file as it stands: its fingerprint, which chains those of what it
 * depends on, is the file's. What it writes did not change — the plan would
 * replace it otherwise —: only a masking under it changed, which runs again
 * over the records it masked and makes no record for it to be replaced with.
 * Left as it was, the next plan read the chain that moved as a change of its
 * own, and replaced it. The state itself when none moved.
 */
export function withKeptFingerprints(
  state: EnvState,
  plan: Pick<EnvPlan, 'actions'>,
  resources: ReadonlyMap<string, Pick<EnvFileResource, 'fingerprint'>>,
): EnvState {
  let next = state;
  for (const action of plan.actions) {
    if (action.action !== 'keep' && action.action !== 'drifted') continue;
    const kept = next.resources[action.resource];
    const fingerprint = resources.get(action.resource)?.fingerprint;
    if (
      kept === undefined ||
      fingerprint === undefined ||
      kept.recovered === true ||
      kept.status === 'destroyed' ||
      kept.fingerprint === fingerprint
    ) {
      continue;
    }
    next = {
      ...next,
      resources: { ...next.resources, [action.resource]: { ...kept, fingerprint } },
    };
  }
  return next;
}

/** The status a run result says, from the exit code an apply or a destroy ends with. */
export function statusOf(exitCode: number): EnvRunResult['status'] {
  if (exitCode === DONE_EXIT) return 'success';
  if (isStopCode(exitCode)) return 'cancelled';
  if (exitCode === FAILED_EXIT) return 'failure';
  return 'partial';
}

/**
 * Apply a plan to its org: see the module's comment. Refused before its first
 * step — the plan refuses, another apply holds the org, the state moved since
 * the plan — it writes nothing and ends 1.
 */
export async function applyPlan(deps: EnvStepDeps, input: EnvApplyInput): Promise<EnvRunOutcome> {
  const { plan, target, resolved } = input;
  const env = resolved.checked.file.name;
  /** Refused before its first step, under the codes of what refused it where they are known. */
  const refused = (
    refusal: string,
    state = input.state,
    codes: readonly string[] = [],
  ): EnvRunOutcome => ({
    result: {
      plan,
      steps: [],
      status: 'failure',
      refusal,
      ...(codes.length > 0 ? { refusalCodes: [...codes] } : {}),
      state: { serial: state?.serial ?? 0 },
    },
    exitCode: FAILED_EXIT,
  });
  if (plan.refusal !== undefined) return refused(plan.refusal, input.state, plan.refusalCodes);
  const steps = applySteps(plan, input.state);
  const beforeTake = plan.checkpoints?.find((c) => c.step === 'before');
  const afterTake = plan.checkpoints?.find((c) => c.step === 'after');
  if (steps.length === 0 && afterTake === undefined) {
    deps.say('nothing to do: the org holds the environment as the file describes it');
    return {
      result: { plan, steps: [], status: 'success', state: { serial: input.state?.serial ?? 0 } },
      exitCode: DONE_EXIT,
    };
  }

  const taken = acquireEnvLock(
    deps.locksDir,
    target.organizationId,
    { operation: 'apply' satisfies EnvLockOperation, env, alias: target.alias },
    deps.lockOptions,
  );
  if ('busy' in taken) {
    const busy = lockRefusal(taken.busy);
    return refused(busy.message, input.state, [busy.code]);
  }
  const stop = new AbortController();
  let stoppedBy: StopSignal | undefined;
  const release = (deps.onStop ?? onStopSignal)((signal) => {
    stoppedBy = signal;
    deps.say(
      `\nstopped by ${signal}: the step under way stops before its next call to the org, and ` +
        'the state keeps what it wrote; apply again takes up from there',
    );
    stop.abort();
  });
  try {
    // Another apply, or a cache put back, since the plan: refused, never
    // written over.
    let current: EnvState;
    try {
      const read = await deps.store.read(target.organizationId, env);
      const moved =
        (read === undefined) !== (input.state === undefined) ||
        (read !== undefined &&
          (read.serial !== input.state?.serial || read.lineage !== input.state.lineage));
      if (moved) {
        return refused(
          `The state of ${env} on ${target.alias} changed since the plan (another apply or ` +
            'destroy ran, or a cache put back another state). Nothing was written: plan again.',
          read,
          [STATE_MOVED],
        );
      }
      current =
        read ??
        newEnvState({
          env,
          org: {
            organizationId: target.organizationId,
            kind: target.kind,
            username: target.username,
            alias: target.alias,
            ...(target.host !== undefined ? { host: target.host } : {}),
          },
          fileDigest: resolved.digest,
          sandforgeVersion: deps.sandforgeVersion,
        });
    } catch (err: unknown) {
      if (err instanceof EnvStateError) {
        return refused(err.message, input.state, [stateRefusal(err).code]);
      }
      throw err;
    }
    // The host the org answers on, kept: what proves its refresh to the next plan.
    current = {
      ...withOrgHost(current, target.host),
      file: { digest: resolved.digest },
      sandforgeVersion: deps.sandforgeVersion,
    };

    const where = { organizationId: target.organizationId, env };
    const results: EnvStepResult[] = [];
    const skipped: Array<{ resource: string; why: string }> = [];
    const codes: number[] = [];
    /** Resources whose run did not end whole: what depends on them does not run. */
    const notWhole = new Map<string, string>();
    let wrote = false;
    let stoppedCode: number | undefined;
    const resources = new Map(resolved.resources.map((resource) => [resource.name, resource]));
    /** The resources this apply ran the script of. */
    const runThisApply = new Set<string>();
    /** The steps that began, for an error to name those it kept from running. */
    let began = 0;
    const checkpoints: EnvCheckpointStepResult[] = [];
    const org = { alias: target.alias, kind: target.kind };
    const settings = takeSettingsOf(resolved.checked.file);

    // Before the first write, or nothing is written: an environment applied
    // without it would leave destroy --rewind nothing to return to.
    if (beforeTake !== undefined && steps.length > 0) {
      const taken = await takeEnvCheckpoint(
        deps,
        {
          org,
          step: 'before',
          name: beforeTake.name,
          ...settings,
        },
        stop.signal,
      );
      checkpoints.push(taken.result);
      if (taken.checkpoint === undefined) {
        const code =
          stoppedBy !== undefined
            ? stopExitCode(stoppedBy)
            : isStopCode(taken.result.exitCode)
              ? taken.result.exitCode
              : FAILED_EXIT;
        return {
          result: {
            plan,
            steps: [],
            checkpoints,
            status: statusOf(code),
            refusal:
              `The checkpoint before the first write, '${beforeTake.name}', was not taken ` +
              `(${taken.result.refusal ?? `exit ${taken.result.exitCode}`}). Nothing was written.`,
            state: { serial: current.serial },
          },
          exitCode: code,
        };
      }
      const id = taken.checkpoint;
      current = await deps.store.update(current, (s) => withCheckpoint(s, 'before', id));
    }

    // What the plan keeps under a masking that runs again is applied from the
    // file as it stands, before any step: a stop part way leaves it so too.
    if (withKeptFingerprints(current, plan, resources) !== current) {
      current = await deps.store.update(current, (s) => withKeptFingerprints(s, plan, resources));
    }

    try {
      for (const step of steps) {
        began += 1;
        if (stoppedCode !== undefined || stoppedBy !== undefined) {
          skipped.push({ resource: step.resource, why: 'the apply was stopped before it' });
          continue;
        }
        const resource = resources.get(step.resource);
        const blockedBy = (resource?.dependsOn ?? []).filter((dep) => notWhole.has(dep));
        if (step.phase === 'run' && blockedBy.length > 0) {
          skipped.push({
            resource: step.resource,
            why: `it depends on ${blockedBy.map((dep) => `${dep} (${notWhole.get(dep) ?? 'not whole'})`).join(', ')}`,
          });
          continue;
        }
        // A take, a rewind or an undo of the org's checkpoints would read or
        // write what the step writes as it writes it.
        const busy = checkpointLockRefusal(deps.locksDir, target.organizationId, deps.lockOptions);
        if (busy !== undefined) {
          deps.say(checkpointActRefusal(busy).message);
          codes.push(FAILED_EXIT);
          skipped.push({ resource: step.resource, why: checkpointActRefusal(busy).message });
          break;
        }

        if (step.phase === 'remove') {
          const accept =
            input.acceptAutomation ||
            resolved.checked.file.resources[step.resource]?.accept?.automation === true;
          const ended = await removeResource(
            deps,
            current,
            {
              resource: step.resource,
              action: step.action,
              target,
              includeChanged: false,
              sweep: false,
              acceptAutomation: accept,
              ends: { whole: 'destroyed', left: 'partial' },
            },
            stop.signal,
          );
          current = ended.state;
          results.push(...ended.steps);
          wrote ||= ended.wrote;
          if (isStopCode(ended.code)) {
            stoppedCode = ended.code;
            continue;
          }
          codes.push(ended.code);
          if (ended.code !== DONE_EXIT && ended.code !== PARTIAL_EXIT) break;
          continue;
        }

        // The run half: the template, then the state ahead of the spawn.
        if (resource === undefined) continue;
        const n = nextRunNumber(current.resources[step.resource]);
        const payload = await runPayloadOf(deps, current, resource, where, target);
        if ('refusal' in payload) {
          // Refused before its script starts: nothing of it was written.
          deps.say(`${step.resource}: not run, ${payload.refusal}`);
          codes.push(FAILED_EXIT);
          skipped.push({ resource: step.resource, why: payload.refusal });
          notWhole.set(step.resource, 'not run');
          break;
        }
        const templateFile = await deps.store.writeFile(
          where.organizationId,
          env,
          runTemplatePathOf(step.resource, n),
          `${JSON.stringify(payload.payload, null, 2)}\n`,
        );
        // Held to what its dry run counted, unless what it depends on ran first
        // in this apply: the dry run read the org before those records were
        // there, and a relation drawing them as existing parents counted none.
        const readTooEarly = resource.dependsOn.some((dep) => runThisApply.has(dep));
        // A users resource replaced converges from its last run known.
        const replacesRun =
          resource.kind === 'users' && step.action === 'replace'
            ? usersReplacesOf(current.resources[step.resource], where, deps).run
            : undefined;
        deps.say(`${step.resource}: run ${n} (${step.action})`);
        const outcome = await runResourceStep(deps, current, {
          resource,
          n,
          where,
          target,
          templateFile,
          dry: input.dryRuns[step.resource],
          readTooEarly,
          replace: step.action === 'replace' && replacesInOneRun(resource.kind),
          acceptAutomation:
            input.acceptAutomation ||
            resolved.checked.file.resources[step.resource]?.accept?.automation === true,
          acceptEmails: input.acceptEmails === true,
          acceptUserEmails: input.acceptUserEmails === true,
          ...(replacesRun !== undefined ? { replacesRun } : {}),
          signal: stop.signal,
        });
        current = outcome.state;
        wrote ||= outcome.wrote;
        // A masking writes over records the org holds, and creates none for
        // what depends on it to count.
        if (resource.kind !== 'mask') runThisApply.add(step.resource);
        const masking = outcome.masking;
        const ended =
          resource.kind === 'mask'
            ? maskEnd(outcome.code, masking)
            : verifiedEnd(runEnd(outcome.code, outcome.count, outcome.planned), outcome.verified);
        const endedAt = await deps.orgNow();
        current = await deps.store.update(current, (s) =>
          stepEnded(s, {
            resource: step.resource,
            status: ended.status,
            run: {
              endedAt,
              exitCode: outcome.code,
              objects:
                masking !== undefined
                  ? masking.objects.map((object) => ({
                      objectApiName: object.object,
                      created: 0,
                      refused: object.refused,
                      masked: object.masked,
                    }))
                  : (outcome.count?.objects ?? []).map((object) => ({
                      objectApiName: object.object,
                      created: object.created,
                      refused: object.refused,
                    })),
              ...(outcome.summary !== undefined ? { summary: outcome.summary } : {}),
              ...(masking?.snapshotId !== undefined ? { snapshotId: masking.snapshotId } : {}),
            },
          }),
        );
        if (outcome.tookBackEarlier === true) {
          // The reload's purge, or a replay's again, took what the runs before
          // it created, and a users run converged holds what the one before
          // it held: no removal looks for them again.
          for (const earlier of current.resources[step.resource]?.runs ?? []) {
            if (earlier.n === n || earlier.takenBack === true) continue;
            current = await deps.store.update(current, (s) =>
              runTakenBack(s, step.resource, earlier.n),
            );
          }
        }
        const objects = resource.kind === 'mask' ? maskObjects(masking) : runObjects(outcome.count);
        const refusal = stepRefusalOf(outcome.code, outcome.answered, outcome.stderr);
        results.push({
          resource: step.resource,
          action: step.action,
          phase: 'run',
          run: n,
          script: outcome.script,
          exitCode: outcome.code,
          status: ended.status,
          ...(outcome.summary !== undefined ? { summary: outcome.summary } : {}),
          objects:
            ended.short !== undefined && objects[0] !== undefined
              ? [{ ...objects[0], reason: ended.short }, ...objects.slice(1)]
              : objects,
          ...(outcome.answer !== undefined ? { answer: outcome.answer } : {}),
          ...(refusal !== undefined ? { refusal } : {}),
        });
        if (ended.short !== undefined) deps.say(`${step.resource}: ${ended.short}`);
        if (isStopCode(outcome.code)) {
          stoppedCode = outcome.code;
          deps.say(
            resource.kind === 'mask'
              ? `${step.resource}: its masking was stopped; the state keeps it applying, and its ` +
                  'store the snapshot it took first: apply again masks what its condition selects'
              : resource.kind === 'users'
                ? `${step.resource}: its run was stopped; the state keeps it applying, and the ` +
                  'run file of sandforge users what it changed: apply again converges from it'
                : `${step.resource}: its run was stopped; the state keeps it applying, and its ` +
                  `${
                    resource.kind === 'forge'
                      ? 'summary what it created'
                      : resource.kind === 'frozen'
                        ? 'sas what it loaded'
                        : resource.kind === 'replay'
                          ? 'payload the checkpoint it replays'
                          : 'run file what it wrote'
                  }: apply again takes it back and runs it whole`,
          );
          continue;
        }
        codes.push(ended.counts);
        if (ended.status !== 'applied') {
          notWhole.set(step.resource, ended.status);
        }
        if (ended.stops) break;
      }
    } catch (err: unknown) {
      // A state that could not be written, a script that could not be
      // started: the apply stops there. What it wrote before, the state
      // names, and the exit says partial once anything was written.
      const why = `the apply stopped on an error: ${err instanceof Error ? err.message : String(err)}`;
      deps.say(why);
      codes.push(FAILED_EXIT);
      for (const step of steps.slice(began)) skipped.push({ resource: step.resource, why });
    }

    // What the last apply's checkpoint holds is no longer the environment as
    // applied once this one wrote: a reset to it would take back what this
    // one wrote, and leave the state naming it.
    const stale = current.checkpoints?.after;
    if (wrote && stale !== undefined && stoppedBy === undefined) {
      const deleted = await deleteEnvCheckpoint(
        deps,
        { org, checkpoint: stale, why: 'taken before this apply wrote' },
        stop.signal,
      );
      checkpoints.push(deleted);
      current = await deps.store.update(current, (s) => withCheckpoint(s, 'after', undefined));
    }
    const whole =
      stoppedBy === undefined && stoppedCode === undefined && worstExit(codes) === DONE_EXIT;
    if (afterTake !== undefined && whole) {
      const taken = await takeEnvCheckpoint(
        deps,
        {
          org,
          step: 'after',
          name: afterTake.name,
          ...settings,
        },
        stop.signal,
      );
      checkpoints.push(taken.result);
      const id = taken.checkpoint;
      if (id !== undefined) {
        current = await deps.store.update(current, (s) => withCheckpoint(s, 'after', id));
      } else if (isStopCode(taken.result.exitCode)) {
        stoppedCode = taken.result.exitCode;
      } else {
        deps.say(
          `the checkpoint once applied, '${afterTake.name}', was not taken: reset has nothing to ` +
            'rewind to until an apply takes it, which the next one does',
        );
        codes.push(FAILED_EXIT);
      }
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
    return {
      result: {
        plan,
        steps: results,
        ...(checkpoints.length > 0 ? { checkpoints } : {}),
        ...(skipped.length > 0 ? { skipped } : {}),
        status: statusOf(exitCode),
        state: { serial: current.serial },
      },
      exitCode,
    };
  } finally {
    release();
    taken.lock.release();
  }
}

/** The lines the checkpoints of an apply or a destroy are said in. */
function checkpointResultLines(checkpoints: readonly EnvCheckpointStepResult[]): string[] {
  return checkpoints.map((step) => {
    const what =
      step.step === 'delete'
        ? `checkpoint ${step.checkpoint ?? ''} deleted`
        : `checkpoint ${step.step === 'before' ? 'before the first write' : 'once applied'}`;
    if (step.exitCode !== DONE_EXIT) {
      return `  ${what}: exit ${step.exitCode}, ${step.step === 'delete' ? 'kept' : 'not taken'}: ${step.refusal ?? ''}`;
    }
    return step.step === 'delete'
      ? `  ${what}`
      : `  ${what}: exit 0, taken ${step.checkpoint ?? ''}`;
  });
}

/** How long the link Salesforce mails to an address asked back is said to stay good. */
const ADDRESS_LINK_HOURS = 72;

/**
 * What a users step says: of a run, the users it set up, then each address
 * awaiting its owner's click, which Salesforce mailed; of a removal, the
 * assignments and memberships it deleted, the changes it put back — those
 * deletions among them —, and what it kept, each user named with why.
 */
function usersStepLines(step: EnvStepResult): string[] {
  const head = `  ${step.resource} ${step.phase === 'run' ? 'run' : 'removal of run'} ${step.run}: exit ${step.exitCode}, ${step.status}`;
  if (step.phase === 'run') {
    const answer = usersApplyAnswerSchema.safeParse(step.answer);
    const lines: string[] = [];
    if (answer.success) {
      const setUp = answer.data.users.filter((user) => user.done.length > 0).length;
      const refused = answer.data.users.filter((user) => (user.refused ?? []).length > 0).length;
      lines.push(`${head}  User ${setUp} set up${refused > 0 ? `, ${refused} refused` : ''}`);
      for (const user of answer.data.users) {
        if (user.address !== 'awaiting') continue;
        lines.push(
          `      ${user.username}: address awaiting its owner's confirmation — Salesforce sent ` +
            `the link to it; until it is clicked (${ADDRESS_LINK_HOURS} h), the address stays .invalid`,
        );
      }
    } else {
      lines.push(head);
    }
    if (step.refusal !== undefined) lines.push(`      ${step.refusal}`);
    for (const object of step.objects) {
      if (object.reason !== undefined) lines.push(`      ${object.object}: ${object.reason}`);
    }
    return lines;
  }
  const removal = step.answer as Partial<UsersRemovalAnswer> | undefined;
  const deleted = step.objects
    .map((object) => `${object.object} ${object.deleted} deleted`)
    .join('; ');
  const undone = typeof removal?.undone === 'number' ? removal.undone : undefined;
  const said = [
    deleted,
    undone !== undefined
      ? `${undone} change(s) of its users put back, the deletions among them`
      : '',
  ].filter(Boolean);
  const lines = [`${head}${said.length > 0 ? `  ${said.join('; ')}` : ''}`];
  if (step.refusal !== undefined) lines.push(`      ${step.refusal}`);
  for (const kept of Array.isArray(removal?.kept) ? removal.kept : []) {
    lines.push(`      ${kept.username}: ${changeWords(kept.change)} kept, ${kept.why}`);
  }
  return lines;
}

/** What a replay's run says: per object what it created, then whose records kept their owner. */
function replayStepLines(step: EnvStepResult): string[] {
  const created = step.objects.map((object) => `${object.object} ${object.created}`).join(', ');
  const refused = step.objects.reduce((sum, object) => sum + object.refused, 0);
  const owners = (
    step.answer as { replay?: { owners?: { kept?: unknown; toRunningUser?: unknown } } } | undefined
  )?.replay?.owners;
  const kept = typeof owners?.kept === 'number' ? owners.kept : undefined;
  const toYou = typeof owners?.toRunningUser === 'number' ? owners.toRunningUser : undefined;
  const said =
    (created !== '' ? `${created} created` : '') +
    (refused > 0 ? `, ${refused} refused` : '') +
    (kept !== undefined && toYou !== undefined
      ? `; ${kept} records kept their owner, ${toYou} went to you`
      : '');
  const lines = [
    `  ${step.resource} replay ${step.run}: exit ${step.exitCode}, ${step.status}` +
      (said !== '' ? `  ${said}` : ''),
  ];
  if (step.refusal !== undefined) lines.push(`      ${step.refusal}`);
  for (const object of step.objects) {
    if (object.reason !== undefined) lines.push(`      ${object.object}: ${object.reason}`);
  }
  return lines;
}

/**
 * The lines an apply or a destroy ends with; `said`, what came after its
 * steps — the audits, the handoff note —, before the last.
 */
export function runResultLines(
  result: EnvRunResult,
  verb: 'apply' | 'destroy',
  said: readonly string[] = [],
): string[] {
  const lines: string[] = [''];
  for (const step of result.steps) {
    if (step.script === USERS_SCRIPT) {
      lines.push(...usersStepLines(step));
      continue;
    }
    if (step.script === REPLAY_SCRIPT && step.phase === 'run') {
      lines.push(...replayStepLines(step));
      continue;
    }
    // A masking writes over records, and its destroy leaves them masked.
    if (step.script === 'sandforge-dataops') {
      const masked = step.objects
        .map((object) =>
          step.phase === 'run'
            ? `${object.object} ${object.masked ?? 0} masked${object.refused > 0 ? `, ${object.refused} refused` : ''}`
            : `${object.object} ${object.masked ?? 0} left masked`,
        )
        .join('; ');
      lines.push(
        `  ${step.resource} ${step.phase === 'run' ? `masking ${step.run}: exit ${step.exitCode}` : 'store deleted'}, ` +
          `${step.status}${masked ? `  ${masked}` : ''}`,
      );
      if (step.refusal !== undefined) lines.push(`      ${step.refusal}`);
      for (const object of step.objects) {
        if (object.reason !== undefined) lines.push(`      ${object.object}: ${object.reason}`);
      }
      continue;
    }
    const counts = step.objects
      .map((object) =>
        step.phase === 'run'
          ? `${object.object} ${object.created} created${object.refused > 0 ? `, ${object.refused} refused` : ''}`
          : `${object.object} ${object.deleted} deleted${object.kept > 0 ? `, ${object.kept} kept` : ''}`,
      )
      .join('; ');
    lines.push(
      `  ${step.resource} ${step.phase === 'run' ? 'run' : 'removal of run'} ${step.run}: ` +
        `exit ${step.exitCode}, ${step.status}${counts ? `  ${counts}` : ''}`,
    );
    // The script's own words, as it refused or failed the step.
    if (step.refusal !== undefined) lines.push(`      ${step.refusal}`);
    for (const object of step.objects) {
      if (object.reason !== undefined) lines.push(`      ${object.object}: ${object.reason}`);
    }
  }
  for (const skip of result.skipped ?? []) lines.push(`  ${skip.resource}: not run, ${skip.why}`);
  lines.push(...checkpointResultLines(result.checkpoints ?? []));
  if (result.refusal !== undefined) lines.push(`${verb} refused: ${result.refusal}`);
  lines.push(...said);
  lines.push(`${verb}: ${result.status}; state serial ${result.state.serial}`);
  return lines;
}
