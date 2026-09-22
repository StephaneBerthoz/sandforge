/**
 * Manages ID remapping for cloned records during Forge operations.
 *
 * Tracks old Salesforce ID to new Salesforce ID mappings so that
 * lookup fields in child records can be updated to point to the
 * newly created parent records in the target org.
 */
export class IdRemapper {
  private readonly map = new Map<string, string>();
  /**
   * Source ids whose target is a record the target org already held, not one
   * this run created. Children link to it all the same; the run summary is
   * what has to tell the two apart.
   */
  private readonly existing = new Set<string>();

  /** Register a mapping from old ID to new ID. */
  add(oldId: string, newId: string): void {
    this.map.set(oldId, newId);
    this.existing.delete(oldId);
  }

  /**
   * Register a source record the target org refused because it already holds
   * it, mapped onto that existing record so its children link to it.
   */
  addExisting(oldId: string, existingId: string): void {
    this.map.set(oldId, existingId);
    this.existing.add(oldId);
  }

  /** Whether `oldId` maps onto a record the target already held. */
  isExisting(oldId: string): boolean {
    return this.existing.has(oldId);
  }

  /** Source ids mapped onto records the target already held, in registration order. */
  existingSourceIds(): string[] {
    return [...this.existing];
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
      // Single-lookup pattern (was has() + get(), 2× the cost on
      // hot path of 50K records × 30 lookup fields = 3M lookups).
      if (typeof value === 'string') {
        const newId = this.map.get(value);
        if (newId !== undefined) remapped[field] = newId;
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
    this.existing.clear();
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
      // Defense-in-depth: skip prototype-pollution payloads in case a
      // checkpoint was hand-edited or a future Salesforce field was named
      // `__proto__` (very unlikely, but free to enforce). Map.set is itself
      // immune to proto pollution (vs. obj[k]=v) — the filter is belt-and-
      // suspenders. The typeof key check is dead code (Object.entries
      // always returns string keys) but kept for value safety.
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
      if (typeof value !== 'string') continue;
      remapper.add(key, value);
    }
    return remapper;
  }
}
