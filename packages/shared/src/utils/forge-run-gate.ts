import * as z from 'zod';
import type { ForgeSampleDraw, WholeOrgSampleLimit } from '../types/forge.types.js';

/**
 * Why a Forge run stopped at its gate — the checks between Execute and the
 * first record the run writes — with nothing written.
 *
 * The extension answers such a run's `forge:execute` with an error carrying
 * one of these codes, and the page says why and goes back to Review rather
 * than showing a run that failed: nothing failed, and nothing was written.
 *
 * - `PRODUCTION_TARGET`: the target is a production org, or one SandForge
 *   cannot tell is a sandbox. Refused before anything is read.
 * - `AUTOMATION_DECLINED`: cancelled at the confirmation of what the target
 *   runs as the run inserts its records. Nothing was read.
 * - `READ_DECLINED`: cancelled at the confirmation of the source tables the
 *   run reads with no cap past the most rows of one object it holds at once.
 *   Nothing was read.
 * - `WRITE_DECLINED`: cancelled at the confirmation of what the run was about
 *   to write, once it had read it.
 * - `STORAGE_EXCEEDED`: the rows to write take more data storage than the
 *   target has left, or the files a clone of the whole org copies more file
 *   storage — the stop's `storage.kind` says which.
 * - `CONFIRMATION_UNAVAILABLE`: a confirmation was needed, and there was no
 *   one to ask.
 * - `CHECKPOINT_REFUSED`: the checkpoint the run was asked to take of what it
 *   writes before its first write (Checkpoint first) was refused, at its
 *   scope or at its take — the stop's `reason` says by what —, or could not
 *   be taken. The mute assigned nothing.
 * - `API_BUDGET_EXCEEDED`: the rows, and the checkpoint taken first, take
 *   more API requests than the target has left today; a clone of the whole
 *   org, besides, more than the source has left, or more Bulk API batches
 *   than the target has left — the stop's `api` says which. Refused, not
 *   cancelled.
 * - `READ_BOUND_EXCEEDED`: a clone of the whole org reads a few objects whole
 *   — the price catalog, reference data — and one of them holds more rows
 *   than `sandforge.forge.maxRecordsPerObject` lets a run hold at once.
 *   Refused before anything was written, rather than cut short: the setting
 *   bounds the memory, and nobody declined anything.
 * - `FILES_UNREAD`: a clone of the whole org asked to copy files, and the
 *   source would neither sum nor list them: what they take of the target's
 *   file storage is not known. Of any other run, its file copier could not
 *   look up all the files of the records it read.
 * - `FILE_STORAGE_UNREAD`: the same, the target not saying what file storage
 *   it has left.
 * - `FILE_STORAGE_EXCEEDED`: of a run that clones no whole org, the files its
 *   file copier would copy take more file storage than the target has left,
 *   as the stop's `storage` says, `kind: 'files'`. A clone of the whole org
 *   is refused so at its gate under `STORAGE_EXCEEDED`.
 *
 * A sample of the whole org (`ForgeConfig.sample`) is refused, nothing
 * written, under seven codes of its own; and under `STORAGE_EXCEEDED` when
 * the target has less room than the sample was fitted to, the stop's
 * `sample` saying how much: drawn again, it would fit, cut, it would not be
 * the sample simulated.
 *
 * - `SAMPLE_STORAGE_UNREAD`: the target would not say what data storage it
 *   has left, and no other bound — the MB or the records asked — holds the
 *   sample: there is nothing to fit it to.
 * - `SAMPLE_CANNOT_FIT`: the objects copied whole and the roots kept of each
 *   object alone take more than the sample may: no share of the rest fits.
 * - `SAMPLE_TOO_LARGE`: drawing the sample read more records than it holds
 *   at once, a bound on the memory.
 * - `SAMPLE_PLAN_MISMATCH`: the plan a run was given to replay was drawn of
 *   another org or for another setup, or is no longer as it was written.
 * - `SAMPLE_PLAN_GONE`: the plan a run resumes, or was given, is not on this
 *   machine, or not as it was written: its records cannot be taken up.
 * - `SAMPLE_DRAW_INVALID`: the roots it was asked to draw among cannot be
 *   drawn so — an object or a field the run does not have, a stratum field
 *   that is no picklist, checkbox or lookup, or has more values than a
 *   stratum is counted by, a filter on the roots the source refused, more
 *   semi-joins than a statement takes, a filter on an object copied whole or
 *   with no root. Refused before a record is read past the counts.
 * - `SAMPLE_DRAW_EMPTY`: no object has a root in the window, the filters on
 *   the roots and the strata asked: there is nothing to draw.
 *
 * A clone from the records a query chooses (`queryScope: 'records'`) is
 * refused, nothing written, under five codes of its own, and under
 * `READ_BOUND_EXCEEDED` and `API_BUDGET_EXCEEDED` when what its roots reach
 * reads more records, or more requests of the source, than it may — the
 * stop's `readBound.of` and `api.reading` say so.
 *
 * - `ROOTS_QUERY_REFUSED`: its query cannot choose records — a clause that
 *   changes the rows it returns, an alias nothing traces, a WHERE, ORDER BY
 *   or LIMIT past the rules. Nothing was read.
 * - `NO_ROOTS`: its query chooses no record of the source.
 * - `ROOTS_EXCEEDED`: its query chooses more records than the run takes
 *   (`maxRoots`), and gives no LIMIT that holds it: refused before any other
 *   read, rather than cut at an order nobody chose.
 * - `ROOTS_PLAN_MISMATCH`: the records a dry run chose, which the run was
 *   given, were read of another org or by another query, or changed since.
 * - `ROOTS_PLAN_GONE`: the records a run resumes are not in its journal: it
 *   cannot take them up without reading the query again, which may choose
 *   others.
 */
