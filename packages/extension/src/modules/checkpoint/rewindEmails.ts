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
 */

import {
  emailsPerWriteOf,
  type CheckpointEmails,
  type CheckpointRefusal,
  type CheckpointWrite,
  type ForgeEmailLimit,
  type ForgeTargetAutomation,
  type RewindDiffObject,
} from '@sandforge/shared';
import {
  alertsCountAsSingle,
  emailsCountedPerRecord,
  emailsUncountedOf,
  type EmailLimit,
} from '../forge/ForgeRunGate.js';
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
