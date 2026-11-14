/**
 * The plans of the MCP server's clone of a whole org: what binds the run
 * `clone_org` writes to the dry run `clone_org_plan` showed.
 *
 * A dry run that would go leaves a receipt, `mcp-plans/<id>.json` under the
 * journal folder: the line of its run, the orgs, the records its gate
 * counted, the question its run would ask, what its reader accepted. Of a
 * sample of the org (`--fit share`), a copy of the plan of ids it drew too,
 * in `mcp-plans/<id>/sample/`, held to the SHA-256 the dry run gave: the
 * next dry run of the same setup puts its own plan in the place of the one
 * it drew, and the run of the receipt writes the copy, the plan shown, or is
 * refused. Of the whole org, the count of its gate, which `--max-total`
 * holds the run to, as an environment holds its runs.
 *
 * A receipt is good for a day from the earlier of when it was made and when
 * its plan was drawn, as a dry run's plan is (`SAMPLE_PLAN_MAX_AGE_MS`); its
 * first run that writes makes it written, which no second run takes, and
 * which lives as long as the journal of its last run. Its runs are kept in
 * it as they start, each with the summary its script writes: a receipt is
 * never taken for unwritten while one of its runs may have written.
 *
 * The folder is its owner's alone, and each file of it: the copies hold the
 * ids of a production's records.
 */

