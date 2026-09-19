/**
 * Fields the platform insists on although the describe calls them nullable.
 *
 * `nillable` is the metadata's answer to "may this be left empty", and for a
 * handful of standard objects it is simply wrong: Salesforce enforces the
 * field in its own code at insert, and the describe never mentions it.
 * `OpportunityLineItem.PricebookEntryId` is the one that costs a clone the
 * most — measured against a live org it reads `nillable: true`, and an insert
 * without it is refused with
 * `FIELD_INTEGRITY_EXCEPTION: ... must specify pricebook entry id`.
 *
 * What follows from it is ordering. A lookup that may be left empty can be
 * nullified at insert and repaired by the second pass, so its parent may be
 * written afterwards. One that may not has to be written first, or the child
 * is refused outright and there is nothing left to repair. Believing the
 * describe put an opportunity's line items in the same cycle bucket as the
 * price book entry they could not be written without, and whichever came
 * first was decided by the order the org happened to answer describes in —
 * so the same clone failed or succeeded from one run to the next.
 */

/** Fields a child cannot be inserted without, per object. */
export const PLATFORM_REQUIRED_FIELDS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  // "versions 3.0 and higher must specify pricebook entry id"
  OpportunityLineItem: Object.freeze(['PricebookEntryId']),
  // The same rule on the order side of the catalogue.
  OrderItem: Object.freeze(['PricebookEntryId']),
  // A quote line is priced the same way.
  QuoteLineItem: Object.freeze(['PricebookEntryId']),
});

/**
 * Whether `fieldName` on `objectApiName` has to be filled at insert whatever
 * the describe says.
 */
export function isPlatformRequiredField(objectApiName: string, fieldName: string): boolean {
  // Own keys only: a plain record still inherits `toString` and friends from
  // Object.prototype, and reading one back as a field list is nonsense.
  if (!Object.prototype.hasOwnProperty.call(PLATFORM_REQUIRED_FIELDS, objectApiName)) return false;
  const fields: readonly string[] = PLATFORM_REQUIRED_FIELDS[objectApiName];
  return fields.indexOf(fieldName) !== -1;
}

/**
 * Whether a lookup has to carry a value for the row to be written at all —
 * either because the describe says so, or because the platform does.
 *
 * `nillable` is optional so a caller that cannot say keeps the old
 * behaviour: unknown is read as nullable.
 */
export function isRequiredLookup(
  objectApiName: string,
  fieldName: string,
  nillable: boolean | undefined,
): boolean {
  return nillable === false || isPlatformRequiredField(objectApiName, fieldName);
}
