import type { AutopilotRunStatus } from '@sandforge/shared';
import type { ExecutionResult } from './AutopilotExecutor.js';

/**
 * How a run ended: the one reading of its result that its exit code, `--json`,
 * the panel and the audit trail all give. A failure when it died or produced
 * only failures. Partial when the target refused some of what it wrote, an
 * object of it failed, a record it wrote stands without a lookup it tried to
 * fill, or it was stopped.
 *
 * A lookup refused in the second pass counts in none of the run's totals: the
 * record is written. Read from the totals alone, such a run ended a success,
 * its records in the target without the links between them.
 *
 * Apart from the executor, which the extension loads once its services are up:
 * the handler, loaded with the extension, reads it too.
 */
export function autopilotRunStatus(
  result: Pick<
    ExecutionResult,
    'fatalError' | 'totalSuccess' | 'totalFailure' | 'failedObjects' | 'stopped' | 'lookups'
  >,
): AutopilotRunStatus {
  if (result.fatalError !== undefined) return 'failure';
  if (result.totalFailure > 0 || result.failedObjects.length > 0) {
    return result.totalSuccess > 0 ? 'partial' : 'failure';
  }
  const lookupLeftEmpty = Object.values(result.lookups ?? {}).some(
    (lookups) => lookups.refusals.length > 0,
  );
  return lookupLeftEmpty || result.stopped === true ? 'partial' : 'success';
}
