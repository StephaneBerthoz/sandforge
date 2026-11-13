/**
 * The lookups whose describe says the parent's delete takes the records
 * along — `cascadeDelete`, `restrictedDelete` beside it — where the org was
 * seen to refuse that delete while one lives: one table, read by the emptying
 * (`emptyRelations.ts`) and by the checkpoint and its rewind
 * (`checkpointFields.ts`, `rewindPlan.ts`), which met the same refusal.
 *
 * - an entitlement's account: "Your attempt to delete … could not be
 *   completed because it is associated with the following entitlements"
 *   (`DELETE_FAILED`), on the emptying of a scratch org whose account held
 *   one, its dry run having said the entitlement went along;
 * - an order's account, while the order is activated: "associated with the
 *   following active orders";
 * - an opportunity's account, while it holds a closed won one: "some
 *   opportunities of this account were closed won", in a removal of a clone.
 *
 * A price's product, flagged the same way, takes its standard prices along
 * (seen live): it is no entry here.
 */

/**
 * How the org meets the delete of a parent its describe says takes the
 * records along, where it refuses it while some of them live.
 *
 * - `always`: whatever the records are. The records go before their parent,
 *   as those of a lookup that refuses the delete do, and no undo brings them
 *   back once their parent has gone too (F41);
 * - `pastDraft`: while a record is past Draft. It is set back to Draft before
 *   the first delete, and it then goes along (P8, `setBackToDraftOf`);
 * - `closedWon`: while an opportunity is closed won. Nothing sets it back:
 *   the records that refuse are counted by their `rows` before anything is
 *   deleted, blocking their parent or said beyond Undo. Whether a user the
 *   org lets delete accounts holding them meets it was not seen: the refusal
 *   is read as the org gave it, for anyone.
 */
export type RefusedWhile = 'always' | 'pastDraft' | 'closedWon';

/** One lookup of the table: see the module's comment. */
export interface RefusingCascade {
  child: string;
  field: string;
  parent: string;
  refused: RefusedWhile;
  /**
   * Of an entry nothing is done about before the first delete, the records
   * of `child` that refuse the parent's delete, by a checkbox they hold:
   * they are counted, and said, before anything is deleted.
   */
  rows?: { field: string; value: boolean };
}

/** The table: see the module's comment. */
export const REFUSING_CASCADES: readonly RefusingCascade[] = [
  { child: 'Entitlement', field: 'AccountId', parent: 'Account', refused: 'always' },
  { child: 'Order', field: 'AccountId', parent: 'Account', refused: 'pastDraft' },
  {
    child: 'Opportunity',
    field: 'AccountId',
    parent: 'Account',
    refused: 'closedWon',
    rows: { field: 'IsWon', value: true },
  },
];

/**
 * Whether the org refuses the delete of the record `child`'s `field` names
 * while any record of `child` names it, whatever the describe says — the
 * table's `always` entries — the parent's name checked when given. Names are
 * compared without their case, as the org gives them.
 */
export function alwaysRefused(child: string, field: string, parent?: string): boolean {
  const [c, f, p] = [child, field, parent ?? ''].map((name) => name.toLowerCase());
  return REFUSING_CASCADES.some(
    (entry) =>
      entry.refused === 'always' &&
      entry.child.toLowerCase() === c &&
      entry.field.toLowerCase() === f &&
      (parent === undefined || entry.parent.toLowerCase() === p),
  );
}
