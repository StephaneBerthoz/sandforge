/**
 * Whether the org a run writes to delivers the emails its automation sends,
 * read just before the run's question, and only when something that still
 * runs sends one.
 *
 * No API says it. `EmailAdministrationSettings`, `OrgSettings` and
 * `Organization` hold no field for Setup > Deliverability's access level. The
 * one direct read is the platform's own check, one line of anonymous Apex
 * that reserves the capacity of a single email and sends nothing:
 *
 * - on All email it answers `success: true`;
 * - on System email only, and on No access, it throws
 *   `System.NoAccessException: The organization is not permitted to send
 *   email`, the same exception with the same words for both: the read does
 *   not tell them apart, and need not, since no email of a flow, a process, a
 *   workflow rule or Apex goes out under either;
 * - anything else — a compile problem, another exception, a refused request,
 *   no answer in time — is read `unread`, and the run asks as it would for
 *   All email. An answer this module does not know is never taken for closed:
 *   read wrongly as closed, the emails would go out with no question.
 *
 * Probed on a Developer Edition switched through the three levels, a client's
 * full sandbox on No access and two scratch orgs on All email: the single
 * emails the orgs had left stood the same before and after every reservation,
 * 15 of 15 and 5,000 of 5,000. Under both closed levels, a contact whose
 * flow's Send Email uses a template saved in a rehearsal: the email was held
 * back without an error.
 *
 * Whether the user the run writes as may send email was not probed: one who
 * may not could be refused with the same words on an org that delivers
 * everything. So a refusal is read `withheld` only once `UserPermissionAccess`
 * says that user holds Send Email; the permission is read only after a
 * refusal, so an org on All email costs the read one request.
 *
 * The read runs as the user the run writes as, whatever the mute's lease
 * holds: read before the lease is taken, it reads the same. It is read again
 * for every run, never kept: an admin can change the level at any time.
 *
 * Through the same transport as the target's limits (`LimitsTransport`), so
 * reading it loads no client library of its own.
 */

import * as z from 'zod';
import type {
  EmailDeliverability,
  EmailSender,
  ForgeAutomationWrite,
  ForgeTargetAutomation,
  MutedAutomation,
  MutePlan,
  StillRunning,
} from '@sandforge/shared';
import { emailSendersOf, mutePlanOf, stillRunningOf } from '@sandforge/shared';
import { extractErrorMessage } from '../../core/common/extractErrorMessage.js';
import { TimeoutError, TimeoutManager } from '../../core/engine/TimeoutManager.js';
import {
  deliverabilityAfterLeaseStop,
  deliverabilityGate,
  sendersUnreadOf,
  type DeliverabilityGate,
  type DeliverabilityRun,
  type LimitsTransport,
} from './ForgeRunGate.js';

/**
 * The one line of anonymous Apex the read runs: it asks the org to reserve
 * the capacity of one single email, which nothing then sends.
 */
export const DELIVERABILITY_APEX = 'Messaging.reserveSingleEmailCapacity(1);';

/** What an org that delivers no email of its automation answers the read with: System email only, or No access. */
export const EMAIL_NOT_PERMITTED =
  'System.NoAccessException: The organization is not permitted to send email';

/** The request that runs {@link DELIVERABILITY_APEX}, and nothing else. */
const DELIVERABILITY_URL = `/tooling/executeAnonymous?anonymousBody=${encodeURIComponent(
  DELIVERABILITY_APEX,
)}`;

/** Whether the user the run writes as holds Send Email, which answers for that user alone. */
const SEND_EMAIL_URL = `/query?q=${encodeURIComponent(
  'SELECT PermissionsEmailSingle FROM UserPermissionAccess',
)}`;

/** How long the read waits for each answer, as the target's limits are waited for. */
export const DELIVERABILITY_TIMEOUT_MS = 30_000;

/** What the Tooling API answers a block of anonymous Apex with. */
const anonymousAnswerSchema = z
  .object({
    compiled: z.boolean(),
    success: z.boolean(),
    compileProblem: z.string().nullish(),
    exceptionMessage: z.string().nullish(),
  })
  .loose();

/** What `UserPermissionAccess` answers of Send Email. */
const sendEmailSchema = z
  .object({
    records: z.array(z.object({ PermissionsEmailSingle: z.boolean().optional() }).loose()),
  })
  .loose();

