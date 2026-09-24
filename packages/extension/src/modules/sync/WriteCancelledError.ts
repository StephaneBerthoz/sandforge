import type { OperationOutcome } from './DataSync.js';

/**
 * A write the run's cancel stopped before it was done. Either a Bulk API
 * upload whose job was aborted while it was still open, none of whose records
 * was written, or a write sent in REST batches, stopped between two of them.
 * `written` holds the outcomes of the records sent before the cancel, in input
 * order: they are the first `written.length` records, and the ones after them
 * were never sent.
 *
 * Thrown rather than answered with those outcomes: an empty list read as an
 * object that had nothing to write, and a run cancelled on its last object
 * ended as a success. The run that catches it ends cancelled, and counts what
 * was written; one that does not fails, which is never a success either.
 *
 * `notes` are what the write says of the records it wrote, as a result's
 * notes are (`DataSync.write`): a record type set aside, a lookup dropped.
 * When a cancel carried the outcomes alone, the records it let into the org
 * went without a word of what they were written without.
 *
 * It lives in a module of its own, importing nothing at run time, for the
 * reason `SyncRunFailure` does: the writer that throws it and the
 * orchestrators and handlers that catch it import each other's neighbours.
 */
export class WriteCancelledError extends Error {
  constructor(
    readonly objectApiName: string,
    readonly written: OperationOutcome[] = [],
    readonly notes: string[] = [],
  ) {
    super(
      written.length === 0
        ? `The write of ${objectApiName} was cancelled before any of its records was written.`
        : `The write of ${objectApiName} was cancelled after ${written.length} of its records were sent.`,
    );
    this.name = 'WriteCancelledError';
  }
}
