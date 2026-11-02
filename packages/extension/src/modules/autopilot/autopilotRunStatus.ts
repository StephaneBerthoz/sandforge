import type { AutopilotRunStatus } from '@sandforge/shared';
import type { ExecutionResult } from './AutopilotExecutor.js';

/**
 * How a run ended: the one reading of its result that its exit code, `--json`,
 * the panel and the audit trail all give. A failure when it died or produced
 * only failures. Partial when the target refused some of what it wrote, an
 * object of it failed, a record it wrote stands without a lookup it tried to
 * fill or at the draft status it was born with, or it was stopped.
 *
 * A lookup or a status refused after the waves counts in none of the run's
 * totals: the record is written. Read from the totals alone, such a run ended
 * a success, its records in the target without the links between them, or
 * orders left drafts. A record the run linked to is a record it found its
 * place for, as Forge and Seed count it: a refusal beside linked records is
 * no run that produced only failures.
 *
 * Apart from the executor, which the extension loads once its services are up:
 * the handler, loaded with the extension, reads it too.
 */
export function autopilotRunStatus(
  result: Pick<
    ExecutionResult,
    | 'fatalError'
    | 'totalSuccess'
    | 'totalLinked'
    | 'totalFailure'
    | 'failedObjects'
    | 'stopped'
    | 'lookups'
    | 'statuses'
  >,
): AutopilotRunStatus {
  if (result.fatalError !== undefined) return 'failure';
  if (result.totalFailure > 0 || result.failedObjects.length > 0) {
    return result.totalSuccess + (result.totalLinked ?? 0) > 0 ? 'partial' : 'failure';
  }
  const leftUnfinished = [
    ...Object.values(result.lookups ?? {}),
    ...Object.values(result.statuses ?? {}),
  ].some((outcome) => outcome.refusals.length > 0);
  return leftUnfinished || result.stopped === true ? 'partial' : 'success';
}
