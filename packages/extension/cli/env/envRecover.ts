/**
 * `state recover`: an environment's state, lost or damaged, rebuilt from the
 * run files the journal directory keeps beside where it was.
 *
 * A state is lost while what it points at is still there: a `state.json`
 * deleted by hand, or as the refusal of a damaged one once advised; one
 * another version wrote, or one cut short; the environment's folder deleted
 * while `seed-runs/` stayed. A cache that was not restored takes the run
 * files with it, and nothing is left to rebuild from. Nothing is read from
 * the org but what it is: the scripts stamp nothing on a record a query
 * could tell apart, and a fresh org holds records already.
 *
 * What is read, all of it before anything is written:
 *
 * - each run's summary, `runs/<resource>/<n>.summary.json`, by the strict
 *   reader of the kind its script names, and what removals of it kept
 *   beside it, `<n>.summary.removals.json`;
 * - each seed run file, `<journal>/seed-runs/env-<env>-<resource>-<n>-<uuid>.ndjson`,
 *   the id the environment gives a seed run, and what removals of it kept,
 *   `<run id>.removal.json`; a run file of another org is another org's;
 * - each frozen resource's sas, `frozen/<resource>/`, and the payload each
 *   load was given, `templates/<resource>.<n>.json`, which its removal is run
 *   from; each mask resource's DataOps store, `dataops/<resource>/`;
 * - the checkpoints of the org, in the checkpoint store of the journal
 *   directory.
 *
 * All or nothing: a state made of part of the runs would have the next apply
 * create again what the rest names, and a destroy leave it in the org. A
 * summary that does not read, one of another org, two runs of one rank, two
 * kinds of one resource, a seed run of a resource that may be another
 * environment's, a load whose payload is gone while the org holds what it
 * created, are each refused, named, nothing written. So is a state
 * that reads — recover never writes over one —, one a later SandForge wrote,
 * one of another org, and a journal that keeps no run at all.
 *
 * What the state rebuilt holds:
 *
 * - a lineage of its own, at serial 1: a plan kept before the loss is of
 *   another state, and refused;
 * - the org as typed live, the file's digest as it stands;
 * - per resource, its runs, each with the files it is taken back from, in
 *   the order they ran; `takenBack` on a run only where a removal's own record
 *   proves it took the run back whole — the sidecar a seed's or a clone's
 *   removal keeps, a sas whose every load was removed, a reload whose purge
 *   took the loads before it, a mask resource's store a destroy deleted. A run
 *   with no proof stays the org's: taken back again, it costs a removal that
 *   finds its records gone, where a run wrongly marked would leave its
 *   records to nobody;
 * - its status from its last run, `destroyed` once every run is taken back;
 * - `recovered`, its fingerprint {@link RECOVERED_FINGERPRINT}: no run file
 *   says what the resource was applied from, so the next plan replaces it;
 * - the checkpoints, only where the store proves them: one checkpoint of the
 *   org named `<env> before`, taken before the first run, and one named as the
 *   file's `checkpoint.after`, taken after the last. A wrong `before` would
 *   have `destroy --rewind` return the org to a wrong moment.
 *
 * A state that did not read is set aside first, `state.json.damaged-<when>`,
 * kept, never deleted.
 */

import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  RECOVERED_FINGERPRINT,
  envNameSchema,
  envStateSchema,
  type EnvRecoverResult,
  type EnvResourceKind,
  type EnvResourceState,
  type EnvResourceStatus,
  type EnvRun,
  type EnvRunObject,
  type EnvState,
} from '@sandforge/shared';
import type { LinkedLockOptions } from '../../src/modules/checkpoint/linkedLock.js';
import { OrgCheckpointStore } from '../../src/modules/checkpoint/OrgCheckpointStore.js';
import { nodeRunJournal } from '../../src/modules/forge/ForgeRunJournal.js';
import {
  SasReferenceIdMappingStore,
  mappedOrgIds,
} from '../../src/modules/frozendataset/SasReferenceIdMappingStore.js';
import { loadRecordsLeft } from '../../src/modules/frozendataset/loadRecords.js';
import { SasPathGuard } from '../../src/modules/frozendataset/SasPathGuard.js';
import { SEED_RUNS_DIR, seedRunKept } from '../../src/modules/seed/SeedRunCreations.js';
import {
  nodeSyncRunCreations,
  readRemovalState,
  syncRemovalPlan,
  type SyncRunKept,
} from '../../src/modules/sync/SyncRunCreations.js';
import { readEarlierRemovals, removalPlan, runKey, runSummaryOfFile } from '../sandforge-clone.js';
import { checkpointNameOf, envCheckpointStoreOf } from './envCheckpoints.js';
import type { EnvFileResolved } from './envFile.js';
import {
  lockRefusal,
  sameOrganization,
  stateRefusal,
  type EnvRefusal,
  type EnvRefusalCode,
  type EnvTarget,
} from './envGuards.js';
import { acquireEnvLock } from './envLock.js';
import {
  EnvStateError,
  newEnvState,
  runRemovalsPathOf,
  runSummaryPathOf,
  runTemplatePathOf,
  type EnvStore,
} from './envState.js';
import { StepAnswerError } from './kinds/common.js';
import { forgeRunCount, readForgeRun, type ForgeRunAnswer } from './kinds/forge.js';
import {
  frozenRunCount,
  frozenSasOf,
  readFrozenRun,
  reloadPurgedWhole,
  type FrozenRunAnswer,
} from './kinds/frozen.js';
import { maskRunCount, readMaskRun, type MaskRunAnswer } from './kinds/mask.js';
import { readSeedRun, seedRunCount, type SeedRunAnswer } from './kinds/seed.js';

