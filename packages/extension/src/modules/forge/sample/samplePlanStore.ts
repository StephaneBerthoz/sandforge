/**
 * The plan of a sample of the whole org, on disk: the ids it keeps of each
 * object, and what was drawn and how — never a value of a record.
 *
 * Drawn once, a plan is read by everything after it: the dry run that drew
 * it says it, the run that takes it up writes its ids, a resume goes on after
 * each object's last id in it, its gate counts from it. So it is kept as it
 * was drawn, and refused when it no longer is:
 *
 * - each object's ids in a file of their own, one a line, in the order of
 *   {@link compareIds} — the order a run reads them in and resumes after its
 *   last id in, whatever order an org would answer them in (`IdSpoolWriter`);
 * - a manifest beside them: the source org, the setup it was drawn for, when
 *   and by what, the SHA-256 of each file and of the whole, and what the
 *   sample drew (`WholeOrgSample` without its place on disk);
 * - written into a folder of its own and put in its place whole, never left
 *   half written; read back, a file whose SHA-256 or count is not the
 *   manifest's is a plan changed since, refused (`changed`), and one not
 *   there, refused (`gone`).
 *
 * The SHA-256 of a plan is of its ids alone: two draws that keep the same
 * ids have the same, whenever they were drawn.
 *
 * A plan holds the ids of a production's records: its folder is its owner's
 * alone (0700) and its files too (0600), where the platform keeps such
 * modes. A dry run's plan lives in `forge-samples/<fingerprint>/` under the
 * storage folder, and goes after a day or when a run takes it up, moved
 * beside the run's journal (`forge-runs/<journal>.sample/`), with which it
 * lives and goes.
 */

import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, readFile, readdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import * as z from 'zod';
import {
  forgeSampleDrawSchema,
  forgeSampleParentsSchema,
  type WholeOrgSample,
} from '@sandforge/shared';
import { CHECKPOINT_FILE_MODE, makePrivateDir } from '../../checkpoint/OrgCheckpointStore.js';
import { IdSpool, IdSpoolWriter, idsFileOf } from '../../checkpoint/spooledRunRecords.js';

/** The first fifteen characters of an id: the key the org knows a record by, whichever length it is written in. */
const KEY_LENGTH = 15;

/** The key of `id`: its first fifteen characters. */
export function idKey(id: string): string {
  return id.slice(0, KEY_LENGTH);
}

/**
 * How two ids of one object stand, by their keys, character by character:
 * the order of a plan's ids on disk, which a run reads its plan in and
 * resumes after its last id in. An org writes an id's characters from
 * `0-9A-Za-z`, in that order, so of two keys of one object the later one is
 * the greater — as `ORDER BY Id` puts them.
 */
export function compareIds(a: string, b: string): number {
  const [left, right] = [idKey(a), idKey(b)];
  return left < right ? -1 : left > right ? 1 : 0;
}

/** How long a dry run's plan is taken up by the run after it, and kept. */
export const SAMPLE_PLAN_MAX_AGE_MS = 24 * 60 * 60_000;

/** The folder of dry runs' plans under the storage folder. */
const SAMPLES_DIR = 'forge-samples';

/** The folder of runs' journals under the storage folder, which a run's plan goes beside. */
const RUNS_DIR = 'forge-runs';

/** The manifest of a plan, in its folder. */
const MANIFEST = 'sample.json';

/** Who sets out to act on a plan's records, as a refusal of its ids names it. */
const ACT = 'the run of this sample';

/** A record id, 15 or 18 letters and digits. */
const RECORD_ID = /^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/;

/** What a dry run's folder is named by: a run's fingerprint, letters, digits, `_` and `-`. */
const FOLDER_NAME = /^[A-Za-z0-9_-]{1,128}$/;

/** What a sample drew, as its plan keeps it: the report but for its place on disk. */
export type WholeOrgSampleDrawn = Omit<WholeOrgSample, 'plan'>;