import { existsSync } from 'node:fs';
import { readFile, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import * as z from 'zod';
import { makePrivateDir } from '../src/modules/checkpoint/OrgCheckpointStore.js';
import {
  SAMPLE_PLAN_MAX_AGE_MS,
  copySamplePlanTo,
} from '../src/modules/forge/sample/samplePlanStore.js';
import { RUN_HANDLE, readRunSummary, stampedId, writePrivate } from './mcpRuns.js';

/** The folder of the plans under the journal folder. */
const PLANS_DIR = 'mcp-plans';

/** The id of a plan: `co-` and when it was made. */
export const PLAN_ID = /^co-\d{8}-\d{6}-[a-z0-9]{4}$/;

/** What a receipt says of a run of its plan. */
export interface ClonePlanRun {
  /** Its handle (`mr-…`). */
  run: string;
  startedAt: string;
  /** The file its script writes its summary to (`--summary`), which names its journal. */
  summary: string;
  /** Whether it took up the journal of the run before it. */
  resume: boolean;
  /**
   * How it ended, once the server saw it end: its exit code, whether it
   * wrote — its journal kept, which a run that wrote nothing does not keep
   * —, and its journal.
   */
  ended?: { code: number; wrote: boolean; journal?: string };
}

/** A plan of `clone_org_plan`, as its receipt keeps it: see the module's comment. */
export interface ClonePlanReceipt {
  version: 1;
  id: string;
  createdAt: string;
  /** When it can no longer be written, unless a run of it wrote: an ISO date. */
  expiresAt: string;
  source: string;
  target: string;
  /** The line of its run: the dry run's, but for `--dry-run` and `--json`. */
  args: string[];
  /** A sample of the org, or every record of it. */
  mode: 'sample' | 'whole';
  /** The records its gate counted. */
  totalRows: number;
  /** Of a sample, where its copy of the plan is, its SHA-256 and when it was drawn. */
  sample?: { dir: string; sha256: string; drawnAt: string };
  /** The question its run would ask on a terminal, in its own words. */
  question?: string;
  /** How long its dry run said its writes take, in seconds: what a run of it is followed against. */
  durationSeconds?: number;
  /** What its reader accepted for it: the parameters of the acceptances given. */
  accepted: string[];
  runs: ClonePlanRun[];
  /** Why it no longer holds, once a run of it was refused for a change since. */
  dead?: { code: string; at: string };
}

const runSchema = z.object({
  run: z.string().regex(RUN_HANDLE),
  startedAt: z.iso.datetime(),
  summary: z.string().min(1),
  resume: z.boolean(),
  ended: z
    .object({
      code: z.number().int(),
      wrote: z.boolean(),
      journal: z.string().min(1).optional(),
    })
    .optional(),
}) satisfies z.ZodType<ClonePlanRun>;

const receiptSchema = z.object({
  version: z.literal(1),
  id: z.string().regex(PLAN_ID),
  createdAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  source: z.string().min(1),
  target: z.string().min(1),
  args: z.array(z.string()),
  mode: z.enum(['sample', 'whole']),
  totalRows: z.number().int().positive(),
  sample: z
    .object({
      dir: z.string().min(1),
      sha256: z.string().regex(/^[0-9a-f]{64}$/),
      drawnAt: z.iso.datetime(),
    })
    .optional(),
  question: z.string().optional(),
  durationSeconds: z.number().nonnegative().optional(),
  accepted: z.array(z.string()),
  runs: z.array(runSchema),
  dead: z.object({ code: z.string().min(1), at: z.iso.datetime() }).optional(),
}) satisfies z.ZodType<ClonePlanReceipt>;

/** The folder of the plans under `journalDir`. */
export function plansDirOf(journalDir: string): string {
  return join(journalDir, PLANS_DIR);
}

/** Whether `id` is one of a plan, and nothing that would make a path of it. */
export function isPlanId(id: string): boolean {
  return PLAN_ID.test(id);
}

/** The receipt of the plan `id`. */
function receiptPathOf(journalDir: string, id: string): string {
  if (!isPlanId(id)) throw new Error(`Not the id of a plan: ${id}`);
  return join(plansDirOf(journalDir), `${id}.json`);
}

/** The folder of what the plan `id` keeps beside its receipt: the copy of a sample's plan. */
function planFolderOf(journalDir: string, id: string): string {
  if (!isPlanId(id)) throw new Error(`Not the id of a plan: ${id}`);
  return join(plansDirOf(journalDir), id);
}

// ─── What a dry run planned ──────────────────────────────────────────────────

/** What the dry run of a clone of the whole org planned, as a receipt keeps it. */
export interface DryRunPlan {
  mode: 'sample' | 'whole';
  totalRows: number;
  /** Of a sample, the plan of ids it drew: where, its SHA-256, when. */
  sample?: { path: string; sha256: string; drawnAt: string };
  question?: string;
  /** How long it said its writes take, in seconds. */
  durationSeconds?: number;
}

const dryRunSchema = z.object({
  tool: z.literal('sandforge-clone'),
  dryRun: z.literal(true),
  writePlan: z.object({ totalRows: z.number().int().positive() }),
  wholeOrg: z.object({
    question: z.string().min(1).optional(),
    durationSeconds: z.number().nonnegative().optional().catch(undefined),
    sample: z
      .object({
        plan: z.object({
          path: z.string().min(1),
          sha256: z.string().regex(/^[0-9a-f]{64}$/),
          drawnAt: z.iso.datetime(),
        }),
      })
      .optional(),
  }),
  wouldBeRefused: z.array(z.string()).max(0).optional(),
});

/**
 * What the `--json` answer of the dry run of a clone of the whole org
 * planned, read as its script writes it: nothing for an answer that is not
 * one of a dry run that would go — refused, of a record or tables, of no
 * record to write.
 */
export function dryRunPlanOf(answer: unknown): DryRunPlan | undefined {
  const parsed = dryRunSchema.safeParse(answer);
  if (!parsed.success) return undefined;
  const { writePlan, wholeOrg } = parsed.data;
  return {
    mode: wholeOrg.sample ? 'sample' : 'whole',
    totalRows: writePlan.totalRows,
    ...(wholeOrg.sample ? { sample: { ...wholeOrg.sample.plan } } : {}),
    ...(wholeOrg.question !== undefined ? { question: wholeOrg.question } : {}),
    ...(wholeOrg.durationSeconds !== undefined
      ? { durationSeconds: wholeOrg.durationSeconds }
      : {}),
  };
}

/** The line of a run from the line of its dry run: without `--dry-run` and `--json`. */
export function runArgsOf(dryRunArgs: readonly string[]): string[] {
  return dryRunArgs.filter((arg) => arg !== '--dry-run' && arg !== '--json');
}

// ─── Keeping and opening a plan ──────────────────────────────────────────────

/** A plan to keep: see {@link keepClonePlan}. */
export interface ClonePlanToKeep {
  source: string;
  target: string;
  /** The line the dry run ran. */
  dryRunArgs: readonly string[];
  planned: DryRunPlan;
  accepted: readonly string[];
}

/**
 * Keep the plan of a dry run that would go: its receipt, and of a sample a
 * copy of the plan it drew, held to its SHA-256.
 *
 * @throws {SamplePlanError} when the sample's plan is no longer the one the
 *   dry run gave — drawn again since, changed or gone —: no receipt is kept.
 */
export async function keepClonePlan(
  journalDir: string,
  plan: ClonePlanToKeep,
  now: Date = new Date(),
): Promise<ClonePlanReceipt> {
  const id = stampedId('co', now);
  await makePrivateDir(plansDirOf(journalDir));
  let sample: ClonePlanReceipt['sample'];
  const drawn = plan.planned.sample;
  if (drawn) {
    await makePrivateDir(planFolderOf(journalDir, id));
    try {
      const copy = await copySamplePlanTo(
        drawn.path,
        join(planFolderOf(journalDir, id), 'sample'),
        drawn.sha256,
      );
      sample = { dir: copy.dir, sha256: copy.sha256, drawnAt: copy.manifest.drawnAt };
    } catch (error: unknown) {
      await rm(planFolderOf(journalDir, id), { recursive: true, force: true });
      throw error;
    }
  }
  const from = Math.min(now.getTime(), sample ? Date.parse(sample.drawnAt) : now.getTime());
  const receipt: ClonePlanReceipt = {
    version: 1,
    id,
    createdAt: now.toISOString(),
    expiresAt: new Date(from + SAMPLE_PLAN_MAX_AGE_MS).toISOString(),
    source: plan.source,
    target: plan.target,
    args: runArgsOf(plan.dryRunArgs),
    mode: plan.planned.mode,
    totalRows: plan.planned.totalRows,
    ...(sample ? { sample } : {}),
    ...(plan.planned.question !== undefined ? { question: plan.planned.question } : {}),
    ...(plan.planned.durationSeconds !== undefined
      ? { durationSeconds: plan.planned.durationSeconds }
      : {}),
    accepted: [...plan.accepted],
    runs: [],
  };
  await saveReceipt(journalDir, receiptSchema.parse(receipt));
  return receipt;
}

/** Write `receipt` in place of the one it was. */
async function saveReceipt(journalDir: string, receipt: ClonePlanReceipt): Promise<void> {
  await writePrivate(
    receiptPathOf(journalDir, receipt.id),
    `${JSON.stringify(receipt, null, 2)}\n`,
  );
}

/** The receipt of the plan `id`, read back; nothing when there is none, or it does not read as one. */
export async function readClonePlan(
  journalDir: string,
  id: string,
): Promise<ClonePlanReceipt | undefined> {
  if (!isPlanId(id)) return undefined;
  try {
    const receipt = receiptSchema.parse(
      JSON.parse(await readFile(receiptPathOf(journalDir, id), 'utf8')),
    );
    return receipt.id === id ? receipt : undefined;
  } catch {
    return undefined;
  }
}

/** Why a plan can no longer be written, as {@link openClonePlan} says it. */
export type ClonePlanGone =
  /** No receipt of it on this machine, or one that does not read as one. */
  | 'unknown'
  /** Past its day, no run of it having written. */
  | 'expired'
  /** A run of it was refused for what changed since it was planned. */
  | 'dead'
  /** A run of it wrote, and the journal of its last run is no longer on this machine. */
  | 'journalGone';

/** A plan as a run of it finds it. */
export type OpenedClonePlan =
  /** No run of it wrote: its run writes it. */
  | { state: 'ready'; receipt: ClonePlanReceipt }
  /**
   * A run of it wrote, or started and never said it wrote nothing: no
   * second run writes it, a resume takes its last journal up. `journal` is
   * that journal, when a run named one; `run` the last run of it.
   */
  | { state: 'written'; receipt: ClonePlanReceipt; run: ClonePlanRun; journal?: string }
  | { state: 'gone'; why: ClonePlanGone; receipt?: ClonePlanReceipt };

/**
 * The journal a run of a plan names: as it ended, or as its summary says,
 * for a run whose end this server did not see.
 */
async function journalOfRun(run: ClonePlanRun): Promise<string | undefined> {
  return run.ended?.journal ?? (await readRunSummary(run.summary))?.journal;
}

/**
 * Whether a run of a plan may have written: it said it did; or, its end
 * never seen — a server that ended with it —, its summary counts records
 * written, its journal is still there, or it left no summary to say.
 */
async function mayHaveWritten(run: ClonePlanRun): Promise<boolean> {
  if (run.ended) return run.ended.wrote;
  const summary = await readRunSummary(run.summary);
  if (!summary) return true;
  return summary.written > 0 || (summary.journal !== undefined && existsSync(summary.journal));
}

/**
 * The plan `id` as a run of it finds it, at `now`: one to write, one written
 * whose last journal a resume takes up, or one gone, with why. The copy of a
 * sample's plan is not read here: the run given it refuses one changed or
 * gone itself (`SAMPLE_PLAN_MISMATCH`, `SAMPLE_PLAN_GONE`), nothing written.
 */
export async function openClonePlan(
  journalDir: string,
  id: string,
  now: Date = new Date(),
): Promise<OpenedClonePlan> {
  const receipt = await readClonePlan(journalDir, id);
  if (!receipt) return { state: 'gone', why: 'unknown' };
  const writers: ClonePlanRun[] = [];
  for (const run of receipt.runs) if (await mayHaveWritten(run)) writers.push(run);
  if (writers.length > 0) {
    // The journal a resume takes up: that of the last run that named one,
    // each run of a plan going on in the same.
    let journal: string | undefined;
    for (const run of [...receipt.runs].reverse()) {
      journal = await journalOfRun(run);
      if (journal !== undefined) break;
    }
    if (journal !== undefined && !existsSync(journal)) {
      return { state: 'gone', why: 'journalGone', receipt };
    }
    const last = receipt.runs[receipt.runs.length - 1] ?? writers[writers.length - 1];
    return { state: 'written', receipt, run: last, ...(journal !== undefined ? { journal } : {}) };
  }
  if (receipt.dead) return { state: 'gone', why: 'dead', receipt };
  if (now.getTime() >= Date.parse(receipt.expiresAt)) {
    return { state: 'gone', why: 'expired', receipt };
  }
  return { state: 'ready', receipt };
}

// ─── The line of a run of a plan ─────────────────────────────────────────────

/** The value of `flag` set on `line` in place of the one it had, or added at its end. */
function withValue(line: readonly string[], flag: string, value: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < line.length; i++) {
    if (line[i] === flag) {
      i++;
      continue;
    }
    out.push(line[i]);
  }
  return [...out, flag, value];
}

