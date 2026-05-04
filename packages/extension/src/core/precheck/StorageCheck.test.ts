import { describe, it, expect, vi } from 'vitest';
import { StorageCheck } from './StorageCheck';
import type { FetchStorageFn, StorageData } from './StorageCheck';
import type { PreCheckConfig } from '@sandforge/shared';

function createConfig(overrides?: Partial<PreCheckConfig>): PreCheckConfig {
  return {
    categories: ['storage'],
    skipWarnings: false,
    autoFix: false,
    targetOrgId: 'org-001',
    module: 'sync',
    operationConfig: {},
    ...overrides,
  };
}

function createStorageData(overrides?: Partial<StorageData>): StorageData {
  return {
    dataStorage: { used: 500, limit: 5000 },
    fileStorage: { used: 200, limit: 2000 },
    ...overrides,
  };
}

describe('StorageCheck', () => {
  describe('check', () => {
    it('should return 2 items for data and file storage', async () => {
      const fetchFn: FetchStorageFn = vi.fn().mockResolvedValue(createStorageData());
      const checker = new StorageCheck(fetchFn);
      const items = await checker.check(createConfig());

      expect(items).toHaveLength(2);
    });

    it('should pass data storage check when sufficient', async () => {
      const fetchFn: FetchStorageFn = vi.fn().mockResolvedValue(createStorageData());
      const checker = new StorageCheck(fetchFn);
      const items = await checker.check(
        createConfig({
          operationConfig: { recordCount: 100, avgRecordSizeKb: 2 },
        }),
      );

      const dataItem = items.find((i) => i.name === 'Data Storage');
      expect(dataItem?.passed).toBe(true);
      expect(dataItem?.severity).toBe('info');
    });

    it('should fail data storage check when insufficient', async () => {
      const fetchFn: FetchStorageFn = vi
        .fn()
        .mockResolvedValue(createStorageData({ dataStorage: { used: 4999, limit: 5000 } }));

      const checker = new StorageCheck(fetchFn);
      const items = await checker.check(
        createConfig({
          operationConfig: { recordCount: 10_000, avgRecordSizeKb: 2 },
        }),
      );

      const dataItem = items.find((i) => i.name === 'Data Storage');
      expect(dataItem?.passed).toBe(false);
      expect(dataItem?.severity).toBe('blocker');
    });

    it('should pass file storage check when no file impact', async () => {
      const fetchFn: FetchStorageFn = vi.fn().mockResolvedValue(createStorageData());
      const checker = new StorageCheck(fetchFn);
      const items = await checker.check(createConfig());

      const fileItem = items.find((i) => i.name === 'File Storage');
      expect(fileItem?.passed).toBe(true);
    });

    it('should fail file storage check when insufficient', async () => {
      const fetchFn: FetchStorageFn = vi
        .fn()
        .mockResolvedValue(createStorageData({ fileStorage: { used: 1990, limit: 2000 } }));

      const checker = new StorageCheck(fetchFn);
      const items = await checker.check(
        createConfig({
          operationConfig: { fileStorageImpactMb: 50 },
        }),
      );

      const fileItem = items.find((i) => i.name === 'File Storage');
      expect(fileItem?.passed).toBe(false);
      expect(fileItem?.severity).toBe('blocker');
    });

    it('should warn when data storage usage will exceed 80%', async () => {
      const fetchFn: FetchStorageFn = vi
        .fn()
        .mockResolvedValue(createStorageData({ dataStorage: { used: 3900, limit: 5000 } }));

      const checker = new StorageCheck(fetchFn);
      const items = await checker.check(
        createConfig({
          operationConfig: { recordCount: 100_000, avgRecordSizeKb: 2 },
        }),
      );

      const dataItem = items.find((i) => i.name === 'Data Storage');
      expect(dataItem?.passed).toBe(true);
      expect(dataItem?.severity).toBe('warning');
    });

    it('should error when data storage usage will exceed 95%', async () => {
      const fetchFn: FetchStorageFn = vi
        .fn()
        .mockResolvedValue(createStorageData({ dataStorage: { used: 4700, limit: 5000 } }));

      const checker = new StorageCheck(fetchFn);
      const items = await checker.check(
        createConfig({
          operationConfig: { recordCount: 100_000, avgRecordSizeKb: 2 },
        }),
      );

      const dataItem = items.find((i) => i.name === 'Data Storage');
      expect(dataItem?.severity).toBe('error');
    });

    it('should include StorageCheckDetail in details', async () => {
      const fetchFn: FetchStorageFn = vi.fn().mockResolvedValue(createStorageData());
      const checker = new StorageCheck(fetchFn);
      const items = await checker.check(createConfig());

      const dataItem = items.find((i) => i.name === 'Data Storage');
      expect(dataItem?.details).toHaveProperty('type', 'data');
      expect(dataItem?.details).toHaveProperty('used');
      expect(dataItem?.details).toHaveProperty('limit');
      expect(dataItem?.details).toHaveProperty('estimatedImpact');
      expect(dataItem?.details).toHaveProperty('sufficient');
    });

    it('should set all items to category storage', async () => {
      const fetchFn: FetchStorageFn = vi.fn().mockResolvedValue(createStorageData());
      const checker = new StorageCheck(fetchFn);
      const items = await checker.check(createConfig());

      for (const item of items) {
        expect(item.category).toBe('storage');
      }
    });

    it('should call fetchStorage with correct orgId', async () => {
      const fetchFn: FetchStorageFn = vi.fn().mockResolvedValue(createStorageData());
      const checker = new StorageCheck(fetchFn);
      await checker.check(createConfig({ targetOrgId: 'org-test-99' }));

      expect(fetchFn).toHaveBeenCalledWith('org-test-99');
    });

    it('should use default avgRecordSizeKb of 2 when not specified', async () => {
      const fetchFn: FetchStorageFn = vi
        .fn()
        .mockResolvedValue(createStorageData({ dataStorage: { used: 0, limit: 5000 } }));

      const checker = new StorageCheck(fetchFn);
      const items = await checker.check(
        createConfig({
          operationConfig: { recordCount: 1024 },
        }),
      );

      const dataItem = items.find((i) => i.name === 'Data Storage');
      expect(dataItem?.message).toContain('2.0 MB');
    });

    it('should mark all items as not autoFixable', async () => {
      const fetchFn: FetchStorageFn = vi.fn().mockResolvedValue(createStorageData());
      const checker = new StorageCheck(fetchFn);
      const items = await checker.check(createConfig());

      for (const item of items) {
        expect(item.autoFixable).toBe(false);
      }
    });

    it('should handle zero storage limit without error', async () => {
      const fetchFn: FetchStorageFn = vi.fn().mockResolvedValue(
        createStorageData({
          dataStorage: { used: 0, limit: 0 },
          fileStorage: { used: 0, limit: 0 },
        }),
      );

      const checker = new StorageCheck(fetchFn);
      const items = await checker.check(createConfig());

      expect(items).toHaveLength(2);
    });

    it('should generate unique IDs for each item', async () => {
      const fetchFn: FetchStorageFn = vi.fn().mockResolvedValue(createStorageData());
      const checker = new StorageCheck(fetchFn);
      const items = await checker.check(createConfig());

      const ids = new Set(items.map((i) => i.id));
      expect(ids.size).toBe(items.length);
    });
  });
});
