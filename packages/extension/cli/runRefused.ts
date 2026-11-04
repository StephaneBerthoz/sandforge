/**
 * How a command says its gate refused a run before its first write, for a
 * refusal that has a code: Sync's way, the one every run shares. A CI job
 * reads the code in the line and, with `--json`, in the summary on stdout: a
 * clone or a seed refused for its emails said a sentence on stderr, no code,
 * and left stdout empty.
 */

import { z } from 'zod';

/** A refusal with its code, as a run's gate gives it. */
export interface RunRefusal {
  code: string;
  message: string;
}

/** The line a refused run ends on. */
export function refusedLine({ code, message }: RunRefusal): string {
  return `refused (${code}): ${message}`;
}

/**
 * The line a dry run says a refusal a real run would meet on, its code named
 * as the real run's line names it, as a rewind's dry run says its own: the
 * sentence alone, a pipeline could not tell one refusal from another.
 *
 * @param run - What would be refused, as the command says it: `a real run`, `a load`.
 */
export function wouldBeRefusedLine({ code, message }: RunRefusal, run = 'a real run'): string {
  return `${run} would be refused (${code}): ${message}`;
}

/**
 * What a dry run's `--json` gives of the refusals a real run would meet: their
 * words under `wouldBeRefused`, the shape scripts read, and beside them, in
 * the same order, the code a real run is refused with for each. Nothing when
 * a real run would go.
 */
export function wouldBeRefusedJson(refusals: readonly RunRefusal[]): {
  wouldBeRefused?: string[];
  wouldBeRefusedCodes?: string[];
} {
  return refusals.length > 0
    ? {
        wouldBeRefused: refusals.map(({ message }) => message),
        wouldBeRefusedCodes: refusals.map(({ code }) => code),
      }
    : {};
}

/** What the summary of a refused run names. */
export interface RefusedRun {
  tool: string;
  /** The org it reads from, for a run that has one. */
  source?: string;
  target: string;
  elapsedMs: number;
}

/**
 * The `--json` summary of a refused run, as stdout carries it.
 *
 * @param also - What else refused it, for a command that says both at once.
 */
export function refusedSummary(
  run: RefusedRun,
  refused: RunRefusal,
  also: readonly RunRefusal[] = [],
): string {
  const { tool, source, target, elapsedMs } = run;
  return `${JSON.stringify(
    {
      tool,
      ...(source !== undefined ? { source } : {}),
      target,
      dryRun: false,
      refused,
      ...(also.length > 0 ? { alsoRefused: also } : {}),
      elapsedMs,
    },
    null,
    2,
  )}\n`;
}

/** What the answer of a removal refused before its first delete names. */
export interface RefusedRemoval {
  tool: string;
  /** What the removal was asked to take back: the summary, or the run's file. */
  summary: string;
  target: string;
  elapsedMs: number;
}

/**
 * The `--json` answer of a removal refused before its first delete, as stdout
 * carries it: the removal's, with its code, as a refused run's. Refused for
 * its mute, a removal said a sentence on stderr and left stdout empty. It
 * says no `dryRun`: saved and given to `--remove`, it reads as no run's summary.
 */
export function refusedRemovalSummary(removal: RefusedRemoval, refused: RunRefusal): string {
  const { tool, summary, target, elapsedMs } = removal;
  return `${JSON.stringify(
    { tool, action: 'remove', summary, target, refused, elapsedMs },
    null,
    2,
  )}\n`;
}

/**
 * The refusal a summary saved from `--json` names, when it is the summary of
 * a run `tool` refused before its first write: `refusedSummary`'s, or Sync's
 * of the same shape. One that holds a `result` is a run's that went, never
 * read as one that wrote nothing.
 */
export function refusalOfSummary(raw: unknown, tool: string): RunRefusal | undefined {
  const parsed = z
    .object({
      tool: z.literal(tool),
      dryRun: z.literal(false),
      refused: z.object({ code: z.string().min(1), message: z.string() }),
      result: z.never().optional(),
    })
    .safeParse(raw);
  return parsed.success ? parsed.data.refused : undefined;
}

/**
 * Why a refused run's summary has nothing to remove or verify, said after the
 * file's name: read as a summary printed before it said which records the
 * run created, it sent the user to a cleanup that takes every record they
 * created that day.
 */
export function refusedSummaryWords(
  { code }: RunRefusal,
  nothingTo: 'remove' | 'verify' = 'remove',
): string {
  return (
    `is the summary of a run refused before its first write (${code}), which wrote nothing to ` +
    `the target: there is nothing of it to ${nothingTo}.`
  );
}
