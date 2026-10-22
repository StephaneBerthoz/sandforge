/**
 * The removal tests' org in miniature (`MemoryRemovalOrg`) whose updates are
 * made: each record's fields set, its `SystemModstamp` and `LastModifiedDate`
 * moved to now, to the second, as modified by the session's user, and every
 * update kept in order — what giving back the values a run wrote over sends.
 * A record a test names in `refuseUpdate` is refused with the answer given.
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