/** What a plan says of itself beside its ids. */
export interface SamplePlanManifest {
  version: 1;
  /** The org the ids are of. */
  sourceOrgId: string;
  /** The fingerprint of the setup it was drawn for (`forgeRunFingerprint`). */
  fingerprint: string;
  /** When it was drawn, an ISO date. */
  drawnAt: string;
  /** Drawn by a run, or by a dry run a run may take up. */
  drawnBy: 'run' | 'dryRun';
  /** The SHA-256 of its ids: of each object's, in the order of their names. */
  sha256: string;
  /** Each object it holds ids of, how many, and the SHA-256 of their file. */
  objects: Array<{ objectApiName: string; count: number; sha256: string }>;
  /** What the sample drew. */
  sample: WholeOrgSampleDrawn;
  /**
   * Of a draw of the newest roots, the objects whose newest were read in the
   * order of their ids, which have no creation date the org orders by
   * (`RecentDraw`): an object's ids follow the making of its records within
   * a load, not from one load to the next. Absent when there are none.
   */
  newestByIds?: string[];
}

/** A plan to keep: see {@link keepSamplePlan}. */
export interface SamplePlanToKeep {
  sourceOrgId: string;
  fingerprint: string;
  drawnAt: Date;
  drawnBy: 'run' | 'dryRun';
  sample: WholeOrgSampleDrawn;
  /** See {@link SamplePlanManifest.newestByIds}. */
  newestByIds?: readonly string[];
  /** The ids kept of each object, in any order; an object of none is left out. */
  ids: ReadonlyArray<{ objectApiName: string; ids: Iterable<string> }>;
}

/** Why a plan cannot be read as the one asked for. */
export type SamplePlanRefusal =
  /** Not on this machine: removed, or never written whole. */
  | 'gone'
  /** Its ids or its manifest are no longer as they were written. */
  | 'changed'
  /** Drawn of another org than the one read. */
  | 'otherOrg'
  /** Drawn for another setup of the run. */
  | 'otherSetup'
  /** Not the plan of the SHA-256 asked for: a run's journal names its own. */
  | 'otherSha';

/** A plan refused: see {@link SamplePlanRefusal}. */
export class SamplePlanError extends Error {
  constructor(
    readonly refusal: SamplePlanRefusal,
    message: string,
  ) {
    super(message);
    this.name = 'SamplePlanError';
  }
}

// ─── Where plans are ─────────────────────────────────────────────────────────

/** The folder of dry runs' plans under `storagePath`. */
export function samplesDirOf(storagePath: string): string {
  return join(storagePath, SAMPLES_DIR);
}

/**
 * The folder of the plan a dry run drew for the setup `fingerprint`: one per
 * setup, the last drawn.
 *
 * @throws {SamplePlanError} `otherSetup`, for a fingerprint that is no name
 *   of a folder: it is about to become a path.
 */
export function dryRunPlanDirOf(storagePath: string, fingerprint: string): string {
  if (!FOLDER_NAME.test(fingerprint)) {
    throw new SamplePlanError('otherSetup', 'Not the fingerprint of a setup of a run.');
  }
  return join(samplesDirOf(storagePath), fingerprint);
}

/**
 * The folder of a run's plan, beside its journal (`forge-runs/<journal>.ndjson`),
 * its name made of the journal's id as the journal's file is.
 */
export function runPlanDirOf(storagePath: string, journalId: string): string {
  return join(storagePath, RUNS_DIR, `${journalId.replace(/[^A-Za-z0-9_-]/g, '_')}.sample`);
}

// ─── Schemas ─────────────────────────────────────────────────────────────────

const objectNameSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9_]*$/);
const countSchema = z.number().int().nonnegative();