/** What the read found, and the requests it sent the org to find it. */
export interface DeliverabilityRead {
  reading: EmailDeliverability;
  /**
   * One — the Apex — or two when the org refused, its user's Send Email read
   * after it: the run's `deliverability` part (`deliverabilityPartOf`).
   */
  requests: number;
}

/**
 * What stands for the read in a production org, where the line of Apex is
 * never run, whatever it costs: Seed's panel writes to one once a person
 * answered Production Guard, and a dry run reads one. A run that sends asks,
 * as it does for any org that would not say, and no request was sent.
 */
export const NO_APEX_IN_PRODUCTION: DeliverabilityRead = {
  reading: { unread: 'SandForge runs no Apex in a production org' },
  requests: 0,
};

/** A time, as the reason of a read that waited for it says it. */
function waitWords(ms: number): string {
  return ms % 1000 === 0 ? `${ms / 1000} s` : `${ms} ms`;
}

/** Why a request of the read got no answer, in the org's words or the wait's. */
function refusedWords(err: unknown, timeoutMs: number): string {
  return err instanceof TimeoutError
    ? `the org did not answer within ${waitWords(timeoutMs)}`
    : `the org refused it: ${extractErrorMessage(err)}`;
}

/**
 * What the org's answer to the Apex says: open, refused with the exception of
 * a closed org — to be told apart from a refusal of the user —, or why it
 * says neither.
 */
function answerOf(answer: unknown): { level: 'all' } | { refused: true } | { unread: string } {
  const parsed = anonymousAnswerSchema.safeParse(answer);
  if (!parsed.success) return { unread: 'its answer is not one anonymous Apex gives' };
  const { compiled, success, compileProblem, exceptionMessage } = parsed.data;
  if (!compiled) {
    return { unread: `it did not compile${compileProblem ? `: ${compileProblem}` : ''}` };
  }
  if (success) return { level: 'all' };
  const said = exceptionMessage?.trim();
  if (said === EMAIL_NOT_PERMITTED) return { refused: true };
  return { unread: said ? `the org answered: ${said}` : 'it failed, and the org did not say why' };
}

/**
 * Whether the target delivers the emails its automation sends, as the one
 * line of anonymous Apex that sends nothing reads it
 * ({@link DELIVERABILITY_APEX}), with the requests sent. Never throws: what
 * keeps it from an answer is said in `unread`, which a run asks about.
 *
 * @param transport - The connection, as the user the run writes as.
 * @param options.timeoutMs - How long to wait for each answer
 *   ({@link DELIVERABILITY_TIMEOUT_MS} unless told).
 */
export async function readEmailDeliverability(
  transport: LimitsTransport,
  options: { timeoutMs?: number } = {},
): Promise<DeliverabilityRead> {
  const timeoutMs = options.timeoutMs ?? DELIVERABILITY_TIMEOUT_MS;
  const ask = (url: string): Promise<unknown> =>
    new TimeoutManager(timeoutMs).withTimeout('forge:deliverability', () =>
      transport.request({ method: 'GET', url }),
    );
  let answer: unknown;
  try {
    answer = await ask(DELIVERABILITY_URL);
  } catch (err: unknown) {
    return { reading: { unread: refusedWords(err, timeoutMs) }, requests: 1 };
  }
  const read = answerOf(answer);
  if (!('refused' in read)) return { reading: read, requests: 1 };
  // The org's refusal tells its setting only if the user may send email.
  const notTold = "so the org's refusal does not say how it is set";
  let permissions: unknown;
  try {
    permissions = await ask(SEND_EMAIL_URL);
  } catch (err: unknown) {
    return {
      reading: {
        unread:
          'whether the user the run writes as may send email could not be read ' +
          `(${refusedWords(err, timeoutMs)}), ${notTold}`,
      },
      requests: 2,
    };
  }
  const parsed = sendEmailSchema.safeParse(permissions);
  const holds = parsed.success ? parsed.data.records[0]?.PermissionsEmailSingle : undefined;
  if (holds === true) return { reading: { level: 'withheld' }, requests: 2 };
  return {
    reading: {
      unread:
        holds === false
          ? `the user the run writes as may not send email (Send Email), ${notTold}`
          : `the org did not say whether the user the run writes as may send email, ${notTold}`,
    },
    requests: 2,
  };
}

