/**
 * The roots of a clone from records, on disk: the ids a dry run read of the
 * records its query chose, which the run after it writes rather than read
 * the query again — a record made in between, matching the query, is not
 * written; one deleted in between is said gone.
 *
 * A plan holds two thousand ids at most (`FORGE_ROOTS_MAX`), some forty KB:
 * one JSON file, `{ version, sourceOrgId, fingerprint, objectApiName, query,
 * from, readAt, ids, sha256 }`, its ids sorted as `compareIds` sorts them,
 * each once, and their SHA-256 beside them. Read back, a file whose ids no
 * longer give its SHA-256 is refused (`changed`), and one not there
 * (`gone`).
 *
 * The ids are a production's records: the file is its owner's alone (0600)
 * in a folder its owner's alone (0700), where the platform keeps such
 * modes, written beside its place then put there whole. The panel keeps a
 * dry run's in `forge-roots/<fingerprint>.json` under the storage folder,
 * taken up by the run of the same setup within a day and swept after it;
 * the command line in the file `--roots-plan` names.
 */

import { randomBytes } from 'node:crypto';
import { chmod, open, readFile, readdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import * as z from 'zod';
import { FORGE_ROOTS_MAX, type ForgeRootsQuery } from '@sandforge/shared';
import { CHECKPOINT_FILE_MODE, makePrivateDir } from '../../checkpoint/OrgCheckpointStore.js';
import { isRootId, rootsSha256, sortedRootIds } from '../stages/QueryRoots.js';

/** How long a dry run's roots are taken up by the run after it, and kept. */
export const ROOT_PLAN_MAX_AGE_MS = 24 * 60 * 60_000;

/** The folder of dry runs' roots under the storage folder. */
const ROOTS_DIR = 'forge-roots';

/** What a dry run's file is named by: a run's fingerprint, letters, digits, `_` and `-`. */
const FILE_NAME = /^[A-Za-z0-9_-]{1,128}$/;

/** The roots a run read, as a plan keeps them. */
export interface RootPlan {
  version: 1;
  /** The org the ids are of. */
  sourceOrgId: string;
  /** The fingerprint of the setup they were read for (`forgeRunFingerprint`); empty when none was given. */
  fingerprint: string;
  /** The object the roots are records of. */
  objectApiName: string;
  /** The query that chose them; absent for roots named one by one. */
  query?: ForgeRootsQuery;
  /** Chosen by a query, or named one by one. */
  from: 'query' | 'records';
  /** When they were read, an ISO date. */
  readAt: string;
  /** The ids, sorted, each once. */
  ids: string[];
  /** The SHA-256 of the ids (`rootsSha256`). */
  sha256: string;
}

/** Roots to keep: see {@link keepRootPlan}. */
export type RootPlanToKeep = Omit<RootPlan, 'version' | 'ids' | 'sha256'> & {
  ids: Iterable<string>;
};

/** Why a plan cannot be read as one. */
export type RootPlanFault =
  /** Not on this machine: removed, or never written whole. */
  | 'gone'
  /** Its ids are no longer those its SHA-256 was taken of, or it no longer reads as a plan. */
  | 'changed';

/** A plan refused as it was read: see {@link RootPlanFault}. */
export class RootPlanError extends Error {
  constructor(
    readonly fault: RootPlanFault,
    message: string,
  ) {
    super(message);
    this.name = 'RootPlanError';
  }
}

const querySchema = z.strictObject({
  where: z.string().min(1).max(512).optional(),
  orderBy: z.string().min(1).max(200).optional(),
  limit: z.number().int().min(1).max(FORGE_ROOTS_MAX).optional(),
});

const planSchema = z.strictObject({
  version: z.literal(1),
  sourceOrgId: z.string().min(1).max(128),
  fingerprint: z.string().max(128),
  objectApiName: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,79}$/),
  query: querySchema.optional(),
  from: z.enum(['query', 'records']),
  readAt: z.string().refine((text) => Number.isFinite(Date.parse(text)), 'not a date'),
  ids: z.array(z.string().refine(isRootId, 'not a record id')).max(FORGE_ROOTS_MAX),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});

/** The folder of dry runs' roots under `storagePath`. */
export function rootsDirOf(storagePath: string): string {
  return join(storagePath, ROOTS_DIR);
}

/**
 * The file of the roots the last dry run of the setup `fingerprint` read.
 *
 * @throws {RootPlanError} `gone`, for a fingerprint that is no name of a file:
 *   it is about to become a path.
 */
