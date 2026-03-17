/**
 * Manages ID remapping for cloned records during Forge operations.
 *
 * Tracks old Salesforce ID to new Salesforce ID mappings so that
 * lookup fields in child records can be updated to point to the
 * newly created parent records in the target org.
 */
export class IdRemapper {
  private readonly map = new Map<string, string>();

  /** Register a mapping from old ID to new ID. */
  add(oldId: string, newId: string): void {
    this.map.set(oldId, newId);
  }

  /** Get the new ID for an old ID. Returns undefined if not mapped. */
  get(oldId: string): string | undefined {
    return this.map.get(oldId);
  }

  /**
   * Remap all lookup fields in a record.
   * For each field in lookupFields, if the value is a string that
   * exists in the map, it is replaced with the new ID.
   * Non-string values and unmapped IDs are left unchanged.
   */
  remapRecord(record: Record<string, unknown>, lookupFields: string[]): Record<string, unknown> {
    const remapped = { ...record };
    for (const field of lookupFields) {
      const value = remapped[field];
      if (typeof value === 'string' && this.map.has(value)) {
        remapped[field] = this.map.get(value);
      }
    }
    return remapped;
  }

  /** Get total number of remapped IDs. */
  get count(): number {
    return this.map.size;
  }

  /** Clear all mappings. */
  clear(): void {
    this.map.clear();
  }

  /** Serialize all mappings to a plain object for checkpoint persistence. */
  toJSON(): Record<string, string> {
    const result: Record<string, string> = {};
    for (const [key, value] of this.map) {
      result[key] = value;
    }
    return result;
  }

  /** Restore an IdRemapper from a serialized plain object. */
  static fromJSON(data: Record<string, string>): IdRemapper {
    const remapper = new IdRemapper();
    for (const [key, value] of Object.entries(data)) {
      remapper.add(key, value);
    }
    return remapper;
  }
}