/**
 * The read a run's emails are judged on: what still runs that may send one,
 * what of it could not be read, and the org's deliverability, read only when
 * either leaves something to send.
 */
export interface RunDeliverabilityRead {
  senders: EmailSender[];
  /**
   * Why what may send could not all be listed: a part of the target's
   * automation that sends emails — its flows, processes, workflow rules, or
   * the assignment rules a run applies — refused whole. Absent when it was
   * all read.
   */
  sendersUnread?: string;
  /** Absent when nothing is left to send: not read. */
  read?: DeliverabilityRead;
}

/** The read of the target's automation as `stillRunningOf` hands it on, its unread parts with it. */
type RunningRead = Pick<
  StillRunning<
    Pick<ForgeTargetAutomation, 'objects'> & Partial<Pick<ForgeTargetAutomation, 'unread'>>
  >,
  'automation' | 'firing'
>;

/**
 * Steps 3 and 4 of a run's write path for its emails: the senders of what
 * still runs once the mute's plan holds ({@link emailSendersOf}), then the
 * org's deliverability, read only when one is left, or when what sends could
 * not be read. A run with nothing left to send sends no request for it, and
 * one the mute quiets whole is such a run.
 *
 * @param input.running - What still runs once the mute's plan holds
 *   (`stillRunningOf`): the plan, nothing assigned.
 * @param input.read - The read ({@link readEmailDeliverability}), as the user
 *   the run writes as. A read that throws is said `unread`.
 */
export async function deliverabilityOfRun(input: {
  running: RunningRead;
  applyAssignmentRules?: boolean;
  writes?: (objectApiName: string, write: ForgeAutomationWrite) => boolean;
  read: () => Promise<DeliverabilityRead>;
}): Promise<RunDeliverabilityRead> {
  const senders = emailSendersOf(input.running, {
    applyAssignmentRules: input.applyAssignmentRules,
    writes: input.writes,
  });
  const sendersUnread = sendersUnreadOf(input.running.automation.unread ?? [], {
    applyAssignmentRules: input.applyAssignmentRules === true,
  });
  const unsaid = sendersUnread !== undefined ? { sendersUnread } : {};
  if (senders.length === 0 && sendersUnread === undefined) return { senders };
  let read: DeliverabilityRead;
  try {
    read = await input.read();
  } catch (err: unknown) {
    // Whatever kept the read from the org may have sent its request first.
    read = { reading: { unread: extractErrorMessage(err) }, requests: 1 };
  }
  return { senders, ...unsaid, read };
}

/**
 * Those of the senders that still run without the mute that a mute would
 * keep quiet: what the refusal of a run that does not mute names
 * `--mute-automation` for. Empty when the mute quiets none of them — no
 * bypass in their condition, a package's, or no permission set holds it —,
 * and the refusal then does not suggest it.
 */
export function sendersTheMuteQuiets(
  automation: ForgeTargetAutomation,
  options: {
    applyAssignmentRules?: boolean;
    writes?: (objectApiName: string, write: ForgeAutomationWrite) => boolean;
  } = {},
): EmailSender[] {
  const key = (sender: EmailSender): string =>
    `${sender.objectApiName}\u0000${sender.kind}\u0000${sender.name}`;
  const unmuted = emailSendersOf(stillRunningOf(automation, undefined, options.writes), options);
  const muted = new Set(
    emailSendersOf(
      stillRunningOf(automation, mutePlanOf(automation, options.writes), options.writes),
      options,
    ).map(key),
  );
  return unmuted.filter((sender) => !muted.has(key(sender)));
}

/**
 * The sets of a mute's plan its lease holds once read back: those it
 * assigned and those the user held already. One it holds neither way leaves
 * running what it was to keep quiet.
 */
export function heldPlanOf(
  plan: Pick<MutePlan, 'assign'>,
  held: Pick<MutedAutomation, 'assigned' | 'held'>,
): Pick<MutePlan, 'assign'> {
  const holds = new Set([...held.assigned, ...held.held]);
  return { assign: plan.assign.filter((set) => holds.has(set.permissionSet)) };
}

/** The parts of the target's automation that send emails, as a read that failed whole leaves them. */
const SENDING_PARTS = ['flows', 'processes', 'workflowRules'] as const;

