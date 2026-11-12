/**
 * A refusal that says the target's automation hit a Salesforce limit.
 *
 * An Apex trigger runs once for the whole call it is fired by: 200 records at
 * a time from the REST API. A trigger that runs a query or a write per
 * record, rather than once for them all, passes the 100 queries or the 150
 * writes a transaction allows on a call large enough, and Salesforce rolls the
 * whole call back. Run for real on a trap org, a trigger that queries once
 * per record had an insert of 200 refused row by row, every one of them, under
 * `CANNOT_INSERT_UPDATE_ACTIVATE_ENTITY` with "<the trigger>:
 * System.LimitException: Too many SOQL queries: 101", and nothing written; the
 * same trigger took 100 in one call. A delete of 116 by one call came back the
 * same, under the same code, nothing deleted. Such a refusal is the call's,
 * not the record's: a writer that tells it from the others sends the rows
 * again in smaller calls (`sendSplittingOnLimits` in the extension).
 *
 * The refusal is told by its text and never by its code, which says nothing:
 * a trigger's limit comes back under `CANNOT_INSERT_UPDATE_ACTIVATE_ENTITY`,
 * on a delete as on an insert, and has been reported under `DELETE_FAILED`,
 * `CANNOT_EXECUTE_FLOW_TRIGGER`, `UNKNOWN_EXCEPTION` or no code at all. Not
 * one: the org's daily API requests (`REQUEST_LIMIT_EXCEEDED`), its storage
 * (`STORAGE_LIMIT_EXCEEDED`), the code `LIMIT_EXCEEDED` with no Apex text, a
 * lock (`UNABLE_TO_LOCK_ROW`), none of which a smaller call cures; nor a
 * trigger's recursion (`Maximum trigger depth`, `Maximum stack depth`), which
 * each record runs into on its own, alone or in a call of 200. Apex's texts
 * stay in English whatever the user's language; a trigger that catches the
 * limit and puts its own error on the record is not told, and is left as it
 * was before.
 */

/**
 * A Salesforce limit an automation's transaction runs into. Unanchored: the
 * text sits in the middle of the trigger's message, after its name.
 */
export const GOVERNOR_LIMIT =
  /System\.LimitException|Too many (?:SOQL queries|SOSL queries|DML statements|DML rows|query rows|future calls|queueable jobs added)|Apex CPU time limit exceeded|Apex heap size too large/i;

/**
 * A trigger's recursion: each record runs into it on its own, and a smaller
 * call does not change it. Tested before {@link GOVERNOR_LIMIT}, since
 * Salesforce reports it as a `System.LimitException` too.
 */
export const NOT_A_BATCH_LIMIT = /Maximum (?:trigger|stack) depth/i;

/**
 * The limits named, in the words {@link limitIn} gives them back, the most
 * telling first. `System.LimitException` alone names none of them.
 */
const LIMIT_PHRASES: readonly string[] = [
  'Too many SOQL queries',
  'Too many SOSL queries',
  'Too many DML statements',
  'Too many DML rows',
  'Too many query rows',
  'Too many future calls',
  'Too many queueable jobs added',
  'Apex CPU time limit exceeded',
  'Apex heap size too large',
];

/** What {@link limitIn} gives when the text names the exception and no limit. */
const LIMIT_EXCEPTION = 'System.LimitException';

/**
 * A text on one line: Apex's messages may run over several ("execution of
 * BeforeDelete\n\ncaused by: System.LimitException…").
 */
function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ');
}

/**
 * The limit the texts of one refused row name — "Too many SOQL queries",
 * "Apex CPU time limit exceeded"… — or `System.LimitException` when they name
 * the exception and no limit; `undefined` when they name none, or name a
 * trigger's recursion in any of them, since that row would be refused again
 * sent alone.
 */
export function limitIn(texts: readonly string[]): string | undefined {
  const lines = texts.map(oneLine);
  if (lines.some((line) => NOT_A_BATCH_LIMIT.test(line))) return undefined;
  for (const line of lines) {
    const lower = line.toLowerCase();
    const phrase = LIMIT_PHRASES.find((named) => lower.includes(named.toLowerCase()));
    if (phrase !== undefined) return phrase;
  }
  return lines.some((line) => GOVERNOR_LIMIT.test(line)) ? LIMIT_EXCEPTION : undefined;
}

/** The trigger a limit's message names, and the event it ran on. */
export interface GovernorLimitAutomation {
  /** The trigger's name, with its namespace when it has one (`ns.Trigger`). */
  automation: string;
  /** `before delete`, `after insert`…, when the message says. */
  event?: string;
}

/** "Acme_Trigger: execution of BeforeDelete": the trigger, then the event it ran on. */
const TRIGGER_EXECUTION =
  /(?<![\w.])([A-Za-z]\w*(?:\.\w+)?): execution of (Before|After)(Insert|Update|Delete|Undelete)/;

/**
 * "CANNOT_INSERT_UPDATE_ACTIVATE_ENTITY: Acme_Trigger: System.LimitException: …":
 * the trigger right before the exception, at the start of the message once
 * its code is read past — the words a trap org answered an insert and a
 * delete with. A status code is never taken for the trigger.
 */
const TRIGGER_BEFORE_EXCEPTION =
  /^(?:[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+:\s*)?(?![A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+:)([A-Za-z]\w*(?:\.\w+)?): System\.LimitException/;

/** "Trigger.Acme_Trigger: line 12, column 1": the line of the stack that names the trigger. */
const TRIGGER_LINE = /Trigger\.([\w.]+?): line \d+/;

/**
 * The trigger a refusal's text names, and the event it ran on when it says;
 * `undefined` when it names none — a Flow's refusal, a message a trigger
 * wrote itself — and the interface speaks of the target's automation. Only
 * the name and the event are kept, never the message.
 */
export function automationOf(text: string): GovernorLimitAutomation | undefined {
  const line = oneLine(text).trim();
  const execution = TRIGGER_EXECUTION.exec(line);
  if (execution) {
    return {
      automation: execution[1],
      event: `${execution[2]} ${execution[3]}`.toLowerCase(),
    };
  }
  const before = TRIGGER_BEFORE_EXCEPTION.exec(line);
  if (before) return { automation: before[1] };
  const stack = TRIGGER_LINE.exec(line);
  return stack ? { automation: stack[1] } : undefined;
}

/** A row's refusal for a limit: the limit, and the trigger that hit it when the texts name one. */
export interface GovernorLimitCause extends Partial<GovernorLimitAutomation> {
  /** As {@link limitIn} gives it. */
  limit: string;
}

/**
 * The limit the texts of one refused row name, with the trigger the first of
 * them to name one; `undefined` when {@link limitIn} finds no limit.
 */
export function limitCauseOf(texts: readonly string[]): GovernorLimitCause | undefined {
  const limit = limitIn(texts);
  if (limit === undefined) return undefined;
  for (const text of texts) {
    const automation = automationOf(text);
    if (automation) return { limit, ...automation };
  }
  return { limit };
}