/**
 * The rows of one object past which a run reading it with no cap asks first
 * (`READ_DECLINED` when the user declines): said in the question and in the
 * notice from this one number.
 */
export const FORGE_READ_CEILING_PER_OBJECT = 50_000;

/**
 * The most `sandforge.forge.maxRecordsPerObject` — the clone command's
 * `--max-records-per-object` — may set: a run from a record holds every row
 * it reads, and past this one object of it would not fit in the memory of an
 * extension host.
 */
export const FORGE_MAX_RECORDS_PER_OBJECT_BOUND = 1_000_000;

/**
 * The records a clone from a query takes as its roots unless told otherwise
 * (`ForgeConfig.maxRoots`, `--max-roots`): the 200 the SOQL tab capped each
 * object at before a query chose records.
 */
export const FORGE_ROOTS_DEFAULT = 200;

/**
 * The most roots a clone from a query or from records named takes, whatever
 * it is told: the ids it keeps of them fit the 2 000 its journal keeps of a
 * run, and a clone from records holds every row it reads, unpaged. Each
 * lookup to that many is read in about five statements, a statement's URI
 * holding some 459 ids beside an Account's hundred fields. Past it, a sample
 * of the whole org with a filter on its roots.
 */
export const FORGE_ROOTS_MAX = 2_000;

/**
 * The most records a clone from many roots reads in all before it writes —
 * a clone from records reads everything before its first write and holds it:
 * past it, refused (`READ_BOUND_EXCEEDED`, `readBound.of: 'roots'`), nothing
 * written. The command line may lower it (`--max-read-total`); a clone of one
 * record is not held to it.
 */
export const FORGE_ROOTS_READ_TOTAL = 50_000;

