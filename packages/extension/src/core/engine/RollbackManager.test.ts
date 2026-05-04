import { describe, it, expect, beforeEach, vi } from 'vitest';
import { RollbackManager } from './RollbackManager';
import type { RollbackExecutor } from './RollbackManager';

describe('RollbackManager', () => {
  let manager: RollbackManager;

  beforeEach(() => {
    manager = new RollbackManager();
  });

  describe('createSavepoint', () => {
    it('should create a savepoint with pending status', () => {
      const sp = manager.createSavepoint('op-1', 'Account', ['001a', '001b']);

      expect(sp.id).toBeDefined();
      expect(sp.operationId).toBe('op-1');
      expect(sp.objectName).toBe('Account');
      expect(sp.recordIds).toEqual(['001a', '001b']);
      expect(sp.status).toBe('pending');
      expect(sp.createdAt).toBeDefined();
    });

    it('should generate unique IDs', () => {
      const sp1 = manager.createSavepoint('op-1', 'Account', ['001a']);
      const sp2 = manager.createSavepoint('op-1', 'Contact', ['003a']);

      expect(sp1.id).not.toBe(sp2.id);
    });

    it('should not mutate the original recordIds array', () => {
      const ids = ['001a', '001b'];
      const sp = manager.createSavepoint('op-1', 'Account', ids);

      ids.push('001c');
      expect(sp.recordIds).toHaveLength(2);
    });
  });

  describe('rollback', () => {
    it('should rollback successfully', async () => {
      const sp = manager.createSavepoint('op-1', 'Account', ['001a', '001b']);
      const executor: RollbackExecutor = vi.fn().mockResolvedValue({
        success: ['001a', '001b'],
        failed: [],
      });

      const result = await manager.rollback(sp, executor);

      expect(result.status).toBe('completed');
      expect(result.rolledBackCount).toBe(2);
      expect(result.failedCount).toBe(0);
      expect(result.errors).toHaveLength(0);
    });

    it('should handle partial rollback', async () => {
      const sp = manager.createSavepoint('op-1', 'Account', ['001a', '001b']);
      const executor: RollbackExecutor = vi.fn().mockResolvedValue({
        success: ['001a'],
        failed: [{ id: '001b', error: 'ENTITY_IS_DELETED' }],
      });

      const result = await manager.rollback(sp, executor);

      expect(result.status).toBe('completed');
      expect(result.rolledBackCount).toBe(1);
      expect(result.failedCount).toBe(1);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain('001b');
    });

    it('should handle complete failure', async () => {
      const sp = manager.createSavepoint('op-1', 'Account', ['001a']);
      const executor: RollbackExecutor = vi.fn().mockResolvedValue({
        success: [],
        failed: [{ id: '001a', error: 'INSUFFICIENT_ACCESS' }],
      });

      const result = await manager.rollback(sp, executor);

      expect(result.status).toBe('failed');
      expect(result.rolledBackCount).toBe(0);
      expect(result.failedCount).toBe(1);
    });

    it('should handle executor throwing an error', async () => {
      const sp = manager.createSavepoint('op-1', 'Account', ['001a']);
      const executor: RollbackExecutor = vi.fn().mockRejectedValue(new Error('Network error'));

      const result = await manager.rollback(sp, executor);

      expect(result.status).toBe('failed');
      expect(result.rolledBackCount).toBe(0);
      expect(result.failedCount).toBe(1);
      expect(result.errors[0]).toContain('Network error');
    });

    it('should return failed for unknown savepoint', async () => {
      const fakeSp = {
        id: 'sp-unknown',
        operationId: 'op-1',
        objectName: 'Account',
        recordIds: [],
        createdAt: new Date().toISOString(),
        status: 'pending' as const,
      };
      const executor: RollbackExecutor = vi.fn();

      const result = await manager.rollback(fakeSp, executor);

      expect(result.status).toBe('failed');
      expect(result.errors[0]).toContain('not found');
      expect(executor).not.toHaveBeenCalled();
    });

    it('should update savepoint status during rollback', async () => {
      const sp = manager.createSavepoint('op-1', 'Account', ['001a']);
      const executor: RollbackExecutor = vi.fn().mockResolvedValue({
        success: ['001a'],
        failed: [],
      });

      await manager.rollback(sp, executor);

      const tracked = manager.getSavepoint(sp.id);
      expect(tracked?.status).toBe('completed');
    });
  });

  describe('getSavepoints', () => {
    it('should return all savepoints for an operation', () => {
      manager.createSavepoint('op-1', 'Account', ['001a']);
      manager.createSavepoint('op-1', 'Contact', ['003a']);
      manager.createSavepoint('op-2', 'Lead', ['00Qa']);

      const savepoints = manager.getSavepoints('op-1');
      expect(savepoints).toHaveLength(2);
    });

    it('should return empty array for unknown operation', () => {
      expect(manager.getSavepoints('nonexistent')).toEqual([]);
    });
  });

  describe('getSavepoint', () => {
    it('should return a savepoint by ID', () => {
      const sp = manager.createSavepoint('op-1', 'Account', ['001a']);
      expect(manager.getSavepoint(sp.id)).toBeDefined();
      expect(manager.getSavepoint(sp.id)?.objectName).toBe('Account');
    });

    it('should return undefined for unknown ID', () => {
      expect(manager.getSavepoint('sp-unknown')).toBeUndefined();
    });
  });

  describe('clear', () => {
    it('should clear all savepoints for an operation', () => {
      manager.createSavepoint('op-1', 'Account', ['001a']);
      manager.createSavepoint('op-1', 'Contact', ['003a']);
      manager.createSavepoint('op-2', 'Lead', ['00Qa']);

      manager.clear('op-1');

      expect(manager.getSavepoints('op-1')).toHaveLength(0);
      expect(manager.getSavepoints('op-2')).toHaveLength(1);
    });

    it('should handle clearing unknown operation', () => {
      expect(() => manager.clear('nonexistent')).not.toThrow();
    });
  });

  describe('clearAll', () => {
    it('should clear all savepoints', () => {
      manager.createSavepoint('op-1', 'Account', ['001a']);
      manager.createSavepoint('op-2', 'Contact', ['003a']);

      manager.clearAll();

      expect(manager.totalSavepoints).toBe(0);
    });
  });

  describe('totalSavepoints', () => {
    it('should return the total number of savepoints', () => {
      expect(manager.totalSavepoints).toBe(0);

      manager.createSavepoint('op-1', 'Account', ['001a']);
      expect(manager.totalSavepoints).toBe(1);

      manager.createSavepoint('op-1', 'Contact', ['003a']);
      expect(manager.totalSavepoints).toBe(2);
    });
  });
});
