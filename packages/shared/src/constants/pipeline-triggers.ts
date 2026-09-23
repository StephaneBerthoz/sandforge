/**
 * What the extension and the Automation page agree on about the runs a
 * trigger starts.
 *
 * @module constants/pipeline-triggers
 */

/**
 * How every run a trigger starts begins its operation id.
 *
 * Such a run answers no request of the page's, so the page hears of it only
 * through the `operation:*` messages every panel receives. The prefix is how it
 * tells one of them from a sync or a backup, and asks for the history again
 * when it ends. A page's own request ids begin with `wv-`.
 */
export const TRIGGERED_RUN_PREFIX = 'pipeline:trigger:';

/** Whether `operationId` is that of a run a trigger started. */
export function isTriggeredRun(operationId: string): boolean {
  return operationId.startsWith(TRIGGERED_RUN_PREFIX);
}
