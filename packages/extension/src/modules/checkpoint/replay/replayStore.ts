/**
 * Where the replays of a checkpoint into other orgs are kept on this
 * machine, and what lists them without asking any org.
 *
 * ```
 * <SANDFORGE_JOURNAL_DIR | ~/.sandforge>/replays/
 *   <checkpoint's Organization Id>/<checkpoint id>/
 *     replay.json                                   the checkpoint's name and date, and per
 *                                                   other org the choices replayed with
 *     referenceid-mapping.<other org>.json          what each replay created there, by key
 *     referenceid-mapping.<other org>.load-<n>.ndjson  a replay under way, a batch a line
 *     counting-contract.<other org>.json            what a verification counts
 * ```
 *
 * Outside the checkpoint's folder, so that a checkpoint expired or deleted
 * never takes with it what removing its replays needs: a replay is removed
 * from its mapping alone, the checkpoint gone. Outside any repository, as
 * every file that names records of an org by their Ids is (`SasPathGuard`),
 * and its owner's alone.
 *
 * Every file of a replay is named by the Organization Id of the org it went
 * into, as that org answered it — never by the alias or the registry's entry
 * a window or a command line knows it by, so that the panel and the command
 * line find each other's replays, and a sandbox refreshed since, which
 * answers another Id, is never taken for the org the replay wrote to.
 * `replay.json` holds choices and names, never a value of a record.
 */

