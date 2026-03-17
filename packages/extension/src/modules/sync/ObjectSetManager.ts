/** A reusable set of Salesforce object API names */
export interface ObjectSet {
  id: string;
  name: string;
  objects: string[];
  createdAt: string;
}

/**
 * Manages reusable sets of Salesforce objects for sync configurations.
 * Allows creating, retrieving, listing, and deleting named object groups
 * that can be shared across multiple sync configs.
 */
export class ObjectSetManager {
  private readonly sets: Map<string, ObjectSet> = new Map();
  private idCounter = 0;

  /**
   * Create a new named object set.
   * Returns the created ObjectSet with a unique ID and timestamp.
   */
  create(name: string, objects: string[]): ObjectSet {
    this.idCounter++;
    const id = `objset-${this.idCounter}`;

    const objectSet: ObjectSet = {
      id,
      name,
      objects: [...objects],
      createdAt: new Date().toISOString(),
    };

    this.sets.set(id, objectSet);
    return objectSet;
  }

  /**
   * Retrieve an object set by ID.
   * Returns the ObjectSet if found, undefined otherwise.
   */
  get(id: string): ObjectSet | undefined {
    return this.sets.get(id);
  }

  /**
   * List all stored object sets.
   */
  list(): ObjectSet[] {
    return [...this.sets.values()];
  }

  /**
   * Delete an object set by ID.
   * Returns true if the set was found and removed, false otherwise.
   */
  delete(id: string): boolean {
    return this.sets.delete(id);
  }
}