/** What a recover runs with. */
export interface EnvRecoverDeps {
  store: EnvStore;
  /** The folder `SANDFORGE_JOURNAL_DIR` names: the seed's run files, the clone's journals, the checkpoints. */
  journalDir: string;
  /** Where the environment locks and the checkpoint locks are. */
  locksDir: string;
  /** This SandForge's version, which the state records, and a damaged state's is held to. */
  sandforgeVersion: string;
  /** The checks a lock makes of its holder; a test gives its own. */
  lockOptions?: LinkedLockOptions;
}

/** What a recover is given: the file as it stands, and the org as typed live. */
export interface EnvRecoverInput {
  resolved: EnvFileResolved;
  target: EnvTarget;
}

/** A recover's end: the state written and what it says of it, or why nothing was written. */
export type EnvRecoverOutcome =
  { result: EnvRecoverResult; state: EnvState } | { refusal: EnvRefusal };

/** The script of each kind, as a summary names it. */
const KIND_OF_TOOL: Readonly<Record<string, EnvResourceKind>> = {
  'sandforge-seed': 'seed',
  'sandforge-clone': 'forge',
  'sandforge-frozen': 'frozen',
  'sandforge-dataops': 'mask',
};

/** A run's summary, in its resource's folder. */
const SUMMARY_NAME = /^([1-9][0-9]{0,5})\.summary\.json$/;

/** A run's payload, in the templates folder. */
const TEMPLATE_NAME = /^([a-z][a-z0-9-]{0,62})\.([1-9][0-9]{0,5})\.json$/;

/** What `env-<env>-` leaves of a seed run's id: `<resource>-<n>-<uuid>`. */
const RUN_ID_REST =
  /^([a-z][a-z0-9-]{0,62})-([1-9][0-9]{0,5})-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A stopped load's journal, in a sas: records no mapping names yet. */
const LOAD_JOURNAL = /\.load-\d{1,16}\.ndjson$/;

class Refused extends Error {
  constructor(
    readonly code: EnvRefusalCode,
    message: string,
  ) {
    super(message);
    this.name = 'Refused';
  }
}

const NOTHING = 'Nothing was written.';

// ─── What the folder and the journal keep ────────────────────────────────────

/** What one rank of one resource left, found by name. */
interface RankFound {
  /** `runs/<resource>/<n>.summary.json`, from the state's folder. */
  summary?: string;
  /** `templates/<resource>.<n>.json`, from the state's folder. */
  template?: string;
  /** The seed run files of this org under the rank, by run id. */
  seedRuns: Array<{ runId: string; run: SyncRunKept }>;
}

/** What the journal directory keeps of an environment on an org, before any of it is read. */
interface Found {
  ranks: Map<string, Map<number, RankFound>>;
  frozen: Set<string>;
  dataops: Set<string>;
  /** The seed runs whose resource neither the file nor the folder has. */
  unclaimed: Array<{ file: string; resource: string; run: SyncRunKept }>;
}

/** The names of a folder's entries of a kind, in name order; none when it is not there. */
async function entriesOf(dir: string, folders: boolean): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((entry) => (folders ? entry.isDirectory() : entry.isFile()))
      .map((entry) => entry.name)
      .sort();
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return [];
    throw err;
  }
}

function rankOf(found: Found, resource: string, n: number): RankFound {
  let ranks = found.ranks.get(resource);
  if (ranks === undefined) {
    ranks = new Map();
    found.ranks.set(resource, ranks);
  }
  let rank = ranks.get(n);
  if (rank === undefined) {
    rank = { seedRuns: [] };
    ranks.set(n, rank);
  }
  return rank;
}

/**
 * Every file of the environment the journal directory keeps for the org, by
 * resource and rank: the folder's summaries, templates, sas and stores, and
 * the seed run files of this org whose id is the environment's.
 *
 * A seed run's id names the environment, the resource and the rank, but an
 * environment `case` and another named `case-flow` share the prefix
 * `env-case-`: `env-case-flow-accounts-1-…` reads as run 1 of `flow-accounts`
 * of `case`. A run file is this environment's when its resource is one the
 * file has or the folder keeps a trace of. One whose resource is neither, and
 * that another environment of the org this machine keeps claims by its longer
 * name, is that one's; one both could own is refused; one neither claims is
 * set apart, for the recover to refuse unless its records are all taken back.
 */
