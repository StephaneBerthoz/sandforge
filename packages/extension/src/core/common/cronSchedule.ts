import { CronExpressionParser } from 'cron-parser';
import { extractErrorMessage } from './extractErrorMessage.js';

/**
 * How far ahead a schedule must next fall due. A schedule that runs once a
 * year waits at most 366 days between two runs; the day more leaves room for
 * a clock change in its time zone, so a yearly schedule is never refused
 * because of the day it happens to be checked on.
 */
export const SCHEDULE_HORIZON_MS = 367 * 24 * 60 * 60 * 1000;

/** What the refusal of a schedule that falls due on no date of the coming year says. */
const NO_RUN_WITHIN_A_YEAR =
  'No date in the coming year matches this cron expression: a day of the month its months ' +
  'do not have, such as the 31st of February or April, never comes, and 29 February comes ' +
  'only once in four years.';

/**
 * Why a schedule gives no run: `unknownTimezone` when its time zone is not
 * one this runtime knows, `unreadable` when the parser refuses the expression
 * (with the parser's words), `noRunWithinYear` when it parses but falls due
 * on no date of the coming year.
 */
export interface CronRefusal {
  refused: 'unknownTimezone' | 'unreadable' | 'noRunWithinYear';
  reason: string;
}

/** Whether `timezone` is an IANA time zone this runtime knows. */
export function isKnownTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

/**
 * The first time a cron expression falls due after `after`, in epoch
 * milliseconds, when that is within {@link SCHEDULE_HORIZON_MS}; otherwise
 * why it gives none.
 *
 * The parser checks each field on its own, so `0 0 31 2,4 *` parses: every
 * value is one its field allows, and together they name a day neither month
 * has. Asked for the next run from 23 September 2026, it searched ten
 * thousand days, gave up without saying so, and answered 7 February 2054, a
 * date the expression does not even match. Bounded to a year, the search
 * ends there, and the answer is that nothing falls due.
 *
 * The pipeline triggers, the sync schedules and the check a sync schedule
 * passes before it is saved all ask here for the next run.
 *
 * @param cron - The expression, as saved.
 * @param timezone - The IANA time zone it is read in.
 * @param after - Epoch milliseconds; a run at exactly this instant is not the next one.
 */
export function nextCronRun(cron: string, timezone: string, after: number): number | CronRefusal {
  // Checked first: the parser reports a zone it cannot place as an error
  // about a timestamp, which would pass for a fault in the expression.
  if (!isKnownTimezone(timezone)) {
    return {
      refused: 'unknownTimezone',
      reason: `SandForge does not know the time zone "${timezone}".`,
    };
  }
  let expression: ReturnType<typeof CronExpressionParser.parse>;
  try {
    expression = CronExpressionParser.parse(cron, {
      tz: timezone,
      currentDate: new Date(after),
      endDate: new Date(after + SCHEDULE_HORIZON_MS),
    });
  } catch (err: unknown) {
    return { refused: 'unreadable', reason: extractErrorMessage(err) };
  }
  try {
    return expression.next().getTime();
  } catch {
    // A bounded search throws once it passes its end: nothing fell due before.
    return { refused: 'noRunWithinYear', reason: NO_RUN_WITHIN_A_YEAR };
  }
}