const sampleSchema = z.object({
  seed: z.number().int().min(0),
  draw: forgeSampleDrawSchema,
  floor: countSchema,
  parents: forgeSampleParentsSchema,
  children: z.union([z.literal('all'), z.number().int().min(1)]),
  share: z.number().min(0).max(1),
  budget: z.object({
    bytes: z.number().nonnegative(),
    remainingMB: z.number().optional(),
    maxMB: z.number().optional(),
    share: z.number().optional(),
    roundingMB: z.number().optional(),
    automationMB: z.number().optional(),
    withinMB: z.number().optional(),
    maxTotal: z.number().optional(),
    limitedBy: z.enum([
      'storage',
      'within',
      'maxTotal',
      'targetRequests',
      'bulkBatches',
      'sourceRequests',
      'whole',
    ]),
  }),
  rows: countSchema,
  storageBytes: z.number().nonnegative(),
  objects: z.array(
    z.object({
      objectApiName: objectNameSchema,
      sourceRows: countSchema,
      kept: countSchema,
      roots: countSchema,
      below: countSchema,
      asParents: countSchema,
      whole: z.literal(true).optional(),
      childrenCut: z.array(z.object({ field: z.string(), rows: countSchema })).optional(),
    }),
  ),
  whole: z.array(
    z.object({
      objectApiName: objectNameSchema,
      why: z.enum(['referenceData', 'catalog', 'smallParent', 'asked']),
    }),
  ),
  heavyRoots: z.array(
    z.object({
      objectApiName: objectNameSchema,
      id: z.string().regex(RECORD_ID),
      rows: countSchema,
      relation: z.object({ objectApiName: objectNameSchema, field: z.string() }),
    }),
  ),
  dropped: z.array(
    z.object({
      objectApiName: objectNameSchema,
      rows: countSchema,
      reason: z.enum([
        'noParentInSource',
        'outsideFilter',
        'excludedObject',
        'withoutParent',
        'heldBack',
        'recordTypeNotInTarget',
      ]),
    }),
  ),
  leftEmpty: z.array(
    z.object({ objectApiName: objectNameSchema, field: z.string(), rows: countSchema }),
  ),
  noRecordDrawn: z.array(z.object({ objectApiName: objectNameSchema, sourceRows: countSchema })),
  planRequests: z.object({ source: countSchema }),
}) satisfies z.ZodType<WholeOrgSampleDrawn>;

const manifestSchema = z.object({
  version: z.literal(1),
  sourceOrgId: z.string().min(1),
  fingerprint: z.string().regex(FOLDER_NAME),
  drawnAt: z.iso.datetime(),
  drawnBy: z.enum(['run', 'dryRun']),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  objects: z.array(
    z.object({
      objectApiName: objectNameSchema,
      count: z.number().int().positive(),
      sha256: z.string().regex(/^[0-9a-f]{64}$/),
    }),
  ),
  sample: sampleSchema,
  newestByIds: z.array(objectNameSchema).optional(),
}) satisfies z.ZodType<SamplePlanManifest>;

// ─── Files ───────────────────────────────────────────────────────────────────