async function findRuns(
  deps: Pick<EnvRecoverDeps, 'store' | 'journalDir'>,
  input: EnvRecoverInput,
): Promise<Found> {
  const env = input.resolved.checked.file.name;
  const organizationId = input.target.organizationId;
  const folder = deps.store.folderOf(organizationId, env);
  const found: Found = { ranks: new Map(), frozen: new Set(), dataops: new Set(), unclaimed: [] };
  const named = (name: string): boolean => envNameSchema.safeParse(name).success;

  for (const resource of (await entriesOf(join(folder, 'runs'), true)).filter(named)) {
    for (const name of await entriesOf(join(folder, 'runs', resource), false)) {
      const n = SUMMARY_NAME.exec(name)?.[1];
      if (n !== undefined)
        rankOf(found, resource, Number(n)).summary = runSummaryPathOf(resource, Number(n));
    }
  }
  for (const name of await entriesOf(join(folder, 'templates'), false)) {
    const match = TEMPLATE_NAME.exec(name);
    if (match?.[1] === undefined || match[2] === undefined || !named(match[1])) continue;
    rankOf(found, match[1], Number(match[2])).template = runTemplatePathOf(
      match[1],
      Number(match[2]),
    );
  }
  for (const resource of (await entriesOf(join(folder, 'frozen'), true)).filter(named)) {
    found.frozen.add(resource);
  }
  for (const resource of (await entriesOf(join(folder, 'dataops'), true)).filter(named)) {
    found.dataops.add(resource);
  }

  const inFile = new Set(input.resolved.resources.map((resource) => resource.name));
  const traced = new Set([...found.ranks.keys(), ...found.frozen, ...found.dataops]);
  // The environments of the org this machine keeps a folder of, whose name
  // begins as this one's: a run id of theirs reads as one of this one's.
  const longer = (await entriesOf(join(folder, '..'), true)).filter(
    (other) => other !== env && other.startsWith(`${env}-`),
  );
  const prefix = `env-${env}-`;
  const runs = nodeSyncRunCreations(deps.journalDir, SEED_RUNS_DIR);
  for (const name of await entriesOf(join(deps.journalDir, SEED_RUNS_DIR), false)) {
    if (!name.endsWith('.ndjson') || !name.startsWith(prefix)) continue;
    const runId = name.slice(0, -'.ndjson'.length);
    const match = RUN_ID_REST.exec(runId.slice(prefix.length));
    if (match?.[1] === undefined || match[2] === undefined) continue;
    const resource = match[1];
    const ours = inFile.has(resource) || traced.has(resource);
    const claimant = longer.find((other) => runId.startsWith(`env-${other}-`));
    if (claimant !== undefined && !ours) continue;
    const file = join(deps.journalDir, SEED_RUNS_DIR, name);
    const run = await runs.get(runId);
    if (run === undefined) {
      throw new Refused(
        'RUN_UNREAD',
        `The seed run file ${file} does not read as a run: a state rebuilt without it would ` +
          `leave what it created to nobody. Move it aside if it is not a run of ${env}. ${NOTHING}`,
      );
    }
    if (run.targetOrganizationId === undefined) {
      throw new Refused(
        'RUN_UNREAD',
        `The seed run file ${file} names no Organization Id: nothing tells whether it wrote to ` +
          `${input.target.alias} or to another org. Move it aside if it is not a run of ${env} on ` +
          `${input.target.alias}. ${NOTHING}`,
      );
    }
    // The run files of every org share the folder: another org's is its own.
    if (!sameOrganization(run.targetOrganizationId, organizationId)) continue;
    if (claimant !== undefined) {
      throw new Refused(
        'RUN_UNCLAIMED',
        `The seed run file ${file} may be run ${match[2]} of ${resource} of ${env}, or a run of ` +
          `${claimant}, kept on this machine too: their names begin alike, and nothing tells ` +
          `them apart. Move it out of the folder while ${env} is recovered if it is ` +
          `${claimant}'s. ${NOTHING}`,
      );
    }
    if (!ours) {
      found.unclaimed.push({ file, resource, run });
      continue;
    }
    rankOf(found, resource, Number(match[2])).seedRuns.push({ runId, run });
  }
  return found;
}

/**
 * Whether the journal directory keeps a run of the environment on the org:
 * what the refusal of an apply with no state says `state recover` rebuilds
 * the state from. A run file that does not read counts: the recover names it.
 */
export async function envRunsKept(
  deps: Pick<EnvRecoverDeps, 'store' | 'journalDir'>,
  input: EnvRecoverInput,
): Promise<boolean> {
  try {
    const found = await findRuns(deps, input);
    return (
      found.unclaimed.length > 0 ||
      found.frozen.size > 0 ||
      found.dataops.size > 0 ||
      [...found.ranks.values()].some((ranks) =>
        [...ranks.values()].some((rank) => rank.summary !== undefined || rank.seedRuns.length > 0),
      )
    );
  } catch (err: unknown) {
    // A hint of the refusal it is said in: a folder that cannot be listed
    // keeps the refusal as it was, and never stops the plan.
    return err instanceof Refused;
  }
}

// ─── Each run, read ──────────────────────────────────────────────────────────

/** A summary read by its kind's reader. */
type SummaryRead =
  | { kind: 'seed'; answer: SeedRunAnswer }
  | { kind: 'forge'; answer: ForgeRunAnswer; finishedAt?: string; elapsedMs?: number }
  | { kind: 'frozen'; answer: FrozenRunAnswer }
  | { kind: 'mask'; answer: MaskRunAnswer };

/** A date as the state keeps one, or undefined for what is none. */
function instantOf(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const at = Date.parse(value);
  return Number.isFinite(at) ? new Date(at).toISOString() : undefined;
}

/** When a file was last written, as the state keeps a date; undefined when it is not there. */
async function writtenAt(file: string): Promise<string | undefined> {
  try {
    return (await stat(file)).mtime.toISOString();
  } catch {
    return undefined;
  }
}

/** A summary read strictly, or the refusal that names it. */
async function readSummary(file: string): Promise<SummaryRead> {
  const refused = (why: string): Refused =>
    new Refused(
      'RUN_UNREAD',
      `The summary ${file} does not read (${why}): a state rebuilt without it would leave what ` +
        `its run created to nobody. ${NOTHING}`,
    );
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (err: unknown) {
    throw refused(err instanceof Error ? err.message : String(err));
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw refused('not JSON');
  }
  const tool = (raw as { tool?: unknown } | null)?.tool;
  const kind = typeof tool === 'string' ? KIND_OF_TOOL[tool] : undefined;
  try {
    if (kind === 'seed') return { kind, answer: readSeedRun(text) };
    if (kind === 'frozen') return { kind, answer: readFrozenRun(text) };
    if (kind === 'mask') return { kind, answer: readMaskRun(text) };
    if (kind === 'forge') {
      const dates = raw as { finishedAt?: unknown; elapsedMs?: unknown };
      const finishedAt = instantOf(dates.finishedAt);
      const elapsedMs =
        typeof dates.elapsedMs === 'number' &&
        Number.isFinite(dates.elapsedMs) &&
        dates.elapsedMs >= 0
          ? dates.elapsedMs
          : undefined;
      return {
        kind,
        answer: readForgeRun(text),
        ...(finishedAt !== undefined ? { finishedAt } : {}),
        ...(elapsedMs !== undefined ? { elapsedMs } : {}),
      };
    }
  } catch (err: unknown) {
    if (err instanceof StepAnswerError) throw refused(err.message);
    throw err;
  }
  throw refused('it names no script of an environment');
}

/** A run rebuilt, with the proof of its taking back. */
interface RunRebuilt {
  run: EnvRun;
  status: EnvResourceStatus;
}