import { randomBytes } from 'node:crypto';
import { open, readFile, readdir, rename, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import * as z from 'zod';
import {
  checkpointIdSchema,
  checkpointOrganizationIdSchema,
  checkpointReplayChoicesSchema,
  type CheckpointOrgTier,
  type CheckpointReplayChoices,
  type ForgeRunObjectRecords,
  type OrgCheckpoint,
} from '@sandforge/shared';
import {
  CHECKPOINT_FILE_MODE,
  CheckpointStoreError,
  makePrivateDir,
  organizationKey,
} from '../OrgCheckpointStore.js';
import { countingContractPath } from '../../frozendataset/CountingContract.js';
import { loadCreatedRecords, loadRecordsLeft } from '../../frozendataset/loadRecords.js';
import { SasPathGuard } from '../../frozendataset/SasPathGuard.js';
import {
  SasReferenceIdMappingStore,
  mappedOrgIds,
  type SasReferenceIdMappingStoreOptions,
} from '../../frozendataset/SasReferenceIdMappingStore.js';

/** The folder the replays are kept in, inside the commands' own. */
const REPLAYS_FOLDER = 'replays';

/** A replay's own file, in its folder. */
export const REPLAY_RECORD_FILE = 'replay.json';

/**
 * The store of replays when nothing names another: `replays/` in the folder
 * `SANDFORGE_JOURNAL_DIR` names, the command lines' own, or in `.sandforge`
 * in the home directory — beside the checkpoints' own `checkpoints/`.
 */
export function defaultReplayStoreRoot(env: NodeJS.ProcessEnv = process.env): string {
  const dir = env['SANDFORGE_JOURNAL_DIR'];
  const home =
    dir !== undefined && dir.trim() !== '' ? resolve(dir) : join(homedir(), '.sandforge');
  return join(home, REPLAYS_FOLDER);
}

// ─── replay.json ─────────────────────────────────────────────────────────────

const instantSchema = z.iso.datetime({ offset: true });

/** One org a checkpoint was replayed into, as `replay.json` keeps it. */
const replayTargetSchema = z.object({
  /** Its Organization Id, as it answered, 18 characters: what its files are named by. */
  organizationId: checkpointOrganizationIdSchema,
  /** What the person named it by: its alias, else its username. */
  name: z.string().min(1).max(255),
  choices: checkpointReplayChoicesSchema,
  firstAt: instantSchema,
  lastAt: instantSchema,
});

/** `replay.json`: the checkpoint replayed, and each org it was replayed into. */
const replayRecordSchema = z.object({
  version: z.literal(1),
  checkpoint: z.object({
    checkpointId: checkpointIdSchema,
    name: z.string().min(1).max(255),
    organizationId: checkpointOrganizationIdSchema,
    alias: z.string().min(1).max(255).optional(),
    tier: z.enum(['sandbox', 'scratch', 'developer']),
    takenAt: instantSchema,
  }),
  targets: z.array(replayTargetSchema).max(10_000),
});

/** `replay.json`, read. */
export type ReplayRecord = z.infer<typeof replayRecordSchema>;

/** The checkpoint a replay is of, as its folder names it. */
export type ReplayedCheckpoint = Pick<OrgCheckpoint, 'checkpointId' | 'name' | 'takenAt'> & {
  org: Pick<OrgCheckpoint['org'], 'organizationId' | 'alias' | 'tier'>;
};

/** The other org of a replay, as its folder names it. */
export interface ReplayTargetOrg {
  /** Its Organization Id, as it answered once connected. */
  organizationId: string;
  /** Its alias, else its username. */
  name: string;
}

/** A replay's folder: the checkpoint's, among the store's. */
export interface ReplayFolder {
  dir: string;
  /** The checkpoint's org, 18 characters. */
  sourceOrganizationId: string;
  checkpointId: string;
}

// ─── The list ────────────────────────────────────────────────────────────────

/** A checkpoint's replay into one org, as this machine's files say it, no org asked. */
export interface ReplayEntry {
  sourceOrganizationId: string;
  checkpointId: string;
  /** Absent when `replay.json` does not read: the replay is listed all the same, to be removed. */
  checkpointName?: string;
  takenAt?: string;
  target: { organizationId: string; name?: string };
  /** The choices of its last replay. */
  choices?: CheckpointReplayChoices;
  /** When its last replay wrote its last record; absent when none wrote. */
  replayedAt?: string;
  /** Records its replays created there that no removal took, every object together. */
  inPlace: number;
  /** Per object, those records. */
  inPlaceByObject: Array<{ objectApiName: string; records: number }>;
  /** Set when a removal took every record the last replay created. */
  removed?: true;
}

/** What a list is limited to. */
export interface ReplayListOptions {
  /** One org's replays: those into it. */
  targetOrganizationId?: string;
  /** One checkpoint's: those of it. */
  sourceOrganizationId?: string;
  checkpointId?: string;
}

/** What a store is opened with. */
export interface ReplayStoreOptions {
  /** {@link defaultReplayStoreRoot} unless one is named. */
  root: string;
  /** What keeps the store out of a repository: the repository above the working folder, unless a test names one. */
  guard?: SasPathGuard;
  now?: () => Date;
}

/** An org's folder name: its Organization Id, 18 characters. */
const ORGANIZATION_KEY = /^00D[A-Za-z0-9]{15}$/;

/** See the module's comment. */
export class ReplayStore {
  readonly root: string;
  private readonly guard: SasPathGuard;
  private readonly now: () => Date;
  /** The writes of each `replay.json` in this process, one after the other. */
  private readonly writes = new Map<string, Promise<unknown>>();

  constructor(options: ReplayStoreOptions) {
    this.guard = options.guard ?? new SasPathGuard();
    this.root = this.guard.assertOutsideRepo(options.root);
    this.now = options.now ?? (() => new Date());
  }

  /**
   * Where the replays of a checkpoint are kept, whether any was made or not.
   *
   * @throws {CheckpointStoreError} `invalid`, for an id that is not a
   *   checkpoint's or an Organization Id.
   */
  folderOf(sourceOrganizationId: string, checkpointId: string): ReplayFolder {
    const source = organizationKey(sourceOrganizationId);
    const parsed = checkpointIdSchema.safeParse(checkpointId);
    if (!parsed.success) throw new CheckpointStoreError('invalid', 'Not a checkpoint’s id');
    return {
      dir: this.guard.assertOutsideRepo(join(this.root, source, parsed.data)),
      sourceOrganizationId: source,
      checkpointId: parsed.data,
    };
  }

  /**
   * Keep what a replay of `checkpoint` into `target` was asked, before it
   * writes: the folder made, its owner's alone, and `replay.json` written
   * whole, the org's entry added or its choices replaced.
   */
  async record(
    checkpoint: ReplayedCheckpoint,
    target: ReplayTargetOrg,
    choices: CheckpointReplayChoices,
  ): Promise<ReplayFolder> {
    const folder = this.folderOf(checkpoint.org.organizationId, checkpoint.checkpointId);
    const targetKey = organizationKey(target.organizationId);
    const checkedChoices = checkpointReplayChoicesSchema.parse(choices);
    await makePrivateDir(folder.dir);
    const file = join(folder.dir, REPLAY_RECORD_FILE);
    const work = async (): Promise<void> => {
      const at = this.now().toISOString();
      const before = await readRecord(file);
      const kept = before?.targets.find((each) => each.organizationId === targetKey);
      const record: ReplayRecord = {
        version: 1,
        checkpoint: {
          checkpointId: folder.checkpointId,
          name: checkpoint.name,
          organizationId: folder.sourceOrganizationId,
          ...(checkpoint.org.alias !== undefined ? { alias: checkpoint.org.alias } : {}),
          tier: checkpoint.org.tier satisfies CheckpointOrgTier,
          takenAt: checkpoint.takenAt,
        },
        targets: [
          ...(before?.targets.filter((each) => each.organizationId !== targetKey) ?? []),
          {
            organizationId: targetKey,
            name: target.name,
            choices: checkedChoices,
            firstAt: kept?.firstAt ?? at,
            lastAt: at,
          },
        ],
      };
      await writeWhole(file, `${JSON.stringify(replayRecordSchema.parse(record), null, 2)}\n`);
    };
    const queued = (this.writes.get(file) ?? Promise.resolve()).then(work, work);
    const settled = queued.catch(() => undefined);
    this.writes.set(file, settled);
    void settled.then(() => {
      if (this.writes.get(file) === settled) this.writes.delete(file);
    });
    await queued;
    return folder;
  }

  /**
   * The mapping of the replays of a checkpoint into one org: what each
   * created, by key, what a removal and a reload read. Named by the org's
   * Organization Id; `organizationId` asks the org which one it is now, so a
   * mapping of an org refreshed since is never purged from the new one.
   */
  mappingStoreOf(
    folder: ReplayFolder,
    targetOrganizationId: string,
    options: Pick<SasReferenceIdMappingStoreOptions, 'organizationId' | 'now'> = {},
  ): SasReferenceIdMappingStore {
    return new SasReferenceIdMappingStore(folder.dir, {
      guard: this.guard,
      orgId: organizationKey(targetOrganizationId),
      ...options,
    });
  }

  /**
   * What the last replay of a checkpoint into one org created there, read
   * from its mapping alone, no org asked: per object, the records it lists
   * among its creations — never one it linked to, a record the org held
   * under the Id the checkpoint knows it by —, the objects in the reverse of
   * the order it wrote them and the last record written first, as a removal
   * takes them (`loadCreatedRecords`). Undefined when no replay of it into
   * that org kept a mapping that says which records it created.
   */
  async createdBy(
    folder: ReplayFolder,
    targetOrganizationId: string,
  ): Promise<ForgeRunObjectRecords[] | undefined> {
    const load = await this.mappingStoreOf(folder, targetOrganizationId).recorded();
    return load?.created === undefined ? undefined : loadCreatedRecords(load);
  }

  /** Where the counting contract of the replays of a checkpoint into one org is. */
  contractPathOf(folder: ReplayFolder, targetOrganizationId: string): string {
    return countingContractPath(this.guard, folder.dir, organizationKey(targetOrganizationId));
  }

  /** `replay.json` of a checkpoint's replays; undefined when none was recorded, or it does not read. */
  async read(folder: ReplayFolder): Promise<ReplayRecord | undefined> {
    return readRecord(join(folder.dir, REPLAY_RECORD_FILE));
  }

  /**
   * The replays this machine keeps, each checkpoint's into each org, read
   * from its files alone: newest first. A replay whose `replay.json` does not
   * read is listed by its mapping, so that what it left can still be removed.
   */
  async list(options: ReplayListOptions = {}): Promise<ReplayEntry[]> {
    const onlySource =
      options.sourceOrganizationId !== undefined
        ? organizationKey(options.sourceOrganizationId)
        : undefined;
    const onlyTarget =
      options.targetOrganizationId !== undefined
        ? organizationKey(options.targetOrganizationId)
        : undefined;
    const entries: ReplayEntry[] = [];
    for (const source of await foldersIn(this.root)) {
      if (!ORGANIZATION_KEY.test(source) || (onlySource !== undefined && source !== onlySource)) {
        continue;
      }
      for (const checkpointId of await foldersIn(join(this.root, source))) {
        if (!checkpointIdSchema.safeParse(checkpointId).success) continue;
        if (options.checkpointId !== undefined && checkpointId !== options.checkpointId) continue;
        const folder = this.folderOf(source, checkpointId);
        entries.push(...(await this.entriesOf(folder, onlyTarget)));
      }
    }
    return entries.sort(
      (a, b) =>
        compareText(b.replayedAt ?? '', a.replayedAt ?? '') ||
        compareText(a.checkpointId, b.checkpointId) ||
        compareText(a.target.organizationId, b.target.organizationId),
    );
  }

  /** The replays of one checkpoint, into every org: what its deletion names. */
  async replaysOf(sourceOrganizationId: string, checkpointId: string): Promise<ReplayEntry[]> {
    return this.list({ sourceOrganizationId, checkpointId });
  }

  /** A checkpoint's replays, one per org its folder names. */
  private async entriesOf(folder: ReplayFolder, onlyTarget?: string): Promise<ReplayEntry[]> {
    const record = await this.read(folder);
    const recorded = new Map(record?.targets.map((target) => [target.organizationId, target]));
    const mapped = (await mappedOrgIds(folder.dir, this.guard)).filter((id) =>
      ORGANIZATION_KEY.test(id),
    );
    const targets = [...new Set([...recorded.keys(), ...mapped])].filter(
      (id) => onlyTarget === undefined || id === onlyTarget,
    );
    const entries: ReplayEntry[] = [];
    for (const targetId of targets) {
      const kept = recorded.get(targetId);
      const loads = await this.mappingStoreOf(folder, targetId).recordedLoads();
      const left = new Map<string, number>();
      for (const load of loads) {
        for (const { objectApiName, ids } of loadRecordsLeft(load)) {
          left.set(objectApiName, (left.get(objectApiName) ?? 0) + ids.length);
        }
      }
      const inPlaceByObject = [...left]
        .map(([objectApiName, records]) => ({ objectApiName, records }))
        .sort((a, b) => compareText(a.objectApiName, b.objectApiName));
      const inPlace = inPlaceByObject.reduce((sum, object) => sum + object.records, 0);
      const last = loads.find((load) => load.earlier !== true);
      entries.push({
        sourceOrganizationId: folder.sourceOrganizationId,
        checkpointId: folder.checkpointId,
        ...(record ? { checkpointName: record.checkpoint.name } : {}),
        ...(record ? { takenAt: record.checkpoint.takenAt } : {}),
        target: { organizationId: targetId, ...(kept ? { name: kept.name } : {}) },
        ...(kept ? { choices: kept.choices } : {}),
        ...(last ? { replayedAt: last.endedAt } : {}),
        inPlace,
        inPlaceByObject,
        ...(last !== undefined && inPlace === 0 && last.removal !== undefined
          ? { removed: true as const }
          : {}),
      });
    }
    return entries;
  }
}

/**
 * The replays among `entries` that left records in an org: what a deletion
 * of their checkpoint names, since it takes nothing of them.
 */
export function replaysInPlace(entries: readonly ReplayEntry[]): ReplayEntry[] {
  return entries.filter((entry) => entry.inPlace > 0);
}

/**
 * What a deletion of a checkpoint says of its replays still in place, or
 * undefined when none is: each org by its name and what it holds of them.
 * The deletion leaves them, and each is still removed by its own mapping.
 */
export function replaysInPlaceWords(entries: readonly ReplayEntry[]): string | undefined {
  const inPlace = replaysInPlace(entries);
  if (inPlace.length === 0) return undefined;
  const each = inPlace
    .map(
      (entry) =>
        `${entry.inPlace.toLocaleString('en-US')} record${entry.inPlace === 1 ? '' : 's'} in ` +
        `${entry.target.name ?? entry.target.organizationId}`,
    )
    .join(', ');
  return (
    `${inPlace.length === 1 ? 'A replay' : `${inPlace.length} replays`} of it ` +
    `${inPlace.length === 1 ? 'is' : 'are'} still in place: ${each}. Deleting the checkpoint ` +
    'leaves them there, and each replay is still removed without it.'
  );
}

// ─── Files ───────────────────────────────────────────────────────────────────

/** `replay.json`, checked; undefined when it is not there or does not read. */
async function readRecord(file: string): Promise<ReplayRecord | undefined> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
  try {
    const parsed = replayRecordSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** Write a file whole, its owner's alone: through a file beside it, renamed over it once flushed. */
async function writeWhole(file: string, content: string): Promise<void> {
  const temp = `${file}.${process.pid}-${randomBytes(4).toString('hex')}.tmp`;
  const handle = await open(temp, 'wx', CHECKPOINT_FILE_MODE);
  try {
    try {
      await handle.writeFile(content, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temp, file);
  } catch (err: unknown) {
    await rm(temp, { force: true });
    throw err;
  }
}

/** The folders in `dir`, by name; none when it is not there. */
async function foldersIn(dir: string): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const folders: string[] = [];
  for (const name of names) {
    if ((await stat(join(dir, name)).catch(() => undefined))?.isDirectory()) folders.push(name);
  }
  return folders.sort();
}

/** Two texts in the order of their code points. */
function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
