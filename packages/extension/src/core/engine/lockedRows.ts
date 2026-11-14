/**
 * The rows a target refused because it could not lock a record their write
 * needed, sent again: only they, a few times, after a wait that doubles each
 * time.
 *
 * A call commits each of its rows on its own (`allOrNone` false; a Bulk API
 * job, each chunk of its rows), so a row refused so was not written: another
 * transaction held the record — the parent the rows hang from, most often —
 * past the ten seconds the platform waits for one. A job, an integration, the
 * target's own automation still at work on what the run had just written. Sent
 * again once it lets go, the row goes in, and once. Forge sent its rows again
 * (`BatchWriter`); a Sync, a Seed or an Autopilot run left them refused, and
 * the lock's hint said to run again: an insert run again whole wrote every
 * other row of it a second time, and an Autopilot run has no removal to take
 * the first ones back.
 *
 * A row a call answered for is sent again here, never a call that threw: the
 * retry of a call that failed whole is `RetryableOperation`'s.
 */

import type { SaveErrorDetail } from '../common/existingRecordMatch.js';
import { RetryStrategy } from './RetryStrategy.js';

/** The code the target refuses a row with when it could not lock a record the write needed. */
export const LOCK_REFUSAL = 'UNABLE_TO_LOCK_ROW';

/** Times a row refused for a lock is sent again, at most. */
export const RESENDS_OF_A_LOCKED_ROW = 3;

/** The wait before the first of those sends: doubled before each next one, up to half of it left to chance. */
export const LOCKED_ROW_RESEND_DELAY_MS = 2_000;

/**
 * The code a trigger's refusal comes under when the update it made met the
 * lock: `CANNOT_INSERT_UPDATE_ACTIVATE_ENTITY: <trigger>: execution of
 * AfterInsert caused by: System.DmlException: Update failed. First exception
 * on row 0 with id …; first error: UNABLE_TO_LOCK_ROW, unable to obtain
 * exclusive access to this record: []`. The trigger threw, so the platform
 * wrote none of the rows it ran for: the same lock, under another code.
 */
const TRIGGER_REFUSAL = 'CANNOT_INSERT_UPDATE_ACTIVATE_ENTITY';

/** How a trigger's refusal names the lock its update met. */
const LOCK_MET_BY_A_TRIGGER = /\bfirst error: UNABLE_TO_LOCK_ROW\b/;

/** `STATUS_CODE: message`, as REST and the Bulk API both begin a refusal. */
const CODED = /^([A-Z][A-Z0-9_]*):\s*([\s\S]*)$/;

/** Whether one error, by its code and message, is the target's failure to lock a record. */
function isLock(statusCode: string, message: string): boolean {
  return (
    statusCode === LOCK_REFUSAL ||
    (statusCode === TRIGGER_REFUSAL && LOCK_MET_BY_A_TRIGGER.test(message))
  );
}

/**
 * Whether every error a row was refused with is the target's failure to lock
 * a record its write needed: read from the errors' codes when the row carries
 * them, from their text otherwise — `STATUS_CODE: message` over REST,
 * `STATUS_CODE:message:--` from a Bulk API job. A text with no code is no
 * row's refusal: a call that threw is worded so.
 */
export function refusedForALock(
  errors: readonly string[],
  details?: ReadonlyArray<Pick<SaveErrorDetail, 'statusCode' | 'message'>>,
): boolean {
  if (details && details.length > 0) {
    return details.every((detail) => isLock(detail.statusCode, detail.message));
  }
  return (
    errors.length > 0 &&
    errors.every((error) => {
      const coded = CODED.exec(error.trim());
      return coded !== null && isLock(coded[1], coded[2]);
    })
  );
}

/** The waits between the sends: the first {@link LOCKED_ROW_RESEND_DELAY_MS}, then doubled. */
const BACKOFF = new RetryStrategy({ initialDelay: LOCKED_ROW_RESEND_DELAY_MS });

/** The wait before the `resend`-th send again of rows refused for a lock, from 0. */
export function lockResendDelay(resend: number): number {
  return BACKOFF.calculateDelay(resend);
}

/** Wait `ms`, or less when `signal` aborts meanwhile: a cancel does not wait out a resend's delay. */
export function waitUnlessStopped(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const done = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });
}

/** What a row still refused for a lock says after its last send. */
export function stillLockedNote(times: number): string {
  return (
    `sent again ${times === 1 ? 'once' : `${times} times`}, waiting longer each time: ` +
    'the target still could not lock a record the write needed'
  );
}

