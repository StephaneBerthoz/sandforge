/**
 * Saved plans: `plan --out` keeps the plan it made in a file, and
 * `apply --plan` applies that plan and nothing else, or refuses it. The model
 * is Terraform's: a saved plan is applied as planned, or refused. In a
 * pipeline, the plan is made and reviewed in the pull request, and applied on
 * merge, nothing decided again in between.
 *
 * A saved plan holds the plan as `plan --json` answers it, and what it was
 * made against: the org its plan names, the state's serial and lineage, the
 * file's digest, the switches of its line — what it replaces, what it
 * accepts — and the seeds its seed resources' dry runs drew. `apply --plan`
 * runs with those switches and those seeds, reads the org again with the
 * same previews and dry runs, and applies the plan it makes only when it is
 * the one kept, action by action and count by count. Otherwise it is refused,
 * exit 1, nothing written:
 *
 * - made for another org;
 * - made from another file: the file, or a variable or an alias it reads,
 *   changed since;
 * - made against another state: an apply or a destroy ran since, or a cache
 *   put back another state;
 * - what the org holds reads otherwise: an action or a count is not the
 *   plan's;
 * - before any org is reached: a plan a day old, one another SandForge made,
 *   and one that was refused when it was made.
 *
 * The seeds are kept because a seed resource that pins none draws at random
 * at each dry run: a relation whose children are drawn between two counts
 * would count otherwise at the apply, and the records it wrote would not be
 * those its plan counted.
 *
 * Nothing secret is written: the schema is strict, and a plan holds ids,
 * counts and words — the actions and why, the users who changed records
 * since, the org's Organization Id and alias, the paths of this machine's
 * stores — never a record's value nor a credential. It names the org, its
 * state and its users all the same, and committed with a project it would
 * publish them, as the state would: so it is written outside the repository
 * that holds the file, the journal directory's rule, unless the line says
 * otherwise (`--out-in-repository`), for a folder of the repository that is
 * never committed. A plan is a short-lived file, handed from the job that
 * plans to the one that applies as an artifact, never a part of the project.
 */

