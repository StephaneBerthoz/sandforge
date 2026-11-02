/**
 * What a run says of its emails once its gate judged them (`runEmailsOf`), for
 * Sync's and Autopilot's hosts and command lines: what the check after its
 * lease and its audit entry read, and the words of a refusal where the run has
 * no flag to add.
 */

import type { DeliverabilityGate, DeliverabilityRun } from './ForgeRunGate.js';

/** What became of a run's emails at its gate, for the check after its lease and its audit entry. */
export interface RunEmailsSaid {
  /** Whether what still runs may send them with the accord of whoever answers for the run. */
  accepted: boolean;
  /** What the org said of them; absent when nothing sends, so it was not read. */
  deliverability?: NonNullable<DeliverabilityGate['audit']>;
}

/**
 * What a run's answer says of its emails: absent when there is nothing to say.
 *
 * @param accepted - Whether the run went on with the accord.
 */
export function runEmailsSaidOf(
  gate: Pick<DeliverabilityGate, 'audit'> | undefined,
  accepted: boolean,
): { emails?: RunEmailsSaid } {
  const audit = gate?.audit;
  if (audit === undefined && !accepted) return {};
  return { emails: { accepted, ...(audit !== undefined ? { deliverability: audit } : {}) } };
}

/**
 * What a run's audit entry says of its emails, as a rewind's does: what the
 * org said, and that they were accepted when that mattered — an org that
 * withholds them asks nothing.
 */
export function runEmailsDetailsOf(said: RunEmailsSaid | undefined): Record<string, string> {
  const deliverability = said?.deliverability;
  if (deliverability === undefined) return {};
  return {
    deliverability,
    ...(deliverability !== 'withheld' && said?.accepted === true ? { confirmed: 'emails' } : {}),
  };
}

/** The sentence of a refusal for the emails that says what lifts it on the command line. */
const LIFTED_ON_THE_COMMAND_LINE: Partial<Record<DeliverabilityRun, string>> = {
  sync: 'Add --accept-emails to sync all the same',
  autopilot: 'Add --accept-emails to run it all the same',
  rewind: 'Add --accept-emails to rewind all the same',
  undo: 'Add --accept-emails to undo all the same',
};

/**
 * A refusal for the emails, saying what lifts it where the run runs: a panel,
 * a schedule and a pipeline have no flag to add. The sentence may name an org,
 * whose alias is the user's to spell: it is put in as it is said.
 *
 * @param liftedBy - The sentence to say instead; the command line's when absent.
 */
export function emailsRefusalWords(
  message: string,
  run: DeliverabilityRun,
  liftedBy: string | undefined,
): string {
  const flag = LIFTED_ON_THE_COMMAND_LINE[run];
  return liftedBy !== undefined && flag !== undefined
    ? message.replace(flag, () => liftedBy)
    : message;
}