/**
 * The line of a run of `receipt`: the line of its dry run, held to what it
 * planned — of a sample, its copy of the plan (`--fit-plan`), whose
 * `--max-total` stays the dry run's, the run being fingerprinted by it; of
 * every record, `--max-total` the count its gate gave —, then `--yes`, the
 * question having been shown with the plan and agreed to with `confirm`,
 * its summary and `--json`. A resume takes up `journal` instead of the
 * plan: its journal names the plan it writes.
 */
export function clonePlanRunLine(
  receipt: ClonePlanReceipt,
  run: { summary: string; resume?: string },
): string[] {
  let line =
    receipt.mode === 'whole'
      ? withValue(receipt.args, '--max-total', String(receipt.totalRows))
      : [...receipt.args];
  if (run.resume !== undefined) line = [...line, '--resume', run.resume];
  else if (receipt.sample) line = [...line, '--fit-plan', receipt.sample.dir];
  return [...line, '--yes', '--summary', run.summary, '--json'];
}

// ─── What became of its runs ─────────────────────────────────────────────────

/** Change the receipt of the plan `id` by `change`, as it is on disk now. */
async function changeReceipt(
  journalDir: string,
  id: string,
  change: (receipt: ClonePlanReceipt) => ClonePlanReceipt,
): Promise<ClonePlanReceipt | undefined> {
  const receipt = await readClonePlan(journalDir, id);
  if (!receipt) return undefined;
  const changed = receiptSchema.parse(change(receipt));
  await saveReceipt(journalDir, changed);
  return changed;
}

