/**
 * Applying a plan: each resource's step run by its own script, in the order
 * the plan's dependencies give, its outcome kept in the state before the
 * next one starts.
 *
 * The environment writes nothing to the org itself. A step spawns the script
 * that does the work — `sandforge-seed` with the template the file converts
 * into, under a run id of the environment's making — and every guard, gate
 * and run file of the script holds as it holds on a terminal.
 *
 * Write-ahead: before a script is spawned, its resource goes to `applying`
 * (or `destroying`) in the state, with the run's rank, id and the time on the
 * org's clock, written and renamed over before the spawn. A process killed
 * anywhere leaves a state that names the run, and the seed's run file names
 * what it wrote: the next plan replaces the resource from it.
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
 * | 4                                        | `partial`              | stops                          |
 * | 129, 130, 143                            | stays `applying`       | stops; the next apply replaces it |
 *
 * The apply exits with the worst of its steps (`worstExit`), but 1 only when
 * it wrote nothing: once a step wrote, the org holds part of the environment
 * and the state names it, which is partial (3). An apply whose plan holds
 * nothing to do writes nothing, to the org or the state: applied twice, the
 * second writes nothing and leaves the state's serial where it was.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type {
  EnvActionKind,
  EnvPlan,
  EnvResourceStatus,
  EnvRunResult,
  EnvState,
  EnvStepObject,
  EnvStepResult,
} from '@sandforge/shared';
import type { LinkedLockOptions } from '../../src/modules/checkpoint/linkedLock.js';
import { SEED_RUNS_DIR } from '../../src/modules/seed/SeedRunCreations.js';
import { DONE_EXIT, FAILED_EXIT, PARTIAL_EXIT, UNSTABLE_EXIT, worstExit } from '../exitCodes.js';
import type { CommandRunner } from '../scriptRunner.js';
import { STOP_SIGNALS, onStopSignal, stopExitCode, type StopSignal } from '../stopSignals.js';
import type { EnvFileResolved } from './envFile.js';
import { checkpointActRefusal, lockRefusal, type EnvTarget } from './envGuards.js';
import { acquireEnvLock, checkpointLockRefusal, type EnvLockOperation } from './envLock.js';
import { liveResources, removalOrder, type EnvDryRun } from './envPlan.js';
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
  type EnvStore,
} from './envState.js';
import {
  SEED_SCRIPT,
  StepAnswerError,
  readSeedRemoval,
  readSeedRun,
  seedApplyLine,
  seedRemoveLine,
  type SeedRemovalAnswer,
  type SeedRunAnswer,
} from './envSteps.js';

/** What a step runs with, beside its line: the product's own, or a test's. */
export interface EnvStepDeps {
  /** Runs a script of `cli/` with the arguments after its name. */
  runner: CommandRunner;
  store: EnvStore;
  /** Where the environment locks and the checkpoint locks are. */
  locksDir: string;
  /** The folder `SANDFORGE_JOURNAL_DIR` names, where the seed keeps its run files. */
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

/** A removal's answer, per object, as a step names it. */
function removalObjects(answer: SeedRemovalAnswer | undefined): EnvStepObject[] {
  return (answer?.result.objects ?? []).map((object) => {
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

/** A run's answer, per object, as a step names it. */
function runObjects(answer: SeedRunAnswer | undefined): EnvStepObject[] {
  return (answer?.result.objectResults ?? []).map((object) => ({
    object: object.objectApiName,
    created: object.recordsCreated,
    refused: object.recordsFailed,
    deleted: 0,
    kept: 0,
    ...(object.errors.length > 0
      ? { reason: object.errors.slice(0, 5).join('; ').slice(0, 2_000) }
      : {}),
  }));
}

/** What a script printed on stdout read with `read`, or undefined, the reason said. */
function answerOf<T>(
  read: (stdout: string) => T,
  stdout: string,
  say: (line: string) => void,
): T | undefined {
  if (stdout.trim() === '') return undefined;
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
 * file, by its id, which the seed writes as the org takes its records; or
 * nothing, for a run that never wrote: no summary and no run file.
 */
export function removalSubjectOf(
  run: { summary?: string; runId?: string },
  where: Where,
  deps: Pick<EnvStepDeps, 'store' | 'journalDir'>,
): string | undefined {
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
  return undefined;
}

/** How taking back one resource's runs ended. */
export interface RemovalEnd {
  /** Every run taken back whole: nothing of the resource is left in the org. */
  whole: boolean;
  /** The exit code that ended it: 0, 3 (records left), or the one that stopped it. */
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
 * Take back every run of a resource, the last first, through the seed's own
 * removal: the resource `destroying` in the state before the first spawn,
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
  let current = await deps.store.update(state, (s) => removalStarted(s, ask.resource));
  const steps: EnvStepResult[] = [];
  let left = false;
  let wrote = false;
  for (const run of [...before.runs].reverse()) {
    if (run.takenBack === true) continue;
    const subject = removalSubjectOf(run, where, deps);
    if (subject === undefined) continue;
    deps.say(`${ask.resource}: taking back run ${run.n}`);
    const ran = await deps.runner(
      SEED_SCRIPT,
      seedRemoveLine({
        target: ask.target.alias,
        summary: subject,
        includeChanged: ask.includeChanged,
        acceptAutomation: ask.acceptAutomation,
        sweep: ask.sweep,
      }),
      signal,
    );
    const answer = answerOf(readSeedRemoval, ran.stdout, deps.say);
    const deleted = (answer?.result.objects ?? []).reduce((sum, o) => sum + o.deleted, 0);
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
    steps.push({
      resource: ask.resource,
      action: ask.action,
      phase: 'remove',
      run: run.n,
      script: SEED_SCRIPT,
      exitCode: ran.code,
      status,
      ...(run.summary !== undefined ? { summary: run.summary } : {}),
      objects: removalObjects(answer),
      ...(answer !== undefined ? { answer } : {}),
    });
    if (ran.code === PARTIAL_EXIT) left = true;
    if (ran.code === DONE_EXIT) {
      current = await deps.store.update(current, (s) => runTakenBack(s, ask.resource, run.n));
    }
    if (!ok) {
      if (!stopped)
        current = await deps.store.update(current, (s) =>
          stepEnded(s, { resource: ask.resource, status: before.status }),
        );
      return { whole: false, code: ran.code, wrote, steps, state: current };
    }
  }
  current = await deps.store.update(current, (s) =>
    stepEnded(s, { resource: ask.resource, status: left ? ask.ends.left : ask.ends.whole }),
  );
  return { whole: !left, code: left ? PARTIAL_EXIT : DONE_EXIT, wrote, steps, state: current };
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
}

/** A step of an apply: a resource's runs taken back, or its script run. */
type ApplyStep =
  | { phase: 'remove'; resource: string; action: EnvActionKind }
  | { phase: 'run'; resource: string; action: EnvActionKind };

/** The steps of a plan, in the order they run: see the module's comment. */
export function applySteps(plan: EnvPlan, state: EnvState | undefined): ApplyStep[] {
  const byName = new Map(plan.actions.map((action) => [action.resource, action]));
  const live = new Set(liveResources(state).map(([name]) => name));
  const removed = removalOrder(
    state,
    plan.actions
      .filter((a) => (a.action === 'delete' || a.action === 'replace') && live.has(a.resource))
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
  answer: SeedRunAnswer | undefined,
  planned: number | undefined,
): { status: EnvResourceStatus; counts: number; stops: boolean; short?: string } {
  if (isStopCode(code)) return { status: 'applying', counts: code, stops: true };
  if (code === DONE_EXIT && answer !== undefined) {
    const created = answer.result.totalRecordsCreated;
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
  const refused = (refusal: string, state = input.state): EnvRunOutcome => ({
    result: {
      plan,
      steps: [],
      status: 'failure',
      refusal,
      state: { serial: state?.serial ?? 0 },
    },
    exitCode: FAILED_EXIT,
  });
  if (plan.refusal !== undefined) return refused(plan.refusal);
  const steps = applySteps(plan, input.state);
  if (steps.length === 0) {
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
  if ('busy' in taken) return refused(lockRefusal(taken.busy).message);
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
          },
          fileDigest: resolved.digest,
          sandforgeVersion: deps.sandforgeVersion,
        });
    } catch (err: unknown) {
      if (err instanceof EnvStateError) return refused(err.message);
      throw err;
    }
    current = {
      ...current,
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
        const runId = envRunIdOf(env, step.resource, n);
        const templateFile = await deps.store.writeFile(
          where.organizationId,
          env,
          runTemplatePathOf(step.resource, n),
          `${JSON.stringify(resource.run.template, null, 2)}\n`,
        );
        const dry = input.dryRuns[step.resource];
        const dryAnswer = dry !== undefined && 'answer' in dry ? dry.answer : undefined;
        // The seed the dry run drew, when the file pins none: the run writes
        // the records the dry run counted.
        const seed = resource.run.seed ?? dryAnswer?.seed;
        const startedAt = await deps.orgNow();
        current = await deps.store.update(current, (s) =>
          runStarted(s, {
            resource: step.resource,
            kind: 'seed',
            fingerprint: resource.fingerprint,
            dependsOn: resource.dependsOn,
            run: { script: SEED_SCRIPT, runId, ...(seed !== undefined ? { seed } : {}), startedAt },
          }),
        );
        deps.say(`${step.resource}: run ${n} (${step.action})`);
        const ran = await deps.runner(
          SEED_SCRIPT,
          seedApplyLine({
            target: target.alias,
            templateFile,
            runId,
            ...(seed !== undefined ? { seed } : {}),
            ...(resource.run.locale !== undefined ? { locale: resource.run.locale } : {}),
            ...(resource.run.recordTypes !== undefined
              ? { recordTypes: resource.run.recordTypes }
              : {}),
          }),
          stop.signal,
        );
        const answer = answerOf(readSeedRun, ran.stdout, deps.say);
        const created = answer?.result.totalRecordsCreated ?? 0;
        wrote ||=
          created > 0 || existsSync(join(deps.journalDir, SEED_RUNS_DIR, `${runId}.ndjson`));
        runThisApply.add(step.resource);
        const summary =
          answer !== undefined
            ? await deps.store
                .writeFile(
                  where.organizationId,
                  env,
                  runSummaryPathOf(step.resource, n),
                  ran.stdout,
                )
                .then(() => runSummaryPathOf(step.resource, n))
            : undefined;
        // Held to what its dry run counted, unless what it depends on ran first
        // in this apply: the dry run read the org before those records were
        // there, and a relation drawing them as existing parents counted none.
        const readTooEarly = resource.dependsOn.some((dep) => runThisApply.has(dep));
        const ended = runEnd(
          ran.code,
          answer,
          readTooEarly ? undefined : dryAnswer?.result.totalRecordsCreated,
        );
        const endedAt = await deps.orgNow();
        current = await deps.store.update(current, (s) =>
          stepEnded(s, {
            resource: step.resource,
            status: ended.status,
            run: {
              endedAt,
              exitCode: ran.code,
              objects: (answer?.result.objectResults ?? []).map((object) => ({
                objectApiName: object.objectApiName,
                created: object.recordsCreated,
                refused: object.recordsFailed,
              })),
              ...(summary !== undefined ? { summary } : {}),
            },
          }),
        );
        const objects = runObjects(answer);
        results.push({
          resource: step.resource,
          action: step.action,
          phase: 'run',
          run: n,
          script: SEED_SCRIPT,
          exitCode: ran.code,
          status: ended.status,
          ...(summary !== undefined ? { summary } : {}),
          objects:
            ended.short !== undefined && objects[0] !== undefined
              ? [{ ...objects[0], reason: ended.short }, ...objects.slice(1)]
              : objects,
          ...(answer !== undefined ? { answer } : {}),
        });
        if (ended.short !== undefined) deps.say(`${step.resource}: ${ended.short}`);
        if (isStopCode(ran.code)) {
          stoppedCode = ran.code;
          deps.say(
            `${step.resource}: its run was stopped; the state keeps it applying, and its run ` +
              'file what it wrote: apply again takes it back and runs it whole',
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

/** The lines an apply or a destroy ends with. */
export function runResultLines(result: EnvRunResult, verb: 'apply' | 'destroy'): string[] {
  const lines: string[] = [''];
  for (const step of result.steps) {
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
    for (const object of step.objects) {
      if (object.reason !== undefined) lines.push(`      ${object.object}: ${object.reason}`);
    }
  }
  for (const skip of result.skipped ?? []) lines.push(`  ${skip.resource}: not run, ${skip.why}`);
  if (result.refusal !== undefined) lines.push(`${verb} refused: ${result.refusal}`);
  lines.push(`${verb}: ${result.status}; state serial ${result.state.serial}`);
  return lines;
}
