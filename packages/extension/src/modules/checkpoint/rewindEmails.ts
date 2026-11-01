/**
 * The emails a rewind's or an undo's writes make the org send, per daily
 * limit, against what it has left of it today: the email gate of Checkpoint &
 * Rewind.
 *
 * A Developer Edition sends fifteen single emails a day, and counts its email
 * alerts against them too (`alertsCountAsSingle`). A rewind of a session's
 * work gives back, deletes and brings back records by the hundred: a flow that
 * sends an email as a contact is updated sent one per contact given back, and
 * past the fifteenth, Salesforce refuses each record whose flow fails in the
 * save (`CANNOT_EXECUTE_FLOW_TRIGGER`) and stops the org's own emails for the
 * rest of the day. So the emails are counted before anything is written, as
 * Forge, Seed and Sync count those of their inserts, and an act past what the
 * org has left is refused: no box lifts it, as none makes the org send more.
 *
 * Each email action of a flow, a process or a workflow rule that fires on a
 * write and that no bypass the user holds keeps quiet counts once a record,
 * whatever condition decides it (`emailsPerWriteOf`): an estimate that errs
 * says too much. What an Apex trigger sends is not read.
 *
 * What a flow, a process or a rule whose definition was not read sends is
 * counted as nothing, and said so (`checkpointEmailsUncounted`): a flow a
 * package runs after the save of its object is one, as no user reads a
 * package's flows. A rewind is not refused for it, which would refuse every
 * rewind of an org where a package runs a flow on an object the checkpoint
 * holds: it fires as the rewind writes, so the rewind asks for its automation
 * to be accepted, and the question says its emails were not counted.
 *
 * Whether the emails leave the org at all is the other half: an org on All
 * email delivers every one of them, to the addresses the records hold — a
 * rewind's are the org's own, never under `.invalid` — and to the records'
 * owners. What still runs as the act writes, once its mute's plan holds, is
 * judged by Forge's gate (`deliverabilityGate`): nothing that sends, nothing
 * read; an org that withholds them (System email only, No access), a line;
 * one that delivers them, or would not say, a refusal (`EMAILS_DELIVERED`)
 * unless the emails were accepted (`acceptEmails`, `--accept-emails`), which
 * the acceptance of the automation never stands for. The org is read only
 * when something that still runs may send one (`deliverabilityOfRun`): one
 * line of anonymous Apex that sends nothing, as the act's user.
 */

import {
  emailSendersOf,
  emailsPerWriteOf,
  removalStepsWrites,
  stillRunningOf,
  type CheckpointEmails,
  type CheckpointRefusal,
  type CheckpointWrite,
  type EmailDeliverability,
  type EmailSender,
  type ForgeEmailLimit,
  type ForgeRemovalSteps,
  type ForgeTargetAutomation,
  type MutedAutomation,
  type MutePlan,
  type RewindDiffObject,
} from '@sandforge/shared';
import {
  alertsCountAsSingle,
  deliverabilityAfterLeaseStop,
  deliverabilityGate,
  emailsCountedPerRecord,
  emailsUncountedOf,
  sendersUnreadOf,
  type DeliverabilityGate,
  type EmailLimit,
} from '../forge/ForgeRunGate.js';
import {
  deliverabilityOfRun,
  sendersTheMuteQuiets,
  type DeliverabilityRead,
  type RunDeliverabilityRead,
} from '../forge/targetDeliverability.js';
import type { RewoundObject } from './rewindEstimate.js';
import type { RewindPlanObject } from './rewindPlan.js';

/** What the org has left today of its daily email limits, as its `/limits` say, or why it did not say. */
export type EmailLimits = Partial<Record<ForgeEmailLimit, EmailLimit>> | { unread: string };

/** Records of one object one write of an act writes. */
export interface WrittenRecords {
  objectApiName: string;
  write: CheckpointWrite;
  records: number;
}

/** The writes of an act, in the order it makes them. */
const WRITES: readonly CheckpointWrite[] = ['undelete', 'insert', 'update', 'delete'];

/** How each daily email limit is said. */
const LIMIT_WORDS: Readonly<Record<ForgeEmailLimit, string>> = {
  SingleEmail: 'single emails',
  DailyWorkflowEmails: 'workflow emails',
};

/** What the act refused is called, and what it does not do. */
const ACT_WORDS: Readonly<Record<'rewind' | 'undo', { what: string; then: string }>> = {
  rewind: { what: 'This rewind', then: 'rewind again' },
  undo: { what: 'This undo', then: 'undo the rewind again' },
};