import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { open, rename, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import {
  envSavedPlanSchema,
  type EnvAction,
  type EnvPlan,
  type EnvSavedPlan,
  type EnvSavedPlanLine,
  type EnvState,
} from '@sandforge/shared';
import { sameOrganization, type EnvRefusal, type EnvTarget } from './envGuards.js';
import { actionCountsOf, type EnvDryRun } from './envPlan.js';
import { ENV_FILE_MODE, repositoryHolding } from './envState.js';
import { SEED_SCRIPT } from './kinds/seed.js';

/** How long a saved plan may be applied after it was made: a day. */
export const SAVED_PLAN_KEEP_MS = 24 * 60 * 60_000;

/** What a saved plan is made of: the plan, what it was made against, and its line. */
export interface SavedPlanInput {
  plan: EnvPlan;
  /** The state the plan read; undefined when there was none. */
  state: EnvState | undefined;
  /** The file's digest, as the plan resolved it. */
  digest: string;
  line: EnvSavedPlanLine;
  /** The dry runs the plan read: each seed's draws are kept from them. */
  dryRuns: Readonly<Record<string, EnvDryRun>>;
  sandforgeVersion: string;
  /** On this machine's clock. */
  madeAt: string;
}

/** The saved plan of a plan, checked by its schema before it is written. */
export function savedPlanOf(input: SavedPlanInput): EnvSavedPlan {
  const seeds: Record<string, number> = {};
  for (const [name, dry] of Object.entries(input.dryRuns)) {
    if ('answer' in dry && dry.answer.tool === SEED_SCRIPT) seeds[name] = dry.answer.seed;
  }
  return envSavedPlanSchema.parse({
    savedPlan: 1,
    sandforgeVersion: input.sandforgeVersion,
    madeAt: input.madeAt,
    file: { digest: input.digest },
    state:
      input.state === undefined
        ? { found: false }
        : { found: true, serial: input.state.serial, lineage: input.state.lineage },
    line: input.line,
    seeds,
    plan: input.plan,
  } satisfies EnvSavedPlan);
}

/**
 * Why a plan may not be kept where `--out` names, or undefined when it may:
 * a folder that is not there, or one inside the repository that holds the
 * file, unless the line says otherwise. Said before any org is reached.
 */
export function outRefusal(
  fileFolder: string,
  out: string,
  inRepository: boolean,
): EnvRefusal | undefined {
  const folder = dirname(resolve(out));
  if (!existsSync(folder) || !statSync(folder).isDirectory()) {
    return {
      code: 'BAD_LINE',
      message: `--out ${resolve(out)}: its folder ${folder} is not there. Nothing was read.`,
      exit: 2,
    };
  }
  if (inRepository) return undefined;
  const repoRoot = repositoryHolding(fileFolder, out);
  if (repoRoot === undefined) return undefined;
  return {
    code: 'PLAN_IN_REPOSITORY',
    message:
      `--out ${resolve(out)} is inside the repository ${repoRoot} that holds the file: a plan ` +
      'names the org by its Organization Id, its state, and the users who changed its records ' +
      'since, and committed with the project it would publish them. Keep it outside — in CI, in ' +
      '$RUNNER_TEMP, handed to the job that applies as an artifact — or give ' +
      '--out-in-repository for a folder of it that is never committed. Nothing was read.',
    exit: 2,
  };
}

/**
 * Write a saved plan whole, its owner's alone: into a file of its own beside
 * it, flushed to the disk, then renamed over it. A plan half written is never
 * read for a whole one.
 */
export async function writeSavedPlan(path: string, saved: EnvSavedPlan): Promise<void> {
  const temp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  const handle = await open(temp, 'wx', ENV_FILE_MODE);
  try {
    await handle.writeFile(`${JSON.stringify(saved, null, 2)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temp, path);
  } catch (err: unknown) {
    await rm(temp, { force: true });
    throw err;
  }
}

/** The plan kept in `path`, read by its schema, or why it is no plan to apply (exit 2). */
export function readSavedPlan(path: string): { saved: EnvSavedPlan } | { refusal: EnvRefusal } {
  const unread = (why: string): { refusal: EnvRefusal } => ({
    refusal: {
      code: 'PLAN_UNREAD',
      message: `--plan ${path} ${why}. Nothing was read or written.`,
      exit: 2,
    },
  });
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err: unknown) {
    return unread(`cannot be read: ${err instanceof Error ? err.message : String(err)}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return unread('is not JSON: it is no plan plan --out kept');
  }
  const parsed = envSavedPlanSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue?.path.map(String).join('.') || 'the plan';
    return unread(`is no plan plan --out kept (${where}: ${issue?.message ?? 'refused'})`);
  }
  return { saved: parsed.data };
}

/** A refusal of the plan kept in `path` that moved since it was made. */
function stale(path: string, why: string): EnvRefusal {
  return {
    code: 'PLAN_STALE',
    message: `The plan kept in ${path} ${why}. Nothing was written: plan again.`.slice(0, 8_000),
    exit: 1,
  };
}

/**
 * Why the plan kept in `path` is refused before any org is reached, or
 * undefined: refused when it was made, made with `--quick`, by another
 * SandForge, or a day ago.
 */
export function savedPlanRefusal(
  saved: EnvSavedPlan,
  path: string,
  context: { now: number; sandforgeVersion: string },
): EnvRefusal | undefined {
  if (saved.plan.refusal !== undefined) {
    return {
      code: 'PLAN_REFUSED',
      message: (
        `The plan kept in ${path} was refused when it was made: ${saved.plan.refusal} ` +
        'Nothing was written: plan again.'
      ).slice(0, 8_000),
      exit: 1,
    };
  }
  if (saved.plan.quick === true) {
    return stale(path, 'was made with --quick, which counts nothing an apply is held to');
  }
  if (saved.sandforgeVersion !== context.sandforgeVersion) {
    return stale(
      path,
      `was made by SandForge ${saved.sandforgeVersion}, and this one is ` +
        `${context.sandforgeVersion}, which may read the file and the org otherwise`,
    );
  }
  if (context.now - Date.parse(saved.madeAt) > SAVED_PLAN_KEEP_MS) {
    return stale(path, `was made at ${saved.madeAt}, more than a day ago`);
  }
  return undefined;
}

/** The state a plan was made against, in words. */
function stateWords(state: EnvSavedPlan['state']): string {
  return state.found ? `the state at serial ${state.serial}` : 'no state';
}

/**
 * Why the plan kept in `path` is not for what the command reached, or
 * undefined: made for another org, from another file, or against another
 * state than the one this machine keeps now.
 */
export function savedPlanMoved(
  saved: EnvSavedPlan,
  path: string,
  now: { target: EnvTarget; digest: string; state: EnvState | undefined },
): EnvRefusal | undefined {
  const org = saved.plan.org;
  if (!sameOrganization(org.organizationId, now.target.organizationId)) {
    return {
      code: 'PLAN_OTHER_ORG',
      message:
        `The plan kept in ${path} was made for ${org.alias ?? org.organizationId} ` +
        `(${org.organizationId}), and ${now.target.alias} is ${now.target.organizationId}: a ` +
        'plan is applied to the org it was made for. Nothing was written.',
      exit: 1,
    };
  }
  if (saved.file.digest !== now.digest) {
    return stale(
      path,
      'was made from another file: the file, or a variable or an alias it reads, changed since',
    );
  }
  const is = now.state;
  const was = saved.state;
  const same =
    was.found === (is !== undefined) &&
    (!was.found || (is !== undefined && is.serial === was.serial && is.lineage === was.lineage));
  if (!same) {
    const isWords =
      is === undefined
        ? 'none'
        : was.found && is.lineage !== was.lineage
          ? `at serial ${is.serial}, made again since`
          : `at serial ${is.serial}`;
    return stale(
      path,
      `was made against ${stateWords(was)}, and the state is now ${isWords}: an apply or a ` +
        'destroy ran since, or a cache put back another state',
    );
  }
  return undefined;
}

/** What a plan's action compares by: its kind of action, and each count of each object. */
function compared(action: EnvAction): string {
  return JSON.stringify([
    action.kind,
    action.action,
    action.objects.map((o) => [o.object, o.wouldCreate, o.atMost, o.present, o.gone, o.changed]),
    (action.draws ?? []).map((d) => [d.lookup, d.from, d.object, d.parents]),
  ]);
}

/** An action as a difference names it: `drifted (Contact 5 in the org, 1 gone)`. */
function actionWords(action: EnvAction | undefined): string {
  if (action === undefined) return 'nothing of it';
  const counts = actionCountsOf(action);
  const parents = (action.draws ?? [])
    .map((d) =>
      d.parents !== undefined
        ? `${d.lookup} under ${d.parents} ${d.object} record(s) of ${d.from}`
        : `${d.lookup} under the ${d.object} records ${d.from} creates first`,
    )
    .join(', ');
  const said = [counts, parents].filter(Boolean).join('; ');
  return `${action.action}${said ? ` (${said})` : ''}`;
}

/** The checkpoints a plan takes, in words: `once applied 'baseline'`. */
function checkpointsWords(plan: EnvPlan): string {
  const words = (plan.checkpoints ?? []).map(
    (c) =>
      `${c.step === 'before' ? 'before the first write' : 'once applied'} '${c.name}'` +
      (c.refusal !== undefined ? ', refused' : ''),
  );
  return words.length > 0 ? words.join(', ') : 'none';
}

/** The whole org against the checkpoint after the last apply, in words. */
function driftWords(plan: EnvPlan): string {
  const drift = plan.drift;
  if (drift === undefined) return 'not compared';
  if (drift.unread !== undefined) return 'not read';
  if (!drift.differs) return 'nothing differs';
  return (
    `differs, ${drift.toDelete ?? 0} to delete · ${drift.toGiveBack ?? 0} to give back · ` +
    `${drift.toBringBack ?? 0} to bring back`
  );
}

/**
 * What differs between the plan kept and the plan the org reads to now,
 * action by action and count by count, each in words: what each resource
 * was planned to come to, and what it comes to now; the checkpoints taken;
 * the whole org against the checkpoint after the last apply. Empty when the
 * plan holds. Why each says it, and what the org has left today, are not
 * compared: they are words and a budget, not what is written.
 */
export function planDifferences(kept: EnvPlan, now: EnvPlan): string[] {
  const out: string[] = [];
  const names = [...new Set([...kept.actions, ...now.actions].map((a) => a.resource))];
  for (const name of names) {
    const was = kept.actions.find((a) => a.resource === name);
    const is = now.actions.find((a) => a.resource === name);
    if (was !== undefined && is !== undefined && compared(was) === compared(is)) continue;
    out.push(`${name}: planned ${actionWords(was)}, now ${actionWords(is)}`);
  }
  const order = (plan: EnvPlan) => plan.actions.map((a) => a.resource).join(', ');
  if (out.length === 0 && order(kept) !== order(now)) {
    out.push(`the order of the resources: planned ${order(kept)}, now ${order(now)}`);
  }
  if (checkpointsWords(kept) !== checkpointsWords(now)) {
    out.push(
      `the checkpoints it takes: planned ${checkpointsWords(kept)}, now ${checkpointsWords(now)}`,
    );
  }
  if (driftWords(kept) !== driftWords(now)) {
    out.push(
      'the whole org against the checkpoint after the last apply: planned ' +
        `${driftWords(kept)}, now ${driftWords(now)}`,
    );
  }
  return out;
}

/** The refusal of a plan kept whose org reads otherwise now. */
export function planDiffersRefusal(path: string, differences: readonly string[]): EnvRefusal {
  return stale(path, `is not what the org holds now, read again: ${differences.join('; ')}`);
}

/** What `plan --out` says once it kept the plan. */
export function savedPlanLine(path: string, saved: EnvSavedPlan): string {
  const until = new Date(Date.parse(saved.madeAt) + SAVED_PLAN_KEEP_MS).toISOString();
  return `plan kept in ${path}, for apply --plan until ${until}`;
}

/** What `apply --plan` says once the plan it was given holds. */
export function savedPlanHeldLine(path: string, saved: EnvSavedPlan): string {
  return (
    `the plan kept in ${path} at ${saved.madeAt} holds: the org, its state, the file and ` +
    'every count are as it planned them'
  );
}
