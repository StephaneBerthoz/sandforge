import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RollbackEngine } from './RollbackEngine';
import type { BackupResult } from '@sandforge/shared';

function createCompletedBackup(overrides?: Partial<BackupResult>): BackupResult {
  return {
    configId: 'cfg-1',
    operationId: 'op-1',
    status: 'completed',
    objectResults: [
      { objectApiName: 'Account', recordCount: 10, size: 500, status: 'success' },
      { objectApiName: 'Contact', recordCount: 5, size: 200, status: 'success' },
    ],
    totalRecords: 15,
    totalSize: 700,
    filePath: 'backups/test/op-1.json',
    checksum: 'abc12345',
    startTime: '2026-01-01T00:00:00Z',
    endTime: '2026-01-01T00:01:00Z',
    duration: 60000,
    ...overrides,
  };
}

describe('RollbackEngine', () => {
  let engine: RollbackEngine;

  beforeEach(() => {
    engine = new RollbackEngine();
  });

  describe('restore', () => {
    it('should restore all objects from the backup', async () => {
      const insertFn = vi.fn().mockResolvedValue(10);
      const backup = createCompletedBackup();

      const result = await engine.restore(backup, 'target-org', insertFn);

      expect(result.success).toBe(true);
      expect(insertFn).toHaveBeenCalledTimes(2);
    });

    it('should return failure when insertFn throws', async () => {
      const insertFn = vi.fn().mockRejectedValue(new Error('Insert failed'));
      const backup = createCompletedBackup();

      const result = await engine.restore(backup, 'target-org', insertFn);

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('RESTORE_FAILED');
    });

    it('should return failure when targetOrgId is empty', async () => {
      const insertFn = vi.fn();
      const backup = createCompletedBackup();

      const result = await engine.restore(backup, '', insertFn);

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('RESTORE_INVALID_ORG');
    });

    it('should skip objects with failure status', async () => {
      const insertFn = vi.fn().mockResolvedValue(5);
      const backup = createCompletedBackup({
        objectResults: [
          { objectApiName: 'Account', recordCount: 10, size: 500, status: 'success' },
          { objectApiName: 'Contact', recordCount: 0, size: 0, status: 'failure', error: 'oops' },
        ],
      });

      const result = await engine.restore(backup, 'target-org', insertFn);

      expect(result.success).toBe(true);
      expect(insertFn).toHaveBeenCalledTimes(1);
    });

    it('should track progress during restore', async () => {
      const insertFn = vi.fn().mockResolvedValue(10);
      const backup = createCompletedBackup();

      await engine.restore(backup, 'target-org', insertFn);
      const progress = engine.getRestoreProgress();

      expect(progress.completed).toBe(2);
      expect(progress.total).toBe(2);
    });

    it('should stop when cancelled', async () => {
      let callCount = 0;
      const insertFn = vi.fn().mockImplementation(async () => {
        callCount += 1;
        if (callCount === 1) {
          engine.cancel();
        }
        return 5;
      });
      const backup = createCompletedBackup();

      const result = await engine.restore(backup, 'target-org', insertFn);

      expect(result.success).toBe(false);
      expect(result.warnings).toContain('Restore cancelled by user');
    });

    it('should include duration in result', async () => {
      const insertFn = vi.fn().mockResolvedValue(1);
      const backup = createCompletedBackup();

      const result = await engine.restore(backup, 'target-org', insertFn);

      expect(result.duration).toBeGreaterThanOrEqual(0);
      expect(result.timestamp).toBeTruthy();
    });
  });

  describe('verifyBackup', () => {
    it('should return true for a valid completed backup', () => {
      const backup = createCompletedBackup();
      expect(engine.verifyBackup(backup)).toBe(true);
    });

    it('should return false for a backup with empty checksum', () => {
      const backup = createCompletedBackup({ checksum: '' });
      expect(engine.verifyBackup(backup)).toBe(false);
    });

    it('should return false for a non-completed backup', () => {
      const backup = createCompletedBackup({ status: 'failed' });
      expect(engine.verifyBackup(backup)).toBe(false);
    });

    it('should return false for a backup with no object results', () => {
      const backup = createCompletedBackup({ objectResults: [] });
      expect(engine.verifyBackup(backup)).toBe(false);
    });
  });

  describe('getRestoreProgress', () => {
    it('should return zero progress before any restore', () => {
      const progress = engine.getRestoreProgress();
      expect(progress.completed).toBe(0);
      expect(progress.total).toBe(0);
    });
  });
});