/**
 * What a rewind would write, per object and write, as its preview counts it:
 * what it brings back, what it makes again with new Ids, what it gives back —
 * what it brings back among it, the values it had when deleted given back
 * once it is back — and what it deletes. A carrier is brought back and
 * deleted again: the automation of either write fires on it.
 */
export function writtenByDiff(objects: readonly RewindDiffObject[]): WrittenRecords[] {
  return objects.flatMap((object) =>
    written(object.objectApiName, {
      undelete:
        object.toBringBack.inBin +
        object.toBringBack.withParent +
        object.toBringBack.deletedWhileTaken +
        (object.toBringBack.carriers ?? 0),
      insert: object.toRecreate ?? 0,
      update: object.toGiveBack.records + object.toBringBack.inBin + object.toBringBack.withParent,
      delete:
        object.toDelete.createdSince +
        object.toDelete.broughtBackSince +
        object.toDelete.comesBackWithParent +
        (object.toBringBack.carriers ?? 0),
    }),
  );
}

/**
 * What a rewind's first pass writes, per object and write, as its plan holds
 * it: what comes back with a parent and what goes with one counted with what
 * is sent, as the org's automation may fire on them all.
 */
export function writtenByPlan(objects: readonly RewindPlanObject[]): WrittenRecords[] {
  return objects.flatMap((object) =>
    written(object.objectApiName, {
      undelete: object.broughtBack + object.backWithParent + (object.carriers ?? 0),
      insert: object.recreated,
      update: object.givenBackFirst + object.givenBackAfter + object.givenBackNextPass,
      delete: object.deleted + object.withParentDeleted + object.nextPassDeleted,
    }),
  );
}

/**
 * What an undo writes, per object and write, from what its rewind did: it
 * brings back what the rewind deleted, gives back what it wrote over, and
 * sends back to the bin what it brought back and what it made again — what
 * goes with a parent among it (`along`).
 */
export function writtenByUndo(
  rewound: readonly RewoundObject[],
  along: ReadonlyArray<{ objectApiName: string; count: number }> = [],
): WrittenRecords[] {
  const alongOf = new Map<string, number>();
  for (const { objectApiName, count } of along) {
    alongOf.set(objectApiName, (alongOf.get(objectApiName) ?? 0) + count);
  }
  const objects = [...new Set([...rewound.map((o) => o.objectApiName), ...alongOf.keys()])];
  return objects.flatMap((objectApiName) => {
    const object = rewound.find((o) => o.objectApiName === objectApiName);
    return written(objectApiName, {
      undelete: object?.deleted ?? 0,
      insert: 0,
      update: object?.givenBack ?? 0,
      delete: (object?.broughtBack ?? 0) + (alongOf.get(objectApiName) ?? 0),
    });
  });
}

function written(
  objectApiName: string,
  counts: Readonly<Record<CheckpointWrite, number>>,
): WrittenRecords[] {
  return WRITES.filter((write) => counts[write] > 0).map((write) => ({
    objectApiName,
    write,
    records: counts[write],
  }));
}

/**
 * Why the emails of what fires on `written` were not counted: the parts of
 * the org's automation that send emails the read could not take, then the
 * flows, processes and rules that fire on a write it makes whose definition
 * was refused or left unread — a package's named with it. Undefined when
 * each one that fires was read. An undelete starts none of them.
 */
export function checkpointEmailsUncounted(
  written: readonly WrittenRecords[],
  automation: Pick<ForgeTargetAutomation, 'objects' | 'unread'>,
): string | undefined {
  const writes = new Set(
    written
      .filter((each) => each.records > 0)
      .map((each) => `${each.objectApiName}\n${each.write}`),
  );
  return emailsUncountedOf(
    automation,
    (objectApiName, write) => writes.has(`${objectApiName}\n${write}`),
    "the org's",
  );
}

/**
 * The sentence a refusal of automation not accepted says of the emails that
 * were not counted, before it says what lifts it; nothing when every email
 * was.
 */
export function emailsUncountedWords(
  act: 'rewind' | 'undo',
  uncounted: string | undefined,
): string {
  if (uncounted === undefined) return '';
  return (
    `The emails it sends as the ${act} writes were not counted against its daily limits, as ` +
    `what sends them was not read (${uncounted}). `
  );
}

/** Whether the limits could not be read. */
function isUnread(limits: EmailLimits): limits is { unread: string } {
  return typeof (limits as { unread?: unknown }).unread === 'string';
}

/**
 * The emails `written` makes the org send, per daily limit, against what it
 * has left today: none when its automation sends none as they are written.
 * Counted as the org counts them: where it counts its email alerts against
 * its single emails, as a Developer Edition does, the alerts of each record
 * are among its single emails too.
 */
