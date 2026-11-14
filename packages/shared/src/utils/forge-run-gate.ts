import * as z from 'zod';

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
 * written, under five codes of its own; and under `STORAGE_EXCEEDED` when
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
  };
  /**
   * For a clone of the whole org refused for an object it reads whole: the
   * most rows of one object it may hold (`sandforge.forge.maxRecordsPerObject`),
   * and each object past it with its rows.
   */
  readBound?: { bound: number; objects: Array<{ objectApiName: string; rows: number }> };
  /**
   * For a sample of the whole org stopped at its gate, what the page names of
   * the stop:
   * - of one that cannot fit (`SAMPLE_CANNOT_FIT`), what the objects copied
   *   whole and the roots kept of each object take, the most the sample may
   *   take, in MB, and the heaviest objects by name;
   * - of one too large to hold (`SAMPLE_TOO_LARGE`), the records it read and
   *   the most it holds at once;
   * - of a plan refused (`SAMPLE_PLAN_GONE`, `SAMPLE_PLAN_MISMATCH`), what is
   *   wrong with it: not there, changed since, drawn of another org, for
   *   another setup, or another plan than its run's;
   * - of a sample whose target has less room than it was fitted to
   *   (`STORAGE_EXCEEDED`), the MB it was fitted to and the MB the storage
   *   the target has left now holds of a sample.
   */
  sample?: {
    needMB?: number;
    budgetMB?: number;
    heaviest?: string[];
    rows?: number;
    most?: number;
    plan?: SampleGatePlanRefusal;
    fittedMB?: number;
    holdsMB?: number;
  };
}

/** What is wrong with the plan of a sample a run is refused for: see {@link ForgeRunGateStop.sample}. */
export type SampleGatePlanRefusal = 'gone' | 'changed' | 'otherOrg' | 'otherSetup' | 'otherSha';

/** The codes of a sample's own stops, and the one a sample whose target moved is refused under. */
const SAMPLE_STOP_CODES: ReadonlySet<ForgeRunGateCode> = new Set([
  'SAMPLE_STORAGE_UNREAD',
  'SAMPLE_CANNOT_FIT',
  'SAMPLE_TOO_LARGE',
  'SAMPLE_PLAN_MISMATCH',
  'SAMPLE_PLAN_GONE',
  'STORAGE_EXCEEDED',
]);

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
    })
    .optional(),
  // Bounded as a message is: sizes and counts never below zero, and the
  // heaviest objects few, each a name.
  sample: z
    .object({
      needMB: z.number().nonnegative().optional(),
      budgetMB: z.number().nonnegative().optional(),
      heaviest: z.array(z.string().min(1).max(255)).max(SAMPLE_HEAVIEST_NAMED).optional(),
      rows: z.number().int().nonnegative().optional(),
      most: z.number().int().nonnegative().optional(),
      plan: z.enum(['gone', 'changed', 'otherOrg', 'otherSetup', 'otherSha']).optional(),
      fittedMB: z.number().nonnegative().optional(),
      holdsMB: z.number().nonnegative().optional(),
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
  const { code, storage, ceiling, reason, api, readBound, sample } = parsed.data;
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
  };
}
