/**
 * What SandForge keeps of one environment applied to one org: the state.
 *
 * Each script already keeps what it wrote, as it writes it, in its run file or
 * summary. The state does not copy those ids: it points at them, and adds what
 * no run knows — the file and resource a run belongs to, the fingerprint it
 * was applied from, the order, and how each step ended. Ids, counts and dates,
 * never a record's values, so it may be cached as the run files are.
 *
 * ```
 * <journal>/env/<organizationId>/<env>/   0700
 *   state.json                            0600  written beside, then renamed over
 *   runs/<resource>/<n>.summary.json            each run's --json summary
 *   templates/<resource>.<n>.json               the payload the run was given
 *   frozen/<resource>/                    0700  a frozen resource's sas: the mapping
 *                                               of what each load created, its
 *                                               counting contract, the script's store
 *   dataops/<resource>/                   0700  a mask resource's DataOps store: its
 *                                               snapshots, which hold the values it
 *                                               wrote over, until destroy deletes it
 * ```
 *
 * `<journal>` is the folder `SANDFORGE_JOURNAL_DIR` names, else `.sandforge`
 * in the home directory: the scripts' own, so a cache that keeps their run
 * files keeps the states too. A state is filed under the Organization Id read
 * live, never the alias: a CI alias reused for a new scratch org gets a new
 * state, and so does a refreshed sandbox, whose Id changed.
 *
 * Every write is checked against what it replaces: the serial it was read at
 * and its lineage. A state that moved since — another apply ran, a cache put
 * back an older one — is refused, never written over. A file that does not
 * parse is refused, never guessed: a plan made from half a state would create
 * again what the missing half names.
 *
 * The journal directory must sit outside the repository that holds the file:
 * committed, the state and the run summaries would publish the org's ids with
 * the project.
 */