/** Whether what a seed run's removals kept leaves nothing of it to take: the removal's own plan, empty. */
function seedRemovalTookAll(run: SyncRunKept): boolean {
  return run.removal !== undefined && syncRemovalPlan(run).length === 0;
}

/** The status a seed run's summary says it ended with. */
function seedStatusOf(answer: SeedRunAnswer): EnvResourceStatus {
  if (answer.interrupted === true || answer.result.cancelled === true) return 'applying';
  if (answer.result.status === 'success') return 'applied';
  return answer.result.status === 'partial' ? 'partial' : 'failed';
}

/** A run's objects as the state keeps them. */
function objectsOf(
  objects: ReadonlyArray<{ object: string; created: number; refused: number }>,
): EnvRunObject[] {
  return objects.map((object) => ({
    objectApiName: object.object,
    created: object.created,
    refused: object.refused,
  }));
}

/** Throw the refusal of a summary that names another org than the one typed live. */
function holdToOrg(file: string, targetOrgId: string | undefined, input: EnvRecoverInput): void {
  if (targetOrgId === undefined || sameOrganization(targetOrgId, input.target.organizationId)) {
    return;
  }
  throw new Refused(
    'RUN_OTHER_ORG',
    `The summary ${file} is of a run that wrote to ${targetOrgId}, not to ${input.target.alias} ` +
      `(${input.target.organizationId}): it was copied from another org's folder. Put it back ` +
      `where it came from. ${NOTHING}`,
  );
}

/**
 * A seed run of one rank: from its summary, its run file, or both, which
 * must be the one run. Taken back on what either removal kept: the summary's
 * sidecar or the run file's own.
 */
async function seedRun(
  deps: Pick<EnvRecoverDeps, 'store'>,
  input: EnvRecoverInput,
  resource: string,
  n: number,
  rank: RankFound,
  read: SummaryRead | undefined,
): Promise<RunRebuilt> {
  const env = input.resolved.checked.file.name;
  const where = (path: string) => deps.store.fileOf(input.target.organizationId, env, path);
  if (rank.seedRuns.length > 1) {
    throw new Refused(
      'RUNS_CONFLICT',
      `Two seed runs are kept for run ${n} of ${resource}: ${rank.seedRuns.map((r) => r.runId).join(', ')}. ` +
        `One rank is one run: the state they come from cannot be told. ${NOTHING}`,
    );
  }
  const file = rank.seedRuns[0];
  const answer = read?.kind === 'seed' ? read.answer : undefined;
  const runId = answer?.result.operationId ?? file?.runId;
  if (answer !== undefined && file !== undefined && answer.result.operationId !== file.runId) {
    throw new Refused(
      'RUNS_CONFLICT',
      `The summary of run ${n} of ${resource} is of the run ${answer.result.operationId}, and ` +
        `the seed run file of that rank of ${file.runId}: one rank is one run. ${NOTHING}`,
    );
  }
  if (
    answer !== undefined &&
    !answer.result.operationId.startsWith(`env-${env}-${resource}-${n}-`)
  ) {
    throw new Refused(
      'RUNS_CONFLICT',
      `The summary ${where(runSummaryPathOf(resource, n))} is of the run ` +
        `${answer.result.operationId}, which is not run ${n} of ${resource}. ${NOTHING}`,
    );
  }
  let tookAll = file !== undefined && seedRemovalTookAll(file.run);
  if (answer !== undefined && !tookAll) {
    const sidecar = await readFile(where(runRemovalsPathOf(resource, n)), 'utf8').catch(
      () => undefined,
    );
    let raw: unknown;
    try {
      raw = sidecar !== undefined ? JSON.parse(sidecar) : undefined;
    } catch {
      raw = undefined;
    }
    // The sidecar of this run alone: the seed's removal reads it by the run's id too.
    const removal =
      (raw as { runId?: unknown } | undefined)?.runId === answer.result.operationId
        ? readRemovalState(raw)
        : undefined;
    tookAll =
      removal !== undefined &&
      answer.result.objectResults.every((object) => object.truncated !== true) &&
      syncRemovalPlan(
        seedRunKept(
          {
            runId: answer.result.operationId,
            targetOrgId: answer.target,
            status: answer.result.status,
            objectResults: answer.result.objectResults,
          },
          removal,
        ),
      ).length === 0;
  }
  const startedAt =
    instantOf(answer?.startedAt) ?? instantOf(file?.run.startedAt) ?? new Date(0).toISOString();
  const endedAt =
    answer !== undefined ? instantOf(answer.finishedAt) : instantOf(file?.run.end?.at);
  const objects =
    answer !== undefined
      ? objectsOf(seedRunCount(answer).objects)
      : (file?.run.created ?? []).map((object) => ({
          objectApiName: object.objectApiName,
          created: object.ids.length,
          refused: 0,
        }));
  return {
    run: {
      n,
      script: 'sandforge-seed',
      ...(runId !== undefined ? { runId } : {}),
      ...(rank.summary !== undefined && answer !== undefined ? { summary: rank.summary } : {}),
      ...(answer !== undefined ? { seed: answer.seed } : {}),
      startedAt,
      ...(endedAt !== undefined ? { endedAt } : {}),
      objects,
      ...(tookAll ? { takenBack: true as const } : {}),
    },
    // A run file with no summary: a run stopped before it printed one.
    status: answer !== undefined ? seedStatusOf(answer) : 'applying',
  };
}

/**
 * A forge run, from its summary: taken back on what the clone's removal kept
 * beside it, read as the removal reads it, by the run's records.
 */
