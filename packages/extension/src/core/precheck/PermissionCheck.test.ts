import { describe, it, expect, vi } from 'vitest';
import { PermissionCheck } from './PermissionCheck';
import type { FetchPermissionsFn, PermissionData } from './PermissionCheck';
import type { PreCheckConfig } from '@sandforge/shared';

function createConfig(overrides?: Partial<PreCheckConfig>): PreCheckConfig {
  return {
    categories: ['permissions'],
    skipWarnings: false,
    autoFix: false,
    targetOrgId: 'org-001',
    module: 'sync',
    operationConfig: {},
    ...overrides,
  };
}

function createPermissionData(overrides?: Partial<PermissionData>): PermissionData {
  return {
    objectPermissions: [],
    hasModifyAllData: true,
    hasViewAllData: true,
    hasBulkApiPermission: true,
    ...overrides,
  };
}

describe('PermissionCheck', () => {
  describe('check', () => {
    it('should return passing items when all permissions are granted', async () => {
      const fetchFn: FetchPermissionsFn = vi.fn().mockResolvedValue(
        createPermissionData({
          objectPermissions: [{
            objectApiName: 'Account',
            crudPermissions: { create: true, read: true, update: true, delete: true },
            missingFieldPermissions: [],
          }],
        })
      );

      const checker = new PermissionCheck(fetchFn);
      const items = await checker.check(createConfig());

      const crudItem = items.find((i) => i.name.includes('CRUD') && i.name.includes('Account'));
      expect(crudItem?.passed).toBe(true);
      expect(crudItem?.severity).toBe('info');
    });

    it('should detect missing CRUD permissions', async () => {
      const fetchFn: FetchPermissionsFn = vi.fn().mockResolvedValue(
        createPermissionData({
          objectPermissions: [{
            objectApiName: 'Contact',
            crudPermissions: { create: false, read: true, update: false, delete: true },
            missingFieldPermissions: [],
          }],
        })
      );

      const checker = new PermissionCheck(fetchFn);
      const items = await checker.check(createConfig());

      const crudItem = items.find((i) => i.name.includes('CRUD') && i.name.includes('Contact'));
      expect(crudItem?.passed).toBe(false);
      expect(crudItem?.severity).toBe('error');
      expect(crudItem?.message).toContain('Create');
      expect(crudItem?.message).toContain('Update');
    });

    it('should detect missing field-level security', async () => {
      const fetchFn: FetchPermissionsFn = vi.fn().mockResolvedValue(
        createPermissionData({
          objectPermissions: [{
            objectApiName: 'Account',
            crudPermissions: { create: true, read: true, update: true, delete: true },
            missingFieldPermissions: ['AnnualRevenue', 'Industry'],
          }],
        })
      );

      const checker = new PermissionCheck(fetchFn);
      const items = await checker.check(createConfig());

      const flsItem = items.find((i) => i.name.includes('Field-level'));
      expect(flsItem?.passed).toBe(false);
      expect(flsItem?.severity).toBe('error');
      expect(flsItem?.message).toContain('AnnualRevenue');
      expect(flsItem?.message).toContain('Industry');
    });

    it('should not create FLS item when no field permissions are missing', async () => {
      const fetchFn: FetchPermissionsFn = vi.fn().mockResolvedValue(
        createPermissionData({
          objectPermissions: [{
            objectApiName: 'Account',
            crudPermissions: { create: true, read: true, update: true, delete: true },
            missingFieldPermissions: [],
          }],
        })
      );

      const checker = new PermissionCheck(fetchFn);
      const items = await checker.check(createConfig());

      const flsItem = items.find((i) => i.name.includes('Field-level'));
      expect(flsItem).toBeUndefined();
    });

    it('should check Modify All Data permission', async () => {
      const fetchFn: FetchPermissionsFn = vi.fn().mockResolvedValue(
        createPermissionData({ hasModifyAllData: false })
      );

      const checker = new PermissionCheck(fetchFn);
      const items = await checker.check(createConfig());

      const madItem = items.find((i) => i.name === 'Modify All Data');
      expect(madItem?.passed).toBe(false);
      expect(madItem?.severity).toBe('warning');
    });

    it('should pass Modify All Data when granted', async () => {
      const fetchFn: FetchPermissionsFn = vi.fn().mockResolvedValue(
        createPermissionData({ hasModifyAllData: true })
      );

      const checker = new PermissionCheck(fetchFn);
      const items = await checker.check(createConfig());

      const madItem = items.find((i) => i.name === 'Modify All Data');
      expect(madItem?.passed).toBe(true);
      expect(madItem?.severity).toBe('info');
    });

    it('should check View All Data permission', async () => {
      const fetchFn: FetchPermissionsFn = vi.fn().mockResolvedValue(
        createPermissionData({ hasViewAllData: false })
      );

      const checker = new PermissionCheck(fetchFn);
      const items = await checker.check(createConfig());

      const vadItem = items.find((i) => i.name === 'View All Data');
      expect(vadItem?.passed).toBe(false);
      expect(vadItem?.severity).toBe('warning');
    });

    it('should check Bulk API permission as blocker', async () => {
      const fetchFn: FetchPermissionsFn = vi.fn().mockResolvedValue(
        createPermissionData({ hasBulkApiPermission: false })
      );

      const checker = new PermissionCheck(fetchFn);
      const items = await checker.check(createConfig());

      const bulkItem = items.find((i) => i.name === 'Bulk API Permission');
      expect(bulkItem?.passed).toBe(false);
      expect(bulkItem?.severity).toBe('blocker');
    });

    it('should pass Bulk API permission when granted', async () => {
      const fetchFn: FetchPermissionsFn = vi.fn().mockResolvedValue(
        createPermissionData({ hasBulkApiPermission: true })
      );

      const checker = new PermissionCheck(fetchFn);
      const items = await checker.check(createConfig());

      const bulkItem = items.find((i) => i.name === 'Bulk API Permission');
      expect(bulkItem?.passed).toBe(true);
      expect(bulkItem?.severity).toBe('info');
    });

    it('should handle multiple objects', async () => {
      const fetchFn: FetchPermissionsFn = vi.fn().mockResolvedValue(
        createPermissionData({
          objectPermissions: [
            {
              objectApiName: 'Account',
              crudPermissions: { create: true, read: true, update: true, delete: true },
              missingFieldPermissions: [],
            },
            {
              objectApiName: 'Contact',
              crudPermissions: { create: true, read: true, update: true, delete: true },
              missingFieldPermissions: [],
            },
          ],
        })
      );

      const checker = new PermissionCheck(fetchFn);
      const items = await checker.check(createConfig());

      const crudItems = items.filter((i) => i.name.includes('CRUD'));
      expect(crudItems).toHaveLength(2);
    });

    it('should set all items to category permissions', async () => {
      const fetchFn: FetchPermissionsFn = vi.fn().mockResolvedValue(
        createPermissionData({
          objectPermissions: [{
            objectApiName: 'Account',
            crudPermissions: { create: true, read: true, update: true, delete: true },
            missingFieldPermissions: [],
          }],
        })
      );

      const checker = new PermissionCheck(fetchFn);
      const items = await checker.check(createConfig());

      for (const item of items) {
        expect(item.category).toBe('permissions');
      }
    });

    it('should mark all permission items as not autoFixable', async () => {
      const fetchFn: FetchPermissionsFn = vi.fn().mockResolvedValue(
        createPermissionData({
          objectPermissions: [{
            objectApiName: 'Account',
            crudPermissions: { create: false, read: true, update: true, delete: true },
            missingFieldPermissions: ['Industry'],
          }],
          hasModifyAllData: false,
          hasViewAllData: false,
          hasBulkApiPermission: false,
        })
      );

      const checker = new PermissionCheck(fetchFn);
      const items = await checker.check(createConfig());

      for (const item of items) {
        expect(item.autoFixable).toBe(false);
      }
    });

    it('should call fetchPermissions with correct orgId and operationConfig', async () => {
      const fetchFn: FetchPermissionsFn = vi.fn().mockResolvedValue(
        createPermissionData()
      );

      const config = createConfig({
        targetOrgId: 'org-test-123',
        operationConfig: { objects: ['Account'] },
      });

      const checker = new PermissionCheck(fetchFn);
      await checker.check(config);

      expect(fetchFn).toHaveBeenCalledWith('org-test-123', { objects: ['Account'] });
    });

    it('should generate unique IDs for each item', async () => {
      const fetchFn: FetchPermissionsFn = vi.fn().mockResolvedValue(
        createPermissionData({
          objectPermissions: [{
            objectApiName: 'Account',
            crudPermissions: { create: true, read: true, update: true, delete: true },
            missingFieldPermissions: [],
          }],
        })
      );

      const checker = new PermissionCheck(fetchFn);
      const items = await checker.check(createConfig());

      const ids = items.map((i) => i.id);
      const uniqueIds = new Set(ids);
      expect(uniqueIds.size).toBe(ids.length);
    });

    it('should detect all four missing CRUD permissions', async () => {
      const fetchFn: FetchPermissionsFn = vi.fn().mockResolvedValue(
        createPermissionData({
          objectPermissions: [{
            objectApiName: 'Lead',
            crudPermissions: { create: false, read: false, update: false, delete: false },
            missingFieldPermissions: [],
          }],
        })
      );

      const checker = new PermissionCheck(fetchFn);
      const items = await checker.check(createConfig());

      const crudItem = items.find((i) => i.name.includes('CRUD'));
      expect(crudItem?.message).toContain('Create');
      expect(crudItem?.message).toContain('Read');
      expect(crudItem?.message).toContain('Update');
      expect(crudItem?.message).toContain('Delete');
    });
  });
});