export const FORGE_RUN_GATE_CODES = [
  'PRODUCTION_TARGET',
  'AUTOMATION_DECLINED',
  'READ_DECLINED',
  'WRITE_DECLINED',
  'STORAGE_EXCEEDED',
  'CONFIRMATION_UNAVAILABLE',
  'CHECKPOINT_REFUSED',
  'API_BUDGET_EXCEEDED',
  'READ_BOUND_EXCEEDED',
  'FILES_UNREAD',
  'FILE_STORAGE_UNREAD',
  'FILE_STORAGE_EXCEEDED',
  'SAMPLE_STORAGE_UNREAD',
  'SAMPLE_CANNOT_FIT',
  'SAMPLE_TOO_LARGE',
  'SAMPLE_PLAN_MISMATCH',
  'SAMPLE_PLAN_GONE',
  'SAMPLE_DRAW_INVALID',
  'SAMPLE_DRAW_EMPTY',
  'ROOTS_QUERY_REFUSED',
  'NO_ROOTS',
  'ROOTS_EXCEEDED',
  'ROOTS_PLAN_MISMATCH',
  'ROOTS_PLAN_GONE',
] as const;

/** A way a Forge run stops at its gate. */
export type ForgeRunGateCode = (typeof FORGE_RUN_GATE_CODES)[number];

/** What the error of a run stopped at its gate says of the stop, beside its code. */
export interface ForgeRunGateStop {
  code: ForgeRunGateCode;
  /**
   * For a run refused for its storage: what its rows or its files take, and
   * what the target had left, in MB. What is left can be below zero: an org
   * over its allocation says so. `kind` says which storage: the data storage
   * when it is absent, as every refusal before files were weighed was.
   */
  storage?: { estimateMB: number; remainingMB: number; kind?: 'data' | 'files' };
  /**
   * For a run cancelled at the confirmation of the tables it reads past the
   * most rows of one object it is set to read: that number, as the run held
   * it (`sandforge.forge.maxRecordsPerObject`).
   */
  ceiling?: number;
  /**
   * For a run refused for the checkpoint it was to take first: the take's
   * own refusal, by its code (a `CheckpointRefusalCode`: `DISK`,
   * `RUN_WRITING`, `NOTHING_HELD`, `TOO_MANY_RECORDS`…), which the page words
   * where it said only that the checkpoint was refused. Absent for a take
   * that failed rather than refused, and for any other stop.
   */
  reason?: string;
  /**
   * For a clone of the whole org refused for an API budget: which allowance
   * — the org's daily API requests, or the target's daily Bulk API batches —
   * of which org, what the run would take of it and what is left of it today.
   */
  api?: {
    kind: 'requests' | 'bulkBatches';
    org: 'source' | 'target';
    estimate: number;
    remaining: number;
    /**
     * Of a sample refused as its plan was drawn: the share of `remaining`
     * the drawing may read (a tenth), past which it stopped, and how it drew.
     * Absent, the run was refused past all that is left. The newest or the
     * oldest roots first read fewer requests than roots spread over the org.
     * `restricted` says the draw was held to a window or filters on its
     * roots: narrowing them is a way out. Strata alone keep every root in
     * the draw, and leave it unset.
     */
    drawing?: { share: number; draw: ForgeSampleDraw; restricted?: boolean };
    /**
     * Of a clone from the records a query chose, refused as it read what they
     * reach: the requests the read may send the source — a tenth of what it
     * has left today, or 2 000 when it would not say —, which `estimate`, the
     * requests sent and those of the next object's statements, passed.
     * Nothing was written.
     */
    reading?: { bound: number };
  };
  /**
   * For a clone of the whole org refused for an object it reads whole: the
   * most rows of one object it may hold (`sandforge.forge.maxRecordsPerObject`),
   * and each object past it with its rows. With `of: 'roots'`, of a clone from
   * the records a query chose: the most records it may read in all
   * (`FORGE_ROOTS_READ_TOTAL`, or `--max-read-total`), and the objects it had
   * read when it went past, with their rows.
   */
  readBound?: {
    bound: number;
    objects: Array<{ objectApiName: string; rows: number }>;
    of?: 'roots';
  };
  /**
   * For a clone from the records a query chooses refused for them — its
   * query refused, choosing none, more than it takes, or a plan of them
   * refused: the object the query chooses from, the most it takes
   * (`maxRoots`), the records the query chooses when they were counted, and
   * what is wrong with the plan. What the query was refused for is said in
   * the error's message.
   */
  roots?: {
    objectApiName: string;
    cap?: number;
    total?: number;
    plan?: RootsGatePlanRefusal;
  };
  /**
   * For a sample of the whole org stopped at its gate, what the page names of
   * the stop:
   * - of one that cannot fit (`SAMPLE_CANNOT_FIT`), what the objects copied
   *   whole and the roots kept of each object take, the most the sample may
   *   take, in MB, and the heaviest objects by name; and what held it
   *   (`limitedBy`), which the way out depends on: past the data storage the
   *   target has left, no setting lets the sample take more;
   * - of one too large to hold (`SAMPLE_TOO_LARGE`), the records it read and
   *   the most it holds at once;
   * - of a plan refused (`SAMPLE_PLAN_GONE`, `SAMPLE_PLAN_MISMATCH`), what is
   *   wrong with it: not there, changed since, drawn of another org, for
   *   another setup, or another plan than its run's;
   * - of a sample whose target has less room than it was fitted to
   *   (`STORAGE_EXCEEDED`), the MB it was fitted to and the MB the storage
   *   the target has left now holds of a sample;
   * - of a draw refused (`SAMPLE_DRAW_INVALID`, `SAMPLE_DRAW_EMPTY`), the
   *   requests its counts had sent the source: none, of options refused
   *   before any.
   */
  sample?: {
    needMB?: number;
    budgetMB?: number;
    heaviest?: string[];
    limitedBy?: WholeOrgSampleLimit;
    rows?: number;
    most?: number;
    plan?: SampleGatePlanRefusal;
    fittedMB?: number;
    holdsMB?: number;
    requests?: number;
  };
}

