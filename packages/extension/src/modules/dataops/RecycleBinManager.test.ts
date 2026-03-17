import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RecycleBinManager } from './RecycleBinManager';

describe('RecycleBinManager', () => {
  let manager: RecycleBinManager;

  beforeEach(() => {
    manager = new RecycleBinManager();
  });

  describe('getDeletedRecords', () => {
    it('should query deleted records with proper SOQL', async () => {
      const queryFn = vi.fn().mockResolvedValue([
        { Id: '001', Name: 'Deleted Account', IsDeleted: true },
      ]);

      const result = await manager.getDeletedRecords('org-1', 'Account', queryFn);

      expect(result).toHaveLength(1);
      expect(queryFn).toHaveBeenCalledWith(
        'SELECT Id, Name, IsDeleted FROM Account WHERE IsDeleted = true ALL ROWS',
      );
    });

    it('should return empty array for empty orgId', async () => {
      const queryFn = vi.fn();

      const result = await manager.getDeletedRecords('', 'Account', queryFn);

      expect(result).toEqual([]);
      expect(queryFn).not.toHaveBeenCalled();
    });

    it('should return empty array for empty objectApiName', async () => {
      const queryFn = vi.fn();

      const result = await manager.getDeletedRecords('org-1', '', queryFn);

      expect(result).toEqual([]);
      expect(queryFn).not.toHaveBeenCalled();
    });
  });

  describe('undelete', () => {
    it('should restore records and return count', async () => {
      const undeleteFn = vi.fn().mockResolvedValue(3);

      const result = await manager.undelete(['001', '002', '003'], undeleteFn);

      expect(result.success).toBe(true);
      expect(result.data?.restoredCount).toBe(3);
    });

    it('should return success with zero count for empty input', async () => {
      const undeleteFn = vi.fn();

      const result = await manager.undelete([], undeleteFn);

      expect(result.success).toBe(true);
      expect(result.data?.restoredCount).toBe(0);
      expect(result.warnings).toContain('No record IDs provided');
    });

    it('should return failure when undeleteFn throws', async () => {
      const undeleteFn = vi.fn().mockRejectedValue(new Error('Undelete error'));

      const result = await manager.undelete(['001'], undeleteFn);

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('UNDELETE_FAILED');
    });

    it('should include duration in result', async () => {
      const undeleteFn = vi.fn().mockResolvedValue(1);

      const result = await manager.undelete(['001'], undeleteFn);

      expect(result.duration).toBeGreaterThanOrEqual(0);
      expect(result.timestamp).toBeTruthy();
    });
  });

  describe('purge', () => {
    it('should purge records and return count', async () => {
      const purgeFn = vi.fn().mockResolvedValue(2);

      const result = await manager.purge(['001', '002'], purgeFn);

      expect(result.success).toBe(true);
      expect(result.data?.purgedCount).toBe(2);
    });

    it('should return success with zero count for empty input', async () => {
      const purgeFn = vi.fn();

      const result = await manager.purge([], purgeFn);

      expect(result.success).toBe(true);
      expect(result.data?.purgedCount).toBe(0);
      expect(result.warnings).toContain('No record IDs provided');
    });

    it('should return failure when purgeFn throws', async () => {
      const purgeFn = vi.fn().mockRejectedValue(new Error('Purge error'));

      const result = await manager.purge(['001'], purgeFn);

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('PURGE_FAILED');
    });

    it('should include duration in result', async () => {
      const purgeFn = vi.fn().mockResolvedValue(1);

      const result = await manager.purge(['001'], purgeFn);

      expect(result.duration).toBeGreaterThanOrEqual(0);
    });
  });
});
