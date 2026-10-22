/**
 * The removal tests' org in miniature (`MemoryRemovalOrg`) whose updates are
 * made: each record's fields set, its modified date moved to now, and every
 * update kept in order — what giving back the values a run wrote over sends.
 * A record a test names in `refuseUpdate` is refused with the answer given.
 *
 * Lives under `src/test/`: a helper, not a suite.
 */

import { MemoryRemovalOrg } from './memoryRemovalOrg.js';

/** See the module's comment. */
export class MemoryRestoreOrg extends MemoryRemovalOrg {
  /** Every update asked, object and records, in order. */
  readonly updates: Array<{ objectApiName: string; records: Array<Record<string, unknown>> }> = [];
  /** Records whose update the org refuses, with its answer. */
  readonly refuseUpdate = new Map<string, { statusCode: string; message: string }>();

  override async update(
    objectApiName: string,
    records: Array<Record<string, unknown>>,
  ): Promise<unknown> {
    this.updates.push({ objectApiName, records: records.map((record) => ({ ...record })) });
    const at = new Date().toISOString();
    return records.map((record) => {
      const id = String(record.Id);
      const refusal = this.refuseUpdate.get(id);
      if (refusal) return { id, success: false, errors: [refusal] };
      const row = this.all(objectApiName).find((held) => held.Id === id);
      if (!row) {
        return {
          id,
          success: false,
          errors: [{ statusCode: 'ENTITY_IS_DELETED', message: 'entity is deleted' }],
        };
      }
      Object.assign(row, record, { LastModifiedDate: at });
      return { id, success: true, errors: [] };
    });
  }
}