/** A refusal's text, with what became of the row's sends after it. */
export function withStillLockedNote(text: string, times: number): string {
  return `${text} — ${stillLockedNote(times)}`;
}

/** What {@link sendLockedRowsAgain} came to. */
export interface LockedRowsSentAgain<O> {
  /** Every row's answer, in its place: a row sent again holds its last. */
  outcomes: O[];
  /** Rows refused for a lock at first. */
  refused: number;
  /** Of them, the rows sent again, once or more. */
  sentAgain: number;
  /** Of those, the rows the target took. */
  written: number;
  /** Of those, the rows still refused for a lock after their last send: their answer says so. */
  stillLocked: number;
  /** Rows refused for a lock never sent again: the run was stopped first. */
  notSentAgain: number;
}

/**
 * Send again the rows of `outcomes` refused for a lock, up to
 * {@link RESENDS_OF_A_LOCKED_ROW} times each, after a wait that doubles each
 * time. A row the target then refuses for another reason keeps that answer; one
 * still refused for a lock after its last send says how many times it went
 * (`note`). A stop seen after a wait sends nothing more; a send the stop cut
 * short answers for its first rows only, and the others keep the answer they
 * had.
 *
 * @param rows.send - Sends again the rows at these places, in this order, and
 *   answers for each in the same order; fewer answers when the run's stop cut
 *   it short.
 */
export async function sendLockedRowsAgain<O>(rows: {
  readonly outcomes: readonly O[];
  readonly locked: (outcome: O) => boolean;
  readonly written: (outcome: O) => boolean;
  readonly send: (at: readonly number[]) => Promise<readonly O[]>;
  readonly note: (outcome: O, times: number) => O;
  readonly wait: (ms: number) => Promise<void>;
  readonly stopped: () => boolean;
}): Promise<LockedRowsSentAgain<O>> {
  const outcomes = [...rows.outcomes];
  const times = new Map<number, number>();
  let at = outcomes.flatMap((outcome, i) => (rows.locked(outcome) ? [i] : []));
  const refused = at.length;
  for (let resend = 0; at.length > 0 && resend < RESENDS_OF_A_LOCKED_ROW; resend++) {
    await rows.wait(lockResendDelay(resend));
    if (rows.stopped()) break;
    const sending = at;
    const answers = await rows.send(sending);
    answers.slice(0, sending.length).forEach((answer, k) => {
      outcomes[sending[k]] = answer;
      times.set(sending[k], (times.get(sending[k]) ?? 0) + 1);
    });
    if (answers.length < sending.length) break;
    at = sending.filter((i) => rows.locked(outcomes[i]));
  }
  let written = 0;
  let stillLocked = 0;
  for (const [i, sent] of times) {
    if (rows.written(outcomes[i])) {
      written++;
    } else if (rows.locked(outcomes[i])) {
      stillLocked++;
      outcomes[i] = rows.note(outcomes[i], sent);
    }
  }
  return {
    outcomes,
    refused,
    sentAgain: times.size,
    written,
    stillLocked,
    notSentAgain: refused - times.size,
  };
}

/**
 * What a write says of the rows it sent again for a lock, after what it wrote
 * and of which object: `37 refused because the target could not lock a record
 * their write needed (UNABLE_TO_LOCK_ROW), sent again up to 3 times, waiting
 * longer each time: 35 written, 2 still refused for the lock`. Nothing when no
 * row was refused so.
 *
 * @param what - What the rows are: `row(s)`, `record(s)`.
 */
export function lockedRowsLine(
  what: string,
  again: Omit<LockedRowsSentAgain<unknown>, 'outcomes'>,
): string | undefined {
  if (again.refused === 0) return undefined;
  const otherwise = again.sentAgain - again.written - again.stillLocked;
  const parts = [
    `${again.written} written`,
    ...(again.stillLocked > 0 ? [`${again.stillLocked} still refused for the lock`] : []),
    ...(otherwise > 0 ? [`${otherwise} refused for another reason`] : []),
    ...(again.notSentAgain > 0
      ? [`${again.notSentAgain} not sent again: the run was stopped`]
      : []),
  ];
  return (
    `${again.refused} ${what} refused because the target could not lock a record their write ` +
    `needed (${LOCK_REFUSAL}), sent again up to ${RESENDS_OF_A_LOCKED_ROW} times, waiting ` +
    `longer each time: ${parts.join(', ')}`
  );
}
