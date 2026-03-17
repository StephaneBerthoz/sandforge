import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readdir } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { BackupStorage } from './BackupStorage';
import type { BackupMeta } from './BackupStorage';

describe('BackupStorage', () => {
  let tempDir: string;
  let storage: BackupStorage;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'sandforge-backup-test-'));
    storage = new BackupStorage(tempDir);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  const sampleObjects = [
    { objectApiName: 'Account', recordCount: 2 },
    { objectApiName: 'Contact', recordCount: 1 },
  ];

  const sampleRecords = new Map<string, Record<string, unknown>[]>([
    [
      'Account',
      [
        { Id: '001A', Name: 'Acme' },
        { Id: '001B', Name: 'Globex' },
      ],
    ],
    ['Contact', [{ Id: '003A', LastName: 'Smith' }]],
  ]);

  describe('saveBackup', () => {
    it('should save metadata and record files', async () => {
      await storage.saveBackup('op-1', 'org-001', sampleObjects, sampleRecords);

      const meta = await storage.getBackupMeta('op-1');
      expect(meta).toBeDefined();
      expect(meta?.operationId).toBe('op-1');
      expect(meta?.orgId).toBe('org-001');
      expect(meta?.objects).toEqual(sampleObjects);
      expect(meta?.totalRecords).toBe(3);
      expect(meta?.timestamp).toBeTruthy();
    });

    it('should create the backups directory if it does not exist', async () => {
      // Storage points to a path that does not yet have a backups/ subdir
      const freshStorage = new BackupStorage(join(tempDir, 'nested', 'deep'));
      await freshStorage.saveBackup('op-2', 'org-002', [], new Map());

      const meta = await freshStorage.getBackupMeta('op-2');
      expect(meta).toBeDefined();
      expect(meta?.operationId).toBe('op-2');
    });
  });

  describe('getBackupMeta', () => {
    it('should return undefined for a non-existent backup', async () => {
      const meta = await storage.getBackupMeta('nonexistent');
      expect(meta).toBeUndefined();
    });

    it('should return metadata for an existing backup', async () => {
      await storage.saveBackup('op-3', 'org-003', sampleObjects, sampleRecords);

      const meta = await storage.getBackupMeta('op-3');
      expect(meta).toBeDefined();
      expect(meta?.operationId).toBe('op-3');
      expect(meta?.orgId).toBe('org-003');
    });
  });

  describe('getBackupRecords', () => {
    it('should return an empty array for a non-existent backup', async () => {
      const records = await storage.getBackupRecords('nonexistent', 'Account');
      expect(records).toEqual([]);
    });

    it('should return an empty array for a non-existent object', async () => {
      await storage.saveBackup('op-4', 'org-004', sampleObjects, sampleRecords);

      const records = await storage.getBackupRecords('op-4', 'Lead');
      expect(records).toEqual([]);
    });

    it('should return records for an existing object', async () => {
      await storage.saveBackup('op-5', 'org-005', sampleObjects, sampleRecords);

      const accounts = await storage.getBackupRecords('op-5', 'Account');
      expect(accounts).toHaveLength(2);
      expect(accounts[0]).toEqual({ Id: '001A', Name: 'Acme' });

      const contacts = await storage.getBackupRecords('op-5', 'Contact');
      expect(contacts).toHaveLength(1);
      expect(contacts[0]).toEqual({ Id: '003A', LastName: 'Smith' });
    });
  });

  describe('listBackups', () => {
    it('should return an empty array when no backups exist', async () => {
      const backups = await storage.listBackups();
      expect(backups).toEqual([]);
    });

    it('should list all saved backups', async () => {
      await storage.saveBackup('op-a', 'org-a', sampleObjects, sampleRecords);
      await storage.saveBackup('op-b', 'org-b', sampleObjects, sampleRecords);

      const backups = await storage.listBackups();
      expect(backups).toHaveLength(2);

      const ids = backups.map((b: BackupMeta) => b.operationId);
      expect(ids).toContain('op-a');
      expect(ids).toContain('op-b');
    });

    it('should sort backups by timestamp descending', async () => {
      await storage.saveBackup('op-old', 'org-1', sampleObjects, sampleRecords);
      // Small delay to ensure different timestamps
      await new Promise((resolve) => setTimeout(resolve, 10));
      await storage.saveBackup('op-new', 'org-2', sampleObjects, sampleRecords);

      const backups = await storage.listBackups();
      expect(backups[0]?.operationId).toBe('op-new');
      expect(backups[1]?.operationId).toBe('op-old');
    });
  });

  describe('deleteBackup', () => {
    it('should not throw when deleting a non-existent backup', async () => {
      await expect(
        storage.deleteBackup('nonexistent')
      ).resolves.toBeUndefined();
    });

    it('should delete metadata and record files', async () => {
      await storage.saveBackup('op-del', 'org-del', sampleObjects, sampleRecords);

      // Verify backup exists
      const metaBefore = await storage.getBackupMeta('op-del');
      expect(metaBefore).toBeDefined();

      await storage.deleteBackup('op-del');

      // Verify backup is gone
      const metaAfter = await storage.getBackupMeta('op-del');
      expect(metaAfter).toBeUndefined();

      const records = await storage.getBackupRecords('op-del', 'Account');
      expect(records).toEqual([]);
    });

    it('should handle sanitized operationId in delete', async () => {
      await storage.saveBackup('op-special', 'org-s', sampleObjects, sampleRecords);
      const meta = await storage.getBackupMeta('op-special');
      expect(meta).toBeDefined();

      await storage.deleteBackup('op-special');
      const metaAfter = await storage.getBackupMeta('op-special');
      expect(metaAfter).toBeUndefined();
    });

    it('should not affect other backups', async () => {
      await storage.saveBackup('op-keep', 'org-k', sampleObjects, sampleRecords);
      await storage.saveBackup('op-remove', 'org-r', sampleObjects, sampleRecords);

      await storage.deleteBackup('op-remove');

      const kept = await storage.getBackupMeta('op-keep');
      expect(kept).toBeDefined();
      expect(kept?.operationId).toBe('op-keep');

      const removed = await storage.getBackupMeta('op-remove');
      expect(removed).toBeUndefined();
    });
  });

  describe('path traversal prevention', () => {
    it('should sanitize operationId with path traversal characters', async () => {
      await storage.saveBackup('../../malicious', 'org-1', sampleObjects, sampleRecords);

      // File should be safely named inside backups dir
      const files = await readdir(join(tempDir, 'backups'));
      expect(files.every((f) => !f.includes('..'))).toBe(true);
      expect(files.some((f) => f.includes('malicious'))).toBe(true);
    });

    it('should sanitize objectApiName with path separators', async () => {
      const maliciousRecords = new Map<string, Record<string, unknown>[]>([
        ['../../../etc/passwd', [{ Id: '001A' }]],
      ]);

      await storage.saveBackup(
        'safe-op',
        'org-1',
        [{ objectApiName: '../../../etc/passwd', recordCount: 1 }],
        maliciousRecords,
      );

      const files = await readdir(join(tempDir, 'backups'));
      expect(files.every((f) => !f.includes('..'))).toBe(true);
    });

    it('should reject empty operationId after sanitization', async () => {
      await expect(
        storage.saveBackup('', 'org-1', sampleObjects, sampleRecords),
      ).rejects.toThrow('Invalid identifier');
    });
  });
});