export function dryRunRootPlanPathOf(storagePath: string, fingerprint: string): string {
  if (!FILE_NAME.test(fingerprint)) {
    throw new RootPlanError('gone', 'Not the fingerprint of a setup of a run.');
  }
  return join(rootsDirOf(storagePath), `${fingerprint}.json`);
}

/** Whether `error` says a file is not there. */
function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/**
 * Keep `plan` in `file`, in place of what it held: written beside it, its
 * owner's alone, then put in its place whole. Its ids sorted, each once,
 * their SHA-256 taken of them.
 *
 * @returns The plan as kept.
 */
export async function keepRootPlan(file: string, plan: RootPlanToKeep): Promise<RootPlan> {
  const ids = sortedRootIds(plan.ids);
  const kept: RootPlan = {
    version: 1,
    sourceOrgId: plan.sourceOrgId,
    fingerprint: plan.fingerprint,
    objectApiName: plan.objectApiName,
    ...(plan.query !== undefined ? { query: { ...plan.query } } : {}),
    from: plan.from,
    readAt: plan.readAt,
    ids,
    sha256: rootsSha256(ids),
  };
  const checked = planSchema.parse(kept);
  await makePrivateDir(dirname(file));
  const temp = `${file}.${process.pid}-${randomBytes(4).toString('hex')}.tmp`;
  try {
    const handle = await open(temp, 'wx', CHECKPOINT_FILE_MODE);
    try {
      await handle.writeFile(`${JSON.stringify(checked)}\n`, 'utf8');
    } finally {
      await handle.close();
    }
    await chmod(temp, CHECKPOINT_FILE_MODE);
    await rename(temp, file);
  } catch (error: unknown) {
    await rm(temp, { force: true });
    throw error;
  }
  return checked;
}

/**
 * The plan in `file`, as it was kept.
 *
 * @throws {RootPlanError} `gone` when nothing is there; `changed` when what
 *   is there no longer reads as a plan, or its ids no longer give its SHA-256.
 */
export async function openRootPlan(file: string): Promise<RootPlan> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error: unknown) {
    if (isMissing(error)) {
      throw new RootPlanError('gone', `No plan of roots is at ${file}.`);
    }
    throw error;
  }
  let parsed: RootPlan;
  try {
    parsed = planSchema.parse(JSON.parse(text));
  } catch {
    throw new RootPlanError('changed', `The plan of roots at ${file} no longer reads as one.`);
  }
  if (rootsSha256(parsed.ids) !== parsed.sha256) {
    throw new RootPlanError(
      'changed',
      `The ids of the plan of roots at ${file} are no longer those it was kept with.`,
    );
  }
  return parsed;
}

/** How long ago `plan` was read, by `now`. */
export function rootPlanAgeMs(plan: Pick<RootPlan, 'readAt'>, now: Date): number {
  return now.getTime() - Date.parse(plan.readAt);
}

/**
 * The roots the last dry run of the setup `fingerprint` read, which the run
 * after it takes up while they are less than a day old: `tooOld` past that,
 * undefined when there are none, or none that read whole.
 */
export async function lastDryRunRootPlan(
  storagePath: string,
  fingerprint: string,
  now: Date,
): Promise<RootPlan | 'tooOld' | undefined> {
  let plan: RootPlan;
  try {
    plan = await openRootPlan(dryRunRootPlanPathOf(storagePath, fingerprint));
  } catch (error: unknown) {
    if (error instanceof RootPlanError) return undefined;
    throw error;
  }
  return rootPlanAgeMs(plan, now) >= ROOT_PLAN_MAX_AGE_MS ? 'tooOld' : plan;
}

/**
 * Remove the dry runs' roots read a day or more before `now`, and what a
 * keep left half written as long ago: their ids are a production's, kept no
 * longer than a run may take them up.
 *
 * @returns How many files were removed.
 */
export async function sweepRootPlans(storagePath: string, now: Date): Promise<number> {
  const root = rootsDirOf(storagePath);
  let names: string[];
  try {
    names = await readdir(root);
  } catch (error: unknown) {
    if (isMissing(error)) return 0;
    throw error;
  }
  let removed = 0;
  for (const name of names) {
    const file = join(root, name);
    let readAt: number;
    try {
      readAt = Date.parse((await openRootPlan(file)).readAt);
    } catch {
      // Half written, or no longer read as a plan: by when it was last written.
      try {
        readAt = (await stat(file)).mtimeMs;
      } catch (error: unknown) {
        if (isMissing(error)) continue;
        throw error;
      }
    }
    if (now.getTime() - readAt < ROOT_PLAN_MAX_AGE_MS) continue;
    await rm(file, { force: true });
    removed++;
  }
  return removed;
}