/**
 * Keep in the receipt of the plan `id` a run of it, as it starts, before its
 * script writes anything: until it is said to have written nothing, the
 * plan is written.
 */
export function addClonePlanRun(
  journalDir: string,
  id: string,
  run: Omit<ClonePlanRun, 'ended'>,
): Promise<ClonePlanReceipt | undefined> {
  return changeReceipt(journalDir, id, (receipt) => ({
    ...receipt,
    runs: [...receipt.runs, { ...run }],
  }));
}

/**
 * Say in the receipt of the plan `id` how its run `handle` ended: its exit
 * code and its journal, which it wrote when the journal is still there — a
 * run that wrote nothing leaves none, unless it took one up.
 */
export function endClonePlanRun(
  journalDir: string,
  id: string,
  handle: string,
  ended: { code: number; journal?: string },
): Promise<ClonePlanReceipt | undefined> {
  const wrote = ended.journal !== undefined && existsSync(ended.journal);
  return changeReceipt(journalDir, id, (receipt) => ({
    ...receipt,
    runs: receipt.runs.map((run) =>
      run.run === handle
        ? {
            ...run,
            ended: {
              code: ended.code,
              wrote,
              ...(ended.journal !== undefined ? { journal: ended.journal } : {}),
            },
          }
        : run,
    ),
  }));
}

