import type { MetadataComponentType, OrgSnapshot } from '@sandforge/shared';

/** Function signature for generating unique IDs */
export type GenerateIdFn = () => string;

/** Default snapshot expiry in milliseconds (30 days) */
const DEFAULT_EXPIRY_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Manages snapshots of org state for historical comparison.
 * Stores snapshots in memory with configurable expiry and
 * provides cleanup of expired entries.
 */
export class SnapshotManager {
  private readonly snapshots: Map<string, OrgSnapshot> = new Map();
  private readonly generateId: GenerateIdFn;
  private readonly expiryMs: number;

  constructor(generateId: GenerateIdFn, expiryMs: number = DEFAULT_EXPIRY_MS) {
    this.generateId = generateId;
    this.expiryMs = expiryMs;
  }

  /**
   * Create a new snapshot for an org.
   * The snapshot is stored in memory and assigned an expiry date.
   */
  async createSnapshot(
    orgId: string,
    name: string,
    types: MetadataComponentType[]
  ): Promise<OrgSnapshot> {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + this.expiryMs);

    const snapshot: OrgSnapshot = {
      id: this.generateId(),
      orgId,
      name,
      componentTypes: types,
      componentCount: types.length,
      createdAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
    };

    this.snapshots.set(snapshot.id, snapshot);
    return snapshot;
  }

  /** Retrieve all snapshots for a given org */
  getSnapshots(orgId: string): OrgSnapshot[] {
    const result: OrgSnapshot[] = [];
    for (const snapshot of this.snapshots.values()) {
      if (snapshot.orgId === orgId) {
        result.push(snapshot);
      }
    }
    return result;
  }

  /** Delete a snapshot by its ID. Returns true if the snapshot was found and deleted. */
  deleteSnapshot(snapshotId: string): boolean {
    return this.snapshots.delete(snapshotId);
  }

  /** Remove all expired snapshots. Returns the number of snapshots removed. */
  cleanExpired(): number {
    const now = Date.now();
    let removed = 0;

    for (const [id, snapshot] of this.snapshots) {
      if (snapshot.expiresAt && new Date(snapshot.expiresAt).getTime() <= now) {
        this.snapshots.delete(id);
        removed++;
      }
    }

    return removed;
  }

  /** Get total number of stored snapshots */
  get size(): number {
    return this.snapshots.size;
  }
}
