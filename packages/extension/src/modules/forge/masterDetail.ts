/**
 * Whether a lookup is a master-detail: a record of the child cannot be written
 * without its parent, and goes with it when the parent is deleted.
 *
 * A describe may say the cascade in two places: on the child's field
 * (`cascadeDelete`, which the describe adapters read as `isMasterDetail`)
 * and in the parent's list of its children. A standard master-detail says it
 * in the list alone: a line item's `OpportunityId` says `cascadeDelete
 * false`, and only the opportunity's list says the delete cascades, as read
 * in a describe of a Developer Edition org, where no standard field said
 * `cascadeDelete true`. A clone of the whole org that read the field alone
 * took the line items for a lookup's children: a sample kept three of an
 * opportunity's four, and said nothing of it.
 *
 * The cascade alone is no master-detail. An account's list of its children
 * says it deletes its contacts, its opportunities and its assets, which may
 * all be left without an account (`nillable`): read as details, an account
 * would bring every contact it has into a sample, past the cap a lookup's
 * children are cut to. Nor is a lookup that may name several objects one: a
 * feed item, a note or an attachment cannot be written without its parent and
 * go with it, but under any of seventy objects and more, and no master sums
 * anything of them. Read in the same describes: a line item, a case comment,
 * an order's or a quote's line, a contact role of an opportunity, and a price
 * book entry each name one object, may not leave it empty, and cascade from
 * it.
 */

import type { ChildRelationship, FieldDescribe } from './GraphDiscoveryService.js';

/** A lookup of a child, as its describe gives it: see {@link isMasterDetailLookup}. */
export type MasterDetailField = Pick<
  FieldDescribe,
  'name' | 'referenceTo' | 'isMasterDetail' | 'nillable'
>;

/** A relation of a parent to one of its children, as the parent's describe lists it. */
export type CascadingRelation = Pick<
  ChildRelationship,
  'childSObject' | 'field' | 'isCascadeDelete'
>;

/**
 * Whether the lookup `field` of `child` is a master-detail: it names one
 * object, it may not be left empty, and the delete of its parent cascades to
 * the child, as the field says it (`isMasterDetail`) or the parent's list of
 * its children does (`parentRelations`, from the parent's describe; absent
 * when the parent was not described, and the field alone then says it).
 */
export function isMasterDetailLookup(
  child: string,
  field: MasterDetailField,
  parentRelations: readonly CascadingRelation[] | undefined,
): boolean {
  if (field.nillable !== false || field.referenceTo.length !== 1) return false;
  return (
    field.isMasterDetail ||
    (parentRelations ?? []).some(
      (relation) =>
        relation.isCascadeDelete &&
        relation.childSObject === child &&
        relation.field === field.name,
    )
  );
}