async function forgeRun(
  deps: Pick<EnvRecoverDeps, 'store' | 'journalDir'>,
  input: EnvRecoverInput,
  resource: string,
  n: number,
  read: Extract<SummaryRead, { kind: 'forge' }>,
): Promise<RunRebuilt> {
  const env = input.resolved.checked.file.name;
  const path = runSummaryPathOf(resource, n);
  const file = deps.store.fileOf(input.target.organizationId, env, path);
  const { answer } = read;
  let tookAll = false;
  const sidecar = await readFile(
    deps.store.fileOf(input.target.organizationId, env, runRemovalsPathOf(resource, n)),
    'utf8',
  ).catch(() => undefined);
  if (sidecar !== undefined) {
    const summary = await runSummaryOfFile(
      file,
      await readFile(file, 'utf8'),
      input.target.alias,
      nodeRunJournal(deps.journalDir),
    );
    if (!('refusal' in summary)) {
      const earlier = readEarlierRemovals(sidecar, runKey(removalPlan(summary.summary)));
      tookAll = 'earlier' in earlier && earlier.earlier?.removalLeft?.length === 0;
    }
  }
  const endedAt =
    answer.running === true || answer.interrupted === true ? undefined : read.finishedAt;
  const last = read.finishedAt ?? (await writtenAt(file)) ?? new Date(0).toISOString();
  const startedAt = new Date(Date.parse(last) - (read.elapsedMs ?? 0)).toISOString();
  const status: EnvResourceStatus =
    answer.running === true || answer.interrupted === true
      ? 'applying'
      : answer.error !== undefined
        ? 'failed'
        : answer.result.failedCount > 0
          ? 'partial'
          : 'applied';
  return {
    run: {
      n,
      script: 'sandforge-clone',
      summary: path,
      startedAt,
      ...(endedAt !== undefined ? { endedAt } : {}),
      objects: objectsOf(forgeRunCount(answer).objects),
      ...(tookAll ? { takenBack: true as const } : {}),
    },
    status,
  };
}

/** A run of a kind whose summary carries no date: from when its payload and its summary were written. */
async function datesOf(
  deps: Pick<EnvRecoverDeps, 'store'>,
  input: EnvRecoverInput,
  rank: RankFound,
): Promise<{ startedAt: string; endedAt?: string }> {
  const env = input.resolved.checked.file.name;
  const of = (path: string | undefined) =>
    path !== undefined
      ? writtenAt(deps.store.fileOf(input.target.organizationId, env, path))
      : Promise.resolve(undefined);
  const template = await of(rank.template);
  const summary = await of(rank.summary);
  return {
    startedAt: template ?? summary ?? new Date(0).toISOString(),
    ...(summary !== undefined ? { endedAt: summary } : {}),
  };
}

/**
 * Whether every load a frozen resource's sas records was taken back whole:
 * each says which records it created, none is left of them, and a removal
 * reached one at least. A load stopped part way keeps a journal, records no
 * mapping names yet: not taken.
 */
async function sasTakenBackWhole(sasDir: string, organizationId: string): Promise<boolean> {
  if ((await entriesOf(sasDir, false)).some((name) => LOAD_JOURNAL.test(name))) return false;
  const guard = new SasPathGuard();
  const orgId = (await mappedOrgIds(sasDir, guard)).find((id) =>
    sameOrganization(id, organizationId),
  );
  if (orgId === undefined) return false;
  const loads = await new SasReferenceIdMappingStore(sasDir, { orgId, guard }).recordedLoads();
  return (
    loads.length > 0 &&
    loads.some((load) => load.removal !== undefined) &&
    loads.every((load) => load.created !== undefined && loadRecordsLeft(load).length === 0)
  );
}

/** Throw the refusal of a sas that keeps the loads of another org. */
async function holdSasToOrg(sasDir: string, input: EnvRecoverInput): Promise<void> {
  const others = (await mappedOrgIds(sasDir, new SasPathGuard())).filter(
    (id) => !sameOrganization(id, input.target.organizationId),
  );
  if (others.length === 0) return;
  throw new Refused(
    'RUN_OTHER_ORG',
    `The sas ${sasDir} keeps loads into ${others.join(', ')}, not into ` +
      `${input.target.alias} (${input.target.organizationId}): it was copied from another org's ` +
      `folder. Put it back where it came from. ${NOTHING}`,
  );
}

/** The status a frozen load's answer says it ended with. */
function frozenStatusOf(answer: FrozenRunAnswer): EnvResourceStatus {
  const count = frozenRunCount(answer);
  if (count.refusal !== undefined) return 'failed';
  if (count.objects.some((object) => object.refused > 0)) return 'partial';
  return answer.verdict === undefined || answer.verdict.status === 'PASSED' ? 'applied' : 'partial';
}

/** The status a masking's answer says it ended with. */
function maskStatusOf(answer: MaskRunAnswer): EnvResourceStatus {
  const count = maskRunCount(answer);
  if (count.refusal !== undefined) return 'failed';
  return count.short !== undefined || count.objects.some((object) => object.notMasked > 0)
    ? 'partial'
    : 'applied';
}

// ─── The state rebuilt ───────────────────────────────────────────────────────

/** A resource rebuilt, with when its runs began and ended. */
interface ResourceRebuilt {
  name: string;
  state: EnvResourceState;
  firstStartedAt: string;
  lastEndedAt?: string;
}

/** The kind a resource's files say, or the refusal of two. */
function kindOf(
  resource: string,
  found: Found,
  reads: ReadonlyMap<number, SummaryRead>,
): EnvResourceKind | undefined {
  const kinds = new Set<EnvResourceKind>();
  for (const read of reads.values()) kinds.add(read.kind);
  if (found.frozen.has(resource)) kinds.add('frozen');
  if (found.dataops.has(resource)) kinds.add('mask');
  if ([...(found.ranks.get(resource)?.values() ?? [])].some((rank) => rank.seedRuns.length > 0)) {
    kinds.add('seed');
  }
  if (kinds.size > 1) {
    throw new Refused(
      'RUNS_CONFLICT',
      `The run files of ${resource} are of ${[...kinds].join(' and ')} runs: one resource is of ` +
        `one kind, and the state they come from cannot be told. ${NOTHING}`,
    );
  }
  return [...kinds][0];
}

