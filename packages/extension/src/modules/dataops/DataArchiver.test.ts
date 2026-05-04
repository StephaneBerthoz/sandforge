import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DataArchiver } from './DataArchiver';

describe('DataArchiver', () => {
  let archiver: DataArchiver;

  beforeEach(() => {
    archiver = new DataArchiver();
  });

  describe('archive', () => {
    it('should archive records and return count', async () => {
      const queryFn = vi.fn().mockResolvedValue([
        { Id: '001', Name: 'A' },
        { Id: '002', Name: 'B' },
      ]);
      const deleteFn = vi.fn().mockResolvedValue(2);

      const result = await archiver.archive(
        'org-1',
        'Account',
        'SELECT Id FROM Account',
        queryFn,
        deleteFn,
      );

      expect(result.success).toBe(true);
      expect(result.data?.archivedCount).toBe(2);
    });

    it('should return failure on validation error', async () => {
      const queryFn = vi.fn();
      const deleteFn = vi.fn();

      const result = await archiver.archive(
        '',
        'Account',
        'SELECT Id FROM Account',
        queryFn,
        deleteFn,
      );

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('ARCHIVE_VALIDATION');
    });

    it('should return failure when query fails', async () => {
      const queryFn = vi.fn().mockRejectedValue(new Error('Query error'));
      const deleteFn = vi.fn();

      const result = await archiver.archive('org-1', 'Account', 'bad query', queryFn, deleteFn);

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('ARCHIVE_QUERY_FAILED');
    });

    it('should return failure when delete fails', async () => {
      const queryFn = vi.fn().mockResolvedValue([{ Id: '001' }]);
      const deleteFn = vi.fn().mockRejectedValue(new Error('Delete error'));

      const result = await archiver.archive(
        'org-1',
        'Account',
        'SELECT Id FROM Account',
        queryFn,
        deleteFn,
      );

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('ARCHIVE_DELETE_FAILED');
    });

    it('should warn when no records match', async () => {
      const queryFn = vi.fn().mockResolvedValue([]);
      const deleteFn = vi.fn();

      const result = await archiver.archive(
        'org-1',
        'Account',
        'SELECT Id FROM Account WHERE Id = null',
        queryFn,
        deleteFn,
      );

      expect(result.success).toBe(true);
      expect(result.data?.archivedCount).toBe(0);
      expect(result.warnings).toContain('No records found matching the query');
    });

    it('should register the archive entry for later listing', async () => {
      const queryFn = vi.fn().mockResolvedValue([{ Id: '001' }]);
      const deleteFn = vi.fn().mockResolvedValue(1);

      await archiver.archive('org-1', 'Account', 'q', queryFn, deleteFn);

      const archives = archiver.listArchives('org-1');
      expect(archives).toHaveLength(1);
      expect(archives[0].objectApiName).toBe('Account');
      expect(archives[0].recordCount).toBe(1);
    });

    it('should accumulate archive size', async () => {
      const queryFn = vi.fn().mockResolvedValue([{ Id: '001', Name: 'Test' }]);
      const deleteFn = vi.fn().mockResolvedValue(1);

      await archiver.archive('org-1', 'Account', 'q', queryFn, deleteFn);

      expect(archiver.getArchiveSize('org-1')).toBeGreaterThan(0);
    });
  });

  describe('getArchiveSize', () => {
    it('should return 0 for unknown org', () => {
      expect(archiver.getArchiveSize('unknown')).toBe(0);
    });
  });

  describe('listArchives', () => {
    it('should return empty array for unknown org', () => {
      expect(archiver.listArchives('unknown')).toEqual([]);
    });

    it('should list multiple archive entries', async () => {
      const queryFn = vi.fn().mockResolvedValue([{ Id: '001' }]);
      const deleteFn = vi.fn().mockResolvedValue(1);

      await archiver.archive('org-1', 'Account', 'q', queryFn, deleteFn);
      await archiver.archive('org-1', 'Contact', 'q', queryFn, deleteFn);

      const archives = archiver.listArchives('org-1');
      expect(archives).toHaveLength(2);
    });
  });
});