/** What a run's emails are judged on, up to its question. */
export interface RunEmailsInput {
  /** What the target runs, read before the mute's plan; or why it could not be read, which asks. */
  read: ForgeTargetAutomation | { unread: string };
  /** The mute's plan, nothing assigned; absent for a run that does not mute. */
  plan?: Pick<MutePlan, 'assign'>;
  /** The writes the run makes, per object. */
  writes: (objectApiName: string, write: ForgeAutomationWrite) => boolean;
  /** Whether its writes apply the target's assignment rules, which can mail who they assign. */
  applyAssignmentRules?: boolean;
  /** The read of the org's deliverability, as the user the run writes as; made only when something sends. */
  readDeliverability: () => Promise<DeliverabilityRead>;
  /** Whether the run came with the accord: `--accept-emails`. A question's answer comes after this gate. */
  accepted: boolean;
  /** The org, as the refusal names it. */
  target: string;
  run: DeliverabilityRun;
  /** Whether the records it writes keep their addresses (`DeliverabilityGateInput.keepsAddresses`). */
  keepsAddresses?: boolean;
  /** Whether the run's way of being started can mute: its refusal then names `--mute-automation`. */
  mayMute?: boolean;
}

/** What a run's emails came to at its gate. */
export interface RunEmails {
  /** What may send, and what was read of the org. */
  ofRun: RunDeliverabilityRead;
  gate: DeliverabilityGate;
  /**
   * Step 8 of the write path for its emails: what the gate was not told of,
   * once the lease is read back — what a set it does not hold was to keep
   * quiet — refuses the run before its first write, unless the emails were
   * accepted or the org withholds them. Nothing without a plan.
   *
   * @param held - What the lease holds, read back (`HeldMute.outcome`).
   * @param accepted - Whether the emails were accepted by then: the flag, or the question's answer.
   */
  afterLease(
    held: Pick<MutedAutomation, 'assigned' | 'held'>,
    accepted: boolean,
  ): ReturnType<typeof deliverabilityAfterLeaseStop>;
}

/**
 * A run's emails, steps 3 to 5 of its write path: what may send once the
 * mute's plan holds, the org's deliverability read only when something may
 * ({@link deliverabilityOfRun}), and what the gate makes of them
 * (`deliverabilityGate`), for Forge's and Seed's hosts and command lines
 * alike. A read of the automation that failed lists no sender and leaves
 * every part that sends unread: the run reads the org and asks, as it does
 * for a part refused whole.
 */
export async function runEmailsOf(input: RunEmailsInput): Promise<RunEmails> {
  const { plan, writes, applyAssignmentRules, read, target, run } = input;
  const known = typeof read.unread === 'string' ? undefined : (read as ForgeTargetAutomation);
  const named = applyAssignmentRules === true ? { applyAssignmentRules } : {};
  const ofRun = await deliverabilityOfRun({
    running: known
      ? stillRunningOf(known, plan, writes)
      : {
          automation: {
            objects: [],
            unread: SENDING_PARTS.map((part) => ({ part, reason: String(read.unread) })),
          },
          firing: [],
        },
    ...named,
    writes,
    read: input.readDeliverability,
  });
  const muteQuiets =
    input.mayMute === true && plan === undefined && known !== undefined && ofRun.senders.length > 0
      ? sendersTheMuteQuiets(known, { ...named, writes })
      : [];
  const reading = ofRun.read?.reading;
  return {
    ofRun,
    gate: deliverabilityGate({
      senders: ofRun.senders,
      ...(ofRun.sendersUnread !== undefined ? { sendersUnread: ofRun.sendersUnread } : {}),
      ...(reading !== undefined ? { reading } : {}),
      accepted: input.accepted,
      target,
      run,
      muteQuiets,
      keepsAddresses: input.keepsAddresses === true,
    }),
    afterLease: (held, accepted) => {
      if (plan === undefined || known === undefined) return undefined;
      return deliverabilityAfterLeaseStop({
        planned: ofRun.senders,
        held: emailSendersOf(stillRunningOf(known, heldPlanOf(plan, held), writes), {
          ...named,
          writes,
        }),
        ...(reading !== undefined ? { reading } : {}),
        accepted,
        target,
        run,
      });
    },
  };
}
