import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DataCompare } from './DataCompare';
import type { FetchRecordsFn, SalesforceRecord } from './DataCompare';

describe('DataCompare', () => {
  let dataCompare: DataCompare;
  let fetchRecords: FetchRecordsFn;

  beforeEach(() => {
    fetchRecords = vi.fn<FetchRecordsFn>().mockResolvedValue([]);
    dataCompare = new DataCompare(fetchRecords);
  });

  describe('compare', () => {
    it('should fetch records from both orgs', async () => {
      await dataCompare.compare('org-1', 'org-2', 'Account', 'ExternalId__c');

      expect(fetchRecords).toHaveBeenCalledWith('org-1', 'Account');
      expect(fetchRecords).toHaveBeenCalledWith('org-2', 'Account');
    });

    it('should detect records only in target as added', async () => {
      vi.mocked(fetchRecords).mockImplementation(async (orgId) => {
        if (orgId === 'org-1') {
          return [];
        }
        return [{ ExternalId__c: 'ACC-001', Name: 'Acme' }];
      });

      const items = await dataCompare.compare('org-1', 'org-2', 'Account', 'ExternalId__c');

      expect(items).toHaveLength(1);
      expect(items[0].status).toBe('added');
      expect(items[0].fullName).toBe('Account.ACC-001');
    });

    it('should detect records only in source as removed', async () => {
      vi.mocked(fetchRecords).mockImplementation(async (orgId) => {
        if (orgId === 'org-1') {
          return [{ ExternalId__c: 'ACC-001', Name: 'Acme' }];
        }
        return [];
      });

      const items = await dataCompare.compare('org-1', 'org-2', 'Account', 'ExternalId__c');

      expect(items).toHaveLength(1);
      expect(items[0].status).toBe('removed');
    });

    it('should detect modified records with different field values', async () => {
      vi.mocked(fetchRecords).mockImplementation(async (orgId) => {
        if (orgId === 'org-1') {
          return [{ ExternalId__c: 'ACC-001', Name: 'Acme v1', Industry: 'Tech' }];
        }
        return [{ ExternalId__c: 'ACC-001', Name: 'Acme v2', Industry: 'Tech' }];
      });

      const items = await dataCompare.compare('org-1', 'org-2', 'Account', 'ExternalId__c');

      expect(items).toHaveLength(1);
      expect(items[0].status).toBe('modified');
      expect(items[0].fieldDiffs).toHaveLength(1);
      expect(items[0].fieldDiffs![0].fieldPath).toBe('Name');
      expect(items[0].fieldDiffs![0].sourceValue).toBe('Acme v1');
      expect(items[0].fieldDiffs![0].targetValue).toBe('Acme v2');
    });

    it('should detect unchanged records with identical field values', async () => {
      const record: SalesforceRecord = { ExternalId__c: 'ACC-001', Name: 'Acme' };
      vi.mocked(fetchRecords).mockResolvedValue([record]);

      const items = await dataCompare.compare('org-1', 'org-2', 'Account', 'ExternalId__c');

      expect(items).toHaveLength(1);
      expect(items[0].status).toBe('unchanged');
      expect(items[0].fieldDiffs).toBeUndefined();
    });

    it('should exclude the match field from field diffs', async () => {
      vi.mocked(fetchRecords).mockImplementation(async (orgId) => {
        if (orgId === 'org-1') {
          return [{ ExternalId__c: 'ACC-001', Name: 'Acme' }];
        }
        return [{ ExternalId__c: 'ACC-001', Name: 'Acme' }];
      });

      const items = await dataCompare.compare('org-1', 'org-2', 'Account', 'ExternalId__c');

      expect(items[0].status).toBe('unchanged');
    });

    it('should detect fields added in target record', async () => {
      vi.mocked(fetchRecords).mockImplementation(async (orgId) => {
        if (orgId === 'org-1') {
          return [{ ExternalId__c: 'ACC-001', Name: 'Acme' }];
        }
        return [{ ExternalId__c: 'ACC-001', Name: 'Acme', Website: 'acme.com' }];
      });

      const items = await dataCompare.compare('org-1', 'org-2', 'Account', 'ExternalId__c');

      expect(items[0].status).toBe('modified');
      expect(items[0].fieldDiffs).toHaveLength(1);
      expect(items[0].fieldDiffs![0].status).toBe('added');
    });

    it('should detect fields removed from target record', async () => {
      vi.mocked(fetchRecords).mockImplementation(async (orgId) => {
        if (orgId === 'org-1') {
          return [{ ExternalId__c: 'ACC-001', Name: 'Acme', Phone: '123' }];
        }
        return [{ ExternalId__c: 'ACC-001', Name: 'Acme' }];
      });

      const items = await dataCompare.compare('org-1', 'org-2', 'Account', 'ExternalId__c');

      expect(items[0].status).toBe('modified');
      expect(items[0].fieldDiffs).toHaveLength(1);
      expect(items[0].fieldDiffs![0].status).toBe('removed');
      expect(items[0].fieldDiffs![0].fieldPath).toBe('Phone');
    });

    it('should return empty array when both orgs have no records', async () => {
      const items = await dataCompare.compare('org-1', 'org-2', 'Account', 'ExternalId__c');
      expect(items).toEqual([]);
    });

    it('should skip records with empty match field values', async () => {
      vi.mocked(fetchRecords).mockResolvedValue([{ ExternalId__c: '', Name: 'No Key' }]);

      const items = await dataCompare.compare('org-1', 'org-2', 'Account', 'ExternalId__c');

      expect(items).toEqual([]);
    });

    it('should use CustomObject as component type', async () => {
      vi.mocked(fetchRecords).mockImplementation(async (orgId) => {
        if (orgId === 'org-1') {
          return [{ Id: 'R1', Name: 'Test' }];
        }
        return [];
      });

      const items = await dataCompare.compare('org-1', 'org-2', 'Account', 'Id');

      expect(items[0].componentType).toBe('CustomObject');
    });

    it('should assign warning severity to modified and removed records', async () => {
      vi.mocked(fetchRecords).mockImplementation(async (orgId) => {
        if (orgId === 'org-1') {
          return [{ Id: 'R1', Name: 'Removed' }];
        }
        return [];
      });

      const items = await dataCompare.compare('org-1', 'org-2', 'Account', 'Id');

      expect(items[0].severity).toBe('warning');
    });

    it('should handle large numbers of records', async () => {
      const records: SalesforceRecord[] = [];
      for (let i = 0; i < 1000; i++) {
        records.push({ ExternalId__c: `ACC-${i}`, Name: `Account ${i}` });
      }
      vi.mocked(fetchRecords).mockResolvedValue(records);

      const items = await dataCompare.compare('org-1', 'org-2', 'Account', 'ExternalId__c');

      expect(items).toHaveLength(1000);
      expect(items.every((item) => item.status === 'unchanged')).toBe(true);
    });

    it('should handle fetch failures by propagating the error', async () => {
      vi.mocked(fetchRecords).mockRejectedValue(new Error('Query failed'));

      await expect(
        dataCompare.compare('org-1', 'org-2', 'Account', 'ExternalId__c'),
      ).rejects.toThrow('Query failed');
    });
  });
});