import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, realpathSync, statSync } from 'node:fs';
import { open, readFile, readdir, rename, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import {
  envNameSchema,
  envStateSchema,
  type EnvResourceKind,
  type EnvResourceState,
  type EnvRun,
  type EnvState,
  type EnvTargetKind,
} from '@sandforge/shared';
import { organizationKey } from '../../src/modules/checkpoint/OrgCheckpointStore.js';
import { SasPathGuard, findRepoRoot } from '../../src/modules/frozendataset/SasPathGuard.js';
import { toolStoreOf } from '../backupStore.js';

/** What a folder of the states is made with: its owner alone lists and reads it. */
export const ENV_DIR_MODE = 0o700;

/** What a file of the states is made with: its owner alone reads it. */
export const ENV_FILE_MODE = 0o600;

/** Days a scratch org's state is kept after its last write: no scratch org lives longer. */
export const SCRATCH_STATE_KEEP_DAYS = 30;

const DAY_MS = 24 * 60 * 60_000;

/** The file a state is kept in, in its folder. */
const STATE_FILE = 'state.json';

/** A run's summary, from its state's folder. */
const SUMMARY_FILE = /^runs\/[a-z][a-z0-9-]{0,62}\/[1-9][0-9]{0,5}\.summary\.json$/;

/** The payload a run was given, from its state's folder. */
const TEMPLATE_FILE = /^templates\/[a-z][a-z0-9-]{0,62}\.[1-9][0-9]{0,5}\.json$/;

/** A frozen resource's sas, or a mask resource's DataOps store, from its state's folder. */
const SAS_FOLDER = /^(?:frozen|dataops)\/[a-z][a-z0-9-]{0,62}$/;

/** Why the states refused, or failed, what they were asked. */
export type EnvStateErrorCode =
  /** The file does not parse, or is not a state of SandForge's. */
  | 'damaged'
  /** It names another org or another environment than its folder. */
  | 'otherOrg'
  /** It changed since it was read: another apply ran, or a cache put back another. */
  | 'moved'
  /** A state, an id or a name that is not what it should be. */
  | 'invalid'
  /** A folder of the states another user owns, or one that cannot be made. */
  | 'folder';

export class EnvStateError extends Error {
  constructor(
    readonly code: EnvStateErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'EnvStateError';
  }
}

// ─── Where states are ────────────────────────────────────────────────────────

/**
 * The journal directory: the folder `SANDFORGE_JOURNAL_DIR` names, else
 * `.sandforge` in the home directory, where the scripts keep their run files.
 */
export function envJournalDirOf(env: NodeJS.ProcessEnv = process.env): string {
  return dirname(toolStoreOf('env', env));
}

/**
 * Why the journal directory may not hold the states of the file in
 * `fileFolder`, or undefined when it may: it sits inside the repository that
 * holds the file — the nearest folder above it with a `.git` — where the
 * state, the run summaries and the templates would be committed with the
 * project. Both are followed to where their links lead first: a journal
 * directory linked into the repository is inside it. A file in no repository
 * has nothing to be committed into.
 *
 * The scripts' own guard of a Frozen sas finds "the repository" from the
 * working directory, which for a command line is the SandForge checkout;
 * this one is given the file's folder, so it is the project's repository.
 */
export function journalInsideRepository(
  fileFolder: string,
  journalDir: string,
): string | undefined {
  const repoRoot = repositoryHolding(fileFolder, journalDir);
  if (repoRoot === undefined) return undefined;
  return (
    `The journal directory ${resolve(journalDir)} is inside the repository ${repoRoot} that ` +
    'holds the file: the state, the run summaries and the templates of its runs would be ' +
    'committed with it, and they name the org’s records by their ids. Point ' +
    'SANDFORGE_JOURNAL_DIR at a folder outside the repository — in CI, $RUNNER_TEMP/sandforge — ' +
    'and keep it between the jobs that apply and destroy, in a cache keyed by the org.'
  );
}

/**
 * The repository that holds the file in `fileFolder` — the nearest folder
 * above it with a `.git` — when `path` is inside it, or undefined: a file in
 * no repository has nothing to be committed into. Both are followed to where
 * their links lead first: a folder linked into the repository is inside it.
 */
export function repositoryHolding(fileFolder: string, path: string): string | undefined {
  let repoRoot: string;
  try {
    // From where the folder's links lead: walked up from a link, the parents
    // would be the link's, and the repository the file is in would be missed.
    repoRoot = findRepoRoot(followed(fileFolder));
  } catch {
    return undefined;
  }
  return new SasPathGuard(repoRoot).isInsideRepo(followed(path)) ? repoRoot : undefined;
}

/**
 * `path` resolved, with the deepest folder of it that exists followed to
 * where its links lead, and the rest as written: the journal directory need
 * not exist yet.
 */
function followed(path: string): string {
  const rest: string[] = [];
  let current = resolve(path);
  for (;;) {
    try {
      return join(realpathSync(current), ...rest.reverse());
    } catch {
      const parent = dirname(current);
      if (parent === current) return resolve(path);
      rest.push(basename(current));
      current = parent;
    }
  }
}

/** Where a run's `--json` summary is kept, from its state's folder: `runs/<resource>/<n>.summary.json`. */
export function runSummaryPathOf(resource: string, n: number): string {
  return `runs/${parsedName(resource)}/${parsedRunNumber(n)}.summary.json`;
}

/** Where the payload a run was given is kept, from its state's folder: `templates/<resource>.<n>.json`. */
export function runTemplatePathOf(resource: string, n: number): string {
  return `templates/${parsedName(resource)}.${parsedRunNumber(n)}.json`;
}

/**
 * The run id an environment gives a Seed run, `env-<env>-<resource>-<n>-<uuid>`:
 * one a lost state can be rebuilt from, since the run files left in the
 * journal directory name the environment, the resource and the rank.
 */
export function envRunIdOf(
  env: string,
  resource: string,
  n: number,
  uuid: string = randomUUID(),
): string {
  return `env-${parsedName(env)}-${parsedName(resource)}-${parsedRunNumber(n)}-${uuid}`;
}

function parsedName(name: string): string {
  const parsed = envNameSchema.safeParse(name);
  if (!parsed.success) throw new EnvStateError('invalid', `Not a name of the file: "${name}"`);
  return parsed.data;
}

function parsedRunNumber(n: number): number {
  if (!Number.isInteger(n) || n < 1 || n > 999_999) {
    throw new EnvStateError('invalid', `Not a run's rank: ${n}`);
  }
  return n;
}

// ─── Changes of a state ──────────────────────────────────────────────────────

/** The org a new state is of, as the guard typed it live. */
export interface EnvStateOrg {
  organizationId: string;
  kind: EnvTargetKind;
  username: string;
  alias?: string;
}

/**
 * The state of an environment no apply has written yet: serial 0, which no
 * file on disk has, and a lineage of its own.
 */
export function newEnvState(input: {
  env: string;
  org: EnvStateOrg;
  fileDigest: string;
  sandforgeVersion: string;
  now?: Date;
}): EnvState {
  return {
    version: 1,
    env: parsedName(input.env),
    lineage: randomUUID(),
    serial: 0,
    sandforgeVersion: input.sandforgeVersion,
    updatedAt: (input.now ?? new Date()).toISOString(),
    org: {
      organizationId: organizationKey(input.org.organizationId),
      kind: input.org.kind,
      username: input.org.username,
      ...(input.org.alias !== undefined ? { alias: input.org.alias } : {}),
    },
    file: { digest: input.fileDigest },
    resources: {},
  };
}

/** The run a step is about to start, before its script is spawned. */
export interface EnvRunStart {
  resource: string;
  kind: EnvResourceKind;
  /** The fingerprint the resource is applied from. */
  fingerprint: string;
  dependsOn: string[];
  run: Pick<EnvRun, 'script' | 'runId' | 'summary' | 'sas' | 'seed' | 'startedAt'>;
}

/** The rank the next run of a resource takes. */
export function nextRunNumber(resource: EnvResourceState | undefined): number {
  return (resource?.runs.at(-1)?.n ?? 0) + 1;
}

/**
 * The state once a run is about to start: its resource `applying`, from the
 * fingerprint it is applied from, with the run appended under the next rank.
 * Written before the script is spawned, a process killed anywhere after
 * leaves a state that names the run.
 */
export function runStarted(state: EnvState, start: EnvRunStart): EnvState {
  const before = state.resources[start.resource];
  const run: EnvRun = { ...start.run, n: nextRunNumber(before), objects: [] };
  return withResource(state, start.resource, {
    kind: start.kind,
    fingerprint: start.fingerprint,
    dependsOn: [...start.dependsOn],
    status: 'applying',
    runs: [...(before?.runs ?? []), run],
  });
}

/**
 * The state once a removal of a resource's runs is about to start: the
 * resource `destroying`. Its runs stay listed: their files say what the
 * removal takes back.
 */
export function removalStarted(state: EnvState, resource: string): EnvState {
  const before = state.resources[resource];
  if (before === undefined) {
    throw new EnvStateError('invalid', `The state holds no resource ${resource} to take back`);
  }
  return withResource(state, resource, { ...before, status: 'destroying' });
}

/**
 * The state once a removal took run `n` of a resource back whole: a later
 * removal skips it. Each replace and each destroy took back every earlier
 * run again, a script started and an org read for each, run after run.
 */
export function runTakenBack(state: EnvState, resource: string, n: number): EnvState {
  const before = state.resources[resource];
  if (before === undefined) {
    throw new EnvStateError('invalid', `The state holds no resource ${resource}`);
  }
  const runs = before.runs.map((run) => (run.n === n ? { ...run, takenBack: true as const } : run));
  return withResource(state, resource, { ...before, runs });
}

/** How a step ended, as its script's exit code and answer said. */
export interface EnvStepEnd {
  resource: string;
  status: EnvResourceState['status'];
  /**
   * The current run's outcome, for a step that ran the resource's script: with
   * the summary it printed, once kept beside the state.
   */
  run?: Pick<EnvRun, 'endedAt' | 'exitCode' | 'objects'> &
    Pick<Partial<EnvRun>, 'summary' | 'snapshotId'>;
}

/** The state once a step ended: its resource's status, and its current run's outcome. */
export function stepEnded(state: EnvState, end: EnvStepEnd): EnvState {
  const before = state.resources[end.resource];
  if (before === undefined) {
    throw new EnvStateError('invalid', `The state holds no resource ${end.resource}`);
  }
  const runs = [...before.runs];
  const current = runs.at(-1);
  if (end.run !== undefined) {
    if (current === undefined) {
      throw new EnvStateError('invalid', `The resource ${end.resource} has no run to end`);
    }
    runs[runs.length - 1] = { ...current, ...end.run };
  }
  return withResource(state, end.resource, { ...before, status: end.status, runs });
}

function withResource(state: EnvState, name: string, resource: EnvResourceState): EnvState {
  return { ...state, resources: { ...state.resources, [parsedName(name)]: resource } };
}

// ─── Expiry ──────────────────────────────────────────────────────────────────

/**
 * When a state expires: a scratch org's {@link SCRATCH_STATE_KEEP_DAYS} after
 * its last write, since no scratch org outlives that; other states never,
 * until a destroy ends clean or someone forgets them.
 */
export function stateExpiresAt(state: Pick<EnvState, 'org' | 'updatedAt'>): string | undefined {
  if (state.org.kind !== 'scratch') return undefined;
  return new Date(Date.parse(state.updatedAt) + SCRATCH_STATE_KEEP_DAYS * DAY_MS).toISOString();
}

// ─── The store ───────────────────────────────────────────────────────────────

/** What the states are opened with. */
export interface EnvStoreOptions {
  /** The journal directory: {@link envJournalDirOf} unless a test names another. */
  journalDir: string;
  /**
   * The folder of the file the states are of, whose repository the journal
   * directory must sit outside; null to list the states alone, which then
   * refuses every write.
   */
  fileFolder: string | null;
  /** The user this process runs as; undefined where the system has none, as on Windows. */
  uid?: () => number | undefined;
  /** Moves a written file over the one it replaces; a test makes it fail. */
  rename?: (from: string, to: string) => Promise<void>;
  /** Now, in epoch milliseconds. */
  now?: () => number;
}

/** A state on this machine, as the list gives it. */
export interface EnvStateListing {
  organizationId: string;
  env: string;
  folder: string;
  /** Absent when it is damaged. */
  state?: EnvState;
  /** Why it is not used. */
  damaged?: string;
  expiresAt?: string;
}

/** A state the sweep deleted on its date, as it is named. */
export interface EnvStateExpired {
  organizationId: string;
  env: string;
  alias?: string;
  updatedAt: string;
  expiresAt: string;
}

/**
 * Open the states in `options.journalDir`: refuse a journal directory inside
 * the file's repository, make `env/` its owner's alone when new, and refuse
 * one another user owns, who could read the states and replace them.
 */
export function openEnvStore(options: EnvStoreOptions): { store: EnvStore } | { refusal: string } {
  if (options.fileFolder !== null) {
    const inside = journalInsideRepository(options.fileFolder, options.journalDir);
    if (inside !== undefined) return { refusal: inside };
  }
  const store = new EnvStore(options);
  const refusal = openFolder(store.root, options.uid ?? currentUid);
  return refusal !== undefined ? { refusal } : { store };
}

/** The environments' states on this machine. Open them with {@link openEnvStore}. */
export class EnvStore {
  readonly root: string;
  private readonly fileFolder: string | null;
  private readonly uid: () => number | undefined;
  private readonly renameFile: (from: string, to: string) => Promise<void>;
  private readonly now: () => number;

  constructor(options: EnvStoreOptions) {
    this.root = join(resolve(options.journalDir), 'env');
    this.fileFolder = options.fileFolder;
    this.uid = options.uid ?? currentUid;
    this.renameFile = options.rename ?? ((from, to) => rename(from, to));
    this.now = options.now ?? Date.now;
  }

  /** Where the state of an environment applied to an org is, whether one is kept or not. */
  folderOf(organizationId: string, env: string): string {
    const org = organizationKeyOrNone(organizationId);
    if (org === undefined) {
      throw new EnvStateError('invalid', `Not an Organization Id: "${organizationId}"`);
    }
    return join(this.root, org, parsedName(env));
  }

  /** A file of a state's folder, by the path the state names it with. */
  fileOf(organizationId: string, env: string, relativePath: string): string {
    if (!SUMMARY_FILE.test(relativePath) && !TEMPLATE_FILE.test(relativePath)) {
      throw new EnvStateError('invalid', `Not a file of a state's folder: "${relativePath}"`);
    }
    return join(this.folderOf(organizationId, env), ...relativePath.split('/'));
  }

  /**
   * The state of an environment applied to an org, or undefined when none is
   * kept.
   *
   * @throws {EnvStateError} `damaged`, when its file does not parse;
   *   `otherOrg`, when it names another org or environment than its folder.
   */
  async read(organizationId: string, env: string): Promise<EnvState | undefined> {
    const folder = this.folderOf(organizationId, env);
    const file = join(folder, STATE_FILE);
    let raw: string;
    try {
      raw = await readFile(file, 'utf8');
    } catch (err: unknown) {
      if (codeOf(err) === 'ENOENT') return undefined;
      throw err;
    }
    return stateIn(raw, file, folder);
  }

  /**
   * Write a state whole, one serial past the one it was read at, after
   * checking that the state on disk is still that one: its serial, and its
   * lineage when one is there. The file is written beside, flushed and renamed
   * over: a write stopped at any point leaves the state as it was.
   *
   * @param read - The state as it was read: serial 0 for one no file holds yet.
   * @returns The state as written.
   * @throws {EnvStateError} `moved`, when the state on disk is another;
   *   `invalid`, when the state would not read back; `folder`, when its folder
   *   cannot be used.
   */
  async write(next: EnvState, read: Pick<EnvState, 'serial' | 'lineage'>): Promise<EnvState> {
    if (this.fileFolder === null) {
      throw new EnvStateError('invalid', 'The states were opened to be listed, not written');
    }
    if (next.lineage !== read.lineage) {
      throw new EnvStateError('invalid', 'A state is written over its own lineage only');
    }
    const folder = this.folderOf(next.org.organizationId, next.env);
    const onDisk = await this.read(next.org.organizationId, next.env);
    const serialOnDisk = onDisk?.serial ?? 0;
    if (serialOnDisk !== read.serial || (onDisk !== undefined && onDisk.lineage !== read.lineage)) {
      const moved =
        onDisk === undefined
          ? 'it is gone'
          : onDisk.lineage !== read.lineage
            ? 'it is another state, made since'
            : `serial ${serialOnDisk}, not ${read.serial}`;
      throw new EnvStateError(
        'moved',
        `The state of ${next.env} on ${next.org.organizationId} changed since it was read ` +
          `(${moved}): another apply or destroy ran, or a cache put back another state. ` +
          'Nothing was written: plan again.',
      );
    }
    const parsed = envStateSchema.safeParse({
      ...next,
      org: { ...next.org, organizationId: organizationKey(next.org.organizationId) },
      serial: read.serial + 1,
      updatedAt: new Date(this.now()).toISOString(),
    });
    if (!parsed.success) {
      throw new EnvStateError('invalid', `Not a state: ${parsed.error.message}`);
    }
    for (const dir of [dirname(folder), folder]) {
      const refusal = openFolder(dir, this.uid);
      if (refusal !== undefined) throw new EnvStateError('folder', refusal);
    }
    await this.writeWhole(join(folder, STATE_FILE), `${JSON.stringify(parsed.data, null, 2)}\n`);
    return parsed.data;
  }

  /**
   * Change a state and write it before going on: what a step does before it
   * spawns its script, so the state names the run whatever happens next.
   */
  async update(state: EnvState, change: (state: EnvState) => EnvState): Promise<EnvState> {
    return this.write(change(state), state);
  }

  /**
   * Write a file of a state's folder whole — a run's summary, the payload a
   * run was given — by the path the state names it with: its owner's alone,
   * written beside and renamed over, as the state is.
   *
   * @returns Where it was written.
   * @throws {EnvStateError} `invalid`, when the states were opened to be
   *   listed or the path is not one of a state's folder; `folder`, when a
   *   folder of it cannot be used.
   */
  async writeFile(
    organizationId: string,
    env: string,
    relativePath: string,
    content: string,
  ): Promise<string> {
    if (this.fileFolder === null) {
      throw new EnvStateError('invalid', 'The states were opened to be listed, not written');
    }
    const file = this.fileOf(organizationId, env, relativePath);
    const folder = this.folderOf(organizationId, env);
    for (const dir of [dirname(folder), folder, dirname(file)]) {
      const refusal = openFolder(dir, this.uid);
      if (refusal !== undefined) throw new EnvStateError('folder', refusal);
    }
    await this.writeWhole(file, content);
    return file;
  }

  /**
   * Make the folders of a file of a state's folder that a script writes
   * itself — a forge run's summary, which the clone writes as it goes — its
   * owner's alone, and give the file's path. Nothing is written: a file
   * already there is left as it is, and the clone refuses to write over it.
   *
   * @throws {EnvStateError} as {@link writeFile} does.
   */
  async prepareFile(organizationId: string, env: string, relativePath: string): Promise<string> {
    if (this.fileFolder === null) {
      throw new EnvStateError('invalid', 'The states were opened to be listed, not written');
    }
    const file = this.fileOf(organizationId, env, relativePath);
    const folder = this.folderOf(organizationId, env);
    for (const dir of [dirname(folder), folder, dirname(file)]) {
      const refusal = openFolder(dir, this.uid);
      if (refusal !== undefined) throw new EnvStateError('folder', refusal);
    }
    return file;
  }

  /**
   * Make a frozen resource's sas — `frozen/<resource>` of a state's folder —
   * or a mask resource's DataOps store — `dataops/<resource>` — its owner's
   * alone, and give its path: the folder its loads, or its snapshots, are
   * kept in, which the script writes itself.
   *
   * @throws {EnvStateError} `invalid`, when the states were opened to be
   *   listed or the path is not a sas of a state's folder; `folder`, when a
   *   folder of it cannot be used.
   */
  async prepareFolder(organizationId: string, env: string, relativePath: string): Promise<string> {
    if (this.fileFolder === null) {
      throw new EnvStateError('invalid', 'The states were opened to be listed, not written');
    }
    if (!SAS_FOLDER.test(relativePath)) {
      throw new EnvStateError('invalid', `Not a folder of a state's folder: "${relativePath}"`);
    }
    const folder = this.folderOf(organizationId, env);
    const sas = join(folder, ...relativePath.split('/'));
    for (const dir of [dirname(folder), folder, dirname(sas), sas]) {
      const refusal = openFolder(dir, this.uid);
      if (refusal !== undefined) throw new EnvStateError('folder', refusal);
    }
    return sas;
  }

  /** Where a frozen resource's sas, or a mask resource's store, is in a state's folder, whether it is there or not. */
  sasOf(organizationId: string, env: string, relativePath: string): string {
    if (!SAS_FOLDER.test(relativePath)) {
      throw new EnvStateError('invalid', `Not a folder of a state's folder: "${relativePath}"`);
    }
    return join(this.folderOf(organizationId, env), ...relativePath.split('/'));
  }

  /** Delete an environment's folder, its state with it: a destroy ended clean, or a state forgotten. */
  async remove(organizationId: string, env: string): Promise<boolean> {
    const folder = this.folderOf(organizationId, env);
    if (statSync(folder, { throwIfNoEntry: false }) === undefined) return false;
    await rm(folder, { recursive: true, force: true });
    return true;
  }

  /** Every state kept on this machine, damaged ones included, by org then environment. */
  async list(): Promise<EnvStateListing[]> {
    const listed: EnvStateListing[] = [];
    for (const org of await foldersIn(this.root)) {
      // Only the folders a state is filed in: another name, or the other form
      // of an Organization Id, would read another folder than the one listed.
      if (organizationKeyOrNone(org) !== org) continue;
      for (const env of await foldersIn(join(this.root, org))) {
        if (!envNameSchema.safeParse(env).success) continue;
        const folder = join(this.root, org, env);
        try {
          const state = await this.read(org, env);
          if (state === undefined) continue;
          const expiresAt = stateExpiresAt(state);
          listed.push({
            organizationId: org,
            env,
            folder,
            state,
            ...(expiresAt !== undefined ? { expiresAt } : {}),
          });
        } catch (err: unknown) {
          listed.push({ organizationId: org, env, folder, damaged: messageOf(err) });
        }
      }
    }
    return listed;
  }

  /**
   * Delete the states whose date has come: a scratch org's, a month after
   * its last write. A damaged state is never deleted on a date it cannot say.
   */
  async sweep(): Promise<EnvStateExpired[]> {
    const now = this.now();
    const swept: EnvStateExpired[] = [];
    for (const { state, expiresAt, folder, organizationId, env } of await this.list()) {
      if (state === undefined || expiresAt === undefined || Date.parse(expiresAt) > now) continue;
      await rm(folder, { recursive: true, force: true });
      swept.push({
        organizationId,
        env,
        ...(state.org.alias !== undefined ? { alias: state.org.alias } : {}),
        updatedAt: state.updatedAt,
        expiresAt,
      });
    }
    return swept;
  }

  /**
   * Write a file whole: into a file of its own beside it, made for this write
   * alone and its owner's, flushed to the disk, then renamed over it.
   */
  private async writeWhole(file: string, content: string): Promise<void> {
    const temp = `${file}.${process.pid}-${randomBytes(4).toString('hex')}.tmp`;
    const handle = await open(temp, 'wx', ENV_FILE_MODE);
    try {
      try {
        await handle.writeFile(content, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      await this.renameFile(temp, file);
    } catch (err: unknown) {
      await rm(temp, { force: true });
      throw err;
    }
  }
}

/** A state file's content, checked: it parses, and it is its folder's own. */
function stateIn(raw: string, file: string, folder: string): EnvState {
  let content: unknown;
  try {
    content = JSON.parse(raw);
  } catch {
    content = undefined;
  }
  const parsed = envStateSchema.safeParse(content);
  if (!parsed.success) {
    throw new EnvStateError(
      'damaged',
      `The state ${file} does not read as a state of this SandForge, and is not used: a plan ` +
        'made from part of it would create again what the rest names. Read it, then delete its ' +
        'folder to start afresh: the records an earlier apply created stay in the org.',
    );
  }
  // A file copied from another org's folder, or another environment's, would
  // have a destroy take back records of an org it does not describe.
  const state = parsed.data;
  if (
    organizationKey(state.org.organizationId) !== basename(dirname(folder)) ||
    state.env !== basename(folder)
  ) {
    throw new EnvStateError(
      'otherOrg',
      `The state ${file} is of ${state.env} on ${state.org.organizationId}, not of the org and ` +
        'environment its folder names: it was copied or moved, and is not used. Put it back ' +
        'where it came from, or delete it.',
    );
  }
  return state;
}

/** The user this process runs as; undefined where the system has none, as on Windows. */
function currentUid(): number | undefined {
  return process.getuid?.();
}

/**
 * Make a folder of the states, and its missing parents, its owner's alone,
 * and refuse one another user owns.
 *
 * @returns Why it cannot be used, or undefined when it can.
 */
function openFolder(dir: string, uid: () => number | undefined): string | undefined {
  try {
    const there = statSync(dir, { throwIfNoEntry: false });
    if (there !== undefined && !there.isDirectory()) return `${dir} is not a folder.`;
    mkdirSync(dir, { recursive: true, mode: ENV_DIR_MODE });
    const me = uid();
    if (me !== undefined && statSync(dir).uid !== me) {
      return (
        `${dir} belongs to another user, who can read the states kept there and replace ` +
        'them: point SANDFORGE_JOURNAL_DIR at a folder of your own.'
      );
    }
    return undefined;
  } catch (err: unknown) {
    return `${dir} could not be made: ${messageOf(err)}`;
  }
}

/** {@link organizationKey}, or undefined for what is not an Organization Id. */
function organizationKeyOrNone(organizationId: string): string | undefined {
  try {
    return organizationKey(organizationId);
  } catch {
    return undefined;
  }
}

/** The folders directly in a folder, in name order; none when it is not there. */
async function foldersIn(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch (err: unknown) {
    if (codeOf(err) === 'ENOENT' || codeOf(err) === 'ENOTDIR') return [];
    throw err;
  }
}

function codeOf(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException | undefined)?.code;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
