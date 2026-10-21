import type { LiveOperationTracker } from '../../modules/monitor/LiveOperationTracker.js';

/**
 * A run's entry in the Monitor's Live Operations, from its start to its end.
 *
 * A run ends once: the first of `complete`, `fail` and `cancel` says how, and
 * the others change nothing. A restore that stopped at an object it may not
 * write, then reached the `finally` that ends every restore, would otherwise
 * be listed failed and then completed; a cancelled masking run listed
 * cancelled, then failed on the error the cancel left behind it.
 */
export interface LiveRun {
  /** How far the run is: ignored once it ended. */
  progress(percentage: number, processed: number, total: number, step: string): void;
  complete(): void;
  fail(reason: string): void;
  cancel(): void;
}

/**
 * List a run in Live Operations, where its Cancel reaches the controller the
 * run registered in the background registry under the same id.
 *
 * @param tracker - The tracker the Monitor lists runs from; none in a test or
 *   at the command line, where nothing is listed.
 * @param operationId - The run's id: its registry entry's, and its `operation:*` messages'.
 * @param module - The module the run belongs to, which names its badge.
 * @param description - What the run does, as the list shows it.
 * @param total - The records, or the objects, the run expects; 0 when unknown.
 */
export function listLive(
  tracker: LiveOperationTracker | undefined,
  operationId: string,
  module: string,
  description: string,
  total = 0,
): LiveRun {
  tracker?.register(operationId, module, description, total);
  let ended = false;
  const end = (how: () => void): void => {
    if (ended) return;
    ended = true;
    how();
  };
  return {
    progress: (percentage, processed, all, step) => {
      if (!ended) tracker?.updateProgress(operationId, percentage, processed, all, step);
    },
    complete: () => end(() => tracker?.complete(operationId)),
    fail: (reason) => end(() => tracker?.fail(operationId, reason)),
    cancel: () => end(() => tracker?.cancel(operationId)),
  };
}
