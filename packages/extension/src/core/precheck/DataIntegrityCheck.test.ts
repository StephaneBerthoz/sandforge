import { describe, it, expect, vi } from 'vitest';
import { DataIntegrityCheck } from './DataIntegrityCheck';
import type { FetchDataInfoFn, DataIntegrityInfo } from './DataIntegrityCheck';
import type { PreCheckConfig } from '@sandforge/shared';

function createConfig(overrides?: Partial<PreCheckConfig>): PreCheckConfig {
  return {
    categories: ['data_integrity'],
    skipWarnings: false,
    autoFix: false,
    targetOrgId: 'org-001',
    module: 'sync',
    operationConfig: {},
    ...overrides,
  };
}

function createDataInfo(overrides?: Partial<DataIntegrityInfo>): DataIntegrityInfo {
  return {
    lookupTargets: [],
    uniqueFieldConflicts: [],
    invalidPicklistValues: [],
    externalIdFields: [],
    ...overrides,
  };
}

describe('DataIntegrityCheck', () => {
  describe('check', () => {
    it('should return empty array when no data integrity issues', async () => {
      const fetchFn: FetchDataInfoFn = vi.fn().mockResolvedValue(createDataInfo());
      const checker = new DataIntegrityCheck(fetchFn);
      const items = await checker.check(createConfig());

      expect(items).toEqual([]);
    });

    it('should pass when all lookup targets exist', async () => {
      const fetchFn: FetchDataInfoFn = vi.fn().mockResolvedValue(
        createDataInfo({
          lookupTargets: [
            {
              objectApiName: 'Contact',
              fieldApiName: 'AccountId',
              referencedObject: 'Account',
              missingTargetCount: 0,
              totalReferenceCount: 100,
            },
          ],
        }),
      );

      const checker = new DataIntegrityCheck(fetchFn);
      const items = await checker.check(createConfig());
      const lookupItem = items.find((i) => i.name.includes('Lookup targets'));

      expect(lookupItem?.passed).toBe(true);
      expect(lookupItem?.severity).toBe('info');
    });

    it('should fail when lookup targets are missing', async () => {
      const fetchFn: FetchDataInfoFn = vi.fn().mockResolvedValue(
        createDataInfo({
          lookupTargets: [
            {
              objectApiName: 'Contact',
              fieldApiName: 'AccountId',
              referencedObject: 'Account',
              missingTargetCount: 15,
              totalReferenceCount: 100,
            },
          ],
        }),
      );

      const checker = new DataIntegrityCheck(fetchFn);
      const items = await checker.check(createConfig());
      const lookupItem = items.find((i) => i.name.includes('Lookup targets'));

      expect(lookupItem?.passed).toBe(false);
      expect(lookupItem?.severity).toBe('error');
      expect(lookupItem?.message).toContain('15');
    });

    it('should pass when no unique field conflicts', async () => {
      const fetchFn: FetchDataInfoFn = vi.fn().mockResolvedValue(
        createDataInfo({
          uniqueFieldConflicts: [
            {
              objectApiName: 'Account',
              fieldApiName: 'ExternalId__c',
              conflictCount: 0,
            },
          ],
        }),
      );

      const checker = new DataIntegrityCheck(fetchFn);
      const items = await checker.check(createConfig());
      const conflictItem = items.find((i) => i.name.includes('Unique field'));

      expect(conflictItem?.passed).toBe(true);
      expect(conflictItem?.severity).toBe('info');
    });

    it('should fail when unique field conflicts exist', async () => {
      const fetchFn: FetchDataInfoFn = vi.fn().mockResolvedValue(
        createDataInfo({
          uniqueFieldConflicts: [
            {
              objectApiName: 'Account',
              fieldApiName: 'ExternalId__c',
              conflictCount: 5,
            },
          ],
        }),
      );

      const checker = new DataIntegrityCheck(fetchFn);
      const items = await checker.check(createConfig());
      const conflictItem = items.find((i) => i.name.includes('Unique field'));

      expect(conflictItem?.passed).toBe(false);
      expect(conflictItem?.severity).toBe('error');
      expect(conflictItem?.message).toContain('5');
    });

    it('should pass when picklist values are valid', async () => {
      const fetchFn: FetchDataInfoFn = vi.fn().mockResolvedValue(
        createDataInfo({
          invalidPicklistValues: [
            {
              objectApiName: 'Account',
              fieldApiName: 'Industry',
              invalidValues: [],
            },
          ],
        }),
      );

      const checker = new DataIntegrityCheck(fetchFn);
      const items = await checker.check(createConfig());
      const picklistItem = items.find((i) => i.name.includes('Picklist'));

      expect(picklistItem?.passed).toBe(true);
    });

    it('should warn when invalid picklist values exist', async () => {
      const fetchFn: FetchDataInfoFn = vi.fn().mockResolvedValue(
        createDataInfo({
          invalidPicklistValues: [
            {
              objectApiName: 'Account',
              fieldApiName: 'Industry',
              invalidValues: ['InvalidValue1', 'InvalidValue2'],
            },
          ],
        }),
      );

      const checker = new DataIntegrityCheck(fetchFn);
      const items = await checker.check(createConfig());
      const picklistItem = items.find((i) => i.name.includes('Picklist'));

      expect(picklistItem?.passed).toBe(false);
      expect(picklistItem?.severity).toBe('warning');
      expect(picklistItem?.message).toContain('InvalidValue1');
    });

    it('should pass when External ID field is available', async () => {
      const fetchFn: FetchDataInfoFn = vi.fn().mockResolvedValue(
        createDataInfo({
          externalIdFields: [
            {
              objectApiName: 'Account',
              fieldApiName: 'ExternalId__c',
              isExternalId: true,
              isUnique: true,
            },
          ],
        }),
      );

      const checker = new DataIntegrityCheck(fetchFn);
      const items = await checker.check(createConfig());
      const extIdItem = items.find((i) => i.name.includes('External ID'));

      expect(extIdItem?.passed).toBe(true);
      expect(extIdItem?.severity).toBe('info');
    });

    it('should fail when field is not an External ID', async () => {
      const fetchFn: FetchDataInfoFn = vi.fn().mockResolvedValue(
        createDataInfo({
          externalIdFields: [
            {
              objectApiName: 'Account',
              fieldApiName: 'CustomField__c',
              isExternalId: false,
              isUnique: false,
            },
          ],
        }),
      );

      const checker = new DataIntegrityCheck(fetchFn);
      const items = await checker.check(createConfig());
      const extIdItem = items.find((i) => i.name.includes('External ID'));

      expect(extIdItem?.passed).toBe(false);
      expect(extIdItem?.severity).toBe('error');
    });

    it('should handle multiple items across all categories', async () => {
      const fetchFn: FetchDataInfoFn = vi.fn().mockResolvedValue(
        createDataInfo({
          lookupTargets: [
            {
              objectApiName: 'Contact',
              fieldApiName: 'AccountId',
              referencedObject: 'Account',
              missingTargetCount: 0,
              totalReferenceCount: 50,
            },
          ],
          uniqueFieldConflicts: [
            { objectApiName: 'Account', fieldApiName: 'ExtId__c', conflictCount: 0 },
          ],
          invalidPicklistValues: [
            { objectApiName: 'Account', fieldApiName: 'Type', invalidValues: [] },
          ],
          externalIdFields: [
            {
              objectApiName: 'Account',
              fieldApiName: 'ExtId__c',
              isExternalId: true,
              isUnique: true,
            },
          ],
        }),
      );

      const checker = new DataIntegrityCheck(fetchFn);
      const items = await checker.check(createConfig());

      expect(items).toHaveLength(4);
    });

    it('should set all items to category data_integrity', async () => {
      const fetchFn: FetchDataInfoFn = vi.fn().mockResolvedValue(
        createDataInfo({
          lookupTargets: [
            {
              objectApiName: 'Contact',
              fieldApiName: 'AccountId',
              referencedObject: 'Account',
              missingTargetCount: 0,
              totalReferenceCount: 50,
            },
          ],
        }),
      );

      const checker = new DataIntegrityCheck(fetchFn);
      const items = await checker.check(createConfig());

      for (const item of items) {
        expect(item.category).toBe('data_integrity');
      }
    });

    it('should call fetchDataInfo with correct parameters', async () => {
      const fetchFn: FetchDataInfoFn = vi.fn().mockResolvedValue(createDataInfo());
      const config = createConfig({
        targetOrgId: 'org-test',
        operationConfig: { objects: ['Account'] },
      });

      const checker = new DataIntegrityCheck(fetchFn);
      await checker.check(config);

      expect(fetchFn).toHaveBeenCalledWith('org-test', { objects: ['Account'] });
    });

    it('should mark all items as not autoFixable', async () => {
      const fetchFn: FetchDataInfoFn = vi.fn().mockResolvedValue(
        createDataInfo({
          lookupTargets: [
            {
              objectApiName: 'Contact',
              fieldApiName: 'AccountId',
              referencedObject: 'Account',
              missingTargetCount: 5,
              totalReferenceCount: 50,
            },
          ],
          uniqueFieldConflicts: [
            { objectApiName: 'Account', fieldApiName: 'ExtId__c', conflictCount: 3 },
          ],
        }),
      );

      const checker = new DataIntegrityCheck(fetchFn);
      const items = await checker.check(createConfig());

      for (const item of items) {
        expect(item.autoFixable).toBe(false);
      }
    });

    it('should generate unique IDs for each item', async () => {
      const fetchFn: FetchDataInfoFn = vi.fn().mockResolvedValue(
        createDataInfo({
          lookupTargets: [
            {
              objectApiName: 'Contact',
              fieldApiName: 'AccountId',
              referencedObject: 'Account',
              missingTargetCount: 0,
              totalReferenceCount: 50,
            },
            {
              objectApiName: 'Case',
              fieldApiName: 'ContactId',
              referencedObject: 'Contact',
              missingTargetCount: 0,
              totalReferenceCount: 30,
            },
          ],
        }),
      );

      const checker = new DataIntegrityCheck(fetchFn);
      const items = await checker.check(createConfig());

      const ids = new Set(items.map((i) => i.id));
      expect(ids.size).toBe(items.length);
    });
  });
});
