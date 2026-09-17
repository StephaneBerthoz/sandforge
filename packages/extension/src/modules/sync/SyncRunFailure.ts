import type { SyncExecutionResult } from '@sandforge/shared';

/**
 * A sync run that failed partway through, carrying what it had already done.
 *
 * The message and the cause are the ones the caller used to receive bare; the
 * result is the new part, so a mid-run failure can be stored with the objects
 * that did complete and the time it really took. Without it the handler's catch
 * built a result with no objects and a zero duration, and a run that had copied
 * two objects of three was stored — and shown in the history panel — as
 * "failure, 0 objects, 0 ms", indistinguishable from one that never started.
 *
 * It lives in a module of its own, importing nothing but a type, because the
 * orchestrator that throws it and the handler that catches it already import
 * each other's neighbours: declared next to the orchestrator, the handler's
 * `err instanceof SyncRunFailure` ran before the class was initialised, threw
 * inside the catch block, and took the history logging down with it.
 */
export class SyncRunFailure extends Error {
  constructor(
    message: string,
    readonly result: SyncExecutionResult,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'SyncRunFailure';
  }
}