/** One resource rebuilt from its files, or nothing when none of them is a run that wrote. */
async function rebuildResource(
  deps: Pick<EnvRecoverDeps, 'store' | 'journalDir'>,
  input: EnvRecoverInput,
  found: Found,
  resource: string,
): Promise<ResourceRebuilt | undefined> {
  const env = input.resolved.checked.file.name;
  const organizationId = input.target.organizationId;
  const ranks = found.ranks.get(resource) ?? new Map<number, RankFound>();
  const reads = new Map<number, SummaryRead>();
  for (const [n, rank] of ranks) {
    if (rank.summary === undefined) continue;
    reads.set(n, await readSummary(deps.store.fileOf(organizationId, env, rank.summary)));
  }
  const kind = kindOf(resource, found, reads);
  if (kind === undefined) return undefined;
  for (const [n, read] of reads) {
    const file = deps.store.fileOf(organizationId, env, runSummaryPathOf(resource, n));
    if (read.kind === 'seed') holdToOrg(file, read.answer.targetOrgId, input);
    if (read.kind === 'forge') holdToOrg(file, read.answer.targetOrgId, input);
  }

  const rebuilt: RunRebuilt[] = [];
  const order = [...ranks.keys()].sort((a, b) => a - b);
  if (kind === 'seed') {
    for (const n of order) {
      const rank = ranks.get(n);
      // A payload alone is a run that never wrote: nothing of it to take back.
      if (rank === undefined || (rank.summary === undefined && rank.seedRuns.length === 0))
        continue;
      rebuilt.push(await seedRun(deps, input, resource, n, rank, reads.get(n)));
    }
  } else if (kind === 'forge') {
    for (const n of order) {
      const read = reads.get(n);
      if (read?.kind === 'forge') rebuilt.push(await forgeRun(deps, input, resource, n, read));
    }
  } else if (kind === 'frozen') {
    const sasDir = deps.store.sasOf(organizationId, env, frozenSasOf(resource));
    await holdSasToOrg(sasDir, input);
    const whole = await sasTakenBackWhole(sasDir, organizationId);
    for (const n of order) {
      const rank = ranks.get(n);
      const read = reads.get(n);
      // Its removal is run from the payload the load was given: a summary alone takes nothing back.
      if (rank?.template === undefined) {
        if (read?.kind !== 'frozen' || whole) continue;
        throw new Refused(
          'RUN_UNREAD',
          `Run ${n} of ${resource} keeps its summary and not the payload its load was given, ` +
            `${deps.store.fileOf(organizationId, env, runTemplatePathOf(resource, n))}, which ` +
            'its removal is run from: a state rebuilt without it would leave what the load ' +
            `created to nobody. ${NOTHING}`,
        );
      }
      const answer = read?.kind === 'frozen' ? read.answer : undefined;
      rebuilt.push({
        run: {
          n,
          script: 'sandforge-frozen',
          sas: frozenSasOf(resource),
          ...(answer !== undefined && rank.summary !== undefined ? { summary: rank.summary } : {}),
          ...(await datesOf(deps, input, rank)),
          objects: answer !== undefined ? objectsOf(frozenRunCount(answer).objects) : [],
          ...(whole ? { takenBack: true as const } : {}),
        },
        status: answer !== undefined ? frozenStatusOf(answer) : 'applying',
      });
      // A reload whose purge took the loads before it whole: what its own report says.
      if (answer !== undefined && reloadPurgedWhole(answer)) {
        for (const earlier of rebuilt.slice(0, -1)) earlier.run.takenBack = true;
      }
    }
  } else {
    // A destroy deletes a mask resource's store whole, every run of it taken back.
    const forgotten = !found.dataops.has(resource);
    for (const n of order) {
      const rank = ranks.get(n);
      const read = reads.get(n);
      if (rank === undefined) continue;
      const answer = read?.kind === 'mask' ? read.answer : undefined;
      // A payload alone, its store gone: nothing says the masking ever ran.
      if (answer === undefined && forgotten) continue;
      const count = answer !== undefined ? maskRunCount(answer) : undefined;
      rebuilt.push({
        run: {
          n,
          script: 'sandforge-dataops',
          ...(answer !== undefined && rank.summary !== undefined ? { summary: rank.summary } : {}),
          ...(count?.snapshotId !== undefined ? { snapshotId: count.snapshotId } : {}),
          ...(await datesOf(deps, input, rank)),
          objects: (count?.objects ?? []).map((object) => ({
            objectApiName: object.object,
            created: 0,
            refused: object.refused,
            masked: object.masked,
          })),
          ...(forgotten ? { takenBack: true as const } : {}),
        },
        status: answer !== undefined ? maskStatusOf(answer) : 'applying',
      });
    }
  }
  if (rebuilt.length === 0) return undefined;

  const runs = rebuilt.map((r) => r.run);
  const last = rebuilt.at(-1);
  const status: EnvResourceStatus = runs.every((run) => run.takenBack === true)
    ? 'destroyed'
    : last?.run.takenBack === true
      ? 'partial'
      : (last?.status ?? 'applying');
  const inFile = input.resolved.resources.find((r) => r.name === resource);
  const ended = runs.flatMap((run) => (run.endedAt !== undefined ? [run.endedAt] : [])).sort();
  const started = runs.map((run) => run.startedAt).sort();
  return {
    name: resource,
    state: {
      kind,
      fingerprint: RECOVERED_FINGERPRINT,
      dependsOn: inFile !== undefined ? [...inFile.dependsOn] : [],
      status,
      runs,
      recovered: true,
    },
    firstStartedAt: started[0] ?? new Date(0).toISOString(),
    ...(ended.length > 0 ? { lastEndedAt: ended.at(-1) } : {}),
  };
}

/**
 * The checkpoints the store proves the environment's: one of the org named
 * `<env> before`, taken before the first run; one named as the file's
 * `checkpoint.after`, taken after the last run ended. Two of one name, or a
 * date that does not hold, prove nothing: the field stays empty, and is said.
 */
