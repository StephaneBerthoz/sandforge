/**
 * The user a run writes as, read once from the target's identity service as
 * the run begins: what the sweep of its removal holds the records the
 * target's automation made to. A run kept nothing of it, and its sweep read it
 * back from the creator of the run's records, which a removal may have taken,
 * and which a Sync run that only wrote over records no longer says once their
 * values are back.
 *
 * Bounded, and never what holds a run up: an org that does not answer leaves
 * the run to go on without it. A Forge run reads it beside its record types,
 * which it waits for anyway (`ForgeHandler.runUserOf`). The runs that keep a
 * file do not wait at all (`keepRunUser`): the file takes it whenever it
 * comes (`SyncCreationRecorder.runUser`), and a run with nothing else to wait
 * on is lengthened by nothing.
 */

import { TimeoutManager } from '../../core/engine/TimeoutManager.js';

/** How long, in milliseconds, a target is given to say who the session is. */
export const RUN_USER_TIMEOUT_MS = 15_000;

const SF_ID = /^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/;

/** How a run asks its target who it writes as: `conn.identity()`. */
export type RunIdentity = () => Promise<{ user_id?: unknown }>;

/**
 * The user `identity` names, by Salesforce id: undefined when the target did
 * not answer within {@link RUN_USER_TIMEOUT_MS}, or answered with anything
 * else. Never rejects.
 *
 * @param context - What a timeout names, in the logs of whoever reads it.
 */
export async function readRunUser(
  identity: RunIdentity,
  context: string,
): Promise<string | undefined> {
  try {
    const { user_id: userId } = await new TimeoutManager(RUN_USER_TIMEOUT_MS).withTimeout(
      `${context} run user`,
      async () => identity(),
    );
    return typeof userId === 'string' && SF_ID.test(userId) ? userId : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Tell a run's recorder who the run writes as, once its target says: one
 * bounded read, started here and awaited by nothing, so a silent target
 * lengthens no run. A recorder that takes no user reads nothing.
 */
export function keepRunUser(
  recorder: { runUser?(userId: string): void } | undefined,
  identity: RunIdentity,
  context: string,
): void {
  if (!recorder?.runUser) return;
  void readRunUser(identity, context).then((userId) => {
    if (userId !== undefined) recorder.runUser?.(userId);
  });
}
