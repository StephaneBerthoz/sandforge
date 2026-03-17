/**
 * Tracks incremental sync state by storing the last sync timestamp
 * per config + object pair. Used by the delta detection system to
 * determine which records have changed since the last sync.
 */
export class IncrementalTracker {
  private readonly timestamps: Map<string, string> = new Map();

  /**
   * Get the last sync timestamp for a config and object combination.
   * Returns undefined if no sync has been recorded.
   */
  getLastSync(configId: string, objectName: string): string | undefined {
    const key = buildKey(configId, objectName);
    return this.timestamps.get(key);
  }

  /**
   * Record a sync completion timestamp for a config and object combination.
   */
  recordSync(configId: string, objectName: string, timestamp: string): void {
    const key = buildKey(configId, objectName);
    this.timestamps.set(key, timestamp);
  }

  /**
   * Reset all tracked timestamps for a config.
   * This forces a full sync on the next run.
   */
  reset(configId: string): void {
    const prefix = `${configId}::`;
    const keysToDelete: string[] = [];

    for (const key of this.timestamps.keys()) {
      if (key.startsWith(prefix)) {
        keysToDelete.push(key);
      }
    }

    for (const key of keysToDelete) {
      this.timestamps.delete(key);
    }
  }
}

/**
 * Build a composite key from configId and objectName.
 */
function buildKey(configId: string, objectName: string): string {
  return `${configId}::${objectName}`;
}