/** What is wrong with the plan of a sample a run is refused for: see {@link ForgeRunGateStop.sample}. */
export type SampleGatePlanRefusal = 'gone' | 'changed' | 'otherOrg' | 'otherSetup' | 'otherSha';

/**
 * What is wrong with the plan of the roots a run is refused for, see
 * {@link ForgeRunGateStop.roots}: not in the journal of the run it resumes
 * (`gone`), read of another org (`otherOrg`) or by another query
 * (`otherQuery`), or no longer the ids it was written with (`changed`).
 */
export type RootsGatePlanRefusal = 'gone' | 'otherOrg' | 'otherQuery' | 'changed';

/** The codes of a sample's own stops, and the one a sample whose target moved is refused under. */
const SAMPLE_STOP_CODES: ReadonlySet<ForgeRunGateCode> = new Set([
  'SAMPLE_STORAGE_UNREAD',
  'SAMPLE_CANNOT_FIT',
  'SAMPLE_TOO_LARGE',
  'SAMPLE_PLAN_MISMATCH',
  'SAMPLE_PLAN_GONE',
  'SAMPLE_DRAW_INVALID',
  'SAMPLE_DRAW_EMPTY',
  'STORAGE_EXCEEDED',
]);

/** The codes of a clone from a query's own stops, which say what the stop names of its roots. */
const ROOTS_STOP_CODES: ReadonlySet<ForgeRunGateCode> = new Set([
  'ROOTS_QUERY_REFUSED',
  'NO_ROOTS',
  'ROOTS_EXCEEDED',
  'ROOTS_PLAN_MISMATCH',
  'ROOTS_PLAN_GONE',
]);

/** An object's API name, as a stop names one. */
const OBJECT_NAME = /^[A-Za-z][A-Za-z0-9_]{0,79}$/;

/** The heaviest objects a refusal of a sample that cannot fit names, at most, as the page reads them. */
const SAMPLE_HEAVIEST_NAMED = 20;