/**
 * Mark the plan `id` as no longer holding: a run of it was refused for a
 * change since it was planned (`code`), and only a new plan says what a run
 * would write now.
 */
export function markClonePlanDead(
  journalDir: string,
  id: string,
  code: string,
  now: Date = new Date(),
): Promise<ClonePlanReceipt | undefined> {
  return changeReceipt(journalDir, id, (receipt) => ({
    ...receipt,
    dead: { code, at: now.toISOString() },
  }));
}

// ─── Cleaning up ─────────────────────────────────────────────────────────────

/**
 * Remove, with their copies, the receipts no run will write any longer: one
 * past its day that no run of it wrote, dead or not — a dead one says why
 * until then —, one written whose last journal is gone; and what a write
 * left half done a day ago or more. A plan `keep` names — a run of it still
 * running — stays.
 *
 * @returns How many plans were removed.
 */
export async function sweepClonePlans(
  journalDir: string,
  now: Date = new Date(),
  keep: (id: string) => boolean = () => false,
): Promise<number> {
  const root = plansDirOf(journalDir);
  let names: string[];
  try {
    names = await readdir(root);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of names) {
    const id = name.replace(/\.json$/, '');
    if (isPlanId(id) && name === `${id}.json`) {
      if (keep(id)) continue;
      const opened = await openClonePlan(journalDir, id, now);
      if (opened.state !== 'gone') continue;
      if (opened.why === 'unknown' && !(await olderThanADay(join(root, name), now))) continue;
      if (opened.why === 'dead' && now.getTime() < Date.parse(opened.receipt?.expiresAt ?? '')) {
        continue;
      }
      await rm(join(root, name), { force: true });
      await rm(planFolderOf(journalDir, id), { recursive: true, force: true });
      removed++;
    } else if (!isPlanId(name) && (await olderThanADay(join(root, name), now))) {
      // A file a write left half done, beside its receipt.
      await rm(join(root, name), { recursive: true, force: true });
      removed++;
    } else if (isPlanId(name) && !existsSync(join(root, `${name}.json`))) {
      // A copy whose receipt never was written whole.
      if (!(await olderThanADay(join(root, name), now))) continue;
      await rm(join(root, name), { recursive: true, force: true });
      removed++;
    }
  }
  return removed;
}

/** Whether `path` was last written a day or more before `now`. */
async function olderThanADay(path: string, now: Date): Promise<boolean> {
  const at = await stat(path).catch(() => undefined);
  return at !== undefined && now.getTime() - at.mtimeMs >= SAMPLE_PLAN_MAX_AGE_MS;
}
