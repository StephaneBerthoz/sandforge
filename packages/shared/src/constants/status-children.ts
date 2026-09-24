/** Rows of another object that a record's status past Draft cannot be given back without. */
export interface ChildrenAStatusNeeds {
  /** The object of the rows. */
  readonly object: string;
  /** Their lookup that names the record. */
  readonly lookup: string;
}

/**
 * Objects whose status follows a lifecycle and whose records take their
 * status past Draft back only with rows of another object under them, and
 * those rows.
 *
 * An order past Draft goes in as a draft and is activated once the rest is
 * written, and the platform activates an order only with a product on it.
 * Run for real at the clone's default cap, discovery stopped before the
 * items of an opportunity's orders, and the target refused the two activated
 * ones their status back — "an order must include at least one product" —
 * leaving them drafts. Only what a refused restore named is listed.
 *
 * Kept here rather than with the extension's other status rules: the Forge
 * page says before a run what leaving those rows out costs, and a second copy
 * of the rule there would drift from the one the run applies.
 */
export const STATUS_NEEDS_CHILDREN: Readonly<Record<string, ChildrenAStatusNeeds>> = {
  Order: { object: 'OrderItem', lookup: 'OrderId' },
};
