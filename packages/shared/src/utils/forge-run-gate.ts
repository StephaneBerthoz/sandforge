import { z } from 'zod';

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
 */
/**
 * The rows of one object past which a run reading it with no cap asks first
 * (`READ_DECLINED` when the user declines): said in the question and in the
 * notice from this one number.
 */
export const FORGE_READ_CEILING_PER_OBJECT = 50_000;

export const FORGE_RUN_GATE_CODES = [
  'PRODUCTION_TARGET',
  'AUTOMATION_DECLINED',
  'READ_DECLINED',
  'WRITE_DECLINED',
  'STORAGE_EXCEEDED',
  'CONFIRMATION_UNAVAILABLE',
] as const;

/** A way a Forge run stops at its gate. */
export type ForgeRunGateCode = (typeof FORGE_RUN_GATE_CODES)[number];

/** What the error of a run stopped at its gate says of the stop, beside its code. */
export interface ForgeRunGateStop {
  code: ForgeRunGateCode;
  /**
   * For a run refused for its storage: what its rows take, and what the
   * target had left, in MB. What is left can be below zero: an org over its
   * allocation says so.
   */
  storage?: { estimateMB: number; remainingMB: number };
}

const stopSchema = z.object({
  code: z.enum(FORGE_RUN_GATE_CODES),
  storage: z.object({ estimateMB: z.number().nonnegative(), remainingMB: z.number() }).optional(),
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
  const { code, storage } = parsed.data;
  return storage ? { code, storage } : { code };
}
