import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PermissionCompare } from './PermissionCompare';
import type {
  FetchPermissionsFn,
  PermissionEntry,
  CrudPermissions,
} from './PermissionCompare';

function createEntry(
  name: string,
  type: 'Profile' | 'PermissionSet',
  objectPermissions: Record<string, CrudPermissions> = {},
  fieldPermissions: Record<string, boolean> = {}
): PermissionEntry {
  return { name, type, objectPermissions, fieldPermissions };
}

const FULL_CRUD: CrudPermissions = { create: true, read: true, update: true, delete: true };
const READ_ONLY: CrudPermissions = { create: false, read: true, update: false, delete: false };
const NO_ACCESS: CrudPermissions = { create: false, read: false, update: false, delete: false };

describe('PermissionCompare', () => {
  let permCompare: PermissionCompare;
  let fetchPermissions: FetchPermissionsFn;

  beforeEach(() => {
    fetchPermissions = vi.fn<FetchPermissionsFn>().mockResolvedValue([]);
    permCompare = new PermissionCompare(fetchPermissions);
  });

  describe('compare', () => {
    it('should fetch permissions from both orgs', async () => {
      await permCompare.compare('org-1', 'org-2');

      expect(fetchPermissions).toHaveBeenCalledWith('org-1');
      expect(fetchPermissions).toHaveBeenCalledWith('org-2');
    });

    it('should detect added permission entries in target', async () => {
      vi.mocked(fetchPermissions).mockImplementation(async (orgId) => {
        if (orgId === 'org-1') {
          return [];
        }
        return [createEntry('Admin', 'Profile', { Account: FULL_CRUD })];
      });

      const items = await permCompare.compare('org-1', 'org-2');

      expect(items).toHaveLength(1);
      expect(items[0].status).toBe('added');
      expect(items[0].fullName).toBe('Admin');
      expect(items[0].componentType).toBe('Profile');
    });

    it('should detect removed permission entries', async () => {
      vi.mocked(fetchPermissions).mockImplementation(async (orgId) => {
        if (orgId === 'org-1') {
          return [createEntry('OldPermSet', 'PermissionSet', { Account: READ_ONLY })];
        }
        return [];
      });

      const items = await permCompare.compare('org-1', 'org-2');

      expect(items).toHaveLength(1);
      expect(items[0].status).toBe('removed');
      expect(items[0].componentType).toBe('PermissionSet');
    });

    it('should detect modified permissions', async () => {
      vi.mocked(fetchPermissions).mockImplementation(async (orgId) => {
        if (orgId === 'org-1') {
          return [createEntry('Admin', 'Profile', { Account: READ_ONLY })];
        }
        return [createEntry('Admin', 'Profile', { Account: FULL_CRUD })];
      });

      const items = await permCompare.compare('org-1', 'org-2');

      expect(items).toHaveLength(1);
      expect(items[0].status).toBe('modified');
    });

    it('should detect unchanged permissions', async () => {
      const entry = createEntry('Admin', 'Profile', { Account: FULL_CRUD });
      vi.mocked(fetchPermissions).mockResolvedValue([entry]);

      const items = await permCompare.compare('org-1', 'org-2');

      expect(items).toHaveLength(1);
      expect(items[0].status).toBe('unchanged');
    });

    it('should detect field permission differences', async () => {
      vi.mocked(fetchPermissions).mockImplementation(async (orgId) => {
        if (orgId === 'org-1') {
          return [createEntry('Admin', 'Profile', {}, { 'Account.Name': true })];
        }
        return [createEntry('Admin', 'Profile', {}, { 'Account.Name': false })];
      });

      const items = await permCompare.compare('org-1', 'org-2');

      expect(items).toHaveLength(1);
      expect(items[0].status).toBe('modified');
    });

    it('should return empty array when both orgs have no permissions', async () => {
      const items = await permCompare.compare('org-1', 'org-2');
      expect(items).toEqual([]);
    });

    it('should assign breaking severity to removed profiles', async () => {
      vi.mocked(fetchPermissions).mockImplementation(async (orgId) => {
        if (orgId === 'org-1') {
          return [createEntry('Admin', 'Profile')];
        }
        return [];
      });

      const items = await permCompare.compare('org-1', 'org-2');

      expect(items[0].severity).toBe('breaking');
    });

    it('should assign warning severity to removed permission sets', async () => {
      vi.mocked(fetchPermissions).mockImplementation(async (orgId) => {
        if (orgId === 'org-1') {
          return [createEntry('DataAccess', 'PermissionSet')];
        }
        return [];
      });

      const items = await permCompare.compare('org-1', 'org-2');

      expect(items[0].severity).toBe('warning');
    });

    it('should handle fetch failures by propagating the error', async () => {
      vi.mocked(fetchPermissions).mockRejectedValue(new Error('Auth failed'));

      await expect(
        permCompare.compare('org-1', 'org-2')
      ).rejects.toThrow('Auth failed');
    });

    it('should handle multiple permission entries of mixed types', async () => {
      vi.mocked(fetchPermissions).mockImplementation(async (orgId) => {
        if (orgId === 'org-1') {
          return [
            createEntry('Admin', 'Profile', { Account: FULL_CRUD }),
            createEntry('ReadOnly', 'PermissionSet', { Account: READ_ONLY }),
          ];
        }
        return [
          createEntry('Admin', 'Profile', { Account: FULL_CRUD }),
          createEntry('NewPS', 'PermissionSet', { Contact: FULL_CRUD }),
        ];
      });

      const items = await permCompare.compare('org-1', 'org-2');

      expect(items).toHaveLength(3);
      const byName = new Map(items.map((i) => [i.fullName, i]));
      expect(byName.get('Admin')?.status).toBe('unchanged');
      expect(byName.get('ReadOnly')?.status).toBe('removed');
      expect(byName.get('NewPS')?.status).toBe('added');
    });
  });

  describe('buildPermissionMatrix', () => {
    it('should build matrix rows for matching objects', () => {
      const source = [createEntry('Admin', 'Profile', { Account: FULL_CRUD })];
      const target = [createEntry('Admin', 'Profile', { Account: READ_ONLY })];

      const rows = permCompare.buildPermissionMatrix(source, target);

      expect(rows).toHaveLength(1);
      expect(rows[0].objectName).toBe('Account');
      expect(rows[0].source).toEqual(FULL_CRUD);
      expect(rows[0].target).toEqual(READ_ONLY);
      expect(rows[0].hasDifference).toBe(true);
    });

    it('should mark rows without differences as hasDifference false', () => {
      const entries = [createEntry('Admin', 'Profile', { Account: FULL_CRUD })];

      const rows = permCompare.buildPermissionMatrix(entries, entries);

      expect(rows).toHaveLength(1);
      expect(rows[0].hasDifference).toBe(false);
    });

    it('should handle objects only in source', () => {
      const source = [createEntry('Admin', 'Profile', { Account: FULL_CRUD })];
      const target: PermissionEntry[] = [];

      const rows = permCompare.buildPermissionMatrix(source, target);

      expect(rows).toHaveLength(1);
      expect(rows[0].source).toEqual(FULL_CRUD);
      expect(rows[0].target).toEqual(NO_ACCESS);
      expect(rows[0].hasDifference).toBe(true);
    });

    it('should handle objects only in target', () => {
      const source: PermissionEntry[] = [];
      const target = [createEntry('Admin', 'Profile', { Contact: READ_ONLY })];

      const rows = permCompare.buildPermissionMatrix(source, target);

      expect(rows).toHaveLength(1);
      expect(rows[0].objectName).toBe('Contact');
      expect(rows[0].source).toEqual(NO_ACCESS);
      expect(rows[0].target).toEqual(READ_ONLY);
    });

    it('should aggregate permissions across multiple entries with OR logic', () => {
      const source = [
        createEntry('Admin', 'Profile', { Account: READ_ONLY }),
        createEntry('Editor', 'PermissionSet', { Account: { create: true, read: false, update: true, delete: false } }),
      ];
      const target: PermissionEntry[] = [];

      const rows = permCompare.buildPermissionMatrix(source, target);

      expect(rows).toHaveLength(1);
      expect(rows[0].source).toEqual({ create: true, read: true, update: true, delete: false });
    });

    it('should return empty array when no entries exist', () => {
      const rows = permCompare.buildPermissionMatrix([], []);
      expect(rows).toEqual([]);
    });
  });
});
