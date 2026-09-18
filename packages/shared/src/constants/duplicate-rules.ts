/**
 * Telling Salesforce that a clone is a deliberate duplicate.
 *
 * A sandbox is a copy of the org it was made from, so the records a clone
 * writes look exactly like records that are already there — which is what a
 * duplicate rule exists to stop. Run against a real pair of orgs, every clone
 * of an Account failed with `DUPLICATES_DETECTED` before writing anything, and
 * because the root failed the whole graph below it was skipped. All seventeen
 * accounts of the source org were already in the target: not an edge case, the
 * main one.
 *
 * Salesforce provides for exactly this. The REST sObject Collections endpoint
 * — the one the writers use — takes a header that says "I know, save it
 * anyway", and it applies to duplicate RULES only. A unique index
 * (`DUPLICATE_VALUE`) is a constraint, not a rule, and still refuses the
 * write; that is the correct outcome and this does not touch it.
 *
 * Off by default nowhere: a clone is a request to duplicate something, so the
 * writers send it unless a caller says otherwise. What protects a production
 * org is the production guard, not a data-quality rule the user is asking to
 * work around on their own sandbox.
 */

/** The header Salesforce reads, and the value that lets a duplicate through. */
export const ALLOW_DUPLICATE_RULE_HEADER: Readonly<Record<string, string>> = Object.freeze({
  'Sforce-Duplicate-Rule-Header': 'allowSave=true',
});

/**
 * The write headers for a clone, given whether duplicate rules may be bypassed.
 * `{}` when they may not, so a caller can always spread the result.
 */
export function duplicateRuleHeaders(allowDuplicates: boolean): Record<string, string> {
  return allowDuplicates ? { ...ALLOW_DUPLICATE_RULE_HEADER } : {};
}

/**
 * Salesforce's marker for a record a duplicate RULE refused.
 *
 * Distinct from `DUPLICATE_VALUE`, which is a unique index and is not
 * bypassable. Frozen Dataset already knew this code; Forge did not, and had no
 * way to tell a user that one flag would let the run through.
 */
export const DUPLICATE_RULE_ERROR = 'DUPLICATES_DETECTED';

/** Whether `message` is a duplicate rule refusing a record. */
export function isDuplicateRuleError(message: string): boolean {
  return message.includes(DUPLICATE_RULE_ERROR);
}

/**
 * Salesforce's marker for a row a unique index refused: the target already
 * holds it.
 *
 * Unlike a duplicate RULE this cannot be waved through, and should not be —
 * the record is there. What follows from it is the point: a parent that failed
 * only this way has not orphaned anything, because the thing its children
 * point at exists. Run between two real sandboxes, a `ProductSellingModel`
 * the target already had took every `PricebookEntry` down with it, and every
 * opportunity line item behind those.
 */
export const ALREADY_EXISTS_ERROR = 'DUPLICATE_VALUE';

/** Whether `message` is the target refusing a row it already holds. */
export function isAlreadyExistsError(message: string): boolean {
  return message.includes(ALREADY_EXISTS_ERROR);
}
