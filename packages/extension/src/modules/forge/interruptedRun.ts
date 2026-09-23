/**
 * What a Forge run that threw had done before it stopped.
 *
 * A run stops on an abort, or on a failure past its first objects, by
 * throwing — and the counts it kept went down with it: the audit trail
 * recorded such a run as failed, with nothing created and nothing lost,
 * whatever it had written to the org by then. The executor keeps its tallies
 * here, by the error it throws, for whoever records the run.
 *
 * Kept apart from the executor, so a handler reads them without loading it.
 */
import type { ExecutionSummary } from './ForgeExecutor.js';

/** The tallies of each run that threw, by the error it threw. */
const partialSummaries = new WeakMap<object, ExecutionSummary>();

/** Keep what a run had done by the time it threw `error`. A thrown non-object keeps nothing. */
export function keepPartialSummary(error: unknown, summary: ExecutionSummary): void {
  if (typeof error === 'object' && error !== null) partialSummaries.set(error, summary);
}

/**
 * What the run that threw `error` had done before it stopped — the rows it
 * created, linked and lost, per object — or undefined for an error no run threw.
 */
export function partialSummaryOf(error: unknown): ExecutionSummary | undefined {
  return typeof error === 'object' && error !== null ? partialSummaries.get(error) : undefined;
}
