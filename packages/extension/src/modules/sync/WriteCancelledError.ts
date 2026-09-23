/**
 * A write the run's cancel stopped before Salesforce processed any of its
 * records: an upload of more than ten thousand records whose job was aborted
 * while it was still open. None of them was written.
 *
 * Thrown rather than answered with an empty list of outcomes: an empty list
 * read as an object that had nothing to write, and a run cancelled on its last
 * object ended as a success. The run that catches it ends cancelled; one that
 * does not fails, which is never a success either.
 *
 * It lives in a module of its own, importing nothing, for the reason
 * `SyncRunFailure` does: the writer that throws it and the orchestrators and
 * handlers that catch it import each other's neighbours.
 */
export class WriteCancelledError extends Error {
  constructor(readonly objectApiName: string) {
    super(`The write of ${objectApiName} was cancelled before any of its records was written.`);
    this.name = 'WriteCancelledError';
  }
}
