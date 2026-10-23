/**
 * The removal tests' org in miniature (`MemoryRemovalOrg`) whose updates are
 * made: each record's fields set, its `SystemModstamp` and `LastModifiedDate`
 * moved to now, to the second, as modified by the session's user, and every
 * update kept in order — what giving back the values a run wrote over sends.
 * A record a test names in `refuseUpdate` is refused with the answer given,
 * and a field a test names in `heldByChildren` is refused while live records
 * of another object name its record.
 *
 * Lives under `src/test/`: a helper, not a suite.
 */

import { MEMORY_ORG_USER, MemoryRemovalOrg } from './memoryRemovalOrg.js';

/** See the module's comment. */
export class MemoryRestoreOrg extends MemoryRemovalOrg {
  /** Every update asked, object and records, in order. */
  readonly updates: Array<{ objectApiName: string; records: Array<Record<string, unknown>> }> = [];
  /** Records whose update the org refuses, with its answer. */
  readonly refuseUpdate = new Map<string, { statusCode: string; message: string }>();
  /**
   * Values a field no longer takes, by field: an update that sends one is
   * refused, naming the field, as a REST collection does — a restricted
   * picklist value deactivated since.
   */
  readonly refuseValue = new Map<string, { value: unknown; statusCode: string; message: string }>();
  /**
   * Fields of an object the org refuses to write while live records of
   * another object name the record, refused naming the fields, as a REST
   * collection does: seen live, an opportunity's price book cannot change
   * while it has products, and its amount is theirs to add up.
   */
  readonly heldByChildren: Array<{
    objectApiName: string;
    fields: readonly string[];
    childSObject: string;
    /** The child's field that names the record. */
    field: string;
    statusCode: string;
    message: string;
  }> = [];

  /** The refusals of {@link heldByChildren} an update of `record` meets now. */
  private heldOf(
    objectApiName: string,
    record: Record<string, unknown>,
  ): Array<{ statusCode: string; message: string; fields: string[] }> {
    const key = String(record.Id).slice(0, 15);
    return this.heldByChildren.flatMap((rule) => {
      if (rule.objectApiName !== objectApiName) return [];
      const fields = rule.fields.filter((field) => field in record);
      if (fields.length === 0) return [];
      const held = this.all(rule.childSObject).some((child) => {
        const parent = child[rule.field];
        return typeof parent === 'string' && parent.slice(0, 15) === key;
      });
      return held ? [{ statusCode: rule.statusCode, message: rule.message, fields }] : [];
    });
  }

  override async update(
    objectApiName: string,
    records: Array<Record<string, unknown>>,
  ): Promise<unknown> {
    this.requests++;
    this.updates.push({ objectApiName, records: records.map((record) => ({ ...record })) });
    return records.map((record) => {
      const id = String(record.Id);
      const refusal = this.refuseUpdate.get(id);
      if (refusal) return { id, success: false, errors: [refusal] };
      const fields = [...this.refuseValue].filter(
        ([field, { value }]) => field in record && record[field] === value,
      );
      if (fields.length > 0) {
        return {
          id,
          success: false,
          errors: fields.map(([field, { statusCode, message }]) => ({
            statusCode,
            message,
            fields: [field],
          })),
        };
      }
      const held = this.heldOf(objectApiName, record);
      if (held.length > 0) return { id, success: false, errors: held };
      const row = this.liveRow(objectApiName, id);
      if (!row) {
        return {
          id,
          success: false,
          errors: [{ statusCode: 'ENTITY_IS_DELETED', message: 'entity is deleted' }],
        };
      }
      // The record keeps its id, whichever length the update named it by.
      Object.assign(row, record, { Id: row.Id });
      this.restamp(row, MEMORY_ORG_USER);
      return { id, success: true, errors: [] };
    });
  }
}