export function checkpointEmails(
  written: readonly WrittenRecords[],
  automation: Pick<ForgeTargetAutomation, 'objects'>,
  limits: EmailLimits,
): CheckpointEmails[] {
  const alertsAsSingle = !isUnread(limits) && alertsCountAsSingle(limits);
  const byLimit = new Map<ForgeEmailLimit, CheckpointEmails>();
  for (const write of WRITES) {
    const sending = emailsPerWriteOf(automation, write);
    if (sending.length === 0) continue;
    const counted = emailsCountedPerRecord(sending, alertsAsSingle);
    const alerting = new Set(
      sending
        .filter((each) => each.limit === 'DailyWorkflowEmails')
        .map((each) => each.objectApiName),
    );
    for (const { objectApiName, records } of written.filter((each) => each.write === write)) {
      for (const each of counted.filter((one) => one.objectApiName === objectApiName)) {
        const check = byLimit.get(each.limit) ?? {
          limit: each.limit,
          emails: 0,
          objects: [],
          verdict: 'fits' as const,
        };
        check.emails += records * each.perRecord;
        check.objects.push({
          objectApiName,
          write,
          records,
          perRecord: each.perRecord,
          sentBy: [...each.sentBy],
        });
        if (alertsAsSingle && each.limit === 'SingleEmail' && alerting.has(objectApiName)) {
          check.alertsCounted = true;
        }
        byLimit.set(each.limit, check);
      }
    }
  }
  return [...byLimit.values()].map((check): CheckpointEmails => {
    if (isUnread(limits)) return { ...check, verdict: 'unread', unread: limits.unread };
    const limit = limits[check.limit];
    if (!limit) {
      return { ...check, verdict: 'unread', unread: `the org's limits list no ${check.limit}` };
    }
    return {
      ...check,
      verdict: check.emails > limit.remaining ? 'exceeds' : 'fits',
      remaining: limit.remaining,
      max: limit.max,
    };
  });
}

/**
 * The refusal of an act whose writes would make the org send more emails of
 * a daily limit than it has left today; nothing when they fit, or could not
 * be counted against a limit.
 */
export function emailsRefusal(
  act: 'rewind' | 'undo',
  emails: readonly CheckpointEmails[],
  orgName: string,
): CheckpointRefusal | undefined {
  const over = emails.filter((check) => check.verdict === 'exceeds');
  if (over.length === 0) return undefined;
  const said = over
    .map(
      (check) =>
        `about ${check.emails} ${LIMIT_WORDS[check.limit]}` +
        (check.alertsCounted
          ? ' (its email alerts among them, as a Developer Edition counts them)'
          : '') +
        `, ${check.remaining ?? 0} of ${check.max ?? 0} left today`,
    )
    .join('; ');
  const words = ACT_WORDS[act];
  return {
    code: 'EMAILS',
    message:
      `${words.what} would make ${orgName} send ${said}: past them, each record whose flow ` +
      "fails in the save is refused (CANNOT_EXECUTE_FLOW_TRIGGER), and the org's own emails " +
      'stop for the rest of the day. Turn off what sends them, or assign the user a bypass ' +
      `that keeps it quiet, then ${words.then}. No record was written.`,
  };
}

// ─── Whether the org delivers them ───────────────────────────────────────────

/** What a rewind's or an undo's gate on whether the org delivers its emails is told. */
export interface ActEmailsInput {
  act: 'rewind' | 'undo';
  /** How the user knows the org: its alias, else its username. */
  orgName: string;
  /**
   * What the org runs as the act writes, as it was read: before the mute's
   * plan holds it, which `plan` says.
   */
  automation: ForgeTargetAutomation;
  /** What the act writes, object by object, as its mute and its automation's gate take it. */
  steps: ForgeRemovalSteps;
  /** The sets the act's lease is to hold; absent for an act that does not mute. */
  plan?: Pick<MutePlan, 'assign'>;
  /**
   * Whether the emails were accepted: `acceptEmails`, `--accept-emails`. The
   * acceptance of the automation never stands for it: a CI script passes
   * `--accept-automation` on every run.
   */
  accepted: boolean;
  /**
   * Whether the act could mute the org's automation and was not asked to
   * (`--mute-automation`, the page's box): its refusal then names what the
   * mute would keep quiet. A pipeline's Rewind step mutes nothing.
   */
  mayMute: boolean;
}

/**
 * What may send an email as the act writes: what still runs once its mute's
 * plan holds (`stillRunningOf`, `emailSendersOf`), and why what may send
 * could not all be listed. Reads nothing: what a preview's answer is judged
 * on again before a rewind is asked, as the act judges what it reads.
 */
