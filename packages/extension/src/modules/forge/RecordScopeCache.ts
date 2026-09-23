/**
 * Record-scope cache used by Forge to clone only the transitive closure
 * of a root record instead of every row of every table in the graph.
 *
 * As each wave of the topological execution completes, the executor adds
 * the IDs it just queried from the source org. Downstream waves use those
 * IDs to build `WHERE foreignKey IN (...)` clauses so children only follow
 * relationships that actually reach the root.
 *
 * The cache is intentionally per-execution (not persisted) because IDs are
 * source-org coordinates that have no meaning across runs.
 */
export class RecordScopeCache {
  private readonly map = new Map<string, Set<string>>();

  /** Per object already read, the IDs its scope held once the read was done. */
  private readonly readScopes = new Map<string, ReadonlySet<string>>();

  /**
   * Add one or more IDs for a given object API name.
   * Existing IDs are preserved (set semantics) so multiple wave updates
   * compose without overwriting earlier hits.
   */
  add(objectApiName: string, ids: Iterable<string>): void {
    let bucket = this.map.get(objectApiName);
    if (!bucket) {
      bucket = new Set<string>();
      this.map.set(objectApiName, bucket);
    }
    for (const id of ids) {
      if (id) bucket.add(id);
    }
  }

  /**
   * Add the IDs a read of `objectApiName` returned, and settle its scope.
   *
   * An object is read once, and a row read after it can still point back at
   * it: the account of a key contact, the parent an account's `ParentId`
   * names. Such an ID is kept like any other, and {@link get} returns it, but
   * no read will ever fetch the row it names — so it stays out of
   * {@link scopeOf}. Counted there, it made that row a parent in scope, and
   * every child of it was read and cloned under an account the run never
   * wrote.
   */
  addRead(objectApiName: string, ids: Iterable<string>): void {
    this.add(objectApiName, ids);
    this.readScopes.set(objectApiName, new Set(this.map.get(objectApiName)));
  }

  /** Get the set of IDs cached for an object, or undefined if none. */
  get(objectApiName: string): ReadonlySet<string> | undefined {
    return this.map.get(objectApiName);
  }

  /**
   * The IDs of the object's rows that are in scope, the ones a child is read
   * under: every ID cached while the object is still to be read, and once it
   * has been read ({@link addRead}), the IDs its scope held then.
   */
  scopeOf(objectApiName: string): ReadonlySet<string> | undefined {
    return this.readScopes.get(objectApiName) ?? this.map.get(objectApiName);
  }

  /** True when at least one ID is cached for the given object. */
  has(objectApiName: string): boolean {
    const bucket = this.map.get(objectApiName);
    return bucket !== undefined && bucket.size > 0;
  }

  /** Total number of distinct IDs across all objects. */
  get size(): number {
    let total = 0;
    for (const bucket of this.map.values()) {
      total += bucket.size;
    }
    return total;
  }

  /** Number of objects that have at least one cached ID. */
  get objectCount(): number {
    let count = 0;
    for (const bucket of this.map.values()) {
      if (bucket.size > 0) count++;
    }
    return count;
  }

  /** Iterate `[objectApiName, ids]` pairs in insertion order. */
  entries(): IterableIterator<[string, ReadonlySet<string>]> {
    return this.map.entries();
  }

  /** Reset the cache — used between independent forge executions. */
  clear(): void {
    this.map.clear();
    this.readScopes.clear();
  }
}
