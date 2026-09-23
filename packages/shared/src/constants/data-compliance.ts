/**
 * Bounds of the DataOps compliance and cleanup work that both ends of the
 * bridge read: the page shapes its requests with them, and the extension
 * refuses a request past them.
 */

/**
 * Objects one personal-data inventory, subject search or cleanup scan reads.
 * The same ten a quality scan reads, for the same reason: each object costs a
 * describe and a handful of queries, one object after the other.
 */
export const COMPLIANCE_MAX_OBJECTS = 10;

/**
 * Records an inventory reads per object to see which of the fields the
 * detector named actually hold values, and to find the fields whose values
 * give them away. The last ones by Id: close to the newest records.
 */
export const PII_SAMPLE_SIZE = 200;

/**
 * Records a subject search lists per object. Only the listed records can be
 * exported or erased, so a search that matches more says so.
 */
export const SUBJECT_SEARCH_LIMIT = 200;

/** Fewest digits a phone number to search by must carry. */
export const SUBJECT_PHONE_MIN_DIGITS = 6;

/**
 * Trailing digits a phone search compares. A number is stored as typed —
 * `+33 1 23 45 67 89`, `01.23.45.67.89` — so what two spellings of one number
 * share is their last digits, not their prefix.
 */
export const SUBJECT_PHONE_MATCH_DIGITS = 8;

/** The longest name a subject search accepts: a first and a last name as the org stores them. */
export const SUBJECT_NAME_MAX_LENGTH = 121;

/** Subject requests the local log keeps; the oldest are dropped past it. */
export const SUBJECT_REQUEST_LOG_LIMIT = 500;

/**
 * Records one cleanup export or delete reads. A recommendation that holds
 * more is handled in several runs, each on the records still there.
 */
export const CLEANUP_ACTION_LIMIT = 1000;

/**
 * Share of an object's records that fill a lookup for the business to be
 * taken to rely on it. A lookup nine records in ten carry is one people fill
 * on purpose; the records that leave it empty are the orphans a cleanup lists.
 */
export const ORPHAN_FILL_THRESHOLD = 0.9;

/** The digits of a phone number, whatever it is written with. */
export function phoneDigits(value: string): string {
  return value.replace(/\D/g, '');
}

/**
 * Whether a subject search may use this phone number: enough digits to single
 * out a line rather than a thousand of them.
 */
export function isSubjectPhone(value: string): boolean {
  const digits = phoneDigits(value);
  return digits.length >= SUBJECT_PHONE_MIN_DIGITS && digits.length <= 20 && value.length <= 40;
}

/**
 * Whether a subject search may use this email address: one `@`, a dot in the
 * domain, no space. Both ends hold an address to the same rule, so the page
 * never offers a search the extension refuses.
 */
export function isSubjectEmail(value: string): boolean {
  return value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

/** Whether a subject search may use this name: one line of text, not too long for a record's name. */
export function isSubjectName(value: string): boolean {
  const trimmed = value.trim();
  // A line break or a tab has no place in a record's name.
  const control = [...value].some((character) => character.charCodeAt(0) < 0x20);
  return trimmed.length > 0 && trimmed.length <= SUBJECT_NAME_MAX_LENGTH && !control;
}
