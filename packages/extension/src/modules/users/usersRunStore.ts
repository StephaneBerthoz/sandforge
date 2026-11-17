/**
 * Where the runs of `sandforge users` are kept on this machine: one file a
 * run, in a folder of the org it set up, named by the Organization Id that
 * org answered.
 *
 * ```
 * <SANDFORGE_JOURNAL_DIR | ~/.sandforge>/users/
 *   <Organization Id>/
 *     run-<n>.json     what run n held of each user: what it was before the
 *                      environment first changed it, what the run left, the
 *                      accesses it created, by id and name, and its removals
 * ```
 *
 * A run file is written before the run's first write and again after each
 * of its steps, so that a run cut short still says what a removal takes
 * back. It is taken whole: written beside itself, then renamed over.
 *
 * By Organization Id, never by alias: a sandbox refreshed since answers
 * another Id, and the users the copy brought are none a run here set up. Its
 * owner's alone, outside any repository, as every file that names records of
 * an org by their Ids is (`SasPathGuard`).
 *
 * A run file holds ids, usernames, booleans and the names of profiles,
 * permission sets and groups — never an address and never a person's name.
 * What the org refused is kept by its code alone: its words may name the
 * person, and are said once, by the run that met them.
 */

import { randomBytes } from 'node:crypto';
import { open, readFile, readdir, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import * as z from 'zod';
import {
  USERS_MAX,
  USERS_MAX_GROUPS,
  USERS_MAX_PERMISSION_SET_GROUPS,
  USERS_MAX_PERMISSION_SETS,
  checkpointOrganizationIdSchema,
  usersAppliedUserSchema,
} from '@sandforge/shared';

import {
  CHECKPOINT_FILE_MODE,
  makePrivateDir,
  organizationKey,
} from '../checkpoint/OrgCheckpointStore.js';
import { SasPathGuard } from '../frozendataset/SasPathGuard.js';

/** The folder the runs are kept in, inside the commands' own. */
const USERS_FOLDER = 'users';

/**
 * The store of runs when nothing names another: `users/` in the folder
 * `SANDFORGE_JOURNAL_DIR` names, or in `.sandforge` in the home directory.
 */
export function defaultUsersStoreRoot(env: NodeJS.ProcessEnv = process.env): string {
  const dir = env['SANDFORGE_JOURNAL_DIR'];
  const home =
    dir !== undefined && dir.trim() !== '' ? resolve(dir) : join(homedir(), '.sandforge');
  return join(home, USERS_FOLDER);
}

// ─── run-<n>.json ────────────────────────────────────────────────────────────

const instantSchema = z.iso.datetime({ offset: true });
const countSchema = z.number().int().nonnegative();
const runSchema = z.number().int().positive().max(999_999);

/** What a user was, or is left, on the three things a run writes of it. */
const userStandingSchema = z.strictObject({
  isActive: z.boolean(),
  isFrozen: z.boolean(),
  profileId: z.string().regex(/^00e[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?$/),
});

/** An access the environment created and holds, by id and by the name the file gave it. */
const heldAccessSchema = z.strictObject({
  id: z.string().regex(/^(?:0Pa|011)[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?$/),
  what: z.enum(['permissionSet', 'permissionSetGroup', 'group']),
  name: z
    .string()
    .regex(/^[A-Za-z][A-Za-z0-9_]*$/)
    .max(80),
  type: z.enum(['Regular', 'Queue']).optional(),
});

/**
 * One user a run holds: what it did and created (the contract's own
 * answer), what it left of the user — what a removal compares the org with —
 * and the accesses the environment holds of it, named.
 */
export const usersHeldUserSchema = z.strictObject({
  applied: usersAppliedUserSchema,
  /** What the environment left: where it differs from `applied.before`, the environment changed it. */
  after: userStandingSchema,
  accesses: z
    .array(heldAccessSchema)
    .max(USERS_MAX_PERMISSION_SETS + USERS_MAX_PERMISSION_SET_GROUPS + USERS_MAX_GROUPS),
  /**
   * Whether the file named the user in this run. One taken out of it stays
   * held while what it held could not all be put back.
   */
  inFile: z.boolean(),
});

/** One removal of a run: when, how it ended, how much it put back and kept, and the codes it met. */
const removalSchema = z.strictObject({
  at: instantSchema,
  status: z.enum(['success', 'partial', 'failure', 'cancelled']),
  undone: countSchema,
  kept: countSchema,
  codes: z.array(z.string().regex(/^[A-Z][A-Z_]{1,63}$/)).max(50),
});

/** `run-<n>.json`. */
export const usersRunRecordSchema = z.strictObject({
  version: z.literal(1),
  organizationId: checkpointOrganizationIdSchema,
  run: runSchema,
  /** The run this one replaced, converging from what it held. */
  replaces: runSchema.optional(),
  status: z.enum(['running', 'success', 'partial', 'failure', 'cancelled']),
  startedAt: instantSchema,
  endedAt: instantSchema.optional(),
  emailsToPeople: countSchema,
  users: z.array(usersHeldUserSchema).max(2 * USERS_MAX),
  removals: z.array(removalSchema).max(1_000).optional(),
});

export type UsersHeldUser = z.infer<typeof usersHeldUserSchema>;
export type UsersHeldAccess = z.infer<typeof heldAccessSchema>;
export type UsersRunRecord = z.infer<typeof usersRunRecordSchema>;

/** What a run file keeps of a refusal of the org: its code, never its words. */
function keptWordsOf(code: string): string {
  return `refused with ${code}; the org’s words are not kept, as they may name the person`;
}

/** A record as its file keeps it: the org's words of each refusal left out. */
function journaledOf(record: UsersRunRecord): UsersRunRecord {
  return {
    ...record,
    users: record.users.map((user) =>
      user.applied.refused === undefined
        ? user
        : {
            ...user,
            applied: {
              ...user.applied,
              refused: user.applied.refused.map((refused) => ({
                ...refused,
                message: keptWordsOf(refused.code),
              })),
            },
          },
    ),
  };
}

// ─── The store ───────────────────────────────────────────────────────────────

/** What a store is opened with. */
export interface UsersRunStoreOptions {
  /** {@link defaultUsersStoreRoot} unless one is named. */
  root: string;
  /** What keeps the store out of a repository: the repository above the working folder, unless a test names one. */
  guard?: SasPathGuard;
}

const RUN_FILE = /^run-([1-9]\d{0,5})\.json$/;

/** See the module's comment. */
export class UsersRunStore {
  readonly root: string;
  private readonly guard: SasPathGuard;

  constructor(options: UsersRunStoreOptions) {
    this.guard = options.guard ?? new SasPathGuard();
    this.root = this.guard.assertOutsideRepo(options.root);
  }

  /** The folder of an org's runs. */
  private folderOf(organizationId: string): string {
    return this.guard.assertOutsideRepo(join(this.root, organizationKey(organizationId)));
  }

  /** The file of run `run` of an org, whether it was written or not. */
  fileOf(organizationId: string, run: number): string {
    return join(this.folderOf(organizationId), `run-${runSchema.parse(run)}.json`);
  }

  /**
   * Keep a run before its first write: the next number of the org's runs,
   * taken by creating its file, so that two runs begun at once never share
   * one.
   */
  async begin(
    organizationId: string,
    begun: Omit<UsersRunRecord, 'version' | 'organizationId' | 'run'>,
  ): Promise<UsersRunRecord> {
    const folder = this.folderOf(organizationId);
    await makePrivateDir(folder);
    for (let run = (await this.highest(organizationId)) + 1; ; run += 1) {
      const record = usersRunRecordSchema.parse(
        journaledOf({
          ...begun,
          version: 1,
          organizationId: organizationKey(organizationId),
          run,
        }),
      );
      let handle;
      try {
        handle = await open(this.fileOf(organizationId, run), 'wx', CHECKPOINT_FILE_MODE);
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code === 'EEXIST') continue;
        throw err;
      }
      try {
        await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      return record;
    }
  }

  /** Write a run's file whole, the record checked and the org's words left out. */
  async write(record: UsersRunRecord): Promise<void> {
    const checked = usersRunRecordSchema.parse(journaledOf(record));
    await writeWhole(
      this.fileOf(checked.organizationId, checked.run),
      `${JSON.stringify(checked, null, 2)}\n`,
    );
  }

  /** A run of an org; undefined when it was never kept, or does not read. */
  async read(organizationId: string, run: number): Promise<UsersRunRecord | undefined> {
    let text: string;
    try {
      text = await readFile(this.fileOf(organizationId, run), 'utf8');
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw err;
    }
    try {
      const parsed = usersRunRecordSchema.safeParse(JSON.parse(text));
      return parsed.success && parsed.data.run === run ? parsed.data : undefined;
    } catch {
      return undefined;
    }
  }

  /** An org's runs that read, newest first. */
  async list(organizationId: string): Promise<UsersRunRecord[]> {
    const records: UsersRunRecord[] = [];
    for (const run of (await this.numbers(organizationId)).sort((a, b) => b - a)) {
      const record = await this.read(organizationId, run);
      if (record) records.push(record);
    }
    return records;
  }

  /** The numbers of an org's run files, read or not. */
  private async numbers(organizationId: string): Promise<number[]> {
    let names: string[];
    try {
      names = await readdir(this.folderOf(organizationId));
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    return names.flatMap((name) => {
      const match = RUN_FILE.exec(name);
      return match ? [Number(match[1])] : [];
    });
  }

  /** The highest number an org's run files take, 0 when none: a file that does not read keeps its number. */
  private async highest(organizationId: string): Promise<number> {
    return Math.max(0, ...(await this.numbers(organizationId)));
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