export function actSendersOf(input: Pick<ActEmailsInput, 'automation' | 'steps' | 'plan'>): {
  senders: EmailSender[];
  sendersUnread?: string;
} {
  const writes = removalStepsWrites(input.steps);
  const senders = emailSendersOf(stillRunningOf(input.automation, input.plan, writes), { writes });
  const sendersUnread = sendersUnreadOf(input.automation.unread);
  return { senders, ...(sendersUnread !== undefined ? { sendersUnread } : {}) };
}

/** What an act's gate on whether the org delivers its emails came to. */
export interface ActEmailsGate {
  gate: DeliverabilityGate;
  /**
   * `EMAILS_DELIVERED`: the org delivers them, or would not say, and they
   * were not accepted. Absent when the act may go on.
   */
  refusal?: CheckpointRefusal;
}

/**
 * An act's gate on whether the org delivers the emails what still runs
 * sends: Forge's own (`deliverabilityGate`), on the senders and the reading.
 * What an act writes back is the org's own values, never put under
 * `.invalid`: its refusal says the emails go to the addresses the records
 * hold (`keepsAddresses`).
 */
export function actEmailsGate(
  input: ActEmailsInput & {
    senders: readonly EmailSender[];
    sendersUnread?: string;
    reading?: EmailDeliverability;
  },
): ActEmailsGate {
  const quiets =
    input.mayMute && input.plan === undefined && input.senders.length > 0
      ? sendersTheMuteQuiets(input.automation, { writes: removalStepsWrites(input.steps) })
      : [];
  const gate = deliverabilityGate({
    senders: input.senders,
    ...(input.sendersUnread !== undefined ? { sendersUnread: input.sendersUnread } : {}),
    ...(input.reading !== undefined ? { reading: input.reading } : {}),
    accepted: input.accepted,
    target: input.orgName,
    run: input.act,
    muteQuiets: quiets,
    keepsAddresses: true,
  });
  return gate.stop
    ? { gate, refusal: { code: 'EMAILS_DELIVERED', message: gate.stop.message } }
    : { gate };
}

/**
 * Steps 3 and 4 of an act's write path for its emails, then its gate: what
 * may send them once the mute's plan holds, the org's deliverability read
 * only when something may (`deliverabilityOfRun`), and what the gate makes of
 * the two ({@link actEmailsGate}). An act whose writes start nothing that
 * sends sends no request for it.
 *
 * @param input.read - The read, as the user the act writes as
 *   (`readEmailDeliverability` through the act's own counted connection).
 */
export async function actDeliverability(
  input: ActEmailsInput & { read: () => Promise<DeliverabilityRead> },
): Promise<ActEmailsGate & { ofRun: RunDeliverabilityRead }> {
  const writes = removalStepsWrites(input.steps);
  const ofRun = await deliverabilityOfRun({
    running: stillRunningOf(input.automation, input.plan, writes),
    writes,
    read: input.read,
  });
  return {
    ofRun,
    ...actEmailsGate({
      ...input,
      senders: ofRun.senders,
      ...(ofRun.sendersUnread !== undefined ? { sendersUnread: ofRun.sendersUnread } : {}),
      ...(ofRun.read !== undefined ? { reading: ofRun.read.reading } : {}),
    }),
  };
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

/**
 * Step 8 of an act's write path for its emails: once its lease is taken and
 * read back, what then still runs that may send one and that its gate was
 * not told of — what a set the lease does not hold was to keep quiet —
 * refuses it before its first write (`deliverabilityAfterLeaseStop`), unless
 * the emails were accepted or the org withholds them. The act then writes
 * nothing, and gives the lease back.
 *
 * @param input.planned - What may send on the lease's plan ({@link actDeliverability}'s senders).
 * @param input.held - What the lease holds, read back (`HeldMute.outcome`).
 */
export function afterLeaseEmailsRefusal(
  input: Pick<ActEmailsInput, 'act' | 'orgName' | 'automation' | 'steps' | 'accepted'> & {
    plan: Pick<MutePlan, 'assign'>;
    held: Pick<MutedAutomation, 'assigned' | 'held'>;
    planned: readonly EmailSender[];
    reading?: EmailDeliverability;
  },
): CheckpointRefusal | undefined {
  const writes = removalStepsWrites(input.steps);
  const held = emailSendersOf(
    stillRunningOf(input.automation, heldPlanOf(input.plan, input.held), writes),
    { writes },
  );
  const stop = deliverabilityAfterLeaseStop({
    planned: input.planned,
    held,
    ...(input.reading !== undefined ? { reading: input.reading } : {}),
    accepted: input.accepted,
    target: input.orgName,
    run: input.act,
  });
  return stop ? { code: 'EMAILS_DELIVERED', message: stop.message } : undefined;
}
