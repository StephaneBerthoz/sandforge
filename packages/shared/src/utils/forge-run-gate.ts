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
 *   target has left.
 * - `CONFIRMATION_UNAVAILABLE`: a confirmation was needed, and there was no
 *   one to ask.
 * - `API_BUDGET_EXCEEDED`: the run would take more API requests than an org
 *   has left today — the target's or the source's — or more Bulk API batches
 *   than the target has left. Refused, not cancelled.
 * - `READ_BOUND_EXCEEDED`: a clone of the whole org reads a few objects whole
 *   — the price catalog, reference data — and one of them holds more rows
 *   than `sandforge.forge.maxRecordsPerObject` lets a run hold at once.
 *   Refused before anything was written, rather than cut short: the setting
 *   bounds the memory, and nobody declined anything.
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
  'API_BUDGET_EXCEEDED',
  'READ_BOUND_EXCEEDED',
] as const;

/** A way a Forge run stops at its gate. */
export type ForgeRunGateCode = (typeof FORGE_RUN_GATE_CODES)[number];

/** What the error of a run stopped at its gate says of the stop, beside its code. */
export interface ForgeRunGateStop {
  code: ForgeRunGateCode;
  /**
   * For a run refused for its storage: what its rows take, and what the
   * target had left, in MB. What is left can be below zero: an org over its
   * allocation says so. `kind` says which storage: the data storage when it
   * is absent, as every refusal before files were weighed was.
   */
  storage?: { estimateMB: number; remainingMB: number; kind?: 'data' | 'files' };
  /**
   * For a run cancelled at the confirmation of the tables it reads past the
   * most rows of one object it is set to read: that number, as the run held
   * it (`sandforge.forge.maxRecordsPerObject`).
   */
  ceiling?: number;
  /**
   * For a run refused for its API budget: which allowance — the org's daily
   * API requests, or the target's daily Bulk API batches — of which org, what
   * the run would take of it and what is left of it today.
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
}

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
  const { code, storage, ceiling, api, readBound } = parsed.data;
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
    ...(api ? { api } : {}),
    ...(readBound ? { readBound } : {}),
  };
}