/** The SHA-256 of a file, read a chunk at a time. */
async function sha256Of(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

/** The SHA-256 of a plan's ids, from each object's: the same ids, the same, in any order given. */
function planShaOf(objects: SamplePlanManifest['objects']): string {
  const hash = createHash('sha256');
  const named = [...objects].sort((a, b) =>
    a.objectApiName < b.objectApiName ? -1 : a.objectApiName > b.objectApiName ? 1 : 0,
  );
  for (const { objectApiName, count, sha256 } of named) {
    hash.update(`${objectApiName}\t${count}\t${sha256}\n`);
  }
  return hash.digest('hex');
}

/** Write `content` to `file`, which is not there yet: flushed, its owner's alone. */
async function writeNew(file: string, content: string): Promise<void> {
  const handle = await open(file, 'wx', CHECKPOINT_FILE_MODE);
  try {
    await handle.writeFile(content, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Whether `error` says a file or folder is not there. */
function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

// ─── A plan ──────────────────────────────────────────────────────────────────

/** A plan as its folder holds it, read back whole: see the module's comment. */
export class SamplePlan {
  private constructor(
    readonly dir: string,
    readonly manifest: SamplePlanManifest,
    private readonly spool: IdSpool,
  ) {}

  /** The SHA-256 of its ids. */
  get sha256(): string {
    return this.manifest.sha256;
  }

  /** The ids it holds of every object. */
  get count(): number {
    return this.spool.count;
  }

  /** The ids it holds of `objectApiName`; 0 of one it holds none of. */
  countOf(objectApiName: string): number {
    return this.manifest.objects.find((o) => o.objectApiName === objectApiName)?.count ?? 0;
  }

  /** How long ago it was drawn, against `now`. */
  ageMs(now: Date): number {
    return now.getTime() - Date.parse(this.manifest.drawnAt);
  }

  /** Its place on disk, as the report of the sample says it. */
  get place(): WholeOrgSample['plan'] {
    return {
      path: this.dir,
      sha256: this.manifest.sha256,
      drawnAt: this.manifest.drawnAt,
      drawnBy: this.manifest.drawnBy,
    };
  }

  /**
   * The ids of `objectApiName`, `size` at a time, in their order on disk;
   * given `after`, those after it alone — where a run resumes after the last
   * id it wrote, whether or not that id is one of the plan's.
   *
   * @throws {CheckpointStoreError} `damaged`, when the file no longer holds
   *   what the manifest says.
   */
  async *ids(
    objectApiName: string,
    options: { after?: string; size?: number } = {},
  ): AsyncGenerator<string[]> {
    const size = Math.max(1, Math.floor(options.size ?? 2_000));
    const after = options.after;
    let page: string[] = [];
    for await (const read of this.spool.pages(objectApiName, size)) {
      for (const id of read) {
        if (after !== undefined && compareIds(id, after) <= 0) continue;
        page.push(id);
        if (page.length >= size) {
          yield page;
          page = [];
        }
      }
    }
    if (page.length > 0) yield page;
  }

  /**
   * The plan in `dir`, read back whole, and held to what is asked of it.
   *
   * @throws {SamplePlanError} `gone` when it is not there; `changed` when its
   *   manifest does not read as one, or a file of its ids is not as the
   *   manifest says; `otherOrg`, `otherSetup` or `otherSha` when it was drawn
   *   of another org, for another setup, or is another plan than the one
   *   asked for.
   */
  static async open(
    dir: string,
    expected: { sourceOrgId?: string; fingerprint?: string; sha256?: string } = {},
  ): Promise<SamplePlan> {
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(join(dir, MANIFEST), 'utf8'));
    } catch (error: unknown) {
      if (isMissing(error)) {
        throw new SamplePlanError('gone', 'The plan of this sample is no longer on this machine.');
      }
      throw new SamplePlanError('changed', 'The plan of this sample does not read as one.');
    }
    const parsed = manifestSchema.safeParse(raw);
    if (!parsed.success) {
      throw new SamplePlanError('changed', 'The plan of this sample does not read as one.');
    }
    const manifest = parsed.data;
    let spool: IdSpool;
    try {
      spool = await IdSpool.open(dir, ACT);
    } catch {
      throw new SamplePlanError('changed', 'The ids of this sample are not as they were written.');
    }
    await SamplePlan.holdToManifest(dir, manifest, spool);
    if (expected.sourceOrgId !== undefined && expected.sourceOrgId !== manifest.sourceOrgId) {
      throw new SamplePlanError('otherOrg', 'This plan was drawn of another org.');
    }
    if (expected.fingerprint !== undefined && expected.fingerprint !== manifest.fingerprint) {
      throw new SamplePlanError('otherSetup', 'This plan was drawn for another setup of the run.');
    }
    if (expected.sha256 !== undefined && expected.sha256 !== manifest.sha256) {
      throw new SamplePlanError('otherSha', 'This is not the plan the run was drawn with.');
    }
    return new SamplePlan(dir, manifest, spool);
  }

  /**
   * Hold the files of the plan in `dir` to its manifest: the objects its
   * spool lists and their counts, each file's SHA-256, and the plan's.
   *
   * @throws {SamplePlanError} `changed`, at the first that is not as written.
   */
  private static async holdToManifest(
    dir: string,
    manifest: SamplePlanManifest,
    spool: IdSpool,
  ): Promise<void> {
    const changed = (): SamplePlanError =>
      new SamplePlanError('changed', 'The ids of this sample are not as they were written.');
    const listed = spool.objects.filter((object) => object.count > 0);
    if (listed.length !== manifest.objects.length) throw changed();
    for (const object of manifest.objects) {
      const held = listed.find((o) => o.objectApiName === object.objectApiName);
      if (!held || held.count !== object.count) throw changed();
      let sha: string;
      try {
        sha = await sha256Of(idsFileOf(dir, object.objectApiName));
      } catch {
        throw changed();
      }
      if (sha !== object.sha256) throw changed();
    }
    if (planShaOf(manifest.objects) !== manifest.sha256) throw changed();
  }

  /** Keep a plan: see {@link keepSamplePlan}. */
  static async keep(dir: string, plan: SamplePlanToKeep): Promise<SamplePlan> {
    const temp = `${dir}.${process.pid}-${randomBytes(4).toString('hex')}.tmp`;
    try {
      await makePrivateDir(temp);
      const writer = new IdSpoolWriter(temp, ACT);
      for (const { objectApiName, ids } of plan.ids) {
        const sorted = [...ids].sort(compareIds);
        for (const id of sorted) await writer.add(objectApiName, id);
      }
      const spool = await writer.finish();
      const objects: SamplePlanManifest['objects'] = [];
      for (const { objectApiName, count } of spool.objects) {
        if (count === 0) continue;
        objects.push({
          objectApiName,
          count,
          sha256: await sha256Of(idsFileOf(temp, objectApiName)),
        });
      }
      const manifest: SamplePlanManifest = {
        version: 1,
        sourceOrgId: plan.sourceOrgId,
        fingerprint: plan.fingerprint,
        drawnAt: plan.drawnAt.toISOString(),
        drawnBy: plan.drawnBy,
        sha256: planShaOf(objects),
        objects,
        sample: plan.sample,
        ...(plan.newestByIds !== undefined && plan.newestByIds.length > 0
          ? { newestByIds: [...plan.newestByIds] }
          : {}),
      };
      manifestSchema.parse(manifest);
      await writeNew(join(temp, MANIFEST), `${JSON.stringify(manifest)}\n`);
      await rm(dir, { recursive: true, force: true });
      await rename(temp, dir);
    } catch (error: unknown) {
      await rm(temp, { recursive: true, force: true });
      throw error;
    }
    return SamplePlan.open(dir);
  }
}

/**
 * Keep `plan` in `dir`, in place of what it held: written into a folder of
 * its own beside it, then put in its place whole. Its ids sorted by
 * {@link compareIds}, each once.
 *
 * @returns The plan, read back from the disk.
 */
export function keepSamplePlan(dir: string, plan: SamplePlanToKeep): Promise<SamplePlan> {
  return SamplePlan.keep(dir, plan);
}

/**
 * The plan of the last dry run of the setup `fingerprint`, which the run
 * after it takes up while it is less than a day old: `tooOld` past that,
 * undefined when there is none, or none that reads whole.
 */
export async function lastDryRunPlan(
  storagePath: string,
  fingerprint: string,
  now: Date,
): Promise<SamplePlan | 'tooOld' | undefined> {
  let plan: SamplePlan;
  try {
    plan = await SamplePlan.open(dryRunPlanDirOf(storagePath, fingerprint), { fingerprint });
  } catch (error: unknown) {
    if (error instanceof SamplePlanError) return undefined;
    throw error;
  }
  return plan.ageMs(now) >= SAMPLE_PLAN_MAX_AGE_MS ? 'tooOld' : plan;
}

/**
 * Move a dry run's plan beside the journal of the run that takes it up,
 * before it writes: it lives and goes with the journal from then on, and no
 * other run takes it up.
 *
 * @returns The plan, read back from its new place, held to its SHA-256.
 */
export async function adoptSamplePlan(
  plan: SamplePlan,
  storagePath: string,
  journalId: string,
): Promise<SamplePlan> {
  const dir = runPlanDirOf(storagePath, journalId);
  await makePrivateDir(join(storagePath, RUNS_DIR));
  await rm(dir, { recursive: true, force: true });
  await rename(plan.dir, dir);
  return SamplePlan.open(dir, { sha256: plan.sha256 });
}

/** Remove a plan and its folder: one a run is done with, or a dry run's no run will take up. */
export async function removeSamplePlan(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

/**
 * Remove the dry runs' plans drawn a day or more before `now`, and the
 * folders a keep left half written as long ago: their ids are a
 * production's, kept no longer than a run may take them up.
 *
 * @returns How many folders were removed.
 */
export async function sweepSamplePlans(storagePath: string, now: Date): Promise<number> {
  const root = samplesDirOf(storagePath);
  let names: string[];
  try {
    names = await readdir(root);
  } catch (error: unknown) {
    if (isMissing(error)) return 0;
    throw error;
  }
  let removed = 0;
  for (const name of names) {
    const dir = join(root, name);
    let drawnAt: number;
    try {
      const manifest = manifestSchema.parse(
        JSON.parse(await readFile(join(dir, MANIFEST), 'utf8')),
      );
      drawnAt = Date.parse(manifest.drawnAt);
    } catch {
      // Half written, or no longer read as a plan: by when it was last written.
      drawnAt = (await stat(dir)).mtimeMs;
    }
    if (now.getTime() - drawnAt < SAMPLE_PLAN_MAX_AGE_MS) continue;
    await rm(dir, { recursive: true, force: true });
    removed++;
  }
  return removed;
}
