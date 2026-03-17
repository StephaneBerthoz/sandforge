import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BackupManager } from './BackupManager';
import type { BackupConfig } from '@sandforge/shared';

function createValidConfig(overrides?: Partial<BackupConfig>): BackupConfig {
  return {
    id: 'cfg-1',
    name: 'Daily Backup',
    orgId: 'org-1',
    objects: ['Account', 'Contact'],
    includeAttachments: false,
    includeFiles: false,
    compression: true,
    encryption: false,
    retentionDays: 30,
    createdAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('BackupManager', () => {
  let manager: BackupManager;

  beforeEach(() => {
    manager = new BackupManager();
  });

  describe('createBackup', () => {
    it('should create a backup with completed status when all objects succeed', async () => {
      const queryFn = vi.fn().mockResolvedValue([{ Id: '001' }, { Id: '002' }]);
      const config = createValidConfig();

      const result = await manager.createBackup(config, queryFn);

      expect(result.status).toBe('completed');
      expect(result.configId).toBe('cfg-1');
      expect(result.totalRecords).toBe(4);
      expect(result.objectResults).toHaveLength(2);
      expect(queryFn).toHaveBeenCalledTimes(2);
    });

    it('should return failed status when any object query fails', async () => {
      const queryFn = vi
        .fn()
        .mockResolvedValueOnce([{ Id: '001' }])
        .mockRejectedValueOnce(new Error('Query timeout'));
      const config = createValidConfig();

      const result = await manager.createBackup(config, queryFn);

      expect(result.status).toBe('failed');
      expect(result.objectResults[1].status).toBe('failure');
      expect(result.objectResults[1].error).toBe('Query timeout');
    });

    it('should compute checksum and filePath', async () => {
      const queryFn = vi.fn().mockResolvedValue([]);
      const config = createValidConfig();

      const result = await manager.createBackup(config, queryFn);

      expect(result.checksum).toBeTruthy();
      expect(result.filePath).toContain('Daily_Backup');
    });

    it('should track the operation for later retrieval', async () => {
      const queryFn = vi.fn().mockResolvedValue([]);
      const config = createValidConfig();

      const result = await manager.createBackup(config, queryFn);

      expect(manager.getBackupStatus(result.operationId)).toBe('completed');
      expect(manager.listBackups()).toHaveLength(1);
    });

    it('should calculate duration', async () => {
      const queryFn = vi.fn().mockResolvedValue([]);
      const config = createValidConfig();

      const result = await manager.createBackup(config, queryFn);

      expect(result.duration).toBeGreaterThanOrEqual(0);
      expect(result.startTime).toBeTruthy();
      expect(result.endTime).toBeTruthy();
    });
  });

  describe('getBackupStatus', () => {
    it('should return pending for unknown operation IDs', () => {
      expect(manager.getBackupStatus('nonexistent')).toBe('pending');
    });

    it('should return the correct status for a tracked operation', async () => {
      const queryFn = vi.fn().mockResolvedValue([]);
      const config = createValidConfig();
      const result = await manager.createBackup(config, queryFn);

      expect(manager.getBackupStatus(result.operationId)).toBe('completed');
    });
  });

  describe('deleteBackup', () => {
    it('should remove a tracked backup and return true', async () => {
      const queryFn = vi.fn().mockResolvedValue([]);
      const config = createValidConfig();
      const result = await manager.createBackup(config, queryFn);

      expect(manager.deleteBackup(result.operationId)).toBe(true);
      expect(manager.listBackups()).toHaveLength(0);
    });

    it('should return false for unknown operation IDs', () => {
      expect(manager.deleteBackup('nonexistent')).toBe(false);
    });
  });

  describe('validateConfig', () => {
    it('should return no errors for a valid config', () => {
      const config = createValidConfig();
      expect(manager.validateConfig(config)).toHaveLength(0);
    });

    it('should return error for missing name', () => {
      const config = createValidConfig({ name: '' });
      const errors = manager.validateConfig(config);
      expect(errors).toContain('Backup config must have a name');
    });

    it('should return error for empty objects array', () => {
      const config = createValidConfig({ objects: [] });
      const errors = manager.validateConfig(config);
      expect(errors).toContain('Backup config must include at least one object');
    });

    it('should return error for invalid retention days', () => {
      const config = createValidConfig({ retentionDays: 0 });
      const errors = manager.validateConfig(config);
      expect(errors).toContain('Retention days must be greater than zero');
    });

    it('should return error for scheduled backup without cron', () => {
      const config = createValidConfig({
        schedule: { enabled: true, cron: '', timezone: 'UTC', maxRetries: 3 },
      });
      const errors = manager.validateConfig(config);
      expect(errors).toContain('Scheduled backup must have a cron expression');
    });
  });
});