async function linkedCheckpoints(
  deps: Pick<EnvRecoverDeps, 'journalDir' | 'locksDir'>,
  input: EnvRecoverInput,
  span: { first: string; last?: string },
): Promise<{ before?: string; after?: string; notLinked: string[] }> {
  const file = input.resolved.checked.file;
  const store = new OrgCheckpointStore({
    root: envCheckpointStoreOf(deps.journalDir),
    locksDir: deps.locksDir,
  });
  const kept = (await store.list({ organizationId: input.target.organizationId })).flatMap(
    (entry) => (entry.valid && entry.checkpoint !== undefined ? [entry.checkpoint] : []),
  );
  const notLinked: string[] = [];
  const linked: { before?: string; after?: string } = {};

  const beforeName = `${file.name} before`;
  const before = kept.filter(
    (checkpoint) =>
      checkpoint.name === beforeName && Date.parse(checkpoint.takenAt) <= Date.parse(span.first),
  );
  if (before.length === 1 && before[0] !== undefined) {
    linked.before = before[0].checkpointId;
  } else if (checkpointNameOf(file, 'before') === undefined && before.length === 0) {
    notLinked.push('checkpoint.before: the file asks none');
  } else {
    notLinked.push(
      `checkpoint.before: ${before.length === 0 ? 'no' : `${before.length}`} checkpoint(s) of ` +
        `this org named '${beforeName}' taken before the first run: none is linked, and ` +
        'destroy --rewind has none to return to',
    );
  }

  const afterName = checkpointNameOf(file, 'after');
  if (afterName === undefined) {
    notLinked.push('checkpoint.after: the file asks none');
  } else {
    const last = span.last;
    const after = kept.filter(
      (checkpoint) =>
        checkpoint.name === afterName &&
        last !== undefined &&
        Date.parse(checkpoint.readFrom) >= Date.parse(last),
    );
    if (after.length === 1 && after[0] !== undefined) {
      linked.after = after[0].checkpointId;
    } else {
      notLinked.push(
        `checkpoint.after: ${after.length === 0 ? 'no' : `${after.length}`} checkpoint(s) of ` +
          `this org named '${afterName}' taken after the last run: none is linked, and reset ` +
          'has none to rewind to until an apply takes it',
      );
    }
  }
  return { ...linked, notLinked };
}

/** Whether `version` is past `mine`: a state a later SandForge wrote. */
function laterVersion(version: unknown, mine: string): boolean {
  const parts = (v: string): number[] | undefined => {
    const match = /^(\d+)\.(\d+)\.(\d+)/.exec(v);
    return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
  };
  const theirs = typeof version === 'string' ? parts(version) : undefined;
  const ours = parts(mine);
  if (theirs === undefined || ours === undefined) return false;
  for (let i = 0; i < 3; i++) {
    if ((theirs[i] ?? 0) !== (ours[i] ?? 0)) return (theirs[i] ?? 0) > (ours[i] ?? 0);
  }
  return false;
}

/**
 * The state of the environment as it is now: none, one that does not read,
 * or the refusal of one that reads, of another org, or of a later SandForge.
 */
async function stateNow(
  deps: Pick<EnvRecoverDeps, 'store' | 'sandforgeVersion'>,
  input: EnvRecoverInput,
): Promise<{ damaged: boolean }> {
  const env = input.resolved.checked.file.name;
  const { alias, organizationId } = input.target;
  try {
    const state = await deps.store.read(organizationId, env);
    if (state === undefined) return { damaged: false };
    throw new Refused(
      'STATE_KEPT',
      `This machine keeps a state of ${env} on ${alias} that reads, serial ${state.serial}: ` +
        `state recover never writes over one, and plan reads it. ${NOTHING}`,
    );
  } catch (err: unknown) {
    if (!(err instanceof EnvStateError)) throw err;
    if (err.code !== 'damaged') {
      const refusal = stateRefusal(err);
      throw new Refused(refusal.code, refusal.message);
    }
  }
  const file = deps.store.stateFileOf(organizationId, env);
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(file, 'utf8'));
  } catch {
    raw = undefined;
  }
  const said = raw as { version?: unknown; sandforgeVersion?: unknown } | undefined;
  const version = said?.version;
  if (
    (typeof version === 'number' && version > 1) ||
    laterVersion(said?.sandforgeVersion, deps.sandforgeVersion)
  ) {
    throw new Refused(
      'STATE_NEWER',
      `The state ${file} was written by a later SandForge (${String(said?.sandforgeVersion ?? `version ${String(version)}`)}; ` +
        `this one is ${deps.sandforgeVersion}): update it, and plan again. ${NOTHING}`,
    );
  }
  return { damaged: true };
}

/**
 * Rebuild the state of the environment on the org from its run files, and
 * write it: see the module's comment. Refused, it wrote nothing, the state's
 * folder as it was.
 */
