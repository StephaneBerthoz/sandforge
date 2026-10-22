/**
 * The exit codes the command lines end with: one table for all of them, the
 * clone's, which `ci-examples/README.md` lists.
 *
 *   0  the run did what it was asked; a partial run too, unless --fail-on-partial
 *   1  it could not start, was refused before it wrote, or produced only failures
 *   2  a bad command line, or a question with no terminal to answer it (--yes)
 *   3  partial: records were left behind, refused or not checked
 *   4  unstable: no two readings of a verification agreed
 *   129, 130, 143  a SIGHUP, a Ctrl-C or a SIGTERM stopped it (stopSignals.ts)
 *
 * Seed, Sync and Autopilot exited 0 when every record was refused, Frozen's
 * verification on a FAILED verdict, DataOps with records left unmasked: a
 * pipeline gated on them went on as if they had done their work.
 */

/** The run did what it was asked. */
export const DONE_EXIT = 0;

/** It could not start, was refused, or produced only failures. */
export const FAILED_EXIT = 1;

/** It did part of what it was asked: records were left behind, refused or not checked. */
export const PARTIAL_EXIT = 3;

/** No two readings of a verification agreed: something still writes to the records. */
export const UNSTABLE_EXIT = 4;

/** How a run that wrote says it ended. */
export type RunStatus = 'success' | 'partial' | 'failure';

/**
 * The exit code of a run that wrote, from how it ended, as the clone's: 1 for
 * one that produced only failures, 0 for one that did some of its work —
 * pipelines that let a few refusals through went on — unless
 * `--fail-on-partial`, which makes it 3.
 */
export function runExitCode(status: RunStatus, failOnPartial: boolean): number {
  if (status === 'failure') return FAILED_EXIT;
  if (status === 'partial' && failOnPartial) return PARTIAL_EXIT;
  return DONE_EXIT;
}

/**
 * The exit code of a DataOps restore, from its answer: 1 when it put nothing
 * back, 3 when the org refused some rows, the snapshot held part of the
 * records, or records of a Sync run's snapshot changed since the run were
 * held back, whose values then stay as they are.
 */
export function restoreExitCode(answer: {
  status?: unknown;
  totalFailed?: unknown;
  partial?: unknown;
  keptChanged?: unknown;
}): number {
  if (answer.status === 'failure') return FAILED_EXIT;
  if (Number(answer.totalFailed ?? 0) > 0 || answer.partial === true) return PARTIAL_EXIT;
  // Held back, as removing the run leaves them: exited 0 as a restore of everything.
  if (answer.keptChanged !== undefined) return PARTIAL_EXIT;
  return DONE_EXIT;
}

/**
 * End the command with `code` once it returns: 0 leaves the code unset, and
 * a code set before — a failure the command said on its way — stands.
 */
export function endWith(code: number): void {
  if (code === DONE_EXIT) return;
  if (process.exitCode !== undefined && process.exitCode !== DONE_EXIT) return;
  process.exitCode = code;
}

/** How bad each code is, the worst last: a partial run, then an unstable one, then a failure. */
const SEVERITY: readonly number[] = [DONE_EXIT, PARTIAL_EXIT, UNSTABLE_EXIT, FAILED_EXIT];

/** The worst of the codes a step came to; 0 when it came to none. */
export function worstExit(codes: readonly number[]): number {
  return codes.reduce(
    (worst, code) => (SEVERITY.indexOf(code) > SEVERITY.indexOf(worst) ? code : worst),
    DONE_EXIT,
  );
}
