/**
 * A target org in miniature for removal tests: rows per object, dated as the
 * org dates them, the child relationships each object lists, a recycle bin,
 * and deletes that take along what cascades from a record — what Forge's
 * removal reads and deletes, and nothing it does not.
 *
 * It reads `SELECT <columns> FROM <Object> WHERE <Field> IN ('a', …)` with an
 * optional `AND IsDeleted = true` and `LIMIT`; anything else throws, so a
 * statement it cannot read never passes for one that selects nothing.
 *
 * Lives under `src/test/`: a helper, not a suite.
 */

import type { RemovalOrg } from '../modules/forge/ForgeRunRemoval.js';

/** A row of the fake org. */
export type MemoryRow = Record<string, unknown> & { Id: string };

/** A child relationship as an object's describe lists it. */
export interface MemoryChild {
  childSObject: string;
  field: string;
  /** Whether a delete of the parent takes the child along. */
  cascadeDelete?: boolean;
}

/** The user the session writes as. */
export const MEMORY_ORG_USER = '005000000000001AAA';

/** See the module's comment. */
export class MemoryRemovalOrg implements RemovalOrg {
  private readonly rows = new Map<string, MemoryRow[]>();
  private readonly bin = new Set<string>();
  /** The rows in the recycle bin, by key, with their object: what an undelete puts back. */
  private readonly binned = new Map<string, { objectApiName: string; row: MemoryRow }>();
  /** Records whose delete the org refuses, with its answer. */
  readonly refuse = new Map<string, string>();
  /** Every delete asked, object and ids, in order. */
  readonly deletes: Array<{ objectApiName: string; ids: string[] }> = [];
  /** Called before each delete: what a test cancels a removal from. */
  beforeDelete?: () => void;

  /** @param children - Per object, the child relationships its describe lists. */
  constructor(private readonly children: Readonly<Record<string, readonly MemoryChild[]>> = {}) {}

  /** Put a row in, dated `at` unless it carries its own dates. */
  add(objectApiName: string, row: MemoryRow, at = new Date().toISOString()): void {
    this.rows.set(objectApiName, [
      ...this.all(objectApiName),
      { CreatedDate: at, LastModifiedDate: at, ...row },
    ]);
  }

  /** The rows of an object still in the org. */
  all(objectApiName: string): MemoryRow[] {
    return this.rows.get(objectApiName) ?? [];
  }

  /** Change a row, as someone does after the run: its modified date moves. */
  touch(objectApiName: string, id: string, at: string): void {
    for (const row of this.all(objectApiName)) {
      if (row.Id === id) row.LastModifiedDate = at;
    }
  }

  async describe(objectApiName: string): Promise<unknown> {
    return {
      name: objectApiName,
      label: objectApiName,
      fields: [],
      childRelationships: (this.children[objectApiName] ?? []).map((child) => ({
        childSObject: child.childSObject,
        field: child.field,
        cascadeDelete: child.cascadeDelete ?? false,
      })),
    };
  }

  async describeGlobal(): Promise<unknown> {
    const names = new Set([
      ...this.rows.keys(),
      ...Object.keys(this.children),
      ...Object.values(this.children).flatMap((list) => list.map((child) => child.childSObject)),
    ]);
    return {
      sobjects: [...names].map((name) => ({
        name,
        label: name,
        queryable: true,
        createable: true,
        layoutable: true,
      })),
    };
  }

  private select(soql: string, deleted: boolean): MemoryRow[] {
    const match =
      /^SELECT (.+) FROM (\w+) WHERE (\w+) IN \((.*?)\)( AND IsDeleted = true)?(?: LIMIT \d+)?$/.exec(
        soql,
      );
    if (!match) throw new Error(`Not a statement the fake org reads: ${soql}`);
    const [, columns, object, field, list, binned] = match;
    const wanted = new Set(list.split(', ').map((quoted) => quoted.slice(1, -1).slice(0, 15)));
    if (binned !== undefined || deleted) {
      return [...this.bin].filter((key) => wanted.has(key)).map((key) => ({ Id: `${key}AAA` }));
    }
    return this.all(object)
      .filter((row) => wanted.has(String(row[field]).slice(0, 15)))
      .map(
        (row) =>
          Object.fromEntries(
            columns.split(', ').map((column) => [column, row[column]]),
          ) as MemoryRow,
      );
  }

  async query(soql: string): Promise<{ totalSize: number; records: unknown[] }> {
    const records = this.select(soql, false);
    return { totalSize: records.length, records };
  }

  async queryDeleted(soql: string): Promise<{ records: unknown[] }> {
    return { records: this.select(soql, true) };
  }

  async update(_objectApiName: string, _records: Array<Record<string, unknown>>): Promise<unknown> {
    return [];
  }

  async serverTime(): Promise<string> {
    return new Date().toISOString();
  }

  async userId(): Promise<string> {
    return MEMORY_ORG_USER;
  }

  async destroy(objectApiName: string, ids: string[]): Promise<unknown> {
    this.beforeDelete?.();
    this.deletes.push({ objectApiName, ids: [...ids] });
    return ids.map((id) => {
      const refusal = this.refuse.get(id);
      if (refusal)
        return { success: false, errors: [{ statusCode: 'DELETE_FAILED', message: refusal }] };
      if (!this.all(objectApiName).some((row) => row.Id === id)) {
        return { success: false, errors: [{ statusCode: 'ENTITY_IS_DELETED', message: 'gone' }] };
      }
      this.remove(objectApiName, id);
      return { id, success: true, errors: [] };
    });
  }

  /** Delete a row to the recycle bin, as someone, or a run, did. */
  trash(objectApiName: string, id: string): void {
    this.remove(objectApiName, id);
  }

  /** Empty a row from the recycle bin: gone for good. */
  purge(id: string): void {
    this.bin.delete(id.slice(0, 15));
    this.binned.delete(id.slice(0, 15));
  }

  /** Take rows out of the recycle bin, as `conn.soap.undelete` does: one answer per id. */
  async undelete(ids: string[]): Promise<unknown> {
    return ids.map((id) => {
      const held = this.binned.get(id.slice(0, 15));
      if (!held) {
        return {
          id,
          success: false,
          errors: [{ statusCode: 'UNDELETE_FAILED', message: 'Entity is not in the recycle bin' }],
        };
      }
      this.purge(id);
      // Dated anew, as modified by the session's user: what a removal's stamps read.
      const row = {
        ...held.row,
        LastModifiedDate: new Date().toISOString(),
        LastModifiedById: MEMORY_ORG_USER,
      };
      this.rows.set(held.objectApiName, [...this.all(held.objectApiName), row]);
      return { id, success: true, errors: [] };
    });
  }

  private remove(objectApiName: string, id: string): void {
    const deleted = this.all(objectApiName).find((held) => held.Id === id);
    if (deleted) this.binned.set(id.slice(0, 15), { objectApiName, row: deleted });
    this.rows.set(
      objectApiName,
      this.all(objectApiName).filter((row) => row.Id !== id),
    );
    this.bin.add(id.slice(0, 15));
    for (const child of this.children[objectApiName] ?? []) {
      if (!child.cascadeDelete) continue;
      for (const row of this.all(child.childSObject)) {
        if (row[child.field] === id) this.remove(child.childSObject, row.Id);
      }
    }
  }
}
