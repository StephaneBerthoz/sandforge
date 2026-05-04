import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MassDeleteManager } from './MassDeleteManager';
import type { MassDeleteConfig } from '@sandforge/shared';

function createValidConfig(overrides?: Partial<MassDeleteConfig>): MassDeleteConfig {
  return {
    objectApiName: 'Account',
    query: 'SELECT Id FROM Account WHERE CreatedDate < LAST_YEAR',
    hardDelete: false,
    batchSize: 200,
    dryRun: false,
    ...overrides,
  };
}

describe('MassDeleteManager', () => {
  let manager: MassDeleteManager;

  beforeEach(() => {
    manager = new MassDeleteManager();
  });

  describe('execute', () => {
    it('should delete records in batches and return total count', async () => {
      const deleteFn = vi.fn().mockResolvedValue(200);
      const config = createValidConfig();

      const result = await manager.execute(config, deleteFn);

      expect(result.success).toBe(true);
      expect(result.data?.deletedCount).toBeGreaterThan(0);
      expect(deleteFn).toHaveBeenCalled();
    });

    it('should return success with zero deletes in dry run mode', async () => {
      const deleteFn = vi.fn();
      const config = createValidConfig({ dryRun: true });

      const result = await manager.execute(config, deleteFn);

      expect(result.success).toBe(true);
      expect(result.data?.deletedCount).toBe(0);
      expect(result.warnings).toContain('Dry run mode — no records were deleted');
      expect(deleteFn).not.toHaveBeenCalled();
    });

    it('should return failure on validation errors', async () => {
      const deleteFn = vi.fn();
      const config = createValidConfig({ objectApiName: '', query: '' });

      const result = await manager.execute(config, deleteFn);

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('MASS_DELETE_VALIDATION');
    });

    it('should return failure when deleteFn throws', async () => {
      const deleteFn = vi.fn().mockRejectedValue(new Error('Bulk API error'));
      const config = createValidConfig();

      const result = await manager.execute(config, deleteFn);

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('MASS_DELETE_FAILED');
    });

    it('should stop when batch returns less than batchSize', async () => {
      const deleteFn = vi.fn().mockResolvedValueOnce(50);
      const config = createValidConfig({ batchSize: 200 });

      const result = await manager.execute(config, deleteFn);

      expect(result.success).toBe(true);
      expect(deleteFn).toHaveBeenCalledTimes(1);
    });

    it('should stop when cancelled', async () => {
      let callCount = 0;
      const deleteFn = vi.fn().mockImplementation(async () => {
        callCount += 1;
        if (callCount === 1) {
          manager.cancel();
        }
        return 200;
      });
      const config = createValidConfig();

      const result = await manager.execute(config, deleteFn);

      expect(result.warnings).toContain('Operation cancelled by user');
    });

    it('should reject batchSize less than 1', async () => {
      const deleteFn = vi.fn();
      const config = createValidConfig({ batchSize: 0 });

      const result = await manager.execute(config, deleteFn);

      expect(result.success).toBe(false);
      expect(result.error?.message).toContain('batchSize');
    });
  });

  describe('dryRun', () => {
    it('should return the count from countFn', async () => {
      const countFn = vi.fn().mockResolvedValue(1500);
      const config = createValidConfig();

      const count = await manager.dryRun(config, countFn);

      expect(count).toBe(1500);
      expect(countFn).toHaveBeenCalledWith(config.query);
    });
  });

  describe('getProgress', () => {
    it('should return zero progress before execution', () => {
      const progress = manager.getProgress();
      expect(progress.deleted).toBe(0);
      expect(progress.total).toBe(0);
      expect(progress.percentage).toBe(0);
    });

    it('should report progress after execution completes', async () => {
      const deleteFn = vi.fn().mockResolvedValueOnce(50);
      const config = createValidConfig();

      await manager.execute(config, deleteFn);
      const progress = manager.getProgress();

      expect(progress.percentage).toBe(100);
    });
  });
});
