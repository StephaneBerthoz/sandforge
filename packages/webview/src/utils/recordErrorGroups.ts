/**
 * The refusals of a run's records, grouped by what refused them: the status
 * code and the fields it named, with how many records each refused and the
 * first one's words as its example.
 *
 * A results page showed one line per refused record, up to a thousand per
 * object, in the platform's words as they came: fifty identical
 * STANDARD_PRICE_NOT_DEFINED lines read as fifty problems, and the one line
 * that differed was lost among them. Grouped, a run refused for one reason
 * reads as one line with its count.
 *
 * Reads the forms SandForge's writers hand on: `STATUS_CODE: message [Field,
 * Other]` (`formatSaveError`, the REST path, several errors of one record
 * joined by "; "), a Bulk API job's `STATUS_CODE:message:Field Other --`, and
 * a text with no code at all, such as a batch lost after its retries, which is
 * grouped by its words.
 */

/** One reason a run's records were refused. */
export interface RecordErrorGroup {
  /** The status code the refusals carry, or null for a text that names none. */
  code: string | null;
  /** The fields the refusals named, as the first of them named them. */
  fields: string[];
  /** How many of the refusals listed fall in the group. */
  count: number;
  /** The first refusal of the group, as the org worded it. */
  example: string;
}

/** What one refusal says: its code, its message and the fields it named. */
export interface ParsedRecordError {
  code: string | null;
  message: string;
  fields: string[];
}

/** A Bulk API job's `sf__Error`: code, message, then the fields before the closing dashes. */
const BULK_ERROR = /^([A-Z][A-Z0-9_]*):([\s\S]*):([A-Za-z0-9_]+(?: [A-Za-z0-9_]+)*)? ?--$/;

/** `STATUS_CODE: message`, the fields after it in brackets when it named any. */
const CODED_ERROR = /^([A-Z][A-Z0-9_]*):\s*([\s\S]*)$/;

/** The fields listed at the end of a message, as `[Name, StageName]`. */
const TRAILING_FIELDS = /\s*\[([A-Za-z0-9_]+(?:,\s*[A-Za-z0-9_]+)*)\]\s*$/;

/** Where one error of a record ends and the next begins, in the REST path's text. */
const NEXT_ERROR = /; (?=[A-Z][A-Z0-9_]*: )/;

/**
 * What one refusal says. A record refused for several reasons is read by its
 * first: that is the reason the org gave first, and the one the group is of.
 */
export function parseRecordError(text: string): ParsedRecordError {
  const trimmed = text.trim();
  const bulk = BULK_ERROR.exec(trimmed);
  if (bulk) {
    return {
      code: bulk[1],
      message: bulk[2],
      fields: bulk[3] === undefined ? [] : bulk[3].split(' '),
    };
  }
  const first = trimmed.split(NEXT_ERROR)[0];
  const coded = CODED_ERROR.exec(first);
  if (!coded) return { code: null, message: trimmed, fields: [] };
  const message = coded[2];
  const listed = TRAILING_FIELDS.exec(message);
  return {
    code: coded[1],
    message: listed ? message.slice(0, listed.index) : message,
    fields: listed ? listed[1].split(',').map((field) => field.trim()) : [],
  };
}

/**
 * The refusals of a run grouped by code and fields, the group of the most
 * refusals first; two of as many in the order their first refusal came.
 */
export function groupRecordErrors(errors: readonly string[]): RecordErrorGroup[] {
  const groups = new Map<string, RecordErrorGroup>();
  for (const error of errors) {
    const parsed = parseRecordError(error);
    const key =
      parsed.code === null
        ? `text:${parsed.message}`
        : `code:${parsed.code}:${[...parsed.fields].sort().join(',')}`;
    const group = groups.get(key);
    if (group) {
      group.count++;
    } else {
      groups.set(key, { code: parsed.code, fields: parsed.fields, count: 1, example: error });
    }
  }
  // Array.prototype.sort is stable: groups of equal counts keep their order.
  return [...groups.values()].sort((a, b) => b.count - a.count);
}
