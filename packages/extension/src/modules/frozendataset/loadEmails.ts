/**
 * The gate of a Frozen load on the emails of what still runs as it writes,
 * before its first write: Seed's and Sync's, on the load's writes.
 *
 * A load counted no email, read no deliverability and took no
 * `--accept-emails`: its inserts fired the target's flows as a clone's do, and
 * the trap Developer Edition, whose contact flow sends two emails a contact
 * and whose workflow alert one more, would have spent 108 of its 15 single
 * emails a day on a reload of 36 contacts. Its pseudonymized addresses are
 * under `example.invalid`, but an owner, a record the target holds and an
 * address an alert names are not, and a field kept in clear keeps its own.
 *
 * Two stops, each before anything is written:
 *
 * - past what the target has left of a daily email limit, counted on the
 *   records of the dataset, at most, as Production Guard counts a load
 *   (`FROZEN_EMAILS_EXCEEDED`): no accord lifts it, as Seed's does not;
 * - the target delivers them, or would not say (`EMAILS_NOT_ACCEPTED`),
 *   unless the load came with the accord: `--accept-emails`, or the box the
 *   Load tab offers beside the mute's.
 */

import type {
  ForgeAutomationWrite,
  ForgeEmailLimit,
  ForgeTargetAutomation,
  FrozenLoadEmailsInfo,
  MutePlan,
} from '@sandforge/shared';
import { emailsPerInsertOf, stillRunningOf } from '@sandforge/shared';
import { extractErrorMessage } from '../../core/common/extractErrorMessage.js';
import {
  countedEmailChecksOf,
  deliverabilityLineOf,
  emailCheckLines,
  emailRefusal,
  emailsUncountedOf,
  insertsOf,
  type EmailCheck,
  type EmailLimit,
} from '../forge/ForgeRunGate.js';
import {
  runEmailsOf,
  type DeliverabilityRead,
  type RunEmails,
} from '../forge/targetDeliverability.js';

/** The code a load is refused under past what its target has left of a daily email limit. */
export const FROZEN_EMAILS_EXCEEDED = 'FROZEN_EMAILS_EXCEEDED';

/** What a load's emails are judged on, before its first write. */
export interface LoadEmailsInput {
  /** What the target runs on the objects the load writes, or why it could not be read: that asks. */
  read: ForgeTargetAutomation | { unread: string };
  /** The mute's plan, nothing assigned; absent for a load that does not mute. */
  plan?: Pick<MutePlan, 'assign'>;
  /** The writes the load makes, per object: its inserts and updates, a reload's purge and sweep. */
  writes: (objectApiName: string, write: ForgeAutomationWrite) => boolean;
  /** The records it inserts, per object: the dataset's, at most. */
  inserts: ReadonlyArray<{ objectApiName: string; rows: number }>;
  /** The target's daily email limits; read only when something that still runs sends. */
  readLimits: () => Promise<Partial<Record<ForgeEmailLimit, EmailLimit>>>;
  /** Whether the target delivers them, as the user the load writes as; read only when something sends. */
  readDeliverability: () => Promise<DeliverabilityRead>;
  /** Whether the load came with the accord: `acceptEmails`, `--accept-emails`. */
  accepted: boolean;
  /** The org, as the refusals name it. */
  target: string;
  /** Whether the load was not asked to mute: a refusal then names `--mute-automation`. */
  mayMute: boolean;
}

/** What a load's emails came to at its gate. */
export interface LoadEmails {
  /** The deliverability gate, and the check after the mute's lease. */
  run: RunEmails;
  /** What a preview, the report and a refusal say of them. */
  info: FrozenLoadEmailsInfo;
  /** Why the load is refused before its first write; absent when it goes on. */
  stop?: { code: string; message: string };
}

/**
 * What the command line says of a load's emails, from what its preview, its
 * report or its refusal carried: the counts, and the deliverability read.
 */
export function loadEmailsLines(info: FrozenLoadEmailsInfo, target: string): string[] {
  return [
    ...emailCheckLines(info.counted, target),
    ...(info.uncounted !== undefined
      ? [`  emails: not counted, ${info.uncounted} could not be read`]
      : []),
    ...(info.deliverability ? [`  ${deliverabilityLineOf(info.deliverability.reading)}`] : []),
  ];
}

/** Whether a read of the target's automation failed whole. */
function isUnread(read: ForgeTargetAutomation | { unread: string }): read is { unread: string } {
  return typeof (read as { unread?: unknown }).unread === 'string';
}

/**
 * A load's emails, steps 3 to 5 of its write path for them, as Seed's and
 * Sync's: what still runs once the mute's plan holds, the emails it sends on
 * the records inserted against the target's daily limits, and the target's
 * deliverability, each read only when something sends.
 */
export async function loadEmailsOf(input: LoadEmailsInput): Promise<LoadEmails> {
  const { read, plan, writes, target } = input;
  const run = await runEmailsOf({
    read,
    ...(plan ? { plan } : {}),
    writes,
    readDeliverability: input.readDeliverability,
    accepted: input.accepted,
    target,
    run: 'load',
    // The records go in with the addresses the dataset holds: under
    // `example.invalid` where the `email` generator pseudonymized them, their
    // own where a field was kept in clear.
    keepsAddresses: true,
    mayMute: input.mayMute,
  });
  let counted: EmailCheck[] = [];
  let uncounted: string | undefined;
  if (isUnread(read)) {
    uncounted = `the target's automation: ${read.unread}`;
  } else {
    // Counted on what still runs once the mute's plan holds, as Seed counts.
    const running = stillRunningOf(read, plan, writes).automation;
    const writePlan = { objects: input.inserts.map((o) => ({ ...o, storageBytes: 0 })) };
    uncounted = emailsUncountedOf(running, insertsOf(writePlan));
    const sending = emailsPerInsertOf(running);
    if (sending.length > 0) {
      const limits = await input
        .readLimits()
        .catch((err: unknown) => ({ unread: extractErrorMessage(err) }));
      counted = countedEmailChecksOf(writePlan, sending, limits);
    }
  }
  const over = emailRefusal(counted, target);
  // Past the limits no accord helps: said first, as Seed and Sync say it.
  const stop = over
    ? { code: FROZEN_EMAILS_EXCEEDED, message: `${over} Nothing was written.` }
    : run.gate.stop;
  const { deliverability } = run.gate;
  return {
    run,
    info: {
      counted: counted.map((check) => ({ ...check, objects: [...check.objects] })),
      ...(uncounted !== undefined ? { uncounted } : {}),
      verdict: run.gate.verdict,
      ...(deliverability ? { deliverability } : {}),
      accepted: input.accepted,
      ...(stop ? { refused: { code: stop.code, message: stop.message } } : {}),
    },
    ...(stop ? { stop } : {}),
  };
}