export async function recoverEnvState(
  deps: EnvRecoverDeps,
  input: EnvRecoverInput,
): Promise<EnvRecoverOutcome> {
  const env = input.resolved.checked.file.name;
  const { target } = input;
  const taken = acquireEnvLock(
    deps.locksDir,
    target.organizationId,
    { operation: 'recover', env, alias: target.alias },
    deps.lockOptions,
  );
  if ('busy' in taken) return { refusal: lockRefusal(taken.busy) };
  try {
    const { damaged } = await stateNow(deps, input);
    const found = await findRuns(deps, input);
    const resources: ResourceRebuilt[] = [];
    for (const resource of [...found.ranks.keys(), ...found.frozen, ...found.dataops]) {
      if (resources.some((r) => r.name === resource)) continue;
      const rebuilt = await rebuildResource(deps, input, found, resource);
      if (rebuilt !== undefined) resources.push(rebuilt);
    }
    const passedOver: string[] = [];
    for (const unclaimed of found.unclaimed) {
      if (seedRemovalTookAll(unclaimed.run)) {
        passedOver.push(
          `${unclaimed.file}: a run of ${unclaimed.resource}, which neither the file nor the ` +
            "environment's folder has, taken back whole: passed over",
        );
        continue;
      }
      throw new Refused(
        'RUN_UNCLAIMED',
        `The seed run file ${unclaimed.file} is of a resource ${unclaimed.resource} that neither ` +
          `the file nor the environment's folder has: it may be another environment's, whose ` +
          `name begins as ${env} does. Move it out of the folder if it is, or put ` +
          `${unclaimed.resource} back in the file. ${NOTHING}`,
      );
    }
    if (resources.length === 0) {
      throw new Refused(
        'NO_RUNS',
        `This machine keeps no run of ${env} on ${target.alias}: there is nothing to rebuild a ` +
          'state from. If the org holds nothing of the environment, apply it with ' +
          `--accept-no-state. ${NOTHING}`,
      );
    }
    resources.sort(
      (a, b) =>
        Date.parse(a.firstStartedAt) - Date.parse(b.firstStartedAt) || a.name.localeCompare(b.name),
    );
    const first = resources[0]?.firstStartedAt ?? new Date(0).toISOString();
    const ends = resources.flatMap((r) => (r.lastEndedAt !== undefined ? [r.lastEndedAt] : []));
    const last = ends.sort().at(-1);
    const checkpoints = await linkedCheckpoints(deps, input, {
      first,
      ...(last !== undefined ? { last } : {}),
    });

    const fresh = newEnvState({
      env,
      org: {
        organizationId: target.organizationId,
        kind: target.kind,
        username: target.username,
        alias: target.alias,
      },
      fileDigest: input.resolved.digest,
      sandforgeVersion: deps.sandforgeVersion,
    });
    const next: EnvState = {
      ...fresh,
      resources: Object.fromEntries(resources.map((r) => [r.name, r.state])),
      ...(checkpoints.before !== undefined || checkpoints.after !== undefined
        ? {
            checkpoints: {
              ...(checkpoints.before !== undefined ? { before: checkpoints.before } : {}),
              ...(checkpoints.after !== undefined ? { after: checkpoints.after } : {}),
            },
          }
        : {}),
    };
    // Checked whole before the damaged state is set aside: a state that would
    // not read back is refused with nothing moved.
    const checked = envStateSchema.safeParse({ ...next, serial: 1 });
    if (!checked.success) {
      const issue = checked.error.issues[0];
      throw new Refused(
        'RUN_UNREAD',
        `The run files of ${env} do not make a state (${issue?.path.join('.') ?? ''}: ` +
          `${issue?.message ?? 'refused'}). ${NOTHING}`,
      );
    }
    const setAside = damaged ? await deps.store.setAside(target.organizationId, env) : undefined;
    const written = await deps.store.write(next, { serial: 0, lineage: next.lineage });
    const inFile = new Set(input.resolved.resources.map((resource) => resource.name));
    return {
      state: written,
      result: {
        env,
        org: {
          organizationId: written.org.organizationId,
          kind: written.org.kind,
          alias: target.alias,
        },
        state: { serial: written.serial, lineage: written.lineage },
        ...(setAside !== undefined ? { setAside } : {}),
        resources: Object.fromEntries(
          resources.map((r) => [
            r.name,
            {
              kind: r.state.kind,
              status: r.state.status,
              runs: r.state.runs.map((run) => run.n),
              takenBack: r.state.runs.filter((run) => run.takenBack === true).map((run) => run.n),
              inFile: inFile.has(r.name),
            },
          ]),
        ),
        checkpoints: {
          ...(checkpoints.before !== undefined ? { before: checkpoints.before } : {}),
          ...(checkpoints.after !== undefined ? { after: checkpoints.after } : {}),
        },
        notLinked: [...checkpoints.notLinked, ...passedOver].slice(0, 20),
      },
    };
  } catch (err: unknown) {
    if (err instanceof Refused) {
      return { refusal: { code: err.code, message: err.message, exit: 1 } };
    }
    throw err;
  } finally {
    taken.lock.release();
  }
}

/** The ranks of runs, as a line says them: `run 1`, `runs 1, 2`. */
function ranksLine(ranks: readonly number[]): string {
  return `${ranks.length === 1 ? 'run' : 'runs'} ${ranks.join(', ')}`;
}

/** The lines a recover ends with: per resource what it holds, what is not linked, and what plan does next. */
export function recoverLines(result: EnvRecoverResult): string[] {
  const lines = [
    `state of ${result.env} on ${result.org.alias ?? result.org.organizationId} rebuilt from its ` +
      `run files: serial ${result.state.serial}`,
  ];
  const width = Math.max(...Object.keys(result.resources).map((name) => name.length));
  for (const [name, resource] of Object.entries(result.resources)) {
    const back =
      resource.takenBack.length === 0
        ? ''
        : resource.takenBack.length === resource.runs.length
          ? `, taken back`
          : `; ${ranksLine(resource.takenBack)} taken back`;
    lines.push(
      `  ${name.padEnd(width)}  ${resource.kind}, ${resource.status}: ${ranksLine(resource.runs)}${back}` +
        (resource.inFile ? '' : '; gone from the file'),
    );
  }
  if (result.checkpoints.before !== undefined) {
    lines.push(`  checkpoint.before: ${result.checkpoints.before}`);
  }
  if (result.checkpoints.after !== undefined) {
    lines.push(`  checkpoint.after: ${result.checkpoints.after}`);
  }
  for (const line of result.notLinked) lines.push(`  ${line}`);
  if (result.setAside !== undefined) {
    lines.push(`the state that did not read is kept, set aside: ${result.setAside}`);
  }
  lines.push(
    'next: plan replaces each resource still in the org, whose run files do not say what it was ' +
      'applied from, and asks no --accept-no-state',
  );
  return lines;
}
