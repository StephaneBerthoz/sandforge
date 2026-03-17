import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SnapshotManager } from './SnapshotManager';
import type { GenerateIdFn } from './SnapshotManager';
import type { MetadataComponentType } from '@sandforge/shared';

describe('SnapshotManager', () => {
  let manager: SnapshotManager;
  let generateId: GenerateIdFn;
  let idCounter: number;

  beforeEach(() => {
    idCounter = 0;
    generateId = vi.fn(() => {
      idCounter++;
      return `snap-${idCounter}`;
    });
    manager = new SnapshotManager(generateId);
  });

  describe('createSnapshot', () => {
    it('should create a snapshot with the correct orgId', async () => {
      const snapshot = await manager.createSnapshot('org-1', 'Test Snapshot', ['ApexClass']);

      expect(snapshot.orgId).toBe('org-1');
    });

    it('should create a snapshot with the correct name', async () => {
      const snapshot = await manager.createSnapshot('org-1', 'My Snapshot', ['Flow']);

      expect(snapshot.name).toBe('My Snapshot');
    });

    it('should assign a unique ID using the generateId function', async () => {
      const snap1 = await manager.createSnapshot('org-1', 'Snap 1', ['ApexClass']);
      const snap2 = await manager.createSnapshot('org-1', 'Snap 2', ['Flow']);

      expect(snap1.id).toBe('snap-1');
      expect(snap2.id).toBe('snap-2');
      expect(generateId).toHaveBeenCalledTimes(2);
    });

    it('should set componentTypes from the provided types', async () => {
      const types: MetadataComponentType[] = ['ApexClass', 'Flow', 'Layout'];
      const snapshot = await manager.createSnapshot('org-1', 'Test', types);

      expect(snapshot.componentTypes).toEqual(types);
    });

    it('should set componentCount to the number of types', async () => {
      const types: MetadataComponentType[] = ['ApexClass', 'Flow', 'Layout'];
      const snapshot = await manager.createSnapshot('org-1', 'Test', types);

      expect(snapshot.componentCount).toBe(3);
    });

    it('should set createdAt to a valid ISO date string', async () => {
      const snapshot = await manager.createSnapshot('org-1', 'Test', ['ApexClass']);

      expect(snapshot.createdAt).toBeDefined();
      expect(new Date(snapshot.createdAt).toISOString()).toBe(snapshot.createdAt);
    });

    it('should set expiresAt approximately 30 days in the future', async () => {
      const before = Date.now();
      const snapshot = await manager.createSnapshot('org-1', 'Test', ['ApexClass']);
      const after = Date.now();

      const expiresMs = new Date(snapshot.expiresAt!).getTime();
      const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;

      expect(expiresMs).toBeGreaterThanOrEqual(before + thirtyDaysMs);
      expect(expiresMs).toBeLessThanOrEqual(after + thirtyDaysMs);
    });

    it('should store the snapshot internally', async () => {
      await manager.createSnapshot('org-1', 'Test', ['ApexClass']);

      expect(manager.size).toBe(1);
    });

    it('should use custom expiry when provided', async () => {
      const customManager = new SnapshotManager(generateId, 60 * 1000);
      const before = Date.now();
      const snapshot = await customManager.createSnapshot('org-1', 'Test', ['ApexClass']);

      const expiresMs = new Date(snapshot.expiresAt!).getTime();
      expect(expiresMs).toBeLessThanOrEqual(before + 60 * 1000 + 100);
    });
  });

  describe('getSnapshots', () => {
    it('should return all snapshots for the given org', async () => {
      await manager.createSnapshot('org-1', 'Snap A', ['ApexClass']);
      await manager.createSnapshot('org-1', 'Snap B', ['Flow']);
      await manager.createSnapshot('org-2', 'Snap C', ['Layout']);

      const snapshots = manager.getSnapshots('org-1');

      expect(snapshots).toHaveLength(2);
      expect(snapshots.every((s) => s.orgId === 'org-1')).toBe(true);
    });

    it('should return an empty array for an org with no snapshots', () => {
      const snapshots = manager.getSnapshots('unknown-org');
      expect(snapshots).toEqual([]);
    });

    it('should not return snapshots from other orgs', async () => {
      await manager.createSnapshot('org-1', 'Snap', ['ApexClass']);

      const snapshots = manager.getSnapshots('org-2');
      expect(snapshots).toEqual([]);
    });
  });

  describe('deleteSnapshot', () => {
    it('should delete an existing snapshot and return true', async () => {
      const snapshot = await manager.createSnapshot('org-1', 'Test', ['ApexClass']);
      const result = manager.deleteSnapshot(snapshot.id);

      expect(result).toBe(true);
      expect(manager.size).toBe(0);
    });

    it('should return false when deleting a non-existent snapshot', () => {
      const result = manager.deleteSnapshot('non-existent');
      expect(result).toBe(false);
    });

    it('should not affect other snapshots', async () => {
      const snap1 = await manager.createSnapshot('org-1', 'Snap 1', ['ApexClass']);
      await manager.createSnapshot('org-1', 'Snap 2', ['Flow']);

      manager.deleteSnapshot(snap1.id);

      expect(manager.size).toBe(1);
      expect(manager.getSnapshots('org-1')).toHaveLength(1);
    });
  });

  describe('cleanExpired', () => {
    it('should remove expired snapshots', async () => {
      const expiredManager = new SnapshotManager(generateId, -1000);
      await expiredManager.createSnapshot('org-1', 'Expired', ['ApexClass']);

      const removed = expiredManager.cleanExpired();

      expect(removed).toBe(1);
      expect(expiredManager.size).toBe(0);
    });

    it('should not remove non-expired snapshots', async () => {
      await manager.createSnapshot('org-1', 'Active', ['ApexClass']);

      const removed = manager.cleanExpired();

      expect(removed).toBe(0);
      expect(manager.size).toBe(1);
    });

    it('should return zero when there are no snapshots', () => {
      const removed = manager.cleanExpired();
      expect(removed).toBe(0);
    });

    it('should only remove expired ones among a mix', async () => {
      const expiredManager = new SnapshotManager(generateId, -1);
      await expiredManager.createSnapshot('org-1', 'Expired 1', ['ApexClass']);
      await expiredManager.createSnapshot('org-1', 'Expired 2', ['Flow']);

      const freshManager = new SnapshotManager(generateId, 999999999);
      await freshManager.createSnapshot('org-1', 'Fresh', ['Layout']);

      const removedExpired = expiredManager.cleanExpired();
      const removedFresh = freshManager.cleanExpired();

      expect(removedExpired).toBe(2);
      expect(removedFresh).toBe(0);
    });
  });

  describe('size', () => {
    it('should return 0 for a new manager', () => {
      expect(manager.size).toBe(0);
    });

    it('should reflect the number of stored snapshots', async () => {
      await manager.createSnapshot('org-1', 'A', ['ApexClass']);
      await manager.createSnapshot('org-1', 'B', ['Flow']);

      expect(manager.size).toBe(2);
    });
  });
});
