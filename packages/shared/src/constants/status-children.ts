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

/** Rows of another object the platform will not delete under a record past Draft. */
export interface LockedPastDraft {
  /** The object of the rows. */
  readonly object: string;
  /** Their lookup that names the record. */
  readonly lookup: string;
}

/**
 * Objects whose status follows a lifecycle and whose records, past Draft,
 * lock rows of other objects under them: the platform refuses to delete those
 * rows for as long as the record keeps its status.
 *
 * Run for real, a removal kept two activated orders — the org had attached a
 * file to each on its activation — and still sent the deletes of their items,
 * refused "unable to modify activated or superseded order", and of their
 * actions, refused `ENTITY_IS_LOCKED`.
 *
 * On a real sandbox, the one row under an activated contract the org would
 * not delete was its item price — `INVALID_INPUT`, "vous ne pouvez pas
 * supprimer un prix de l'élément du contrat dans un contrat actif" — and it
 * took one under a contract still in Draft. It deleted the rest hanging from
 * the activated contract: an order in Draft, a contact role, an opportunity
 * and a quote naming it, a task, an event, a note, an attachment, a file's
 * link, feed items. It deleted the activated contract too, and its item
 * prices with it. Only what a real refusal named is listed.
 *
 * Kept here rather than with the extension's other status rules: the Forge
 * page says before a run which objects may refuse the removal of its records,
 * and a second copy there would drift from the one the removal applies.
 */
export const LOCKED_PAST_DRAFT: Readonly<Record<string, readonly LockedPastDraft[]>> = {
  Order: [
    { object: 'OrderItem', lookup: 'OrderId' },
    { object: 'OrderAction', lookup: 'OrderId' },
  ],
  Contract: [{ object: 'ContractItemPrice', lookup: 'ContractId' }],
};
