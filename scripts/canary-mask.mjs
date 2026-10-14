/**
 * What the canary may print. Kept apart from `canary.mjs`, which runs as it
 * is loaded, so the rule can be tested without an org.
 */

/**
 * A Salesforce id: 15 or 18 letters and digits, at least one a digit (a word
 * of fifteen letters is not one; a number of fifteen digits may be). Masked in
 * anything the canary prints, whatever printed it: the counts it reports
 * carry none, but an org's error message can, and the canary's log is public
 * when it runs in CI.
 */
const SALESFORCE_ID = /\b(?=[A-Za-z0-9]*\d)[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?\b/g;

/** `text` with every Salesforce id in it replaced by `<id>`. */
export const maskIds = (text) => String(text).replace(SALESFORCE_ID, '<id>');

/**
 * `text` as one cell of the report's Markdown table. A backslash is doubled
 * before a pipe is escaped: escaping the pipe alone turned a detail ending in
 * `\` followed by `|` into an escaped backslash and a bare pipe, which split
 * the row. A line break would end the row, so it becomes a space.
 */
export const tableCell = (text) =>
  String(text).replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