const stopSchema = z.object({
  code: z.enum(FORGE_RUN_GATE_CODES),
  storage: z
    .object({
      estimateMB: z.number().nonnegative(),
      remainingMB: z.number(),
      kind: z.enum(['data', 'files']).optional(),
    })
    .optional(),
  ceiling: z.number().int().positive().optional(),
  // A refusal's code as the checkpoint's guards spell it: never words.
  reason: z
    .string()
    .regex(/^[A-Z][A-Z_]{0,39}$/)
    .optional(),
  // What is left can be below zero, as an org over its allocation says.
  api: z
    .object({
      kind: z.enum(['requests', 'bulkBatches']),
      org: z.enum(['source', 'target']),
      estimate: z.number().int().nonnegative(),
      remaining: z.number().int(),
      drawing: z
        .object({
          share: z.number().positive().max(1),
          draw: z.enum([
            'uniform',
            'recent',
            'oldest',
          ] as const satisfies readonly ForgeSampleDraw[]),
          restricted: z.boolean().optional(),
        })
        .optional(),
      reading: z.object({ bound: z.number().int().positive() }).optional(),
    })
    .optional(),
  // Bounded as a message is: the page names each object, and a forged one
  // naming thousands would only make the notice unreadable.
  readBound: z
    .object({
      bound: z.number().int().positive(),
      objects: z
        .array(
          z.object({
            objectApiName: z.string().min(1).max(255),
            rows: z.number().int().nonnegative(),
          }),
        )
        .min(1)
        .max(200),
      of: z.literal('roots').optional(),
    })
    .optional(),
  roots: z
    .object({
      objectApiName: z.string().regex(OBJECT_NAME),
      cap: z.number().int().min(1).max(FORGE_ROOTS_MAX).optional(),
      total: z.number().int().nonnegative().optional(),
      plan: z
        .enum([
          'gone',
          'otherOrg',
          'otherQuery',
          'changed',
        ] as const satisfies readonly RootsGatePlanRefusal[])
        .optional(),
    })
    .optional(),
  // Bounded as a message is: sizes and counts never below zero, and the
  // heaviest objects few, each a name.
  sample: z
    .object({
      needMB: z.number().nonnegative().optional(),
      budgetMB: z.number().nonnegative().optional(),
      heaviest: z.array(z.string().min(1).max(255)).max(SAMPLE_HEAVIEST_NAMED).optional(),
      limitedBy: z
        .enum([
          'storage',
          'within',
          'maxTotal',
          'targetRequests',
          'bulkBatches',
          'sourceRequests',
          'heavyRoots',
          'whole',
          'draw',
        ] as const satisfies readonly WholeOrgSampleLimit[])
        .optional(),
      rows: z.number().int().nonnegative().optional(),
      most: z.number().int().nonnegative().optional(),
      plan: z.enum(['gone', 'changed', 'otherOrg', 'otherSetup', 'otherSha']).optional(),
      fittedMB: z.number().nonnegative().optional(),
      holdsMB: z.number().nonnegative().optional(),
      requests: z.number().int().nonnegative().optional(),
    })
    .optional(),
});

/** Whether `value` is one of the codes a run stops at its gate with. */
export function isForgeRunGateCode(value: unknown): value is ForgeRunGateCode {
  return (FORGE_RUN_GATE_CODES as readonly unknown[]).includes(value);
}

/**
 * The gate stop an error's `gate` field carries, read as the untrusted input a
 * message is: null when it carries none, or not one of these.
 */
export function forgeRunGateStopOf(value: unknown): ForgeRunGateStop | null {
  const parsed = stopSchema.safeParse(value);
  if (!parsed.success) return null;
  const { code, storage, ceiling, reason, api, readBound, sample, roots } = parsed.data;
  return {
    code,
    ...(storage
      ? {
          storage: {
            estimateMB: storage.estimateMB,
            remainingMB: storage.remainingMB,
            ...(storage.kind !== undefined ? { kind: storage.kind } : {}),
          },
        }
      : {}),
    ...(ceiling !== undefined ? { ceiling } : {}),
    ...(reason !== undefined && code === 'CHECKPOINT_REFUSED' ? { reason } : {}),
    // Each says something of its own stop only, as the reason does.
    ...(api && code === 'API_BUDGET_EXCEEDED' ? { api } : {}),
    ...(readBound && code === 'READ_BOUND_EXCEEDED' ? { readBound } : {}),
    ...(sample && SAMPLE_STOP_CODES.has(code) ? { sample } : {}),
    ...(roots && ROOTS_STOP_CODES.has(code) ? { roots } : {}),
  };
}
