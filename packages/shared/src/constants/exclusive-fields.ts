/**
 * Field pairs the platform accepts one of, never both.
 *
 * A describe says both fields are createable, because each one is — just not
 * at the same time. Nothing in the metadata expresses "one or the other", so
 * every module that builds an insert payload from the createable set sends
 * both and the write is refused.
 *
 * Run between a real pair of orgs, cloning an Opportunity that carried
 * products failed on all three of its line items with
 * `FIELD_INTEGRITY_EXCEPTION: only one of unit price or total price may be
 * specified`. Any Opportunity with products hits it, which makes it a main
 * path rather than an edge case: a clone that drops the very line items the
 * user wanted is worse than one that stops.
 *
 * The first field of a group wins because it is the one the platform derives
 * the others from — `TotalPrice` is `UnitPrice` × `Quantity`, so keeping the
 * unit price reproduces the total, while keeping the total and losing the
 * unit price does not reproduce the unit price when the quantity is not 1.
 */

/** One set of fields of an object that may not travel together. */
export interface ExclusiveFieldGroup {
  /** SObject the rule applies to. */
  objectApiName: string;
  /** The mutually exclusive fields, the one to keep first. */
  fields: readonly string[];
}

/**
 * The known groups.
 *
 * Both entries are the same documented platform rule on the same field pair;
 * the Opportunity line was the one observed failing against a live org.
 */
export const EXCLUSIVE_FIELD_GROUPS: readonly ExclusiveFieldGroup[] = Object.freeze([
  Object.freeze({
    objectApiName: 'OpportunityLineItem',
    fields: Object.freeze(['UnitPrice', 'TotalPrice']),
  }),
  Object.freeze({
    objectApiName: 'QuoteLineItem',
    fields: Object.freeze(['UnitPrice', 'TotalPrice']),
  }),
]) as readonly ExclusiveFieldGroup[];

/**
 * The fields to leave out of `record` so no exclusive group travels twice.
 *
 * A value counts as present when it is neither `undefined` nor `null`: a
 * record that carries only one of the pair is already valid and nothing is
 * dropped. Returns the names to omit, empty when the record is fine.
 */
export function exclusiveFieldsToDrop(
  objectApiName: string,
  record: Readonly<Record<string, unknown>>,
): string[] {
  const drop: string[] = [];
  for (const group of EXCLUSIVE_FIELD_GROUPS) {
    if (group.objectApiName !== objectApiName) continue;
    const present = group.fields.filter((f) => record[f] !== undefined && record[f] !== null);
    // One value, or none, is not a conflict.
    if (present.length < 2) continue;
    // Keep the first of the group that the record actually carries.
    drop.push(...present.slice(1));
  }
  return drop;
}
