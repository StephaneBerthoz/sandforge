/**
 * The second pass of a copy: lookups a record was written without, filled
 * once the record they point at is in the target.
 *
 * A record whose parent is written after it — in a cycle, or further down the
 * same object — goes in with the lookup empty, and the value is owed until
 * the parent has a target id. Forge learnt to pay it back in a second pass;
 * Autopilot, which promised "update in 2nd pass" for every cycle it planned,
 * never did, and a real run left every contact of a cycle without its
 * account. Both collect what they owe here: one update per record, however
 * many of its lookups were left empty.
 */

/** One lookup a written record owes, and the target id it now takes. */
export interface LookupPatch {
  /** The object of the record to update. */
  objectApiName: string;
  /** Target id of the record to update. */
  recordId: string;
  /** The lookup left empty at insert. */
  fieldName: string;
  /** Target id of the record the lookup points at. */
  value: string;
}

/** Whether a patch was taken, and what the record owes instead when it was not. */
export type PatchTaken =
  | { readonly taken: true }
  | { readonly taken: false; readonly kept: unknown };

/** The lookups owed by the records of a run, gathered into one update per record. */
export class LookupPatchSet {
  private readonly byObject = new Map<string, Map<string, Record<string, unknown>>>();

  /**
   * Owe one more lookup. A record already owing the same field another value
   * keeps the first one, and says which: an ambiguous polymorphic lookup is
   * for the caller to report, not to settle by the order the patches came in.
   */
  add(patch: LookupPatch): PatchTaken {
    let records = this.byObject.get(patch.objectApiName);
    if (!records) {
      records = new Map();
      this.byObject.set(patch.objectApiName, records);
    }
    const current = records.get(patch.recordId);
    const kept = current?.[patch.fieldName];
    if (kept !== undefined && kept !== patch.value) return { taken: false, kept };
    const updated = current ?? { Id: patch.recordId };
    updated[patch.fieldName] = patch.value;
    records.set(patch.recordId, updated);
    return { taken: true };
  }

  /** The updates to send, per object: `{ Id, field: value, … }` per record, in the order owed. */
  updates(): Array<[objectApiName: string, records: Array<Record<string, unknown>>]> {
    return [...this.byObject].map(([objectApiName, records]) => [
      objectApiName,
      [...records.values()],
    ]);
  }
}
