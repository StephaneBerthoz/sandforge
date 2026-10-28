/**
 * The removal tests' org in miniature (`MemoryRemovalOrg`) whose updates are
 * made: each record's fields set, its `SystemModstamp` and `LastModifiedDate`
 * moved to now, to the second, as modified by the session's user, and every
 * update kept in order — what giving back the values a run wrote over sends.
 * A record a test names in `refuseUpdate` is refused with the answer given,
 * and a field a test names in `heldByChildren` is refused while live records
 * of another object name its record. An update that points a lookup at a
 * record in the recycle bin is refused, `ENTITY_IS_DELETED`, as the org
 * refused one live.
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

  /** Every insert asked, object and records, in order. */
  readonly creates: Array<{ objectApiName: string; records: Array<Record<string, unknown>> }> = [];
  /**
   * Why the org refuses to make a record, as a test says, or nothing: a
   * validation rule added since, say.
   */
  refuseCreate?: (
    objectApiName: string,
    record: Readonly<Record<string, unknown>>,
  ) => { statusCode: string; message: string } | undefined;
  /** Records made, to number the ids the org gives them. */
  private made = 0;

  /**
   * Insert records as a REST collection does, one answer per record in their
   * order: each made with a new id of its object's prefix, dated now, to the
   * second, as created and last modified by the session's user. A lookup
   * naming a record of an object the org holds that is no longer live is
   * refused, as the org refuses one: `INVALID_CROSS_REFERENCE_KEY`.
   */
  async create(objectApiName: string, records: Array<Record<string, unknown>>): Promise<unknown> {
    this.requests++;
    this.creates.push({ objectApiName, records: records.map((record) => ({ ...record })) });
    const prefix = this.prefixOf(objectApiName);
    return records.map((record) => {
      const told = this.refuseCreate?.(objectApiName, record);
      if (told) return { success: false, errors: [told] };
      const dangling = Object.entries(record).find(
        ([, value]) => this.namesKnownRecord(value) && !this.isLive(String(value)),
      );
      if (dangling) {
        return {
          success: false,
          errors: [
            {
              statusCode: 'INVALID_CROSS_REFERENCE_KEY',
              message: `invalid cross reference id`,
              fields: [dangling[0]],
            },
          ],
        };
      }
      const id = `${prefix}N${String(++this.made).padStart(11, '0')}AAA`;
      this.add(objectApiName, {
        ...record,
        Id: id,
        CreatedById: MEMORY_ORG_USER,
        LastModifiedById: MEMORY_ORG_USER,
      });
      return { id, success: true, errors: [] };
    });
  }

  /** The key prefix of an object's records, from one it holds or held. */
  private prefixOf(objectApiName: string): string {
    const held = [...this.all(objectApiName), ...this.inBin(objectApiName)][0];
    return held ? held.Id.slice(0, 3) : 'a0X';
  }

  /** Whether `value` is an id of an object whose records the org holds or held. */
  private namesKnownRecord(value: unknown): boolean {
    if (typeof value !== 'string' || !/^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/.test(value)) {
      return false;
    }
    return this.knownPrefixes().has(value.slice(0, 3));
  }

  /** The prefixes of the records the org holds, live or in the bin. */
  private knownPrefixes(): Set<string> {
    const prefixes = new Set<string>();
    for (const name of this.objectNames()) {
      for (const row of [...this.all(name), ...this.inBin(name)]) prefixes.add(row.Id.slice(0, 3));
    }
    return prefixes;
  }

  /** Whether a record of any object is live, by either length of its id. */
  private isLive(id: string): boolean {
    return this.objectNames().some((name) => this.liveRow(name, id) !== undefined);
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
      // A lookup to a record in the recycle bin, refused as the org refused
      // one live, the record left as it was.
      const binned = Object.entries(record).find(
        ([field, value]) => field !== 'Id' && this.namesBinned(value),
      );
      if (binned) {
        return {
          id,
          success: false,
          errors: [
            { statusCode: 'ENTITY_IS_DELETED', message: 'entity is deleted', fields: [binned[0]] },
          ],
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
